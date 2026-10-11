import { clear, drawSkeleton, drawVideo, type Surface } from "../draw";
import { Tracker } from "../tracker";
import { AIOpponent } from "./ai";
import { BallMachine } from "./ballMachine";
import { ARRIVAL_HEIGHT, BALL_RADIUS } from "./court";
import { GameState, type GameEvent, type UiEvent } from "./gamestate";
import { HandPaddle } from "./handPaddle";
import { PaddleOrientation } from "./paddleOrientation";
import { INDEX_MCP, PINKY_MCP, WRIST, handPose, type HandPose } from "./paddlePose";
import {
  DEFAULT_SETTINGS,
  SETTING_SPECS,
  changedSettings,
  paddleSettings,
  resetPaddleSettings,
  setPaddleSetting,
  type PaddleSettings,
} from "./paddleSettings";
import { RTCGamePeer, type PaddleState } from "./network";
import type { Paddle, Side } from "./physics";
import { Scene3D } from "./scene3d";
import { announceCamera, otherCameraTabs } from "./tabGuard";

type Mode = "ai" | "network" | "lab";

if (import.meta.env.DEV) {
  // Dev builds only: lets a test drive the real pipeline with synthetic hands.
  queueMicrotask(() => {
    (window as unknown as Record<string, unknown>).__portal = { tracker, hand, getGame: () => game };
  });
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const canvas = el<HTMLCanvasElement>("canvas");
const viewport = el<HTMLDivElement>("viewport");
const curtain = el<HTMLDivElement>("curtain");
const errEl = el<HTMLParagraphElement>("err");

const opponentView = el<HTMLDivElement>("opponent-view");
const opponentVideo = el<HTMLVideoElement>("opponent-video");
const menuBtn = el<HTMLButtonElement>("menu-btn");
const selfView = el<HTMLDivElement>("self-view");
const selfCanvas = el<HTMLCanvasElement>("self-canvas");
const selfCtx = selfCanvas.getContext("2d", { alpha: false });
if (!selfCtx) throw new Error("2d canvas context unavailable");

const scoreYou = el<HTMLElement>("score-you");
const scoreOpp = el<HTMLElement>("score-opp");
const scoreYouRow = el<HTMLDivElement>("score-you-row");
const scoreOppRow = el<HTMLDivElement>("score-opp-row");
const serveBanner = el<HTMLDivElement>("serve-banner");
const serveText = el<HTMLParagraphElement>("serve-text");
const serveProgress = el<HTMLDivElement>("serve-progress");
const pointFlash = el<HTMLDivElement>("point-flash");
const endScreen = el<HTMLDivElement>("end-screen");
const endTitle = el<HTMLHeadingElement>("end-title");

const views = Array.from(document.querySelectorAll<HTMLElement>("[data-view]"));
function show(name: string): void {
  errEl.textContent = "";
  for (const v of views) v.classList.toggle("active", v.dataset.view === name);
}

// Right hand only: a left hand (or anyone else's) coming into view is ignored.
const tracker = new Tracker({ detectionConfidence: 0.3, trackingConfidence: 0.25, hand: "right" });
const scene = new Scene3D(canvas);
const hand = new HandPaddle((u, v) => scene.screenToStrikePlane(u, v));
let game: GameState | null = null;
let ai: AIOpponent | null = null;
let peer: RTCGamePeer | null = null;
let mode: Mode = "ai";
/** In network play the host serves first; the guest's game must start with the other side serving. */
let firstServer: Side = "local";
let playing = false;
let lastFrameAt = performance.now();
let flashTimer = 0;

// ---------------------------------------------------------------- sizing

function resizeSurfaces(): void {
  const rect = viewport.getBoundingClientRect();
  scene.resize(Math.max(1, rect.width), Math.max(1, rect.height));

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const selfRect = selfView.getBoundingClientRect();
  selfCanvas.width = Math.max(1, Math.round(selfRect.width * dpr));
  selfCanvas.height = Math.max(1, Math.round(selfRect.height * dpr));
}

const resizer = new ResizeObserver(resizeSurfaces);
resizer.observe(viewport);
resizer.observe(selfView);
resizeSurfaces();

// ---------------------------------------------------------------- camera + paddle

async function ensureCamera(onProgress: (msg: string) => void): Promise<void> {
  if (tracker.getStream()) return;
  onProgress("Loading the hand tracker…");
  await tracker.init();
  onProgress("Requesting camera access…");
  await tracker.start();
  announceCamera();
  // Match the corner preview to the camera's real shape, so the skeleton
  // overlay isn't drawn over a stretched picture.
  const { videoWidth: w, videoHeight: h } = tracker.video;
  if (w && h) selfView.style.aspectRatio = `${w} / ${h}`;
}

/** Paddle orientation, fed once per new camera frame of your hand. */
const orientation = new PaddleOrientation();
let poseSampleT = -1;
/** This camera frame's own pose — the head point is computed from it, unsmoothed. */
let framePose: HandPose | null = null;

function updatePose(): void {
  const s = tracker.latest;
  if (!s.present || !s.landmarks || s.tProcessed === poseSampleT) return;
  poseSampleT = s.tProcessed;
  const { videoWidth: w, videoHeight: h } = tracker.video;
  framePose = handPose(s.landmarks, s.worldLandmarks, w && h ? w / h : 16 / 9);
  orientation.update(framePose);
}

/**
 * Direction from palm to paddle head for this camera frame: the frame's own
 * knuckle line, falling back toward the smoothed one when the knuckle line is
 * foreshortened (pointing at the camera) and too short to trust.
 */
function headDirection(): { x: number; y: number } {
  const smooth = orientation.handle;
  if (!framePose) return smooth;
  const trust = Math.min(1, framePose.handleSpan / 0.035);
  const x = smooth.x + (framePose.handle.x - smooth.x) * trust;
  const y = smooth.y + (framePose.handle.y - smooth.y) * trust;
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

/**
 * The paddle head — what hits the ball. It sits past your index knuckle,
 * along your knuckle line. Reach, height offset and handle length come from
 * the Paddle lab settings.
 *
 * The head point is worked out on each camera frame and then tracked by
 * HandPaddle — the same lag-free motion fit that made the palm feel right.
 * (Adding a separately smoothed direction to an already-tracked palm made the
 * head trail the hand and lurch on fast moves.)
 */
function currentLocalPaddle(now: number) {
  const s = tracker.latest;
  const set = paddleSettings();
  // Raw palm position, not the tracker's filtered one: MotionFit does its own
  // smoothing, and the tracker's filter is what made fast moves lag. Reach
  // scales movement around the screen centre; height offset shifts it.
  const u = 0.5 + (s.rawX - 0.5) * set.reach;
  const v = 0.5 + (s.rawY - 0.5) * set.reach - set.heightOffset;
  updatePose();
  const dir = headDirection();
  const offset = { x: dir.x * set.headOffset, y: dir.y * set.headOffset };
  return hand.update({ present: s.present, u, v, t: s.tProcessed, offset }, now);
}

/**
 * A hit counts when the ball, as you see it, is within this distance of the
 * paddle head's centre — the head's radius plus a margin past the rim (the
 * "Hit area" setting, in ball radii).
 */
function contactRadius(): number {
  const { headRadius, hitMargin } = paddleSettings();
  return headRadius + BALL_RADIUS * hitMargin;
}

function drawLocalPaddle(paddle: ReturnType<typeof currentLocalPaddle>): void {
  scene.updateLocalPaddle(
    paddle?.x ?? 0,
    paddle?.y ?? 0,
    paddle?.state === "tracked" ? orientation.axes() : null,
    paddle !== null,
    PADDLE_STRENGTH[paddle?.state ?? "tracked"],
  );
}

// ---------------------------------------------------------------- landing

show("landing");

el<HTMLButtonElement>("pick-ai").addEventListener("click", () => show("ai-setup"));
el<HTMLButtonElement>("pick-friend").addEventListener("click", () => show("friend-choice"));
el<HTMLButtonElement>("pick-lab").addEventListener("click", async () => {
  goLandscape();
  show("loading-cam");
  try {
    await ensureCamera((msg) => (el<HTMLElement>("loading-status").textContent = msg));
    enterLab();
  } catch (err) {
    show("landing");
    errEl.textContent = `Couldn't start: ${(err as Error).message}`;
  }
});
el<HTMLButtonElement>("ai-back").addEventListener("click", () => show("landing"));
el<HTMLButtonElement>("friend-back").addEventListener("click", () => show("landing"));

// ---------------------------------------------------------------- AI setup

const diffSlider = el<HTMLInputElement>("diff-slider");
const diffReadout = el<HTMLElement>("diff-readout");
diffSlider.addEventListener("input", () => {
  diffReadout.textContent = `${diffSlider.value}%`;
});

el<HTMLButtonElement>("ai-start").addEventListener("click", async () => {
  goLandscape();
  const difficulty = Number(diffSlider.value) / 100;
  show("loading-cam");
  try {
    await ensureCamera((msg) => (el<HTMLElement>("loading-status").textContent = msg));
    mode = "ai";
    ai = new AIOpponent(difficulty);
    game = new GameState("ai", "local");
    enterGame();
  } catch (err) {
    show("ai-setup");
    errEl.textContent = `Couldn't start: ${(err as Error).message}`;
  }
});

// ---------------------------------------------------------------- friend: host / join

el<HTMLButtonElement>("pick-host").addEventListener("click", async () => {
  goLandscape();
  show("loading-cam");
  try {
    await ensureCamera((msg) => (el<HTMLElement>("loading-status").textContent = msg));
    await startHost();
  } catch (err) {
    show("friend-choice");
    errEl.textContent = `Couldn't start: ${(err as Error).message}`;
  }
});

el<HTMLButtonElement>("pick-join").addEventListener("click", () => show("join-enter"));
el<HTMLButtonElement>("join-back").addEventListener("click", () => show("friend-choice"));

async function startHost(): Promise<void> {
  mode = "network";
  firstServer = "local";
  const stream = tracker.getStream();
  if (!stream) throw new Error("camera stream missing");

  peer = new RTCGamePeer(stream);
  wirePeer(peer);

  show("host-wait");
  el<HTMLTextAreaElement>("host-code").value = "Generating…";
  el<HTMLTextAreaElement>("host-code").value = await peer.createInvite();
}

el<HTMLButtonElement>("host-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(el<HTMLTextAreaElement>("host-code").value);
  flashStatus("host-status", "Copied.");
});

el<HTMLButtonElement>("host-connect").addEventListener("click", async () => {
  const answer = el<HTMLTextAreaElement>("host-answer").value.trim();
  if (!answer || !peer) return;
  try {
    await peer.completeInvite(answer);
    setDot("host-dot", "pulse");
    el<HTMLElement>("host-status").textContent = "Connecting…";
  } catch (err) {
    setDot("host-dot", "bad");
    el<HTMLElement>("host-status").textContent = `That code didn't work: ${(err as Error).message}`;
  }
});

el<HTMLButtonElement>("host-back").addEventListener("click", () => {
  peer?.close();
  peer = null;
  show("friend-choice");
});

el<HTMLButtonElement>("join-continue").addEventListener("click", async () => {
  const code = el<HTMLTextAreaElement>("join-code").value.trim();
  if (!code) return;
  goLandscape();

  show("loading-cam");
  try {
    await ensureCamera((msg) => (el<HTMLElement>("loading-status").textContent = msg));
    mode = "network";
    firstServer = "remote";
    const stream = tracker.getStream();
    if (!stream) throw new Error("camera stream missing");

    peer = new RTCGamePeer(stream);
    wirePeer(peer);

    el<HTMLTextAreaElement>("join-answer").value = await peer.acceptInvite(code);
    show("join-wait");
  } catch (err) {
    show("join-enter");
    errEl.textContent = `That code didn't work: ${(err as Error).message}`;
  }
});

el<HTMLButtonElement>("join-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(el<HTMLTextAreaElement>("join-answer").value);
  flashStatus("join-status", "Copied.");
});

