import * as THREE from "three";
import { COURT_LENGTH, HALF_WIDTH, NET_HEIGHT } from "./court";
import { Crowd } from "./crowd";

/**
 * The pickleball venue: an outdoor court on a sunny day.
 *
 * Proportions follow a real pickleball court scaled to the play space — a
 * coloured playing surface on a green surround, white lines, a "kitchen"
 * (non-volley zone) on each side of the net, centre lines that stop at the
 * kitchen, a mesh net on posts with a centre strap, and a chain-link fence.
 * Around it: spectators in two small stands, floodlight poles (off — it's
 * daytime), a tree line, a blue sky with the sun and clouds.
 *
 * Kept separate from the scene so other backgrounds can be added later as
 * more venues: everything here is decoration — physics never looks at it.
 * Textures are drawn in code (no image files to load or license).
 */

const COURT_BLUE = 0x2c5f9f;
const KITCHEN_BLUE = 0x3b74b8;
const SURROUND_GREEN = 0x3c7d55;
const GROUND = 0x5b8a45; // grass beyond the fence
const LINE_WHITE = 0xf2f4f2;
const POST_DARK = 0x2b2f33;
const FENCE_GREEN = 0x24382d;

const NEAR_BASELINE = 0.3;
const FAR_BASELINE = COURT_LENGTH - 0.3;
const NET_Z = COURT_LENGTH / 2;
/** The kitchen reaches 7 ft from the net on a 22 ft half-court. */
const KITCHEN_DEPTH = ((NET_Z - NEAR_BASELINE) * 7) / 22;
const FENCE_X = HALF_WIDTH + 3.4;
const FENCE_FAR_Z = COURT_LENGTH + 2.8;
const FENCE_HEIGHT = 2.6;

export interface Venue {
  group: THREE.Group;
  crowd: Crowd;
}

/** Builds the venue into `scene`: court, net, fence, lights, crowd, scenery, sky. */
export function buildVenue(scene: THREE.Scene): Venue {
  const g = new THREE.Group();

  // --- ground layers, back to front (tiny y offsets stop them flickering into each other)
  const surface = surfaceTexture();
  g.add(flat(140, 140, GROUND, 0, NET_Z, -0.01));
  g.add(flat(FENCE_X * 2, FENCE_FAR_Z + 2, SURROUND_GREEN, 0, (FENCE_FAR_Z - 2) / 2, -0.002, false, surface));
  g.add(flat(HALF_WIDTH * 2, FAR_BASELINE - NEAR_BASELINE, COURT_BLUE, 0, NET_Z, 0, false, surface));
  g.add(flat(HALF_WIDTH * 2, KITCHEN_DEPTH, KITCHEN_BLUE, 0, NET_Z - KITCHEN_DEPTH / 2, 0.001, false, surface));
  g.add(flat(HALF_WIDTH * 2, KITCHEN_DEPTH, KITCHEN_BLUE, 0, NET_Z + KITCHEN_DEPTH / 2, 0.001, false, surface));

  // --- lines
  const W = 0.05;
  const lineY = 0.003;
  const line = (w: number, l: number, x: number, z: number) => g.add(flat(w, l, LINE_WHITE, x, z, lineY, true));
  const courtLen = FAR_BASELINE - NEAR_BASELINE;
  line(W, courtLen, -HALF_WIDTH, NET_Z); // sidelines
  line(W, courtLen, HALF_WIDTH, NET_Z);
  line(HALF_WIDTH * 2 + W, W, 0, NEAR_BASELINE); // baselines
  line(HALF_WIDTH * 2 + W, W, 0, FAR_BASELINE);
  line(HALF_WIDTH * 2, W, 0, NET_Z - KITCHEN_DEPTH); // kitchen lines
  line(HALF_WIDTH * 2, W, 0, NET_Z + KITCHEN_DEPTH);
  // Centre lines run from each baseline to the kitchen — not through it.
  const serviceLen = NET_Z - KITCHEN_DEPTH - NEAR_BASELINE;
  line(W, serviceLen, 0, NEAR_BASELINE + serviceLen / 2);
  line(W, serviceLen, 0, FAR_BASELINE - serviceLen / 2);

  g.add(buildNet());
  g.add(buildFence());
  g.add(buildFloodlights());
  g.add(buildScenery());
  const crowd = new Crowd(FENCE_X + 0.9, 5.6, COURT_LENGTH + 1.2);
  g.add(crowd.group);
  scene.add(g);

  // --- light: blue sky from above and green bounce from the grass, the sun
  // high and a little behind you (so what faces you is lit), and a soft fill.
  scene.add(new THREE.HemisphereLight(0xd6e9ff, 0x6c8f55, 1.05));
  const sun = new THREE.DirectionalLight(0xfff3df, 1.7);
  sun.position.set(-5, 12, -3);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(4, 4, 12);
  scene.add(fill);

  scene.background = skyTexture();
  scene.fog = new THREE.Fog(0xc9dcec, 28, 75);
  return { group: g, crowd };
}

