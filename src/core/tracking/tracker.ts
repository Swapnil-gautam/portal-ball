import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { HandChooser, type HandCandidate, type HandLabel } from "./handChooser";
import { DEFAULT_ONE_EURO, LagEstimator, OneEuroFilter, type OneEuroParams } from "./oneEuro";
import { Rolling } from "./stats";

// MediaPipe hand landmark indices.
const WRIST = 0;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const RING_MCP = 13;
const PINKY_MCP = 17;
const PALM = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];

export type HandSide = "left" | "right";

function asLabel(categoryName: string | undefined): HandLabel | null {
  return categoryName === "Left" || categoryName === "Right" ? categoryName : null;
}

export interface PaddleSample {
  present: boolean;
  /** Handedness score. A proxy for tracking quality, not a true presence score. */
  confidence: number;
  /** Filtered palm centre, normalized 0..1, already mirrored for display. */
  x: number;
  y: number;
  /** Unfiltered palm centre, for drawing the ghost that makes filter lag visible. */
  rawX: number;
  rawY: number;
  /** Palm "up" direction (wrist to middle knuckle), radians. */
  angle: number;
  /** Wrist-to-knuckle distance in frame-width units. Crude depth proxy. */
  span: number;
  /** Velocity of the filtered position, frame-widths per second. */
  vx: number;
  vy: number;
  speed: number;
  landmarks: NormalizedLandmark[] | null;
  /**
   * The same hand in rough metric 3D (camera's raw, unmirrored orientation).
   * Noisy for position, but good enough for which way the palm is facing.
   */
  worldLandmarks: Landmark[] | null;
  /** Every hand MediaPipe saw this frame (its own labels), including ones being ignored. */
  seen: { label: HandLabel | null; score: number }[];
  /** performance.now() when this sample finished processing. */
  tProcessed: number;
  inferenceMs: number;
  /** now - metadata.captureTime, when the browser exposes it. */
  captureLatencyMs: number | null;
}

const EMPTY: PaddleSample = {
  present: false,
  confidence: 0,
  x: 0.5,
  y: 0.5,
  rawX: 0.5,
  rawY: 0.5,
  angle: 0,
  span: 0,
  vx: 0,
  vy: 0,
  speed: 0,
  landmarks: null,
  worldLandmarks: null,
  seen: [],
  tProcessed: 0,
  inferenceMs: 0,
  captureLatencyMs: null,
};

export class Tracker {
  readonly video: HTMLVideoElement = document.createElement("video");
  latest: PaddleSample = { ...EMPTY };

  readonly inference = new Rolling(180);
  readonly frameInterval = new Rolling(180);
  readonly captureLatency = new Rolling(180);
  readonly lag = new LagEstimator();

  params: OneEuroParams = { ...DEFAULT_ONE_EURO };

  private landmarker: HandLandmarker | null = null;
  private fx = new OneEuroFilter(this.params);
  private fy = new OneEuroFilter(this.params);
  private lastTimestamp = 0;
  private lastFrameAt: number | null = null;
  private prev: { x: number; y: number; t: number } | null = null;
  private running = false;
  private aspect = 16 / 9;
  /** Frames lost to a thrown exception rather than to a missing hand. */
  errors = 0;

  /** Fires once per new camera frame, after the sample is built. */
  onSample: ((s: PaddleSample) => void) | null = null;

  /** Which delegate we ended up on — the HUD should say, since it moves the numbers. */
  delegate: "GPU" | "CPU" = "GPU";