el<HTMLButtonElement>("join-back2").addEventListener("click", () => {
  peer?.close();
  peer = null;
  show("friend-choice");
});

function flashStatus(id: string, msg: string): void {
  const target = el<HTMLElement>(id);
  const prev = target.textContent;
  target.textContent = msg;
  setTimeout(() => {
    if (target.textContent === msg) target.textContent = prev;
  }, 1400);
}

function setDot(id: string, state: "pulse" | "ok" | "bad"): void {
  el<HTMLElement>(id).className = `dot-status ${state}`;
}

// ---------------------------------------------------------------- peer wiring

function wirePeer(p: RTCGamePeer): void {
  p.onRemoteStream = (stream) => {
    opponentVideo.srcObject = stream;
    opponentVideo.play().catch(() => {});
    opponentView.hidden = false;
  };

  p.onPaddle = (theirs) => {
    remotePaddle = mirrorPaddle(theirs);
  };

  p.onEvent = (evt: GameEvent) => game?.applyRemoteEvent(evt, p.latencyMs);

  p.onStatus = (status) => {
    if (status === "connected" && !playing) {
      game = new GameState("network", firstServer);
      enterGame();
    } else if (status === "failed" || status === "disconnected") {
      if (playing) {
        exitToMenu();
        errEl.textContent = "The connection to your opponent dropped.";
      } else if (status === "failed") {
        errEl.textContent = "Connection failed — the code was mismatched or stale. Try again.";
      }
    }
  };
}

