/**
 * camera.test.mjs — unit tests for camera.js (pure maths, no DOM).
 *
 * Run:  node tests/camera.test.mjs
 *
 * A tiny hand-rolled assertion harness is used on purpose: the project has no
 * test runner dependency and adding one just for this would bloat the repo.
 */

import InkCamera from '../camera.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; failures.push(label); console.log('  ✗ ' + label); }
}
function near(a, b, label, eps = 1e-6) {
  const d = Math.abs(a - b);
  if (d <= eps) { passed++; }
  else {
    failed++;
    failures.push(`${label} (got ${a}, want ${b}, Δ${d})`);
    console.log(`  ✗ ${label} — got ${a}, want ${b}, Δ${d}`);
  }
}
function group(name, fn) { console.log('\n' + name); fn(); }

const K = InkCamera;

/* ───────────────────────────── easing ───────────────────────────── */
group('Easing', () => {
  near(K.easeNamed('linear', 0.25), 0.25, 'linear is identity');
  near(K.easeNamed('linear', 0), 0, 'linear(0)=0');
  near(K.easeNamed('linear', 1), 1, 'linear(1)=1');
  near(K.easeNamed('easeIn', 0), 0, 'easeIn(0)=0');
  near(K.easeNamed('easeIn', 1), 1, 'easeIn(1)=1');
  ok(K.easeNamed('easeIn', 0.5) < 0.5, 'easeIn slow at the start');
  ok(K.easeNamed('easeOut', 0.5) > 0.5, 'easeOut fast at the start');
  near(K.easeNamed('easeInOut', 0.5), 0.5, 'easeInOut symmetric at 0.5');
  near(K.easeNamed('easeInOut', 0), 0, 'easeInOut(0)=0');
  near(K.easeNamed('easeInOut', 1), 1, 'easeInOut(1)=1');
  near(K.easeNamed('nope-not-real', 0.3), 0.3, 'unknown easing falls back to linear');
  near(K.easeNamed('linear', -5), 0, 'easing clamps below 0');
  near(K.easeNamed('linear', 5), 1, 'easing clamps above 1');
});

/* ───────────────────────── view transform ───────────────────────── */
group('View transform / world↔screen round-trip', () => {
  const cam = K.makePose(1000, 500, 1, 0);
  const t = K.viewTransform(cam, 720, 1280, 720, 1280);
  near(t.scale, 1, 'zoom 1 with a same-size output → scale 1');
  const centre = K.worldToScreen(t, 1000, 500);
  near(centre.x, 360, 'camera centre maps to output centre X');
  near(centre.y, 640, 'camera centre maps to output centre Y');

  const p = K.screenToWorld(t, centre.x, centre.y);
  near(p.x, 1000, 'screen→world round-trip X');
  near(p.y, 500, 'screen→world round-trip Y');

  // Letterboxed viewport: a 400x900 editor area showing a 720x1280 frame.
  const t2 = K.viewTransform(cam, 720, 1280, 400, 900);
  near(t2.scale, Math.min(400 / 720, 900 / 1280), 'letterbox scale = min fit');
  const c2 = K.worldToScreen(t2, 1000, 500);
  near(c2.x, 200, 'letterboxed centre X');
  near(c2.y, 450, 'letterboxed centre Y');

  // Rotated camera must still round-trip.
  const camR = K.makePose(1000, 500, 1.4, 0.3);
  const tR = K.viewTransform(camR, 720, 1280, 720, 1280);
  const pr = K.screenToWorld(tR, 100, 640);
  const back = K.worldToScreen(tR, pr.x, pr.y);
  near(back.x, 100, 'rotated round-trip X', 1e-6);
  near(back.y, 640, 'rotated round-trip Y', 1e-6);

  // canvas matrix must agree with the JS maths
  const m = K.viewTransform(K.makePose(120, 80, 2, 0.15), 720, 1280, 360, 640);
  const wx = 133, wy = 99;
  const mx = m.a * wx + m.c * wy + m.e;
  const my = m.b * wx + m.d * wy + m.f;
  const js = K.worldToScreen(m, wx, wy);
  near(mx, js.x, 'canvas matrix agrees with worldToScreen X', 1e-9);
  near(my, js.y, 'canvas matrix agrees with worldToScreen Y', 1e-9);
});

