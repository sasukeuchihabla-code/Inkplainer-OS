/**
 * canvas-mock.mjs — a recording stand-in for CanvasRenderingContext2D.
 *
 * The sandbox has no GPU, no Cairo and no browser, so a real 2D context is
 * not available.  This mock implements every method the app touches, records
 * the calls, and returns sane values so that real application code paths
 * (rendering, hit-testing, outline detection, export) actually execute.
 *
 * It is NOT a renderer: nothing is rasterised.  What it verifies is that the
 * code runs, that the right calls happen in the right order, and — importantly
 * for this project — that no enormous bitmap is ever allocated.
 */

export const stats = {
  canvases: [],       // every canvas created: {w, h}
  maxPixels: 0,
  calls: {},          // method name -> count
  drawImages: [],     // {srcW, srcH, args}
  imageSrcs: [],      // every src assigned to an <img>, i.e. every file fetched
  lastError: null,
};

function rec(name) { stats.calls[name] = (stats.calls[name] || 0) + 1; }

export function resetStats() {
  stats.canvases.length = 0;
  stats.maxPixels = 0;
  stats.calls = {};
  stats.drawImages.length = 0;
  stats.imageSrcs.length = 0;
  stats.lastError = null;
}

class MockGradient {
  addColorStop() {}
}

class MockImageData {
  constructor(w, h, data) {
    this.width = w;
    this.height = h;
    this.data = data || new Uint8ClampedArray(Math.max(0, w * h * 4));
  }
}

const CTX_METHODS = [
  'save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform',
  'resetTransform', 'clearRect', 'fillRect', 'strokeRect',
  'beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo',
  'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'clip',
  'setLineDash', 'getLineDash', 'fillText', 'strokeText',
  'putImageData', 'drawImage', 'reset',
];

export function createMockContext(canvas) {
  const ctx = {
    canvas,
    // style / state properties
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)', shadowOffsetX: 0, shadowOffsetY: 0,
    filter: 'none', letterSpacing: '0px', wordSpacing: '0px',
    // non-standard
    _m: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    _stack: [],
  };

  for (const name of CTX_METHODS) {
    if (name === 'drawImage') continue;
    ctx[name] = function () { rec(name); return undefined; };
  }

  ctx.save = function () { rec('save'); ctx._stack.push({ ...ctx._m }); };
  ctx.restore = function () {
    rec('restore');
    const m = ctx._stack.pop();
    if (m) ctx._m = m;
  };
  ctx.setTransform = function (a, b, c, d, e, f) {
    rec('setTransform');
    ctx._m = { a, b, c, d, e, f };
  };
  ctx.resetTransform = function () { rec('resetTransform'); ctx._m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; };
  ctx.transform = function (a, b, c, d, e, f) {
    rec('transform');
    const m = ctx._m;
    ctx._m = {
      a: m.a * a + m.c * b, b: m.b * a + m.d * b,
      c: m.a * c + m.c * d, d: m.b * c + m.d * d,
      e: m.a * e + m.c * f + m.e, f: m.b * e + m.d * f + m.f,
    };
  };
  ctx.translate = function (x, y) { rec('translate'); ctx.transform(1, 0, 0, 1, x, y); };
  ctx.scale = function (x, y) { rec('scale'); ctx.transform(x, 0, 0, y, 0, 0); };
  ctx.rotate = function (r) {
    rec('rotate');
    const cos = Math.cos(r), sin = Math.sin(r);
    ctx.transform(cos, sin, -sin, cos, 0, 0);
  };
  ctx.getTransform = function () { rec('getTransform'); return { ...ctx._m }; };
  ctx.getLineDash = function () { return []; };

  ctx.createLinearGradient = function () { rec('createLinearGradient'); return new MockGradient(); };
  ctx.createRadialGradient = function () { rec('createRadialGradient'); return new MockGradient(); };
  ctx.createConicGradient = function () { rec('createConicGradient'); return new MockGradient(); };
  ctx.createPattern = function () { rec('createPattern'); return {}; };

  ctx.measureText = function (t) {
    rec('measureText');
    const size = parseFloat(String(ctx.font).match(/(\d+(?:\.\d+)?)px/)?.[1] || 10);
    return { width: String(t).length * size * 0.5, actualBoundingBoxAscent: size, actualBoundingBoxDescent: size * 0.2 };
  };

  ctx.getImageData = function (x, y, w, h) {
    rec('getImageData');
    const W = Math.max(0, Math.floor(w)), H = Math.max(0, Math.floor(h));
    return new MockImageData(W, H);
  };
  ctx.createImageData = function (w, h) { rec('createImageData'); return new MockImageData(w, h); };

  ctx.drawImage = function (img) {
    rec('drawImage');
    const args = Array.from(arguments).slice(1);
    stats.drawImages.push({
      src: img && (img.width != null ? `${img.width}x${img.height}` : String(img)),
      args,
      transform: { ...ctx._m },
    });
  };

  return ctx;
}

