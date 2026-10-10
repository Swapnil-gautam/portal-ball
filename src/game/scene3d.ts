import * as THREE from "three";
import type { PaddleAxes } from "./paddleOrientation";
import { paddleSettings } from "./paddleSettings";
import {
  BALL_RADIUS,
  CAMERA_FOV,
  CAMERA_LOOK,
  CAMERA_POS,
  COURT_LENGTH,
  HALF_WIDTH,
  NET_HEIGHT,
  HANDLE_LENGTH,
  HEAD_RADIUS,
  HEAD_THICKNESS,
  STRIKE_Z,
} from "./court";

/**
 * The 3D view from behind your end of the court. Physics already works in
 * these world units (court.ts), so positions pass straight through — no
 * second coordinate system to drift out of sync with the hit test.
 *
 * Network play clears to transparent so the opponent's live video shows
 * through from behind; solo play draws a real court with a net and a ball
 * shadow, since there's no camera feed to look at.
 */

const TRAIL_LENGTH = 7;
const TELEPORT_DISTANCE = 1.2; // a jump bigger than this per frame is a reset, not motion

/** Per display frame, how far the drawn paddle eases toward its target orientation. */
const RENDER_EASE = 0.6;
const WOOD = 0xc8955a;
const AMBER = 0xffa85c;
const CYAN = 0x4cbecb;
const GROUND = 0x0c1113;

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;

  private ball: THREE.Mesh;
  private shadow: THREE.Mesh;
  private trail: THREE.Mesh[] = [];
  private trailHistory: THREE.Vector3[] = [];

  private localPaddle: THREE.Group;
  private aiMarker: THREE.Group;
  private court: THREE.Group;

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

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-3, 6, 2);
    this.scene.add(key);
    // From behind the camera, so the side of the paddle you actually see is
    // lit and its shading changes as you tilt it.
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(2, 3, -5);
    this.scene.add(fill);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 24, 24),
      new THREE.MeshStandardMaterial({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.9 }),
    );
    this.ball.add(new THREE.PointLight(AMBER, 1.2, 3));
    this.scene.add(this.ball);

    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const k = 1 - (i + 1) / (TRAIL_LENGTH + 1);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_RADIUS * (0.35 + 0.55 * k), 10, 10),
        new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.35 * k, depthWrite: false }),
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

    this.localPaddle = this.makePaddle(AMBER);
    this.scene.add(this.localPaddle);

    this.aiMarker = this.makePaddle(CYAN);
    this.aiMarker.visible = false;
    this.scene.add(this.aiMarker);

    this.court = this.buildCourt();
    this.scene.add(this.court);
    this.setMode("ai");
  }

  /**
   * A table-tennis paddle: a round head with some thickness, a solid rim, and
   * a wooden handle below it. The face is semi-transparent so you can still
   * see the ball coming through it. Built around the head's centre, with the
   * handle pointing down local -y and the face normal along local +z.
   */
  private makePaddle(color: number): THREE.Group {
    const g = new THREE.Group();

    const face = new THREE.Mesh(
      new THREE.CylinderGeometry(HEAD_RADIUS, HEAD_RADIUS, HEAD_THICKNESS, 48),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.15,
        roughness: 0.55,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    face.rotation.x = Math.PI / 2; // cylinder axis y → face normal along z

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(HEAD_RADIUS, HEAD_THICKNESS * 0.6, 10, 56),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4, transparent: true }),
    );

    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, HANDLE_LENGTH, 0.05),
      new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.7, transparent: true }),
    );
    handle.position.y = -(HEAD_RADIUS + HANDLE_LENGTH / 2 - 0.02);

    g.add(face, rim, handle);
    g.renderOrder = 2;
    return g;
  }

  private buildCourt(): THREE.Group {
    const g = new THREE.Group();
    const len = COURT_LENGTH + 1;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_WIDTH * 2 + 1.2, len),
      new THREE.MeshStandardMaterial({ color: 0x15201f, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, COURT_LENGTH / 2);
    g.add(floor);

    const lineMat = new THREE.MeshBasicMaterial({ color: 0x5b6b70 });
    const line = (w: number, l: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.004, z);
      g.add(m);
    };
    const baseNear = 0.3;
    const baseFar = COURT_LENGTH - 0.3;
    line(0.05, baseFar - baseNear, -HALF_WIDTH, COURT_LENGTH / 2); // sidelines
    line(0.05, baseFar - baseNear, HALF_WIDTH, COURT_LENGTH / 2);
    line(HALF_WIDTH * 2, 0.05, 0, baseNear); // baselines
    line(HALF_WIDTH * 2, 0.05, 0, baseFar);
    line(0.04, baseFar - baseNear, 0, COURT_LENGTH / 2); // centre line

    const net = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_WIDTH * 2 + 0.6, NET_HEIGHT),
      new THREE.MeshBasicMaterial({ color: 0xb4c2c4, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    );
    net.position.set(0, NET_HEIGHT / 2, COURT_LENGTH / 2);
    g.add(net);

    const tape = new THREE.Mesh(
      new THREE.BoxGeometry(HALF_WIDTH * 2 + 0.6, 0.035, 0.035),
      new THREE.MeshBasicMaterial({ color: 0xe8eeee }),
    );
    tape.position.set(0, NET_HEIGHT, COURT_LENGTH / 2);
    g.add(tape);

    return g;
  }

  /** Transparent backdrop (opponent's real video behind it) vs an opaque court of our own. */
  setMode(mode: "ai" | "network"): void {
    const solo = mode === "ai";
    this.court.visible = solo;
    this.aiMarker.visible = solo;
    this.shadow.visible = solo;
    this.renderer.setClearColor(GROUND, solo ? 1 : 0);
    this.scene.fog = solo ? new THREE.Fog(GROUND, 9, COURT_LENGTH * 2.2) : null;
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

    const [face, rim, handle] = this.localPaddle.children as THREE.Mesh[];
    (face.material as THREE.MeshStandardMaterial).opacity = 0.55 * strength;
    (rim.material as THREE.MeshStandardMaterial).opacity = strength;
    (handle.material as THREE.MeshStandardMaterial).opacity = strength;

    // Paddle size: scale the head (face spans its local x/z before being
    // turned to face down-court; the rim spans x/y) and keep the handle
    // attached to the rim.
    const k = settings.headRadius / HEAD_RADIUS;
    face.scale.set(k, 1, k);
    rim.scale.set(k, k, 1);
    handle.position.y = -(settings.headRadius + HANDLE_LENGTH / 2 - 0.02);
  }

  /** The Paddle lab has no opponent. */
  showOpponent(visible: boolean): void {
    this.aiMarker.visible = visible;
  }

  updateAIMarker(x: number, y: number): void {
    this.aiMarker.position.set(x, y, STRIKE_Z.remote);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