group('viewRect', () => {
  const r = K.viewRect(K.makePose(0, 0, 1, 0), 720, 1280);
  near(r.x, -360, 'viewRect x at zoom 1');
  near(r.w, 720, 'viewRect w at zoom 1');
  const r2 = K.viewRect(K.makePose(0, 0, 2, 0), 720, 1280);
  near(r2.w, 360, 'zoom 2 halves the view width');
  near(r2.h, 640, 'zoom 2 halves the view height');
});

/* ─────────────────────── zoom about a screen point ──────────────── */
group('Zoom about a focal point', () => {
  const cam = K.makePose(1000, 500, 1, 0);
  const anchor = { x: 200, y: 1000 };
  const t0 = K.viewTransform(cam, 720, 1280, 720, 1280);
  const s0 = K.worldToScreen(t0, anchor.x, anchor.y);

  const cam2 = K.zoomAboutScreen(cam, 720, 1280, 720, 1280, s0.x, s0.y, 2.5, 0.02, 40);
  near(cam2.zoom, 2.5, 'zoom applied');
  const t1 = K.viewTransform(cam2, 720, 1280, 720, 1280);
  const s1 = K.worldToScreen(t1, anchor.x, anchor.y);
  near(s1.x, s0.x, 'focal point stays put (X)', 1e-6);
  near(s1.y, s0.y, 'focal point stays put (Y)', 1e-6);

  const cam3 = K.zoomAboutScreen(cam, 720, 1280, 720, 1280, s0.x, s0.y, 100, 0.02, 40);
  near(cam3.zoom, 40, 'zoom clamped to max');
  const cam4 = K.zoomAboutScreen(cam, 720, 1280, 720, 1280, s0.x, s0.y, 0.0001, 0.02, 40);
  near(cam4.zoom, 0.02, 'zoom clamped to min');
});

/* ──────────────────────────── keyframes ─────────────────────────── */
group('Camera keyframes', () => {
  const keys = [
    K.makeKey(0, K.makePose(0, 0, 1, 0), 'linear'),
    K.makeKey(4, K.makePose(1000, 0, 1, 0), 'linear'),
  ];
  near(K.poseAtKeys(keys, 0).x, 0, 'at first key');
  near(K.poseAtKeys(keys, 2).x, 500, 'linear midpoint');
  near(K.poseAtKeys(keys, 4).x, 1000, 'at last key');
  near(K.poseAtKeys(keys, -3).x, 0, 'before the track holds the first key');
  near(K.poseAtKeys(keys, 99).x, 1000, 'after the track holds the last key');
  ok(K.poseAtKeys([], 1) === null, 'empty track → null');

  // easing
  const eased = [
    K.makeKey(0, K.makePose(0, 0, 1, 0), 'easeIn'),
    K.makeKey(2, K.makePose(100, 0, 1, 0), 'linear'),
  ];
  const mid = K.poseAtKeys(eased, 1);
  ok(mid.x < 50, `easeIn lags behind linear at midpoint (got ${mid.x})`);

  // unsorted input must still work
  const shuffled = [keys[1], keys[0]];
  near(K.poseAtKeys(shuffled, 2).x, 500, 'unsorted keys are sorted internally');

  // geometric zoom interpolation: geometric mean at the midpoint of 1 → 4
  const zk = [
    K.makeKey(0, K.makePose(0, 0, 1, 0), 'linear'),
    K.makeKey(2, K.makePose(0, 0, 4, 0), 'linear'),
  ];
  near(K.poseAtKeys(zk, 1).zoom, 2, 'zoom interpolates geometrically (1→4 gives 2 at t=0.5)');
  near(K.poseAtKeys(zk, 0.5).zoom, Math.pow(4, 0.25), 'zoom at 25%');

  // cut
  const cutKeys = [
    Object.assign(K.makeKey(0, K.makePose(0, 0, 1, 0), 'linear'), { cut: true }),
    K.makeKey(2, K.makePose(500, 0, 1, 0), 'linear'),
  ];
  near(K.poseAtKeys(cutKeys, 1).x, 0, 'cut holds the previous pose');
  near(K.poseAtKeys(cutKeys, 2).x, 500, 'cut jumps at the next key');

  near(K.keysDuration(keys, 6), 6, 'duration = max(last key, fallback)');
  near(K.keysDuration(keys, 1), 4, 'duration = last key when it is later');
});

