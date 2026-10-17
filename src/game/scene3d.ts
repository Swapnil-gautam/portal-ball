import * as THREE from "three";
import { Avatar, type AvatarStyle } from "./avatar";
import { BALL_RADIUS, CAMERA_FOV, CAMERA_LOOK, CAMERA_POS, HALF_WIDTH, HEAD_RADIUS, STRIKE_Z } from "./court";
import type { PaddleAxes } from "./paddleOrientation";
import { FACE_HALF_HEIGHT, handleY, makePickleballPaddle } from "./paddleModel";
import { paddleSettings } from "./paddleSettings";
import type { Side } from "./physics";
import { buildVenue, pickleballMaterial, type Venue } from "./venue";

/**
 * The 3D view from behind your end of the court. Physics already works in
 * these world units (court.ts), so positions pass straight through — no
 * second coordinate system to drift out of sync with the hit test.
 *
 * The surroundings (court, net, fence, lights, crowd, sky) come from
 * venue.ts, the paddles from paddleModel.ts and the opponent figure from
 * avatar.ts, so other venues, paddle styles and characters can be added
 * later without touching this file.
 */

const TRAIL_LENGTH = 7;
const TELEPORT_DISTANCE = 1.2; // a jump bigger than this per frame is a reset, not motion

/** Per display frame, how far the drawn paddle eases toward its target orientation. */
const RENDER_EASE = 0.6;
const YOUR_PADDLE = 0xff8a3d;
const THEIR_PADDLE = 0x2fb7c4;
const BALL_TRAIL = 0xd9f04a;

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;

  private ball: THREE.Mesh;
  private shadow: THREE.Mesh;
  private trail: THREE.Mesh[] = [];
  private trailHistory: THREE.Vector3[] = [];

  private localPaddle: THREE.Group;
  private opponentPaddle: THREE.Group;
  private readonly venue: Venue;
  private readonly avatar: Avatar;
  private readonly gripPoint = new THREE.Vector3();
  private lastRenderAt = performance.now();
  private readonly opponentTurn = new THREE.Quaternion();
  private readonly lastBallPos = new THREE.Vector3();

  private readonly ray = new THREE.Vector3();
  private readonly turnTarget = new THREE.Quaternion();
  private readonly basis = new THREE.Matrix4();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 60);
    this.camera.position.set(CAMERA_POS.x, CAMERA_POS.y, CAMERA_POS.z);
    this.camera.lookAt(CAMERA_LOOK.x, CAMERA_LOOK.y, CAMERA_LOOK.z);
    this.camera.updateMatrixWorld();

    this.venue = buildVenue(this.scene);

    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 28, 20), pickleballMaterial());
    this.scene.add(this.ball);

    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const k = 1 - (i + 1) / (TRAIL_LENGTH + 1);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_RADIUS * (0.35 + 0.55 * k), 10, 10),
        new THREE.MeshBasicMaterial({ color: BALL_TRAIL, transparent: true, opacity: 0.3 * k, depthWrite: false }),
      );
      dot.visible = false;
      this.trail.push(dot);
      this.scene.add(dot);
    }

    // A soft dark disc under the ball. Its size and darkness track height, so
    // you can read where the ball will bounce well before it lands.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 1.6, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.shadow);

    this.localPaddle = makePickleballPaddle(YOUR_PADDLE);
    this.scene.add(this.localPaddle);

    this.opponentPaddle = makePickleballPaddle(THEIR_PADDLE);
    this.opponentPaddle.visible = false;
    this.scene.add(this.opponentPaddle);

    // The opponent stands just behind their paddle, holding it.
    this.avatar = new Avatar(STRIKE_Z.remote + 0.42, THEIR_PADDLE, HALF_WIDTH + 0.5);
    this.avatar.group.visible = false;
    this.scene.add(this.avatar.group);
  }

  /** The practice partner wears a cap; a friend, a white shirt and headband. */
  setOpponentStyle(style: AvatarStyle): void {
    this.avatar.setStyle(style);
  }

  /** A point ended: the winner's side reacts. */
  pointWon(by: Side): void {
    const now = performance.now();
    if (by === "local") {
      this.venue.crowd.cheer(0.5, now);
      this.avatar.setMood("sad", 1.1, now);
    } else {
      this.avatar.setMood("cheer", 1.2, now);
    }
  }

  /** The match ended: big cheer and a dejected opponent, or the opponent celebrating. */
  matchWon(by: Side): void {
    const now = performance.now();
    if (by === "local") {
      this.venue.crowd.cheer(1, now);
      this.avatar.setMood("sad", Infinity, now);
    } else {
      this.avatar.setMood("cheer", Infinity, now);
    }
  }

  resetReactions(): void {
    this.avatar.resetMood();
    this.venue.crowd.calm();
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Map a point on screen (0..1, already mirrored the way the player sees
   * themselves) to the local strike plane. The paddle then sits exactly
   * under your hand on screen — the earlier version mapped screen to court
   * linearly and drew the paddle at a different depth from where it was
   * hit-tested, so lining it up by eye didn't line it up in the physics.
   */
  screenToStrikePlane(u: number, v: number): { x: number; y: number } {
    this.ray.set(u * 2 - 1, -(v * 2 - 1), 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const t = (STRIKE_Z.local - this.camera.position.z) / this.ray.z;
    return {
      x: this.camera.position.x + this.ray.x * t,
      y: this.camera.position.y + this.ray.y * t,
    };
  }

  updateBall(pos: { x: number; y: number; z: number }): void {
    const prev = this.ball.position.clone();
    this.ball.position.set(pos.x, pos.y, pos.z);

    // Roll the ball the way it's travelling, so its holes visibly turn.
    const dx = pos.x - this.lastBallPos.x;
    const dz = pos.z - this.lastBallPos.z;
    if (Math.hypot(dx, dz) < 1) {
      this.ball.rotation.x += dz / BALL_RADIUS;
      this.ball.rotation.z -= dx / BALL_RADIUS;
    }
    this.lastBallPos.set(pos.x, pos.y, pos.z);

    // A serve or a new point teleports the ball; don't streak a trail across the court.
    if (prev.distanceTo(this.ball.position) > TELEPORT_DISTANCE) this.trailHistory.length = 0;
    this.trailHistory.unshift(this.ball.position.clone());
    if (this.trailHistory.length > TRAIL_LENGTH + 1) this.trailHistory.pop();
    this.trail.forEach((dot, i) => {
      const p = this.trailHistory[i + 1];
      dot.visible = !!p;
      if (p) dot.position.copy(p);
    });

    const height = Math.max(0, pos.y - BALL_RADIUS);
    const spread = 1 + height * 0.35;
    this.shadow.position.set(pos.x, 0.006, pos.z);
    this.shadow.scale.setScalar(spread);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.55 / (1 + height * 0.9);
  }

  /**
   * `x, y` is the centre of the paddle head. `axes` is the paddle's finished
   * orientation (see PaddleOrientation); null keeps the last one, e.g. while
   * the hand is lost. `strength` 1 = tracked; lower while the position is a guess.
   */
  updateLocalPaddle(x: number, y: number, axes: PaddleAxes | null, visible: boolean, strength = 1): void {
    this.localPaddle.visible = visible;
    if (!visible) return;
    this.localPaddle.position.set(x, y, STRIKE_Z.local);

    const settings = paddleSettings();
    if (axes) {
      this.basis.makeBasis(
        new THREE.Vector3(axes.x.x, axes.x.y, axes.x.z),
        new THREE.Vector3(axes.y.x, axes.y.y, axes.y.z),
        new THREE.Vector3(axes.z.x, axes.z.y, axes.z.z),
      );
      this.turnTarget.setFromRotationMatrix(this.basis);
      // Only bridges the camera's ~30 updates a second into smooth 60fps
      // motion; the real steadiness work happens in PaddleOrientation.
      this.localPaddle.quaternion.slerp(this.turnTarget, RENDER_EASE);
    }

    const [face, guard, handle] = this.localPaddle.children as [THREE.Mesh, THREE.Mesh, THREE.Group];
    (face.material as THREE.MeshStandardMaterial).opacity = 0.55 * strength;
    (guard.material as THREE.MeshStandardMaterial).opacity = strength;
    for (const part of handle.children as THREE.Mesh[]) (part.material as THREE.MeshStandardMaterial).opacity = strength;

    // Paddle size: scale the head and keep the grip attached below it.
    const k = settings.headRadius / HEAD_RADIUS;
    face.scale.set(k, k, 1);
    guard.scale.set(k, k, 1);
    handle.position.y = handleY(FACE_HALF_HEIGHT * k);
  }

  /**
   * The opponent's paddle at the far end — the AI's, or the other player's
   * as sent over the network (already mirrored into our court). `axes`
   * null keeps the current orientation; the AI never tilts its paddle.
   */
  updateOpponentPaddle(x: number, y: number, axes: PaddleAxes | null, visible: boolean): void {
    this.opponentPaddle.visible = visible;
    if (!visible) return;
    this.opponentPaddle.position.set(x, y, STRIKE_Z.remote);
    if (axes) {
      this.basis.makeBasis(
        new THREE.Vector3(axes.x.x, axes.x.y, axes.x.z),
        new THREE.Vector3(axes.y.x, axes.y.y, axes.y.z),
        new THREE.Vector3(axes.z.x, axes.z.y, axes.z.z),
      );
      this.opponentTurn.setFromRotationMatrix(this.basis);
      this.opponentPaddle.quaternion.slerp(this.opponentTurn, RENDER_EASE);
    }
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastRenderAt) / 1000));
    this.lastRenderAt = now;

    this.venue.crowd.update(now);
    this.avatar.group.visible = this.opponentPaddle.visible;
    if (this.opponentPaddle.visible) {
      // The hand goes where the paddle's grip is, however the paddle is turned.
      this.opponentPaddle.updateMatrixWorld();
      this.gripPoint.set(0, handleY(FACE_HALF_HEIGHT), 0);
      this.opponentPaddle.localToWorld(this.gripPoint);
      this.avatar.update(this.gripPoint, this.ball.position, dt, now);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
