import { COLOR, label } from "../../core/tracking/overlay2d";
import type { Surface } from "../../core/tracking/overlay2d";
import { fmt } from "../../core/tracking/stats";
import type { PaddleSample } from "../../core/tracking/tracker";
import type { Mode, Readout } from "./types";

const FLASH_HOLD_MS = 220;
const HYSTERESIS = 0.035;

interface Trigger {
  index: number;
  atMs: number;
  displayFrame: number;
}

/**
 * The only honest way to measure true end-to-end latency from inside a browser
 * is to leave the browser: film your hand and the screen together at 240 fps
 * and count frames. This mode gives that film something unambiguous to capture.
 *
 * When the tracked palm crosses the trigger line, the screen flips to full
 * white and a frame counter keeps ticking, so a single video frame tells you
 * both that the flip happened and exactly which display frame it happened on.
 */
export class LatencyMode implements Mode {
  readonly id = "latency";
  readonly title = "Latency probe";
  readonly blurb =
    "Cross the line with your hand and the screen flashes. Film hand + screen at 240 fps, count frames from the physical crossing to the flash.";

  /** Trigger line height, normalized. */
  lineY = 0.45;

  private armed = true;
  private flashUntil = 0;
  private displayFrame = 0;
  private triggers: Trigger[] = [];
  private strobe = false;

  reset(): void {
    this.armed = true;
    this.flashUntil = 0;
    this.triggers = [];
  }

  onSample(s: PaddleSample): void {
    if (!s.present) return;
    const now = performance.now();

    // Fires on an upward crossing only; the hand must fall back below the band
    // before the next one can arm, so a hand hovering on the line can't chatter.
    if (this.armed && s.y < this.lineY - HYSTERESIS) {
      this.armed = false;
      this.flashUntil = now + FLASH_HOLD_MS;
      this.triggers.push({
        index: this.triggers.length + 1,
        atMs: now,
        displayFrame: this.displayFrame,
      });
      if (this.triggers.length > 60) this.triggers.shift();
    } else if (!this.armed && s.y > this.lineY + HYSTERESIS) {
      this.armed = true;
    }
  }

  draw(surface: Surface, s: PaddleSample): void {
    const { ctx, w, h } = surface;
    this.displayFrame++;
    this.strobe = !this.strobe;

    const flashing = performance.now() < this.flashUntil;

    // Deliberately cheap: a full-screen fill and some text. Anything heavier
    // would inflate the very number we are trying to measure.
    ctx.fillStyle = flashing ? "#FFFFFF" : "#07090A";
    ctx.fillRect(0, 0, w, h);

    // Per-frame strobe square: gives the 240 fps footage a way to see display
    // frame boundaries, so you can count in display frames as well as video ones.
    ctx.fillStyle = this.strobe ? "#FFFFFF" : "#07090A";
    ctx.fillRect(w - w * 0.09, 0, w * 0.09, w * 0.09);

    const fg = flashing ? "#07090A" : COLOR.ink;

    label(surface, String(this.displayFrame % 10000).padStart(4, "0"), w * 0.5, h * 0.30, {
      size: Math.round(w * 0.14),
      color: fg,
      align: "center",
    });
    label(surface, flashing ? "TRIGGERED" : "armed — cross the line", w * 0.5, h * 0.62, {
      size: Math.round(w * 0.022),
      color: flashing ? "#07090A" : this.armed ? COLOR.cyan : COLOR.muted,
      align: "center",
    });
    label(surface, `triggers ${this.triggers.length}`, w * 0.5, h * 0.70, {
      size: Math.round(w * 0.016),
      color: flashing ? "#07090A" : COLOR.muted,
      align: "center",
    });

    // Small preview so you can confirm the hand is actually being tracked
    // without lighting up the whole screen.
    const pw = w * 0.2;
    const ph = pw / surface.aspect;
    const px = w * 0.02;
    const py = h - ph - w * 0.02;

    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.translate(px + pw, py);
    ctx.scale(-1, 1);
    ctx.drawImage(surface.video, 0, 0, pw, ph);
    ctx.restore();

    ctx.strokeStyle = COLOR.rule;
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, pw, ph);

    // Trigger line, drawn in the preview.
    ctx.strokeStyle = this.armed ? COLOR.cyan : COLOR.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, py + this.lineY * ph);
    ctx.lineTo(px + pw, py + this.lineY * ph);
    ctx.stroke();

    if (s.present) {
      ctx.fillStyle = COLOR.amber;
      ctx.beginPath();
      ctx.arc(px + s.x * pw, py + s.y * ph, Math.max(3, pw * 0.018), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  readout(): Readout {
    const last = this.triggers[this.triggers.length - 1];
    const prev = this.triggers[this.triggers.length - 2];
    return [
      ["Triggers", String(this.triggers.length)],
      ["Last at frame", last ? String(last.displayFrame) : "—"],
      ["Since previous", last && prev ? fmt.ms(last.atMs - prev.atMs, 0) : "—"],
      ["State", this.armed ? "armed" : "waiting for reset"],
    ];
  }

  csv(): string | null {
    if (!this.triggers.length) return null;
    const rows = ["index,t_ms,display_frame"];
    for (const t of this.triggers) {
      rows.push(`${t.index},${t.atMs.toFixed(2)},${t.displayFrame}`);
    }
    return rows.join("\n");
  }
}
