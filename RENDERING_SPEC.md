# Whiteboard Studio — Rendering and Timing Specification

- **Status:** normative design target; renderer/exporter are not implemented yet.
- **Related contract:** [RECIPE_FORMAT.md](RECIPE_FORMAT.md), JSON Schema v1, and `examples/minimal-project-v1.json`.

## 1. One deterministic evaluator

The renderer must be a pure evaluation of project data at a requested time. Conceptually:

```text
renderAt(projectSnapshot, projectFrame, target, assetResolver) -> complete frame
```

It clears/reconstructs the target and evaluates all visible scenes, backgrounds, cameras, layers, objects, and drawing progress for that frame. It does not rely on prior frames, a mutable animation tick counter, or the order in which the playhead was visited. Rendering the same validated recipe, assets, viewport, and frame must produce the same pixels within documented platform/font rasterization tolerance.

### Playback and export clocks

- Persist timing as integer frame indices and rational frame rate `N/D` frames per second.
- Export is frame-stepped: request frame `n` directly, then submit it in order. Do not use `requestAnimationFrame`, timers, or `canvas.captureStream()` as the export clock.
- Preview may advance the playhead from monotonic elapsed time, but it converts that time to a frame position and calls the same evaluator. Seeking, pause/resume, reverse seeking, and looping reset no renderer state.
- At project time `n`, the ideal timestamp is `n × D/N` seconds. For an encoder using microseconds, compute `PTS_us(n) = round(n × 1,000,000 × D/N)` with integer-safe arithmetic. Frame order is `0 .. totalFrames-1`; the final frame duration is one frame interval.
- The scene schedule and total frame count are derived from scene order and outgoing transition durations as defined in the recipe format. There is no separately stored, potentially contradictory scene start time.

## 2. Scene and object evaluation order

For each requested global project frame `g`:

1. Derive each scene start `S[i]`: `S[0] = 0`; `S[i+1] = S[i] + duration[i] - outgoingOverlap[i]`, with `outgoingOverlap=0` for a cut and equal to the crossfade duration otherwise.
2. Select scenes whose active interval contains `g`: `[S[i], S[i] + duration[i])`. A valid v1 project has at most two active scenes. For an active scene, scene-local frame is `local = g - S[i]`.
3. Draw scene background and visible layers back-to-front. Layer order is `layer.order`; objects within a layer retain array order. A scene with a transition is composited with the adjacent scene using its evaluated transition weight.
4. For each object, skip it when outside `[startFrame, endFrame)` or when its base/stepwise evaluated visibility is false. Resolve base transform, object-local tracks (including boolean `visible` tracks), and then project-global continuity overrides in that order. Visibility tracks are hold/step only; they do not interpolate booleans. Apply drawing progress if present. Draw the complete object at its resolved transform.
5. Apply the scene camera to the composed scene, then blend scene outputs if a crossfade is active. This preserves each scene's own camera/background while allowing globally linked camera tracks to stay continuous.

If two adjacent scenes crossfade for `d` frames, the incoming scene starts at `S[next] = end[outgoing] - d`. During the overlap, `u = clamp((g - S[next])/d, 0, 1)`. The outgoing weight is `1-u`, incoming weight is `u`. At the first overlap frame, `u=0`; at the outgoing exclusive end, the outgoing scene is gone and the incoming scene is fully visible. Validation rejects transitions that would create a three-scene overlap.

Object and camera tracks use scene-local frame indices. Audio and continuity tracks use global project frames. Do not implicitly reinterpret one as the other.

## 3. Keyframe interpolation and property precedence

- An object starts from its base `transform`. Each track replaces only its named property; untracked properties keep their base values.
- A camera starts from its base `position`, `zoom`, and `rotationDegrees`; scene-local camera tracks replace their named properties.
- Project continuity tracks override the corresponding object/camera property for matching IDs at the global project frame. A global track affects every active scene instance that shares the target `continuityId`, including both copies during a crossfade.
- Keyframes are strictly increasing. The interpolation/easing value on key `i` is applied between key `i` and `i+1`; before the first or after the last key, hold the endpoint value. A track must have at least two keys.
- `linear`: `t`; `hold`: `0` until the next key; `easeIn`: `t³`; `easeOut`: `1-(1-t)³`; `easeInOut`: `4t³` for `t<0.5`, otherwise `1-(-2t+2)³/2`. Clamp `t` to `[0,1]`.
- Interpolate position and scale component-wise; opacity linearly then clamp to `[0,1]`. `visible` is step/hold-only and takes the keyed boolean state. Rotation uses the shortest angular delta in `[-180°,180°]` in v1. Scale remains positive; mirroring is a later explicit property, not negative scale.
- A frame at a keyframe uses that key's exact value. Export never accumulates a previous frame's interpolated state.

