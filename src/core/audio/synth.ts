/**
 * A tiny sound synthesizer for camera games — pitched blips and filtered
 * noise bursts, generated in code. No audio files: nothing to download,
 * nothing to license, and every sound can vary with how hard you swung.
 *
 * Each app builds its own sound recipes on top of `tone` and `noise` (see
 * game/sounds.ts). Sound on/off is remembered per app via `storageKey`.
 *
 * Browsers only let audio start from a user gesture, so call `unlock()` from
 * a tap or click before the first sound; until then sounds are silently skipped.
 */

export interface ToneOptions {
  type?: OscillatorType;
  /** Start and end pitch, Hz — a slide gives hits their "pock". */
  from: number;
  to?: number;
  duration: number;
  gain: number;
  /** Seconds from now — for sequences like a little victory tune. */
  delay?: number;
}

export interface NoiseOptions {
  duration: number;
  gain: number;
  /** Seconds to swell in (default: instant, like a hit). */
  attack?: number;
  filter: BiquadFilterType;
  frequency: number;
  q?: number;
  delay?: number;
}

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private on: boolean;

  constructor(private readonly storageKey: string) {
    this.on = readFlag(storageKey, true);
  }

  get enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    writeFlag(this.storageKey, on);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.01);
  }

  toggle(): boolean {
    this.setEnabled(!this.on);
    return this.on;
  }

  /** Call from a tap/click. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.on ? 0.8 : 0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private ready(): AudioContext | null {
    return this.on && this.ctx && this.master && this.ctx.state === "running" ? this.ctx : null;
  }

  tone(o: ToneOptions): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.from, t);
    if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t + o.duration);
    const env = envelope(ctx, t, o.duration, o.gain);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + o.duration + 0.02);
  }

  noise(o: NoiseOptions): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer ??= makeNoise(ctx);
    src.loop = true; // the buffer is short; long sounds just keep reading it
    const filter = ctx.createBiquadFilter();
    filter.type = o.filter;
    filter.frequency.value = o.frequency;
    filter.Q.value = o.q ?? 1;
    const env = envelope(ctx, t, o.duration, o.gain, o.attack);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t);
    src.stop(t + o.duration + 0.02);
  }
}

/** Fast attack (or a swell, with `attack`), exponential decay — the shape of anything struck. */
function envelope(ctx: AudioContext, t: number, duration: number, gain: number, attack = 0.004): GainNode {
  const g = ctx.createGain();
  const peak = Math.max(0.0002, gain);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + Math.min(attack, duration * 0.8));
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  return g;
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v === null || v === undefined ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, on ? "1" : "0");
  } catch {
    // storage blocked — the setting still applies for this session
  }
}
