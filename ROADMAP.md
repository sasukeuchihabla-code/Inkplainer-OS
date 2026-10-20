# Whiteboard Studio — Implementation Roadmap

**Status:** M0 documentation is complete; M1 diagnostic Android scaffold and CI workflow are added, with build/device acceptance still pending. Milestones are gates, not date estimates. Complete a gate's acceptance tests before expanding scope; do not generate the full future product in one pass.

## Milestone map

| ID | Milestone | Dependencies | Status |
|---|---|---|---|
| M0 | Feasibility, architecture, recipe contract | None | Complete for this phase; schema and sample validation passed locally |
| M1 | Buildable offline Android shell | M0 | Scaffold/workflow added; CI APK build and Infinix Hot 30 checks pending |
| M2 | Native video-export feasibility spike | M1 | Not started; early architecture gate |
| M3 | Versioned project model and safe local storage | M1 | Not started |
| M4 | Phone-first static editor vertical slice | M3 | Not started |
| M5 | Deterministic timeline, SVG drawing, scenes, and camera | M4 | Not started |
| M6 | Audio, expanded assets, reusable symbols, and recovery hardening | M3–M5 | Not started |
| M7 | Integrated production export | M2, M5, M6 | Not started |
| M8 | Optional prompt-to-animation assistance | M3–M6 | Not started |
| M9 | Device qualification and release hardening | M1–M8 | Not started |

## M0 — Phase 0/1 feasibility and architecture

**Scope:** inspect the existing repository and actual build environment; select an architecture; document modules, storage, recipe, rendering/export, tests, risks, and milestones. No editor implementation or APK work is included.

**Deliverables:** `README.md`, `ARCHITECTURE.md`, `RECIPE_FORMAT.md`, `RENDERING_SPEC.md`, `ROADMAP.md`, machine-readable v1 JSON Schema, and minimal sample recipe.

**Acceptance:**

- Existing code and limitations are identified without replacing the browser prototype.
- Local APK feasibility and the free build fallback are reported with inspected evidence.
- The example parses as JSON and validates against the v1 JSON Schema; known-invalid cases are rejected.
- Every persisted time field and coordinate convention is unambiguous.
- No claim is made that Android packaging or video export has been tested.

## M1 — Buildable Android shell and phone test path

**Dependencies:** M0.

**Scope:** create the smallest Kotlin Android project, Gradle wrapper, and public-repository GitHub Actions debug-APK workflow. A single packaged HTML page is enough; do not build editor controls yet. Load it from APK assets using `WebViewAssetLoader`, set up portrait layout, and keep runtime content local. **Scaffold status:** these files now exist; the workflow and actual APK remain unverified because this sandbox has no JDK/Android SDK.

**Tests and acceptance criteria:**

1. `./gradlew assembleDebug` succeeds on the GitHub-hosted standard runner and stores a downloadable debug APK artifact. Keep workflow permissions read-only; do not publish secrets or release credentials.
2. Install that APK on an Infinix Hot 30 running Android 13. Cold launch succeeds in airplane mode, the packaged page appears within 5 seconds on the test phone, and the app remains usable after a process restart.
3. Confirm no remote page, font, script, analytics call, or CDN request is required. A local-only test page and all referenced assets load from the APK.
4. Verify portrait sizing, WebView touch handling, Back behavior, and recreation after Activity pause/resume. Record device model, Android/WebView versions, APK size, startup time, and any permissions.
5. The current sandbox need not produce the APK locally. Do not mark M1 complete until a real APK from CI is installed and exercised on the target phone.

**Exit decision:** if local asset loading or the phone-first WebView shell fails, compare a native screen for the editor shell before adding application features.

## M2 — Video export feasibility spike (do early)

**Dependencies:** M1.

**Reason for early placement:** export is the highest architectural risk. Prove frame capture and native encoding before investing in a large editor.

**Scope:** a disposable/small test screen renders a deterministic moving path/shape at requested frame indices. Prototype the least-complex frame hand-off to Android and encode using `MediaCodec`/`MediaMuxer`. Compare WebView frame capture plus EGL/encoder input with a native rendering adapter fed by the same recipe; keep only the option that proves acceptable on-device. Do not add a large FFmpeg package just to make the prototype pass.

**Tests and acceptance criteria:**

- While offline, generate an MP4 with 150 ordered 1280 × 720 frames at 30 fps (five seconds), with the moving path visibly changing at expected frame indices.
- Decode the file on-device using Android media APIs; confirm H.264 video track, 150 frames, monotonic timestamps corresponding to rational 30 fps, and duration within one frame of five seconds.
- Add a short generated/test audio track only after video-only succeeds; confirm the AAC track is present and audio/video end times differ by no more than one frame in the test fixture.
- Progress advances from rendered frames; cancellation releases encoder/muxer and removes the partial file. Simulated codec/storage errors preserve source data and display a recoverable error.
- Record render/encode wall time, peak process PSS, temporary disk usage, and surface/bridge latency on the Infinix Hot 30. One frame plus a bounded queue only; no full movie in memory.