/** A pickleball: bright yellow-green plastic with its pattern of holes. */
export function pickleballMaterial(): THREE.MeshStandardMaterial {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const x = c.getContext("2d")!;
  x.fillStyle = "#d9f04a";
  x.fillRect(0, 0, 256, 128);
  x.fillStyle = "#8ea524";
  // Rows of holes; spacing widens toward the poles of the texture so they
  // look evenly spaced once wrapped around the sphere.
  for (let row = 0; row < 5; row++) {
    const y = 18 + row * 23;
    const lat = Math.abs(y - 64) / 64;
    const count = Math.max(3, Math.round(8 * Math.cos(lat * 1.2)));
    for (let i = 0; i < count; i++) {
      const xPos = ((i + (row % 2) * 0.5) / count) * 256;
      x.beginPath();
      x.ellipse(xPos, y, 7 * Math.max(0.5, Math.cos(lat * 1.2)) + 3, 7, 0, 0, Math.PI * 2);
      x.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: 0x9fb82a, emissiveIntensity: 0.28 });
}

// ---------------------------------------------------------------- pieces

function flat(w: number, l: number, color: number, x: number, z: number, y: number, basic = false, texture?: THREE.Texture): THREE.Mesh {
  let map: THREE.Texture | undefined;
  if (texture) {
    map = texture.clone();
    map.repeat.set(w / 1.5, l / 1.5);
    map.needsUpdate = true;
  }
  const mat = basic ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshStandardMaterial({ color, roughness: 0.92, map });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

function buildNet(): THREE.Group {
  const g = new THREE.Group();
  const postX = HALF_WIDTH + 0.32;
  const width = postX * 2;
  const bottom = 0.04;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, NET_HEIGHT - bottom),
    new THREE.MeshBasicMaterial({
      map: gridTexture(width * 16, (NET_HEIGHT - bottom) * 16),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.position.set(0, bottom + (NET_HEIGHT - bottom) / 2, NET_Z);
  g.add(mesh);

  const tape = new THREE.Mesh(new THREE.BoxGeometry(width, 0.05, 0.025), new THREE.MeshStandardMaterial({ color: LINE_WHITE }));
  tape.position.set(0, NET_HEIGHT, NET_Z);
  g.add(tape);

  const strap = new THREE.Mesh(new THREE.PlaneGeometry(0.04, NET_HEIGHT), new THREE.MeshBasicMaterial({ color: LINE_WHITE, side: THREE.DoubleSide }));
  strap.position.set(0, NET_HEIGHT / 2, NET_Z + 0.002);
  g.add(strap);

  const postMat = new THREE.MeshStandardMaterial({ color: POST_DARK, metalness: 0.4, roughness: 0.5 });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, NET_HEIGHT + 0.08, 12), postMat);
    post.position.set(sx * postX, (NET_HEIGHT + 0.08) / 2, NET_Z);
    g.add(post);
  }
  return g;
}

