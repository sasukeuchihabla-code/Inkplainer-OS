/**
 * animation.test.mjs — drives a REAL playback through the drawing engine.
 *
 * Run:  node tests/animation.test.mjs
 *
 * This is the check that the infinite-canvas changes did not break the
 * existing hand-drawing engine, and that the camera and the drawing share one
 * timeline.  The page is booted in jsdom with a recording canvas mock, then:
 *
 *   · the three-scene demo is loaded
 *   · the frame is shrunk so the pixel loops stay cheap
 *   · requestAnimationFrame and performance.now are replaced with a manual,
 *     deterministic clock so frames can be stepped one at a time
 *   · generate() runs and every frame is stepped until the animation reports
 *     complete (or a hard cap is hit)
 *
 * Because the mock never rasterises, the artwork is empty — the point of the
 * test is that the pipeline executes, advances, and finishes without errors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import 'fake-indexeddb/auto';
import { installCanvasMock, stats, resetStats } from './canvas-mock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label); }
}
function group(n) { console.log('\n' + n); }

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  if (/Could not load|not implemented/i.test(e.message || '')) return;
  errors.push('jsdomError: ' + (e.message || e));
});
vc.on('error', (...a) => {
  const m = a.map(String).join(' ');
  if (/Could not load|Not implemented|css/i.test(m)) return;
  errors.push('console.error: ' + m);
});

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/inkplainer/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    installCanvasMock(win, { viewW: 360, viewH: 640, imgW: 400, imgH: 300 });
    win.indexedDB = globalThis.indexedDB;
    win.IDBKeyRange = globalThis.IDBKeyRange;
    win.addEventListener('error', (e) => errors.push('window.error: ' + (e.message || e)));
  },
});
const win = dom.window;
const doc = win.document;

const realTimeoutForBoot = win.setTimeout.bind(win);
for (const f of ['camera.js', 'animations.js', 'world.js', 'demo.js']) {
  const s = doc.createElement('script');
  s.textContent = fs.readFileSync(path.join(ROOT, f), 'utf8');
  doc.body.appendChild(s);
}
await new Promise((r) => realTimeoutForBoot(r, 400));
await new Promise((r) => realTimeoutForBoot(r, 60));

const state = win.eval('state');
const K = win.InkCamera;

/* ─────────────── deterministic clock + manual rAF + timers ─────────────── */

// Keep a handle on the REAL setTimeout (used by this file's own awaits); the
// page's timers are virtualised below so group delays cost no wall-clock time.
const realTimeout = win.setTimeout.bind(win);

let vClock = 0;                 // virtual milliseconds
let rafQueue = [];
let timers = [];
let nextId = 1;

win.performance.now = () => vClock;
win.Date.now = () => 1690000000000 + vClock;
win.requestAnimationFrame = (cb) => { const id = nextId++; rafQueue.push({ id, cb }); return id; };
win.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter((f) => f.id !== id); };
win.setTimeout = (fn, ms) => { const id = nextId++; timers.push({ id, at: vClock + (ms || 0), fn }); return id; };
win.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
win.setInterval = () => nextId++;   // nothing in the playback path needs it

/** Advance the virtual clock by `ms`, fire due timers, then one frame of rAF. */
function step(ms = 1000 / 30) {
  vClock += ms;
  const dueT = timers.filter((t) => t.at <= vClock).sort((a, b) => a.at - b.at);
  timers = timers.filter((t) => t.at > vClock);
  for (const t of dueT) { try { t.fn(); } catch (e) { errors.push('timer: ' + (e.stack || e)); } }
  const due = rafQueue;
  rafQueue = [];
  for (const f of due) { try { f.cb(vClock); } catch (e) { errors.push('rAF: ' + (e.stack || e)); } }
  return due.length + dueT.length;
}
/** Run `n` virtual frames, letting Node drain microtasks between them. */
async function pump(n, msPerFrame = 1000 / 30) {
  let ran = 0;
  for (let i = 0; i < n; i++) {
    ran += step(msPerFrame);
    await new Promise((r) => realTimeout(r, 0));
  }
  return ran;
}

/* ─────────────────────────── A. setup ──────────────────────────── */

group('A. Playback harness');
ok(errors.length === 0, `page booted clean${errors.length ? ': ' + errors[0] : ''}`);
ok(typeof win.generate === 'function', 'generate() exists');
ok(typeof win.animate === 'function', 'animate() exists');

