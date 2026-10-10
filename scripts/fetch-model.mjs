// Downloads the MediaPipe hand landmarker model into public/models/.
// Kept out of git (7.8 MB) and fetched on setup instead.
import { mkdir, writeFile, stat } from "node:fs/promises";

const URL_ =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const OUT = "public/models/hand_landmarker.task";

try {
  const existing = await stat(OUT);
  if (existing.size > 1_000_000) {
    console.log(`${OUT} already present (${(existing.size / 1e6).toFixed(1)} MB)`);
    process.exit(0);
  }
} catch {
  // not there yet, carry on
}

await mkdir("public/models", { recursive: true });
const res = await fetch(URL_);
if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
await writeFile(OUT, Buffer.from(await res.arrayBuffer()));
console.log(`downloaded ${OUT}`);