// ---------------------------------------------------------------- game loop

function enterGame(): void {
  if (!game) return;
  playing = true;
  curtain.hidden = true;
  endScreen.hidden = true;
  lastFrameAt = performance.now();
  hand.reset();
  orientation.reset();
  framePose = null;

  remotePaddle = null;
  menuBtn.hidden = false;
  scene.updateOpponentPaddle(0, 0, null, false);

  game.onEvent = (evt: GameEvent) => {
    if (mode === "network") peer?.send(evt);
  };

  requestAnimationFrame(frame);
}

function exitToMenu(): void {
  playing = false;
  machine = null;
  viewport.classList.remove("lab");
  labPanel.hidden = true;
  const p = peer;
  peer = null;
  p?.close();
  ai = null;
  game = null;
  opponentView.hidden = true;
  opponentVideo.srcObject = null;
  remotePaddle = null;
  menuBtn.hidden = true;
  scene.updateOpponentPaddle(0, 0, null, false);
  curtain.hidden = false;
  endScreen.hidden = true;
  serveBanner.hidden = true;
  show("landing");
}

/** Most recent error from a frame, shown in the D readout. */
let lastFrameError: { message: string; count: number } | null = null;

function frame(now: number): void {
  if (!playing || !game) return;
  requestAnimationFrame(frame);

  try {
    step(now, game);
  } catch (err) {
    reportFrameError(err, now);
  }
}

