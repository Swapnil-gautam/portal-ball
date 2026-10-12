import { Synth } from "../core/audio/synth";

/**
 * Portal Ball's sounds, built from the core synthesizer. A pickleball hit is
 * a hollow, high "pock" — a plastic ball with holes on a hard paddle face —
 * so it's a short bright noise click plus a falling mid tone. Harder shots
 * are louder and brighter; the opponent's hits are quieter and duller, since
 * they're at the far end of the court.
 */

export const sound = new Synth("portalBall.sound");

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** `power` 0..1 — how hard the shot was. `far` for the opponent's end of the court. */
export function playHit(power: number, far = false): void {
  const p = clamp01(power);
  const level = (0.35 + 0.65 * p) * (far ? 0.45 : 1);
  sound.noise({ duration: 0.035, gain: 0.5 * level, filter: "bandpass", frequency: far ? 1400 : 2200 + 900 * p, q: 1.4 });
  sound.tone({ type: "triangle", from: far ? 700 : 950 + 250 * p, to: 420, duration: 0.07, gain: 0.35 * level });
}

/** `speed` is the ball's downward speed at impact (court units/s). */
export function playBounce(speed: number, far = false): void {
  const level = clamp01(speed / 6) * (far ? 0.4 : 0.8);
  if (level < 0.05) return; // a ball settling on the court shouldn't tick
  sound.tone({ type: "sine", from: 260, to: 150, duration: 0.08, gain: 0.45 * level });
  sound.noise({ duration: 0.02, gain: 0.25 * level, filter: "lowpass", frequency: 900 });
}

export function playPoint(won: boolean): void {
  if (won) {
    sound.tone({ type: "triangle", from: 660, duration: 0.11, gain: 0.22 });
    sound.tone({ type: "triangle", from: 990, duration: 0.16, gain: 0.22, delay: 0.09 });
  } else {
    sound.tone({ type: "sine", from: 440, duration: 0.12, gain: 0.18 });
    sound.tone({ type: "sine", from: 330, duration: 0.2, gain: 0.18, delay: 0.1 });
  }
}

export function playMatchEnd(won: boolean): void {
  const notes = won ? [523, 659, 784, 1047] : [392, 330, 262];
  notes.forEach((f, i) =>
    sound.tone({ type: won ? "triangle" : "sine", from: f, duration: 0.22, gain: 0.22, delay: i * 0.12 }),
  );
}
