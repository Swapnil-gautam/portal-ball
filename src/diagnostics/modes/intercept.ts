import { clear, COLOR, drawPaddle, drawVideo, label } from "../../core/tracking/overlay2d";
import type { Surface } from "../../core/tracking/overlay2d";
import { fmt } from "../../core/tracking/stats";
import type { PaddleSample } from "../../core/tracking/tracker";
import type { Mode, Readout } from "./types";

interface Target {
  index: number;
  x: number;
  y: number;
  spawnAt: number;
  arriveAt: number;
  minDist: number;
  minDistAt: number;
  distAtArrival: number | null;
  resolved: boolean;
}

export interface Attempt {
  index: number;
  x: number;
  y: number;
  hit: boolean;
  minDist: number;
  distAtArrival: number;
  timingErrorMs: number;
}

const REST_MS = 650;

/**
 * The question Spike 0 exists to answer: with this pipeline and this much lag,
 * can a person reliably put the paddle on a target at a known arrival time?
 *
 * Flight time and hit window default to the values the design doc argues for
 * (~1.1 s crossing, ±120 ms window). If the hit rate here is poor, the doc's
 * core premise needs revisiting before anything else gets built.
 */
export class InterceptMode implements Mode {
  readonly id = "intercept";
  readonly title = "Intercept";
  readonly blurb =
    "Targets arrive on a fixed clock. Put the paddle on them. Hit rate and timing error here decide whether the whole concept holds.";

  flightMs = 1100;
  hitWindowMs = 120;
  /** Hit radius in frame-width units. */
  hitRadius = 0.075;
  aspect = 16 / 9;

  private target: Target | null = null;
  private nextSpawnAt = 0;
  private counter = 0;
  private attempts: Attempt[] = [];

  reset(): void {
    this.target = null;
    this.nextSpawnAt = performance.now() + 400;
    this.counter = 0;
    this.attempts = [];
  }

  private distance(s: PaddleSample, t: Target): number {
    return Math.hypot(s.x - t.x, (s.y - t.y) / this.aspect);
  }

  private spawn(now: number): void {
    this.counter++;
    this.target = {
      index: this.counter,
      // Central 70% of frame, biased slightly high — where a returned ball
      // would actually meet you.
      x: 0.15 + Math.random() * 0.7,
      y: 0.18 + Math.random() * 0.55,
      spawnAt: now,
      arriveAt: now + this.flightMs,
      minDist: Number.POSITIVE_INFINITY,
      minDistAt: now,
      distAtArrival: null,
      resolved: false,
    };
  }

  onSample(s: PaddleSample): void {
    const now = performance.now();

    if (!this.target) {
      if (now >= this.nextSpawnAt) this.spawn(now);
      return;
    }

    const t = this.target;
    if (t.resolved) return;

    const windowOpens = t.arriveAt - this.hitWindowMs;
    const windowCloses = t.arriveAt + this.hitWindowMs;

    if (s.present && now >= windowOpens && now <= windowCloses) {
      const d = this.distance(s, t);
      if (d < t.minDist) {
        t.minDist = d;
        t.minDistAt = now;
      }
      if (t.distAtArrival === null && now >= t.arriveAt) {
        t.distAtArrival = d;
      }
    }

    if (now > windowCloses) {
      t.resolved = true;
      const minDist = Number.isFinite(t.minDist) ? t.minDist : 1;
      this.attempts.push({
        index: t.index,
        x: t.x,
        y: t.y,
        hit: minDist < this.hitRadius,
        minDist,
        distAtArrival: t.distAtArrival ?? 1,
        timingErrorMs: t.minDistAt - t.arriveAt,
      });
      this.target = null;
      this.nextSpawnAt = now + REST_MS;
    }
  }

  draw(surface: Surface, s: PaddleSample): void {
    const { ctx, w, h } = surface;
    this.aspect = surface.aspect;

    clear(surface);
    drawVideo(surface, 0.55);

    const now = performance.now();
    const t = this.target;

    if (t) {
      const cx = t.x * w;
      const cy = t.y * h;
      const hitPx = this.hitRadius * w;
      const progress = Math.min(1, (now - t.spawnAt) / (t.arriveAt - t.spawnAt));

      // Approach ring: collapses onto the target at the arrival instant, so the
      // player reads timing from geometry rather than a number.
      const ringR = hitPx + (1 - progress) * w * 0.28;
      ctx.save();
      ctx.strokeStyle = progress > 0.88 ? COLOR.amber : COLOR.cyan;
      ctx.lineWidth = Math.max(2, w * 0.003);
      ctx.globalAlpha = 0.45 + 0.55 * progress;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = COLOR.amber;
      ctx.fillStyle = "rgba(255,168,92,0.14)";
      ctx.lineWidth = Math.max(2, w * 0.0025);
      ctx.beginPath();
      ctx.arc(cx, cy, hitPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - hitPx * 0.35, cy);
      ctx.lineTo(cx + hitPx * 0.35, cy);
      ctx.moveTo(cx, cy - hitPx * 0.35);
      ctx.lineTo(cx, cy + hitPx * 0.35);
      ctx.stroke();
      ctx.restore();
    }

    drawPaddle(surface, s, false);
    this.drawResultStrip(surface);
    this.drawHistogram(surface);

    const hits = this.attempts.filter((a) => a.hit).length;
    if (this.attempts.length) {
      label(
        surface,
        `${hits}/${this.attempts.length}  ·  ${fmt.pct(hits / this.attempts.length, 0)}`,
        w * 0.02,
        h * 0.03,
        { size: Math.round(w * 0.028), color: COLOR.ink },
      );
    } else {
      label(surface, "wait for the ring, put the paddle on the target", w * 0.02, h * 0.03, {
        size: Math.round(w * 0.018),
        color: COLOR.muted,
      });
    }
  }

