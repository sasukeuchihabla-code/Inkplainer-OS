# Whiteboard Studio Project Recipe Format

- **Schema version:** 1
- **Status:** proposed contract; parser, validator, migrations, and runtime use are not implemented yet.

A Whiteboard Studio project is a portable, editable recipe—not a rendered video and not a UI-state dump. The same recipe is the source for editing, preview, autosave, reopen, and export. The canonical v1 JSON Schema is [`schema/whiteboard-studio-project-v1.schema.json`](schema/whiteboard-studio-project-v1.schema.json); a complete valid fixture is [`examples/minimal-project-v1.json`](examples/minimal-project-v1.json).

## 1. Container and versioning

### Portable project bundle

The user-facing `.wbs` file is a ZIP container with:

```text
project.json              # envelope and project recipe
assets/<asset-id>.<ext>   # local images, SVGs, audio, or fonts
```

`project.json` is the manifest. Every asset is addressed by a stable `id` plus a bundle-relative `path`, byte length, MIME type, and SHA-256. No absolute device path, `content://` URI, network URL, or external SVG reference is part of a portable recipe. Projects without assets can also be represented as a standalone JSON recipe.

The archive reader must stream entries to bounded temporary storage; it must not unzip untrusted content directly into an arbitrary filesystem path. Reject path traversal (`..`), absolute paths, duplicate names/IDs, symlinks, excessive expanded size/compression ratio, hash mismatches, and unexpected file/MIME combinations before loading the document.

### JSON envelope

Every recipe begins with:

```json
{
  "format": "whiteboard-studio-project",
  "schemaVersion": 1,
  "project": { }
}
```

`schemaVersion` is an integer and is independent of the application version. A newer unsupported version must be rejected with a recoverable message; it must never be opened as v1 and overwritten. Migrations are explicit, ordered, deterministic transformations from `n` to `n+1`. Preserve the original bundle and create a migrated working copy; do not rewrite the only copy during open.

## 2. Coordinate and timing conventions

### Composition coordinates

- `project.canvas.width` and `.height` are the virtual artboard dimensions in project units (1 unit = 1 artboard pixel). Origin is the upper-left; +X points right, +Y points down.
- Object `transform.position` is the object-local anchor position in scene/world coordinates. `transform.anchor` is normalized to the local bounds: `(0,0)` upper-left, `(0.5,0.5)` center. The path/SVG `viewBox` defines local geometry coordinates.
- Object scale is a positive X/Y multiplier; rotation is in degrees, clockwise on the y-down canvas. Opacity is `[0,1]`.
- A scene camera uses world-space `position`, positive `zoom`, and clockwise `rotationDegrees`. Preview fits the artboard into the available viewport and letterboxes; viewport scaling is not written back to project transforms.
- Layer `order` is ascending back-to-front. Within a layer, the `objects` array is also back-to-front. Hidden layer/object and zero-opacity values do not draw but remain editable.

### Time

The project frame rate is a rational value `{ numerator, denominator }`; for example `30/1` or `30000/1001`. V1 semantic validation requires an effective rate between 1 and 60 fps. Persisted edit times are integer frame indices, never accumulated floating-point seconds.

- A scene has `durationFrames` and occupies `[sceneStart, sceneStart + durationFrames)` in project-frame space.
- Each scene's object `startFrame`, `endFrame`, object keyframe `frame`, and camera keyframe `frame` are **scene-relative**. An object is active on `[startFrame, endFrame)`. A key at `endFrame` may specify its terminal transform but is not itself an additional displayed frame.
- Audio clip `startFrame`/`endFrame` and `continuityTracks[].keyframes[].projectFrame` are **project-global**.
- Scene starts are derived, not duplicated in saved data. A cut starts the next scene at the previous scene's end. A crossfade of `d` frames starts the next scene `d` frames before the outgoing scene ends. V1 validation forbids overlapping adjacent transitions that would require three simultaneous scenes.
- Project frame count is `lastSceneStart + lastScene.durationFrames`. Export renders frames `0` through `totalFrames - 1`, inclusive. No `timeInSeconds` field is accepted for animation timing.
- Scene/object timing and track bounds are cross-validated against scene duration and computed project duration; JSON Schema alone cannot enforce all cross-references.

### Keyframes

Tracks name one property and contain at least two strictly increasing frame indices. A keyframe's interpolation applies from that key to the next. `linear`, `hold`, `easeIn`, `easeOut`, and `easeInOut` are defined; values before/after a track hold its first/last key. Object `visible` tracks are step/hold-only booleans: the keyed state applies until the next key. Position values use `{x,y}` vectors within ±100,000 project units; scale values are positive vectors in `[0.001,100]`; rotation values are within ±3600 degrees; opacity is `[0,1]`; camera zoom is `[0.01,100]`. Rotation follows the shortest angular path in v1; a full-spin interpolation mode can be added later. Keyframe values are numeric, `{x,y}` vectors, or booleans according to the targeted property.

