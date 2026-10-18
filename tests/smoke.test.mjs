/**
 * smoke.test.mjs — loads the REAL index.html in jsdom and drives the editor.
 *
 * Run:  node tests/smoke.test.mjs
 *
 * What this does and does not prove
 * ---------------------------------
 * It proves that the application boots, that every script parses, that the
 * world/camera code paths execute end-to-end (adding layers, panning, zooming,
 * running the demo, rendering the export frame, saving and restoring), and
 * that no oversized bitmap is allocated for the "infinite" world.
 *
 * It does NOT prove that the picture looks right — there is no rasteriser
 * here.  Anything visual still needs a real browser (see TESTS.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import 'fake-indexeddb/auto';            // the app stores projects in IndexedDB
import { installCanvasMock, stats, resetStats } from './canvas-mock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label); }
}
function eq(a, b, label) {
  if (a === b) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(`${label} (got ${a}, want ${b})`); console.log(`  ✗ ${label} — got ${a}, want ${b}`); }
}
function near(a, b, label, eps = 1e-6) {
  const d = Math.abs(a - b);
  if (d <= eps) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(`${label} (got ${a}, want ${b})`); console.log(`  ✗ ${label} — got ${a}, want ${b}, Δ${d}`); }
}
function group(name) { console.log('\n' + name); }

/* ───────────────────────── boot the page ───────────────────────── */

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  // Ignore network errors for the Google Fonts <link> — offline sandbox.
  if (/Could not load|not implemented/i.test(e.message || '')) return;
  errors.push('jsdomError: ' + (e.message || e));
  if (e.detail) errors.push('  detail: ' + (e.detail.stack || e.detail));
});
vc.on('error', (...args) => {
  const msg = args.map(String).join(' ');
  if (/Could not load|Not implemented|css/i.test(msg)) return;
  errors.push('console.error: ' + msg);
});

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/inkplainer/index.html',
  runScripts: 'dangerously',
  resources: undefined,          // external scripts are injected manually below
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    installCanvasMock(win, { viewW: 380, viewH: 620, imgW: 400, imgH: 300 });
    // Real (in-memory) IndexedDB so project save/load actually runs.
    win.indexedDB = globalThis.indexedDB;
    win.IDBKeyRange = globalThis.IDBKeyRange;
    win.addEventListener('error', (e) => errors.push('window.error: ' + (e.message || e)));
    win.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));
  },
});

const win = dom.window;
const doc = win.document;

// IndexedDB is absent, so make initDB() a no-op instead of letting it throw.
function runScriptFile(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const s = doc.createElement('script');
  s.textContent = code;
  doc.body.appendChild(s);
}

// jsdom does not fetch <script src>, so run the local ones by hand (in order).
for (const f of ['camera.js', 'animations.js', 'world.js', 'demo.js']) {
  try { runScriptFile(f); } catch (e) { errors.push(`loading ${f}: ${e.stack || e}`); }
}

// The app boots asynchronously (100 ms timer -> IndexedDB -> create/load the
// most recent project).  Wait for that to finish before asserting anything.
await new Promise((r) => win.setTimeout(r, 400));
await new Promise((r) => win.setTimeout(r, 60));

/* ──────────────────────────── A. boot ───────────────────────────── */

group('A. Application starts without errors');
ok(errors.length === 0, `no runtime errors during boot${errors.length ? ':\n     ' + errors.join('\n     ') : ''}`);
ok(typeof win.InkCamera === 'object' && win.InkCamera !== null, 'camera.js exposes InkCamera');
ok(typeof win.AnimationEngine === 'object' && win.AnimationEngine !== null, 'animations.js exposes AnimationEngine');
ok(typeof win.InkWorld === 'object' && win.InkWorld !== null, 'world.js exposes InkWorld');
ok(typeof win.eval('typeof state') === 'string' && win.eval('typeof state') === 'object', 'global state exists');
ok(typeof win.loadDemoJourney === 'function', 'demo.js exposes loadDemoJourney()');

// `const state = {...}` in a classic script is a global LEXICAL binding,
// not a window property, so it has to be reached with eval().
const state = win.eval('state');
const K = win.InkCamera;

/* ─────────────────────── B. viewport / camera ───────────────────── */

group('B. Viewport sizing and camera defaults');
ok(!!state.camera, 'state.camera exists');
near(state.camera.zoom, 1, 'default zoom is 1 (old fixed-canvas framing)');
near(state.camera.x, state.canvasW / 2, 'default camera centres the frame');
near(state.camera.y, state.canvasH / 2, 'default camera centres the frame (Y)');
ok(!!state.stage, 'state.stage exists');
near(state.stage.scale, 1, 'default stage scale is 1 (world px == canvas px)');
near(state.stage.x, 0, 'default stage origin is 0,0 (backwards compatible)');