/**
 * An exception in a frame used to stop the whole loop for good — the paddle
 * froze with no hint why. Now the next frame still runs, and the error is
 * shown in the D readout (opened automatically the first time).
 */
function reportFrameError(err: unknown, now: number): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!lastFrameError) {
    console.error("frame failed:", err);
    debugEl.hidden = false;
  }
  lastFrameError = { message, count: (lastFrameError?.count ?? 0) + 1 };
  if (now - debugUpdatedAt > 200) updateDebug(now);
}

function step(now: number, game: GameState): void {
  const dt = Math.min((now - lastFrameAt) / 1000, 0.05);
  lastFrameAt = now;

  game.physics.localContactRadius = contactRadius();
  const paddle = currentLocalPaddle(now);
  // A held paddle has zero speed, which the serve would read as "holding
  // still" — so only a tracked paddle serves, and a held one can't hit.
  // A predicted one can hit: that's the whole point mid-swing.
  const canAct =
    paddle !== null &&
    (paddle.state === "tracked" || (paddle.state === "predicted" && game.match.phase === "rally"));
  if (canAct) game.updateLocalPaddle(paddle, now);
  if (mode === "network") sendOurPaddle(paddle, now);

  if (mode === "ai" && ai) {
    ai.update(game.physics.ball, paddle, dt, now);
    game.updateAIPaddle(ai.paddle, ai.intent, now);
  }

  for (const e of game.step(dt, now)) handleUi(e);

  scene.updateBall(game.physics.ball.pos);
  drawLocalPaddle(paddle);
  if (ai) scene.updateOpponentPaddle(ai.paddle.x, ai.paddle.y, null, true);
  else if (mode === "network") drawRemotePaddle();
  scene.render();

  updateHud(paddle?.state === "tracked", now);
  renderSelfView();
  if (!debugEl.hidden && now - debugUpdatedAt > 200) updateDebug(now);
  updateTabWarning(now);
}

