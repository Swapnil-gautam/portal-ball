import { MotionFit } from "./motionFit";
import { paddleSettings } from "./paddleSettings";
import type { Paddle } from "./physics";

/**
 * Turns per-camera-frame hand samples into a paddle that doesn't blink out.
 *
 * Fast swings blur the hand and the tracker drops it for a few frames —
 * exactly when the paddle matters most. When that happens the paddle:
 *
 *   1. predicts (≤ PREDICT_MS): keeps moving in the direction and at the
 *      speed fitted from the last several camera frames (see MotionFit).
 *      It extrapolates velocity only, not acceleration — simulated against
 *      a noisy swing, extrapolating acceleration sent the paddle up to 10
 *      units off.
 *   2. holds (≤ HOLD_MS): no prediction is accurate past ~250ms, so it stops
 *      where it got to, faded, rather than vanishing.
 *   3. hides, only once the hand has really been gone a while.
 *
 * When the hand comes back the paddle glides to it instead of snapping, and
 * shot speed is measured from the last real sighting, so a dropout can't
 * become a phantom full-power swing.
 */

export interface HandSample {
  present: boolean;
  /** Screen position 0..1 (already mirrored for display). */
  u: number;
  v: number;
  /** Timestamp of the camera frame this came from (performance.now() domain). */
  t: number;
  /**
   * Added (in world units) after mapping u/v onto the court — lets the caller
   * track a point other than the one it has screen coordinates for, e.g. the
   * paddle head past the palm.
   */
  offset?: { x: number; y: number };
}

export type PaddleState = "tracked" | "predicted" | "held";

export interface PaddleReading extends Paddle {
  state: PaddleState;
}

/** How long the hand has been missing, for the debug readout. */
export interface DropoutStats {
  count: number;
  longestMs: number;
  lastMs: number;
  /** Dropouts long enough that the paddle had to hold still instead of predicting. */
  overPredict: number;
}

const PREDICT_MS = 250;
const HOLD_MS = 1500;
/** Gentle slowdown while predicting, per second — keeps a stopped swing from overshooting far. */
const PREDICT_DECAY = 2.5;
/** A swing faster than this is a tracking glitch (a jump), not a real hand. */
const MAX_SPEED = 22;
/**
 * The camera gives a new position ~30×/s but the screen draws ~60×/s. Between
 * camera frames, keep moving along the fitted velocity instead of sitting
 * still — capped at a bit over one camera frame so a stopping hand can't be
 * overshot.
 */
/** Full look-ahead from this speed (world units/s) up; none for a hand at rest, where velocity is mostly jitter. */
const LEAD_FULL_SPEED = 1.5;
/** After a gap this long the old frames are stale; start the motion fit fresh. */
const REFIT_GAP_MS = 250;
/** Fraction of the remaining gap closed per display frame when the hand reappears — quick, but not a snap. */
const SETTLE_RATE = 0.7;
const SETTLED = 0.03;
/** Visible area of the strike plane, roughly; a predicted paddle won't leave it. */
const BOUNDS = { x: 2.6, yMin: 0, yMax: 2.8 };

export class HandPaddle {
  /** Where the paddle is shown and hit-tested. */
  private px = 0;
  private py = 0;
  /** Where the hand really is, per the motion fit. */
  private tx = 0;
  private ty = 0;
  /** Hand velocity from the motion fit — shot power. */
  private vx = 0;
  private vy = 0;
  /** The same velocity, slowing down while predicting through a dropout. */
  private predVx = 0;
  private predVy = 0;
  private readonly fit = new MotionFit();
  private predictT = 0;
  private lastReal: { x: number; y: number; t: number } | null = null;
  private lastSampleT = -1;
  private valid = false;
  private missing = false;
  private settling = false;
  /** When the current dropout began. Survives the paddle hiding, so long dropouts still get counted. */
  private lostFrom: number | null = null;

  readonly stats: DropoutStats = { count: 0, longestMs: 0, lastMs: 0, overPredict: 0 };

  /** `toPlane` maps a screen point onto the strike plane in world units. */
  constructor(private readonly toPlane: (u: number, v: number) => { x: number; y: number }) {}

  reset(): void {
    this.lostFrom = null;
    this.forget();
  }