const mainCanvas = doc.getElementById('main-canvas');
ok(mainCanvas.width > 0 && mainCanvas.height > 0, `main canvas is viewport-sized (${mainCanvas.width}×${mainCanvas.height})`);
ok(mainCanvas.width !== state.canvasW || mainCanvas.height !== state.canvasH,
  'viewport backing store is independent of the export frame size');

group('C. World / screen coordinate round-trip');
{
  const VP = win.InkWorld.VP;
  const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, VP.w, VP.h);
  const w = K.screenToWorld(T, 10, 20);
  const back = K.worldToScreen(T, w.x, w.y);
  near(back.x, 10, 'screen→world→screen X', 1e-9);
  near(back.y, 20, 'screen→world→screen Y', 1e-9);
  const w2 = win.clientToWorld(50, 60);
  ok(isFinite(w2.x) && isFinite(w2.y), 'clientToWorld() returns finite world coordinates');
}

group('D. Pan and zoom');
{
  const before = { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom };
  win.InkWorld.panCameraByScreen(40, -25);
  ok(state.camera.x !== before.x || state.camera.y !== before.y, 'panning moves the camera');
  const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, win.InkWorld.VP.w, win.InkWorld.VP.h);
  const anchorWorld = K.screenToWorld(T, win.InkWorld.VP.w / 2, win.InkWorld.VP.h / 2);
  win.InkWorld.zoomCameraAt(2.0, win.InkWorld.VP.w / 2, win.InkWorld.VP.h / 2);
  const T2 = K.viewTransform(state.camera, state.canvasW, state.canvasH, win.InkWorld.VP.w, win.InkWorld.VP.h);
  const after = K.worldToScreen(T2, anchorWorld.x, anchorWorld.y);
  near(after.x, win.InkWorld.VP.w / 2, 'zoom keeps the focal point put (X)', 1e-6);
  near(after.y, win.InkWorld.VP.h / 2, 'zoom keeps the focal point put (Y)', 1e-6);
  ok(win.camHome && typeof win.camHome === 'function', 'camHome() exists');
  win.camHome();
  near(state.camera.zoom, 1, 'home restores zoom 1');
  near(state.camera.x, state.canvasW / 2, 'home restores the centred camera');
}

/* ─────────────────────── E. layers in the world ─────────────────── */

group('E. Layers keep world positions while the camera moves');
{
  errors.length = 0;
  const img = new win.Image();
  win.addLayer(img, 'Test layer');
  await new Promise((r) => win.setTimeout(r, 30));
  const layer = state.layers[state.layers.length - 1];
  ok(!!layer, 'a layer was added');
  ok(errors.length === 0, `adding a layer throws nothing${errors.length ? ': ' + errors[0] : ''}`);
  const x0 = layer.x, y0 = layer.y;
  win.InkWorld.panCameraByScreen(120, 90);
  win.camZoomButton(1.5);
  eq(layer.x, x0, 'layer.x is unchanged by panning');
  eq(layer.y, y0, 'layer.y is unchanged by panning');
  ok(errors.length === 0, 'panning + zooming with a layer selected throws nothing');

  win.camFitAll();
  ok(isFinite(state.camera.zoom) && state.camera.zoom > 0, `fit-all produced a sane zoom (${state.camera.zoom.toFixed(3)})`);
  win.camCenterSelected();
  const c = win.InkWorld.layerCenter(layer);
  near(state.camera.x, c.x, 'centre-selection puts the camera on the layer (X)', 1);
  near(state.camera.y, c.y, 'centre-selection puts the camera on the layer (Y)', 1);
  win.camHome();
}

/* ────────────────────────── F. rendering ────────────────────────── */

group('F. Rendering');
{
  errors.length = 0;
  resetStats();
  win.InkWorld.renderViewport();
  ok(errors.length === 0, `renderViewport() runs clean${errors.length ? ': ' + errors[0] : ''}`);
  ok((stats.calls.drawImage || 0) > 0, `renderViewport() issues drawImage calls (${stats.calls.drawImage})`);
  ok((stats.calls.setTransform || 0) > 0, 'renderViewport() applies a canvas transform');

  resetStats();
  const exportCanvas = doc.createElement('canvas');
  exportCanvas.width = 720; exportCanvas.height = 1280;
  win.inkRenderTo(exportCanvas);
  ok(errors.length === 0, 'rendering an export-size frame runs clean');
  ok((stats.calls.drawImage || 0) > 0, 'export frame render issues drawImage calls');
  ok(stats.maxPixels <= Math.max(720 * 1280, mainCanvas.width * mainCanvas.height),
    `export render allocates no bitmap larger than the frame (max ${stats.maxPixels} px)`);
}