/**
 * Install the mock onto a jsdom window.  Also stubs the handful of browser
 * APIs the app touches that jsdom does not implement.
 */
export function installCanvasMock(win, opts = {}) {
  const viewW = opts.viewW || 380;
  const viewH = opts.viewH || 620;

  const HTMLCanvasElement = win.HTMLCanvasElement;

  // Track every canvas that is created and every size it is given.
  const sizing = {
    set width(v) {
      this._w = v; trackCanvas(this);
    },
    get width() { return this._w || 300; },
    set height(v) {
      this._h = v; trackCanvas(this);
    },
    get height() { return this._h || 150; },
  };
  function trackCanvas(el) {
    const w = el._w || 300, h = el._h || 150;
    stats.canvases.push({ w, h, id: el.id || '(offscreen)' });
    const px = w * h;
    if (px > stats.maxPixels) stats.maxPixels = px;
  }
  Object.defineProperty(HTMLCanvasElement.prototype, 'width', sizing);
  Object.defineProperty(HTMLCanvasElement.prototype, 'height', sizing);

  HTMLCanvasElement.prototype.getContext = function (type) {
    if (type !== '2d') return null;
    if (!this.__ctx) this.__ctx = createMockContext(this);
    return this.__ctx;
  };
  HTMLCanvasElement.prototype.toDataURL = function () {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  };
  HTMLCanvasElement.prototype.toBlob = function (cb) {
    rec('toBlob');
    cb(new win.Blob(['fake-png-bytes'], { type: 'image/png' }));
  };
  HTMLCanvasElement.prototype.captureStream = function () {
    rec('captureStream');
    return { getTracks: () => [] };
  };

  // A plausible layout for the editor viewport.
  win.Element.prototype.getBoundingClientRect = function () {
    const isViewport = this.id === 'canvas-wrapper' || this.id === 'main-canvas' ||
      this.id === 'select-canvas' || this.id === 'canvas-area';
    if (isViewport) {
      return { x: 0, y: 0, left: 0, top: 0, width: viewW, height: viewH, right: viewW, bottom: viewH, toJSON() { return this; } };
    }
    return { x: 0, y: 0, left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40, toJSON() { return this; } };
  };

  // Images decode "instantly" and report a fixed natural size.
  class MockImage {
    constructor() {
      this._w = opts.imgW || 400;
      this._h = opts.imgH || 300;
      this.onload = null;
      this.onerror = null;
      this.complete = false;
    }
    get width() { return this._w; }
    get height() { return this._h; }
    set src(v) {
      this._src = v;
      stats.imageSrcs.push(String(v));
      this.complete = true;
      // Defer like a real browser so async code paths are exercised.
      win.setTimeout(() => { if (this.onload) this.onload({ target: this }); }, 0);
    }
    get src() { return this._src; }
  }
  win.Image = MockImage;
  win.HTMLImageElement = MockImage;

  if (!win.document.fonts) {
    win.document.fonts = { ready: Promise.resolve(), load: () => Promise.resolve([]), check: () => true };
  }
  if (!win.performance) win.performance = { now: () => Date.now() };
  if (typeof win.URL.createObjectURL !== 'function') {
    win.URL.createObjectURL = () => 'blob:mock-object-url';
    win.URL.revokeObjectURL = () => {};
  }

  // jsdom does not expose the CanvasRenderingContext2D constructor, but the
  // app polyfills roundRect on its prototype and world.js reads clearRect
  // from it.  Provide a real (empty) prototype for that.
  if (typeof win.CanvasRenderingContext2D === 'undefined') {
    const Ctor = function CanvasRenderingContext2D() {};
    for (const name of CTX_METHODS) {
      Ctor.prototype[name] = function () { return undefined; };
    }
    Ctor.prototype.getTransform = function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; };
    Ctor.prototype.measureText = function (t) { return { width: String(t).length * 5 }; };
    Ctor.prototype.getImageData = function (x, y, w, h) { return new MockImageData(w, h); };
    Ctor.prototype.createImageData = function (w, h) { return new MockImageData(w, h); };
    Ctor.prototype.createLinearGradient = Ctor.prototype.createRadialGradient = function () { return new MockGradient(); };
    win.CanvasRenderingContext2D = Ctor;
  }

  return stats;
}