  /** Recent hits and misses, newest on the right. */
  private drawResultStrip(surface: Surface): void {
    const { ctx, w, h } = surface;
    const recent = this.attempts.slice(-24);
    if (!recent.length) return;

    const r = Math.max(3, w * 0.005);
    const gap = r * 3;
    const y = h * 0.11;
    const x0 = w * 0.02 + r;

    recent.forEach((a, i) => {
      ctx.fillStyle = a.hit ? COLOR.ok : COLOR.warn;
      ctx.beginPath();
      ctx.arc(x0 + i * gap, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Timing error distribution: are misses early, late, or just scattered? */
  private drawHistogram(surface: Surface): void {
    const { ctx, w, h } = surface;
    if (this.attempts.length < 4) return;

    const bins = 9;
    const span = this.hitWindowMs;
    const counts = new Array<number>(bins).fill(0);
    for (const a of this.attempts) {
      const norm = (a.timingErrorMs + span) / (2 * span);
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(norm * bins)));
      counts[idx]++;
    }
    const peak = Math.max(...counts, 1);

    const boxW = w * 0.24;
    const boxH = h * 0.14;
    const x0 = w - boxW - w * 0.02;
    const y1 = h - h * 0.05;
    const barW = boxW / bins;

    ctx.save();
    ctx.fillStyle = "rgba(12,17,19,0.6)";
    ctx.fillRect(x0 - 8, y1 - boxH - 22, boxW + 16, boxH + 38);

    counts.forEach((c, i) => {
      const bh = (c / peak) * boxH;
      ctx.fillStyle = i === Math.floor(bins / 2) ? COLOR.amber : COLOR.cyan;
      ctx.fillRect(x0 + i * barW + 1, y1 - bh, barW - 2, bh);
    });

    ctx.strokeStyle = COLOR.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y1 + 0.5);
    ctx.lineTo(x0 + boxW, y1 + 0.5);
    ctx.stroke();
    ctx.restore();

    const size = Math.max(9, Math.round(w * 0.011));
    label(surface, "timing error", x0, y1 - boxH - 18, { size, color: COLOR.muted });
    label(surface, `−${span}`, x0, y1 + 4, { size, color: COLOR.muted });
    label(surface, `+${span} ms`, x0 + boxW, y1 + 4, { size, color: COLOR.muted, align: "right" });
  }

  readout(): Readout {
    const n = this.attempts.length;
    if (!n) {
      return [
        ["Attempts", "0"],
        ["Hit rate", "—"],
        ["Mean miss", "—"],
        ["Timing bias", "—"],
      ];
    }

    const hits = this.attempts.filter((a) => a.hit).length;
    const meanMiss = this.attempts.reduce((s, a) => s + a.minDist, 0) / n;
    const meanTiming = this.attempts.reduce((s, a) => s + a.timingErrorMs, 0) / n;
    const sd = Math.sqrt(
      this.attempts.reduce((s, a) => s + (a.timingErrorMs - meanTiming) ** 2, 0) / n,
    );

    return [
      ["Attempts", String(n)],
      ["Hit rate", `${fmt.pct(hits / n, 0)}  (${hits}/${n})`],
      ["Mean miss", `${fmt.num(meanMiss, 3)} w`],
      ["Timing bias", `${meanTiming >= 0 ? "+" : ""}${fmt.num(meanTiming, 0)} ±${fmt.num(sd, 0)} ms`],
    ];
  }

  csv(): string | null {
    if (!this.attempts.length) return null;
    const rows = ["index,target_x,target_y,hit,min_dist,dist_at_arrival,timing_error_ms"];
    for (const a of this.attempts) {
      rows.push(
        [
          a.index,
          a.x.toFixed(4),
          a.y.toFixed(4),
          a.hit ? 1 : 0,
          a.minDist.toFixed(4),
          a.distAtArrival.toFixed(4),
          a.timingErrorMs.toFixed(1),
        ].join(","),
      );
    }
    return rows.join("\n");
  }
}
