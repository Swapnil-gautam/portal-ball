import { ARRIVAL_HEIGHT, BALL_RADIUS, COURT_LENGTH, HEAD_RADIUS, STRIKE_Z } from "./court";
import { Physics, planShot, type Paddle, type Shot, type ShotInput, type Side } from "./physics";

export type GamePhase = "serve" | "rally" | "end";
export type OpponentMode = "ai" | "network";

/** Sent between the two players' machines. Always written from the sender's point of view. */
export type GameEvent =
  | { type: "shot"; shot: Shot; serve: boolean }
  | { type: "point"; scorer: Side }
  | { type: "restart" };

/** Things the screen should react to. Never sent over the network. */
export type UiEvent =
  | { type: "hit"; by: Side }
  | { type: "point"; scorer: Side }
  | { type: "match_end"; winner: Side }
  /** The other player started a rematch — our end screen should clear. */
  | { type: "restart" };

export interface MatchState {
  phase: GamePhase;
  scoreLocal: number;
  scoreRemote: number;
  serving: Side;
  winScore: number;
}

/** First to this many points wins the match. */
export const WIN_SCORE = 3;
const SERVE_HOLD_MS = 500;
const STILL_SPEED = 0.8; // world units/s — paddle counts as "held still" below this
const AI_SERVE_DELAY_MS = 900;
/** If a shot is still bouncing around this long after it should have arrived, the receiver missed. */
const DEAD_BALL_MS = 1500;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const other = (s: Side): Side => (s === "local" ? "remote" : "local");

/**
 * Turns a tracked swing into shot intent. Faster swing = harder, faster
 * shot. Swinging sideways steers it sideways; swinging upward lifts it.
 * Holding the paddle still still returns the ball — just slowly.
 */
export function swingToShot(p: Paddle): ShotInput {
  const speed = Math.hypot(p.vx, p.vy);
  return {
    power: clamp((speed - 1) / 8, 0, 1),
    aimX: p.x * 0.5 + p.vx * 0.12,
    aimHeight: ARRIVAL_HEIGHT + clamp(p.vy * 0.04, -0.3, 0.3),
  };
}

/** The other player's court is ours rotated 180°: lateral and depth flip, height doesn't. */
function mirrorShot(s: Shot): Shot {
  return {
    pos: { x: -s.pos.x, y: s.pos.y, z: COURT_LENGTH - s.pos.z },
    vel: { x: -s.vel.x, y: s.vel.y, z: -s.vel.z },
    restitution: s.restitution,
    flightS: s.flightS,
    arrival: { x: -s.arrival.x, y: s.arrival.y },
  };
}

export class GameState {
  physics = new Physics();
  match!: MatchState;

  serveHoldStart: number | null = null;
  /** Who the ball in flight is heading toward. */
  receiver: Side = "remote";

  private serveEnteredAt = 0;
  /**
   * Network play: when the ball passes the *other* player, it's their call
   * whether they hit it — their camera saw their hand, ours didn't. Until
   * their verdict arrives we stop simulating, instead of each side scoring
   * on its own and drifting apart (which the first networked version did).
   */
  private awaitingVerdict = false;
  private ui: UiEvent[] = [];

  /** Outbound events for the network peer. */
  onEvent: ((e: GameEvent) => void) | null = null;

  /**
   * `firstServer` must be opposite on the two machines in network play — the
   * host serves first. The first networked version had both sides serve.
   */
  constructor(
    public readonly mode: OpponentMode,
    private readonly firstServer: Side = "local",
  ) {
    this.startNewMatch();
  }

  startNewMatch(): void {
    this.match = { phase: "serve", scoreLocal: 0, scoreRemote: 0, serving: this.firstServer, winScore: WIN_SCORE };
    this.beginServe(this.firstServer);
  }

  /** Local player asked for a rematch — tell the other side too. */
  requestRestart(): void {
    this.startNewMatch();
    this.onEvent?.({ type: "restart" });
  }

  private beginServe(server: Side): void {
    this.match.phase = "serve";
    this.match.serving = server;
    this.serveHoldStart = null;
    this.serveEnteredAt = performance.now();
    this.awaitingVerdict = false;
    this.physics.hold({ x: 0, y: ARRIVAL_HEIGHT, z: STRIKE_Z[server] });
  }

  serveHoldProgress(now: number): number {
    if (this.serveHoldStart === null) return 0;
    return clamp((now - this.serveHoldStart) / SERVE_HOLD_MS, 0, 1);
  }