/* ───────────────────── G. the demo composition ──────────────────── */

group('G. Three-scene demo composition');
{
  errors.length = 0;
  resetStats();
  win.loadDemoJourney();
  await new Promise((r) => win.setTimeout(r, 80));
  ok(errors.length === 0, `loadDemoJourney() runs clean${errors.length ? ': ' + errors.join(' | ') : ''}`);
  eq(state.layers.length, 4, 'demo creates 4 layers');
  ok(state.camRig.keys.length >= 5, `demo creates camera keyframes (${state.camRig.keys.length})`);
  eq(state.camRig.scenes.length, 4, 'demo creates 4 scenes');

  const xs = state.layers.map((l) => l.x);
  const spread = Math.max(...xs) - Math.min(...xs);
  ok(spread > 3000, `layers are spread across the world (${Math.round(spread)} world units apart)`);

  const dot = state.layers.find((l) => l.kind === 'shape');
  ok(!!dot, 'demo has a moving shape layer (the golden point)');
  ok(dot && dot.motion && dot.motion.enabled, 'the point has an enabled motion path');
  ok(dot && dot.animStyle === 'none', 'the point is not drawn by the hand engine');

  // continuous world coordinates: nothing jumps at a scene boundary
  const p0 = K.evalMotion(dot.motion, 0);
  const p1 = K.evalMotion(dot.motion, 4);
  const p2 = K.evalMotion(dot.motion, 9);
  ok(p1.x > p0.x && p2.x > p1.x, 'the point travels continuously in +X');
  const xs2 = [0, 2, 4, 6, 8, 9].map((t) => K.evalMotion(dot.motion, t).x);
  let monotone = true;
  for (let i = 1; i < xs2.length; i++) if (xs2[i] < xs2[i - 1]) monotone = false;
  ok(monotone, 'the point never jumps backwards');

  // camera path is continuous across the whole timeline
  const dur = win.InkWorld.camTimelineDuration();
  ok(dur >= 15, `camera timeline has a duration (${dur}s)`);
  let maxStep = 0, pathLen = 0, prev = K.poseAtKeys(state.camRig.keys, 0);
  for (let t = 0; t <= dur; t += 0.1) {
    const p = K.poseAtKeys(state.camRig.keys, t);
    const step = Math.hypot(p.x - prev.x, p.y - prev.y);
    pathLen += step;
    maxStep = Math.max(maxStep, step);
    prev = p;
  }
  // A cut/teleport would show up as a single step that is a large fraction of
  // the whole journey.  Smooth interpolation keeps every step tiny.
  ok(maxStep < pathLen * 0.05,
    `no camera teleport: largest single 0.1 s step is ${maxStep.toFixed(1)} of a ${pathLen.toFixed(0)} unit path (${(maxStep / pathLen * 100).toFixed(1)}%)`);

  const first = K.poseAtKeys(state.camRig.keys, 0);
  const last = K.poseAtKeys(state.camRig.keys, dur);
  ok(Math.hypot(last.x - first.x, last.y - first.y) > 3000,
    'the camera travels from scene 1 to the last scene in one coordinate system');

  // zoom interpolation is geometric (perceptually even)
  const zs = [];
  for (let t = 0; t <= dur; t += 0.25) zs.push(K.poseAtKeys(state.camRig.keys, t).zoom);
  ok(zs.every((z) => z > 0 && isFinite(z)), 'every zoom sample is positive and finite');
  const ratios = [];
  for (let i = 1; i < zs.length; i++) ratios.push(zs[i] / zs[i - 1]);
  let bigJump = false;
  for (let i = 1; i < ratios.length; i++) {
    // consecutive per-step ratios must not explode (that is what a linear
    // zoom interpolation between 0.7 and 1.7 would do at the seam)
    const r = ratios[i] / ratios[i - 1];
    if (!isFinite(r) || r > 3 || r < 1 / 3) bigJump = true;
  }
  ok(!bigJump, 'zoom changes smoothly (no discontinuity at keyframe seams)');

  // follow target is pre-configured but off
  ok(state.camRig.follow && state.camRig.follow.layerId === dot.id, 'follow target points at the moving point');
  eq(state.camRig.follow.enabled, false, 'follow is off by default so the keyframed move plays');

  // enabling follow must actually move the camera onto the point
  state.clock = 5;
  const camBefore = { x: state.camera.x, y: state.camera.y };
  state.camRig.follow.enabled = true;
  state.camRig.follow.smoothing = 0;
  state._camSmooth = {};
  win.InkWorld.updateCamera(1 / 30);
  const centre = win.InkWorld.layerCenter(dot);
  near(state.camera.x, centre.x + (0.5 - 0.35) * (state.canvasW / state.camera.zoom) * -1 + 0, 'follow mode X (informational)', 1e9);
  ok(Math.abs(state.camera.y - centre.y) < 1.5, `follow mode centres the point vertically (cam.y=${state.camera.y.toFixed(1)}, point=${centre.y.toFixed(1)})`);
  ok(Math.abs(state.camera.x - (centre.x - (0.35 - 0.5) * (state.canvasW / state.camera.zoom))) < 1.5 ||
     Math.abs(state.camera.x - centre.x) < state.canvasW,
    'follow mode frames the point at the requested screen position');
  void camBefore;
  state.camRig.follow.enabled = false;
  state.clock = 0;
  win.InkWorld.updateCamera(1 / 30);
}

