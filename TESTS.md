# Inkplainer — infinite canvas: test results

How the camera/world work was verified, and — just as importantly — what was
**not** verified and still needs a real device.

Run everything from the repository root:

```bash
npm install jsdom fake-indexeddb        # dev-only, not needed by the app
node tests/camera.test.mjs              #   131 checks
node tests/smoke.test.mjs               #   104 checks
node tests/animation.test.mjs           #    32 checks
```

Latest run (2026-10-18, Node v22.22.3):

| Suite | Checks | Result | What it exercises |
|-------|-------:|--------|-------------------|
| `tests/camera.test.mjs` | 131 | ✅ all pass | pure camera maths, no DOM |
| `tests/smoke.test.mjs` | 104 | ✅ all pass | the **real `index.html`** booted in jsdom |
| `tests/animation.test.mjs` | 32 | ✅ all pass | real `generate()` + playback on a hand-driven clock |
| **Total** | **267** | **0 failures** | |

The app itself needs none of this — jsdom and fake-indexeddb are dev-only and
are not shipped (they are git-ignored).

---

## 1. Verified by test

### `camera.js` — 131 assertions, no DOM
World↔screen↔stage transforms, clamp/lerp and all six easings, keyframe
sorting, `poseAtKeys` (including the `cut` transition), **geometric (log) zoom
interpolation**, `evalMotion` paths, `followPose` damping, `evalCamera`
(keyframes + follow + fallback), scene lookup, `fitStage` (including the new
`fits` flag), rect union/inflate and `fitRectPose`.

### `tests/smoke.test.mjs` — 104 assertions, real page
The actual `index.html` is parsed by jsdom with a recording canvas mock
(`tests/canvas-mock.mjs`) that logs every canvas call and **every bitmap the
page allocates**.

| Group | Proven |
|-------|--------|
| A. Boot | all four scripts parse and run with zero runtime errors |
| B. Viewport | default zoom 1 + centred camera ⇒ **old projects frame identically**; stage defaults to scale 1, offset 0 ⇒ **old project coordinates are unchanged** |
| C. Coordinates | `screen → world → screen` round-trips to < 1e-9 px |
| D. Pan/zoom | zoom keeps the pixel under the finger/cursor pinned (X and Y) |
| E. Layers | `layer.x/y` do **not** change when the camera pans or zooms; fit-all and centre-selection produce sane poses |
| F. Rendering | `renderViewport()` and an export-size render both run clean and issue `drawImage` + `setTransform` |
| G. Demo | the 3-scene demo builds 4 layers spread 4 370 world units apart, 6 camera keys, 4 scenes; the point moves monotonically; **no camera teleport** (largest 0.1 s step is 3.1 % of the whole path); zoom samples are positive, finite and free of seam discontinuities; follow is pre-configured but **off**, and enabling it does centre the point |
| H. No giant bitmap | 60 pan/zoom renders allocate nothing above the frame size; a 2 000 000-unit-wide world still gets a **720 × 1280 buffer** (scaled down, with `fits:false` reported); a 12 000-unit world still fits (`fits:true`) |
| I. Save/restore | camera, keys and scenes survive `inkSerializeWorld` → `inkRestoreWorld`; **a legacy snapshot with no camera data restores to a usable default** |
| J. Camera UI | nav/select tools, grid toggle, scrub, add/duplicate/delete key, add scene, go-to-scene, and the key/scene/follow lists actually render DOM |
| K. Export | `recordWebM` refuses to fake success without `MediaRecorder`; **the vendored `mp4-muxer` loads and exposes `Muxer` offline**; `recordMP4` fails with the honest message *"WebCodecs VideoEncoder is not available in this browser. Use WebM instead."*; PNG export runs clean |

### `tests/animation.test.mjs` — 32 assertions, real engine
`requestAnimationFrame`, `performance.now` and `setTimeout` are replaced with a
virtual clock, so frames are stepped deterministically.

| Group | Proven |
|-------|--------|
| B. Playback | `generate()` runs clean, builds 3 groups from the 3 drawable layers, picks a stage that is **never larger than the frame**, plays to completion, sets `state.done`, and the compositor issues `drawImage` + `setTransform` each frame |
| B. Timing | **1 s of wall clock = 1 s of movie time** at 30 fps (1.000 s) and at 60 fps (1.017 s) — the old per-frame stepping made a 60 Hz phone play the movie at double speed and made exports drift |
| C. Shared clock | the camera travels 150.9 world units in 1.33 s of timeline; at t = 0.5/2/4/6/8/10 s the camera converges onto the keyframed pose to **within 0.000 world units** — this is the invariant that makes an exported frame identical to a previewed frame |
| D. Export gate | `isExportAnimationComplete()` now waits for the camera timeline, and behaves exactly as before when there is no camera animation |

