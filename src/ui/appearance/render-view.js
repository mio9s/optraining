// 外観の描画ビュー: Worker プールでタイル並列描画、プログレッシブ蓄積、ドラッグ回転、線の断面
import { presetLights, prepareScene, renderTile } from '../../appearance/render.js';
import { linearToSrgb } from '../../appearance/color.js';

const TILE = 48;

/** Worker プール。Worker が使えない環境では UI スレッドで逐次実行する */
export function createPool() {
  const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const workers = [];
  try {
    const url = URL.createObjectURL(new Blob([__APPEAR_WORKER_SRC__], { type: 'text/javascript' }));
    for (let i = 0; i < n; i++) workers.push(new Worker(url));
  } catch (e) { console.warn('Worker を使えないため UI スレッドで描画します', e); }
  let sceneKey = '', sceneInfo = null, sceneSeq = 0, localCache = null;
  const pending = new Map(); // id → {resolve}
  let queue = [], seq = 0;
  const idle = new Set(workers);
  workers.forEach((w) => {
    w.onmessage = (e) => {
      const m = e.data;
      const p = pending.get(m.id);
      if (m.type !== 'ready') idle.add(w);
      if (p) { pending.delete(m.id); m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m); }
      pump();
    };
  });
  function pump() {
    while (idle.size && queue.length) {
      const w = idle.values().next().value;
      idle.delete(w);
      const it = queue.shift();
      w.postMessage(it.msg);
    }
  }
  return {
    size: workers.length || 1,
    async ensureScene(parts) {
      const key = JSON.stringify(parts);
      if (key === sceneKey && sceneInfo) return sceneInfo;
      sceneKey = key;
      if (!workers.length) { localCache = prepareScene(parts); sceneInfo = { center: localCache.center, size: localCache.size }; return sceneInfo; }
      const id = `s${++sceneSeq}`;
      const all = workers.map((w, i) => new Promise((resolve, reject) => { pending.set(`${id}-${i}`, { resolve, reject }); w.postMessage({ type: 'scene', id: `${id}-${i}`, parts }); }));
      const r = await Promise.all(all);
      sceneInfo = { center: r[0].center, size: r[0].size };
      return sceneInfo;
    },
    submit(job, tag) {
      if (!workers.length) return new Promise((resolve) => setTimeout(() => resolve({ job, ...renderTile(localCache, job) }), 0));
      const id = `t${++seq}`;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, tag }); queue.push({ msg: { type: 'tile', id, job }, tag }); pump(); });
    },
    cancel(tag) {
      queue = queue.filter((q) => {
        if (q.tag !== tag) return true;
        const p = pending.get(q.msg.id); pending.delete(q.msg.id); p?.resolve(null); return false;
      });
    },
  };
}

function tiles(w, h, base, pass) {
  const out = [];
  for (let y = 0; y < h; y += TILE) for (let x = 0; x < w; x += TILE) out.push({ ...base, width: w, height: h, pass, x0: x, y0: y, w: Math.min(TILE, w - x), h: Math.min(TILE, h - y) });
  return out;
}

/** 静止画を n パス描画(角度一覧など)。onPass(buf) で途中経過 */
export async function renderStill(pool, s, passes, tag, onPass) {
  const info = await pool.ensureScene(s.parts);
  const lights = [...(s.lights ?? []), ...presetLights(s.env, info)];
  const w = s.width, h = s.height;
  const buf = { w, h, rgb: new Float32Array(w * h * 3), y: new Float32Array(w * h), n: new Float32Array(w * h), contrib: {}, passes: 0 };
  for (let p = 0; p < passes; p++) {
    const res = await Promise.all(tiles(w, h, { camera: s.camera, env: s.env, lights, suppressInternal: !!s.suppressInternal, exactSpectral: !!s.exactSpectral }, p).map((j) => pool.submit(j, tag)));
    if (res.some((r) => r === null)) return null; // 取り消し
    for (const m of res) addTile(buf, m);
    buf.passes = p + 1;
    onPass?.(buf);
  }
  return buf;
}

function addTile(buf, m) {
  const { job } = m;
  for (let j = 0; j < job.h; j++) for (let i = 0; i < job.w; i++) {
    const k = (job.y0 + j) * buf.w + job.x0 + i, t = j * job.w + i;
    buf.rgb[k * 3] += m.rgb[t * 3]; buf.rgb[k * 3 + 1] += m.rgb[t * 3 + 1]; buf.rgb[k * 3 + 2] += m.rgb[t * 3 + 2];
    buf.y[k] += m.y[t]; buf.n[k] += 1;
  }
  for (const key in m.contrib) buf.contrib[key] = (buf.contrib[key] ?? 0) + m.contrib[key];
}

