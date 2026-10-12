/** Fixed-capacity rolling window with the few statistics the HUD needs. */
export class Rolling {
  private buf: number[] = [];

  constructor(private readonly capacity = 120) {}

  push(v: number): void {
    this.buf.push(v);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  get count(): number {
    return this.buf.length;
  }

  get mean(): number {
    if (!this.buf.length) return 0;
    return this.buf.reduce((s, v) => s + v, 0) / this.buf.length;
  }

  /** Nearest-rank percentile, `p` in 0..1. */
  percentile(p: number): number {
    if (!this.buf.length) return 0;
    const sorted = [...this.buf].sort((a, b) => a - b);
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[i];
  }

  reset(): void {
    this.buf.length = 0;
  }
}

export const fmt = {
  ms(v: number | null, digits = 1): string {
    return v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)} ms`;
  },
  num(v: number | null, digits = 1): string {
    return v === null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
  },
  pct(v: number | null, digits = 0): string {
    return v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
  },
};