/* ─────────────────────────── motion paths ───────────────────────── */
group('Object motion', () => {
  const motion = {
    enabled: true,
    ease: 'linear',
    path: [{ t: 0, x: 0, y: 0 }, { t: 4, x: 400, y: 0 }],
  };
  near(K.evalMotion(motion, 0).x, 0, 'motion start');
  near(K.evalMotion(motion, 2).x, 200, 'motion midpoint');
  near(K.evalMotion(motion, 4).x, 400, 'motion end');
  near(K.evalMotion(motion, 9).x, 400, 'motion holds past the end');
  near(K.evalMotion(motion, -1).x, 0, 'motion holds before the start');
  ok(K.evalMotion(null, 1) === null, 'no motion → null');
  ok(K.evalMotion({ enabled: false, path: [] }, 1) === null, 'disabled motion → null');
  ok(K.evalMotion({ enabled: true, path: [] }, 1) === null, 'empty path → null');

  const eased = {
    enabled: true,
    path: [{ t: 0, x: 0, y: 0, ease: 'easeIn' }, { t: 2, x: 100, y: 0 }],
  };
  ok(K.evalMotion(eased, 1).x < 50, 'per-segment easing respected');
});

group('layerWorldRect', () => {
  const layer = {
    x: -20, y: -20, w: 40, h: 40,
    motion: { enabled: true, path: [{ t: 0, x: 0, y: 0 }, { t: 4, x: 1000, y: 0 }] },
  };
  const r = K.layerWorldRect(layer, 4);
  ok(r.x <= -20, `swept rect includes the start (x=${r.x})`);
  ok(r.x + r.w >= 1020, `swept rect includes the end (right=${r.x + r.w})`);
  const staticR = K.layerWorldRect({ x: 5, y: 6, w: 7, h: 8 }, 4);
  near(staticR.x, 5, 'static layer rect x');
  near(staticR.w, 7, 'static layer rect w');
});

/* ─────────────────────────── follow target ──────────────────────── */
group('Follow target', () => {
  const frameW = 720, frameH = 1280;
  const cam = K.makePose(0, 0, 1, 0);
  const target = { x: 500, y: 0 };

  const centred = K.followPose(cam, frameW, frameH, target, 0.5, 0.5);
  near(centred.x, 500, 'follow centred → camera on target X');
  near(centred.y, 0, 'follow centred → camera on target Y');

  const left = K.followPose(cam, frameW, frameH, target, 0.2, 0.5);
  near(left.x, 500 + 0.3 * frameW, 'target sits left of centre → camera ahead (+X)');

  // Verify the framing really lands at the requested fraction — both in the
  // exported frame and in an editor viewport of a different pixel size
  // (preview vs export equivalence).  The correct invariant is the position
  // relative to the output centre measured in world units; letterbox bars
  // differ when the output aspect differs from the frame aspect.
  const outA = K.viewTransform(left, frameW, frameH, 720, 1280);
  const outB = K.viewTransform(left, frameW, frameH, 360, 640);
  const sa = K.worldToScreen(outA, target.x, target.y);
  const sb = K.worldToScreen(outB, target.x, target.y);
  near(sa.x / 720, 0.2, 'export framing fraction X', 1e-9);
  near(sb.x / 360, 0.2, 'preview framing fraction X matches export', 1e-9);
  near(sa.y / 1280, 0.5, 'export framing fraction Y', 1e-9);
  near(sb.y / 640, 0.5, 'preview framing fraction Y matches export', 1e-9);

  // Follow zoom override
  const rig = {
    keys: [K.makeKey(0, K.makePose(0, 0, 1, 0), 'linear')],
    follow: { enabled: true, screenX: 0.5, screenY: 0.5, smoothing: 0, zoom: 3 },
  };
  const pose = K.evalCamera(rig, 1, { frameW, frameH, target, dt: 1 / 30 });
  near(pose.zoom, 3, 'follow zoom override wins');
  near(pose.x, 500, 'follow position');
});