const tabWarning = el<HTMLDivElement>("tab-warning");
let tabWarningAt = 0;

/** Another tab running the camera halves the tracker's speed — say so. Checked about once a second. */
function updateTabWarning(now: number): void {
  if (now - tabWarningAt < 1000) return;
  tabWarningAt = now;
  tabWarning.hidden = otherCameraTabs() === 0;
}

const PADDLE_STRENGTH = { tracked: 1, predicted: 0.6, held: 0.3 } as const;

// ---------------------------------------------------------------- debug readout (D)

const debugEl = el<HTMLDivElement>("debug");
let debugUpdatedAt = 0;

function updateDebug(now: number): void {
  debugUpdatedAt = now;
  const fps = tracker.frameInterval.count ? 1000 / tracker.frameInterval.mean : 0;
  const d = hand.stats;
  const seen = tracker.latest.seen.map((h) => `${h.label ?? "?"} ${Math.round(h.score * 100)}%`).join(", ") || "none";
  debugEl.textContent = [
    `camera ${fps.toFixed(0)} fps · tracker ${tracker.inference.mean.toFixed(0)} ms (${tracker.delegate})`,
    `hands seen: ${seen} · your hand is labelled "${tracker.playingLabel ?? "?"}" on this camera`,
    `hand lost ${d.count}× · longest ${d.longestMs.toFixed(0)} ms · last ${d.lastMs.toFixed(0)} ms`,
    `lost longer than prediction covers: ${d.overPredict}×`,
    `other Portal Ball tabs using the camera: ${otherCameraTabs()}`,
    ...(lastFrameError ? [`ERROR (${lastFrameError.count}×): ${lastFrameError.message}`] : []),
  ].join("\n");
}

function handleUi(e: UiEvent): void {
  if (e.type === "point") {
    pointFlash.className = e.scorer === "local" ? "you show" : "opp show";
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => pointFlash.classList.remove("show"), 260);
  } else if (e.type === "match_end") {
    endTitle.textContent = e.winner === "local" ? "You win" : "Opponent wins";
    endTitle.className = e.winner === "local" ? "win" : "lose";
    endScreen.hidden = false;
  }
}

function updateHud(handVisible: boolean, now: number): void {
  if (!game) return;
  const m = game.match;

  scoreYou.textContent = String(m.scoreLocal);
  scoreOpp.textContent = String(m.scoreRemote);
  scoreYouRow.classList.toggle("serving", m.serving === "local");
  scoreOppRow.classList.toggle("serving", m.serving === "remote");

  if (m.phase === "serve") {
    serveBanner.hidden = false;
    if (m.serving === "local") {
      serveText.textContent = handVisible ? "hold still to serve" : "raise your hand to serve";
      serveProgress.style.width = `${game.serveHoldProgress(now) * 100}%`;
    } else {
      serveText.textContent = "opponent is serving…";
      serveProgress.style.width = "0%";
    }
  } else {
    serveBanner.hidden = true;
  }
}

