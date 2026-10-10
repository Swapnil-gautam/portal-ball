// Copies the MediaPipe wasm runtime into public/ so the app serves it locally.
// Keeping it off a CDN removes a network variable from a latency-measurement tool.
import { cp, mkdir } from "node:fs/promises";

const from = "node_modules/@mediapipe/tasks-vision/wasm";
const to = "public/mediapipe/wasm";

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
