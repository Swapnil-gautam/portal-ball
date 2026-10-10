import "./style.css";

import type { Surface } from "./draw";
import { InterceptMode } from "./modes/intercept";
import { LatencyMode } from "./modes/latency";
import { TrackMode } from "./modes/track";
import type { Mode } from "./modes/types";
import { DEFAULT_ONE_EURO } from "./oneEuro";
import { fmt } from "./stats";
import { Tracker } from "./tracker";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

const canvas = el<HTMLCanvasElement>("canvas");
const ctx = must(canvas.getContext("2d", { alpha: false }), "2d canvas context unavailable");

const curtain = el<HTMLDivElement>("curtain");
const startBtn = el<HTMLButtonElement>("start");
const statusEl = el<HTMLParagraphElement>("status");
const tabsEl = el<HTMLElement>("tabs");
const blurbEl = el<HTMLParagraphElement>("blurb");
const pipelineEl = el<HTMLDListElement>("pipeline");
const modeStatsEl = el<HTMLDListElement>("mode-stats");
const modeStatsTitle = el<HTMLHeadingElement>("mode-stats-title");
const toastEl = el<HTMLParagraphElement>("toast");

const tracker = new Tracker();
const latencyMode = new LatencyMode();
const interceptMode = new InterceptMode();
const modes: Mode[] = [new TrackMode(), latencyMode, interceptMode];
let active: Mode = modes[0];
let started = false;

// ---------------------------------------------------------------- tabs

const tabButtons = modes.map((mode) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.role = "tab";
  btn.textContent = mode.title;
  btn.addEventListener("click", () => selectMode(mode));
  tabsEl.appendChild(btn);
  return btn;
});

function selectMode(mode: Mode): void {
  active = mode;
  mode.reset();
  blurbEl.textContent = mode.blurb;
  modeStatsTitle.textContent = mode.title;
  modes.forEach((m, i) => tabButtons[i].setAttribute("aria-selected", String(m === mode)));
  document.querySelectorAll<HTMLElement>("#panel section[data-mode]").forEach((section) => {
    section.hidden = section.dataset.mode !== mode.id;
  });
  renderPanel();
}

// ---------------------------------------------------------------- controls

function slider(
  id: string,
  valueId: string,
  initial: number,
  digits: number,
  onChange: (v: number) => void,
): void {
  const input = el<HTMLInputElement>(id);
  const out = el<HTMLElement>(valueId);
  input.value = String(initial);
  out.textContent = initial.toFixed(digits);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = v.toFixed(digits);
    onChange(v);
  });
}

slider("mincutoff", "v-mincutoff", DEFAULT_ONE_EURO.minCutoff, 2, (v) => {
  tracker.params = { ...tracker.params, minCutoff: v };
  tracker.resetFilters();
});
slider("beta", "v-beta", DEFAULT_ONE_EURO.beta, 3, (v) => {
  tracker.params = { ...tracker.params, beta: v };
  tracker.resetFilters();
});
slider("liney", "v-liney", latencyMode.lineY, 2, (v) => {
  latencyMode.lineY = v;
});
slider("flight", "v-flight", interceptMode.flightMs, 0, (v) => {
  interceptMode.flightMs = v;
});
slider("radius", "v-radius", interceptMode.hitRadius, 3, (v) => {
  interceptMode.hitRadius = v;
});

el<HTMLButtonElement>("reset").addEventListener("click", () => {
  active.reset();
  tracker.resetFilters();
  tracker.inference.reset();
  tracker.frameInterval.reset();
  tracker.captureLatency.reset();
  toast("Run reset.");
});

el<HTMLButtonElement>("copy").addEventListener("click", async () => {
  const csv = active.csv?.() ?? null;
  if (!csv) {
    toast("Nothing logged in this mode yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(csv);
    toast(`Copied ${csv.split("\n").length - 1} rows.`);
  } catch {
    toast("Clipboard blocked — check the console instead.");
    console.log(csv);
  }
});

let toastTimer = 0;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2600);
}

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const index = Number(e.key) - 1;
  if (index >= 0 && index < modes.length) selectMode(modes[index]);
  if (e.key.toLowerCase() === "r") {
    active.reset();
    toast("Run reset.");
  }
});

