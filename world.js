/* =============================================================================
 * world.js — Inkplainer infinite-canvas integration layer
 * -----------------------------------------------------------------------------
 * Inkplainer OS · Apache License 2.0
 *
 * This file turns the original fixed-canvas editor into an infinite virtual
 * workspace with a movable, animatable camera, WITHOUT replacing the existing
 * drawing engine.
 *
 * HOW IT WORKS (read camera.js for the coordinate-system definitions)
 * ------------------------------------------------------------------
 * The original engine renders into fixed-size offscreen buffers the size of the
 * export frame.  Those buffers are kept exactly as they are.  What changes is
 * that a buffer is no longer "the canvas" — it is a *stage*: a bounded window
 * into the infinite world, positioned and scaled by `state.stage`.
 *
 *      world  ──(stage)──>  stage buffer px  ──(camera)──>  screen px
 *
 * Everything the engine already does (outline detection, chunk reveals, ink
 * waypoints, the hand sprite, …) keeps operating in stage pixels, so the
 * drawing algorithms are untouched.  Only the two ends of the chain change:
 *
 *   · preRender() now draws the layer into the offscreen through the stage
 *     transform, so a layer can live anywhere in the world.
 *   · the composite step now draws each finished buffer into the output through
 *     the camera transform instead of blitting it at (0,0).
 *
 * The editor viewport and the exported frame run the SAME composite function
 * (renderFrameTo), which is what guarantees "what you preview is what you
 * export".  The only difference is the output pixel size, plus two
 * editor-only decorations (world grid and frame outline) that are switched off
 * for export.
 *
 * Backwards compatibility: with the default camera (centred on the frame,
 * zoom 1) and the default stage (origin 0,0, scale 1) world coordinates are
 * numerically identical to the old canvas coordinates, so every existing
 * project, recipe and saved file keeps working unchanged.
 *
 * Everything here is additive: existing functions are wrapped or replaced, and
 * every replacement keeps the original name and call signature.
 * ========================================================================== */

