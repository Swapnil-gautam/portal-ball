# Portal Ball

Two pages, two different jobs:

| Page | What it is |
| --- | --- |
| **[game.html](game.html)** | **The actual game.** Practice vs an AI opponent, or play a real match against someone else over the internet (real WebRTC video + data channel — two separate machines, two separate cameras). |
| **[index.html](index.html)** | The Spike 0 diagnostic harness — measures camera→pose→render latency and tests whether a person can time an intercept through that pipeline. Not the game; a tool for debugging the tracking pipeline if something feels off. |

If you just want to play, open **game.html**. The rest of this doc is split the same way.

## Playing

```bash
npm install
npm run dev
```

Open the URL it prints, then:

- **Practice vs AI** — one camera, a bot opponent. Good for testing your swing without needing a second person.
- **Play a friend, anywhere** — the real mode. One of you clicks **Host** and gets a 5-letter code and an invite link; send either to the other player. They open the link (or type the code) and tap **Join** — that's it. Video and gameplay then run directly between your two browsers, so it works across any distance.

**How to play:** stand 1.5–2.5 m back from your camera, hold a hand up. Hold still inside the highlighted zone for half a second to serve. Swing to hit the ball — swing speed sets power, tilting your palm up/down aims the shot. First to 7 wins; press Enter after a match to go again, Escape to leave.

### How the code connects you

Two browsers can't connect directly until they've swapped connection details. PeerJS's free public matchmaking server does that swap: the host registers under the 5-letter code, the guest asks for it, and the server introduces them. It never sees the video or the game — those go straight between the two players. If that public server is ever down, joining fails until it's back.

### If the connection won't go through

Most home networks connect fine with just STUN (built in, via Google's public servers). Some networks — strict corporate firewalls, certain mobile carriers — need a TURN relay; a free public one (Open Relay Project) is included as a fallback, but it's a best-effort community service neither of us operates, so it can occasionally be slow or unavailable. If a connection consistently fails, try a different network (mobile hotspot instead of office wifi is a common fix).

## Diagnostics (Spike 0)

The original latency/tracking measurement tool. Kept around because it's genuinely useful for figuring out *why* something feels off in the game — is it your camera's frame rate, the filter's lag, or your network — rather than just that it does.

Spike 0 exists to answer two questions before any game gets built:

1. **What is the true end-to-end latency** of `camera → pose → render` on this machine?
2. **Can a person reliably intercept a target** arriving on a fixed clock through that pipeline?

## Run it

```bash
npm install     # postinstall copies the wasm runtime and fetches the model
npm run dev
```

Then click **Enable camera**. Everything stays local — no upload, no network calls at
runtime. The wasm runtime and the 7.8 MB model are served from `public/` rather than a
CDN, deliberately: this is a measurement tool, and a CDN is a variable it doesn't need.

Stand 1.5–2.5 m back, framed from roughly the waist up, with the room lit from the front.

## The three modes

| Mode | Key `1`/`2`/`3` | What it's for |
| --- | --- | --- |
| **Track** | 1 | Baseline sanity. Skeleton, paddle, swing vector, frame-loss rate. The dashed ghost is the *unfiltered* palm position — the gap during a fast swing is filter lag you can see. |
| **Latency probe** | 2 | Flashes the screen when your hand crosses a line. Feeds the 240 fps measurement below. |
| **Intercept** | 3 | Targets arrive on a fixed clock. Hit rate and timing error decide whether the premise holds. |

`R` resets the current run. **Copy CSV** exports whatever the mode has logged.

## Measuring true end-to-end latency

The browser cannot see sensor exposure, USB transfer, compositor queueing, or panel
response. The panel's **Subtotal** is therefore a *floor*, not an answer — it is what we
can prove, and the real number is always higher. To get the real number you have to leave
the browser:

1. Open the **Latency probe** and set the trigger line where a swing would naturally cross it.
2. Put a **physical marker** in the camera's view at the height that trips the line — a
   strip of tape on a shelf edge, a book standing on end. It has to be visible in your
   recording.
3. Frame a second camera (a phone at **240 fps**) so it sees **both your hand at the marker
   and the monitor** in the same shot. A slightly off-axis position usually gets both.
4. Record. Move your hand up through the marker briskly, ten or more times. Move fast —
   a slow crossing makes the trigger instant ambiguous.
5. Scrub the footage. For each crossing, count frames from the one where your hand passes
   the marker to the one where the screen goes white.

At 240 fps each frame is **4.17 ms**. Take the median of ten crossings, not the best one.

The on-screen frame counter and the strobe square (top right, alternating every display
frame) let you pin the exact display frame the flash landed on, which is useful when the
video frame rate and the display refresh rate beat against each other.

**Subtract the floor from your measurement.** The remainder is capture + display latency —
the part the design doc has to assume rather than measure, and the part you cannot optimise
away in software.

## Reading the panel

- **Filter lag** is measured, not assumed: the raw and filtered signals are cross-correlated
  and the best-fitting shift is reported, with its correlation `r`. It reads "move to
  measure" when the hand is too still to have a phase to measure. Treat `r < 0.9` as noise.
- **Capture latency** appears only if the browser exposes `captureTime` on the video frame
  metadata. Chromium usually does for camera sources; if it says *not exposed*, that term
  folds into what the 240 fps method measures.
- **Inference p95** matters more than the mean. A 12 ms mean with a 40 ms p95 will feel worse
  than a steady 20 ms.

## Exit criteria

Spike 0 passes if, at settings that don't visibly jitter:

| Measure | Target |
| --- | --- |
| Frame loss (Track, normal room light) | < 2% |
| Inference p95 | < 25 ms |
| Filter lag | < 40 ms |
| True end-to-end (240 fps method) | < 200 ms |
| Intercept hit rate @ 1100 ms / 0.075 w | > 80% |
| Intercept timing SD | < 60 ms |

A poor hit rate with a *tight* timing SD means the spatial mapping is off and is fixable.
A poor hit rate with a *wide* timing SD means people cannot time this pipeline, and the
ball needs to get slower or the hit window wider before Spike 1 is worth starting.

## What this deliberately does not do

No pose model, so the strike zone is the whole frame rather than being normalized to
shoulder width — that normalization is Spike 1 work, and it needs `PoseLandmarker`.
No networking, no video compositing, no art. Those are Spikes 2, 3, and later.

## Layout

```
src/
  main.ts           bootstrap, mode routing, instrument panel
  tracker.ts        camera + MediaPipe, emits PaddleSample per camera frame
  oneEuro.ts        One-Euro filter and the cross-correlation lag estimator
  draw.ts           shared canvas helpers, palette
  stats.ts          rolling window, formatters
  modes/            track / latency / intercept
scripts/            wasm copy, model fetch
```

`public/mediapipe/` and `public/models/` are generated — `npm run setup` rebuilds them.