/** 蓄積バッファを canvas に描く。返り値: 使った露出 */
export function drawBuffer(canvas, buf, { exposure = 1, auto = true, line = null, scale = 1 } = {}) {
  canvas.width = buf.w; canvas.height = buf.h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(buf.w, buf.h);
  let ex = exposure;
  if (auto) {
    const ys = [];
    for (let i = 0; i < buf.y.length; i += 3) if (buf.n[i]) ys.push(buf.y[i] / buf.n[i]);
    ys.sort((a, b) => a - b);
    const ref = ys[Math.floor(ys.length * 0.99)] || 0;
    ex = ref > 0 ? 0.92 / ref : 1;
  }
  for (let k = 0; k < buf.w * buf.h; k++) {
    const n = buf.n[k] || 1;
    for (let c = 0; c < 3; c++) img.data[k * 4 + c] = Math.round(255 * linearToSrgb(Math.min(1, Math.max(0, (buf.rgb[k * 3 + c] / n) * ex))));
    img.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (line) {
    ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = Math.max(1, buf.w / 320);
    ctx.beginPath(); ctx.moveTo(line[0][0] * scale, line[0][1] * scale); ctx.lineTo(line[1][0] * scale, line[1][1] * scale); ctx.stroke();
    for (const p of line) { ctx.beginPath(); ctx.arc(p[0] * scale, p[1] * scale, 3 * Math.max(1, buf.w / 320), 0, 2 * Math.PI); ctx.stroke(); }
  }
  return ex;
}

export function bufferLuminance(buf) {
  const Y = new Float32Array(buf.w * buf.h);
  for (let k = 0; k < Y.length; k++) Y[k] = buf.n[k] ? buf.y[k] / buf.n[k] : 0;
  return { Y, w: buf.w, h: buf.h };
}

/**
 * 対話的な描画ビュー。cb: {onProgress(passes, max), onCamera(camera), onLine(line, lum), onExposure(ex), onError(msg), onFrame(buf)}
 */
export function createRenderView(canvas, pool, cb = {}) {
  let state = null, buf = null, gen = 0, idleTimer = null;
  let exposure = 1, auto = true, maxPasses = 32, lineMode = false, line = null, drag = null;

  const render = () => {
    if (!buf) return;
    const ex = drawBuffer(canvas, buf, { exposure, auto, line: buf.w === state.width ? line : null, scale: 1 });
    cb.onExposure?.(ex);
  };
  let previewBusy = false, previewPending = false, fullStarted = false;
  /**
   * ドラッグ中のプレビュー: 前のフレームが終わるまで次を出さず、最新の視点だけを描く。
   * 全解像度の描画が始まったら(手を離した後)、遅れて来たプレビューは出さない(全解像度を取り消さないため)。
   */
  async function preview() {
    fullStarted = false;
    if (previewBusy) { previewPending = true; return; }
    previewBusy = true;
    try {
      do { previewPending = false; if (fullStarted) break; await restart(true); } while (previewPending && !fullStarted);
    } finally { previewBusy = false; }
  }
  async function restart(lowRes) {
    if (!state) return;
    if (!lowRes) fullStarted = true;
    else if (fullStarted) return;
    const tag = ++gen;
    pool.cancel(tag - 1);
    const s = lowRes ? 3 : 1;
    const w = Math.max(16, Math.round(state.width / s)), h = Math.max(12, Math.round(state.height / s));
    if (!lowRes) cb.onProgress?.(0, maxPasses, false); // 描き直しを始めたことをすぐ表示
    try {
      const b = await renderStill(pool, { ...state, width: w, height: h }, lowRes ? 1 : maxPasses, tag, (bb) => {
        if (tag !== gen) return;
        buf = bb; render(); cb.onProgress?.(bb.passes, lowRes ? 1 : maxPasses, lowRes);
        if (!lowRes) { cb.onFrame?.(bb); if (line) cb.onLine?.(line, bufferLuminance(bb)); }
      });
      void b;
    } catch (e) { cb.onError?.(e.message); }
  }
  const toImage = (e) => { const r = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(state.width, ((e.clientX - r.left) / r.width) * state.width)), Math.max(0, Math.min(state.height, ((e.clientY - r.top) / r.height) * state.height))]; };
  canvas.addEventListener('pointerdown', (e) => {
    if (!state) return;
    canvas.setPointerCapture(e.pointerId);
    if (lineMode) { line = [toImage(e), toImage(e)]; drag = { line: true }; return; }
    drag = { x: e.clientX, y: e.clientY, az: state.camera.azimuth, el: state.camera.elevation, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.line) { line[1] = toImage(e); render(); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    state.camera.azimuth = drag.az - dx * 0.4;
    state.camera.elevation = Math.max(-89, Math.min(89, drag.el + dy * 0.4));
    cb.onCamera?.(state.camera);
    preview();
  });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.line) { if (buf && buf.w === state.width) cb.onLine?.(line, bufferLuminance(buf)); render(); return; }
    if (d.moved) { clearTimeout(idleTimer); idleTimer = setTimeout(() => restart(false), 120); }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    if (!state) return;
    e.preventDefault();
    state.camera.distance *= Math.exp(e.deltaY * 0.001);
    cb.onCamera?.(state.camera);
    preview(); clearTimeout(idleTimer); idleTimer = setTimeout(() => restart(false), 250);
  }, { passive: false });

  return {
    update(s, { keepLine = false } = {}) { state = s; if (!keepLine) line = null; restart(false); },
    setExposure(v, a) { exposure = v; auto = a; render(); },
    setLineMode(on) { lineMode = on; canvas.style.cursor = on ? 'crosshair' : 'grab'; },
    clearLine() { line = null; render(); },
    setMaxPasses(n) { maxPasses = n; },
    buffer: () => buf,
    line: () => line,
  };
}
