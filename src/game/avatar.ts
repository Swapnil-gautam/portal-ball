import * as THREE from "three";

/**
 * The opponent at the far end of the court: a person who holds the
 * opponent's paddle, side-steps to stay behind it, bends their knees for low
 * balls, watches the ball, and reacts to points.
 *
 * Built from simple shapes in code (no model files). Small, constant
 * movement keeps them alive between shots: breathing, shifting weight, a
 * relaxed ready bounce, the free arm swinging, real steps when they move.
 *
 * Coordinates: the avatar faces the camera (−z). Their own right side is
 * +x, which is screen-left from the camera — the paddle hand.
 */

/** The practice partner wears a cap and team shirt; a friend, a white shirt and headband. */
export type AvatarStyle = "partner" | "friend";
export type AvatarMood = "ready" | "cheer" | "sad";

const UPPER_ARM = 0.31;
const FOREARM = 0.29;
const THIGH = 0.45;
const SHIN = 0.44;
const HIP_HEIGHT = 0.92;
const TORSO_HEIGHT = 0.52; // hips → base of the neck
const SHOULDER_HALF = 0.2;
const NECK = 0.08;
const HEAD_RADIUS = 0.115;
/** The grip sits this far to the avatar's right of their centre line. */
const GRIP_SIDE = 0.3;

interface Outfit {
  skin: number;
  hair: number;
  shirt: number;
  trim: number;
  shorts: number;
  shoes: number;
  cap: boolean;
}

function outfit(style: AvatarStyle, team: number): Outfit {
  return style === "partner"
    ? { skin: 0xd09a72, hair: 0x2a1d14, shirt: team, trim: 0xffffff, shorts: 0x26313b, shoes: 0xf2f2f2, cap: true }
    : { skin: 0xb98060, hair: 0x15100d, shirt: 0xf3f4f6, trim: team, shorts: 0x1d5f68, shoes: 0xffffff, cap: false };
}

const mat = (color: number, roughness = 0.75) => new THREE.MeshStandardMaterial({ color, roughness });

/** A limb segment: a tapered cylinder along +y, stretched between two points each frame. */
function segment(rTop: number, rBottom: number, m: THREE.Material): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(rBottom, rTop, 1, 12);
  geo.translate(0, 0.5, 0);
  return new THREE.Mesh(geo, m);
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();

function stretch(seg: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  tmpDir.subVectors(to, from);
  const len = tmpDir.length();
  seg.position.copy(from);
  seg.scale.set(1, Math.max(0.001, len), 1);
  if (len > 1e-6) seg.quaternion.setFromUnitVectors(UP, tmpDir.multiplyScalar(1 / len));
}

/**
 * Two-bone reach: where the middle joint (elbow/knee) goes so the limb runs
 * from `root` to `target`, bending toward `pole`. Out of reach, it points straight.
 */
function solveJoint(root: THREE.Vector3, target: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const dir = new THREE.Vector3().subVectors(target, root);
  const d = Math.min(Math.max(dir.length(), Math.abs(a - b) + 1e-3), a + b - 1e-3);
  dir.normalize();
  const cos = (a * a + d * d - b * b) / (2 * a * d);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  const bend = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir)));
  if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0);
  bend.normalize();
  return out.copy(root).addScaledVector(dir, cos * a).addScaledVector(bend, sin * a);
}