  // ---------------------------------------------------------------- local input

  updateLocalPaddle(p: Paddle, now: number): void {
    if (this.match.phase === "serve" && this.match.serving === "local") {
      // The ball rides just above your paddle until you serve it.
      this.physics.hold({ x: p.x, y: p.y + HEAD_RADIUS + BALL_RADIUS + 0.06, z: STRIKE_Z.local });

      if (Math.hypot(p.vx, p.vy) < STILL_SPEED) {
        if (this.serveHoldStart === null) this.serveHoldStart = now;
        else if (now - this.serveHoldStart >= SERVE_HOLD_MS) {
          this.launch("local", { power: 0.3, aimX: -p.x * 0.4 }, now, true);
        }
      } else {
        this.serveHoldStart = null;
      }
      return;
    }

    if (this.match.phase === "rally" && this.receiver === "local" && this.physics.canHit(p, "local")) {
      this.launch("local", swingToShot(p), now, false);
    }
  }

  /** Solo mode: the bot plays the remote side through exactly the same rules. */
  updateAIPaddle(p: Paddle, intent: ShotInput, now: number): void {
    if (this.mode !== "ai") return;

    if (this.match.phase === "serve" && this.match.serving === "remote") {
      if (now - this.serveEnteredAt >= AI_SERVE_DELAY_MS) this.launch("remote", intent, now, true);
      return;
    }
    if (this.match.phase === "rally" && this.receiver === "remote" && this.physics.canHit(p, "remote")) {
      this.launch("remote", intent, now, false);
    }
  }

  private launch(hitter: Side, intent: ShotInput, now: number, serve: boolean): void {
    const shot = planShot(this.physics.ball.pos, hitter, intent);
    this.physics.launch(shot, now);
    this.match.phase = "rally";
    this.receiver = other(hitter);
    this.serveHoldStart = null;
    this.ui.push({ type: "hit", by: hitter });
    if (hitter === "local") this.onEvent?.({ type: "shot", shot, serve });
  }

  // ---------------------------------------------------------------- network inbound

  /**
   * Apply an event from the other player. `latencyMs` is the measured one-way
   * delay. The first networked version used the sender's timestamps here, but
   * performance.now() on two machines counts from different origins, so the
   * "elapsed" time was garbage — sometimes negative, running the ball backwards.
   */
  applyRemoteEvent(evt: GameEvent, latencyMs: number): void {
    if (evt.type === "shot") {
      const now = performance.now();
      const lag = clamp(latencyMs, 0, 300);
      this.physics.launch(mirrorShot(evt.shot), now - lag);
      this.physics.update(lag / 1000); // catch up to where it is by now
      this.match.phase = "rally";
      this.receiver = "local";
      this.awaitingVerdict = false;
      this.ui.push({ type: "hit", by: "remote" });
      return;
    }
    if (evt.type === "point") {
      this.endRally(other(evt.scorer), false);
      return;
    }
    if (evt.type === "restart") {
      this.startNewMatch();
      this.ui.push({ type: "restart" });
    }
  }

  // ---------------------------------------------------------------- per frame

  /** Advance the ball and resolve the end of a point. Returns what the screen should show. */
  step(dt: number, now: number): UiEvent[] {
    if (this.match.phase === "rally" && !this.awaitingVerdict) {
      this.physics.update(dt);

      let missed = this.physics.missedBy();
      const arrival = this.physics.ball.arrival;
      if (!missed && arrival && now > arrival.at + DEAD_BALL_MS) missed = this.receiver;

      if (missed) {
        if (this.mode === "network" && missed === "remote") {
          this.awaitingVerdict = true; // their call — see awaitingVerdict
        } else {
          this.endRally(other(missed), true);
        }
      }
    }
    return this.ui.splice(0);
  }

  private endRally(scorer: Side, broadcast: boolean): void {
    if (this.match.phase === "end") return;

    if (scorer === "local") this.match.scoreLocal++;
    else this.match.scoreRemote++;
    this.ui.push({ type: "point", scorer });
    if (broadcast) this.onEvent?.({ type: "point", scorer });

    const m = this.match;
    const winner: Side | null =
      m.scoreLocal >= m.winScore ? "local" : m.scoreRemote >= m.winScore ? "remote" : null;

    if (winner) {
      m.phase = "end";
      this.physics.hold(this.physics.ball.pos);
      this.ui.push({ type: "match_end", winner });
    } else {
      this.beginServe(other(scorer)); // whoever lost the point serves next
    }
  }
}