// ---------------------------------------------------------------- start

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    statusEl.classList.remove("error");
    statusEl.textContent = "Loading hand landmarker…";
    await tracker.init();

    statusEl.textContent = "Requesting camera…";
    await tracker.start();

    canvas.width = tracker.video.videoWidth;
    canvas.height = tracker.video.videoHeight;

    curtain.hidden = true;
    started = true;
  } catch (err) {
    startBtn.disabled = false;
    statusEl.classList.add("error");
    statusEl.textContent = `Could not start: ${(err as Error).message}`;
    console.error(err);
  }
});

tracker.onSample = (sample) => active.onSample(sample);

// ---------------------------------------------------------------- loops

const renderInterval = { last: 0, mean: 16.7 };

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!started) return;

  if (renderInterval.last) {
    // Light EMA — the panel only needs the trend, not every spike.
    renderInterval.mean = renderInterval.mean * 0.9 + (now - renderInterval.last) * 0.1;
  }
  renderInterval.last = now;

  const surface: Surface = {
    ctx,
    w: canvas.width,
    h: canvas.height,
    video: tracker.video,
    aspect: canvas.width / canvas.height,
  };
  active.draw(surface, tracker.latest);
}
requestAnimationFrame(frame);

function rows(target: HTMLDListElement, entries: ReadonlyArray<readonly [string, string, string?]>): void {
  target.replaceChildren(
    ...entries.flatMap(([k, v, cls]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      if (cls) dd.className = cls;
      return [dt, dd];
    }),
  );
}

function renderPanel(): void {
  const cam = started ? tracker.cameraInfo() : null;
  const lag = tracker.lag.estimate();
  const captureMs = tracker.captureLatency.count ? tracker.captureLatency.mean : null;
  const inferenceMs = tracker.inference.count ? tracker.inference.mean : null;
  const frameMs = tracker.frameInterval.count ? tracker.frameInterval.mean : null;

  // Deliberately a floor: this omits sensor exposure, USB transfer and the
  // panel's own response, none of which the browser will tell us about.
  const subtotal =
    (captureMs ?? 0) + (inferenceMs ?? 0) + (lag?.lagMs ?? 0) + renderInterval.mean;

  rows(pipelineEl, [
    ["Camera", cam ? `${cam.width}×${cam.height}` : "—"],
    ["Frame rate", frameMs ? `${fmt.num(1000 / frameMs, 1)} fps` : "—"],
    ["Delegate", started ? tracker.delegate : "—", tracker.delegate === "CPU" ? "accent" : undefined],
    ["Inference", fmt.ms(inferenceMs)],
    ["Inference p95", fmt.ms(tracker.inference.count ? tracker.inference.percentile(0.95) : null)],
    ["Render interval", fmt.ms(renderInterval.mean)],
    [
      "Capture latency",
      captureMs === null ? "not exposed" : fmt.ms(captureMs),
      captureMs === null ? "dim" : undefined,
    ],
    [
      "Filter lag",
      lag ? `${fmt.ms(lag.lagMs)} (r ${lag.correlation.toFixed(2)})` : "move to measure",
      lag ? undefined : "dim",
    ],
    ["Subtotal (floor)", fmt.ms(subtotal), "accent"],
    ["Tracking", tracker.latest.present ? fmt.pct(tracker.latest.confidence, 0) : "lost"],
    ...(tracker.errors ? [["Frame errors", String(tracker.errors), "accent"] as const] : []),
  ]);

  rows(modeStatsEl, active.readout());
}

window.setInterval(renderPanel, 120);

selectMode(modes[0]);
renderPanel();
