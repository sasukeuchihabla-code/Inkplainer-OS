/* =============================================================================
 * demo.js — "Three Connected Scenes": one continuous world, one camera move
 * -----------------------------------------------------------------------------
 * Inkplainer OS · Apache License 2.0
 *
 * Everything in this demo lives in ONE world coordinate system.  Nothing is
 * a full-screen slide: the camera travels from the first scene to the last
 * through continuous world space, and every object keeps its world position
 * for the whole journey.
 *
 *   Scene 1  (x ≈ 0 … 900)     a small golden point appears and starts moving
 *   Scene 2  (x ≈ 900 … 2400)  the camera follows the point; the diagram far
 *                              along the same world comes into view
 *   Scene 3  (x ≈ 2450 … 3550) the camera settles on the diagram and the
 *                              Inkplainer hand draws its lines and labels
 *   Scene 4  (x ≈ 4400 … 5050) the camera continues to the final destination
 *
 * The diagram is generated procedurally into a canvas, so the demo needs no
 * external assets and works completely offline.
 *
 * Ink colour note: the outline detector in animations.js looks for pixels that
 * are darker than 240 or not fully opaque, and the demo background is white —
 * so all artwork here is drawn in dark ink on transparency.  That is the same
 * convention real Inkplainer projects use.
 * ========================================================================== */

