import type { PaddleSample } from "./tracker";

export const COLOR = {
  ink: "#E8EEEE",
  muted: "#7D8F95",
  rule: "#283336",
  cyan: "#4CBECB",
  amber: "#FFA85C",
  warn: "#E4705C",
  ok: "#6FBE8C",
  ground: "#0C1113",
};

export interface Surface {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  video: HTMLVideoElement;
  /** width / height */
  aspect: number;
}

const HAND_LINKS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 5], [0, 17], [5, 9], [9, 13], [13, 17],
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];

export function clear(s: Surface, fill = COLOR.ground): void {
  s.ctx.fillStyle = fill;
  s.ctx.fillRect(0, 0, s.w, s.h);
}

/** Draws the camera feed mirrored, so the display reads like a mirror. */
export function drawVideo(s: Surface, dim = 0): void {
  const { ctx, w, h } = s;
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(s.video, 0, 0, w, h);
  ctx.restore();
  if (dim > 0) {
    ctx.fillStyle = `rgba(12,17,19,${dim})`;
    ctx.fillRect(0, 0, w, h);
  }
}

export function drawSkeleton(s: Surface, sample: PaddleSample): void {
  if (!sample.landmarks) return;
  const { ctx, w, h } = s;
  const pts = sample.landmarks;

  ctx.save();
  ctx.strokeStyle = "rgba(76,190,203,0.55)";
  ctx.lineWidth = Math.max(1.5, w * 0.002);
  ctx.beginPath();
  for (const [a, b] of HAND_LINKS) {
    ctx.moveTo(pts[a].x * w, pts[a].y * h);
    ctx.lineTo(pts[b].x * w, pts[b].y * h);
  }
  ctx.stroke();

  ctx.fillStyle = COLOR.cyan;
  const r = Math.max(2, w * 0.0032);
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The paddle, plus a hollow ghost at the unfiltered position. The gap between
 * them is filter lag made visible — if the ghost runs far ahead during a swing,
 * the filter is costing more than the HUD number suggests.
 */
export function drawPaddle(s: Surface, sample: PaddleSample, showGhost = true): void {
  if (!sample.present) return;
  const { ctx, w, h } = s;
  const radius = Math.max(w * 0.055, sample.span * w * 1.35);

  if (showGhost) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,168,92,0.35)";
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = Math.max(1, w * 0.0015);
    ctx.beginPath();
    ctx.arc(sample.rawX * w, sample.rawY * h, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const cx = sample.x * w;
  const cy = sample.y * h;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(sample.angle);
  ctx.fillStyle = "rgba(255,168,92,0.16)";
  ctx.strokeStyle = COLOR.amber;
  ctx.lineWidth = Math.max(2, w * 0.0025);
  ctx.beginPath();
  ctx.ellipse(0, 0, radius, radius * 0.86, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Handle, pointing along the palm's "up" axis.
  ctx.beginPath();
  ctx.moveTo(-radius * 0.95, 0);
  ctx.lineTo(-radius * 1.75, 0);
  ctx.lineWidth = Math.max(3, w * 0.006);
  ctx.stroke();
  ctx.restore();

  // Velocity vector — the signal that will drive shot power.
  if (sample.speed > 0.08) {
    ctx.save();
    ctx.strokeStyle = COLOR.warn;
    ctx.lineWidth = Math.max(2, w * 0.0028);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + sample.vx * w * 0.16, cy + sample.vy * w * 0.16);
    ctx.stroke();
    ctx.restore();
  }
}

export function label(
  s: Surface,
  text: string,
  x: number,
  y: number,
  opts: { size?: number; color?: string; align?: CanvasTextAlign } = {},
): void {
  const { ctx } = s;
  ctx.save();
  ctx.font = `${opts.size ?? 16}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = opts.color ?? COLOR.muted;
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
  ctx.restore();
}
