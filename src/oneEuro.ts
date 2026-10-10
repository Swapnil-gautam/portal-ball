/**
 * One-Euro filter, plus a live estimator for how much lag it is costing.
 *
 * The design doc calls filter lag "the sneaky term" in the latency budget: it is
 * invisible in a profiler because it is not compute time, it is phase delay. So
 * we measure it rather than assume it, by cross-correlating the raw and filtered
 * signals and reporting the shift that best aligns them.
 */

/** Smoothing factor for a first-order low-pass at `cutoffHz`, given a timestep. */
export function alpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

class LowPass {
  private s: number | null = null;

  filter(x: number, a: number): number {
    this.s = this.s === null ? x : a * x + (1 - a) * this.s;
    return this.s;
  }

  reset(): void {
    this.s = null;
  }
}

export interface OneEuroParams {
  /** Baseline cutoff in Hz. Lower = smoother at rest, more lag. */
  minCutoff: number;
  /** Speed coefficient. Higher = cutoff opens up faster when moving. */
  beta: number;
  /** Cutoff for the derivative estimate itself. */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = {
  minCutoff: 1.7,
  beta: 0.035,
  dCutoff: 1.0,
};

export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private prevX: number | null = null;
  private prevT: number | null = null;

  constructor(public params: OneEuroParams) {}

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.prevX = null;
    this.prevT = null;
  }

  /** `tSec` must be monotonically increasing. */
  filter(value: number, tSec: number): number {
    if (this.prevT === null || this.prevX === null) {
      this.prevT = tSec;
      this.prevX = value;
      return this.x.filter(value, 1);
    }

    const dt = Math.max(1e-4, tSec - this.prevT);
    const derivative = (value - this.prevX) / dt;
    const smoothedDerivative = this.dx.filter(derivative, alpha(this.params.dCutoff, dt));
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(smoothedDerivative);
    const out = this.x.filter(value, alpha(cutoff, dt));

    this.prevX = value;
    this.prevT = tSec;
    return out;
  }
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 8) return 0;

  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;

  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }

  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}

export interface LagEstimate {
  lagMs: number;
  /** Peak correlation, 0..1. Below ~0.9 the estimate is not trustworthy. */
  correlation: number;
}

/**
 * Estimates filter phase delay by finding the frame shift `k` for which
 * `filtered[i]` best matches `raw[i - k]`, then converting frames to ms.
 *
 * Only meaningful while the hand is actually moving — a still signal has no
 * phase to measure, so `estimate()` returns null below a motion threshold.
 */
export class LagEstimator {
  private raw: number[] = [];
  private filt: number[] = [];
  private dts: number[] = [];

  constructor(
    private readonly capacity = 240,
    private readonly maxLagFrames = 30,
    /** Minimum std-dev of the raw signal (normalized units) to bother. */
    private readonly minMotion = 0.012,
  ) {}

  push(raw: number, filtered: number, dtSec: number): void {
    this.raw.push(raw);
    this.filt.push(filtered);
    this.dts.push(dtSec);
    if (this.raw.length > this.capacity) {
      this.raw.shift();
      this.filt.shift();
      this.dts.shift();
    }
  }

  reset(): void {
    this.raw.length = 0;
    this.filt.length = 0;
    this.dts.length = 0;
  }

  estimate(): LagEstimate | null {
    const n = this.raw.length;
    const compare = n - this.maxLagFrames;
    if (compare < 40) return null;

    const tail = this.raw.slice(this.maxLagFrames);
    const mean = tail.reduce((s, v) => s + v, 0) / tail.length;
    const variance = tail.reduce((s, v) => s + (v - mean) ** 2, 0) / tail.length;
    if (Math.sqrt(variance) < this.minMotion) return null;

    const target = this.filt.slice(this.maxLagFrames);
    const scores: number[] = [];
    for (let k = 0; k <= this.maxLagFrames; k++) {
      const shifted = this.raw.slice(this.maxLagFrames - k, n - k);
      scores.push(pearson(target, shifted));
    }

    let best = 0;
    for (let k = 1; k < scores.length; k++) {
      if (scores[k] > scores[best]) best = k;
    }

    // Parabolic refinement around the peak for sub-frame resolution.
    let refined = best;
    if (best > 0 && best < scores.length - 1) {
      const y0 = scores[best - 1];
      const y1 = scores[best];
      const y2 = scores[best + 1];
      const denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 1e-9) {
        const offset = (0.5 * (y0 - y2)) / denom;
        if (Math.abs(offset) <= 1) refined = best + offset;
      }
    }

    const meanDt = this.dts.reduce((s, v) => s + v, 0) / this.dts.length;
    return { lagMs: refined * meanDt * 1000, correlation: scores[best] };
  }
}
