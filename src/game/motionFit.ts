/**
 * Estimates where the hand is *now*, and how it's moving, from its last few
 * raw camera positions.
 *
 * It fits a smooth curve through the last few positions (the "Frames in motion
 * fit" setting, 6 by default) and reads the
 * position and velocity off that curve at the newest frame. Using several
 * frames averages out tracking jitter; reading the curve at "now" (instead of
 * averaging) avoids lag.
 *
 * This replaced a One-Euro filter whose speed setting was tuned for pixels
 * while positions here are 0..1 of the screen — so it never noticed fast
 * movement and smoothed a swing as hard as a still hand. Simulated on a
 * sudden arm movement, that filter trailed the hand by 20% of the screen and
 * arrived ~205ms late; this fit trails by ~1% and adds no lag beyond the
 * camera's own frame timing. Compared alternatives: straight-line fits lag a
 * hand that's speeding up, and adaptive window sizes overshoot when it stops.
 */

import { paddleSettings } from "./paddleSettings";

/** Below this speed (world units/s) the hand counts as still and gets smoothed; above MOVING, not at all. */
const STILL_SPEED = 0.25;
const MOVING_SPEED = 1.2;

interface Sample {
  t: number;
  x: number;
  y: number;
}

export interface MotionEstimate {
  x: number;
  y: number;
  /** World units per second, from the same fit. */
  vx: number;
  vy: number;
}

export class MotionFit {
  private samples: Sample[] = [];
  private out: { x: number; y: number } | null = null;

  reset(): void {
    this.samples.length = 0;
    this.out = null;
  }

  /** Add a camera frame's position (world units, time in ms) and get the current estimate. */
  push(t: number, x: number, y: number): MotionEstimate {
    const { fitFrames, restSmoothing } = paddleSettings();
    this.samples.push({ t, x, y });
    while (this.samples.length > fitFrames) this.samples.shift();

    const fx = fitAtLatest(this.samples, (s) => s.x);
    const fy = fitAtLatest(this.samples, (s) => s.y);

    const speed = Math.hypot(fx.velocity, fy.velocity);
    const moving = clamp((speed - STILL_SPEED) / (MOVING_SPEED - STILL_SPEED), 0, 1);
    // How much of each new reading to take: (1 - restSmoothing) when still, all of it when moving.
    const restBlend = 1 - restSmoothing;
    const blend = restBlend + (1 - restBlend) * moving;

    this.out = this.out === null
      ? { x: fx.value, y: fy.value }
      : { x: this.out.x + (fx.value - this.out.x) * blend, y: this.out.y + (fy.value - this.out.y) * blend };

    return { x: this.out.x, y: this.out.y, vx: fx.velocity, vy: fy.velocity };
  }
}

/**
 * Least-squares fit of a quadratic in time through the samples, evaluated at
 * the newest sample: value and slope there. Falls back to a straight line
 * (or the raw value) while there are too few samples for a curve.
 */
function fitAtLatest(samples: Sample[], pick: (s: Sample) => number): { value: number; velocity: number } {
  const n = samples.length;
  const latest = samples[n - 1];
  if (n === 1) return { value: pick(latest), velocity: 0 };

  const degree = n >= 4 ? 2 : 1;
  const m = degree + 1;
  // Normal equations in seconds relative to the newest sample, so the
  // constant term is the value "now" and the linear term is the velocity.
  const A = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const b = new Array<number>(m).fill(0);
  for (const s of samples) {
    const dt = (s.t - latest.t) / 1000;
    const v = pick(s);
    for (let i = 0; i < m; i++) {
      b[i] += v * dt ** i;
      for (let j = 0; j < m; j++) A[i][j] += dt ** (i + j);
    }
  }

  const c = solve(A, b);
  if (!c) return { value: pick(latest), velocity: 0 };
  return { value: c[0], velocity: c[1] };
}

/** Gaussian elimination for the small (2×2 / 3×3) systems above. Null if degenerate. */
function solve(A: number[][], b: number[]): number[] | null {
  const m = b.length;
  for (let i = 0; i < m; i++) {
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let k = i + 1; k < m; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < m; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const c = new Array<number>(m).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < m; j++) s -= A[i][j] * c[j];
    c[i] = s / A[i][i];
  }
  return c;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