  /**
   * `trackingConfidence` is how sure MediaPipe must stay to keep following a
   * hand it already found; `detectionConfidence` is how sure it must be to
   * find one from scratch — which is what it falls back to after losing a
   * hand mid-swing, on frames that are still blurred. The 0.5 defaults drop
   * fast swings, so the game lowers both. Diagnostics keep the defaults so
   * their frame-loss numbers stay comparable.
   */
  constructor(
    private readonly opts: {
      detectionConfidence?: number;
      trackingConfidence?: number;
      /**
       * The player's paddle hand. With a second hand in view, the tracker
       * stays with this one (see HandChooser). Default: whichever it finds.
       */
      hand?: HandSide;
    } = {},
  ) {
    // Starting guess for the label MediaPipe gives the paddle hand. On the
    // camera this was tested with, a right hand comes out labelled "Right"
    // (assuming the opposite meant only the left hand was tracked). Cameras
    // differ, so HandChooser keeps learning it from real play.
    this.chooser = opts.hand ? new HandChooser(opts.hand === "right" ? "Right" : "Left") : null;
  }

  private readonly chooser: HandChooser | null;

  /** The label MediaPipe gives the player's hand on this camera, as learned so far. */
  get playingLabel(): HandLabel | null {
    return this.chooser?.playingLabel ?? null;
  }

  async init(): Promise<void> {
    // Relative to wherever the site is served from — the published game lives
    // under a sub-path (…github.io/portal-ball/), not at the domain root.
    const base = import.meta.env.BASE_URL;
    const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);

