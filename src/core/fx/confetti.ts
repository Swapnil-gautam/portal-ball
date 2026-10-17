/**
 * Confetti on a 2D canvas: two cannons fire from the bottom corners, then a
 * couple of waves drift down from the top. Runs its own animation loop only
 * while pieces are on screen, so it costs nothing the rest of the time.
 * People who ask their system for reduced motion get a short, gentle fall.
 */

const COLORS = ["#ff8a3d", "#2fb7c4", "#d9f04a", "#ffffff", "#ff5d8f", "#ffd34d", "#7c8cff"];
const GRAVITY = 1400; // px/s², at device-pixel scale 1

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  flip: number;
  flipSpeed: number;
  round: boolean;
}

export class Confetti {
  private readonly ctx: CanvasRenderingContext2D | null;
  private pieces: Piece[] = [];
  private raf = 0;
  private last = 0;
  private timers: number[] = [];
  /** More waves are still scheduled until this time. */
  private wavesUntil = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
  }

  burst(): void {
    this.stop();
    this.resize();
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      this.rain(40);
    } else {
      this.cannon(-1, 110);
      this.cannon(1, 110);
      this.timers.push(window.setTimeout(() => this.rain(70), 650));
      this.timers.push(window.setTimeout(() => this.rain(60), 1500));
      this.timers.push(window.setTimeout(() => { this.cannon(-1, 50); this.cannon(1, 50); }, 2300));
      this.wavesUntil = performance.now() + 2400;
    }
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.wavesUntil = 0;
    this.pieces = [];
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  private get scale(): number {
    return Math.max(0.6, this.canvas.height / 800);
  }

  private piece(x: number, y: number, vx: number, vy: number): Piece {
    const k = this.scale;
    const round = Math.random() < 0.18;
    const w = (round ? 7 : 6 + Math.random() * 6) * k;
    return {
      x, y, vx, vy,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 12,
      w,
      h: round ? w : (10 + Math.random() * 10) * k,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 6 + Math.random() * 10,
      round,
    };
  }

  /** From a bottom corner, up and inward. `side` −1 = left, 1 = right. */
  private cannon(side: -1 | 1, count: number): void {
    const { width: W, height: H } = this.canvas;
    const k = this.scale;
    for (let i = 0; i < count; i++) {
      const angle = (-Math.PI / 2) + side * -(0.25 + Math.random() * 0.5); // up, tilted toward the middle
      const speed = (900 + Math.random() * 900) * k;
      const x = side < 0 ? W * 0.02 : W * 0.98;
      this.pieces.push(this.piece(x, H * 1.02, Math.cos(angle) * speed, Math.sin(angle) * speed));
    }
    this.restart();
  }

  private rain(count: number): void {
    const W = this.canvas.width;
    const k = this.scale;
    for (let i = 0; i < count; i++) {
      this.pieces.push(this.piece(Math.random() * W, -20 * k - Math.random() * 200 * k, (Math.random() - 0.5) * 200 * k, Math.random() * 150 * k));
    }
    this.restart();
  }

  private restart(): void {
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  private frame(now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const { width: W, height: H } = this.canvas;
    const g = GRAVITY * this.scale;
    const drag = Math.exp(-dt * 1.6);

    ctx.clearRect(0, 0, W, H);
    this.pieces = this.pieces.filter((p) => p.y < H + 60 && p.x > -80 && p.x < W + 80);
    for (const p of this.pieces) {
      p.vx *= drag;
      p.vy = p.vy * drag + g * dt * 0.55;
      // Paper flutters: sideways wobble as it falls.
      p.x += (p.vx + Math.sin(p.flip) * 40 * this.scale) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.flip += p.flipSpeed * dt;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.flip)); // turning over in the air
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }

    if (this.pieces.length || now < this.wavesUntil) {
      this.raf = requestAnimationFrame((t) => this.frame(t));
    } else {
      this.raf = 0;
    }
  }
}