function buildFence(): THREE.Group {
  const g = new THREE.Group();
  const linkMat = (w: number, h: number) =>
    new THREE.MeshBasicMaterial({
      map: chainLinkTexture(w * 6, h * 6),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: true,
    });
  const postMat = new THREE.MeshStandardMaterial({ color: FENCE_GREEN, roughness: 0.7 });

  const panel = (w: number, x: number, z: number, rotY: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, FENCE_HEIGHT), linkMat(w, FENCE_HEIGHT));
    m.position.set(x, FENCE_HEIGHT / 2, z);
    m.rotation.y = rotY;
    g.add(m);
  };
  const nearZ = -1.5;
  const sideLen = FENCE_FAR_Z - nearZ;
  panel(FENCE_X * 2, 0, FENCE_FAR_Z, 0); // behind the far baseline
  panel(sideLen, -FENCE_X, nearZ + sideLen / 2, Math.PI / 2); // sides
  panel(sideLen, FENCE_X, nearZ + sideLen / 2, Math.PI / 2);

  const post = (x: number, z: number) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, FENCE_HEIGHT, 8), postMat);
    p.position.set(x, FENCE_HEIGHT / 2, z);
    g.add(p);
  };
  for (let x = -FENCE_X; x <= FENCE_X + 0.01; x += FENCE_X / 2) post(x, FENCE_FAR_Z);
  for (let z = nearZ; z <= FENCE_FAR_Z + 0.01; z += 2.5) {
    post(-FENCE_X, z);
    post(FENCE_X, z);
  }

  const rail = (len: number, x: number, z: number, rotY: number) => {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 6), postMat);
    r.rotation.z = Math.PI / 2;
    r.rotation.y = rotY;
    r.position.set(x, FENCE_HEIGHT, z);
    g.add(r);
  };
  rail(FENCE_X * 2, 0, FENCE_FAR_Z, 0);
  rail(sideLen, -FENCE_X, nearZ + sideLen / 2, Math.PI / 2);
  rail(sideLen, FENCE_X, nearZ + sideLen / 2, Math.PI / 2);
  return g;
}

function buildFloodlights(): THREE.Group {
  const g = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4148, metalness: 0.5, roughness: 0.5 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xd9dee2, metalness: 0.3, roughness: 0.4 });
  const height = 6.5;
  for (const [x, z] of [
    // Only the far pair: near ones would cut through the sky right in front of you.
    [-(FENCE_X + 0.8), COURT_LENGTH - 0.5],
    [FENCE_X + 0.8, COURT_LENGTH - 0.5],
  ] as const) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, height, 8), poleMat);
    pole.position.set(x, height / 2, z);
    g.add(pole);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 0.3), lampMat);
    lamp.position.set(x - Math.sign(x) * 0.25, height, z);
    lamp.rotation.z = Math.sign(x) * 0.35; // tilted toward the court
    g.add(lamp);

  }
  return g;
}

/** Everything beyond the fence: trees, the sun and clouds. */
function buildScenery(): THREE.Group {
  const g = new THREE.Group();

  // Tree line behind the far end and down both sides.
  const treeMat = (w: number) =>
    new THREE.MeshBasicMaterial({ map: treeTexture(w), transparent: true, depthWrite: false, alphaTest: 0.05 });
  const trees = new THREE.Mesh(new THREE.PlaneGeometry(90, 5.5), treeMat(90));
  trees.position.set(0, 2.5, 26);
  trees.rotation.y = Math.PI;
  g.add(trees);
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(34, 6), treeMat(34));
    side.position.set(sx * 17, 2.8, 9);
    side.rotation.y = (-sx * Math.PI) / 2;
    g.add(side);
  }

  // The sun, high to the right, with a soft glow.
  const sun = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: radialTexture([
        [0, "rgba(255,255,250,1)"],
        [0.12, "rgba(255,252,235,1)"],
        [0.2, "rgba(255,245,215,0.55)"],
        [0.5, "rgba(255,240,210,0.12)"],
        [1, "rgba(255,240,210,0)"],
      ]),
      depthWrite: false,
      fog: false,
    }),
  );
  sun.position.set(19, 17, 50);
  sun.scale.setScalar(12);
  g.add(sun);

  // A few soft clouds.
  const rand = mulberry32(5);
  for (let i = 0; i < 9; i++) {
    const cloud = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTexture(i), transparent: true, depthWrite: false, fog: false, opacity: 0.9 }));
    const w = 10 + rand() * 12;
    cloud.scale.set(w, w * 0.32, 1);
    cloud.position.set(-40 + i * 10 + rand() * 6, 11 + rand() * 9, 50 + rand() * 6);
    g.add(cloud);
  }
  return g;
}