**Exit decision:** if a deterministic frame can be rendered but WebView-to-encoder transfer cannot meet memory/latency gates, either add a native Canvas renderer using the same recipe/timeline contract or defer MP4 export with an explicit limitation. Do not label M2/M7 as passed from a desktop browser or emulator-only test.

## M3 — Project model, recipe validation, and safe storage

**Dependencies:** M1; use M2 findings where they affect export-only limits.

**Scope:** implement v1 JSON Schema validation, semantic validation, recipe serialization, command-based document mutations, archive import/export, private local storage, autosave, crash recovery, and v1 fixtures. No rich UI is required beyond a small project list/open/save test screen.

**Tests and acceptance criteria:**

- The checked-in sample validates. Tests reject invalid format/version, malformed geometry/time, duplicate IDs, missing/wrong-kind asset references, invalid crossfades, wrong path order, unsafe SVG/archive paths, corrupt hashes, and configured size-limit violations with field paths.
- Round-trip save → close process → reopen reproduces canonical recipe data and every asset SHA-256. Exporting/importing `.wbs` preserves IDs and content.
- Autosave is debounced, serialized, and atomic. Injected save failures leave the document marked dirty and preserve the last valid on-disk copy. Killing the app during a write recovers either the prior committed revision or a complete newer revision, never a partial recipe.
- Unsupported newer schema versions are not overwritten. A migration fixture for every supported version round-trips through the migration chain while the original remains available.
- Missing assets appear as explicit repairable placeholders; opening an invalid project never silently drops content.

## M4 — Phone-first static editing vertical slice

**Dependencies:** M3.

**Scope:** project home/create/rename; portrait canvas preview; one scene; layers/objects; select, move, scale, rotate, and edit properties; create text, path, and basic shapes; import a local image and supported SVG; undo/redo; save status and autosave. Keep timeline timing static in this milestone.

**Tests and acceptance criteria:**

- In airplane mode, a tester can create a project, draw a path, add/edit text and a shape, import a local image, undo/redo each change, save, force-close, and reopen without loss.
- At 1280 × 720 artboard size, fit-to-screen and touch transforms are correct within 2 project units at a known test point; no accidental preview gestures trigger property controls.
- Every empty list, invalid/missing asset, low-storage, save failure, and unsupported SVG has a visible recovery action.
- Primary controls have at least 48 dp touch target; one-handed portrait workflows are tested on the target phone. No desktop-only layout or horizontal page overflow.

## M5 — Deterministic animation and multi-scene timeline

**Dependencies:** M4.

**Scope:** integer-frame timeline; object visibility; per-object drawing durations; transform keyframes; SVG path measurement and true stroke reveal; tangent-following drawing hand; scene management; cuts/crossfades; camera tracks; project-global continuity tracks; preview seek/playback.

**Tests and acceptance criteria:**

- The same recipe renders pixel-identical golden frames (within documented rasterization tolerance) when sought forward, backward, or in shuffled order.
- Track interpolation tests cover exact keyframes, hold/ease variants, rotation wrap, opacity bounds, and camera/object inverse transforms.
- SVG reveal progresses monotonically by measured path length; first/middle/final frames match path-length fixtures; no connecting line appears between separate subpaths; hand tip stays within 2 px of the measured tip at 720p.
- Two-scene cuts/crossfades have correct boundary frame weights and no unintended triple-scene overlap. A linked object/camera moves across a scene boundary without a position discontinuity greater than 1 project unit.
- Preview play/pause/seek stays within one frame of the requested position and does not mutate project data.

## M6 — Audio, asset safety, symbols, and reliability

**Dependencies:** M3–M5.

**Scope:** supported audio import/decode and global placement, sample-accurate rational timing, gain/fades, local background assets, reusable path symbols, import safeguards, recovery/backup UI, and performance fallbacks for complex vectors.

**Tests and acceptance criteria:**

- Audio timestamp tests cover 24/30/60 fps and 30000/1001, trim offsets, fade boundaries, mixed tracks, silence beyond source samples, and end-time comparison.
- Safe-import tests fuzz duplicate IDs, compressed/expanded limits, path traversal, malformed XML, external SVG references, giant paths, missing assets, and truncated media. No imported content can execute script or fetch a URL.
- Symbol instances render and save/reopen with shared definition plus independent transforms; editing a symbol is explicit and undoable.
- Repeated open/close/import/seek does not show monotonic memory growth; every decode cache is bounded and evictable.

## M7 — Integrated offline export

**Dependencies:** M2, M5, M6.

**Scope:** native export adapter driven by the shared deterministic renderer; output selection and SAF hand-off; video-only then AAC mux; progress/cancel/recovery and output verification. Start at 720p/30 only. Gate 1080p/longer duration on device results.

**Tests and acceptance criteria:**

