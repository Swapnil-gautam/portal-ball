import Peer, { type DataConnection, type MediaConnection } from "peerjs";
import type { GameEvent } from "./gamestate";
import type { PaddleAxes } from "./paddleOrientation";

/**
 * A player's paddle as they see it on their own screen — position on their
 * strike plane and its axes, in their own court coordinates (to themselves
 * they're always the near side). The receiver mirrors it onto the far end.
 */
export interface PaddleState {
  visible: boolean;
  x: number;
  y: number;
  axes: PaddleAxes | null;
}

/**
 * Real WebRTC between two machines, set up with one short code.
 *
 * Two browsers can't connect directly without first swapping connection
 * details (an "offer" and an "answer"). The first version had the players
 * carry both by hand — two long codes, one each way. Now PeerJS's free public
 * matchmaking server passes them: the host registers under a 5-letter code,
 * the guest asks for that code, and the server introduces them. It only ever
 * sees those connection details; video and gameplay go directly between the
 * two players. If that public server is ever down, joining fails until it's back.
 *
 * NAT traversal: Google's public STUN servers handle most home networks.
 * A minority of networks (strict corporate firewalls, some mobile carriers)
 * need a TURN relay to connect at all. The Open Relay Project's free public
 * TURN servers are included as a fallback — a best-effort community service,
 * not something either of us operate.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.relay.metered.ca:80" },
  {
    urls: "turn:global.relay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:global.relay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:global.relay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

/** No 0/O or 1/I/L, so a code read aloud or typed on a phone can't be misread. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
/** Namespaces our codes on the shared public server, so they can't collide with other apps. */
const ID_PREFIX = "portalball-v1-";
const PING_EVERY_MS = 2000;

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** Accepts what people actually type: lowercase, spaces, dashes. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isPlausibleCode(input: string): boolean {
  const code = normalizeCode(input);
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

type WireMessage =
  | { type: "event"; event: GameEvent }
  // Sent ~30×/s so each player can see the other's paddle. Purely visual:
  // hits are still decided by each player's own machine.
  | { type: "paddle"; p: PaddleState }
  // Round-trip probe. Both timestamps are the *sender's* clock, so the RTT is
  // computed on one machine — never compare performance.now() across machines.
  | { type: "ping"; t: number }
  | { type: "pong"; t: number };

export type PeerStatus = "connected" | "disconnected" | "failed";

export class RTCGamePeer {
  private peer: Peer | null = null;
  private data: DataConnection | null = null;
  private call: MediaConnection | null = null;
  private pingTimer = 0;
  private rttMs: number | null = null;
  private reportedConnected = false;
  private closed = false;

  onRemoteStream: ((stream: MediaStream) => void) | null = null;
  onEvent: ((e: GameEvent) => void) | null = null;
  onPaddle: ((p: PaddleState) => void) | null = null;
  onStatus: ((status: PeerStatus) => void) | null = null;

  constructor(private readonly localStream: MediaStream) {}

  /** Measured one-way delay, ms. A reasonable guess until the first round trip is in. */
  get latencyMs(): number {
    return this.rttMs === null ? 60 : this.rttMs / 2;
  }

  /**
   * Host: register under a fresh 5-letter code. Resolves with the code as soon
   * as it's claimed; the friend can join any time after that.
   */
  host(): Promise<string> {
    return new Promise((resolve, reject) => {
      const attempt = (tries: number) => {
        const code = newCode();
        const peer = new Peer(ID_PREFIX + code, { config: { iceServers: ICE_SERVERS } });
        this.peer = peer;

        peer.on("open", () => resolve(code));
        peer.on("connection", (conn) => {
          if (this.data) conn.close(); // one opponent at a time
          else this.wireData(conn);
        });
        peer.on("call", (call) => {
          call.answer(this.localStream);
          this.wireCall(call);
        });
        peer.on("error", (err) => {
          if (err.type === "unavailable-id" && tries < 5) {
            peer.destroy(); // someone has that code already — pick another
            attempt(tries + 1);
          } else if (!this.reportedConnected) {
            reject(new Error(describe(err.type)));
          }
        });
      };
      attempt(0);
    });
  }

  /** Guest: join the game hosting under `code`. Resolves once the game connection is open. */
  join(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config: { iceServers: ICE_SERVERS } });
      this.peer = peer;
      const hostId = ID_PREFIX + normalizeCode(code);

      peer.on("open", () => {
        const conn = peer.connect(hostId, { reliable: true, serialization: "json" });
        conn.on("open", () => resolve());
        this.wireData(conn);
        this.wireCall(peer.call(hostId, this.localStream));
      });
      peer.on("error", (err) => {
        if (!this.reportedConnected) reject(new Error(describe(err.type)));
      });
    });
  }

  private wireData(conn: DataConnection): void {
    this.data = conn;
    conn.on("open", () => this.markConnected());
    conn.on("data", (raw) => {
      const msg = raw as WireMessage;
      if (msg.type === "event") this.onEvent?.(msg.event);
      else if (msg.type === "paddle") this.onPaddle?.(msg.p);
      else if (msg.type === "ping") this.sendRaw({ type: "pong", t: msg.t });
      else if (msg.type === "pong") {
        const rtt = performance.now() - msg.t;
        this.rttMs = this.rttMs === null ? rtt : this.rttMs * 0.7 + rtt * 0.3;
      }
    });
    conn.on("close", () => {
      if (!this.closed) this.onStatus?.("disconnected");
    });
    conn.on("error", () => {
      if (!this.closed) this.onStatus?.("failed");
    });
  }

  private wireCall(call: MediaConnection): void {
    this.call = call;
    call.on("stream", (stream) => this.onRemoteStream?.(stream));
  }

  private markConnected(): void {
    if (this.reportedConnected) return;
    this.reportedConnected = true;
    this.onStatus?.("connected");
    this.sendRaw({ type: "ping", t: performance.now() });
    this.pingTimer = window.setInterval(() => this.sendRaw({ type: "ping", t: performance.now() }), PING_EVERY_MS);
  }

  send(event: GameEvent): void {
    this.sendRaw({ type: "event", event });
  }

  sendPaddle(p: PaddleState): void {
    // Rounded: millimetre precision is plenty, and it keeps each message small.
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const v3 = (v: { x: number; y: number; z: number }) => ({ x: r(v.x), y: r(v.y), z: r(v.z) });
    this.sendRaw({
      type: "paddle",
      p: { visible: p.visible, x: r(p.x), y: r(p.y), axes: p.axes && { x: v3(p.axes.x), y: v3(p.axes.y), z: v3(p.axes.z) } },
    });
  }

  private sendRaw(msg: WireMessage): void {
    if (this.data?.open) this.data.send(msg);
  }

  close(): void {
    this.closed = true;
    window.clearInterval(this.pingTimer);
    this.onStatus = null; // a deliberate close isn't a dropped connection
    this.data?.close();
    this.call?.close();
    this.peer?.destroy();
  }
}

/** Plain-language versions of the PeerJS errors a player can actually hit. */
function describe(type: string): string {
  switch (type) {
    case "peer-unavailable":
      return "No game with that code. Check the letters, or ask your friend for a new code.";
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
      return "Couldn't reach the matchmaking server. Check your internet connection and try again.";
    case "browser-incompatible":
      return "This browser can't make direct connections. Try Chrome, Edge or Safari.";
    case "unavailable-id":
      return "Couldn't get a free game code. Try again.";
    default:
      return `Connection problem (${type}). Try again.`;
  }
}
