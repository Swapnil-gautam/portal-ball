import type { Surface } from "../draw";
import type { PaddleSample } from "../tracker";

export type Readout = ReadonlyArray<readonly [label: string, value: string]>;

export interface Mode {
  readonly id: string;
  readonly title: string;
  /** What this mode is for, shown under the tabs. */
  readonly blurb: string;
  reset(): void;
  /** Once per camera frame, in step with tracking. */
  onSample(s: PaddleSample): void;
  /** Once per display frame. */
  draw(surface: Surface, s: PaddleSample): void;
  readout(): Readout;
  /** CSV of whatever this mode has logged, or null if it logs nothing. */
  csv?(): string | null;
}