    const build = (delegate: "GPU" | "CPU") =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${base}models/hand_landmarker.task`,
          delegate,
        },
        runningMode: "VIDEO",
        // One hand. MediaPipe only skips its expensive hand-detection step
        // once it's tracking as many hands as it's looking for — asking for
        // two while one is in view ran full detection every frame, which
        // brought back the paddle lag. With one, once it's following your
        // hand it doesn't look for others, so a second hand coming into view
        // doesn't take over (unless your hand is lost while the other is up).
        numHands: 1,
        minHandDetectionConfidence: this.opts.detectionConfidence ?? 0.5,
        minHandPresenceConfidence: this.opts.trackingConfidence ?? 0.5,
        minTrackingConfidence: this.opts.trackingConfidence ?? 0.5,
      });

    try {
      this.landmarker = await build("GPU");
      this.delegate = "GPU";
    } catch (err) {
      // Some Windows GPU/driver combinations reject the WebGL delegate outright.
      // CPU is slower but it is better than no spike at all.
      console.warn("GPU delegate unavailable, falling back to CPU:", err);
      this.landmarker = await build("CPU");
      this.delegate = "CPU";
    }
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        // Front camera on phones and tablets; ignored by ordinary webcams.
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });

    this.video.srcObject = stream;
    this.video.playsInline = true;
    this.video.muted = true;
    await this.video.play();
    this.aspect = this.video.videoWidth / this.video.videoHeight;

    this.running = true;
    this.pump();
  }

  stop(): void {
    this.running = false;
    const stream = this.video.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }

  /** The raw camera stream, for anything that needs it besides tracking — e.g. WebRTC. */
  getStream(): MediaStream | null {
    return this.video.srcObject as MediaStream | null;
  }

  /** Current camera settings, for the HUD. */
  cameraInfo(): { width: number; height: number; fps: number | null } {
    const track = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    const settings = track?.getSettings();
    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      fps: settings?.frameRate ?? null,
    };
  }

  resetFilters(): void {
    this.fx.params = this.params;
    this.fy.params = this.params;
    this.fx.reset();
    this.fy.reset();
    this.lag.reset();
    this.prev = null;
  }

  private pump(): void {
    if (!this.running) return;

    // `process` must never take the loop down with it: this callback is what
    // schedules the next frame, so an uncaught throw would stop tracking
    // permanently and silently.
    const step = (now: number, meta: VideoFrameCallbackMetadata | null) => {
      try {
        this.process(now, meta);
      } catch (err) {
        this.errors++;
        if (this.errors <= 3) console.error("frame processing failed:", err);
      }
      this.pump();
    };

    // Typed as required by the DOM lib, but genuinely absent in a few browsers.
    if ("requestVideoFrameCallback" in this.video) {
      this.video.requestVideoFrameCallback((now, meta) => step(now, meta));
    } else {
      // Safari < 15.4 and a few others. Falls back to display cadence, which
      // means some frames get inferred twice; fps readout will be less honest.
      requestAnimationFrame((now) => step(now, null));
    }
  }

  private process(now: number, meta: VideoFrameCallbackMetadata | null): void {
    if (!this.landmarker || this.video.readyState < 2) return;

    // Re-read every frame: turning a phone swaps the camera's width and
    // height, and reading it once at start left angles and speeds skewed
    // after rotating from portrait to landscape.
    if (this.video.videoWidth && this.video.videoHeight) {
      this.aspect = this.video.videoWidth / this.video.videoHeight;
    }

    if (this.lastFrameAt !== null) this.frameInterval.push(now - this.lastFrameAt);
    this.lastFrameAt = now;

    if (meta?.captureTime !== undefined) {
      this.captureLatency.push(Math.max(0, now - meta.captureTime));
    }

    // MediaPipe requires strictly increasing timestamps in ms.
    const timestamp = Math.max(this.lastTimestamp + 1, Math.round(now));
    this.lastTimestamp = timestamp;

    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(this.video, timestamp);
    const inferenceMs = performance.now() - t0;
    this.inference.push(inferenceMs);

    const candidates: HandCandidate[] = result.landmarks.map((lm, i) => {
      let px = 0;
      let py = 0;
      for (const k of PALM) {
        px += lm[k].x;
        py += lm[k].y;
      }
      return {
        i,
        label: asLabel(result.handedness[i]?.[0]?.categoryName),
        score: result.handedness[i]?.[0]?.score ?? 0,
        palm: { x: px / PALM.length, y: py / PALM.length },
      };
    });
    const pick = this.chooser ? this.chooser.choose(candidates, now) : (candidates[0] ?? null);
    const seenSummary = candidates.map((h) => ({ label: h.label, score: h.score }));

    const hand = pick ? result.landmarks[pick.i] : undefined;
    if (!hand || !pick) {
      this.latest = { ...EMPTY, seen: seenSummary, tProcessed: now, inferenceMs };
      this.onSample?.(this.latest);
      return;
    }

    // Mirror x so the display reads like a mirror, and everything downstream
    // works in display space.
    const mirrored = hand.map((p) => ({ ...p, x: 1 - p.x }));

    let cx = 0;
    let cy = 0;
    for (const i of PALM) {
      cx += mirrored[i].x;
      cy += mirrored[i].y;
    }
    cx /= PALM.length;
    cy /= PALM.length;

    const tSec = now / 1000;
    this.fx.params = this.params;
    this.fy.params = this.params;
    const x = this.fx.filter(cx, tSec);
    const y = this.fy.filter(cy, tSec);

    this.lag.push(cx, x, this.frameInterval.mean / 1000 || 1 / 60);

    const wrist = mirrored[WRIST];
    const middle = mirrored[MIDDLE_MCP];
    const dx = middle.x - wrist.x;
    // Normalized y is relative to height; rescale so distances are isotropic
    // and expressed in frame-width units.
    const dy = (middle.y - wrist.y) / this.aspect;

    let vx = 0;
    let vy = 0;
    if (this.prev) {
      const dt = Math.max(1e-3, tSec - this.prev.t);
      vx = (x - this.prev.x) / dt;
      vy = (y - this.prev.y) / this.aspect / dt;
    }
    this.prev = { x, y, t: tSec };

    this.latest = {
      present: true,
      confidence: pick.score,
      x,
      y,
      rawX: cx,
      rawY: cy,
      angle: Math.atan2(dy, dx),
      span: Math.hypot(dx, dy),
      vx,
      vy,
      speed: Math.hypot(vx, vy),
      landmarks: mirrored,
      worldLandmarks: result.worldLandmarks[pick.i] ?? null,
      seen: seenSummary,
      tProcessed: now,
      inferenceMs,
      captureLatencyMs: meta?.captureTime !== undefined ? now - meta.captureTime : null,
    };

    this.onSample?.(this.latest);
  }
}