function renderSelfView(): void {
  if (!selfCtx) return;
  const surface: Surface = {
    ctx: selfCtx,
    w: selfCanvas.width,
    h: selfCanvas.height,
    video: tracker.video,
    aspect: selfCanvas.width / selfCanvas.height,
  };
  clear(surface);
  if (tracker.video.readyState >= 2) drawVideo(surface, 0.06);
  drawSkeleton(surface, tracker.latest);
  drawGripGuide(surface);
}

/**
 * What the paddle follows, drawn over your hand: the palm triangle (wrist,
 * index knuckle, pinky knuckle) that sets the face, and the handle line
 * through pinky knuckle → index knuckle, extended toward where the head sits.
 */
function drawGripGuide(surface: Surface): void {
  const lm = tracker.latest.landmarks;
  if (!lm) return;
  const { ctx, w, h } = surface;
  const at = (i: number) => ({ x: lm[i].x * w, y: lm[i].y * h });
  const wrist = at(WRIST);
  const index = at(INDEX_MCP);
  const pinky = at(PINKY_MCP);

  ctx.save();
  ctx.fillStyle = "rgba(255,168,92,0.22)";
  ctx.strokeStyle = "rgba(255,168,92,0.7)";
  ctx.lineWidth = Math.max(1, w * 0.004);
  ctx.beginPath();
  ctx.moveTo(wrist.x, wrist.y);
  ctx.lineTo(index.x, index.y);
  ctx.lineTo(pinky.x, pinky.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const dx = index.x - pinky.x;
  const dy = index.y - pinky.y;
  ctx.strokeStyle = "#FFA85C";
  ctx.lineWidth = Math.max(2, w * 0.012);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(pinky.x - dx * 0.35, pinky.y - dy * 0.35);
  ctx.lineTo(index.x + dx * 0.9, index.y + dy * 0.9);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- opponent paddle (online)

/** The other player's paddle, mirrored into our court. Drawn eased toward each update. */
let remotePaddle: PaddleState | null = null;
const remoteShown = { x: 0, y: ARRIVAL_HEIGHT };
let lastPaddleSentAt = 0;
/** ~30 updates a second — the rate their camera sees their hand anyway. */
const PADDLE_SEND_MS = 33;

/** Their court is ours turned 180° about the vertical: lateral and depth flip, height doesn't. */
function mirrorPaddle(theirs: PaddleState): PaddleState {
  const m = (v: { x: number; y: number; z: number }) => ({ x: -v.x, y: v.y, z: -v.z });
  return {
    visible: theirs.visible,
    x: -theirs.x,
    y: theirs.y,
    axes: theirs.axes && { x: m(theirs.axes.x), y: m(theirs.axes.y), z: m(theirs.axes.z) },
  };
}

function drawRemotePaddle(): void {
  const r = remotePaddle;
  if (!r) {
    scene.updateOpponentPaddle(0, 0, null, false);
    return;
  }
  // Updates arrive ~30×/s with network jitter; easing hides the steps.
  remoteShown.x += (r.x - remoteShown.x) * 0.5;
  remoteShown.y += (r.y - remoteShown.y) * 0.5;
  scene.updateOpponentPaddle(remoteShown.x, remoteShown.y, r.axes, r.visible);
}

function sendOurPaddle(paddle: ReturnType<typeof currentLocalPaddle>, now: number): void {
  if (!peer || now - lastPaddleSentAt < PADDLE_SEND_MS) return;
  lastPaddleSentAt = now;
  peer.sendPaddle({
    visible: paddle !== null,
    x: paddle?.x ?? 0,
    y: paddle?.y ?? 0,
    axes: paddle?.state === "tracked" ? orientation.axes() : null,
  });
}

// ---------------------------------------------------------------- buttons (phones have no Enter / Esc)

function rematch(): void {
  if (game?.match.phase !== "end") return;
  endScreen.hidden = true;
  game.requestRestart();
}

el<HTMLButtonElement>("end-again").addEventListener("click", rematch);
el<HTMLButtonElement>("end-menu").addEventListener("click", () => {
  if (playing) exitToMenu();
});
menuBtn.addEventListener("click", () => {
  if (playing) exitToMenu();
});

/**
 * Phones: the game needs landscape. Where the browser allows it (Android
 * Chrome) go fullscreen and lock to landscape; where it doesn't (iPhone),
 * the "turn your phone sideways" screen covers portrait instead. Has to run
 * synchronously inside the tap that starts play — browsers only allow
 * fullscreen from a user gesture.
 */
function goLandscape(): void {
  if (!matchMedia("(pointer: coarse)").matches) return;
  const lock = () => {
    const o = screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> };
    o.lock?.("landscape").catch(() => {});
  };
  const root = document.documentElement;
  if (!document.fullscreenElement && root.requestFullscreen) {
    root.requestFullscreen().then(lock).catch(() => {});
  } else {
    lock();
  }
}

// ---------------------------------------------------------------- keyboard

window.addEventListener("keydown", (e) => {
  // Typing in a text field shouldn't trigger shortcuts — but a focused lab
  // slider shouldn't trap Esc or D.
  const typing = e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLInputElement && e.target.type !== "range");
  if (typing) return;

  if (e.key === "Enter") rematch();
  if (e.key === "Escape" && playing) exitToMenu();
  if (e.key.toLowerCase() === "d" && playing) {
    debugEl.hidden = !debugEl.hidden;
    if (!debugEl.hidden) updateDebug(performance.now());
  }
});

