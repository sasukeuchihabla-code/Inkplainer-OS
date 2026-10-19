/* =============================================================================
 * camera.js — Inkplainer infinite-canvas camera, timeline and world maths
 * -----------------------------------------------------------------------------
 * Inkplainer OS · Apache License 2.0
 *
 * This module holds ALL of the pure geometry / timeline maths for the new
 * infinite virtual canvas.  It deliberately touches **no** DOM APIs so that it
 * can be unit-tested under Node (see tests/camera.test.mjs).
 *
 * -----------------------------------------------------------------------------
 * COORDINATE SYSTEMS
 * -----------------------------------------------------------------------------
 * 1. WORLD space   — infinite, in "world units".  A world unit is defined as
 *                    one pixel of the export frame at zoom 1, so an existing
 *                    Inkplainer project (whose layer x/y were canvas pixels)
 *                    keeps exactly the same numbers.  Backwards compatible.
 *
 * 2. STAGE space   — the pixel coordinate space of the fixed-size offscreen
 *                    buffers the original drawing engine renders into
 *                    (offscreen / slot canvases / bgCanvas / revealCanvas …).
 *                    A stage is a bounded window into the world:
 *
 *                        stagePx   = (world - stage.origin) * stage.scale
 *                        world     = stage.origin + stagePx / stage.scale
 *
 *                    stage.scale is normally 1 (1 world unit = 1 buffer pixel).
 *                    When a layer's content is larger than the frame the stage
 *                    is scaled down so it still fits inside the buffer — this
 *                    is what keeps memory bounded no matter how big the world
 *                    gets.  Stage buffers are ALWAYS frame-sized or smaller;
 *                    the world is never allocated as one big bitmap.
 *
 * 3. SCREEN space  — device pixels of whatever surface we are drawing into:
 *                    the editor viewport canvas, or the export frame canvas.
 *
 * The camera maps WORLD -> SCREEN.  A camera pose is
 *
 *      { x, y, zoom, rot }
 *
 *      (x, y)  world point shown at the CENTRE of the output surface
 *      zoom    scale factor.  The "view rect" (the region of the world that
 *              the output surface shows) is  frameW/zoom  x  frameH/zoom
 *              world units.  zoom === 1 reproduces the original fixed-canvas
 *              framing, so existing projects are unchanged.
 *      rot     camera rotation in radians (optional; 0 by default)
 *
 * The same functions produce the editor preview and the exported frame, which
 * is what guarantees "what you preview is what you export".
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InkCamera = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ───────────────────────── small numeric helpers ─────────────────────── */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const isFiniteNum = (v) => typeof v === 'number' && isFinite(v);

  /* ─────────────────────────────── easing ──────────────────────────────── */

  const EASINGS = {
    linear: (t) => t,
    easeIn: (t) => t * t * t,
    easeOut: (t) => 1 - Math.pow(1 - t, 3),
    easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    // Extras — kept because they are cheap and useful for camera moves.
    expoOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    backOut: (t) => {
      const c = 1.70158;
      return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    },
  };

  const EASING_NAMES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'expoOut', 'backOut'];

  function easeNamed(name, t) {
    const fn = EASINGS[name] || EASINGS.linear;
    return fn(clamp(t, 0, 1));
  }

  /* ─────────────────────── camera pose / view rect ─────────────────────── */

  function makePose(x, y, zoom, rot) {
    return {
      x: isFiniteNum(x) ? x : 0,
      y: isFiniteNum(y) ? y : 0,
      zoom: isFiniteNum(zoom) && zoom > 0 ? zoom : 1,
      rot: isFiniteNum(rot) ? rot : 0,
    };
  }

  function clonePose(p) {
    return makePose(p && p.x, p && p.y, p && p.zoom, p && p.rot);
  }

  /**
   * World-space rectangle (axis aligned, un-rotated) that an output surface
   * of frameW x frameH "reference pixels" shows at the given camera pose.
   */
  function viewRect(cam, frameW, frameH) {
    const w = frameW / (cam.zoom || 1);
    const h = frameH / (cam.zoom || 1);
    return { x: cam.x - w / 2, y: cam.y - h / 2, w, h };
  }

  /**
   * Build the WORLD -> SCREEN transform for an output surface of outW x outH
   * pixels.  The "view rect" is fitted inside the surface (letterboxed) using
   * the same rule for the editor viewport and for the exported frame, which is
   * what makes preview and export identical.
   *
   * Returns an object carrying both the maths and the exact canvas 2D matrix.
   */
  function viewTransform(cam, frameW, frameH, outW, outH) {
    const pose = makePose(cam && cam.x, cam && cam.y, cam && cam.zoom, cam && cam.rot);
    const viewW = frameW / pose.zoom;
    const viewH = frameH / pose.zoom;
    const c = Math.abs(Math.cos(pose.rot));
    const s = Math.abs(Math.sin(pose.rot));
    // Axis-aligned footprint of the (possibly rotated) view rect.
    const boxW = viewW * c + viewH * s;
    const boxH = viewW * s + viewH * c;
    const scale = Math.min(outW / (boxW || 1), outH / (boxH || 1));
    const cos = Math.cos(pose.rot) * scale;
    const sin = Math.sin(pose.rot) * scale;

    return {
      scale,
      rot: pose.rot,
      cx: outW / 2,
      cy: outH / 2,
      camX: pose.x,
      camY: pose.y,
      outW,
      outH,
      // canvas 2D matrix: setTransform(a, b, c, d, e, f)
      a: cos,
      b: sin,
      c: -sin,
      d: cos,
      e: outW / 2 - (pose.x * cos - pose.y * sin),
      f: outH / 2 - (pose.x * sin + pose.y * cos),
    };
  }

  function worldToScreen(t, wx, wy) {
    const dx = (wx - t.camX) * t.scale;
    const dy = (wy - t.camY) * t.scale;
    const cos = Math.cos(t.rot);
    const sin = Math.sin(t.rot);
    return { x: t.cx + dx * cos - dy * sin, y: t.cy + dx * sin + dy * cos };
  }

  function screenToWorld(t, sx, sy) {
    let dx = sx - t.cx;
    let dy = sy - t.cy;
    const cos = Math.cos(-t.rot);
    const sin = Math.sin(-t.rot);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return { x: t.camX + rx / t.scale, y: t.camY + ry / t.scale };
  }

  /** Apply a view transform to a canvas 2D context (device pixels). */
  function applyCanvasTransform(ctx2d, t) {
    ctx2d.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
  }

  /**
   * Zoom about a fixed screen point (pinch / wheel).  The world point under
   * (sx, sy) stays under (sx, sy).
   */
  function zoomAboutScreen(cam, frameW, frameH, outW, outH, sx, sy, factor, minZoom, maxZoom) {
    const before = viewTransform(cam, frameW, frameH, outW, outH);
    const w = screenToWorld(before, sx, sy);
    const nextZoom = clamp((cam.zoom || 1) * factor, minZoom || 0.02, maxZoom || 40);
    const after = viewTransform(
      makePose(cam.x, cam.y, nextZoom, cam.rot),
      frameW, frameH, outW, outH
    );
    const s2 = worldToScreen(after, w.x, w.y);
    // Shift the camera so the anchor world point moves back under the finger.
    const ddx = (s2.x - sx) / after.scale;
    const ddy = (s2.y - sy) / after.scale;
    const cos = Math.cos(-after.rot);
    const sin = Math.sin(-after.rot);
    return makePose(
      cam.x + (ddx * cos - ddy * sin),
      cam.y + (ddx * sin + ddy * cos),
      nextZoom,
      cam.rot
    );
  }

  /* ─────────────────────────── camera keyframes ────────────────────────── */

  let _keyId = 0;
  /** Keep the id counter ahead of ids loaded from a saved project. */
  function reserveKeyId(id) {
    if (isFiniteNum(id) && id > _keyId) _keyId = Math.floor(id);
  }
  function makeKey(t, cam, ease) {
    return {
      id: ++_keyId,
      t: Math.max(0, isFiniteNum(t) ? t : 0),
      x: cam.x,
      y: cam.y,
      zoom: cam.zoom,
      rot: cam.rot || 0,
      ease: ease || 'easeInOut',
      cut: false, // true = jump to the NEXT key instead of interpolating
    };
  }

  function sortKeys(keys) {
    return (keys || []).slice().sort((a, b) => a.t - b.t);
  }

  /**
   * Pose of a keyframe track at time t.
   * Zoom is interpolated GEOMETRICALLY (log space) — linear zoom interpolation
   * feels like it accelerates and then slams on the brakes; geometric
   * interpolation is perceptually even.
   */
  function poseAtKeys(keys, t) {
    const k = sortKeys(keys);
    if (!k.length) return null;
    if (t <= k[0].t) return makePose(k[0].x, k[0].y, k[0].zoom, k[0].rot);
    const last = k[k.length - 1];
    if (t >= last.t) return makePose(last.x, last.y, last.zoom, last.rot);

    let i = 0;
    while (i < k.length - 1 && k[i + 1].t <= t) i++;
    const a = k[i];
    const b = k[i + 1];
    const span = b.t - a.t;
    if (span <= 0) return makePose(b.x, b.y, b.zoom, b.rot);
    if (a.cut) return makePose(a.x, a.y, a.zoom, a.rot); // hold, then jump at b

    const u = clamp((t - a.t) / span, 0, 1);
    const e = easeNamed(a.ease, u);
    const z0 = a.zoom > 0 ? a.zoom : 1;
    const z1 = b.zoom > 0 ? b.zoom : 1;
    return makePose(
      lerp(a.x, b.x, e),
      lerp(a.y, b.y, e),
      z0 * Math.pow(z1 / z0, e),
      lerp(a.rot || 0, b.rot || 0, e)
    );
  }

  /** Duration implied by a keyframe track (seconds). */
  function keysDuration(keys, fallback) {
    const k = sortKeys(keys);
    if (!k.length) return fallback || 0;
    return Math.max(k[k.length - 1].t, fallback || 0);
  }

  /* ─────────────────────── object motion (followable) ──────────────────── */

  /**
   * Evaluate a layer's optional motion path.
   *   motion = { enabled, path:[{t,x,y,ease?}], loop:false }
   * Path points hold the WORLD position of the layer CENTRE at time t.
   * Returns null when the layer has no usable motion (caller falls back to
   * the layer's static x/y).
   */
  function evalMotion(motion, t) {
    if (!motion || !motion.enabled || !Array.isArray(motion.path) || !motion.path.length) {
      return null;
    }
    const p = motion.path.slice().sort((a, b) => a.t - b.t);
    if (t <= p[0].t) return { x: p[0].x, y: p[0].y };
    const last = p[p.length - 1];
    if (t >= last.t) return { x: last.x, y: last.y };
    let i = 0;
    while (i < p.length - 1 && p[i + 1].t <= t) i++;
    const a = p[i];
    const b = p[i + 1];
    const span = b.t - a.t;
    if (span <= 0) return { x: b.x, y: b.y };
    const e = easeNamed(a.ease || motion.ease || 'linear', (t - a.t) / span);
    return { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e) };
  }

  /** World rect a layer sweeps over the whole timeline (motion included). */
  function layerWorldRect(layer, duration) {
    let x = layer.x || 0, y = layer.y || 0, w = layer.w || 0, h = layer.h || 0;
    let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
    const m = layer.motion;
    if (m && m.enabled && Array.isArray(m.path) && m.path.length) {
      m.path.forEach((pt) => {
        x0 = Math.min(x0, pt.x - w / 2);
        y0 = Math.min(y0, pt.y - h / 2);
        x1 = Math.max(x1, pt.x + w / 2);
        y1 = Math.max(y1, pt.y + h / 2);
      });
      // Also sample the eased path so curves do not escape the bounding box.
      const tEnd = Math.max(duration || 0, m.path[m.path.length - 1].t);
      const STEPS = 24;
      for (let i = 0; i <= STEPS; i++) {
        const p = evalMotion(m, (tEnd * i) / STEPS);
        if (!p) continue;
        x0 = Math.min(x0, p.x - w / 2);
        y0 = Math.min(y0, p.y - h / 2);
        x1 = Math.max(x1, p.x + w / 2);
        y1 = Math.max(y1, p.y + h / 2);
      }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* ─────────────────────────── follow target ───────────────────────────── */

  /**
   * Camera pose that puts `target` (world point) at the requested fraction of
   * the view rect.  The offset is expressed as a FRACTION of the view rect, not
   * of the output surface, so the framing is identical in the editor preview
   * and in the exported frame regardless of their pixel aspect.
   */
  function followPose(cam, frameW, frameH, target, screenX, screenY) {
    const viewW = frameW / (cam.zoom || 1);
    const viewH = frameH / (cam.zoom || 1);
    const ox = (clamp(screenX, 0, 1) - 0.5) * viewW;
    const oy = (clamp(screenY, 0, 1) - 0.5) * viewH;
    // Rotate the offset into world space (inverse of the view rotation).
    const cos = Math.cos(cam.rot || 0);
    const sin = Math.sin(cam.rot || 0);
    return makePose(
      target.x - (ox * cos + oy * sin),
      target.y - (-ox * sin + oy * cos),
      cam.zoom,
      cam.rot
    );
  }

  /**
   * Camera pose for a given timeline position.
   *
   * rig    = { keys, follow:{enabled, screenX, screenY, smoothing, zoom, offsetX, offsetY} }
   * opts   = { frameW, frameH, target:{x,y}|null, dt, smoothing:{x,y,zoom}|null }
   *
   * `smoothing` is the rig's damped camera state; it is mutated here so that
   * damping is reproducible (it depends only on dt, and export steps dt in
   * fixed increments).
   */
  function evalCamera(rig, t, opts) {
    const o = opts || {};
    const frameW = o.frameW || 1280;
    const frameH = o.frameH || 720;
    const dt = isFiniteNum(o.dt) ? o.dt : 1 / 30;

    let base = poseAtKeys(rig && rig.keys, t);
    if (!base) base = o.fallback ? clonePose(o.fallback) : makePose(frameW / 2, frameH / 2, 1, 0);

    const f = rig && rig.follow;
    if (f && f.enabled && o.target) {
      const zoom = f.zoom && f.zoom > 0 ? f.zoom : base.zoom;
      const target = {
        x: o.target.x + (f.offsetX || 0),
        y: o.target.y + (f.offsetY || 0),
      };
      base = followPose(
        makePose(base.x, base.y, zoom, base.rot),
        frameW, frameH,
        target,
        f.screenX == null ? 0.5 : f.screenX,
        f.screenY == null ? 0.5 : f.screenY
      );
    }

    const sm = o.smoothing;
    if (!sm || !f || !f.enabled) return base;
    const tau = clamp(f.smoothing == null ? 0.25 : f.smoothing, 0, 4);
    if (tau <= 0.0005) {
      sm.x = base.x; sm.y = base.y; sm.zoom = base.zoom; sm.rot = base.rot;
      return clonePose(sm);
    }
    const alpha = 1 - Math.exp(-dt / tau);
    if (!isFiniteNum(sm.x)) { sm.x = base.x; sm.y = base.y; sm.zoom = base.zoom; sm.rot = base.rot; }
    sm.x = lerp(sm.x, base.x, alpha);
    sm.y = lerp(sm.y, base.y, alpha);
    sm.zoom = sm.zoom > 0 ? Math.exp(lerp(Math.log(sm.zoom), Math.log(base.zoom), alpha)) : base.zoom;
    sm.rot = lerp(sm.rot || 0, base.rot || 0, alpha);
    return makePose(sm.x, sm.y, sm.zoom, sm.rot);
  }

  /* ─────────────────────────────── scenes ──────────────────────────────── */

  let _sceneId = 0;
  function makeScene(name, rect, t, dur) {
    return {
      id: ++_sceneId,
      name: name || 'Scene',
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      t: Math.max(0, t || 0),
      dur: Math.max(0.1, dur == null ? 4 : dur),
    };
  }

  function sceneAt(scenes, t) {
    const list = scenes || [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (t >= s.t && t < s.t + s.dur) return s;
    }
    return null;
  }

  function scenesDuration(scenes, fallback) {
    let end = fallback || 0;
    (scenes || []).forEach((s) => { end = Math.max(end, s.t + s.dur); });
    return end;
  }

  /* ──────────────────────── stage (bounded buffers) ────────────────────── */

  /**
   * Pick a stage that covers `bounds` (world units) inside a buffer of
   * bufW x bufH pixels.
   *
   * scale is normally 1.  When the content does not fit, the stage is scaled
   * down rather than the buffer being enlarged, so memory stays bounded:
   *   scale = min(1, bufW/contentW, bufH/contentH)
   * `desiredScale` (typically the camera zoom at group start) lets us spend
   * buffer resolution where it is actually visible on screen.
   */
  const MIN_STAGE_SCALE = 0.05;   // below this the reveal algorithms degrade

  function fitStage(bounds, bufW, bufH, opts) {
    const o = opts || {};
    const pad = o.pad == null ? 40 : o.pad;
    const contentW = Math.max(1, (bounds.w || 1) + pad * 2);
    const contentH = Math.max(1, (bounds.h || 1) + pad * 2);
    const fitMax = Math.min(1, bufW / contentW, bufH / contentH);
    const desired = clamp(o.desiredScale == null ? 1 : o.desiredScale, 0.25, 4);
    const floor = o.minScale == null ? MIN_STAGE_SCALE : o.minScale;
    const scale = clamp(Math.min(fitMax, Math.max(desired, 0.5)), floor, 1);

    const worldW = bufW / scale;
    const worldH = bufH / scale;
    // Centre the stage window on the content.
    const cx = (bounds.x || 0) + (bounds.w || 0) / 2;
    const cy = (bounds.y || 0) + (bounds.h || 0) / 2;
    return {
      x: cx - worldW / 2,
      y: cy - worldH / 2,
      scale,
      bufW,
      bufH,
      worldW,
      worldH,
      // false when the content is so large that even the minimum scale cannot
      // fit it into the buffer — the caller should warn rather than pretend.
      fits: contentW * scale <= bufW + 0.5 && contentH * scale <= bufH + 0.5,
      contentW,
      contentH,
    };
  }

  const worldToStageX = (st, wx) => (wx - st.x) * st.scale;
  const worldToStageY = (st, wy) => (wy - st.y) * st.scale;
  const stageToWorldX = (st, px) => st.x + px / st.scale;
  const stageToWorldY = (st, py) => st.y + py / st.scale;

  /** A stage window as a world rect (used when compositing stage buffers). */
  function stageWorldRect(st) {
    return { x: st.x, y: st.y, w: st.bufW / st.scale, h: st.bufH / st.scale };
  }

  /* ───────────────────────── misc rect helpers ─────────────────────────── */

  function unionRect(a, b) {
    if (!a) return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
    if (!b) return { x: a.x, y: a.y, w: a.w, h: a.h };
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      w: Math.max(a.x + a.w, b.x + b.w) - x,
      h: Math.max(a.y + a.h, b.y + b.h) - y,
    };
  }

  function inflateRect(r, pad) {
    if (!r) return null;
    return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  }

  /** Bounds of every visible layer (motion included). */
  function contentBounds(layers, duration, opts) {
    const o = opts || {};
    let acc = null;
    (layers || []).forEach((l) => {
      if (o.visibleOnly !== false && l.visible === false) return;
      acc = unionRect(acc, layerWorldRect(l, duration));
    });
    return acc;
  }

  /** Camera pose that frames `rect` inside the output surface. */
  function fitRectPose(rect, frameW, frameH, opts) {
    const o = opts || {};
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) {
      return makePose(frameW / 2, frameH / 2, 1, 0);
    }
    const pad = o.pad == null ? 1.08 : o.pad;
    const viewW = rect.w * pad;
    const viewH = rect.h * pad;
    // The view rect has the frame's aspect; find the zoom that contains rect.
    const zoom = Math.min(frameW / viewW, frameH / viewH);
    return makePose(
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      clamp(zoom, o.minZoom || 0.02, o.maxZoom || 40),
      o.rot || 0
    );
  }

  /** World-space length that corresponds to `px` output pixels. */
  function pxToWorld(t, px) {
    return px / (t.scale || 1);
  }
  function worldToPx(t, w) {
    return w * (t.scale || 1);
  }

  return {
    // helpers
    clamp, lerp, easeNamed, EASINGS, EASING_NAMES, isFiniteNum,
    // pose
    makePose, clonePose, viewRect, viewTransform,
    worldToScreen, screenToWorld, applyCanvasTransform, zoomAboutScreen,
    // keys
    makeKey, reserveKeyId, sortKeys, poseAtKeys, keysDuration,
    // motion
    evalMotion, layerWorldRect,
    // follow
    followPose, evalCamera,
    // scenes
    makeScene, sceneAt, scenesDuration,
    // stage
    fitStage, worldToStageX, worldToStageY, stageToWorldX, stageToWorldY, stageWorldRect,
    // rects
    unionRect, inflateRect, contentBounds, fitRectPose,
    pxToWorld, worldToPx,
  };
});