group('Follow damping is deterministic', () => {
  const frameW = 720, frameH = 1280;
  const mk = () => ({
    keys: [K.makeKey(0, K.makePose(0, 0, 1, 0), 'linear')],
    follow: { enabled: true, screenX: 0.5, screenY: 0.5, smoothing: 0.3, zoom: null },
  });
  const runA = [], runB = [];
  for (let rep = 0; rep < 2; rep++) {
    const rig = mk();
    const sm = {};
    const out = rep === 0 ? runA : runB;
    for (let i = 0; i < 60; i++) {
      const t = i / 30;
      const target = { x: i * 40, y: 0 };
      out.push(K.evalCamera(rig, t, { frameW, frameH, target, dt: 1 / 30, smoothing: sm }));
    }
  }
  let identical = true;
  for (let i = 0; i < runA.length; i++) {
    if (Math.abs(runA[i].x - runB[i].x) > 1e-12) identical = false;
  }
  ok(identical, 'two identical runs produce identical camera paths (export == preview)');
  // Steady-state lag of exponential damping ≈ tau × velocity.
  // velocity = 40 world-units per frame × 30 fps = 1200 u/s, tau = 0.3 s.
  const lastTarget = 59 * 40;
  const lag = lastTarget - runA[runA.length - 1].x;
  ok(lag > 0, 'damped camera lags the target');
  ok(Math.abs(lag - 0.3 * 1200) < 40, `lag ≈ tau × velocity (got ${lag.toFixed(1)}, want ~360)`);
  ok(runA[runA.length - 1].x > 1800, 'damped camera still tracks the target');

  // Zero smoothing == instant snap
  const rig2 = mk(); rig2.follow.smoothing = 0;
  const sm2 = {};
  const p = K.evalCamera(rig2, 1, { frameW, frameH, target: { x: 777, y: 0 }, dt: 1 / 30, smoothing: sm2 });
  near(p.x, 777, 'smoothing 0 snaps to the target');
});

group('evalCamera falls back cleanly', () => {
  const p = K.evalCamera({}, 1, { frameW: 720, frameH: 1280, dt: 1 / 30 });
  near(p.x, 360, 'no keys → camera centred on the frame');
  near(p.zoom, 1, 'no keys → zoom 1');
});

/* ─────────────────────────── scenes ─────────────────────────────── */
group('Scenes', () => {
  const s1 = K.makeScene('A', { x: 0, y: 0, w: 720, h: 1280 }, 0, 3);
  const s2 = K.makeScene('B', { x: 2000, y: 0, w: 720, h: 1280 }, 3, 3);
  ok(K.sceneAt([s1, s2], 1) === s1, 'scene A at t=1');
  ok(K.sceneAt([s1, s2], 4) === s2, 'scene B at t=4');
  ok(K.sceneAt([s1, s2], 99) === null, 'no scene past the end');
  near(K.scenesDuration([s1, s2], 0), 6, 'scene duration total');
  near(K.scenesDuration([], 5), 5, 'scene duration fallback');
});

/* ──────────────────────────── stage ─────────────────────────────── */
group('Stage fitting (bounded buffers)', () => {
  const small = { x: 100, y: 100, w: 300, h: 200 };
  const st = K.fitStage(small, 720, 1280, { pad: 20 });
  near(st.scale, 1, 'content that fits keeps scale 1');
  near(st.x + st.worldW / 2, 250, 'stage centred on content X');
  near(st.y + st.worldH / 2, 200, 'stage centred on content Y');
  ok(st.worldW >= 720, 'stage covers at least the buffer width in world units');
  near(K.worldToStageX(st, st.x), 0, 'stage origin maps to buffer pixel 0');
  near(K.stageToWorldX(st, 0), st.x, 'buffer pixel 0 maps back to the stage origin');

  // Huge content must scale DOWN rather than allocating a bigger buffer.
  const huge = { x: 0, y: 0, w: 8000, h: 4000 };
  const st2 = K.fitStage(huge, 720, 1280, { pad: 0 });
  ok(st2.scale < 1, `huge content is scaled down (scale=${st2.scale})`);
  ok(st2.scale > 0, 'scale stays positive');
  ok(8000 * st2.scale <= 720 + 1e-6, 'scaled content fits the buffer width');
  ok(4000 * st2.scale <= 1280 + 1e-6, 'scaled content fits the buffer height');
  near(st2.bufW, 720, 'buffer width is never grown');
  near(st2.bufH, 1280, 'buffer height is never grown');

  const r = K.stageWorldRect(st2);
  near(r.w, 720 / st2.scale, 'stage world rect width');
  near(r.h, 1280 / st2.scale, 'stage world rect height');
});