// ---------------------------------------------------------------- textures

function skyTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 256;
  const x = c.getContext("2d")!;
  const grad = x.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#2f6fcf");
  grad.addColorStop(0.45, "#5f9ae0");
  grad.addColorStop(0.8, "#a9cdef");
  grad.addColorStop(1, "#dcebf7");
  x.fillStyle = grad;
  x.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Net mesh: a square grid of dark cord. */
function gridTexture(repeatX: number, repeatY: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const x = c.getContext("2d")!;
  x.strokeStyle = "rgba(20, 22, 24, 0.85)";
  x.lineWidth = 2;
  x.strokeRect(0, 0, 16, 16);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  return tex;
}

/** Chain-link: diamonds of thin wire. */
function chainLinkTexture(repeatX: number, repeatY: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const x = c.getContext("2d")!;
  x.strokeStyle = "rgba(150, 165, 160, 0.32)";
  x.lineWidth = 1.2;
  x.beginPath();
  x.moveTo(0, 16);
  x.lineTo(16, 0);
  x.lineTo(32, 16);
  x.lineTo(16, 32);
  x.closePath();
  x.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  return tex;
}

/** Fine speckle for the acrylic court and the surround, so they aren't flat colour. */
function surfaceTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  x.fillStyle = "#ffffff";
  x.fillRect(0, 0, 128, 128);
  const rand = mulberry32(11);
  for (let i = 0; i < 2600; i++) {
    const v = 215 + Math.floor(rand() * 40);
    x.fillStyle = `rgb(${v},${v},${v})`;
    x.fillRect(rand() * 128, rand() * 128, 1.4, 1.4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A dark band of tree crowns against the sky. */
function treeTexture(widthUnits: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = Math.min(4096, Math.round(widthUnits * 40));
  c.height = 256;
  const x = c.getContext("2d")!;
  const rand = mulberry32(Math.round(widthUnits));
  for (const [shade, top, size] of [["#4a7a48", 70, 60], ["#335f37", 110, 48]] as const) {
    x.fillStyle = shade;
    x.fillRect(0, top + size * 0.6, c.width, c.height);
    for (let px = -20; px < c.width + 20; px += size * (0.45 + rand() * 0.4)) {
      const r = size * (0.55 + rand() * 0.6);
      x.beginPath();
      x.ellipse(px, top + size * 0.7 - rand() * size * 0.6, r * 0.8, r, 0, 0, Math.PI * 2);
      x.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function radialTexture(stops: [number, string][]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const grad = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  x.fillStyle = grad;
  x.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Small seeded random, so the scenery looks the same every time. */
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

/** A soft cumulus: overlapping white puffs, shaded slightly underneath. */
function cloudTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const x = c.getContext("2d")!;
  const rand = mulberry32(100 + seed);
  for (let i = 0; i < 9; i++) {
    const cx = 40 + rand() * 176;
    const cy = 50 + (rand() - 0.5) * 22;
    const r = 18 + rand() * 22;
    const grad = x.createRadialGradient(cx, cy - r * 0.3, 0, cx, cy, r);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.7, "rgba(240,246,252,0.7)");
    grad.addColorStop(1, "rgba(225,235,245,0)");
    x.fillStyle = grad;
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