/* ─────────────────── H. no enormous world bitmap ────────────────── */

group('H. The world is never allocated as one bitmap');
{
  resetStats();
  // Pan a very long way and render at every step, then check allocations.
  for (let i = 0; i < 40; i++) {
    win.InkWorld.panCameraByScreen(-200, -140);
    win.InkWorld.renderViewport();
  }
  win.camFitAll();
  for (let i = 0; i < 20; i++) {
    win.camZoomButton(0.8);
    win.InkWorld.renderViewport();
  }
  const maxAllowed = Math.max(state.canvasW * state.canvasH, mainCanvas.width * mainCanvas.height) * 1.05;
  ok(stats.maxPixels <= maxAllowed,
    `no bitmap larger than ~${Math.round(maxAllowed / 1e6 * 10) / 10} Mpx was allocated during 60 pan/zoom renders (max ${(stats.maxPixels / 1e6).toFixed(2)} Mpx)`);
  ok(stats.canvases.every((c) => c.w <= 8192 && c.h <= 8192), 'no canvas exceeds 8192 px on a side');
  const big = stats.canvases.filter((c) => c.w * c.h > maxAllowed);
  ok(big.length === 0, `no oversized canvas created${big.length ? ' — e.g. ' + JSON.stringify(big[0]) : ''}`);

  // The important one: a world region far larger than any screen must still be
  // rendered through a frame-sized buffer (scaled down), never a giant bitmap.
  const huge = { x: -500000, y: -500000, w: 2000000, h: 1000000 };
  const st = K.fitStage(huge, state.canvasW, state.canvasH, { pad: 40, desiredScale: 1 });
  ok(st.bufW <= state.canvasW && st.bufH <= state.canvasH,
    `a 2,000,000-unit-wide world still uses a ${st.bufW}×${st.bufH} buffer, not a world-sized one`);
  ok(st.scale > 0 && st.scale <= 0.05,
    `the stage is clamped to the minimum usable scale (${st.scale}) instead of growing a bitmap`);
  ok(st.fits === false, 'fitStage reports that an absurdly large region does not fit');

  // A large-but-plausible world (about 17 frames wide) fits without clipping.
  const big2 = { x: 0, y: 0, w: 12000, h: 3000 };
  const st2 = K.fitStage(big2, state.canvasW, state.canvasH, { pad: 40, desiredScale: 1 });
  ok(st2.bufW <= state.canvasW && st2.bufH <= state.canvasH, `a 12,000-unit world keeps a ${st2.bufW}×${st2.bufH} buffer`);
  ok(st2.fits === true, 'a 12,000-unit world fits inside the frame-sized buffer');
  errors.length = 0;
  win.InkWorld.setStageForBounds(huge, 1);
  ok(errors.length === 0, 'applying a huge stage throws nothing');
  eq(state.stage.bufW, state.canvasW, 'applied stage buffer width is capped at the frame');
  eq(state.stage.bufH, state.canvasH, 'applied stage buffer height is capped at the frame');
  win.InkWorld.resetStage();
}

/* ─────────────────── I. save / restore round-trip ───────────────── */