  /** Drop the paddle's state, but keep counting the dropout in progress. */
  private forget(): void {
    this.valid = false;
    this.missing = false;
    this.settling = false;
    this.vx = this.vy = this.predVx = this.predVy = 0;
    this.lastReal = null;
    this.lastSampleT = -1;
    this.fit.reset();
  }

  /** Call once per display frame with the latest sample. Returns null when there's no hand to show. */
  update(sample: HandSample, now: number): PaddleReading | null {
    if (sample.present) {
      if (sample.t !== this.lastSampleT) this.takeSample(sample);

      const moving = clamp(Math.hypot(this.vx, this.vy) / LEAD_FULL_SPEED, 0, 1);
      const lead = this.lastReal ? (clamp(now - this.lastReal.t, 0, paddleSettings().lookAheadMs) / 1000) * moving : 0;
      const gx = clamp(this.tx + this.vx * lead, -BOUNDS.x, BOUNDS.x);
      const gy = clamp(this.ty + this.vy * lead, BOUNDS.yMin, BOUNDS.yMax);

      if (this.settling) {
        this.px += (gx - this.px) * SETTLE_RATE;
        this.py += (gy - this.py) * SETTLE_RATE;
        if (Math.hypot(gx - this.px, gy - this.py) < SETTLED) this.settling = false;
      }
      if (!this.settling) {
        this.px = gx;
        this.py = gy;
      }
      return this.reading("tracked");
    }

    if (!this.valid || !this.lastReal) return null;

    const gone = now - this.lastReal.t;
    if (!this.missing) {
      this.missing = true;
      this.predictT = this.lastReal.t;
      this.lostFrom = this.lastReal.t;
    }

    if (gone > HOLD_MS) {
      this.forget();
      return null;
    }

    if (gone <= PREDICT_MS) {
      const dt = Math.max(0, (now - this.predictT) / 1000);
      const decay = Math.exp(-PREDICT_DECAY * dt);
      this.predVx *= decay;
      this.predVy *= decay;
      this.px = clamp(this.px + this.predVx * dt, -BOUNDS.x, BOUNDS.x);
      this.py = clamp(this.py + this.predVy * dt, BOUNDS.yMin, BOUNDS.yMax);
      this.predictT = now;
      this.settling = false;
      return this.reading("predicted");
    }

    // Past the point where prediction is trustworthy: hold still, faded.
    this.vx = this.vy = 0;
    return this.reading("held");
  }

  private takeSample(s: HandSample): void {
    const mapped = this.toPlane(s.u, s.v);
    const raw = s.offset ? { x: mapped.x + s.offset.x, y: mapped.y + s.offset.y } : mapped;
    if (this.lastReal && s.t - this.lastReal.t > REFIT_GAP_MS) this.fit.reset();
    const est = this.fit.push(s.t, raw.x, raw.y);
    const v = clampMagnitude(est.vx, est.vy, MAX_SPEED);
    this.vx = this.predVx = v.x;
    this.vy = this.predVy = v.y;
    const p = { x: est.x, y: est.y };

    if (this.lostFrom !== null) {
      const ms = s.t - this.lostFrom;
      this.lostFrom = null;
      this.stats.count++;
      this.stats.lastMs = ms;
      this.stats.longestMs = Math.max(this.stats.longestMs, ms);
      if (ms > PREDICT_MS) this.stats.overPredict++;
    }

    if (!this.valid) {
      this.px = p.x; // first sighting: appear where the hand is
      this.py = p.y;
    } else if (this.missing) {
      this.settling = true; // back from a dropout: glide to the hand, don't snap
    }

    this.tx = p.x;
    this.ty = p.y;
    this.lastReal = { x: p.x, y: p.y, t: s.t };
    this.lastSampleT = s.t;
    this.valid = true;
    this.missing = false;
  }

  private reading(state: PaddleState): PaddleReading {
    return { x: this.px, y: this.py, vx: this.vx, vy: this.vy, state };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clampMagnitude(x: number, y: number, max: number): { x: number; y: number } {
  const m = Math.hypot(x, y);
  return m > max ? { x: (x / m) * max, y: (y / m) * max } : { x, y };
}