- Export a known 10-second multi-scene fixture offline and compare selected decoded output frames against preview golden frames.
- Confirm exact expected frame count, increasing PTS, correct transition timing, audio track duration, and A/V sync within one frame; validate output with Android decoder after muxer close.
- Cancel at multiple progress points and simulate low storage/codec failure; partial output is removed and project remains intact.
- On the Infinix Hot 30, export a 60-second 720p/30 fixture without OOM or crash, keep peak app process PSS below the provisional 350 MiB target, and complete within five minutes without severe thermal shutdown. Record actual results; revise limits if hardware evidence requires it.
- Save to a user-selected SAF destination; reopen/play the final file in an Android media player. Until this passes, MP4 export remains unverified and must not be advertised as available.

## M8 — Optional prompt/script-to-animation assistant

**Dependencies:** M3–M6.

**Scope:** start with a deterministic local rule-based script-to-scene draft (script beats, simple text/path placeholders, duration templates). Optional external provider adapters can be added only as explicit plugins; no provider is needed to edit projects.

**Tests and acceptance criteria:**

- Prompt/script results are new, editable drafts validated against the same schema/semantic validator as imported files.
- Unsupported requests (complex camera choreography, unavailable assets, unsupported audio) are reported before accepting the draft.
- Existing open project remains byte-for-byte/canonical-data unchanged unless the user deliberately imports or replaces content.
- Offline mode works with no provider configured. Any cloud mode names data sent, network requirement, provider terms, and user-configured costs; no free/offline claim is made without verification.

## M9 — Qualification, accessibility, and release hardening

**Dependencies:** M1–M8.

**Scope:** supported-device statement, migration policy, crash/error handling, screen reader and keyboard/accessibility checks, touch target review, final privacy/security review, and repeatable release artifact process.

**Tests and acceptance criteria:**

- Full offline create/edit/save/reopen/preview and, only if M7 passes, video export on the target Infinix Hot 30 with recorded Android/WebView versions.
- Repeat recipe migrations and safe-import suite on every release candidate. Verify no runtime CDN/network request is needed by core flows.
- A release build can be reproduced from the documented Gradle wrapper and CI workflow; build number, schema support, limitations, and known issues are documented.
- No feature is described as implemented/verified unless its acceptance test passed on the stated device/build.

## Cross-cutting testing strategy

| Area | Test layer | Required evidence |
|---|---|---|
| Recipe parsing, schema, migrations | Node/JVM unit tests as appropriate | Valid/invalid fixtures and migration snapshots |
| Persistence and asset integrity | Model + Android storage tests | Save/reopen and interrupted-write round trips with hashes |
| Timeline/interpolation/scene scheduling | Pure deterministic unit tests | Fixed timestamps, boundary cases, randomized seek order |
| SVG reveal/hand/camera | Geometry unit + renderer golden tests | Measured path progress, tangent/anchor tolerance, transform matrices |
| Audio | Pure rational math tests + Android codec tests | Sample/PTS mapping and decoded end-time checks |
| Import security | Fuzz/property tests + Android instrumentation | Archive traversal, XML expansion, size-limit and corruption cases |
| Export | On-device instrumentation/manual validation | Decoded frame count/PTS, audio sync, cancellation, PSS, thermal results |
| Phone UX/accessibility | Device walkthrough | Portrait/one-handed flow, screen-reader labels, touch targets |

## Risk register

| Risk | Severity | Mitigation / gate |
|---|---:|---|
| WebView frame capture cannot feed native encoder efficiently | High | M2 prototype before full editor; compare native renderer using the same recipe contract; defer export rather than fake it |
| Android/System WebView feature and version variation | High | Feature probes, local fallback, test on the named phone and update its WebView before release qualification |
| Legacy editor is monolithic and desktop-oriented | High | Preserve it; extract only isolated reusable algorithms behind tests; do not wrap the old page unchanged |
| SVG import complexity/security and inconsistent path measurement | High | Strict local sanitizer and element allowlist, path-count limits, deterministic metrics, explicit fallback/errors |
| Memory, thermal throttling, and low storage during export | High | Stream bounded frames, use preflight checks, show cancellation/progress, measure on target, constrain initial export |
| Corrupt saves, asset paths, and schema evolution | High | Atomic writes, retained last-good copy, hashes, strict validation, immutable migration fixtures |
| Local Android build toolchain absent in coding sandbox | Medium | Public GitHub Actions standard runner for APK builds; download and install artifact on phone; retain reproducible wrapper |
| Optional AI becomes mistaken for free/offline capability | Medium | Separate module, explicit provider/configuration/network/cost disclosure, validated draft only |
| Third-party/native codec packaging increases size or licensing burden | Medium | Use Android platform codecs first; avoid FFmpeg until a specific unmet requirement and license review justify it |

## Exact next implementation task

**Close M1 by running and exercising the scaffold already added:** run `.github/workflows/android-debug.yml` on the active branch, download its debug-APK artifact, and install it on the Infinix Hot 30 in airplane mode. Record cold-start, touch, permission, WebView-version, and offline-origin results. This sandbox cannot run the Android build locally and has no phone attached, so M1 is not complete until those external checks pass. Do not add editor controls or export before then. If M1 passes, the next implementation gate is M2's five-second deterministic `MediaCodec`/`MediaMuxer` proof.