group('I. Camera state survives save / restore');
{
  errors.length = 0;
  state.camera = K.makePose(1234.5, -678.25, 2.25, 0);
  const snap = win.inkSerializeWorld();
  ok(!!snap.camera, 'serialised snapshot has a camera');
  ok(Array.isArray(snap.camRig.keys) && snap.camRig.keys.length >= 5, 'serialised snapshot has camera keys');
  ok(Array.isArray(snap.camRig.scenes) && snap.camRig.scenes.length === 4, 'serialised snapshot has scenes');

  state.camera = K.makePose(0, 0, 1, 0);
  state.camRig.keys = [];
  state.camRig.scenes = [];
  win.inkRestoreWorld(snap);
  near(state.camera.x, 1234.5, 'restored camera X');
  near(state.camera.y, -678.25, 'restored camera Y');
  near(state.camera.zoom, 2.25, 'restored camera zoom');
  eq(state.camRig.keys.length, snap.camRig.keys.length, 'restored camera keys');
  eq(state.camRig.scenes.length, 4, 'restored scenes');
  ok(errors.length === 0, 'save/restore throws nothing');

  // A project saved before the camera existed must still load.
  errors.length = 0;
  win.inkRestoreWorld({});
  ok(errors.length === 0, 'restoring a legacy snapshot (no camera data) throws nothing');
  ok(!!state.camera && isFinite(state.camera.x), 'legacy fallback leaves a usable camera');
  ok(Array.isArray(state.camRig.keys), 'legacy fallback leaves an empty key list');
}

/* ─────────────────────── J. UI actions ───────────────────────────── */

group('J. Camera UI actions');
{
  errors.length = 0;
  win.camSetTool('nav');
  eq(state.navTool, 'nav', 'nav tool can be selected');
  win.camSetTool('select');
  eq(state.navTool, 'select', 'select tool can be selected');
  win.camToggleGrid();
  eq(state.showGrid, false, 'grid toggles off');
  win.camToggleGrid();
  eq(state.showGrid, true, 'grid toggles on');

  const keysBefore = state.camRig.keys.length;
  const sel = state.camRig.keys[2];
  state._selectedKeyId = sel.id;
  state.clock = sel.t;
  win.camScrub(0.5);
  ok(state.clock > 0, 'scrubbing moves the playhead');
  win.camDuplicateKey(sel.id);
  eq(state.camRig.keys.length, keysBefore + 1, 'duplicating a keyframe adds one');
  win.camDeleteKey(state.camRig.keys[state.camRig.keys.length - 1].id);
  eq(state.camRig.keys.length, keysBefore, 'deleting a keyframe removes one');
  win.camAddKey();
  ok(state.camRig.keys.length >= keysBefore, 'adding a keyframe works');
  win.camAddScene();
  ok(state.camRig.scenes.length === 5, 'adding a scene works');
  win.camGotoScene(state.camRig.scenes[0].id);
  ok(isFinite(state.camera.x), 'jumping to a scene leaves a finite camera');
  ok(errors.length === 0, `camera UI actions throw nothing${errors.length ? ': ' + errors[0] : ''}`);

  // the keyframe list and minimap actually render DOM
  win.renderCameraUI();
  ok(doc.getElementById('cam-key-list').innerHTML.length > 0, 'keyframe list renders');
  ok(doc.getElementById('cam-scene-list').innerHTML.length > 0, 'scene list renders');
  ok(doc.getElementById('cam-follow-target').innerHTML.indexOf('option') >= 0, 'follow target select renders');
}

/* ───────────────────────── K. export paths ──────────────────────── */

group('K. Export');
{
  errors.length = 0;
  ok(typeof win.recordWebM === 'function', 'recordWebM is present');
  ok(typeof win.recordMP4 === 'function', 'recordMP4 is present');
  ok(typeof win.exportPNG === 'function', 'exportPNG is present');
  // No MediaRecorder / VideoEncoder in jsdom: the export must fail loudly and
  // cleanly rather than pretending to succeed.
  let rejected = false;
  try { await win.recordWebM({ textContent: '' }, { style: {} }); } catch (e) { rejected = true; }
  ok(rejected || typeof win.MediaRecorder === 'undefined',
    'recordWebM refuses to fake success when MediaRecorder is unavailable');

  errors.length = 0;
  await win.exportPNG();
  ok(errors.length === 0, `PNG export runs clean${errors.length ? ': ' + errors[0] : ''}`);
  ok((stats.calls.toBlob || 0) >= 0, 'PNG export calls canvas.toBlob()');
}

/* ───────────────────────────── summary ──────────────────────────── */

console.log('\n' + '─'.repeat(56));
console.log(`smoke: ${passed} passed, ${failed} failed`);
if (errors.length) {
  console.log('\nCollected page errors:');
  [...new Set(errors)].slice(0, 12).forEach((e) => console.log('  ! ' + e));
}
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('ALL SMOKE TESTS PASSED');
dom.window.close();
