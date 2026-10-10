import type { GameEvent } from "./gamestate";

/**
 * Real WebRTC between two machines — this is what makes long-distance play
 * possible at all. There's no signaling server deployed for this project, so
 * connection setup uses the classic "serverless" WebRTC pattern: one side's
 * offer and the other's answer are exchanged as plain text codes, over
 * whatever channel you already use to talk to them (chat, text, email).
 * It's two copy-pastes to connect, then a direct peer-to-peer link for the
 * whole match — video and game events both, no server in the middle.
 *
 * NAT traversal: Google's public STUN servers handle most home networks.
 * A minority of networks (strict corporate firewalls, some mobile carriers)
 * need a TURN relay to connect at all. The Open Relay Project's free public
 * TURN servers are included as a fallback — it's a best-effort community
 * service, not something either of us operate, so if it's ever down the
 * fix is to get a free API key from metered.ca or another TURN provider.
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

type WireMessage =
  | { type: "event"; event: GameEvent }
  // Round-trip probe. Both timestamps are the *sender's* clock, so the RTT is
  // computed on one machine — never compare performance.now() across machines.
  | { type: "ping"; t: number }
  | { type: "pong"; t: number };

const PING_EVERY_MS = 2000;

function toCode(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromCode<T>(code: string): T {
  const b64 = code.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export type PeerStatus = "new" | "connecting" | "connected" | "disconnected" | "failed";

export class RTCGamePeer {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private pingTimer = 0;
  private rttMs: number | null = null;
  private reportedConnected = false;

  onRemoteStream: ((stream: MediaStream) => void) | null = null;
  onEvent: ((e: GameEvent) => void) | null = null;
  onStatus: ((status: PeerStatus) => void) | null = null;

  constructor(localStream: MediaStream) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    for (const track of localStream.getTracks()) {
      this.pc.addTrack(track, localStream);
    }

    this.pc.addEventListener("track", (e) => {
      if (e.streams[0]) this.onRemoteStream?.(e.streams[0]);
    });

    this.pc.addEventListener("datachannel", (e) => {
      this.dc = e.channel;
      this.wireDataChannel();
    });

    this.pc.addEventListener("connectionstatechange", () => {
      // "connected" is reported from the data channel opening, not from here —
      // the media path can come up first, and a game that starts before its
      // event channel is open silently drops the first serve.
      const s = this.pc.connectionState;
      if (s === "disconnected") this.onStatus?.("disconnected");
      else if (s === "failed" || s === "closed") this.onStatus?.("failed");
    });
  }

  /** Measured one-way delay, ms. A reasonable guess until the first round trip is in. */
  get latencyMs(): number {
    return this.rttMs === null ? 60 : this.rttMs / 2;
  }

  private markConnected(): void {
    if (this.reportedConnected) return;
    this.reportedConnected = true;
    this.onStatus?.("connected");
    this.sendRaw({ type: "ping", t: performance.now() });
    this.pingTimer = window.setInterval(() => this.sendRaw({ type: "ping", t: performance.now() }), PING_EVERY_MS);
  }

  private wireDataChannel(): void {
    if (!this.dc) return;
    this.dc.addEventListener("open", () => this.markConnected());
    this.dc.addEventListener("close", () => this.onStatus?.("disconnected"));
    this.dc.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data) as WireMessage;
        if (msg.type === "event") this.onEvent?.(msg.event);
        else if (msg.type === "ping") this.sendRaw({ type: "pong", t: msg.t });
        else if (msg.type === "pong") {
          const rtt = performance.now() - msg.t;
          this.rttMs = this.rttMs === null ? rtt : this.rttMs * 0.7 + rtt * 0.3;
        }
      } catch (err) {
        console.error("bad message from peer:", err);
      }
    });
    // The guest's channel can already be open by the time it's handed over,
    // in which case "open" never fires.
    if (this.dc.readyState === "open") this.markConnected();
  }

  /** Host side, step 1: generates the code to send to the other player. */
  async createInvite(): Promise<string> {
    this.dc = this.pc.createDataChannel("game", { ordered: true });
    this.wireDataChannel();

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIce();

    return toCode({ sdp: this.pc.localDescription!.sdp, type: this.pc.localDescription!.type });
  }

  /** Guest side, step 1: consumes the host's code, produces one to send back. */
  async acceptInvite(hostCode: string): Promise<string> {
    const offer = fromCode<RTCSessionDescriptionInit>(hostCode);
    await this.pc.setRemoteDescription(offer);

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIce();

    return toCode({ sdp: this.pc.localDescription!.sdp, type: this.pc.localDescription!.type });
  }

  /** Host side, step 2: consumes the guest's reply. Connection completes shortly after. */
  async completeInvite(guestCode: string): Promise<void> {
    const answer = fromCode<RTCSessionDescriptionInit>(guestCode);
    await this.pc.setRemoteDescription(answer);
  }

  private waitForIce(): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const onChange = () => {
        if (this.pc.iceGatheringState === "complete") {
          this.pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      this.pc.addEventListener("icegatheringstatechange", onChange);
      // Some networks never cleanly report "complete" — don't block forever.
      setTimeout(resolve, 4000);
    });
  }

  send(event: GameEvent): void {
    this.sendRaw({ type: "event", event });
  }

  private sendRaw(msg: WireMessage): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(msg));
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    this.onStatus = null; // a deliberate close isn't a dropped connection
    this.dc?.close();
    this.pc.close();
  }
}