## 4. Coordinate transforms and camera

Artboard coordinates use upper-left origin, X right, Y down. Positive rotation is clockwise. For a local geometry point `p`, normalized object anchor `a`, object anchor position `q`, scale `S`, object rotation `R(o)`, camera world position `c`, camera zoom `z`, camera rotation `R(c)`, artboard-to-viewport fit `k`, and viewport center `v`:

```text
p_world  = q + R(o) · S · (p - a_pixels)
p_screen = v + k · z · R(c) · (p_world - c)
```

`a_pixels` is the normalized anchor multiplied by the object's local bounds. `k` is a preview/export-target fit factor; it does not mutate the project. In a composition-sized export, the target viewport maps exactly to project canvas dimensions (no phone letterbox). In the preview, letterbox/pan/zoom is editor viewport state and is excluded from the rendered project image unless explicitly exported as a camera property.

Use the same transform order for hit testing and rendering; selection handles operate in screen space but map edits back through the inverse transform. Transform order must be covered by unit tests for non-uniform scale, rotation, anchor, zoom, and camera rotation.

## 5. SVG stroke-reveal rendering

### Supported geometry and security

- A `path` object uses its path data directly. A sanitized SVG object is parsed locally and reduced to supported vector paths with stable source IDs/order. Simple `path`, line, polyline, polygon, rect, circle, and ellipse geometry may be converted to paths during import.
- Never execute scripts, external `<image>`/`href` references, external stylesheets, entities, or arbitrary CSS. Unsupported filters, masks, text layout, and complex SVG constructs are reported at import time. They are not silently treated as compatible strokes.
- Prefer SVG geometry measurement (`getTotalLength()` and `getPointAtLength()`) when supported by the packaged WebView. Feature-test it; cache measurements by asset hash and path geometry. A bounded path-flattening fallback may be used for supported path commands if native SVG measurement is unavailable.
- For a true reveal, draw only the prefix of each measured path: use SVG stroke-dash offset or an equivalent clipped polyline whose visible length equals the evaluated prefix. Do not fade in the complete source image. A filled shape's outline is revealed first; its fill appears when its fill path completes unless a separate fill-reveal is authored.

### Multiple paths, order, and time allocation

- Explicit `drawing.pathOrder` takes precedence over SVG payload `data.pathOrder`; if neither exists, use stable source order. A path list must be a valid permutation of the revealable path IDs. Invalid IDs generate a validation error, not a different order.
- Split disjoint subpaths (separate `M` segments) into independent stroke segments. There is no artificial line between them.
- Let ordered segment lengths be `L[i]`, total length `L`, elapsed draw frames be `e = localFrame - object.startFrame`, and draw duration `d`. Overall path-distance budget is `B = clamp(e/d,0,1) × L`. Earlier paths receive their full length first; the active path receives `clamp(B - sum(previous L), 0, L[i])`. This gives deterministic, length-proportional drawing time. If duration is shorter than the number of paths, several paths can finish within one frame; there is still no missing/extra frame or random order.
- The draw starts with zero revealed distance at `e=0`, reaches the full path at `e=d`, then remains complete until object end. A drawing duration must fit inside the object's active interval. The first visible sample may include the hand at the path start even when revealed distance is zero.

### Drawing hand

- At each frame, identify the active ordered path and arc-length position `s`. Sample `P(s)` and a nearby point/tangent from the same path. If the local derivative is near zero, use a short finite-difference sample, then the last non-zero tangent; never use an undefined angle.
- Transform both point and tangent through object and camera matrices. Place the hand image so its normalized `tipAnchor` lands on the transformed point. Rotate its tip direction to the transformed tangent plus `rotationOffsetDegrees`. Scale the hand to a consistent project-space size and then apply camera/viewport transforms.
- The hand follows the drawing tip; it is not anchored to the viewport or object center. It is hidden when drawing is complete, drawing is disabled, or no compatible path is active.
- At a subpath/path break, do not draw a connecting stroke. Hide the hand while repositioning and show it at the next start. On the final stroke, keep it at the final tip only through the final active drawing sample, then hide it; do not leave it parked in the finished illustration.
- A missing hand asset only removes the hand. A missing/unsupported path invokes the declared fallback. `instant` displays the complete object from its start frame with no hand; `clipReveal` uses an explicitly non-stroke clip reveal when possible. Neither fallback claims that actual paths were drawn.

### Other reveal modes

