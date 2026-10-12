import { HEAD_OFFSET, HEAD_RADIUS } from "./court";
import { devMode } from "./devMode";

/**
 * How the paddle follows your hand — everything the Paddle lab can tune.
 *
 * Players always get DEFAULT_SETTINGS, so both sides of a match feel the
 * same. In dev mode (see devMode.ts) the lab's tuning is saved in the browser
 * and used by the game. Read with `paddleSettings()` every frame (it's a
 * plain object), so changes take effect immediately without restarting.
 */

export interface PaddleSettings {
  // ---- tilt
  /** How much of your palm's tilt the paddle face copies. 1 = all of it, 0 = always face-on. */
  slant: number;
  /** The most the paddle face will ever tilt, degrees. */
  maxSlantDeg: number;
  /** 0 = every tiny angle wobble shows, 0.95 = small wobbles almost ignored. Big deliberate turns always come through. */
  angleSteadiness: number;

  // ---- movement
  /** Paddle travel ÷ hand travel, around the centre of the screen. */
  reach: number;
  /** Shift the paddle up (+) or down (−), as a fraction of the screen height. */
  heightOffset: number;
  /** Palm to paddle-head centre, in court units. 0 = the head is on your palm. */
  headOffset: number;
  /** 0 = raw position even when still (most responsive, most shake), 0.95 = very steady when still. */
  restSmoothing: number;
  /** How far ahead (ms) the paddle is projected between camera frames. */
  lookAheadMs: number;
  /** Camera frames the motion fit looks at. Fewer = snappier, more = steadier. */
  fitFrames: number;

  // ---- paddle
  /** Head radius, court units. Also the area that counts as contact. */
  headRadius: number;
  /**
   * How far past the paddle's rim still counts as a hit, in ball radii.
   * 0 = the ball's centre must be over the face; 1 = the ball's edge just
   * touching the rim counts.
   */
  hitMargin: number;
}

export const DEFAULT_SETTINGS: PaddleSettings = {
  slant: 0.5,
  maxSlantDeg: 35,
  angleSteadiness: 0.75,
  reach: 1,
  heightOffset: 0,
  headOffset: HEAD_OFFSET,
  restSmoothing: 0.85,
  lookAheadMs: 40,
  fitFrames: 5,
  headRadius: HEAD_RADIUS,
  hitMargin: 0.6,
};

export interface SettingSpec {
  key: keyof PaddleSettings;
  group: "Tilt" | "Movement" | "Paddle";
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

const times = (v: number) => `${v.toFixed(2)}×`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

export const SETTING_SPECS: SettingSpec[] = [
  { key: "slant", group: "Tilt", label: "Face follows palm", help: "How much the paddle face copies your palm's tilt. 100% = exactly, 0% = always facing straight down the court. The handle always follows your knuckles.", min: 0, max: 1, step: 0.05, format: pct },
  { key: "maxSlantDeg", group: "Tilt", label: "Max tilt", help: "The most the paddle face will ever tilt, however your palm is turned.", min: 0, max: 80, step: 1, format: (v) => `${v.toFixed(0)}°` },
  { key: "angleSteadiness", group: "Tilt", label: "Angle steadiness", help: "Ignores small wobbles in your hand's angle. Big deliberate turns always come through straight away.", min: 0, max: 0.95, step: 0.05, format: pct },

  { key: "reach", group: "Movement", label: "Reach", help: "Above 1, the paddle moves further than your hand, so smaller movements cover the court.", min: 0.6, max: 2, step: 0.05, format: times },
  { key: "heightOffset", group: "Movement", label: "Height offset", help: "Raise or lower the paddle relative to your hand.", min: -0.3, max: 0.3, step: 0.01, format: (v) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%` },
  { key: "headOffset", group: "Movement", label: "Handle length", help: "How far the paddle head sits past your palm. 0 = the head is right on your palm.", min: 0, max: 0.8, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "restSmoothing", group: "Movement", label: "Steadiness when still", help: "Calms the paddle when your hand is still. Never applies while you're moving.", min: 0, max: 0.95, step: 0.05, format: pct },
  { key: "lookAheadMs", group: "Movement", label: "Look-ahead", help: "Projects the paddle ahead along your swing between camera frames. Higher = snappier, but can overshoot when you stop.", min: 0, max: 80, step: 5, format: (v) => `${v.toFixed(0)} ms` },
  { key: "fitFrames", group: "Movement", label: "Frames in motion fit", help: "How many recent camera frames estimate your hand's motion. Fewer = snappier, more = steadier.", min: 3, max: 10, step: 1, format: (v) => v.toFixed(0) },

  { key: "headRadius", group: "Paddle", label: "Paddle size", help: "Head size — and the area that counts as a hit.", min: 0.18, max: 0.5, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "hitMargin", group: "Paddle", label: "Hit area", help: "How far past the paddle's rim still counts as a hit, in ball sizes. 0 = the ball's centre must be on the face; 1 = the ball's edge just touching the rim counts.", min: 0, max: 1.5, step: 0.05, format: (v) => `+${v.toFixed(2)} ball` },
];

const STORAGE_KEY = "portalBall.paddleSettings.v3";
/**
 * Older saves. Tilt worked differently in those, so their tilt values don't
 * carry over (they aren't keys any more); movement and size settings do.
 */
const LEGACY_KEYS = ["portalBall.paddleSettings.v2", "portalBall.paddleSettings.v1"];

let current: PaddleSettings = devMode ? load() : { ...DEFAULT_SETTINGS };

export function paddleSettings(): PaddleSettings {
  return current;
}

export function setPaddleSetting(key: keyof PaddleSettings, value: number): void {
  current = { ...current, [key]: clampToSpec(key, value) };
  save();
}

export function resetPaddleSettings(): void {
  current = { ...DEFAULT_SETTINGS };
  save();
}

/** Only the values that differ from the defaults — what's worth sending back to bake in. */
export function changedSettings(): Partial<PaddleSettings> {
  const out: Partial<PaddleSettings> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof PaddleSettings)[]) {
    if (Math.abs(current[k] - DEFAULT_SETTINGS[k]) > 1e-9) out[k] = current[k];
  }
  return out;
}

function clampToSpec(key: keyof PaddleSettings, value: number): number {
  const spec = SETTING_SPECS.find((s) => s.key === key);
  if (!spec || !Number.isFinite(value)) return DEFAULT_SETTINGS[key];
  return Math.min(spec.max, Math.max(spec.min, value));
}

function load(): PaddleSettings {
  try {
    const storage = globalThis.localStorage;
    const raw = [STORAGE_KEY, ...LEGACY_KEYS].map((k) => storage?.getItem(k)).find((v) => v);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const saved = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof PaddleSettings)[]) {
      const v = saved[k];
      if (typeof v === "number") out[k] = clampToSpec(k, v);
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS }; // storage blocked or corrupt: defaults are always safe
  }
}

function save(): void {
  if (!devMode) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage blocked (private window etc.) — settings still apply for this session.
  }
}