/** Torso shape: hips, a narrower waist, a broader chest and shoulders, rounding into the neck. */
function torsoGeometry(): THREE.BufferGeometry {
  const profile = [
    [0.0, -0.02], [0.135, 0.0], [0.14, 0.06], [0.125, 0.16], [0.135, 0.26], [0.16, 0.36],
    [0.175, 0.44], [0.16, 0.5], [0.09, 0.535], [0.05, 0.545], [0.0, 0.55],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(profile, 20);
  geo.scale(1, 1, 0.62); // flatter front to back
  return geo;
}

class Figure {
  readonly root = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly chest: THREE.Mesh;
  private readonly neck: THREE.Mesh;
  private readonly head = new THREE.Group();
  private readonly sleeves: [THREE.Mesh, THREE.Mesh];
  private readonly upperArms: [THREE.Mesh, THREE.Mesh];
  private readonly forearms: [THREE.Mesh, THREE.Mesh];
  private readonly hands: [THREE.Mesh, THREE.Mesh];
  private readonly elbows: [THREE.Mesh, THREE.Mesh];
  private readonly thighs: [THREE.Mesh, THREE.Mesh];
  private readonly shins: [THREE.Mesh, THREE.Mesh];
  private readonly knees: [THREE.Mesh, THREE.Mesh];
  private readonly socks: [THREE.Mesh, THREE.Mesh];
  private readonly feet: [THREE.Group, THREE.Group];

  constructor(style: AvatarStyle, team: number) {
    const o = outfit(style, team);
    const skin = mat(o.skin, 0.65);
    const shirt = mat(o.shirt, 0.8);
    const trim = mat(o.trim, 0.6);
    const shorts = mat(o.shorts, 0.85);
    const hair = mat(o.hair, 0.95);
    const sphere = (r: number, m: THREE.Material, w = 16, h = 12) => new THREE.Mesh(new THREE.SphereGeometry(r, w, h), m);

    // Torso: shirt over the upper body, shorts' waistband below.
    this.chest = new THREE.Mesh(torsoGeometry(), shirt);
    this.torso.add(this.chest);
    const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.138, 0.142, 0.1, 18).scale(1, 1, 0.64), shorts);
    waist.position.y = 0.0;
    this.torso.add(waist);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 18), trim);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.535;
    this.torso.add(collar);
    if (!o.cap) {
      // A stripe across the chest in the team colour.
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.163, 0.158, 0.035, 20, 1, true).scale(1, 1, 0.63), trim);
      stripe.position.y = 0.36;
      this.torso.add(stripe);
    }
    this.root.add(this.torso);

    this.neck = segment(0.045, 0.05, skin);
    this.root.add(this.neck);

    // Head, built facing −z: slightly long skull, ears, nose, eyes, hair or a cap.
    const skull = sphere(HEAD_RADIUS, skin, 20, 16);
    skull.scale.set(0.95, 1.1, 1);
    this.head.add(skull);
    const jaw = sphere(HEAD_RADIUS * 0.8, skin, 16, 12);
    jaw.scale.set(0.85, 0.7, 0.9);
    jaw.position.set(0, -0.045, -0.012);
    this.head.add(jaw);
    for (const sx of [-1, 1]) {
      const ear = sphere(0.026, skin, 10, 8);
      ear.scale.set(0.5, 1, 0.8);
      ear.position.set(sx * 0.108, 0.0, 0.005);
      this.head.add(ear);
      const eyeWhite = sphere(0.017, mat(0xf4f1ec, 0.4), 10, 8);
      eyeWhite.position.set(sx * 0.04, 0.018, -0.1);
      this.head.add(eyeWhite);
      const pupil = sphere(0.01, new THREE.MeshBasicMaterial({ color: 0x1b130d }), 8, 6);
      pupil.position.set(sx * 0.04, 0.018, -0.114);
      this.head.add(pupil);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.008, 0.01), hair);
      brow.position.set(sx * 0.04, 0.047, -0.104);
      brow.rotation.z = sx * -0.12;
      this.head.add(brow);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.04, 8), skin);
    nose.rotation.x = -Math.PI / 2 + 0.35;
    nose.position.set(0, -0.005, -0.118);
    this.head.add(nose);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.006, 0.006), mat(0x8a4a3c, 0.6));
    mouth.position.set(0, -0.05, -0.103);
    this.head.add(mouth);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS * 1.06, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), hair);
    hairCap.scale.set(0.97, 1.1, 1.04);
    hairCap.rotation.x = 0.28; // hairline above the forehead, longer at the back
    hairCap.position.y = 0.01;
    this.head.add(hairCap);
    if (o.cap) {
      const crown = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS * 1.1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), shirt);
      crown.position.y = 0.02;
      this.head.add(crown);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 20, 1, false, Math.PI * 0.5, Math.PI), shirt);
      brim.scale.set(1, 1, 1.1);
      brim.position.set(0, 0.06, -0.09);
      brim.rotation.x = 0.12;
      this.head.add(brim);
    } else {
      const band = new THREE.Mesh(new THREE.TorusGeometry(HEAD_RADIUS * 1.02, 0.014, 6, 24), trim);
      band.rotation.x = Math.PI / 2 + 0.25;
      band.position.y = 0.05;
      this.head.add(band);
    }
    this.root.add(this.head);

    // Arms: short sleeve over the top of the upper arm, then skin.
    const pair = <T,>(make: () => T): [T, T] => [make(), make()];
    this.sleeves = pair(() => segment(0.062, 0.056, shirt));
    this.upperArms = pair(() => segment(0.045, 0.04, skin));
    this.forearms = pair(() => segment(0.04, 0.032, skin));
    this.elbows = pair(() => sphere(0.04, skin, 10, 8));
    this.hands = pair(() => {
      const h = sphere(0.042, skin, 10, 8);
      h.scale.set(0.85, 1.1, 0.75);
      return h;
    });
    // Legs: shorts over the thigh, skin below, white socks, trainers.
    this.thighs = pair(() => segment(0.085, 0.07, shorts));
    this.shins = pair(() => segment(0.05, 0.036, skin));
    this.knees = pair(() => sphere(0.052, skin, 10, 8));
    this.socks = pair(() => segment(0.04, 0.04, mat(0xf4f4f4, 0.9)));
    this.feet = pair(() => {
      const f = new THREE.Group();
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.065, 0.24), mat(o.shoes, 0.6));
      shoe.position.z = -0.05;
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.02, 0.25), mat(0x9aa3ab, 0.8));
      sole.position.set(0, -0.035, -0.05);
      const lace = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.01, 0.08), trim);
      lace.position.set(0, 0.035, -0.08);
      f.add(shoe, sole, lace);
      return f;
    });
    for (const part of [...this.sleeves, ...this.upperArms, ...this.forearms, ...this.elbows, ...this.hands, ...this.thighs, ...this.shins, ...this.knees, ...this.socks, ...this.feet]) {
      this.root.add(part);
    }
  }

  private readonly tmp = {
    shoulder: [new THREE.Vector3(), new THREE.Vector3()] as [THREE.Vector3, THREE.Vector3],
    hipJoint: new THREE.Vector3(),
    neckBase: new THREE.Vector3(),
    neckTop: new THREE.Vector3(),
    joint: new THREE.Vector3(),
    hand: new THREE.Vector3(),
    sleeveEnd: new THREE.Vector3(),
    ankle: new THREE.Vector3(),
  };

  /**
   * Pose in the figure's own space.
   *  - `hipX/hipY`: where the pelvis is (crouch, weight shift, bounce)
   *  - `feet`: where each foot is planted (it may be lifted mid-step)
   *  - `hands`: right (paddle) and left hand targets
   *  - `lean`: tips the upper body toward the paddle (+x); `slump`: forward and down
   *  - `breath`: 0..1 chest rise
   */
  pose(p: {
    hipX: number;
    hipY: number;
    feet: [THREE.Vector3, THREE.Vector3];
    hands: [THREE.Vector3, THREE.Vector3];
    headYaw: number;
    headPitch: number;
    lean: number;
    twist: number;
    slump: number;
    breath: number;
  }): void {
    const v = this.tmp;
    this.torso.position.set(p.hipX, p.hipY, 0);
    this.torso.rotation.set(-p.slump * 0.4, p.twist, -p.lean * 0.3, "YXZ");
    this.chest.scale.set(1 + p.breath * 0.015, 1 + p.breath * 0.008, 1 + p.breath * 0.03);
    this.torso.updateMatrix();

    // Shoulders and neck ride on the torso's tilt.
    for (const [i, sx] of [[0, 1], [1, -1]] as const) {
      v.shoulder[i].set(sx * SHOULDER_HALF, TORSO_HEIGHT - 0.06, 0).applyMatrix4(this.torso.matrix);
    }
    v.neckBase.set(0, TORSO_HEIGHT - 0.01, 0).applyMatrix4(this.torso.matrix);
    v.neckTop.set(0, TORSO_HEIGHT + NECK, -0.01).applyMatrix4(this.torso.matrix);
    stretch(this.neck, v.neckBase, v.neckTop);
    this.head.position.copy(v.neckTop).add(new THREE.Vector3(0, HEAD_RADIUS * 0.9, 0));
    this.head.rotation.set(p.headPitch, p.headYaw + p.twist * 0.5, -p.lean * 0.15, "YXZ");

    // Arms: elbows out, down and a little back.
    for (const i of [0, 1] as const) {
      const sx = i === 0 ? 1 : -1;
      const elbow = solveJoint(v.shoulder[i], p.hands[i], UPPER_ARM, FOREARM, new THREE.Vector3(sx * 0.7, -1, 0.6), v.joint);
      stretch(this.upperArms[i], v.shoulder[i], elbow);
      v.sleeveEnd.lerpVectors(v.shoulder[i], elbow, 0.55);
      stretch(this.sleeves[i], v.shoulder[i], v.sleeveEnd);
      this.elbows[i].position.copy(elbow);
      const toHand = v.hand.subVectors(p.hands[i], elbow);
      if (toHand.length() > FOREARM) toHand.setLength(FOREARM);
      const hand = toHand.add(elbow);
      stretch(this.forearms[i], elbow, hand);
      this.hands[i].position.copy(hand);
    }

    // Legs: hips to planted feet, knees forward and slightly out.
    for (const i of [0, 1] as const) {
      const sx = i === 0 ? 1 : -1;
      v.hipJoint.set(p.hipX + sx * 0.09, p.hipY - 0.02, 0);
      v.ankle.copy(p.feet[i]).add(new THREE.Vector3(0, 0.07, 0));
      const knee = solveJoint(v.hipJoint, v.ankle, THIGH, SHIN, new THREE.Vector3(sx * 0.25, 0, -1), v.joint);
      stretch(this.thighs[i], v.hipJoint, knee);
      this.knees[i].position.copy(knee);
      const sockTop = v.hand.lerpVectors(knee, v.ankle, 0.78);
      stretch(this.shins[i], knee, sockTop);
      stretch(this.socks[i], sockTop, v.ankle);
      this.feet[i].position.set(p.feet[i].x, p.feet[i].y + 0.035, p.feet[i].z);
      this.feet[i].rotation.y = sx * 0.12; // toes turned slightly out
    }
  }
}