- `clipReveal` is an image/shape viewport mask (v1 default direction: left-to-right) and is labeled as a clip reveal. It is not an SVG stroke reveal.
- `typewriter` reveals text by Unicode grapheme clusters in reading order; it is not handwriting. If the platform lacks a grapheme segmenter, use a bundled deterministic segmentation fallback or report the feature unsupported—never split surrogate pairs.
- Image assets without compatible paths use their authored clip behavior or appear instantly according to fallback. They are not traced using a fixed hand position.

## 6. Scene transitions and continuous motion

- `cut` changes scenes at the derived boundary with no overlap.
- `crossfade` uses a linear progress over its integer frame duration and composites complete scene frames. Camera, background, and all visible objects belong to their scene during the blend.
- Project-global `continuityTracks` can animate an object's world position/scale/rotation/opacity across scenes. Instances with the same `continuityId` use the same global value on both sides of a crossfade. If both scenes contain a copy, the transition blends the copies; validation/editor warnings should prevent accidental double-strength opacity or mismatched geometry.
- Camera continuity tracks similarly target a global camera property. When a character and camera move together, author both tracks in the same global frame space. Do not infer camera movement from object movement.
- If no continuity track exists, each scene's local transform/camera is evaluated independently. A cut may intentionally jump. The editor should show a continuity warning only when the user linked an object but left the intended track boundary uncovered.

## 7. Audio clock and synchronization

Audio clip positions are project-global. Let video frame rate be `N/D`, output audio sample rate `Rout`, source sample rate `Rsrc`, output sample index `m`, and clip start frame `a`. Output sample time is `m/Rout` seconds; clip time begins at `a×D/N`. When a sample falls inside the clip, the source position is:

```text
sourcePosition = sourceStartSample + (m/Rout - a×D/N) × Rsrc
```

Evaluate this mapping from absolute timestamps using rational/integer-safe arithmetic, not by adding a rounded samples-per-video-frame increment. Resample/interpolate from the source at that position. If `loop` is true, wrap the source position from the asset end back to `sourceStartSample`; otherwise source samples past the asset duration are silence. Apply clip gain and deterministic frame-count-based fades, sum clips in float PCM, and apply a documented clipping/limiting policy. V1 does not time-stretch. Audio end time is compared with the final video-frame end time in export validation.

Android decode, PCM mixing, AAC encoding, and muxing are platform adapters. If an asset codec cannot be decoded locally, report an unsupported audio asset and preserve the project. The same recipe must still preview and export video-only when audio is absent or the user chooses mute.

## 8. Export frame pipeline

1. Validate the project/asset graph, output dimensions, frame rate, codec, estimated duration, free storage, and device limits before creating output.
2. Render project frame `n` deterministically at the requested composition/export resolution.
3. Transfer one frame (or a tightly bounded number) to the native encoder path. Never hold the whole movie as bitmaps. The exact WebView-to-encoder transfer must be proven on the target device before this stage is considered feasible.
4. Submit the frame with its exact presentation timestamp, drain encoded output without blocking the UI thread, and stream samples to a private temporary MP4. When enabled, decode/mix audio and mux its timestamped AAC samples.
5. Report progress from `n/totalFrames`, support cancellation between frames, close encoder/muxer in every exit path, validate the produced container/frame count/duration, then offer a SAF destination.
6. On any failure or cancellation, remove partial files, retain the editable project, and show a concise cause plus retry guidance. Never report success before muxer close and validation.

The initial target is 1280 × 720 at 30 fps. A 720p RGBA frame is approximately 3.52 MiB and a 1080p frame approximately 7.91 MiB, before WebView/texture/codec buffers. Stream frames, release decoded bitmaps promptly, and measure process PSS and thermal behavior on the Infinix Hot 30. MP4 export remains **planned and unverified** until a real device output is decoded and its timestamps/audio are checked.

## 9. Determinism tests and fallbacks

- Render frames in forward, reverse, and shuffled seek order and compare the same frame outputs.
- Check monotonic path reveal: each frame shows no less path length than the prior frame, reaches exactly 100%, has no gap-connecting line, and places the hand anchor on the measured tip within a defined pixel tolerance.
- Compare expected boundary samples around cuts and crossfades, and compare camera/object matrix output against known coordinate fixtures.
- Compare rational video PTS and audio sample positions across 24/30/60 fps and `30000/1001`.
- Golden tests pin fonts/assets and browser/runtime where possible; allow only documented rasterization tolerance, not state or timeline differences.
- Cache eviction, renderer recreation, app pause/resume, WebView process loss, and export cancellation must not mutate recipe data or alter a later seek result.
- For excessive complexity, downsample imported raster preview, simplify only within an explicit user-visible import option, or disable the unsupported reveal with an error. Do not silently change timing/order or claim a full path animation when using a static fallback.
