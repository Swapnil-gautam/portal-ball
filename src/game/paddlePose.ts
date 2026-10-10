import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";

/**
 * How the paddle sits in your hand, from three hand landmarks:
 *
 *   0  wrist
 *   5  index-finger knuckle
 *   17 pinky knuckle
 *
 * Close your hand around a handle and your knuckles line up along it — index
 * knuckle at the top, pinky knuckle at the bottom. So:
 *
 *   - the handle runs along the line 17 → 5, and the head sits past the index
 *     knuckle (5), where a paddle blade sits above your index finger;
 *   - the paddle face tilts toward the plane through 0, 5 and 17 — your
 *     palm's plane — by a reduced, capped amount (see PaddleOrientation).
 *
 * (An earlier version used wrist → middle knuckle as "up", which is
 * perpendicular to how a gripped handle actually runs.)
 *
 * Coordinates: MediaPipe's 3D hand points come in the webcam's own frame
 * (x right as the webcam sees it, y down, z away from the webcam). The game
 * world is viewed from behind the player looking at the webcam, so the
 * conversion is (x, -y, -z) — a pure rotation, which keeps cross products
 * (and so the face normal) pointing the right way.
 */

export const WRIST = 0;
export const INDEX_MCP = 5;
export const PINKY_MCP = 17;

/**
 * MediaPipe documents z as "smaller = closer to the camera". If the paddle
 * ever tilts the opposite way to your palm, that convention doesn't hold for
 * these 3D points on your setup — flip this.
 */
const DEPTH_SIGN = 1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface HandPose {
  /** Unit direction along the handle toward the head (17 → 5), in world x/y on the paddle's plane. */
  handle: { x: number; y: number };
  /**
   * Length of 17 → 5 on screen, in frame widths. Short means the knuckle line
   * is foreshortened (pointing at the camera) and its direction is unreliable.
   */
  handleSpan: number;
  /**
   * Normal of the 0-5-17 palm plane, game-world coordinates. Unsigned — a
   * paddle has two faces — so the caller picks the sign (see PaddleOrientation).
   * Null if unreadable.
   */
  normal: Vec3 | null;
}

/**
 * `screen` is the tracker's display-space (mirrored) landmarks, `world` its
 * raw 3D landmarks, `aspect` the camera's width/height.
 */
export function handPose(screen: NormalizedLandmark[], world: Landmark[] | null, aspect: number): HandPose {
  const from = screen[PINKY_MCP];
  const to = screen[INDEX_MCP];
  // Screen: x right, y down, y measured in heights → rescale to widths.
  const dx = to.x - from.x;
  const dy = (to.y - from.y) / aspect;
  const span = Math.hypot(dx, dy);
  // World on the paddle plane: screen-right is world -x, screen-down is world -y.
  const handle = span > 1e-6 ? { x: -dx / span, y: -dy / span } : { x: 0, y: 1 };
  return { handle, handleSpan: span, normal: world ? palmNormal(world) : null };
}

function palmNormal(world: Landmark[]): Vec3 | null {
  const toWorld = (l: Landmark): Vec3 => ({ x: l.x, y: -l.y, z: -l.z * DEPTH_SIGN });
  const wrist = toWorld(world[WRIST]);
  const index = toWorld(world[INDEX_MCP]);
  const pinky = toWorld(world[PINKY_MCP]);
  return normalize(cross(sub(index, wrist), sub(pinky, wrist)));
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
function normalize(a: Vec3): Vec3 | null {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 1e-6 ? scale(a, 1 / l) : null;
}