## 3. Recipe entities

### Project and canvas

`project` contains a stable ID, name and ISO-8601 UTC timestamps, canvas width/height, rational frame rate, local asset definitions, reusable symbols, ordered scenes, project-global continuity tracks, and project-global audio clips.

V1 accepts canvas dimensions from 16 to 4096 units per side. Runtime/device validation also applies a pixel-count, frame-rate, total-duration, and import-size budget; schema-valid input is not automatically safe to decode/render on a phone.

### Assets

An asset definition contains:

- `id`, `kind` (`image`, `svg`, `audio`, or `font`), `mimeType`, bundle-relative `path`, `sizeBytes`, and lowercase SHA-256.
- Raster image metadata: `pixelWidth`, `pixelHeight`.
- Audio metadata: source `sampleRate`, `channels`, and `durationSamples`.
- SVG dimensions come from its validated `viewBox`; fonts may be embedded for consistent offline text rendering.

Asset IDs are project-wide unique. The resolver validates that every reference points to an existing asset of the right kind. Missing/corrupt assets remain visible as repairable placeholders and cause an actionable warning; they must not silently disappear or be removed from the recipe.

### Reusable symbols

`project.symbols` holds named reusable vector components. A v1 symbol is a local viewBox and ordered list of editable SVG path primitives. Scene objects of `kind: "symbol"` reference a symbol ID and may animate their instance transform. For example, a stick figure can be built from separate paths and reused as a symbol. V1 does not define a skeletal/pose rig; opening/editing a symbol edits its paths, while ungrouping can create independent scene objects.

### Scenes, transitions, and backgrounds

Scenes contain a stable ID, name, duration, background, camera, ordered layers, and an outgoing transition. V1 supports:

- `cut`: no overlap.
- `crossfade`: deterministic linear alpha blend over `durationFrames`.

The last scene uses `cut`. Wipes, motion-matched transitions, and transition effects requiring arbitrary shader code are future extensions. Backgrounds may be a solid color, a linear gradient, or a referenced local image.

### Layers and objects

A layer has an ID, name, unique integer order, visibility, opacity, and ordered objects. Objects share:

- `id`, `name`, `kind`, scene-relative `startFrame` and exclusive `endFrame`.
- Base `transform` (`position`, `scale`, `rotationDegrees`, `opacity`, normalized `anchor`), local property tracks, and a base `visible` flag. Object tracks may animate position, scale, rotation, opacity, or stepwise visibility.
- Optional `continuityId`, used to bind scene instances to one project-global object continuity track.
- Optional `drawing` configuration for a path reveal, clipped/masked reveal, or text typewriter reveal.

V1 object kinds and editable payloads:

| Kind | Payload | Drawing behavior |
|---|---|---|
| `path` | SVG `d`, viewBox, fill/stroke style | True stroke reveal via SVG path geometry |
| `shape` | Rect, ellipse, or line plus fill/stroke | May be converted to a path for outline reveal; otherwise use a named clip reveal |
| `text` | Text, font/style, alignment, line height, spacing | Typewriter/clip reveal in v1; true pen-stroke text requires font-to-path conversion and is not implied |
| `image` | Local image asset ID and fit mode | Clip/mask reveal; a raster image is not represented as a traced path |
| `svg` | Sanitized local SVG asset ID and optional explicit path order | True stroke reveal only for supported path elements; unsupported constructs use the explicit fallback or remain static |
| `symbol` | Reusable symbol ID | Sequential path reveal using symbol path order |

`drawing.durationFrames` is the number of scene-relative frames allocated from the object's `startFrame` to progressively reveal the content. The object remains visible in its completed state through `endFrame`. An absent drawing configuration means the object appears at `startFrame`. Stroke reveal is never simulated by fading in a completed image.

A drawing hand references a local image asset and normalized tip anchor; its tip is placed at the active path point and its angle follows the transformed path tangent plus an offset. If a hand or compatible path is unavailable, the hand is hidden and the configured visual fallback is used. It must not be pinned at a fixed screen coordinate.

### Cross-scene continuity and camera

Scene-local object/camera tracks are convenient for independent scenes. `project.continuityTracks` provides a project-global override for an object `continuityId` or camera property. Matching object instances in adjacent scenes share the same global value during their scene intervals (including a crossfade overlap), so a character can cross a scene boundary without a position jump. Continuity-track values use the project/world coordinate system; camera movement can be coordinated with object movement through a camera continuity track.

The property targeted by a continuity track overrides the corresponding local/base property while the track is active. Other properties continue to use their local/base values. IDs must match a scene object or camera target, and track values must cover the intended boundary; missing coverage is reported rather than extrapolated unpredictably.

### Audio

