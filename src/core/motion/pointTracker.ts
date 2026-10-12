import { MotionFit, type MotionFitOptions } from "./motionFit";

/**
 * Turns per-camera-frame samples of a point on the hand (a paddle head, a
 * drumstick tip, a fingertip…) into a smooth, lag-free position that doesn't
 * blink out when tracking drops.
 *
 * Fast moves blur the hand and the tracker drops it for a few frames —
 * exactly when the point matters most. When that happens it:
 *
 *   1. predicts (≤ PREDICT_MS): keeps moving in the direction and at the
 *      speed fitted from the last several camera frames (see MotionFit).
 *      It extrapolates velocity only, not acceleration — simulated against
 *      a noisy swing, extrapolating acceleration sent the point up to 10
 *      units off.
 *   2. holds (≤ HOLD_MS): no prediction is accurate past ~250ms, so it stops
 *      where it got to, faded, rather than vanishing.
 *   3. hides, only once the hand has really been gone a while.
 *
 * When the hand comes back the point glides to it instead of snapping, and
 * shot speed is measured from the last real sighting, so a dropout can't
 * become a phantom full-power swing.
 */

export interface PointSample {
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

export type PointState = "tracked" | "predicted" | "held";

/** Where the point is now, and how it's moving (units per second), in the caller's units. */
export interface PointReading {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: PointState;
}

export interface PointBounds {
  /** Half-width: x stays within ±x. */
  x: number;
  yMin: number;
  yMax: number;
}

export interface PointTrackerOptions extends MotionFitOptions {
  /** How far ahead (ms) to project between camera frames. */
  lookAheadMs: number;
  /** Where a projected or predicted point may go — e.g. the visible play area. */
  bounds?: PointBounds;
}

/** How long the hand has been missing, for the debug readout. */
export interface DropoutStats {
  count: number;
  longestMs: number;
  lastMs: number;
  /** Dropouts long enough that the point had to hold still instead of predicting. */
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
/** No limit unless the caller gives one. */
const UNBOUNDED: PointBounds = { x: Infinity, yMin: -Infinity, yMax: Infinity };

export class PointTracker {
  /** Where the point is shown (and, for the paddle game, hit-tested). */
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
  private readonly fit: MotionFit;
  private predictT = 0;
  private lastReal: { x: number; y: number; t: number } | null = null;
  private lastSampleT = -1;
  private valid = false;
  private missing = false;
  private settling = false;
  /** When the current dropout began. Survives the point hiding, so long dropouts still get counted. */
  private lostFrom: number | null = null;

  readonly stats: DropoutStats = { count: 0, longestMs: 0, lastMs: 0, overPredict: 0 };

  /**
   * `toPlane` maps a screen point (0..1) into the caller's units (for the
   * paddle game, the court's strike plane). `options` is read every frame.
   */
  constructor(
    private readonly toPlane: (u: number, v: number) => { x: number; y: number },
    private readonly options: () => PointTrackerOptions,
  ) {
    this.fit = new MotionFit(options);
  }

  reset(): void {
    this.lostFrom = null;
    this.forget();
  }

  /** Drop the point's state, but keep counting the dropout in progress. */
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
  update(sample: PointSample, now: number): PointReading | null {
    if (sample.present) {
      if (sample.t !== this.lastSampleT) this.takeSample(sample);

      const moving = clamp(Math.hypot(this.vx, this.vy) / LEAD_FULL_SPEED, 0, 1);
      const lead = this.lastReal ? (clamp(now - this.lastReal.t, 0, this.options().lookAheadMs) / 1000) * moving : 0;
      const b = this.options().bounds ?? UNBOUNDED;
      const gx = clamp(this.tx + this.vx * lead, -b.x, b.x);
      const gy = clamp(this.ty + this.vy * lead, b.yMin, b.yMax);

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
      const b = this.options().bounds ?? UNBOUNDED;
      this.px = clamp(this.px + this.predVx * dt, -b.x, b.x);
      this.py = clamp(this.py + this.predVy * dt, b.yMin, b.yMax);
      this.predictT = now;
      this.settling = false;
      return this.reading("predicted");
    }

    // Past the point where prediction is trustworthy: hold still, faded.
    this.vx = this.vy = 0;
    return this.reading("held");
  }

  private takeSample(s: PointSample): void {
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

  private reading(state: PointState): PointReading {
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