// ---------------------------------------------------------------- paddle lab

const labPanel = el<HTMLElement>("lab-panel");
const labSliders = el<HTMLDivElement>("lab-sliders");
const labReadout = el<HTMLDListElement>("lab-readout");
const labHits = el<HTMLElement>("lab-hits");
const labStatus = el<HTMLElement>("lab-status");
const labFeed = el<HTMLButtonElement>("lab-feed");
const sliderRows = new Map<keyof PaddleSettings, { input: HTMLInputElement; value: HTMLElement }>();
let machine: BallMachine | null = null;
let labReadoutAt = 0;

function enterLab(): void {
  mode = "lab";
  playing = true;
  curtain.hidden = true;
  viewport.classList.add("lab");
  labPanel.hidden = false;
  scene.updateOpponentPaddle(0, 0, null, false);
  menuBtn.hidden = false;
  machine = new BallMachine();
  machine.reset(performance.now());
  labFeed.textContent = "Pause balls";
  hand.reset();
  orientation.reset();
  framePose = null;
  lastFrameAt = performance.now();
  buildLabPanel();
  requestAnimationFrame(labFrame);
}

function labFrame(now: number): void {
  if (!playing || mode !== "lab" || !machine) return;
  requestAnimationFrame(labFrame);
  try {
    labStep(now, machine);
  } catch (err) {
    reportFrameError(err, now);
  }
}

function labStep(now: number, m: BallMachine): void {
  const dt = Math.min((now - lastFrameAt) / 1000, 0.05);
  lastFrameAt = now;

  m.physics.localContactRadius = contactRadius();
  const paddle = currentLocalPaddle(now);
  // Same rule as the game: a paddle frozen in place after losing your hand can't hit.
  m.update(paddle && paddle.state !== "held" ? paddle : null, dt, now);

  scene.updateBall(m.physics.ball.pos);
  drawLocalPaddle(paddle);
  scene.render();
  renderSelfView();
  if (now - labReadoutAt > 150) updateLabReadout(now, paddle);
  if (!debugEl.hidden && now - debugUpdatedAt > 200) updateDebug(now);
  updateTabWarning(now);
}