(function () {
  'use strict';

  const K = window.InkCamera;
  if (!K) { console.error('[world.js] camera.js must be loaded before world.js'); return; }

  const $ = (id) => document.getElementById(id);
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /* ═══════════════════════════════════════════════════════════════════════
   * 1. VIEWPORT METRICS
   * ═════════════════════════════════════════════════════════════════════ */

  const VP = { w: 1280, h: 720, cssW: 1280, cssH: 720, dpr: 1 };

  /** Cap the backing-store resolution so a phone does not allocate a huge
   *  canvas for a high-DPI screen (8 GB Android phones still get killed for
   *  a 3× 1080p backing store). */
  const MAX_VIEWPORT_PIXELS = 2_400_000; // ~2.4 Mpx ≈ 1600×1500
  function pickDpr(cssW, cssH) {
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = cssW * cssH * dpr * dpr;
    if (px > MAX_VIEWPORT_PIXELS) dpr = Math.max(1, dpr * Math.sqrt(MAX_VIEWPORT_PIXELS / px));
    return dpr;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 2. STATE DEFAULTS
   * ═════════════════════════════════════════════════════════════════════ */

  function defaultCamera() {
    return { x: state.canvasW / 2, y: state.canvasH / 2, zoom: 1, rot: 0 };
  }
  function defaultStage() {
    return {
      x: 0, y: 0, scale: 1,
      bufW: state.canvasW, bufH: state.canvasH,
      worldW: state.canvasW, worldH: state.canvasH,
    };
  }
  function defaultRig() {
    return {
      keys: [],
      scenes: [],
      duration: 8,
      follow: {
        enabled: false, layerId: null,
        screenX: 0.5, screenY: 0.5,
        smoothing: 0.25, zoom: null,
        offsetX: 0, offsetY: 0,
      },
    };
  }

  function ensureWorldState() {
    if (!state.camera) state.camera = defaultCamera();
    if (!state.homeCamera) state.homeCamera = defaultCamera();
    if (!state.stage) state.stage = defaultStage();
    if (!state.camRig) state.camRig = defaultRig();
    if (!state.camRig.follow) state.camRig.follow = defaultRig().follow;
    if (!Array.isArray(state.camRig.keys)) state.camRig.keys = [];
    if (!Array.isArray(state.camRig.scenes)) state.camRig.scenes = [];
    if (state.showGrid === undefined) state.showGrid = true;
    if (state.showFrame === undefined) state.showFrame = true;
    if (state.clock === undefined) state.clock = 0;
    if (state._frameScale === undefined) state._frameScale = 1;
    if (state._camSmooth === undefined) state._camSmooth = {};
    if (state.navTool === undefined) state.navTool = 'select';
    if (!state.stage.bufW) { state.stage.bufW = state.canvasW; state.stage.bufH = state.canvasH; }
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 3. STAGE HELPERS
   * ═════════════════════════════════════════════════════════════════════ */

  /** setTransform matrix mapping STAGE buffer pixels -> WORLD units. */
  function stageToWorldMatrix() {
    const st = state.stage;
    const s = 1 / (st.scale || 1);
    return { a: s, b: 0, c: 0, d: s, e: st.x, f: st.y };
  }
  /** setTransform matrix mapping WORLD units -> STAGE buffer pixels. */
  function worldToStageMatrix() {
    const st = state.stage;
    const s = st.scale || 1;
    return { a: s, b: 0, c: 0, d: s, e: -st.x * s, f: -st.y * s };
  }
  /** world -> screen matrix (camera), composed with the stage matrix. */
  function stageToScreenMatrix(T) {
    const S = stageToWorldMatrix();
    return {
      a: T.a * S.a + T.c * S.b,
      b: T.b * S.a + T.d * S.b,
      c: T.a * S.c + T.c * S.d,
      d: T.b * S.c + T.d * S.d,
      e: T.a * S.e + T.c * S.f + T.e,
      f: T.b * S.e + T.d * S.f + T.f,
    };
  }
  function applyMat(c, m) { c.setTransform(m.a, m.b, m.c, m.d, m.e, m.f); }

  /** Draw a stage-sized buffer (offscreen / slot canvas / bgCanvas / hand) at
   *  its place in the world.  Call with the camera transform already applied. */
  function drawStageBuffer(c, buf) {
    if (!buf || !buf.width || !buf.height) return;
    const st = state.stage;
    c.drawImage(buf, st.x, st.y, st.bufW / st.scale, st.bufH / st.scale);
  }

  /** Apply the WORLD -> STAGE transform to a buffer context. */
  function applyStageTransform(c) { applyMat(c, worldToStageMatrix()); }

  /** Choose + apply a stage that covers the given world bounds. */
  function setStageForBounds(bounds, desiredScale) {
    const st = K.fitStage(bounds || { x: 0, y: 0, w: state.canvasW, h: state.canvasH },
      state.canvasW, state.canvasH,
      { pad: 48, desiredScale: desiredScale == null ? state.camera.zoom : desiredScale });
    const changed = !state.stage || state.stage.x !== st.x || state.stage.y !== st.y ||
      state.stage.scale !== st.scale;
    state.stage = st;
    if (changed) rebuildBaked();
    if (!st.fits && !state._stageWarned && window.showToast) {
      state._stageWarned = true;
      showToast('⚠ Content is larger than the drawing buffer — split it into smaller layers for full quality');
    }
    return st;
  }

  /** Reset the stage to the identity (world == stage px). */
  function resetStage() {
    state.stage = defaultStage();
    state._bakedSnap = null;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 4. BACKGROUND (drawn in SCREEN space so it covers the whole output)
   * ═════════════════════════════════════════════════════════════════════ */

  let _bgTile = null, _bgTileKey = '';

  function bgTileKey() {
    const bg = state.canvasBg || { type: 'solid', val: 'white' };
    return `${bg.type}|${bg.val}|${bg.key || ''}`;
  }

  /**
   * The background presets are authored in frame coordinates.  We render one
   * into a small cached tile and stretch it over the output, which gives an
   * "infinite" background without allocating a world-sized bitmap.
   */
  function getBgTile() {
    const key = bgTileKey();
    if (_bgTile && _bgTileKey === key) return _bgTile;
    const bg = state.canvasBg || { type: 'solid', val: 'white' };
    if (bg.type === 'solid') { _bgTile = null; _bgTileKey = key; return null; }

    const TILE = 512;
    const cv = document.createElement('canvas');
    cv.width = TILE; cv.height = TILE;
    const c = cv.getContext('2d');
    // The gradient functions measure themselves against state.canvasW/H.
    const sw = state.canvasW, sh = state.canvasH;
    try {
      state.canvasW = TILE; state.canvasH = TILE;
      if (bg.type === 'gradient' && window.BG_GRADIENTS && window.BG_GRADIENTS[bg.key]) {
        c.save(); window.BG_GRADIENTS[bg.key](c); c.restore();
      } else if (bg.type === 'custom') {
        c.fillStyle = bg.val; c.fillRect(0, 0, TILE, TILE);
      } else {
        c.fillStyle = '#ffffff'; c.fillRect(0, 0, TILE, TILE);
      }
    } finally {
      state.canvasW = sw; state.canvasH = sh;
    }
    _bgTile = cv; _bgTileKey = key;
    return _bgTile;
  }

  function drawCheckerboard(c, w, h) {
    const S = Math.max(8, Math.round(Math.min(w, h) / 24));
    c.fillStyle = '#e9e9ec'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#f7f7f9';
    for (let y = 0; y < h; y += S) {
      for (let x = 0; x < w; x += S) {
        if (((x / S) + (y / S)) % 2 === 0) c.fillRect(x, y, S, S);
      }
    }
  }

  /** Paint the background over an entire output surface, in screen space. */
  function drawBgScreen(c, w, h) {
    const bg = state.canvasBg || { type: 'solid', val: 'white' };
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    if (bg.type === 'solid') {
      if (bg.val === 'transparent') { drawCheckerboard(c, w, h); return; }
      c.fillStyle = (bg.val === 'white') ? '#ffffff' : bg.val;
      c.fillRect(0, 0, w, h);
      return;
    }
    const tile = getBgTile();
    if (tile) {
      // Cover the surface (the tile aspect rarely matches, so scale to cover).
      c.drawImage(tile, 0, 0, w, h);
    } else {
      c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 5. WORLD CONTENT
   * ═════════════════════════════════════════════════════════════════════ */

  /** Centre of a layer in world units, honouring its motion path. */
  function layerCenter(layer) {
    if (!layer) return { x: 0, y: 0 };
    const m = K.evalMotion(layer.motion, state.clock);
    if (m) return { x: m.x, y: m.y };
    return { x: layer.x + layer.w / 2, y: layer.y + layer.h / 2 };
  }
  /** Top-left of a layer in world units, honouring its motion path. */
  function layerTopLeft(layer) {
    if (!layer) return { x: 0, y: 0 };
    const m = K.evalMotion(layer.motion, state.clock);
    if (m) return { x: m.x - layer.w / 2, y: m.y - layer.h / 2 };
    return { x: layer.x, y: layer.y };
  }
  function isDirectLayer(l) {
    return !!l && (l.kind === 'shape' || l.animStyle === 'none');
  }

  function drawShapeLayer(c, layer) {
    const p = layerTopLeft(layer);
    const x = p.x, y = p.y, w = layer.w, h = layer.h;
    c.save();
    c.globalAlpha = layer.opacity == null ? 1 : layer.opacity;
    c.beginPath();
    const shape = layer.shape || 'circle';
    if (shape === 'rect') {
      const r = Math.min(24, Math.min(w, h) * (layer.radiusPct != null ? layer.radiusPct / 100 : 0.18));
      c.moveTo(x + r, y);
      c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
      c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
      c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
      c.closePath();
    } else if (shape === 'triangle') {
      c.moveTo(x + w / 2, y); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath();
    } else if (shape === 'line') {
      c.moveTo(x, y + h / 2); c.lineTo(x + w, y + h / 2);
    } else {
      c.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
    }
    if (layer.fill && layer.fill !== 'none') { c.fillStyle = layer.fill; c.fill(); }
    if (layer.stroke && layer.strokeWidth > 0) {
      c.lineWidth = layer.strokeWidth; c.strokeStyle = layer.stroke; c.lineJoin = 'round'; c.stroke();
    }
    c.restore();
  }

  /** Draw one layer (image or shape) at its current world position. */
  function drawLayerWorld(c, layer) {
    if (!layer || layer.visible === false) return;
    if (layer.kind === 'shape') { drawShapeLayer(c, layer); return; }
    if (!layer.img) return;
    const p = layerTopLeft(layer);
    c.save();
    c.globalAlpha = layer.opacity == null ? 1 : layer.opacity;
    if (layer.w < 64 && layer.h < 64) c.imageSmoothingEnabled = false;
    c.drawImage(layer.img, p.x, p.y, layer.w, layer.h);
    c.restore();
  }

  /** Rebuild state.bgCanvas after the stage moved.  The last bake is kept as a
   *  {canvas, worldRect} snapshot so previously completed content keeps its
   *  place in the world even though its pixel buffer was stage-aligned. */
  function rebuildBaked() {
    const snap = state._bakedSnap;
    if (!snap || !snap.canvas) { state.bgCanvas = null; return; }
    const cv = document.createElement('canvas');
    cv.width = state.canvasW; cv.height = state.canvasH;
    const c = cv.getContext('2d');
    applyStageTransform(c);
    c.drawImage(snap.canvas, snap.rect.x, snap.rect.y, snap.rect.w, snap.rect.h);
    state.bgCanvas = cv;
  }

  function drawBakedContent(c) {
    if (state.bgCanvas) drawStageBuffer(c, state.bgCanvas);
    if (state._extraBaked) state._extraBaked.forEach((b) => drawStageBuffer(c, b));
  }

  /** Layers that are not drawn by the hand engine (shapes / motion layers). */
  function drawDirectLayers(c, mode) {
    const groups = state._animGroups || [];
    const gpos = state._groupPos || 0;
    let minIdx = Infinity, maxIdx = -Infinity;
    const cur = groups[gpos];
    if (cur && cur.length) {
      cur.forEach((l) => {
        const i = state.layers.indexOf(l);
        if (i >= 0) { minIdx = Math.min(minIdx, i); maxIdx = Math.max(maxIdx, i); }
      });
    }
    state.layers.forEach((l, i) => {
      if (!isDirectLayer(l) || l.visible === false) return;
      const above = i > maxIdx;
      if (mode === 'above' && !above) return;
      if (mode === 'below' && above) return;
      drawLayerWorld(c, l);
    });
  }

  /**
   * Draw the world (background is painted separately).
   * `c` must already have the camera transform applied.
   */
  function drawWorldContent(c) {
    const slots = state._activeSlots || [];
    if (slots.length) {
      drawBakedContent(c);
      drawDirectLayers(c, 'below');
      slots.forEach((s) => drawStageBuffer(c, s.canvas));
      drawDirectLayers(c, 'above');
      return;
    }
    if (state.bgCanvas) drawBakedContent(c);
    state.layers.forEach((l) => drawLayerWorld(c, l));
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 6. EDITOR-ONLY DECORATIONS (world grid + frame outline)
   * ═════════════════════════════════════════════════════════════════════ */

  function worldVisibleRect(T) {
    const a = K.screenToWorld(T, 0, 0);
    const b = K.screenToWorld(T, T.outW, 0);
    const d = K.screenToWorld(T, 0, T.outH);
    const e = K.screenToWorld(T, T.outW, T.outH);
    const xs = [a.x, b.x, d.x, e.x], ys = [a.y, b.y, d.y, e.y];
    const x = Math.min.apply(null, xs), y = Math.min.apply(null, ys);
    return { x, y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
  }

  function drawWorldGrid(c, T) {
    if (!state.showGrid) return;
    const r = worldVisibleRect(T);
    if (!(r.w > 0)) return;
    let step = 50;
    while (step * T.scale < 14) step *= 5;
    while (step * T.scale > 140) step /= 5;
    const lw = 1 / T.scale;
    c.save();
    c.lineWidth = lw;
    c.strokeStyle = 'rgba(90,110,140,0.13)';
    c.beginPath();
    const x0 = Math.floor(r.x / step) * step, x1 = r.x + r.w;
    const y0 = Math.floor(r.y / step) * step, y1 = r.y + r.h;
    for (let x = x0; x <= x1; x += step) { c.moveTo(x, y0); c.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += step) { c.moveTo(x0, y); c.lineTo(x1, y); }
    c.stroke();
    // Origin axes, slightly stronger, so the user can always find home.
    c.strokeStyle = 'rgba(90,110,140,0.28)';
    c.beginPath();
    c.moveTo(0, y0); c.lineTo(0, y1);
    c.moveTo(x0, 0); c.lineTo(x1, 0);
    c.stroke();
    c.restore();
  }

  /** Outline of the exported frame inside the (letterboxed) editor viewport. */
  function drawFrameOutline(c, T) {
    if (!state.showFrame) return;
    const viewW = (state.canvasW / state.camera.zoom) * T.scale;
    const viewH = (state.canvasH / state.camera.zoom) * T.scale;
    const x = T.outW / 2 - viewW / 2, y = T.outH / 2 - viewH / 2;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.strokeStyle = 'rgba(20,20,25,0.35)';
    c.lineWidth = 1;
    c.setLineDash([6, 5]);
    c.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(viewW), Math.round(viewH));
    c.setLineDash([]);
    c.restore();
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 7. THE SHARED RENDERER (preview + export)
   * ═════════════════════════════════════════════════════════════════════ */

  /**
   * Render one complete frame of the composition into `c` at outW × outH px.
   * This is the single source of truth for both the editor preview and the
   * exported video frame.
   */
  function renderFrameTo(c, outW, outH, opts) {
    const o = opts || {};
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, outW, outH);
    drawBgScreen(c, outW, outH);
    c.save();
    K.applyCanvasTransform(c, T);
    if (o.grid) drawWorldGrid(c, T);
    drawWorldContent(c);
    if (o.hand !== false) drawStageBuffer(c, handCanvas);
    c.restore();
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (o.frameOutline) drawFrameOutline(c, T);
    return T;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 8. VIEWPORT SIZING  (replaces fitCanvas)
   * ═════════════════════════════════════════════════════════════════════ */

  const visibleCanvases = [];
  function registerVisibleCanvas(el) { if (el && visibleCanvases.indexOf(el) < 0) visibleCanvases.push(el); }

  window.fitCanvas = function fitCanvas() {
    const area = $('canvas-area');
    const wrap = $('canvas-wrapper');
    if (!area || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const cssW = Math.max(80, Math.round(r.width));
    const cssH = Math.max(80, Math.round(r.height));
    if (!cssW || !cssH) return;
    const dpr = pickDpr(cssW, cssH);
    const w = Math.max(80, Math.round(cssW * dpr));
    const h = Math.max(80, Math.round(cssH * dpr));
    VP.cssW = cssW; VP.cssH = cssH; VP.dpr = dpr;
    if (VP.w !== w || VP.h !== h) { VP.w = w; VP.h = h; }
    visibleCanvases.forEach((el) => {
      if (!el) return;
      if (el.width !== w) el.width = w;
      if (el.height !== h) el.height = h;
      el.style.width = '100%';
      el.style.height = '100%';
    });
    renderViewport();
  };

  /** Overlay canvases (selection / crop / outline) are erased with a full
   *  clear regardless of the rect the legacy code passes. */
  function patchFullClear(c2d) {
    if (!c2d || c2d.__inkFullClear) return;
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.clearRect;
    c2d.clearRect = function () {
      const m = this.getTransform ? this.getTransform() : null;
      if (m) this.setTransform(1, 0, 0, 1, 0, 0);
      orig.call(this, 0, 0, this.canvas.width, this.canvas.height);
      if (m) this.setTransform(m);
    };
    c2d.__inkFullClear = true;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 9. VIEWPORT RENDER  (replaces redrawLayersOnCanvas)
   * ═════════════════════════════════════════════════════════════════════ */

  function renderViewport() {
    if (!_mainCtx) return;
    ensureViewport();
    renderFrameTo(_mainCtx, VP.w, VP.h, { grid: true, frameOutline: true, hand: true });
    drawSelectionHandles();
    if (window._cropState && typeof window._drawCropOverlay === 'function') window._drawCropOverlay();
    updateCameraHud();
    drawMinimap();
  }

  function ensureViewport() {
    if (!VP.w || !VP.h || VP.w !== (_mainCtx.canvas && _mainCtx.canvas.width)) {
      if (_mainCtx && _mainCtx.canvas) { VP.w = _mainCtx.canvas.width; VP.h = _mainCtx.canvas.height; }
    }
  }

  window.redrawLayersOnCanvas = function redrawLayersOnCanvas() { renderViewport(); };

  /* ── selection handles, drawn in world space with a screen-constant size ── */
  window.drawSelectionHandles = function drawSelectionHandles() {
    if (!sctx) return;
    patchFullClear(sctx);
    sctx.clearRect();
    const layer = getSelectedLayer();
    if (!layer || state.playing) return;
    const p = layerTopLeft(layer);
    const x = p.x, y = p.y, w = layer.w, h = layer.h;
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, sctx.canvas.width, sctx.canvas.height);
    const inv = 1 / (T.scale || 1);
    const R = 6 * inv * (VP.dpr || 1);
    const LW = 2 * inv * (VP.dpr || 1);
    sctx.save();
    K.applyCanvasTransform(sctx, T);
    sctx.strokeStyle = '#6c63ff';
    sctx.lineWidth = LW;
    sctx.setLineDash([5 * inv, 3 * inv]);
    sctx.strokeRect(x, y, w, h);
    sctx.setLineDash([]);
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    corners.forEach(([cx, cy]) => {
      sctx.fillStyle = '#6c63ff';
      sctx.beginPath(); sctx.arc(cx, cy, R, 0, Math.PI * 2); sctx.fill();
      sctx.strokeStyle = '#fff'; sctx.lineWidth = LW * 0.75; sctx.stroke();
    });
    const mids = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
    mids.forEach(([cx, cy]) => {
      sctx.fillStyle = '#fff';
      sctx.beginPath(); sctx.arc(cx, cy, R * 0.66, 0, Math.PI * 2); sctx.fill();
      sctx.strokeStyle = '#6c63ff'; sctx.lineWidth = LW * 0.75; sctx.stroke();
    });
    sctx.restore();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 10. COORDINATE CONVERSION FOR INPUT (replaces toCanvasCoords)
   * ═════════════════════════════════════════════════════════════════════ */

  /** Screen (client) point -> world point. */
  function clientToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, VP.w, VP.h);
    const sx = ((clientX - rect.left) / rect.width) * VP.w;
    const sy = ((clientY - rect.top) / rect.height) * VP.h;
    return K.screenToWorld(T, sx, sy);
  }
  window.toCanvasCoords = function toCanvasCoords(e) { return clientToWorld(e.clientX, e.clientY); };
  window.clientToWorld = clientToWorld;

  window.getCanvasScale = function getCanvasScale() {
    // Legacy callers use this to convert screen px -> canvas px.  With a camera
    // the answer is the number of WORLD units per screen CSS pixel.
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return 1;
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, VP.w, VP.h);
    return 1 / ((T.scale * VP.w) / rect.width);
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 11. CAMERA CONTROL API
   * ═════════════════════════════════════════════════════════════════════ */

  const ZOOM_MIN = 0.02, ZOOM_MAX = 40;

  function setCamera(x, y, zoom, rot) {
    state.camera.x = x;
    state.camera.y = y;
    if (zoom != null) state.camera.zoom = K.clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    if (rot != null) state.camera.rot = rot;
    renderViewport();
  }
  function panCameraByScreen(dxScreen, dyScreen) {
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, VP.w, VP.h);
    const a = K.screenToWorld(T, 0, 0);
    const b = K.screenToWorld(T, dxScreen, dyScreen);
    state.camera.x -= (b.x - a.x);
    state.camera.y -= (b.y - a.y);
    renderViewport();
  }
  function zoomCameraAt(factor, sx, sy) {
    state.camera = K.zoomAboutScreen(state.camera, state.canvasW, state.canvasH,
      VP.w, VP.h, sx, sy, factor, ZOOM_MIN, ZOOM_MAX);
    renderViewport();
  }
  function setHomeCamera(pose) {
    state.homeCamera = K.clonePose(pose || state.camera);
  }
  window.camHome = function camHome() {
    setCamera(state.homeCamera.x, state.homeCamera.y, state.homeCamera.zoom, state.homeCamera.rot);
    updateCameraHud();
  };
  window.camSetHome = function camSetHome() {
    setHomeCamera(state.camera);
    if (window.showToast) showToast('Home view saved');
    scheduleAutoSave();
  };
  window.camFitAll = function camFitAll() {
    const b = K.contentBounds(state.layers, camTimelineDuration(), { visibleOnly: true });
    const pose = b
      ? K.fitRectPose(K.inflateRect(b, 40), state.canvasW, state.canvasH, { pad: 1.06 })
      : defaultCamera();
    setCamera(pose.x, pose.y, pose.zoom, pose.rot);
  };
  window.camCenterSelected = function camCenterSelected() {
    const l = getSelectedLayer();
    if (!l) { if (window.showToast) showToast('Select a layer first'); return; }
    const c = layerCenter(l);
    setCamera(c.x, c.y, state.camera.zoom, state.camera.rot);
  };
  window.camZoomButton = function camZoomButton(factor) {
    zoomCameraAt(factor, VP.w / 2, VP.h / 2);
  };
  window.camZoomReset = function camZoomReset() {
    const c = state.camera;
    setCamera(c.x, c.y, 1, c.rot);
  };
  window.camToggleGrid = function camToggleGrid() {
    state.showGrid = !state.showGrid;
    const b = $('btn-cam-grid'); if (b) b.classList.toggle('active', state.showGrid);
    renderViewport();
    scheduleAutoSave();
  };
  window.camToggleFrame = function camToggleFrame() {
    state.showFrame = !state.showFrame;
    const b = $('btn-cam-frame'); if (b) b.classList.toggle('active', state.showFrame);
    renderViewport();
    scheduleAutoSave();
  };
  window.camSetTool = function camSetTool(tool) {
    state.navTool = tool;
    const b1 = $('btn-tool-select'), b2 = $('btn-tool-nav');
    if (b1) b1.classList.toggle('active', tool === 'select');
    if (b2) b2.classList.toggle('active', tool === 'nav');
    const wrap = $('canvas-wrapper');
    if (wrap) wrap.classList.toggle('nav-mode', tool === 'nav');
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 12. NAVIGATION INPUT (mouse + touch)
   * ═════════════════════════════════════════════════════════════════════ */

  const nav = {
    pointers: new Map(),
    mode: null,       // 'pan' | 'pinch'
    startDist: 0,
    startCx: 0, startCy: 0,
    lastCx: 0, lastCy: 0,
    moved: false,
    spaceDown: false,
  };

  function canvasRect() { return canvas.getBoundingClientRect(); }

  function pointerOverCanvas(e) {
    const t = e.target;
    return t === canvas || t === selectCanvas || t === handCanvas || t === $('crop-canvas');
  }
  function screenFromClient(clientX, clientY) {
    const r = canvasRect();
    return {
      x: ((clientX - r.left) / (r.width || 1)) * VP.w,
      y: ((clientY - r.top) / (r.height || 1)) * VP.h,
    };
  }
  function hitAnythingWorld(clientX, clientY) {
    const w = clientToWorld(clientX, clientY);
    const sel = getSelectedLayer();
    if (sel) {
      const p = layerTopLeft(sel);
      const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, VP.w, VP.h);
      const tol = 14 / (T.scale || 1);
      if (w.x >= p.x - tol && w.x <= p.x + sel.w + tol && w.y >= p.y - tol && w.y <= p.y + sel.h + tol) return true;
    }
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      const p = layerTopLeft(l);
      if (w.x >= p.x && w.x <= p.x + l.w && w.y >= p.y && w.y <= p.y + l.h) return true;
    }
    return false;
  }

  function isPanGesture(e) {
    if (state.navTool === 'nav') return true;
    if (e.pointerType === 'touch') return !hitAnythingWorld(e.clientX, e.clientY);
    if (e.button === 1 || e.button === 2) return true;      // middle / right drag
    if (nav.spaceDown) return true;                          // space + drag
    return !hitAnythingWorld(e.clientX, e.clientY);          // empty space
  }

  function onPointerDown(e) {
    if (state.playing) return;
    if (!pointerOverCanvas(e)) return;
    if (window._cropState) return;                  // crop tool owns the canvas
    if (window._ts && window._ts.placing) return;   // text placement owns clicks

    nav.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    nav.moved = false;

    if (nav.pointers.size === 2) {
      const pts = [...nav.pointers.values()];
      nav.startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      nav.mode = 'pinch';
      if (window._interact) { window._interact = null; }
      e.stopPropagation(); e.preventDefault();
      return;
    }
    if (nav.pointers.size === 1 && isPanGesture(e)) {
      nav.mode = 'pan';
      nav.lastCx = e.clientX; nav.lastCy = e.clientY;
      e.stopPropagation(); e.preventDefault();
    }
  }

  function onPointerMove(e) {
    if (!nav.pointers.has(e.pointerId)) return;
    nav.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (nav.mode === 'pinch' && nav.pointers.size >= 2) {
      const pts = [...nav.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      const s = screenFromClient(cx, cy);
      const factor = dist / nav.startDist;
      state.camera = K.zoomAboutScreen(state.camera, state.canvasW, state.canvasH,
        VP.w, VP.h, s.x, s.y, factor, ZOOM_MIN, ZOOM_MAX);
      nav.startDist = dist;
      // Two-finger drag also pans.
      if (nav.lastCx || nav.lastCy) {
        const r = canvasRect();
        panCameraByScreen(-(cx - nav.lastCx) * (VP.w / (r.width || 1)), -(cy - nav.lastCy) * (VP.h / (r.height || 1)));
      }
      nav.lastCx = cx; nav.lastCy = cy;
      nav.moved = true;
      renderViewport();
      e.stopPropagation(); e.preventDefault();
      return;
    }
    if (nav.mode === 'pan') {
      const r = canvasRect();
      const dx = (e.clientX - nav.lastCx) * (VP.w / (r.width || 1));
      const dy = (e.clientY - nav.lastCy) * (VP.h / (r.height || 1));
      if (Math.abs(dx) + Math.abs(dy) > 0.5) nav.moved = true;
      panCameraByScreen(-dx, -dy);
      nav.lastCx = e.clientX; nav.lastCy = e.clientY;
      e.stopPropagation(); e.preventDefault();
    }
  }

  function onPointerUp(e) {
    if (!nav.pointers.has(e.pointerId)) return;
    nav.pointers.delete(e.pointerId);
    if (nav.pointers.size < 2 && nav.mode === 'pinch') nav.mode = nav.pointers.size ? 'pan' : null;
    if (nav.pointers.size === 0) {
      if (nav.mode === 'pan' && nav.moved) {
        // Swallow the click that follows a pan so it cannot also select/deselect.
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        selectCanvas.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => selectCanvas.removeEventListener('click', swallow, { capture: true }), 0);
      }
      nav.mode = null;
      nav.lastCx = 0; nav.lastCy = 0;
      scheduleAutoSave();
    }
  }

  function onWheel(e) {
    if (!pointerOverCanvas(e)) return;
    e.preventDefault();
    const s = screenFromClient(e.clientX, e.clientY);
    const factor = Math.pow(0.9988, e.deltaY * (e.deltaMode === 1 ? 16 : 1));
    state.camera = K.zoomAboutScreen(state.camera, state.canvasW, state.canvasH,
      VP.w, VP.h, s.x, s.y, factor, ZOOM_MIN, ZOOM_MAX);
    renderViewport();
    clearTimeout(onWheel._t);
    onWheel._t = setTimeout(scheduleAutoSave, 400);
  }

  function bindNavigation() {
    const wrap = $('canvas-wrapper');
    if (!wrap) return;
    const opts = { capture: true, passive: false };
    wrap.addEventListener('pointerdown', onPointerDown, opts);
    wrap.addEventListener('pointermove', onPointerMove, opts);
    wrap.addEventListener('pointerup', onPointerUp, opts);
    wrap.addEventListener('pointercancel', onPointerUp, opts);
    wrap.addEventListener('wheel', onWheel, opts);
    // Stop the browser from scrolling/zooming the page while navigating.
    ['touchstart', 'touchmove', 'touchend'].forEach((t) => {
      wrap.addEventListener(t, (e) => {
        if (nav.pointers.size > 0 || nav.mode) e.preventDefault();
      }, opts);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) { nav.spaceDown = true; }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') nav.spaceDown = false; });
  }
  function isTypingTarget(el) {
    if (!el) return false;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 13. PLAYBACK CLOCK + CAMERA DRIVING
   * ═════════════════════════════════════════════════════════════════════ */

  function camTimelineDuration() {
    const rig = state.camRig;
    let d = rig.duration || 0;
    d = Math.max(d, K.keysDuration(rig.keys, 0));
    d = Math.max(d, K.scenesDuration(rig.scenes, 0));
    return d;
  }

  function resetCamSmooth() { state._camSmooth = {}; }

  function updateCamera(dt) {
    const rig = state.camRig;
    if (!rig) return;
    const follow = rig.follow || {};
    let target = null;
    if (follow.enabled && follow.layerId != null) {
      const l = getLayerById(follow.layerId);
      if (l) {
        const c = layerCenter(l);
        target = { x: c.x + (follow.offsetX || 0), y: c.y + (follow.offsetY || 0) };
      }
    }
    const hasKeys = !!(rig.keys && rig.keys.length);
    if (!target && !hasKeys) return;   // manual camera — nothing to drive
    const pose = K.evalCamera(rig, state.clock, {
      frameW: state.canvasW, frameH: state.canvasH,
      target, dt: dt || 1 / 30,
      smoothing: state._camSmooth,
      fallback: state.homeCamera,
    });
    state.camera.x = pose.x;
    state.camera.y = pose.y;
    state.camera.zoom = pose.zoom;
    state.camera.rot = pose.rot;
  }

  const _origStartAnim = window.startAnim;
  window.startAnim = function startAnim() {
    state._lastTs = 0;
    _origStartAnim();
  };

  const _origResetAnim = window.resetAnim;
  window.resetAnim = function resetAnim() {
    state.clock = 0;
    resetCamSmooth();
    state._lastTs = 0;
    _origResetAnim();
    updateCameraHud();
  };

  const _origTogglePlay = window.togglePlay;
  window.togglePlay = function togglePlay() {
    if (state.done) { state.clock = 0; resetCamSmooth(); }
    state._lastTs = 0;
    _origTogglePlay();
  };

  const _origRestartAnim = window.restartAnim;
  window.restartAnim = function restartAnim() {
    state.clock = 0;
    resetCamSmooth();
    state._lastTs = 0;
    _origRestartAnim();
  };

  /**
   * Time-based playback.  The original engine advanced one "speed unit" per
   * animation frame, which made the animation run twice as fast on a 60 Hz
   * screen as on a 30 Hz one and made exports drift.  We scale the step by the
   * real elapsed time (normalised to 30 fps) and drive the camera from the same
   * clock, so preview and export agree and dropped frames no longer change the
   * timing of the movie — they only drop a sample.
   */
  window.animate = function animate() {
    if (!state.playing) return;
    const now = nowMs();
    let dt = state._lastTs ? (now - state._lastTs) / 1000 : 1 / 30;
    state._lastTs = now;
    dt = Math.min(0.25, Math.max(0.0005, dt));
    state.clock += dt;
    state._frameScale = dt * 30;
    updateCamera(dt);

    if (state._activeSlots && state._activeSlots.some((s) => !s.done)) {
      AnimationEngine._tickAllSlots();
      if (state.playing) state.animFrame = requestAnimationFrame(window.animate);
      return;
    }
    if (!offscreen) return;
    const slider = $('speed-slider');
    const baseSpeed = slider ? parseInt(slider.value) : 40;
    const speed = baseSpeed * (state._frameScale || 1);
    switch (state.animStyle) {
      case 'contour': AnimationEngine.tickContour(speed); break;
      case 'outlinechunks': AnimationEngine.tickOutlineChunks(speed); break;
      case 'outlinefill': AnimationEngine.tickOutlineFill(speed); break;
      case 'illustfill': AnimationEngine.tickIllustFill(speed); break;
      case 'outlineonly': AnimationEngine.tickOutlineOnly(speed); break;
      case 'chunkjump': AnimationEngine.tickChunkJump(speed); break;
      case 'scribble': AnimationEngine.tickScribble(speed); break;
      case 'spec-text': AnimationEngine.tickSpecText(speed); break;
      case 'spec-human': case 'spec-animal': case 'spec-portrait':
      case 'spec-vehicle': case 'spec-building': case 'spec-landscape':
      case 'spec-spiral': case 'spec-nature': AnimationEngine.tickSpecialized(speed); break;
      default: AnimationEngine.tickScanner(speed); break;
    }
    if (state.playing) state.animFrame = requestAnimationFrame(window.animate);
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 14. STAGE SELECTION PER ANIMATION GROUP
   * ═════════════════════════════════════════════════════════════════════ */

  const _origRunGroupAt = window._runGroupAt;
  window._runGroupAt = function _runGroupAt(gpos) {
    const groups = state._animGroups || [];
    const group = groups[gpos];
    if (group && group.length) {
      let bounds = null;
      group.forEach((l) => {
        if (l.visible === false) return;
        bounds = K.unionRect(bounds, K.layerWorldRect(l, camTimelineDuration()));
      });
      if (bounds) setStageForBounds(bounds, state.camera.zoom);
    }
    return _origRunGroupAt(gpos);
  };

  /* Remember where the last bake lives in the world so a stage change can
   * rebuild it (see rebuildBaked). */
  const _origFinishAnim = window.finishAnim;
  window.finishAnim = function finishAnim() {
    const stageBefore = { x: state.stage.x, y: state.stage.y, scale: state.stage.scale };
    const r = _origFinishAnim.apply(this, arguments);
    if (state.bgCanvas) {
      const st = stageBefore;
      state._bakedSnap = {
        canvas: state.bgCanvas,
        rect: { x: st.x, y: st.y, w: state.canvasW / st.scale, h: state.canvasH / st.scale },
      };
    }
    return r;
  };

  const _origGenerateNow = window._generateNow;
  window._generateNow = function _generateNow() {
    state._bakedSnap = null;
    resetCamSmooth();
    return _origGenerateNow.apply(this, arguments);
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 15. preRender — draw the layer into the offscreen through the stage
   * ═════════════════════════════════════════════════════════════════════ */

  window.preRender = function preRender(existingBgCanvas) {
    const layer = state.layers[state.activeLayerIndex];

    if (existingBgCanvas) {
      state.bgCanvas = existingBgCanvas;
    } else {
      state.bgCanvas = document.createElement('canvas');
      state.bgCanvas.width = state.canvasW;
      state.bgCanvas.height = state.canvasH;
      const bc = state.bgCanvas.getContext('2d');
      const _tmpBg = state.bgCanvas;
      state.bgCanvas = null;
      fillBg(bc);                       // transparent: the composite paints the bg
      state.bgCanvas = _tmpBg;
      const alreadyDone = (state._animQueue || []).slice(0, state._queuePos || 0);
      applyStageTransform(bc);
      alreadyDone.forEach((l) => {
        if (!l) return;
        bc.save();
        bc.globalAlpha = (l.opacity !== undefined ? l.opacity : 1);
        bc.drawImage(l.img, l.x, l.y, l.w, l.h);   // world coords
        bc.restore();
      });
      bc.setTransform(1, 0, 0, 1, 0, 0);
    }

    // offscreen: the current layer only (what the animation reveals)
    offscreen = document.createElement('canvas');
    offscreen.width = state.canvasW;
    offscreen.height = state.canvasH;
    const oc = offscreen.getContext('2d', { willReadFrequently: true });
    applyStageTransform(oc);            // world -> stage pixels
    if (layer) {
      oc.save();
      oc.globalAlpha = (layer.opacity !== undefined ? layer.opacity : 1);
      if (layer.kind === 'shape') {
        oc.fillStyle = layer.fill && layer.fill !== 'none' ? layer.fill : '#111';
        oc.fillRect(layer.x, layer.y, layer.w, layer.h);
      } else {
        oc.drawImage(layer.img, layer.x, layer.y, layer.w, layer.h);
      }
      oc.restore();
    } else {
      // Legacy text fallback (no layers): centre on the current view.
      const view = K.viewRect(state.camera, state.canvasW, state.canvasH);
      const text = ($('text-input') && $('text-input').value) || 'Hello, World!';
      const font = ($('font-select') && $('font-select').value) || 'Caveat';
      const size = parseInt(($('font-size') && $('font-size').value)) || 52;
      oc.fillStyle = state.color;
      oc.font = `${size}px '${font}'`;
      oc.textAlign = 'center';
      oc.textBaseline = 'middle';
      const lines = text.split('\n'), lineH = size * 1.3;
      const startY = view.y + view.h / 2 - (lines.length - 1) * lineH / 2;
      lines.forEach((ln, i) => oc.fillText(ln, view.x + view.w / 2, startY + i * lineH));
    }
    oc.setTransform(1, 0, 0, 1, 0, 0);

    state.contentBounds = detectContentBounds(offscreen);
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 16. BACKGROUND FILL — dispatch between buffers and the viewport
   * ═════════════════════════════════════════════════════════════════════ */

  const _origFillBg = window.fillBg;
  window.fillBg = function fillBg(c) {
    if (!c) return;
    if (c === _mainCtx) {
      // The visible canvas: paint the background across the whole surface in
      // screen space, then composite the already-completed content.
      drawBgScreen(c, c.canvas.width, c.canvas.height);
      const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, c.canvas.width, c.canvas.height);
      c.save();
      K.applyCanvasTransform(c, T);
      if (state.bgCanvas) drawStageBuffer(c, state.bgCanvas);
      c.restore();
      c.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    // Offscreen buffers stay transparent — the background is composited once,
    // in screen space, so it covers the whole world instead of only the stage.
    c.clearRect(0, 0, state.canvasW, state.canvasH);
    if (state._slotMode) return;
    if (state.bgCanvas && c.canvas !== state.bgCanvas) c.drawImage(state.bgCanvas, 0, 0);
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 17. SHAPE / MOTION LAYERS
   * ═════════════════════════════════════════════════════════════════════ */

  /** Animation queue skips layers that are not drawn by the hand engine. */
  const _origGetAnimOrder = window.getAnimOrder;
  window.getAnimOrder = function getAnimOrder() {
    const all = _origGetAnimOrder();
    return all.filter((l) => !isDirectLayer(l));
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 17b. COMPOSITE HELPERS USED BY animations.js
   * ═════════════════════════════════════════════════════════════════════ */

  function viewTransformFor(c) {
    return K.viewTransform(state.camera, state.canvasW, state.canvasH, c.canvas.width, c.canvas.height);
  }

  /**
   * Start a world-space composite on a visible canvas:
   *   1. paint the background over the whole surface (screen space)
   *   2. draw the world grid and the already-baked content
   *   3. leave the WORLD -> SCREEN camera transform applied
   */
  window.inkBeginWorld = function inkBeginWorld(c) {
    drawBgScreen(c, c.canvas.width, c.canvas.height);
    const T = viewTransformFor(c);
    applyMat(c, { a: T.a, b: T.b, c: T.c, d: T.d, e: T.e, f: T.f });
    drawWorldGrid(c, T);
    drawBakedContent(c);
    drawDirectLayers(c, 'below');
    return T;
  };
  window.inkEndWorld = function inkEndWorld(c) { c.setTransform(1, 0, 0, 1, 0, 0); };

  /** Draw a stage-sized buffer at its world position (transform applied). */
  window.inkDrawStage = function inkDrawStage(c, buf) { drawStageBuffer(c, buf); };

  /** Same, but for contexts whose transform is not set up yet (temp canvases).
   *  save/restore keeps any clip or globalAlpha the caller has set. */
  window.inkDrawStageOn = function inkDrawStageOn(c, buf) {
    c.save();
    K.applyCanvasTransform(c, viewTransformFor(c));
    drawStageBuffer(c, buf);
    c.restore();
  };

  /** The WORLD -> SCREEN matrix for a given output canvas. */
  window.inkViewportTransform = function inkViewportTransform(c) { return viewTransformFor(c); };

  window.inkDrawLayerWorld = function inkDrawLayerWorld(c, layer) { drawLayerWorld(c, layer); };
  window.inkDrawDirect = function inkDrawDirect(c, mode) { drawDirectLayers(c, mode); };

  /* ═══════════════════════════════════════════════════════════════════════
   * 18. HAND CANVAS — keep it at frame resolution, draw through the stage
   * ═════════════════════════════════════════════════════════════════════ */

  const _origDrawHand = window.drawHand;
  window.drawHand = function drawHand(c, tipX, tipY, dir, style) {
    if (c !== hctx || state.stage.scale === 1) return _origDrawHand(c, tipX, tipY, dir, style);
    // The hand is authored at frame scale; when the stage renders at a
    // different scale, scale the sprite about its tip so it keeps a constant
    // size in the world (and therefore on screen).
    const s = state.stage.scale;
    c.save();
    c.translate(tipX, tipY);
    c.scale(s, s);
    c.translate(-tipX, -tipY);
    _origDrawHand(c, tipX, tipY, dir, style);
    c.restore();
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 19. EXPORT — render the frame, never the editor UI
   * ═════════════════════════════════════════════════════════════════════ */

  /** Composite the current composition into a target canvas at any size. */
  function renderExportFrame(c, outW, outH) {
    return renderFrameTo(c, outW, outH, { grid: false, frameOutline: false, hand: true });
  }

  window.exportPNG = function exportPNG() {
    return new Promise((resolve) => {
      const cv = document.createElement('canvas');
      cv.width = state.canvasW;
      cv.height = state.canvasH;
      renderExportFrame(cv.getContext('2d'), cv.width, cv.height);
      cv.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        a.href = url;
        a.download = `whiteboard-${ts}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        resolve();
      }, 'image/png');
    });
  };

  /** Draw the current composition into an external canvas element (used by
   *  the recorder and by the tests). */
  window.inkRenderTo = function inkRenderTo(target) {
    return renderExportFrame(target.getContext('2d'), target.width, target.height);
  };

  /**
   * WebM export.  Frames are produced by rendering the composition at the
   * export resolution (never by copying the editor canvas), and the capture
   * runs on a fixed time base so a dropped frame cannot stretch the movie.
   */
  window.recordWebM = function recordWebM(progressText, progressBar) {
    return new Promise((resolve, reject) => {
      try {
        const qualityMap = { high: 8000000, medium: 4000000, low: 2000000 };
        const bitrate = qualityMap[state.exportQuality] || 4000000;
        const mimes = [
          'video/webm;codecs=vp9',
          'video/webm;codecs=vp8',
          'video/webm;codecs=h264',
          'video/webm',
        ];
        let mime = 'video/webm';
        for (const m of mimes) {
          try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) { mime = m; break; } } catch (e) { /* ignore */ }
        }

        const rec = document.createElement('canvas');
        rec.width = state.canvasW;
        rec.height = state.canvasH;
        const rctx = rec.getContext('2d');

        state.recording = true;
        state.chunks = [];

        let stream;
        try {
          stream = rec.captureStream(30);
        } catch (err) {
          reject(new Error('Canvas capture is not available in this browser.'));
          return;
        }
        let mr;
        try {
          mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
        } catch (err) {
          reject(new Error('MediaRecorder could not start: ' + (err.message || err)));
          return;
        }

        mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) state.chunks.push(e.data); };
        mr.onstop = () => {
          const blob = new Blob(state.chunks, { type: 'video/webm' });
          if (!blob.size) { reject(new Error('Recorder produced an empty file.')); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
          a.href = url;
          a.download = `whiteboard-${ts}.webm`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          resolve();
        };
        mr.onerror = (e) => { state.recording = false; reject(new Error('Recording failed: ' + (e.error && e.error.name ? e.error.name : 'unknown'))); };

        const FPS = 30;
        let rafId = null;
        let nextFrame = nowMs();
        let frameCount = 0;
        (function syncLoop() {
          if (!state.recording) return;
          const t = nowMs();
          if (t >= nextFrame) {
            renderExportFrame(rctx, rec.width, rec.height);
            nextFrame = Math.max(t + 1000 / FPS * 0.5, nextFrame + 1000 / FPS);
            frameCount++;
          }
          rafId = requestAnimationFrame(syncLoop);
        })();

        mr.start(100);
        state.mediaRecorder = mr;

        progressText.textContent = 'Recording animation...';
        progressBar.style.width = '0%';
        restartAnim();

        const checkComplete = setInterval(() => {
          if (!state.recording) { clearInterval(checkComplete); return; }
          const progress = getExportAnimationProgress();
          progressBar.style.width = `${Math.round(progress * 100)}%`;
          progressText.textContent = isExportAnimationComplete() ? 'Finalizing...' : 'Recording...';
          if (isExportAnimationComplete()) {
            clearInterval(checkComplete);
            setTimeout(() => {
              state.recording = false;
              if (rafId) cancelAnimationFrame(rafId);
              if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
            }, 600);
          }
        }, 200);
      } catch (err) {
        state.recording = false;
        reject(err);
      }
    });
  };

  window.recordMP4 = function recordMP4(progressText, progressBar) {
    return new Promise(async (resolve, reject) => {
      try {
        if (typeof VideoEncoder === 'undefined') {
          reject(new Error('WebCodecs VideoEncoder is not available in this browser. Use WebM instead.'));
          return;
        }
        // The muxer is vendored in vendor/mp4-muxer.js (MIT, v5.2.2) so MP4
        // export works with no network at all.  It is loaded as a plain
        // script, so it also works from file:// where ESM imports are blocked.
        let Muxer, ArrayBufferTarget;
        try {
          const mod = window.Mp4Muxer || (typeof Mp4Muxer !== 'undefined' ? Mp4Muxer : null);
          Muxer = mod && mod.Muxer;
          ArrayBufferTarget = mod && mod.ArrayBufferTarget;
          if (!Muxer || !ArrayBufferTarget) {
            throw new Error('vendor/mp4-muxer.js did not load');
          }
        } catch (importErr) {
          reject(new Error('MP4 muxer is not available (' + importErr.message + '). ' +
            'Make sure vendor/mp4-muxer.js sits next to index.html, or export WebM instead.'));
          return;
        }

        const qualityMap = { high: 8000000, medium: 4000000, low: 2000000 };
        const bitrate = qualityMap[state.exportQuality] || 4000000;
        const FPS = 30;
        const W = state.canvasW % 2 === 0 ? state.canvasW : state.canvasW + 1;
        const H = state.canvasH % 2 === 0 ? state.canvasH : state.canvasH + 1;

        const target = new ArrayBufferTarget();
        const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory' });

        const isHighRes = W > 1280 || H > 720;
        const h264Codec = isHighRes ? 'avc1.640033' : 'avc1.42001f';
        let encoderConfig = {
          codec: h264Codec, width: W, height: H, bitrate, framerate: FPS, latencyMode: 'quality',
          ...(isHighRes ? { hardwareAcceleration: 'prefer-software' } : {}),
        };
        let support;
        try { support = await VideoEncoder.isConfigSupported(encoderConfig); } catch (e) { support = { supported: false }; }
        if (!support || !support.supported) {
          encoderConfig = { codec: 'vp09.00.51.08', width: W, height: H, bitrate, framerate: FPS, latencyMode: 'quality' };
          const s2 = await VideoEncoder.isConfigSupported(encoderConfig).catch(() => ({ supported: false }));
          if (!s2.supported) {
            reject(new Error('No supported H.264/VP9 encoder on this device. Export WebM instead.'));
            return;
          }
        }

        const videoEncoder = new VideoEncoder({
          output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
          error: (e) => { state.recording = false; reject(e); },
        });
        videoEncoder.configure(encoderConfig);

        const rec = document.createElement('canvas');
        rec.width = W; rec.height = H;
        const rctx = rec.getContext('2d', { willReadFrequently: true });

        state.recording = true;
        let frameCount = 0;
        let rafId = null;
        let encodingDone = false;
        let nextFrame = nowMs();

        progressText.textContent = 'Encoding MP4…';
        progressBar.style.width = '0%';
        restartAnim();

        // Fixed time base: one encoded frame per 1/FPS of wall clock, so the
        // exported movie has exactly the same duration as the preview no
        // matter how fast the device manages to render.
        function captureFrame() {
          if (!state.recording || encodingDone) return;
          const t = nowMs();
          if (t < nextFrame) { rafId = requestAnimationFrame(captureFrame); return; }
          nextFrame = Math.max(t + (1000 / FPS) * 0.5, nextFrame + 1000 / FPS);
          if (videoEncoder.encodeQueueSize > 12) { rafId = requestAnimationFrame(captureFrame); return; }
          renderExportFrame(rctx, W, H);
          const ts = Math.round((frameCount / FPS) * 1e6);
          const frame = new VideoFrame(rec, { timestamp: ts, duration: Math.round(1e6 / FPS) });
          videoEncoder.encode(frame, { keyFrame: frameCount % (FPS * 2) === 0 });
          frame.close();
          frameCount++;
          rafId = requestAnimationFrame(captureFrame);
        }
        rafId = requestAnimationFrame(captureFrame);

        const checkComplete = setInterval(async () => {
          if (!state.recording) { clearInterval(checkComplete); return; }
          const progress = getExportAnimationProgress();
          progressBar.style.width = `${Math.round(progress * 88)}%`;
          progressText.textContent = isExportAnimationComplete()
            ? 'Muxing MP4…'
            : `Encoding MP4… ${Math.round(progress * 100)}%`;
          if (isExportAnimationComplete() && !encodingDone) {
            encodingDone = true;
            clearInterval(checkComplete);
            state.recording = false;
            if (rafId) cancelAnimationFrame(rafId);
            setTimeout(async () => {
              try {
                await videoEncoder.flush();
                muxer.finalize();
                videoEncoder.close();
                progressBar.style.width = '100%';
                const blob = new Blob([target.buffer], { type: 'video/mp4' });
                if (!blob.size) { reject(new Error('MP4 muxer produced an empty file.')); return; }
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
                a.href = url;
                a.download = `whiteboard-${ts}.mp4`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
                resolve();
              } catch (finalErr) { reject(finalErr); }
            }, 800);
          }
        }, 200);
      } catch (err) {
        state.recording = false;
        reject(err);
      }
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 19b. EXPORT COMPLETION — wait for BOTH the drawing and the camera
   * ═════════════════════════════════════════════════════════════════════ */

  const _origIsExportComplete = window.isExportAnimationComplete;
  window.isExportAnimationComplete = function isExportAnimationComplete() {
    if (!_origIsExportComplete()) return false;
    // A camera timeline is part of the movie: do not stop recording until it
    // has played out, even if the drawing finished first.
    const rig = state.camRig;
    const hasCam = rig && ((rig.keys && rig.keys.length) ||
      (rig.follow && rig.follow.enabled && rig.follow.layerId != null));
    if (!hasCam) return true;
    return state.clock >= camTimelineDuration() - 0.05;
  };
  const _origExportProgress = window.getExportAnimationProgress;
  window.getExportAnimationProgress = function getExportAnimationProgress() {
    const base = _origExportProgress();
    const rig = state.camRig;
    const hasCam = rig && ((rig.keys && rig.keys.length) ||
      (rig.follow && rig.follow.enabled && rig.follow.layerId != null));
    if (!hasCam) return base;
    const cd = camTimelineDuration();
    const cp = cd > 0 ? K.clamp(state.clock / cd, 0, 1) : 1;
    // The last 15 % of the bar is reserved for the camera move finishing.
    return Math.min(base * 0.85 + cp * 0.15, 1);
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 19c. UI OVERRIDES THAT MUST DRAW THROUGH THE CAMERA
   * ═════════════════════════════════════════════════════════════════════ */

  // Background changes must repaint the whole viewport, not blit layers at
  // raw canvas coordinates.
  window.redrawWithBg = function redrawWithBg() { renderViewport(); };

  // Refresh the camera panel when its sidebar tab is opened.
  const _origSwitchSidebarTab = window.switchSidebarTab;
  if (_origSwitchSidebarTab) {
    window.switchSidebarTab = function switchSidebarTab(tab) {
      const r = _origSwitchSidebarTab.apply(this, arguments);
      if (tab === 'camera') { renderCameraUI(); drawMinimap(); }
      return r;
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 20. MISC OVERRIDES THAT MUST USE WORLD COORDINATES
   * ═════════════════════════════════════════════════════════════════════ */

  // Scrubbing the progress bar redraws the partial reveal through the stage.
  window.seekAnim = function seekAnim(e) {
    if (!offscreen) return;
    const ratio = e.offsetX / (e.currentTarget.clientWidth || 1);
    const cb = state.contentBounds;
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, VP.w, VP.h);
    drawBgScreen(_mainCtx, VP.w, VP.h);
    _mainCtx.save();
    K.applyCanvasTransform(_mainCtx, T);
    const h = cb.h * ratio;
    const st = state.stage;
    if (h > 0) {
      _mainCtx.drawImage(offscreen,
        cb.x, cb.y, cb.w, h,
        st.x + cb.x / st.scale, st.y + cb.y / st.scale, cb.w / st.scale, h / st.scale);
    }
    _mainCtx.restore();
    _mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (hctx) hctx.clearRect(0, 0, state.canvasW, state.canvasH);
  };

  // The baked outline overlay is a viewport-sized canvas now.
  window._bakeOutlineOverlay = function _bakeOutlineOverlay() {
    const ov = $('outline-overlay');
    if (!ov) return;
    patchFullClear(ov.getContext('2d'));
    if (!ov.width || ov.width !== VP.w) { ov.width = VP.w; ov.height = VP.h; }
    const oc2 = ov.getContext('2d');
    oc2.clearRect();
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, ov.width, ov.height);
    oc2.save();
    K.applyCanvasTransform(oc2, T);
    if (state.ifOutlineCanvas) drawStageBuffer(oc2, state.ifOutlineCanvas);
    if (state.ifInkCanvas) drawStageBuffer(oc2, state.ifInkCanvas);
    if (state.ofOutlineCanvas) drawStageBuffer(oc2, state.ofOutlineCanvas);
    oc2.restore();
    oc2.setTransform(1, 0, 0, 1, 0, 0);
    const visible = ($('outline-visible') && $('outline-visible').checked) !== false;
    const opacity = (($('outline-opacity') && $('outline-opacity').value) ?? 100) / 100;
    ov.style.display = visible ? 'block' : 'none';
    ov.style.opacity = opacity;
  };

  // New layers appear where the camera is looking, not at world origin.
  const _origAddLayer = window.addLayer;
  window.addLayer = function addLayer(img, name) {
    _origAddLayer(img, name);
    const l = state.layers[state.layers.length - 1];
    if (l) {
      const c = state.camera;
      l.x = Math.round(c.x - l.w / 2);
      l.y = Math.round(c.y - l.h / 2);
      renderViewport();
    }
    scheduleAutoSave();
  };

  // Text overlay follows the camera.
  window._positionTextOverlay = function _positionTextOverlay(cx, cy) {
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, VP.w, VP.h);
    const rect = canvas.getBoundingClientRect();
    const k = (rect.width || 1) / (VP.w || 1);   // CSS px per device px
    const s = K.worldToScreen(T, cx, cy);
    const left = s.x * k, top = s.y * k;
    const ov = $('text-editor-overlay'), frm = $('text-editor-frame');
    if (!ov) return;
    const w = Math.max(120, rect.width - left - 8);
    const fs = Math.max(8, _ts.size * (T.scale * k));
    const minH = fs * (_ts.lineHeight || 1.3) * 1.5;
    ov.style.left = left + 'px'; ov.style.top = top + 'px';
    ov.style.width = w + 'px'; ov.style.minHeight = minH + 'px';
    if (frm) {
      frm.style.left = (left - 3) + 'px'; frm.style.top = (top - 3) + 'px';
      frm.style.width = (w + 6) + 'px'; frm.style.minHeight = (minH + 6) + 'px';
    }
  };

  window.updateTextOverlayStyle = function updateTextOverlayStyle() {
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, VP.w, VP.h);
    const rect = canvas.getBoundingClientRect();
    const k = (rect.width || 1) / (VP.w || 1);
    const scale = T.scale * k;
    const ov = $('text-editor-overlay'), ta = $('text-editor-ta');
    if (!ov || !ta) return;
    const fStyle = (_ts.italic ? 'italic ' : '') + (_ts.bold ? 'bold ' : '');
    ta.style.font = `${fStyle}${Math.max(8, _ts.size * scale)}px '${_ts.font}', cursive, sans-serif`;
    ta.style.lineHeight = String(_ts.lineHeight || 1.3);
    ta.style.letterSpacing = (_ts.spacing || 0) * scale + 'px';
    ta.style.color = _ts.color;
    ta.style.textAlign = _ts.align || 'left';
  };

  // Crop overlay is drawn in world space on a viewport-sized canvas.
  window._drawCropOverlay = function _drawCropOverlay() {
    const cs = window._cropState;
    if (!cs) return;
    const cv = $('crop-canvas');
    if (!cv) return;
    if (cv.width !== VP.w) { cv.width = VP.w; cv.height = VP.h; }
    const c = cv.getContext('2d');
    patchFullClear(c);
    c.clearRect();
    const r = cs.rect;
    const T = K.viewTransform(state.camera, state.canvasW, state.canvasH, cv.width, cv.height);
    const inv = 1 / (T.scale || 1);
    c.save();
    K.applyCanvasTransform(c, T);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    const big = 1e7;
    c.fillRect(r.x - big, r.y - big, big * 2 + r.w, big);          // top
    c.fillRect(r.x - big, r.y + r.h, big * 2 + r.w, big);          // bottom
    c.fillRect(r.x - big, r.y, big, r.h);                          // left
    c.fillRect(r.x + r.w, r.y, big, r.h);                          // right
    c.strokeStyle = '#fff'; c.lineWidth = 1.5 * inv;
    c.strokeRect(r.x, r.y, r.w, r.h);
    const hs = 5 * inv * (VP.dpr || 1);
    [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].forEach(([hx, hy]) => {
      c.fillStyle = '#fff';
      c.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
      c.strokeStyle = '#6c63ff'; c.lineWidth = 1.2 * inv; c.strokeRect(hx - hs, hy - hs, hs * 2, hs * 2);
    });
    c.restore();
    c.setTransform(1, 0, 0, 1, 0, 0);
  };

  const _origActivateCropTool = window.activateCropTool;
  window.activateCropTool = function activateCropTool() {
    const r = _origActivateCropTool.apply(this, arguments);
    const cv = $('crop-canvas');
    if (cv) {
      cv.width = VP.w; cv.height = VP.h;
      cv.style.width = '100%'; cv.style.height = '100%';
      patchFullClear(cv.getContext('2d'));
    }
    if (window._cropState) window._drawCropOverlay();
    return r;
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 21. SERIALISATION (projects + undo snapshots)
   * ═════════════════════════════════════════════════════════════════════ */

  function serializeWorld() {
    ensureWorldState();
    return {
      camera: K.clonePose(state.camera),
      homeCamera: K.clonePose(state.homeCamera),
      camRig: {
        duration: state.camRig.duration,
        keys: state.camRig.keys.map((k) => ({
          id: k.id, t: k.t, x: k.x, y: k.y, zoom: k.zoom, rot: k.rot,
          ease: k.ease, cut: !!k.cut,
        })),
        scenes: state.camRig.scenes.map((s) => ({
          id: s.id, name: s.name, x: s.x, y: s.y, w: s.w, h: s.h, t: s.t, dur: s.dur,
        })),
        follow: Object.assign({}, state.camRig.follow),
      },
      showGrid: state.showGrid,
      showFrame: state.showFrame,
      navTool: state.navTool,
    };
  }

  function restoreWorld(data) {
    ensureWorldState();
    if (!data) return;
    if (data.camera) state.camera = K.makePose(data.camera.x, data.camera.y, data.camera.zoom, data.camera.rot);
    if (data.homeCamera) state.homeCamera = K.makePose(data.homeCamera.x, data.homeCamera.y, data.homeCamera.zoom, data.homeCamera.rot);
    if (data.camRig) {
      const r = data.camRig;
      state.camRig.duration = r.duration != null ? r.duration : state.camRig.duration;
      state.camRig.keys = Array.isArray(r.keys) ? r.keys.map((k) => ({
        id: k.id, t: k.t, x: k.x, y: k.y, zoom: k.zoom, rot: k.rot || 0,
        ease: k.ease || 'easeInOut', cut: !!k.cut,
      })) : [];
      state.camRig.scenes = Array.isArray(r.scenes) ? r.scenes.map((s) => ({
        id: s.id, name: s.name, x: s.x, y: s.y, w: s.w, h: s.h, t: s.t, dur: s.dur,
      })) : [];
      if (r.follow) state.camRig.follow = Object.assign(state.camRig.follow, r.follow);
    }
    if (data.showGrid !== undefined) state.showGrid = !!data.showGrid;
    if (data.showFrame !== undefined) state.showFrame = !!data.showFrame;
    if (data.navTool) state.navTool = data.navTool;
    // Re-register key ids so newly added keys never collide.
    state.camRig.keys.forEach((k) => { if (typeof k.id === 'number') K.reserveKeyId && K.reserveKeyId(k.id); });
    resetStage();
    resetCamSmooth();
    renderCameraUI();
  }
  window.inkSerializeWorld = serializeWorld;
  window.inkRestoreWorld = restoreWorld;

  /* ═══════════════════════════════════════════════════════════════════════
   * 22. CAMERA UI
   * ═════════════════════════════════════════════════════════════════════ */

  function setReadout(attr, text) {
    const els = document.querySelectorAll(`[data-cam="${attr}"]`);
    for (let i = 0; i < els.length; i++) els[i].textContent = text;
  }
  function updateCameraHud() {
    setReadout('zoom', Math.round((state.camera.zoom || 1) * 100) + '%');
    setReadout('pos', `${Math.round(state.camera.x)}, ${Math.round(state.camera.y)}`);
    setReadout('time', state.clock.toFixed(2) + 's');
  }

  function renderKeyList() {
    const el = $('cam-key-list');
    if (!el) return;
    const keys = K.sortKeys(state.camRig.keys);
    if (!keys.length) {
      el.innerHTML = '<div class="cam-empty">No camera keyframes yet — press “+ Key” to capture the current view.</div>';
      return;
    }
    const dur = camTimelineDuration();
    el.innerHTML = keys.map((k, i) => {
      const nx = keys[i + 1];
      const seg = nx ? (nx.t - k.t).toFixed(1) + 's' : '—';
      return `<div class="cam-key${k.id === state._selectedKeyId ? ' selected' : ''}" data-id="${k.id}">
        <span class="cam-key-t">${k.t.toFixed(1)}s</span>
        <span class="cam-key-pos">${Math.round(k.x)}, ${Math.round(k.y)}</span>
        <span class="cam-key-z">${Math.round(k.zoom * 100)}%</span>
        <span class="cam-key-e">${k.ease}</span>
        <span class="cam-key-seg">→ ${seg}</span>
        <button class="cam-key-btn" data-act="dup"  data-id="${k.id}" title="Duplicate">⧉</button>
        <button class="cam-key-btn" data-act="upd"  data-id="${k.id}" title="Update to current view">⟳</button>
        <button class="cam-key-btn danger" data-act="del" data-id="${k.id}" title="Delete">✕</button>
      </div>`;
    }).join('');
    el.querySelectorAll('.cam-key').forEach((row) => {
      row.addEventListener('click', (e) => {
        const act = e.target && e.target.dataset ? e.target.dataset.act : null;
        const id = parseInt(row.dataset.id);
        if (act === 'del') return camDeleteKey(id);
        if (act === 'dup') return camDuplicateKey(id);
        if (act === 'upd') return camUpdateKey(id);
        camSelectKey(id);
      });
    });
    void dur;
  }

  function renderSceneList() {
    const el = $('cam-scene-list');
    if (!el) return;
    const sc = state.camRig.scenes;
    if (!sc.length) {
      el.innerHTML = '<div class="cam-empty">No scenes yet.</div>';
      return;
    }
    el.innerHTML = sc.map((s) => `
      <div class="cam-scene" data-id="${s.id}">
        <input class="cam-scene-name" data-id="${s.id}" value="${String(s.name).replace(/"/g, '&quot;')}">
        <span class="cam-scene-t">${s.t.toFixed(1)}s · ${s.dur.toFixed(1)}s</span>
        <button class="cam-key-btn" data-act="go" data-id="${s.id}" title="Move camera here">⤢</button>
        <button class="cam-key-btn" data-act="frame" data-id="${s.id}" title="Set from current view">⟳</button>
        <button class="cam-key-btn danger" data-act="del" data-id="${s.id}" title="Delete">✕</button>
      </div>`).join('');
    el.querySelectorAll('.cam-scene').forEach((row) => {
      row.addEventListener('click', (e) => {
        const act = e.target && e.target.dataset ? e.target.dataset.act : null;
        const id = parseInt(row.dataset.id);
        if (act === 'del') { state.camRig.scenes = state.camRig.scenes.filter((s) => s.id !== id); renderSceneList(); scheduleAutoSave(); return; }
        if (act === 'go') return camGotoScene(id);
        if (act === 'frame') return camSceneFromView(id);
      });
    });
    el.querySelectorAll('.cam-scene-name').forEach((inp) => {
      inp.addEventListener('change', () => {
        const s = state.camRig.scenes.find((x) => x.id === parseInt(inp.dataset.id));
        if (s) { s.name = inp.value; scheduleAutoSave(); }
      });
    });
  }

  function renderFollowOptions() {
    const sel = $('cam-follow-target');
    if (!sel) return;
    const cur = state.camRig.follow.layerId;
    sel.innerHTML = '<option value="">— none —</option>' + state.layers.map((l) =>
      `<option value="${l.id}"${l.id === cur ? ' selected' : ''}>${String(l.name).replace(/</g, '&lt;')}</option>`).join('');
  }

  function renderCameraUI() {
    renderKeyList();
    renderSceneList();
    renderFollowOptions();
    const f = state.camRig.follow;
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('cam-follow-x', f.screenX == null ? 0.5 : f.screenX);
    set('cam-follow-y', f.screenY == null ? 0.5 : f.screenY);
    set('cam-follow-smooth', f.smoothing == null ? 0.25 : f.smoothing);
    set('cam-follow-zoom', f.zoom == null ? 0 : f.zoom);
    const tog = $('cam-follow-toggle');
    if (tog) tog.classList.toggle('on', !!f.enabled);
    set('cam-duration', state.camRig.duration);
    const dEl = $('cam-duration-val'); if (dEl) dEl.textContent = Number(state.camRig.duration).toFixed(1) + 's';
    updateCameraHud();
    drawMinimap();
  }
  window.renderCameraUI = renderCameraUI;
  window.updateCameraHud = updateCameraHud;

  /* ── keyframe actions ───────────────────────────────────────────────── */

  function camSelectKey(id) {
    state._selectedKeyId = id;
    const k = state.camRig.keys.find((x) => x.id === id);
    if (k) {
      setCamera(k.x, k.y, k.zoom, k.rot);
      state.clock = k.t;
      const easeSel = $('cam-key-ease'); if (easeSel) easeSel.value = k.ease || 'easeInOut';
      const tEl = $('cam-key-time'); if (tEl) tEl.value = k.t.toFixed(1);
    }
    renderKeyList();
  }
  window.camAddKey = function camAddKey() {
    const k = K.makeKey(state.clock, state.camera, ($('cam-key-ease') && $('cam-key-ease').value) || 'easeInOut');
    state.camRig.keys.push(k);
    state.camRig.keys.sort((a, b) => a.t - b.t);
    state._selectedKeyId = k.id;
    state.camRig.duration = Math.max(state.camRig.duration, k.t + 0.5);
    renderKeyList(); scheduleAutoSave();
    if (window.showToast) showToast(`Keyframe added at ${k.t.toFixed(1)}s`);
  };
  window.camUpdateKey = function camUpdateKey(id) {
    const k = state.camRig.keys.find((x) => x.id === (id == null ? state._selectedKeyId : id));
    if (!k) { if (window.showToast) showToast('Select a keyframe first'); return; }
    k.x = state.camera.x; k.y = state.camera.y; k.zoom = state.camera.zoom; k.rot = state.camera.rot;
    const e = $('cam-key-ease'); if (e) k.ease = e.value;
    const t = $('cam-key-time'); if (t) k.t = Math.max(0, parseFloat(t.value) || k.t);
    state.camRig.keys.sort((a, b) => a.t - b.t);
    renderKeyList(); scheduleAutoSave();
    if (window.showToast) showToast('Keyframe updated');
  };
  window.camDeleteKey = function camDeleteKey(id) {
    const key = id == null ? state._selectedKeyId : id;
    state.camRig.keys = state.camRig.keys.filter((k) => k.id !== key);
    state._selectedKeyId = null;
    renderKeyList(); scheduleAutoSave();
  };
  window.camDuplicateKey = function camDuplicateKey(id) {
    const k = state.camRig.keys.find((x) => x.id === (id == null ? state._selectedKeyId : id));
    if (!k) return;
    const nk = K.makeKey(k.t + Math.max(0.5, (state.camRig.duration || 8) * 0.1), state.camera, k.ease);
    nk.x = k.x; nk.y = k.y; nk.zoom = k.zoom; nk.rot = k.rot;
    state.camRig.keys.push(nk);
    state.camRig.keys.sort((a, b) => a.t - b.t);
    state.camRig.duration = Math.max(state.camRig.duration, nk.t);
    renderKeyList(); scheduleAutoSave();
  };
  window.camClearKeys = function camClearKeys() {
    state.camRig.keys = [];
    state._selectedKeyId = null;
    renderKeyList(); scheduleAutoSave();
  };

  /* ── timeline scrubbing / preview ───────────────────────────────────── */

  window.camScrub = function camScrub(ratio) {
    const dur = camTimelineDuration();
    state.clock = K.clamp(ratio, 0, 1) * dur;
    resetCamSmooth();
    updateCamera(1 / 30);
    renderViewport();
    const sl = $('cam-scrub'); if (sl) sl.value = String(K.clamp(ratio, 0, 1) * 1000);
    updateCameraHud();
  };
  window.camScrubFromSlider = function camScrubFromSlider(el) {
    camScrub(parseFloat(el.value) / 1000);
  };

  let _camPreview = null;
  window.camPreviewToggle = function camPreviewToggle() {
    if (_camPreview) { window.camPreviewStop(); return; }
    if (!state.camRig.keys.length && !(state.camRig.follow && state.camRig.follow.enabled)) {
      if (window.showToast) showToast('Add a camera keyframe or enable follow first');
      return;
    }
    if (state.playing) { if (window.showToast) showToast('Stop the drawing animation first'); return; }
    const dur = camTimelineDuration();
    state.clock = 0;
    resetCamSmooth();
    const btn = $('cam-preview-btn');
    if (btn) { btn.textContent = '⏸ Pause camera'; btn.classList.add('playing'); }
    let last = nowMs();
    _camPreview = { raf: 0 };
    (function step() {
      if (!_camPreview) return;
      const t = nowMs();
      const dt = Math.min(0.1, (t - last) / 1000) || 1 / 30;
      last = t;
      state.clock += dt;
      if (state.clock >= dur) {
        state.clock = dur;
        updateCamera(dt);
        renderViewport();
        window.camPreviewStop();
        return;
      }
      updateCamera(dt);
      renderViewport();
      const sl = $('cam-scrub'); if (sl) sl.value = String((state.clock / (dur || 1)) * 1000);
      updateCameraHud();
      _camPreview.raf = requestAnimationFrame(step);
    })();
  };
  window.camPreviewStop = function camPreviewStop() {
    if (_camPreview) { cancelAnimationFrame(_camPreview.raf); _camPreview = null; }
    const btn = $('cam-preview-btn');
    if (btn) { btn.textContent = '▶ Preview camera'; btn.classList.remove('playing'); }
  };
  window.camPreviewReset = function camPreviewReset() {
    window.camPreviewStop();
    state.clock = 0;
    resetCamSmooth();
    const sl = $('cam-scrub'); if (sl) sl.value = '0';
    updateCamera(1 / 30);
    renderViewport();
    updateCameraHud();
  };

  /* ── follow target ──────────────────────────────────────────────────── */

  window.camToggleFollow = function camToggleFollow() {
    const f = state.camRig.follow;
    f.enabled = !f.enabled;
    const tog = $('cam-follow-toggle');
    if (tog) tog.classList.toggle('on', f.enabled);
    if (f.enabled) {
      if (f.layerId == null) {
        const l = getSelectedLayer();
        if (l) { f.layerId = l.id; renderFollowOptions(); }
      }
      resetCamSmooth();
      updateCamera(1 / 30);
      renderViewport();
    }
    scheduleAutoSave();
  };
  window.camFollowChanged = function camFollowChanged(el) {
    const f = state.camRig.follow;
    f.layerId = el.value === '' ? null : parseInt(el.value);
    resetCamSmooth();
    updateCamera(1 / 30);
    renderViewport();
    scheduleAutoSave();
  };
  window.camFollowNum = function camFollowNum(el, field) {
    const f = state.camRig.follow;
    const v = parseFloat(el.value);
    f[field] = isFinite(v) ? v : 0;
    const lbl = $('cam-follow-' + field + '-val');
    if (lbl) lbl.textContent = (field === 'smoothing' ? f[field].toFixed(2) + 's' : Math.round(f[field] * 100) + '%');
    resetCamSmooth();
    updateCamera(1 / 30);
    renderViewport();
    scheduleAutoSave();
  };
  window.camFollowZoom = function camFollowZoom(el) {
    const v = parseFloat(el.value);
    const f = state.camRig.follow;
    f.zoom = (!isFinite(v) || v <= 0) ? null : v;
    const lbl = $('cam-follow-zoom-val');
    if (lbl) lbl.textContent = f.zoom ? (f.zoom * 100).toFixed(0) + '%' : 'auto';
    updateCamera(1 / 30);
    renderViewport();
    scheduleAutoSave();
  };

  /* ── scenes ─────────────────────────────────────────────────────────── */

  window.camAddScene = function camAddScene() {
    const view = K.viewRect(state.camera, state.canvasW, state.canvasH);
    const sc = K.makeScene(`Scene ${state.camRig.scenes.length + 1}`, view, camTimelineDuration(), 4);
    state.camRig.scenes.push(sc);
    renderSceneList(); scheduleAutoSave();
    if (window.showToast) showToast('Scene added at the current view');
  };
  window.camGotoScene = function camGotoScene(id) {
    const s = state.camRig.scenes.find((x) => x.id === id);
    if (!s) return;
    const pose = K.fitRectPose({ x: s.x, y: s.y, w: s.w, h: s.h }, state.canvasW, state.canvasH, { pad: 1 });
    setCamera(pose.x, pose.y, pose.zoom, pose.rot);
    state.clock = s.t;
    const sl = $('cam-scrub');
    if (sl) sl.value = String(K.clamp(s.t / (camTimelineDuration() || 1), 0, 1) * 1000);
    updateCameraHud();
  };
  window.camSceneFromView = function camSceneFromView(id) {
    const s = state.camRig.scenes.find((x) => x.id === id);
    if (!s) return;
    const v = K.viewRect(state.camera, state.canvasW, state.canvasH);
    s.x = v.x; s.y = v.y; s.w = v.w; s.h = v.h; s.t = state.clock;
    renderSceneList(); scheduleAutoSave();
    if (window.showToast) showToast('Scene updated from the current view');
  };

  window.camDurationChanged = function camDurationChanged(el) {
    const v = parseFloat(el.value);
    state.camRig.duration = isFinite(v) && v > 0 ? v : 1;
    const d = $('cam-duration-val'); if (d) d.textContent = state.camRig.duration.toFixed(1) + 's';
    scheduleAutoSave();
  };

  /* ── minimap ─────────────────────────────────────────────────────────── */

  let _miniDrag = false;
  function drawMinimap() {
    const cv = $('cam-minimap');
    if (!cv) return;
    const w = cv.clientWidth || 240, h = cv.clientHeight || 130;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#f4f4f6'; c.fillRect(0, 0, w, h);

    let b = K.contentBounds(state.layers, camTimelineDuration(), { visibleOnly: true });
    const view = K.viewRect(state.camera, state.canvasW, state.canvasH);
    b = K.unionRect(b, view);
    if (!b) return;
    const pad = 8;
    const s = Math.min((w - pad * 2) / (b.w || 1), (h - pad * 2) / (b.h || 1));
    const ox = pad + ((w - pad * 2) - b.w * s) / 2 - b.x * s;
    const oy = pad + ((h - pad * 2) - b.h * s) / 2 - b.y * s;
    const X = (v) => ox + v * s, Y = (v) => oy + v * s;

    // scene regions
    c.strokeStyle = 'rgba(108,99,255,0.35)';
    c.lineWidth = 1;
    state.camRig.scenes.forEach((sc) => {
      c.strokeRect(X(sc.x), Y(sc.y), sc.w * s, sc.h * s);
    });
    // layers
    state.layers.forEach((l) => {
      if (l.visible === false) return;
      const r = K.layerWorldRect(l, camTimelineDuration());
      c.fillStyle = (l.id === state.selectedLayerId) ? 'rgba(108,99,255,0.75)' : 'rgba(40,44,55,0.35)';
      c.fillRect(X(r.x), Y(r.y), Math.max(1.5, r.w * s), Math.max(1.5, r.h * s));
    });
    // camera path
    const keys = K.sortKeys(state.camRig.keys);
    if (keys.length > 1) {
      c.strokeStyle = '#e11d48'; c.lineWidth = 1.2;
      c.beginPath();
      keys.forEach((k, i) => { const px = X(k.x), py = Y(k.y); if (i === 0) c.moveTo(px, py); else c.lineTo(px, py); });
      c.stroke();
      c.fillStyle = '#e11d48';
      keys.forEach((k) => { c.beginPath(); c.arc(X(k.x), Y(k.y), 2, 0, Math.PI * 2); c.fill(); });
    }
    // view rect
    c.strokeStyle = '#111'; c.lineWidth = 1.5;
    c.strokeRect(X(view.x), Y(view.y), view.w * s, view.h * s);
    c.save();
    c.strokeStyle = 'rgba(17,17,17,0.25)';
    c.setLineDash([3, 3]); c.lineWidth = 1;
    c.beginPath(); c.moveTo(X(0), 0); c.lineTo(X(0), h); c.moveTo(0, Y(0)); c.lineTo(w, Y(0)); c.stroke();
    c.restore();
    cv._map = { s, ox, oy };
  }
  window.drawMinimap = drawMinimap;

  function bindMinimap() {
    const cv = $('cam-minimap');
    if (!cv) return;
    const go = (e) => {
      const m = cv._map; if (!m) return;
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      state.camera.x = (px - m.ox) / m.s;
      state.camera.y = (py - m.oy) / m.s;
      renderViewport();
    };
    cv.addEventListener('pointerdown', (e) => { _miniDrag = true; cv.setPointerCapture(e.pointerId); go(e); e.preventDefault(); });
    cv.addEventListener('pointermove', (e) => { if (_miniDrag) { go(e); e.preventDefault(); } });
    cv.addEventListener('pointerup', (e) => { _miniDrag = false; scheduleAutoSave(); });
    cv.addEventListener('pointercancel', () => { _miniDrag = false; });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 23. PUBLIC API
   * ═════════════════════════════════════════════════════════════════════ */

  window.InkWorld = {
    VP,
    renderViewport,
    renderFrameTo,
    renderExportFrame,
    clientToWorld,
    layerCenter,
    layerTopLeft,
    setCamera,
    panCameraByScreen,
    zoomCameraAt,
    setStageForBounds,
    resetStage,
    drawStageBuffer,
    applyStageTransform,
    stageToWorldMatrix,
    worldToStageMatrix,
    stageToScreenMatrix,
    camTimelineDuration,
    updateCamera,
    serializeWorld,
    restoreWorld,
    renderCameraUI,
    drawMinimap,
    defaultCamera,
    defaultStage,
    defaultRig,
    ensureWorldState,
    isDirectLayer,
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * 24. INIT
   * ═════════════════════════════════════════════════════════════════════ */

  function init() {
    ensureWorldState();

    // The visible canvases become viewport-sized overlays.
    registerVisibleCanvas(canvas);
    registerVisibleCanvas(selectCanvas);
    registerVisibleCanvas($('crop-canvas'));
    registerVisibleCanvas($('outline-overlay'));
    patchFullClear(sctx);
    patchFullClear($('crop-canvas') && $('crop-canvas').getContext('2d'));
    patchFullClear($('outline-overlay') && $('outline-overlay').getContext('2d'));

    // The hand canvas is composited by us now, so it no longer needs to be
    // stacked on screen.  Keeping it at frame resolution means the exported
    // hand is never upscaled from the (smaller) editor viewport.
    if (handCanvas) {
      handCanvas.style.display = 'none';
      handCanvas.width = state.canvasW;
      handCanvas.height = state.canvasH;
    }

    // block native gestures on the canvas surface
    [canvas, selectCanvas, $('crop-canvas')].forEach((el) => {
      if (!el) return;
      el.style.touchAction = 'none';
      el.style.userSelect = 'none';
    });

    window.fitCanvas();
    bindNavigation();
    bindMinimap();
    camSetTool(state.navTool || 'select');
    renderCameraUI();

    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { window.fitCanvas(); drawMinimap(); }, 60);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

    // Keep the camera panel in sync when layers change.
    const _origRenderLayerList = window.renderLayerList;
    if (_origRenderLayerList) {
      window.renderLayerList = function () {
        const r = _origRenderLayerList.apply(this, arguments);
        renderFollowOptions();
        drawMinimap();
        return r;
      };
    }
    const _origSelectLayer = window.selectLayer;
    if (_origSelectLayer) {
      window.selectLayer = function () {
        const r = _origSelectLayer.apply(this, arguments);
        drawMinimap();
        return r;
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
