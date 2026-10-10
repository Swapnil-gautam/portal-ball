import type { HandPose, Vec3 } from "./paddlePose";
import { paddleSettings } from "./paddleSettings";

/**
 * Turns raw per-frame hand angles into a steady paddle orientation.
 *
 *   - Handle: follows your knuckle line (17 → 5) on screen, exactly.
 *   - Face: tilts toward your palm's plane, but only part of the way and
 *     never past a cap — at full strength, a fist grip (palm edge-on to the
 *     camera) turned the paddle edge-on too.
 *   - Steadiness: each reading is first compared with its two neighbours
 *     (median of 3) so a one-frame tracking glitch is dropped; then small
 *     wobbles are mostly ignored while a change big enough to be deliberate
 *     passes straight through, so there's no lag on a real turn. (Without the
 *     median, a single bad frame on an edge-on palm looked "deliberate" and
 *     got through as a sudden jump.)
 *
 * It also fixes the "jumps around" bug. A paddle has two faces, so the palm
 * normal's sign is arbitrary; the old code forced it to face down the court.
 * With the palm near edge-on — common when gripping — tracking noise flipped
 * that sign back and forth, and each flip sent the paddle swinging through a
 * large rotation. Here the sign is kept continuous from one frame to the next.
 */

/** Knuckle span (frame widths) below which the knuckle line is too foreshortened to fully trust. */
const SPAN_RELIABLE = 0.035;
/** An angle change this big in one camera frame (radians) counts as deliberate — no smoothing. */
const DELIBERATE_TURN = 0.5;
/** Past this (palm turned to face you), re-anchor the sign; a two-sided face looks the same either way. */
const REANCHOR_ANGLE = (135 * Math.PI) / 180;

export interface PaddleAxes {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export class PaddleOrientation {
  /** Smoothed handle direction on the paddle plane (world x/y), unit length. */
  handle = { x: 0, y: 1 };
  /** Smoothed palm normal, sign kept continuous. */
  private normal: Vec3 = { x: 0, y: 0, z: 1 };
  private started = false;
  /** Last three raw readings, for the median that drops one-frame glitches. */
  private recentHandles: { x: number; y: number }[] = [];
  private recentNormals: Vec3[] = [];

  /** For the lab readout: the palm's own tilt from facing the camera, and how much the paddle shows. */
  palmTiltDeg = 0;
  paddleTiltDeg = 0;

  reset(): void {
    this.started = false;
    this.recentHandles = [];
    this.recentNormals = [];
    this.handle = { x: 0, y: 1 };
    this.normal = { x: 0, y: 0, z: 1 };
  }

  /** Call once per new camera frame of the hand. */
  update(pose: HandPose): void {
    const smallBlend = 1 - paddleSettings().angleSteadiness;

    if (!this.started) {
      this.handle = { ...pose.handle };
      if (pose.normal) this.normal = pose.normal.z >= 0 ? { ...pose.normal } : scale(pose.normal, -1);
      this.started = true;
      this.updateReadout();
      return;
    }

    // Handle: a foreshortened knuckle line has a noisy direction, so trust it less.
    const reliability = clamp(pose.handleSpan / SPAN_RELIABLE, 0.15, 1);
    const h = median2(pushRecent(this.recentHandles, pose.handle));
    const turn = Math.acos(clamp(this.handle.x * h.x + this.handle.y * h.y, -1, 1));
    const hBlend = adaptiveBlend(turn, smallBlend) * reliability;
    this.handle = normalize2({
      x: this.handle.x + (h.x - this.handle.x) * hBlend,
      y: this.handle.y + (h.y - this.handle.y) * hBlend,
    });

    if (pose.normal) {
      // Keep the sign continuous rather than forcing it down-court.
      const signed = dot(pose.normal, this.normal) < 0 ? scale(pose.normal, -1) : pose.normal;
      let n = median3(pushRecent(this.recentNormals, signed), this.normal);
      const change = Math.acos(clamp(dot(n, this.normal), -1, 1));
      const nBlend = adaptiveBlend(change, smallBlend);
      n = normalize3(add(this.normal, scale(sub(n, this.normal), nBlend))) ?? this.normal;
      // Turned right round to face you: flip back, so tilt is measured from the nearer face.
      if (Math.acos(clamp(n.z, -1, 1)) > REANCHOR_ANGLE) n = scale(n, -1);
      this.normal = n;
    }

    this.updateReadout();
  }

  private updateReadout(): void {
    const tilt = Math.acos(clamp(Math.abs(this.normal.z), 0, 1));
    this.palmTiltDeg = (tilt * 180) / Math.PI;
  }

  /** The paddle's axes: x across the face, y along the handle toward the head, z the face normal. */
  axes(): PaddleAxes {
    const { slant, maxSlantDeg } = paddleSettings();

    // Face: start facing straight down the court and tilt toward the palm's
    // normal — by \`slant\` of the palm's tilt, capped at maxSlantDeg.
    const n = this.normal;
    const theta = Math.acos(clamp(n.z, -1, 1));
    const phi = Math.min(theta * slant, (maxSlantDeg * Math.PI) / 180);
    this.paddleTiltDeg = (phi * 180) / Math.PI;
    const across = Math.hypot(n.x, n.y);
    const z: Vec3 =
      across < 1e-6
        ? { x: 0, y: 0, z: 1 }
        : { x: (n.x / across) * Math.sin(phi), y: (n.y / across) * Math.sin(phi), z: Math.cos(phi) };

    // Handle: the knuckle direction, kept within the face.
    const d: Vec3 = { x: this.handle.x, y: this.handle.y, z: 0 };
    const y = normalize3(sub(d, scale(z, dot(d, z)))) ?? { x: 0, y: 1, z: 0 };
    return { x: cross(y, z), y, z };
  }
}

function pushRecent<T>(list: T[], item: T): T[] {
  list.push(item);
  if (list.length > 3) list.shift();
  return list;
}

const mid = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/** Component-wise median of up to three directions — drops a single outlier. */
function median2(v: { x: number; y: number }[]): { x: number; y: number } {
  if (v.length < 3) return v[v.length - 1];
  return normalize2({ x: mid(v[0].x, v[1].x, v[2].x), y: mid(v[0].y, v[1].y, v[2].y) });
}

/** Same for normals; each is first given the sign that agrees with `ref`, since a face's normal is two-sided. */
function median3(v: Vec3[], ref: Vec3): Vec3 {
  const last = v[v.length - 1];
  if (v.length < 3) return last;
  const [a, b, c] = v.map((n) => (dot(n, ref) < 0 ? scale(n, -1) : n));
  return normalize3({ x: mid(a.x, b.x, c.x), y: mid(a.y, b.y, c.y), z: mid(a.z, b.z, c.z) }) ?? last;
}

/** Small changes blend in gently (steadiness); deliberate ones come through at once. */
function adaptiveBlend(change: number, smallBlend: number): number {
  return clamp(smallBlend + (1 - smallBlend) * (change / DELIBERATE_TURN), smallBlend, 1);
}

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
function normalize3(a: Vec3): Vec3 | null {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 1e-9 ? scale(a, 1 / l) : null;
}
function normalize2(a: { x: number; y: number }): { x: number; y: number } {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 1 };
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