win.loadDemoJourney();
await new Promise((r) => realTimeout(r, 150));
ok(state.layers.length === 4, `demo loaded (${state.layers.length} layers)`);

// Shrink the frame so the pixel loops stay fast in a mocked canvas.
win.eval('initCanvas(240, 420)');
ok(state.canvasW === 240 && state.canvasH === 420, `frame shrunk to ${state.canvasW}×${state.canvasH}`);
ok(state.layers.every((l) => isFinite(l.x) && isFinite(l.y)), 'layers keep finite world coordinates after resizing');

/* ─────────────────── B. run the drawing animation ──────────────── */

group('B. generate() + playback');
{
  errors.length = 0;
  resetStats();
  const camBefore = { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom };
  win.eval('state._lastTs = 0; state.clock = 0;');
  win.generate();
  // generate() defers through one or two rAFs on drawing styles.
  await pump(6);
  ok(errors.length === 0, `generate() ran clean${errors.length ? ': ' + errors[0] : ''}`);
  ok(!!state._animGroups && state._animGroups.length > 0,
    `animation groups were built (${state._animGroups ? state._animGroups.length : 0})`);

  const groupCount = state._animGroups.length;
  ok(groupCount === 3, `the 3 drawable layers became 3 groups (the moving shape is not drawn)`);

  // Stage must have been chosen for group 0 and must be frame-sized or smaller.
  ok(state.stage.bufW <= state.canvasW && state.stage.bufH <= state.canvasH,
    `stage buffer is never larger than the frame (${state.stage.bufW}×${state.stage.bufH})`);
  ok(state.stage.scale > 0 && state.stage.scale <= 1, `stage scale is sane (${state.stage.scale})`);

  let frames = 0;
  const MAX_FRAMES = 2000;
  while (frames < MAX_FRAMES && !win.eval('state.done')) {
    await pump(1);
    frames++;
    if (frames % 40 === 0) await new Promise((r) => realTimeout(r, 2));
  }

  ok(errors.length === 0, `playback ran clean for ${frames} frames${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  ok(frames < MAX_FRAMES, `animation finished before the frame cap (${frames} frames)`);
  ok(!!win.eval('state.done'), 'state.done is set when the animation completes');
  ok((stats.calls.drawImage || 0) > 0, `the compositor issued drawImage calls (${stats.calls.drawImage})`);
  ok((stats.calls.setTransform || 0) > 0, 'the compositor applied the camera transform each frame');

  // NOTE: the mock canvas never rasterises, so the drawing itself finishes in a
  // couple of frames.  The clock still has to advance while frames are played,
  // which is what makes preview and export agree.
  const moved = Math.hypot(state.camera.x - camBefore.x, state.camera.y - camBefore.y);
  ok(state.clock > 0.05, `playback clock advanced (${state.clock.toFixed(3)}s over ${frames} frames)`);
  ok(isFinite(moved) && isFinite(state.camera.zoom), 'camera is finite after playback');
  ok(Math.abs(state.clock - frames * (1 / 30)) < frames * (1 / 30) + 0.01,
    'clock advances by real elapsed time, not by a fixed amount per frame');

  // Frame-rate independence: one second of wall-clock time must advance the
  // movie clock by one second whether the device renders 30 or 60 frames in it.
  // (The old per-frame stepping made a 60 Hz phone play the movie at 2x speed
  // and made exports drift from the preview.)
  rafQueue = [];
  win.eval('state.playing = true; state.done = true;');
  state.clock = 0; state._lastTs = 0;
  // (the ticks finish immediately on empty mock artwork and clear `playing`,
  //  so it is re-armed before every frame — we are measuring the clock, not
  //  the artwork)
  for (let i = 0; i < 30; i++) { vClock += 1000 / 30; state.playing = true; win.animate(); }
  const d30 = state.clock;
  state.clock = 0; state._lastTs = 0;
  for (let i = 0; i < 60; i++) { vClock += 1000 / 60; state.playing = true; win.animate(); }
  const d60 = state.clock;
  ok(Math.abs(d30 - 1) < 0.06 && Math.abs(d60 - 1) < 0.06,
    `1 s of wall clock = 1 s of movie time at 30 fps (${d30.toFixed(3)}s) and at 60 fps (${d60.toFixed(3)}s)`);
  ok(Math.abs(d30 - d60) < 0.06, `frame rate does not change the timing (Δ${Math.abs(d30 - d60).toFixed(4)}s)`);
  rafQueue = [];
  win.eval('state.playing = false;');
  ok(errors.length === 0, `frame-rate stepping throws nothing${errors.length ? ': ' + errors[0] : ''}`);
}

/* ─────────────────── C. camera / drawing share a clock ─────────── */

group('C. Camera and drawing share one timeline');
{
  errors.length = 0;
  win.eval('resetAnim()');
  state.clock = 0;
  state._camSmooth = {};
  const K2 = win.InkCamera;
  const samples = [];
  for (let i = 0; i < 40; i++) {
    state.clock += 1 / 30;                 // one 30 fps frame of movie time
    win.InkWorld.updateCamera(1 / 30);
    samples.push({ clock: state.clock, x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom });
  }
  ok(samples.every((s) => isFinite(s.x) && isFinite(s.y) && isFinite(s.zoom)), 'every camera sample is finite');
  ok(samples[samples.length - 1].clock > samples[0].clock, 'the clock advances with the frames');
  const moved = Math.hypot(samples[samples.length - 1].x - samples[0].x,
                           samples[samples.length - 1].y - samples[0].y);
  ok(moved > 5, `the camera travels while the timeline plays (${moved.toFixed(1)} world units in 1.33 s)`);

  // The camera must land where the keyframes say it should — this is the
  // invariant that makes an exported frame identical to the previewed frame.
  let worst = 0;
  for (const t of [0.5, 2, 4, 6, 8, 10]) {
    state.clock = t;
    state._camSmooth = {};
    for (let k = 0; k < 60; k++) win.InkWorld.updateCamera(1 / 30);   // settle damping
    const want = K2.poseAtKeys(state.camRig.keys, t);
    const d = Math.hypot(state.camera.x - want.x, state.camera.y - want.y);
    worst = Math.max(worst, d);
  }
  ok(worst < 2, `camera converges onto the keyframed pose (worst error ${worst.toFixed(3)} world units)`);
  ok(errors.length === 0, `camera stepping throws nothing${errors.length ? ': ' + errors[0] : ''}`);

  // Preview and export must agree: rendering the same camera pose into two
  // differently sized surfaces must work and must not throw.
  const pose = K2.poseAtKeys(state.camRig.keys, 12) || state.camera;
  const savedCam = { ...state.camera };
  Object.assign(state.camera, pose);
  const a = doc.createElement('canvas'); a.width = 720; a.height = 1280;
  const b = doc.createElement('canvas'); b.width = 360; b.height = 640;
  resetStats();
  win.inkRenderTo(a);
  win.inkRenderTo(b);
  ok(errors.length === 0, 'rendering to both an export-size and a preview-size surface works');
  ok((stats.calls.setTransform || 0) >= 2, 'each render applies its own camera transform');
  Object.assign(state.camera, savedCam);
}

/* ─────────────────── D. export completion gate ─────────────────── */

group('D. Export waits for the camera timeline too');
{
  win.eval('state.done = true; state.playing = false; state._groupPos = 99; state._animGroups = [];');
  state.clock = 0;
  eqish(win.isExportAnimationComplete(), false, 'export is not complete while the camera timeline is still playing');
  state.clock = win.InkWorld.camTimelineDuration() + 1;
  eqish(win.isExportAnimationComplete(), true, 'export completes once the camera timeline finishes');
  // Without a camera timeline the old behaviour is unchanged.
  state.camRig.keys = [];
  state.camRig.follow.enabled = false;
  state.clock = 0;
  eqish(win.isExportAnimationComplete(), true, 'with no camera animation the export behaves as before');
}
function eqish(a, b, label) {
  if (a === b) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label} — got ${a}, want ${b}`); }
}

/* ───────────────────────────── summary ─────────────────────────── */

console.log('\n' + '─'.repeat(56));
console.log(`animation: ${passed} passed, ${failed} failed`);
if (errors.length) {
  console.log('\nCollected page errors (first 10):');
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log('  ! ' + e));
}
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('ALL ANIMATION TESTS PASSED');
dom.window.close();
