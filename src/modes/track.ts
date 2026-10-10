import { clear, drawPaddle, drawSkeleton, drawVideo, label, COLOR } from "../draw";
import type { Surface } from "../draw";
import { fmt, Rolling } from "../stats";
import type { PaddleSample } from "../tracker";
import type { Mode, Readout } from "./types";

/**
 * Baseline sanity check: is the hand tracked at all, how stable is it, and what
 * do the derived signals (span, angle, swing velocity) actually look like when
 * a person moves the way they would in a rally?
 */
export class TrackMode implements Mode {
  readonly id = "track";
  readonly title = "Track";
  readonly blurb =
    "Live paddle and derived signals. The dashed ghost is the unfiltered position — watch the gap during a fast swing.";

  private peakSpeed = 0;
  private readonly spanWindow = new Rolling(120);
  private readonly speedWindow = new Rolling(120);
  private lostFrames = 0;
  private totalFrames = 0;

  reset(): void {
    this.peakSpeed = 0;
    this.spanWindow.reset();
    this.speedWindow.reset();
    this.lostFrames = 0;
    this.totalFrames = 0;
  }

  onSample(s: PaddleSample): void {
    this.totalFrames++;
    if (!s.present) {
      this.lostFrames++;
      return;
    }
    this.spanWindow.push(s.span);
    this.speedWindow.push(s.speed);
    this.peakSpeed = Math.max(this.peakSpeed, s.speed);
  }

  draw(surface: Surface, s: PaddleSample): void {
    clear(surface);
    drawVideo(surface, 0.25);
    drawSkeleton(surface, s);
    drawPaddle(surface, s);

    if (!s.present) {
      label(surface, "no hand in frame", surface.w / 2, surface.h / 2, {
        size: Math.round(surface.w * 0.022),
        color: COLOR.warn,
        align: "center",
      });
    }
  }

  readout(): Readout {
    const lossRate = this.totalFrames ? this.lostFrames / this.totalFrames : 0;
    return [
      ["Palm span", fmt.num(this.spanWindow.mean, 3)],
      ["Swing speed", `${fmt.num(this.speedWindow.mean, 2)} w/s`],
      ["Peak swing", `${fmt.num(this.peakSpeed, 2)} w/s`],
      ["Frames lost", fmt.pct(lossRate, 1)],
    ];
  }
}