/* ─────────────────────── rect helpers / fit ─────────────────────── */
group('Rect helpers', () => {
  const u = K.unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 10 });
  near(u.x, 0, 'union x'); near(u.y, -5, 'union y');
  near(u.w, 15, 'union w'); near(u.h, 15, 'union h');
  ok(K.unionRect(null, null) === null, 'union of nothing is null');
  const inf = K.inflateRect({ x: 0, y: 0, w: 10, h: 10 }, 5);
  near(inf.w, 20, 'inflate w'); near(inf.x, -5, 'inflate x');

  const layers = [
    { x: 0, y: 0, w: 100, h: 100, visible: true },
    { x: 900, y: 400, w: 200, h: 200, visible: true },
    { x: 5000, y: 5000, w: 10, h: 10, visible: false },
  ];
  // 0..100 and 900..1100 → union 0..1100.  The hidden layer at 5000 is skipped.
  const b = K.contentBounds(layers, 0);
  near(b.w, 1100, 'content bounds span the visible layers');
  ok(b.x + b.w < 5000, 'content bounds ignore hidden layers');

  const pose = K.fitRectPose(b, 720, 1280, { pad: 1 });
  const vr = K.viewRect(pose, 720, 1280);
  ok(vr.w >= b.w - 1e-6, 'fit pose shows the whole width');
  ok(vr.h >= b.h - 1e-6, 'fit pose shows the whole height');
  near(pose.x, 550, 'fit pose centres X on the content');
});

group('Content bounds over a big world', () => {
  const layers = [
    { x: -100, y: 0, w: 50, h: 50, visible: true },
    { x: 6000, y: 300, w: 800, h: 600, visible: true },
  ];
  const b = K.contentBounds(layers, 10);
  near(b.x, -100, 'far-apart layers: bounds start');
  near(b.x + b.w, 6800, 'far-apart layers: bounds end');
  const pose = K.fitRectPose(b, 720, 1280, { pad: 1.1 });
  ok(pose.zoom < 1, 'zoomed out to fit a wide world');
});

/* ───────────────────────── preview == export ────────────────────── */
group('Preview and export agree', () => {
  const frameW = 720, frameH = 1280;
  const keys = [
    K.makeKey(0, K.makePose(0, 0, 1, 0), 'easeInOut'),
    K.makeKey(3, K.makePose(3000, 200, 2.5, 0), 'easeInOut'),
    K.makeKey(6, K.makePose(4000, 0, 1, 0), 'linear'),
  ];
  // The editor viewport has an arbitrary pixel size / aspect, so the exported
  // frame is letterboxed inside it.  The invariant that must hold is that a
  // world point lands the same distance from the output centre once that
  // distance is measured in world units — i.e. the same camera framing.
  for (const t of [0, 0.7, 1.5, 3, 4.2, 6]) {
    const cam = K.poseAtKeys(keys, t);
    const exportT = K.viewTransform(cam, frameW, frameH, 1080, 1920);
    const previewT = K.viewTransform(cam, frameW, frameH, 311, 553);
    const w = { x: 1234.5, y: -77.25 };
    const e = K.worldToScreen(exportT, w.x, w.y);
    const p = K.worldToScreen(previewT, w.x, w.y);
    const eRel = { x: (e.x - exportT.outW / 2) / exportT.scale, y: (e.y - exportT.outH / 2) / exportT.scale };
    const pRel = { x: (p.x - previewT.outW / 2) / previewT.scale, y: (p.y - previewT.outH / 2) / previewT.scale };
    near(eRel.x, pRel.x, `same camera-space X at t=${t}`, 1e-9);
    near(eRel.y, pRel.y, `same camera-space Y at t=${t}`, 1e-9);
  }

  // And with a viewport that has EXACTLY the frame aspect, the normalised
  // pixel positions must match too (this is the true WYSIWYG case).
  for (const t of [0, 1.5, 3, 6]) {
    const cam = K.poseAtKeys(keys, t);
    const exportT = K.viewTransform(cam, frameW, frameH, 1080, 1920);
    const previewT = K.viewTransform(cam, frameW, frameH, 360, 640);
    const e = K.worldToScreen(exportT, 1234.5, -77.25);
    const p = K.worldToScreen(previewT, 1234.5, -77.25);
    near(e.x / 1080, p.x / 360, `same normalised X at t=${t}`, 1e-9);
    near(e.y / 1920, p.y / 640, `same normalised Y at t=${t}`, 1e-9);
  }
});

/* ───────────────────────────── summary ──────────────────────────── */
console.log(`\n${'─'.repeat(56)}`);
console.log(`camera.js: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('ALL CAMERA TESTS PASSED');