/**
 * The opponent figure. Call `update` every frame with where the opponent's
 * paddle grip is (world space, or null when there's no paddle), the ball,
 * and the frame time.
 */
export class Avatar {
  readonly group = new THREE.Group();
  private readonly figures: Record<AvatarStyle, Figure>;
  private figure: Figure;

  private x = 0;
  private vx = 0;
  private drop = 0;
  private headYaw = 0;
  private headPitch = 0;
  private stepPhase = 0;
  private readonly footX: [number, number] = [0.15, -0.15];
  private mood: AvatarMood = "ready";
  private moodUntil = 0;
  private moodStart = 0;
  private readonly grip = new THREE.Vector3();
  private readonly localGrip = new THREE.Vector3();
  private readonly offHand = new THREE.Vector3();
  private readonly feet: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];

  /** `standZ` — how far down the court the avatar stands (just behind its paddle). */
  constructor(private readonly standZ: number, team: number, private readonly limitX: number) {
    this.figures = { partner: new Figure("partner", team), friend: new Figure("friend", team) };
    this.figure = this.figures.partner;
    this.group.add(this.figures.partner.root, this.figures.friend.root);
    this.figures.friend.root.visible = false;
    this.group.position.z = standZ;
  }

  setStyle(style: AvatarStyle): void {
    this.figure = this.figures[style];
    this.figures.partner.root.visible = style === "partner";
    this.figures.friend.root.visible = style === "friend";
  }

  /** React for `seconds` (Infinity = until reset). */
  setMood(mood: AvatarMood, seconds: number, now: number): void {
    this.mood = mood;
    this.moodStart = now;
    this.moodUntil = now + seconds * 1000;
  }

  resetMood(): void {
    this.mood = "ready";
  }

  update(grip: THREE.Vector3 | null, ball: THREE.Vector3, dt: number, now: number): void {
    if (this.mood !== "ready" && now > this.moodUntil) this.mood = "ready";
    const ease = (rate: number) => 1 - Math.exp(-dt * rate);
    const t = now / 1000;

    // Stand so the paddle is in the right hand; side-step there, don't glide.
    if (grip) this.grip.copy(grip);
    else this.grip.set(this.x + GRIP_SIDE, 1.0, this.standZ - 0.4);
    const targetX = Math.max(-this.limitX, Math.min(this.limitX, this.grip.x - GRIP_SIDE));
    const prevX = this.x;
    this.x += (targetX - this.x) * ease(4.5);
    this.vx = dt > 0 ? (this.x - prevX) / dt : 0;
    this.group.position.x = this.x;

    // Feet: each stays planted until it's too far from where it should be,
    // then steps there with a little lift — so moving sideways reads as steps.
    const speed = Math.min(1, Math.abs(this.vx) / 1.2);
    this.stepPhase += dt * (4 + speed * 8);
    for (const i of [0, 1] as const) {
      const home = (i === 0 ? 0.15 : -0.15) + this.vx * 0.06;
      const lagging = Math.abs(this.footX[i] - home) > 0.05 && Math.sin(this.stepPhase + i * Math.PI) > 0;
      if (lagging) this.footX[i] += (home - this.footX[i]) * ease(14);
      // Feet are planted in world space: undo the body's own movement.
      this.footX[i] -= this.x - prevX;
      this.footX[i] = Math.max(-0.4, Math.min(0.4, this.footX[i]));
      const lift = lagging ? Math.abs(Math.sin(this.stepPhase + i * Math.PI)) * 0.06 * Math.max(0.3, speed) : 0;
      this.feet[i].set(this.footX[i], lift, 0.02);
    }

    // Knees bend for low balls; a relaxed ready bounce; breathing; weight shift.
    const wantDrop = Math.max(0.03, Math.min(0.3, 1.0 - this.grip.y));
    this.drop += (wantDrop - this.drop) * ease(6);
    let bounce = Math.sin(t * 2.4) * 0.008;
    const breath = 0.5 + 0.5 * Math.sin(t * 1.5);
    const weightShift = Math.sin(t * 0.55) * 0.018 + (this.footX[0] + this.footX[1]) * 0.5;
    let slump = 0;
    let jump = 0;

    // Free (left) hand: out front for balance, swinging gently.
    this.offHand.set(-0.22 + Math.sin(t * 1.1) * 0.015, HIP_HEIGHT + 0.24 - this.drop, -0.3 + Math.sin(t * 0.9) * 0.02);

    const sinceMood = (now - this.moodStart) / 1000;
    if (this.mood === "cheer") {
      jump = Math.max(0, Math.sin(sinceMood * 8.5)) * 0.1;
      bounce = 0;
      this.offHand.set(-0.24, HIP_HEIGHT + TORSO_HEIGHT + 0.5 + jump + Math.sin(sinceMood * 8.5) * 0.04, -0.02); // fist up
    } else if (this.mood === "sad") {
      slump = Math.min(1, sinceMood * 1.5);
      bounce = 0;
      this.offHand.set(-0.25, HIP_HEIGHT - 0.12 - slump * 0.05, 0.02); // hanging
    }
    if (jump > 0) for (const f of this.feet) f.y += jump;

    // Head follows the ball, with a little life of its own.
    const headPos = new THREE.Vector3(this.x, HIP_HEIGHT + TORSO_HEIGHT + 0.2, this.standZ);
    const to = new THREE.Vector3().subVectors(ball, headPos);
    const wantYaw = Math.max(-0.7, Math.min(0.7, Math.atan2(-to.x, -to.z))) + Math.sin(t * 0.7) * 0.03;
    const wantPitch =
      this.mood === "sad" ? -0.6 : Math.max(-0.45, Math.min(0.35, Math.atan2(to.y, Math.hypot(to.x, to.z)))) + Math.sin(t * 0.9) * 0.02;
    this.headYaw += (wantYaw - this.headYaw) * ease(5);
    this.headPitch += (wantPitch - this.headPitch) * ease(5);

    // Lean and turn the shoulders toward a paddle that's out to the side.
    const reachOut = this.grip.x - (this.x + GRIP_SIDE);
    const lean = Math.max(-0.45, Math.min(0.45, reachOut * 1.1));
    const twist = Math.max(-0.35, Math.min(0.35, (this.grip.y - 1.0) * -0.2 + reachOut * 0.3));

    this.localGrip.set(this.grip.x - this.x, this.grip.y, this.grip.z - this.standZ);
    this.figure.pose({
      hipX: weightShift,
      hipY: HIP_HEIGHT - this.drop + bounce + jump,
      feet: this.feet,
      hands: [this.localGrip, this.offHand],
      headYaw: this.headYaw,
      headPitch: this.headPitch,
      lean,
      twist,
      slump,
      breath,
    });
  }
}