Audio clips are project-global and reference an `audio` asset. `startFrame`/`endFrame` define the clip's timeline interval; `sourceStartSample` identifies the trim point in that asset's native sample rate. `gain` is linear amplitude; fade lengths are frame counts. V1 does not time-stretch: playback uses the source's native rate, truncates at the clip end, and yields silence after source samples end when `loop` is false. When `loop` is true, the source interval from `sourceStartSample` through the asset's final sample repeats at its native rate until `endFrame`. Audio mixing/export resamples deterministically to the chosen output sample rate and uses presentation timestamps from the same rational project clock. Muted, missing, or unsupported audio creates an explicit warning; it does not corrupt video frames.

## 4. Validation and migration rules

Validation has three layers:

1. **Container validation:** archive limits, no unsafe paths/symlinks, correct root entries, no duplicate paths, and all asset bytes remain inside the bundle.
2. **Schema validation:** validate `project.json` against the exact versioned JSON Schema before constructing editor state. Reject unknown required structural fields rather than guessing.
3. **Semantic/runtime validation:** project-wide uniqueness and references; asset kind/hash/content; bounded width × height and total pixels; rational frame-rate range; scene transition duration and no triple overlap; frame/keyframe ordering and bounds; drawing duration; valid path IDs; continuity references; audio sample bounds; and device-specific resource budgets.

On invalid input, return a structured list of errors with a JSON Pointer-like path, message, and severity. Do not partially load malformed state and then autosave it. A recoverable import may create a separate repair copy only after the user sees what is missing or unsupported.

For a future schema version, leave the source untouched and offer a copy or explain the required app update. Migrations are tested with saved fixtures for every supported historical version. A failed migration preserves the original project and writes no replacement. Unknown optional metadata may be preserved in a namespaced extension field in a future schema version; v1's strict schema does not accept arbitrary extension fields.

## 5. Complete minimal valid v1 example

This is the full recipe stored in [`examples/minimal-project-v1.json`](examples/minimal-project-v1.json). It has one scene and one real SVG path that reveals progressively over 30 frames; it uses no external assets.

```json
{
  "format": "whiteboard-studio-project",
  "schemaVersion": 1,
  "project": {
    "id": "project-minimal-v1",
    "name": "Minimal Stroke",
    "createdAt": "2026-10-19T12:00:00Z",
    "updatedAt": "2026-10-19T12:00:00Z",
    "canvas": {
      "width": 1280,
      "height": 720,
      "colorSpace": "srgb"
    },
    "frameRate": {
      "numerator": 30,
      "denominator": 1
    },
    "assets": [],
    "symbols": [],
    "scenes": [
      {
        "id": "scene-1",
        "name": "One stroke",
        "durationFrames": 90,
        "transitionOut": { "type": "cut" },
        "background": { "type": "solid", "color": "#FFFFFF" },
        "camera": {
          "position": { "x": 640, "y": 360 },
          "zoom": 1,
          "rotationDegrees": 0,
          "tracks": []
        },
        "layers": [
          {
            "id": "layer-1",
            "name": "Drawing",
            "order": 0,
            "visible": true,
            "opacity": 1,
            "objects": [
              {
                "id": "path-1",
                "name": "Curved stroke",
                "kind": "path",
                "startFrame": 0,
                "endFrame": 90,
                "visible": true,
                "continuityId": "stroke-one",
                "transform": {
                  "position": { "x": 0, "y": 0 },
                  "scale": { "x": 1, "y": 1 },
                  "rotationDegrees": 0,
                  "opacity": 1,
                  "anchor": { "x": 0, "y": 0 }
                },
                "tracks": [],
                "drawing": {
                  "mode": "strokeReveal",
                  "durationFrames": 30,
                  "fallback": "instant"
                },
                "data": {
                  "viewBox": { "x": 0, "y": 0, "width": 1280, "height": 720 },
                  "path": "M 200 360 C 400 160 600 560 800 360",
                  "fill": "none",
                  "stroke": "#172033",
                  "strokeWidth": 12,
                  "lineCap": "round",
                  "lineJoin": "round"
                }
              }
            ]
          }
        ]
      }
    ],
    "continuityTracks": [],
    "audioTracks": []
  }
}
```

## 6. Compatibility and v1 non-goals

V1 is intentionally small enough to validate and render deterministically. It provides a versioned foundation for editable text, paths, shapes, images/SVG, symbols, object keyframes, scenes, crossfades, camera motion, and audio timing. It does not imply that these features already exist in the application.

Unsupported v1 content must be reported specifically: animated raster/GIF timeline decoding, arbitrary SVG filters/masks/scripts/external resources, arbitrary Bézier rig animation, text converted into authentic pen strokes without path outlines, complex blend modes, unsupported audio codecs, 4K phone export, and cloud AI. New capabilities require schema versioning or a clearly backward-compatible optional field and round-trip tests.