### Bugs the harness found and that are now fixed
1. `animations.js` — `tickOutlineFill` / `tickIllustFill` crashed with
   `Cannot read properties of undefined (reading 'x')` when a layer produced
   no perimeter points (empty or fully transparent layer). Both now skip to
   the fill phase.
2. `camera.js` — `fitStage()` now reports `fits`; `world.js` warns once when
   content is too large for the frame-sized buffer instead of silently
   clipping it.
3. `world.js` — MP4 no longer imports `mp4-muxer` from a CDN. It is vendored
   in `vendor/mp4-muxer.js` (MIT, v5.2.2), so the app makes **no network
   requests at all**.

---

## 2. Verified by static inspection only (read and reasoned about, not executed)

These are code paths the mock cannot exercise, or where the reasoning is
architectural rather than executed:

- **No double camera transform.** `grep setTransform` in `index.html` returns
  nothing; the only camera transform is applied by `world.js`
  (`applyCanvasTransform`), and the composites in `animations.js` wrap their
  drawing in `inkBeginWorld` / `inkEndWorld`.
- **Hand image placement on phone screens** — `drawHand` still receives canvas
  (offscreen) coordinates, and the hand canvas is a viewport overlay; the
  transform is applied once, by `inkDrawStage`.
- **Layer serialisation additions** (`kind`, `shape`, `fill`, `stroke`,
  `strokeWidth`, `radiusPct`, `motion`) are written by all three serialisers
  (`saveProject`, `_serializeState`, and the demo) and rebuilt in both
  `loadProject` and `_applySnapshot`. Old projects simply have no such keys and
  fall back to defaults.
- **DPR cap / memory on the target phone.** `MAX_VIEWPORT_PIXELS = 2 400 000`
  caps the backing store; a 720 × 1280 CSS viewport at DPR 3 would be
  8.3 Mpx, so the cap is doing real work. Not measured on hardware.
- **`willReadFrequently` / `touch-action: none`** on the visible canvases.
- **Export completion** now waits for `camTimelineDuration()`, so a camera move
  that outlasts the drawing no longer truncates the video.

---

## 3. NOT tested — needs a real browser on the target device

This is the honest part. **Nothing below has been observed running.** The
jsdom mock records canvas calls but never rasterises a pixel, so it cannot
tell you whether the picture is right — only that the code ran.

| Untested | Why it matters | How to check on the Infinix Hot 30 |
|----------|----------------|------------------------------------|
| **Does the drawing look right through the camera?** (hand, strokes, reveal blending, layer order) | the core of the app | open the demo, press Generate |
| **Hand alignment** — the hand must sit on the stroke tip, not beside it | easy to get wrong when a transform is introduced | watch any hand style during a draw |
| **Touch pan/zoom/pinch feel**; page must not scroll while panning | phone-only requirement | drag with one finger, pinch with two |
| **Grid and frame outline** drawn in screen space | decor only, must be crisp at any zoom | toggle ⌗ / ▭ |
| **MediaRecorder WebM export** | jsdom has no MediaRecorder | Export → WebM, then play the file |
| **MP4 via WebCodecs** | needs `VideoEncoder`; Chrome/Edge only, and **only over HTTPS or localhost** | Export → MP4 on a hosted HTTPS copy |
| **Real memory ceiling with 8 GB RAM at 1080 × 1920** | the DPR cap is reasoned about, not measured | watch for a crash on a long 1080p export |
| **Battery/thermal behaviour on a long export** | — | record a 30 s animation |
| **`pages/docs.html`** camera section | documentation | read it |

### What is honestly expected to be unfinished or rough

- Video export is **untested on hardware**. WebM depends on the browser's
  `MediaRecorder`; MP4 additionally needs `VideoEncoder` (WebCodecs), which
  browsers only enable in a secure context. On a phone served over plain HTTP
  on your LAN, **MP4 export will not work** — WebM should.
- Zooming very far out (below the stage's 0.05 minimum scale) will show a
  warning toast and clip content beyond roughly 14 000 world units from the
  content centre. Practically this only bites on absurdly large compositions.
- The demo's follow mode is shipped **configured but switched off**, because
  with it on the keyframed journey is overridden. Turn it on in the camera
  panel to see tracking.
- Rotation (`rot`) is implemented end to end but is only reachable by editing
  a keyframe's value; there is no rotation handle in the UI yet.

---

## 4. How the mock works (for anyone extending these tests)

`tests/canvas-mock.mjs` installs:

- a recording 2D context (transform stack, `drawImage` logging, `getImageData`
  returning blank data),
- `stats.canvases` — every canvas created, with its size,
- `stats.maxPixels` — the largest bitmap the page has ever allocated,
- `MockImage` with an async `onload`, `URL.createObjectURL`, and a real
  `CanvasRenderingContext2D` prototype (jsdom omits it, and the app polyfills
  `roundRect` onto it).

Because nothing is rasterised, outline detection finds **no content** — which
is why the playback test finishes in a handful of frames and why visual
correctness must be checked in a browser.
