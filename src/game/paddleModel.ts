import * as THREE from "three";
import { HANDLE_LENGTH, HEAD_RADIUS, HEAD_THICKNESS } from "./court";

/**
 * A paddle: a round face, a dark edge guard, and a wrapped grip. Built around the head's centre with
 * the handle pointing down local -y and the face normal along local +z.
 *
 * Children are always [face, edge guard, handle] — the scene fades and
 * resizes them by position. Other paddle styles can be added later as more
 * builders with the same shape contract.
 *
 * The face is semi-transparent so you can still see the ball coming through.
 *
 * Round on purpose, exactly the hit area (HEAD_RADIUS). A circle looks the
 * same however it turns flat in your hand, so the small wobble in the
 * tracked hand angle doesn't show. A rounded-rectangle face was tried and
 * made that wobble visible as jitter on every swing.
 */

export const FACE_HALF_HEIGHT = HEAD_RADIUS;

export function makePickleballPaddle(faceColor: number): THREE.Group {
  const g = new THREE.Group();

  const faceGeo = new THREE.ExtrudeGeometry(circle(HEAD_RADIUS), { depth: HEAD_THICKNESS, bevelEnabled: false, curveSegments: 48 });
  faceGeo.translate(0, 0, -HEAD_THICKNESS / 2);
  const face = new THREE.Mesh(
    faceGeo,
    new THREE.MeshStandardMaterial({
      color: faceColor,
      emissive: faceColor,
      emissiveIntensity: 0.18,
      roughness: 0.45,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );

  // Edge guard: a thin dark band around the face.
  const guardShape = circle(HEAD_RADIUS + 0.022);
  guardShape.holes.push(circle(HEAD_RADIUS) as unknown as THREE.Path);
  const guardGeo = new THREE.ExtrudeGeometry(guardShape, { depth: HEAD_THICKNESS * 1.4, bevelEnabled: false, curveSegments: 48 });
  guardGeo.translate(0, 0, -HEAD_THICKNESS * 0.7);
  const guard = new THREE.Mesh(guardGeo, new THREE.MeshStandardMaterial({ color: 0x1b1e21, roughness: 0.6, transparent: true }));

  // Grip: a wrapped cylinder with a butt cap.
  const handle = new THREE.Group();
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.034, 0.038, HANDLE_LENGTH, 14),
    new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.85, transparent: true }),
  );
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.044, 0.044, 0.025, 14),
    new THREE.MeshStandardMaterial({ color: faceColor, roughness: 0.5, transparent: true }),
  );
  cap.position.y = -HANDLE_LENGTH / 2;
  handle.add(grip, cap);
  handle.position.y = handleY(FACE_HALF_HEIGHT);

  g.add(face, guard, handle);
  g.renderOrder = 2;
  return g;
}

/** Where the handle's centre sits for a face of this half-height. */
export function handleY(faceHalfHeight: number): number {
  return -(faceHalfHeight + HANDLE_LENGTH / 2 - 0.01);
}

function circle(r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}