(function () {
  'use strict';

  const K = window.InkCamera;
  const $ = (id) => document.getElementById(id);

  const DEMO_INK = '#1a1a1a';
  const DEMO_ACCENT = '#b45309';

  /* ─────────────────────────── text rendering ─────────────────────────── */

  function renderTextImage(text, opts) {
    const o = opts || {};
    const size = o.size || 72;
    const font = o.font || 'Caveat';
    const weight = o.weight || '700';
    const lineHeight = o.lineHeight || 1.25;
    const lines = String(text).split('\n');

    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `${weight} ${size}px '${font}', cursive, sans-serif`;
    let maxW = 0;
    lines.forEach((ln) => { maxW = Math.max(maxW, probe.measureText(ln).width); });

    const padX = Math.ceil(size * 0.25);
    const padY = Math.ceil(size * 0.35);
    const w = Math.max(8, Math.ceil(maxW + padX * 2));
    const h = Math.max(8, Math.ceil(lines.length * size * lineHeight + padY * 2));

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.font = `${weight} ${size}px '${font}', cursive, sans-serif`;
    c.fillStyle = o.color || DEMO_INK;
    c.textBaseline = 'top';
    c.textAlign = o.align || 'left';
    lines.forEach((ln, i) => {
      const x = (o.align === 'center') ? w / 2 : (o.align === 'right' ? w - padX : padX);
      c.fillText(ln, x, padY + i * size * lineHeight);
    });
    return cv;
  }

  /* ────────────────────────── diagram painting ────────────────────────── */

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  function arrow(c, x1, y1, x2, y2, head) {
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    const a = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath();
    c.moveTo(x2, y2);
    c.lineTo(x2 - head * Math.cos(a - Math.PI / 7), y2 - head * Math.sin(a - Math.PI / 7));
    c.lineTo(x2 - head * Math.cos(a + Math.PI / 7), y2 - head * Math.sin(a + Math.PI / 7));
    c.closePath();
    c.fill();
  }

  /**
   * A labelled three-step flow diagram, drawn as dark line art on
   * transparency — exactly the kind of artwork Inkplainer's outline styles
   * are built for.
   */
  function renderDiagramImage() {
    const W = 1100, H = 520;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');

    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.strokeStyle = DEMO_INK;
    c.fillStyle = DEMO_INK;

    // ── title ──
    c.font = `700 62px 'Caveat', cursive, sans-serif`;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText('One world, one camera', 14, 8);

    c.lineWidth = 3;
    c.beginPath(); c.moveTo(14, 86); c.lineTo(W - 14, 86); c.stroke();

    // ── three boxes ──
    const bw = 268, bh = 132, by = 168;
    const gap = ((W - 28) - bw * 3) / 2;
    const boxes = [
      { x: 14, label: 'Place', sub: 'anywhere' },
      { x: 14 + bw + gap, label: 'Move', sub: 'the camera' },
      { x: 14 + (bw + gap) * 2, label: 'Export', sub: 'vertical video' },
    ];
    boxes.forEach((b) => {
      c.lineWidth = 7;
      roundRectPath(c, b.x, by, bw, bh, 20);
      c.stroke();
      c.font = `700 54px 'Caveat', cursive, sans-serif`;
      c.textAlign = 'center';
      c.fillText(b.label, b.x + bw / 2, by + 26);
      c.font = `400 36px 'Caveat', cursive, sans-serif`;
      c.fillText(b.sub, b.x + bw / 2, by + 84);
    });

    // ── arrows between the boxes ──
    c.lineWidth = 6;
    arrow(c, boxes[0].x + bw + 12, by + bh / 2, boxes[1].x - 14, by + bh / 2, 22);
    arrow(c, boxes[1].x + bw + 12, by + bh / 2, boxes[2].x - 14, by + bh / 2, 22);

    // ── a looping arrow underneath: the camera path ──
    c.lineWidth = 5;
    c.strokeStyle = DEMO_ACCENT;
    c.fillStyle = DEMO_ACCENT;
    c.beginPath();
    c.moveTo(30, 400);
    c.bezierCurveTo(280, 470, 760, 470, W - 60, 392);
    c.stroke();
    arrow(c, W - 60, 392, W - 96, 386, 20);

    c.font = `700 40px 'Caveat', cursive, sans-serif`;
    c.textAlign = 'center';
    c.fillText('the camera never cuts', W / 2, 424);

    // ── underline ──
    c.strokeStyle = DEMO_INK;
    c.fillStyle = DEMO_INK;
    c.lineWidth = 3;
    c.beginPath(); c.moveTo(14, H - 26); c.lineTo(W - 14, H - 26); c.stroke();

    return cv;
  }

  /* ─────────────────────────── layer builders ─────────────────────────── */

  function addImageLayer(canvasSrc, name, opts) {
    const o = opts || {};
    const img = new Image();
    // addLayer() needs the intrinsic size synchronously, so build the layer
    // object directly from the canvas we just painted.
    const layer = {
      id: ++_layerIdCounter,
      name,
      img: null,
      x: o.x, y: o.y, w: o.w, h: o.h,
      baseW: o.w, baseH: o.h,
      resizePct: 100,
      animStyle: o.animStyle || state.animStyle || 'chunkjump',
      hand: o.hand || state.hand || 'custom1',
      animOrder: o.animOrder == null ? null : o.animOrder,
      opacity: 1,
      visible: true,
      groupId: null,
      speed: o.speed == null ? 40 : o.speed,
      handSpeed: o.handSpeed == null ? 6 : o.handSpeed,
      chunks: 30,
      specChunks: 35,
      hasPngAlpha: true,
      kind: 'image',
      motion: null,
    };
    state.layers.push(layer);
    // The canvas is turned into an Image exactly like an uploaded file would
    // be, so the layer behaves like any other image layer.
    img.onload = () => {
      layer.img = img;
      renderLayerList();
      if (typeof window.renderCameraUI === 'function') window.renderCameraUI();
      redrawLayersOnCanvas();
    };
    img.onerror = () => { console.error('[demo] failed to rasterise layer', name); };
    img.src = canvasSrc.toDataURL('image/png');
    return layer;
  }

  function addShapeLayer(name, opts) {
    const o = opts || {};
    const layer = {
      id: ++_layerIdCounter,
      name,
      img: null,
      kind: 'shape',
      shape: o.shape || 'circle',
      x: o.x, y: o.y, w: o.w, h: o.h,
      baseW: o.w, baseH: o.h,
      resizePct: 100,
      animStyle: 'none',          // never drawn by the hand engine
      hand: state.hand || 'custom1',
      animOrder: null,
      opacity: o.opacity == null ? 1 : o.opacity,
      visible: true,
      groupId: null,
      speed: 40, handSpeed: 6, chunks: 30, specChunks: 35,
      hasPngAlpha: false,
      fill: o.fill || '#f0b429',
      stroke: o.stroke || DEMO_ACCENT,
      strokeWidth: o.strokeWidth == null ? 4 : o.strokeWidth,
      radiusPct: 18,
      motion: o.motion || null,
    };
    state.layers.push(layer);
    return layer;
  }

  /* ───────────────────────────── the demo ─────────────────────────────── */

  window.loadDemoJourney = function loadDemoJourney() {
    if (typeof pushUndoSnapshot === 'function') pushUndoSnapshot();

    // ── 1. vertical 720 × 1280 frame (what the exported video will be) ──
    try {
      _currentRatio = '9:16';
      _currentRes = 720;
      _applyCanvasSizeImmediate();
      document.querySelectorAll('.ratio-btn, .bb-ratio-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.ratio === '9:16');
      });
      document.querySelectorAll('.res-btn, .bb-res-btn').forEach((b) => {
        b.classList.toggle('active', parseInt(b.dataset.res) === 720);
      });
      if (typeof _syncBbSizeReadout === 'function') _syncBbSizeReadout();
    } catch (e) {
      console.warn('[demo] could not switch to 9:16, keeping the current frame', e);
    }

    // ── 2. clean slate ──
    state.layers = [];
    state.groups = [];
    state.selectedLayerId = null;
    state.bgCanvas = null;
    state._bakedSnap = null;
    if (typeof resetAnim === 'function') resetAnim();
    if (window.InkWorld) InkWorld.resetStage();

    // ── 3. whiteboard background ──
    const whitePill = document.querySelector('.bg-pill[data-bg="white"], .bg-pill[onclick*="white"]');
    if (typeof selectBgPreset === 'function') {
      if (whitePill) selectBgPreset(whitePill, 'solid', 'white');
      else { state.canvasBg = { type: 'solid', val: 'white' }; redrawLayersOnCanvas(); }
    }

    // ── 4. the moving subject (Scene 1 → Scene 3) ──
    //     World coordinates: the point starts near the origin and ends at the
    //     left edge of the diagram, 2400 world units to the right.
    const DOT_R = 22;
    const dot = addShapeLayer('Golden point', {
      shape: 'circle',
      x: 80 - DOT_R, y: 640 - DOT_R,
      w: DOT_R * 2, h: DOT_R * 2,
      fill: '#f0b429', stroke: DEMO_ACCENT, strokeWidth: 4,
      motion: {
        enabled: true,
        ease: 'easeInOut',
        loop: false,
        path: [
          { t: 0, x: 80, y: 640, ease: 'easeInOut' },
          { t: 4.5, x: 1500, y: 640, ease: 'linear' },
          { t: 9, x: 2380, y: 640, ease: 'easeOut' },
        ],
      },
    });

    // ── 5. Scene 1 caption (drawn first, while the point sets off) ──
    addImageLayer(renderTextImage('Inkplainer OS', { size: 76, color: DEMO_INK }),
      'Caption — title', {
        x: 30, y: 852, w: 320, h: 112,
        animStyle: 'chunkjump', speed: 55, animOrder: 1,
      });

    // ── 6. Scene 2/3 diagram ──
    addImageLayer(renderDiagramImage(), 'Diagram — flow', {
      x: 2450, y: 360, w: 1100, h: 520,
      animStyle: 'outlinefill', speed: 34, handSpeed: 7, animOrder: 2,
    });

    // ── 7. Scene 4 destination ──
    addImageLayer(renderTextImage('One world.\nOne camera.', { size: 84, color: DEMO_INK }),
      'Caption — destination', {
        x: 4400, y: 560, w: 560, h: 220,
        animStyle: 'chunkjump', speed: 50, animOrder: 3,
      });

    // ── 8. camera keyframes: one continuous move through the world ──
    //     Each key keeps the point at ~35 % from the left while it travels,
    //     then releases it to frame the diagram and the final caption.
    const keys = [
      { t: 0.0, x: 150, y: 640, zoom: 1.7, ease: 'easeInOut' },
      { t: 4.5, x: 1600, y: 640, zoom: 1.05, ease: 'easeInOut' },
      { t: 7.5, x: 2450, y: 640, zoom: 0.72, ease: 'easeInOut' }, // diagram appears
      { t: 10.5, x: 3000, y: 620, zoom: 0.78, ease: 'easeInOut' }, // settle on it
      { t: 17.0, x: 3000, y: 620, zoom: 1.05, ease: 'easeInOut' }, // slow push in
      { t: 20.5, x: 4680, y: 660, zoom: 1.0, ease: 'easeInOut' },  // final scene
    ];
    state.camRig.keys = keys.map((k) => K.makeKey(k.t, K.makePose(k.x, k.y, k.zoom, 0), k.ease));
    state.camRig.duration = 21;

    // ── 9. scenes (logical regions of the same world) ──
    state.camRig.scenes = [
      K.makeScene('1 · The point', { x: -200, y: 300, w: 1100, h: 700 }, 0, 4.5),
      K.makeScene('2 · The journey', { x: 900, y: 300, w: 1600, h: 700 }, 4.5, 5),
      K.makeScene('3 · The diagram', { x: 2400, y: 330, w: 1200, h: 600 }, 9.5, 9),
      K.makeScene('4 · Destination', { x: 4350, y: 480, w: 700, h: 420 }, 18.5, 2.5),
    ];

    // ── 10. follow target — pre-configured, off by default so the keyframed
    //        journey plays first.  Switch it on and the camera locks on to
    //        the golden point instead (see camToggleFollow).
    state.camRig.follow = {
      enabled: false,
      layerId: dot.id,
      screenX: 0.35, screenY: 0.5,
      smoothing: 0.35,
      zoom: null,
      offsetX: 0, offsetY: 0,
    };

    // ── 11. home view + UI sync ──
    state.homeCamera = K.makePose(150, 640, 1.7, 0);
    state.camera = K.clonePose(state.homeCamera);
    state.clock = 0;
    state._camSmooth = {};
    state.navTool = 'nav';   // panning is the natural first gesture here
    if (window.camSetTool) camSetTool('nav');

    renderLayerList();
    redrawLayersOnCanvas();
    if (window.renderCameraUI) renderCameraUI();
    if (window.switchSidebarTab) switchSidebarTab('camera');
    if (window.showToast) showToast('Demo loaded — press Generate, then Export');
    scheduleAutoSave();
    return true;
  };
})();
