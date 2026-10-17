import * as THREE from "three";

/**
 * Spectators in two small stands beside the court. They sway while they
 * watch and jump up to cheer when you win a point — a big cheer when you
 * win the match.
 *
 * Everyone is two instanced meshes (bodies and heads), so the whole crowd
 * costs two draw calls however many people there are.
 */

const SHIRTS = [0xff8a3d, 0x2fb7c4, 0xd9f04a, 0xf2f4f2, 0xe2556b, 0x6c7cff, 0xf5c542, 0x3fbf7f, 0x9b6bd6, 0x2b2f33];
const SKIN = [0xf1c7a5, 0xd9a07c, 0xc68a63, 0x9a6648, 0x6e4630];
const BENCH = 0x6d7680;

interface Fan {
  base: THREE.Vector3;
  facing: number;
  phase: number;
  /** How keen they are: scales how high they jump. */
  energy: number;
  delay: number;
}

export class Crowd {
  readonly group = new THREE.Group();
  private readonly fans: Fan[] = [];
  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private cheerStart = -1e9;
  private cheerStrength = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly yAxis = new THREE.Vector3(0, 1, 0);

  /** Stands run from `zFrom` to `zTo`, starting `innerX` out from the centre line on each side. */
  constructor(innerX: number, zFrom: number, zTo: number) {
    const rand = mulberry32(7);
    const tiers = 3;
    const seatSpacing = 0.62;
    const benchMat = new THREE.MeshStandardMaterial({ color: BENCH, metalness: 0.5, roughness: 0.45 });

    for (const side of [-1, 1]) {
      for (let tier = 0; tier < tiers; tier++) {
        const x = side * (innerX + 0.3 + tier * 0.75);
        const seatY = 0.45 + tier * 0.45;
        // Bench plank and riser for this tier.
        const len = zTo - zFrom;
        const plank = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, len), benchMat);
        plank.position.set(x, seatY, (zFrom + zTo) / 2);
        const riser = new THREE.Mesh(new THREE.BoxGeometry(0.06, seatY, len), benchMat);
        riser.position.set(x + side * 0.25, seatY / 2, (zFrom + zTo) / 2);
        this.group.add(plank, riser);

        for (let z = zFrom + 0.35; z < zTo - 0.2; z += seatSpacing) {
          if (rand() < 0.22) continue; // empty seats
          this.fans.push({
            base: new THREE.Vector3(x, seatY + 0.03, z + (rand() - 0.5) * 0.12),
            facing: side > 0 ? -Math.PI / 2 : Math.PI / 2, // toward the court
            phase: rand() * Math.PI * 2,
            energy: 0.6 + rand() * 0.6,
            delay: rand() * 0.25,
          });
        }
      }
    }

    const bodyGeo = new THREE.CapsuleGeometry(0.15, 0.3, 4, 10);
    bodyGeo.translate(0, 0.3, 0);
    const headGeo = new THREE.SphereGeometry(0.11, 12, 8);
    this.bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), this.fans.length);
    this.heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), this.fans.length);
    const c = new THREE.Color();
    this.fans.forEach((_, i) => {
      this.bodies.setColorAt(i, c.setHex(SHIRTS[Math.floor(rand() * SHIRTS.length)]));
      this.heads.setColorAt(i, c.setHex(SKIN[Math.floor(rand() * SKIN.length)]));
    });
    this.group.add(this.bodies, this.heads);
    this.update(0);
  }

  /** `strength` 0..1: a point (≈0.5) or the match (1). */
  cheer(strength: number, now: number): void {
    this.cheerStart = now;
    this.cheerStrength = strength;
  }

  calm(): void {
    this.cheerStrength = 0;
  }

  update(now: number): void {
    const t = now / 1000;
    const since = (now - this.cheerStart) / 1000;
    // A cheer lasts ~1.5 s for a point, ~4 s for the match.
    const length = 1.2 + this.cheerStrength * 2.8;
    const cheering = this.cheerStrength > 0 && since < length;
    const fade = cheering ? 1 - since / length : 0;

    this.fans.forEach((f, i) => {
      let lift = 0;
      let sway = Math.sin(t * 1.3 + f.phase) * 0.03;
      if (cheering && since > f.delay) {
        lift = Math.abs(Math.sin((since - f.delay) * 8 + f.phase)) * 0.22 * f.energy * this.cheerStrength * fade;
        sway *= 3;
      }
      this.q.setFromAxisAngle(this.yAxis, f.facing);
      this.p.set(f.base.x, f.base.y + lift, f.base.z + sway);
      this.bodies.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
      this.p.y += 0.72;
      this.heads.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
  }
}

/** Small seeded random, so the crowd looks the same every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
