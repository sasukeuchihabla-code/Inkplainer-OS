# Whiteboard Studio — Architecture

- **Status:** proposed architecture; M1 diagnostic Android shell built successfully in CI, target-phone test pending; product editor not implemented
- **Updated:** 2026-10-20 (environment evidence captured 2026-10-19)
- **Repository:** `Inkplainer-OS`; the existing browser editor is retained as a source of reusable ideas and assets.

## 1. Decision summary

Build a **local-first Android application with a small Kotlin host and a locally packaged WebView editor/rendering core**. The WebView is an implementation choice, not the product boundary: the saved project model, timeline evaluator, and renderer must remain separate from the UI and Android bridge.

- **Android host (Kotlin):** application lifecycle, portrait window, Android file pickers, private project storage, import/export hand-off, and a future native video-encoding adapter.
- **Packaged editor (HTML/CSS/JavaScript):** phone-first editor UI, timeline controls, and a deterministic Canvas 2D/SVG renderer. Every required file ships inside the APK; the editor must start without a network connection.
- **Project/model and timeline core:** plain, versioned project data plus deterministic functions. They do not import DOM, WebView, or UI code.
- **Platform adapters:** storage, media decode, and video encoding behind narrow interfaces. Optional AI is an isolated adapter and is not required for any core workflow.

Use AndroidX `WebViewAssetLoader` to serve APK assets through its reserved local origin rather than enabling broad `file://` access. Android documents this as a same-origin-compatible way to load packaged content [1](https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader). The local content is still bundled with the APK; this URL is not a remote website dependency.

### Why this is the best evidence-based first architecture

The repository already contains substantial browser-based Canvas animation code (`index.html`, `animations.js`, and local hand images), but it is a desktop-first, tightly coupled prototype—not an Android app. Replacing the renderer with Kotlin immediately would discard the most relevant existing work and require a large renderer port before proving the product. A packaged WebView lets the project selectively extract and test useful algorithms while gaining Android lifecycle, document-picker, and storage integration.

This does **not** mean embedding the current `index.html` unchanged. It contains a desktop-only narrow-screen notice, UI/renderer globals, remote Google Fonts, and an MP4 muxer loaded from jsDelivr. Its IndexedDB save data is not the new versioned recipe format. The first editor should be a small, responsive, offline-safe implementation; reuse from the old editor must be deliberate and covered by tests.

| Option | Advantages | Costs/risks | Decision |
|---|---|---|---|
| Native Kotlin/Compose UI and native renderer | Best native touch/accessibility integration; direct Android storage and media APIs | Rebuild the existing JS/Canvas algorithms; SVG-path and renderer parity work; no Android toolchain is present in this sandbox | Reconsider if WebView touch, accessibility, or rendering tests fail; not the initial path |
| Browser/PWA only | Maximum reuse of current app; simplest web deployment | Browser storage/export capability varies; current code has remote runtime dependencies and a desktop layout; not a self-contained Android package | Not selected as the product delivery target |
| **Kotlin host + packaged WebView editor** | Reuses browser rendering concepts while providing a self-contained APK, SAF and native media APIs; web content can be tested independently | WebView version/performance vary by device; native/JS boundary and frame capture require careful testing | **Selected, with an early on-device export feasibility gate** |

## 2. Phase 0 environment evidence

Inspected on 2026-10-19 in the coding sandbox:

- Debian 12, Linux x86-64; 2 visible CPUs, 3.8 GiB RAM reported, about 20 GiB free disk at inspection.
- Available: Node.js 22.22.3, npm 10.9.8, Python 3.11.2, Git, and `gh`.
- Not found: Java/JDK, Gradle or Gradle wrapper, Android SDK, `adb`, Android emulator/AVD tools, NDK, Docker/Podman, or FFmpeg. No connected Android device or emulator is exposed through this environment.
- Repository baseline: approximately 57 MiB, no `package.json`, Gradle project, wrapper, or test suite. The current editor is a large HTML/JavaScript browser application with local image assets.
- HTTPS checks to the permitted GitHub, GitHub API, codeload, and npm registry hosts returned HTTP 200. Sandbox egress is allow-listed; do not assume Google's Android SDK/Maven hosts are available here.
- The GitHub repository was public at inspection. A standard GitHub-hosted runner is a practical **build-only** fallback for a public repository; GitHub documents standard runner usage for public repositories as free [2](https://docs.github.com/en/billing/concepts/product-billing/github-actions). The M1 Gradle shell and debug workflow have since been added. CI run [39465491250](https://github.com/sasukeuchihabla-code/Inkplainer-OS/actions/runs/39465491250) successfully assembled and uploaded the debug APK; this is build evidence only, not an install or phone test.

**Conclusion:** APK compilation is **not possible with the currently installed local toolchain**. This is an environment limitation, not evidence that Android packaging is infeasible. The GitHub Actions build workflow has produced a debug APK artifact in run [39465491250](https://github.com/sasukeuchihabla-code/Inkplainer-OS/actions/runs/39465491250). The remaining M1 gate is to install and exercise that artifact on the target phone. Keep CI independent of runtime app behavior; cloud CI cannot replace the local phone test.

## 3. Application modules and dependency rules

Planned repository boundaries (names are logical; implementation may use a smaller directory count):

| Module | Responsibility | Must not depend on |
|---|---|---|
| `android-app` | Kotlin entry point, lifecycle, portrait shell, WebView configuration, permissions, Android navigation, SAF intents | Editor implementation details beyond a versioned bridge contract |
| `editor-ui` | Phone-first project home, canvas, object/property sheets, scene list, compact timeline, playback, undo/redo, save/error status | Android framework APIs or persistence internals |
| `project-model` | Recipe types, JSON Schema validation, semantic validation, commands, serialization, migration | DOM, WebView, Android UI, renderer state |
| `timeline-core` | Frame/scene mapping, keyframe and transition evaluation, camera/object state at a requested time | Playback history, wall-clock timers, UI |
| `renderer` | Canvas/SVG draw operations from a project snapshot and requested time; path metrics and hand pose | Editor controls, storage implementation, global mutable animation state |
| `asset-manager` | Local archive parsing, image/SVG/audio import validation, hashes, decoded asset cache and missing-asset errors | External URLs, renderer-specific UI |
| `storage` | Transactional project/autosave records, project bundles, recovery, schema migration | Browser-only `localStorage` as the authoritative store |
| `android-media` | Android image/audio decode and future `MediaCodec`/`MediaMuxer` export adapter | Web UI or remote codec/muxer service |
| `assistant` (future, optional) | Local rule-based generation and optional explicit provider adapters; produces a draft recipe | Direct mutation/replacement of the open project; assumptions that a provider is free/offline |

Dependency flow:

```text
editor-ui ──> project-model ──> timeline-core ──> renderer
    │               │                              ▲
    │               ├──> storage / asset-manager ──┘
    │               └──> recipe validator
    └── typed bridge ──> android-app ──> Android SAF / private files / media adapter

assistant (future) ──> recipe validator ──> new user-reviewed draft
```

The renderer receives an immutable project snapshot, a frame/time, a viewport or export target, and an `AssetResolver`. It returns/draws a complete frame. It must not read UI controls or depend on what was rendered before. The preview and export call the same evaluator and visual renderer.

### UI state and editing model

- Keep the document as the source of truth. Selection, open panels, playback state, and viewport pan/zoom are transient UI state and are not silently mixed into animation time.
- Make edits through named commands (`AddObject`, `MoveObject`, `SetKeyframe`, `DeleteScene`, etc.). Commands produce reversible changes for undo/redo and mark the project dirty.
- Use a small, explicit state store; avoid a heavyweight state framework until interaction complexity demonstrates a need.
- The interface is designed for portrait touch: canvas first, compact scene/timeline strip, contextual bottom sheets/property panels, large touch targets, and explicit empty/error states. A desktop panel layout must not simply be scaled down.
- Playback uses a monotonic clock only to advance the playhead. Seeking and rendering always evaluate the requested timeline time from the recipe.

### WebView boundary and security

- Load only the packaged editor origin (for example, `https://appassets.androidplatform.net/assets/index.html`) through `WebViewAssetLoader`; reject navigation away from the local origin.
- Disable file-URL universal access and arbitrary file access. Keep JavaScript/native communication narrow and schema-validated; expose typed operations, not a general-purpose `addJavascriptInterface` object.
- For large binary frame transfers, never base64-encode a full frame. Benchmark a native capture path or a bounded binary channel before committing to an export bridge.
- Do not include remote scripts, web fonts, CDN imports, analytics, or an app runtime server. The core app should not request the Android `INTERNET` permission. Optional AI/network access, if ever added, requires explicit configuration and separate consent.
- Probe WebView features at runtime and keep a Canvas 2D/SVG fallback. WebCodecs is not a required WebView feature.

## 4. Project state, storage, and assets

The recipe in [RECIPE_FORMAT.md](RECIPE_FORMAT.md) is independent of the view hierarchy. A `.wbs` project bundle contains a JSON manifest/recipe and local asset files. Asset references are project-relative, integrity-checked paths; they are never remote URLs or temporary device paths.

- Keep working projects and autosaves in app-private storage. Use a transactional database or equivalent indexed metadata plus content-addressed asset files; write a new project revision to a temporary file, flush it, and atomically replace the active revision only after success.
- Debounce autosave (initial target 500–1000 ms after an edit), serialize writes, flush on explicit Save and lifecycle pause, and retain a recoverable last-good revision. A failed save leaves the project dirty and visibly reports the error.
- Use Android Storage Access Framework (`ACTION_OPEN_DOCUMENT` / `ACTION_CREATE_DOCUMENT`) for user-selected import/export destinations; do not request broad storage access for ordinary project work.
- Import bundles in a bounded streaming pass. Reject path traversal, duplicate IDs, unsupported MIME/content mismatches, excessive expanded sizes, malformed archives, and unsafe SVG constructs. Verify hashes before using assets. Never evaluate SVG scripts or external references.
- Missing assets create a visible placeholder and repair action. They do not cause a project to be silently rewritten or discarded.
- Initial configurable safety budgets: up to 100 MiB per imported file, 200 MiB total expanded project assets, 4096 × 4096 source pixels per raster, and a strict SVG path/element limit. These are conservative starting limits, not guarantees; tune using device tests. Downsample decoded previews to the artboard/viewport and avoid holding original, decoded, and export copies simultaneously.

## 5. Animation and rendering boundaries

`project-model` owns serializable values; `timeline-core` owns time interpretation; `renderer` owns pixels. Coordinate and timing rules are normative in [RECIPE_FORMAT.md](RECIPE_FORMAT.md) and [RENDERING_SPEC.md](RENDERING_SPEC.md).

- All saved timing uses integer frames and rational frame rate. Scene object/keyframe times are scene-local; audio and continuity-track times are project-global.
- A frame is evaluated by `renderAt(project, projectFrame)`. No setup/tick accumulator is allowed to affect the result.
- SVG stroke reveal is a geometry operation, not opacity. Only path-capable content gets a drawing-hand stroke reveal. Raster assets have a clearly named clip/mask reveal instead.
- Renderer caches are disposable and keyed by content hash plus relevant geometry. Cache loss must not affect determinism or saved documents.
- Initial target composition is 1280 × 720 at 30 fps. The first export experiment is 720p/30; 1080p and longer projects are gated on measured memory and thermal results. The target phone's 8 GB RAM is system-wide; it is not an app memory budget.

## 6. Video-export decision and feasibility gate

### Candidate comparison

| Approach | Advantages | Risks for this product | Decision |
|---|---|---|---|
| WebView `MediaRecorder` / canvas stream | Low integration effort; browser may expose WebM | Capture is tied to real-time scheduling; background throttling, codec/container support, audio sync, and frame exactness vary by WebView/device | Keep only as a possible prototype/fallback; do not promise offline MP4 |
| WebCodecs plus JavaScript MP4 muxer | Can encode deterministic frames in capable browsers | API availability is not guaranteed in Android System WebView; muxer packaging and codec support add variables. The current editor downloads its muxer from a CDN, which is unsuitable for offline launch | Do not select as the native product's required export path |
| **Android `MediaCodec` + `MediaMuxer`** | On-device APIs; MP4/WebM muxing is available through Android APIs, with device codec capabilities discoverable at runtime [3](https://developer.android.com/reference/android/media/MediaCodec) [4](https://developer.android.com/reference/android/media/MediaMuxer) | Device encoders vary; WebView-to-encoder frame transfer is an unresolved performance/complexity risk; audio mixing and cancellation need implementation | **Preferred native export target, explicitly unverified until a device prototype produces and decodes a file** |
| FFmpeg bundle | Broad codecs and mature filter/mux operations | Large per-ABI native binaries, licensing choices (including LGPL/GPL implications), app size, security updates, and maintenance exceed the current minimal-dependency budget | Not selected for v1; revisit only if Android APIs fail a concrete requirement |

Android's encoder input `Surface` is intended for hardware-accelerated rendering, commonly through EGL/OpenGL; the WebView renderer cannot simply be assumed to write directly to it. Therefore M2 in [ROADMAP.md](ROADMAP.md) must compare a small number of frame-transfer prototypes (for example, WebView frame capture plus EGL upload versus a native Canvas renderer fed by the same recipe). Select only after measuring on the Infinix Hot 30.

### Export constraints and acceptance gates

- First target: MP4/H.264, 1280 × 720, 30 fps; AAC audio only after video-only encoding is validated. Probe codec availability and supported sizes/bitrates before starting; show a useful error instead of claiming unsupported formats.
- Render one requested frame at a time. A 1280 × 720 RGBA bitmap is about 3.52 MiB; 1920 × 1080 is about 7.91 MiB. Do not retain a full frame sequence in memory. Stream frames and encoded samples to a temporary file.
- Frame `n` gets presentation timestamp `round(n × 1,000,000 × fpsDenominator / fpsNumerator)` microseconds. Export frames are ordered `0 .. totalFrames-1`; no frame is dropped or duplicated by a wall-clock loop.
- Mix/encode audio to a temporary track with timestamps derived from the same project time base; mux only after encoder output formats are available. Validate actual decoded duration, frame count/timestamps, and A/V end-time delta.
- Keep temporary output in app-private cache; only offer the final SAF destination after muxer close and validation. Cancellation and all failures remove the partial output, preserve the project, and leave export retryable.
- Export is foreground-visible in the first release, with progress and cancellation. Background continuation/foreground-service behavior is a later decision after Android 13 notification and lifecycle tests.
- Thermal throttling, free storage, encoder errors, and process death are normal failure cases. Initial 720p duration/quality limits remain configurable and should be communicated before export.

**Status:** no Android APK has been compiled, no export pipeline has been implemented, and no MP4 has been produced or validated by this project. The API choice is a plan gated by an on-device proof, not a delivered feature.

## 7. Optional AI boundary

The editor remains fully useful with no AI provider configured. The first assistant can be local, rule-based script-to-scene scaffolding. Any cloud provider is optional, separately named, explicitly enabled, and must state network/data/cost requirements before use. The pipeline is: interpret → draft scene/object recipe → validate schema and semantic constraints → show unsupported content and warnings → open as a separate editable draft. It never overwrites the current project. No API key, paid service, or remote renderer is part of core editing, preview, save/reopen, or export.

## 8. Quality strategy

- Pure unit tests for schema validation, migrations, timeline mapping, interpolation, path reveal, camera/object transforms, transitions, and audio timestamp math.
- Property-based or generated tests for sorted/invalid keyframes, scene overlaps, missing assets, archive path traversal, and malformed SVG/JSON.
- Save/reopen round-trip tests that compare canonical recipe data and asset hashes.
- Renderer golden-frame tests at fixed timestamps; compare preview and export frame output from the same project fixture.
- Android instrumentation on the actual Infinix Hot 30 for offline cold start, SAF import/export, touch usability, WebView process recovery, memory, battery/thermal behavior, and end-to-end MP4 decode.
- Never mark device compatibility or video export as verified based only on emulator or desktop browser tests.