function updateLabReadout(now: number, paddle: (Paddle & { state: string }) | null): void {
  labReadoutAt = now;
  if (!machine) return;
  labHits.textContent = `hits ${machine.hits} / ${machine.fed}`;
  const deg = (v: number) => `${v.toFixed(0)}°`;
  // Handle angle from vertical, + = leaning toward screen-right (world −x).
  const handleDeg = (Math.atan2(-orientation.handle.x, orientation.handle.y) * 180) / Math.PI;
  const rows: [string, string][] = [
    ["hand", paddle ? paddle.state : "not seen"],
    ["handle angle", paddle ? `${handleDeg >= 0 ? "+" : ""}${deg(handleDeg)}` : "—"],
    ["palm tilt", paddle ? deg(orientation.palmTiltDeg) : "—"],
    ["paddle tilt", paddle ? deg(orientation.paddleTiltDeg) : "—"],
    ["swing speed", paddle ? Math.hypot(paddle.vx, paddle.vy).toFixed(1) : "—"],
  ];
  labReadout.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const term = document.createElement("dt");
      term.textContent = k;
      const desc = document.createElement("dd");
      desc.textContent = v;
      return [term, desc];
    }),
  );
}

function buildLabPanel(): void {
  labSliders.replaceChildren();
  sliderRows.clear();
  let group = "";
  for (const spec of SETTING_SPECS) {
    if (spec.group !== group) {
      group = spec.group;
      const heading = document.createElement("p");
      heading.className = "lab-group";
      heading.textContent = group;
      labSliders.append(heading);
    }

    const row = document.createElement("div");
    row.className = "lab-row";

    const top = document.createElement("div");
    top.className = "lab-row-top";
    const label = document.createElement("span");
    label.textContent = spec.label;
    const right = document.createElement("span");
    const value = document.createElement("b");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "reset";
    reset.title = `Back to the default (${spec.format(DEFAULT_SETTINGS[spec.key])})`;
    right.append(value, reset);
    top.append(label, right);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.setAttribute("aria-label", spec.label);

    const help = document.createElement("p");
    help.textContent = spec.help;

    input.addEventListener("input", () => {
      setPaddleSetting(spec.key, Number(input.value));
      syncLabPanel();
    });
    reset.addEventListener("click", () => {
      setPaddleSetting(spec.key, DEFAULT_SETTINGS[spec.key]);
      syncLabPanel();
    });

    row.append(top, input, help);
    labSliders.append(row);
    sliderRows.set(spec.key, { input, value });
  }
  syncLabPanel();
}

function syncLabPanel(): void {
  const current = paddleSettings();
  for (const spec of SETTING_SPECS) {
    const row = sliderRows.get(spec.key);
    if (!row) continue;
    row.input.value = String(current[spec.key]);
    row.value.textContent = spec.format(current[spec.key]);
  }
}

labFeed.addEventListener("click", () => {
  if (!machine) return;
  machine.feeding = !machine.feeding;
  labFeed.textContent = machine.feeding ? "Pause balls" : "Feed balls";
});

el<HTMLButtonElement>("lab-reset").addEventListener("click", () => {
  resetPaddleSettings();
  syncLabPanel();
  labStatus.textContent = "Back to defaults.";
});

el<HTMLButtonElement>("lab-copy").addEventListener("click", async () => {
  const changed = changedSettings();
  const text = Object.keys(changed).length
    ? `Portal Ball paddle settings: ${JSON.stringify(changed)}`
    : "Portal Ball paddle settings: all defaults";
  try {
    await navigator.clipboard.writeText(text);
    labStatus.textContent = "Copied — paste it to me and I'll make these the defaults.";
  } catch {
    labStatus.textContent = text; // clipboard blocked: show it so it can be copied by hand
  }
});
