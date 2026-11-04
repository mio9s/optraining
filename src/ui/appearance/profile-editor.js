// 断面エディタ(ダイアログ)。座標: 横 = z(光軸方向、右が +)、縦 = r(上が +)。点は [r, z]
import { segmentEvaluator, validateProfile, asphereSag, bounds, tessellate } from '../../appearance/profile.js';
import { lensProfile } from '../../appearance/scene.js';
import { parseNumber } from '../editor.js';

const TOOLS = [
  ['select', '選択・移動', 'V'], ['line', '直線', 'L'], ['arc', '円弧(3 点)', 'A'], ['bezier', 'ベジェ', 'B'],
  ['spline', 'スプライン', 'S'], ['asphere', '非球面', 'P'],
];
const HINT = {
  select: '点をドラッグで移動。白丸 = 端点、四角 = 制御点・通過点。空いた所をドラッグで画面移動、ホイールで拡大縮小',
  line: '終点をクリック。最初のクリックは始点',
  arc: '弧の途中の点 → 終点 の順にクリック(現在の端点から 3 点を通る円弧)',
  bezier: '制御点 1 → 制御点 2 → 終点 の順にクリック',
  spline: '通過点を順にクリックし、ダブルクリック(または Enter)で終点を確定',
  asphere: '右の欄に非球面の係数と終点の r を入れて「追加」',
};

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null && v !== false) e.setAttribute(k, v); }
  for (const c of kids) if (c != null) e.append(c);
  return e;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmt = (v, d = 4) => (Number.isFinite(v) ? String(+v.toFixed(d)) : '');

/** 3 点を通る円の中心(点は [r, z])。一直線なら null */
function circleCenter(a, m, b) {
  // (z, r) を (x, y) とみる
  const [ax, ay, mx, my, bx, by] = [a[1], a[0], m[1], m[0], b[1], b[0]];
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
  if (Math.abs(d) < 1e-12) return null;
  const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d;
  const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d;
  return [uy, ux];
}
/** a → m → b を通る円弧のセグメント */
export function arcThrough(a, m, b) {
  const c = circleCenter(a, m, b);
  if (!c) return { type: 'line', to: b };
  const ang = (p) => Math.atan2(p[0] - c[0], p[1] - c[1]);
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccw = norm(ang(m) - ang(a)) < norm(ang(b) - ang(a));
  return { type: 'arc', to: b, center: c, ccw };
}

export function openProfileEditor(dialog, part, onSave) {
  let prof = part.profile ? clone(part.profile) : { start: null, segments: [] };
  if (!prof.start) prof = { start: null, segments: [] };
  const hist = [clone(prof)]; let hpos = 0;
  let tool = prof.start ? 'select' : 'line', pending = [], grid = true, snap = true, underlay = null;
  let view = null, drag = null, hover = null, cursor = null;

  dialog.replaceChildren();
  const canvas = h('canvas', { class: 'pe-canvas', tabindex: '0', 'aria-label': '断面の描画領域' });
  const status = h('div', { class: 'pe-status' });
  const errs = h('div', { class: 'pe-errors', role: 'alert' });
  const hint = h('div', { class: 'pe-hint' });
  const table = h('div', { class: 'pe-table' });
  const toolBtns = TOOLS.map(([k, label, key]) => h('button', { type: 'button', class: 'tool', 'data-tool': k, title: `${label}(${key})`, onclick: () => setTool(k) }, label));
  const nameInput = h('input', { type: 'text', value: part.name ?? '部品', class: 'pe-name', 'aria-label': '部品名' });
  const saveBtn = h('button', { type: 'button', class: 'primary', onclick: () => { if (!validateProfile(prof).ok) return; onSave({ ...part, name: nameInput.value || '部品', profile: clone(prof) }); dialog.close(); } }, '保存して閉じる');
  const asphereForm = (() => {
    const f = { R: 40, k: 0, A4: 0, A6: 0, A8: 0, A10: 0, r1: 10 };
    const box = h('fieldset', { class: 'pe-asph' }, h('legend', {}, '非球面'));
    for (const [k, label, title] of [['R', '曲率半径 R', '頂点の曲率半径 [mm](inf = 平面)'], ['k', '円錐定数 k', '0 = 球、−1 = 放物面'], ['A4', 'A4', 'r⁴ の係数'], ['A6', 'A6', 'r⁶'], ['A8', 'A8', 'r⁸'], ['A10', 'A10', 'r¹⁰'], ['r1', '終点の r', '非球面を描き終える高さ [mm]']]) {
      const inp = h('input', { type: 'text', value: String(f[k]), title });
      inp.addEventListener('input', () => { f[k] = parseNumber(inp.value, k === 'R'); });
      box.append(h('label', { class: 'field', title }, h('span', {}, label), inp));
    }
    box.append(h('button', { type: 'button', onclick: () => {
      const start = endPoint();
      if (!start) { setErr('先に始点をクリックしてください'); return; }
      const c = Number.isFinite(f.R) && f.R !== 0 ? 1 / f.R : 0;
      const seg0 = { c, k: f.k, A: [f.A4, f.A6, f.A8, f.A10], z0: 0 };
      const z0 = start[1] - (asphereSag(seg0, start[0]) - 0);
      const s = { type: 'asphere', z0, c, k: f.k, A: [f.A4, f.A6, f.A8, f.A10], to: [f.r1, 0] };
      s.to[1] = asphereSag(s, f.r1);
      if (!Number.isFinite(s.to[1])) { setErr('終点の r で非球面式が計算できません(√ の中が負)'); return; }
      prof.segments.push(s); commit();
    } }, '追加'));
    return box;
  })();
  const templateForm = (() => {
    const f = { R1: 50, R2: Infinity, t: 4, D: 25 };
    const box = h('fieldset', { class: 'pe-tmpl' }, h('legend', {}, 'レンズのひな形'));
    for (const [k, label, title] of [['R1', '前面 R1', '[mm]、inf = 平面'], ['R2', '後面 R2', '[mm]、inf = 平面'], ['t', '中心厚', '[mm]'], ['D', '外径', '[mm]']]) {
      const inp = h('input', { type: 'text', value: Number.isFinite(f[k]) ? String(f[k]) : 'inf', title });
      inp.addEventListener('input', () => { f[k] = parseNumber(inp.value, true); });
      box.append(h('label', { class: 'field', title }, h('span', {}, label), inp));
    }
    box.append(h('button', { type: 'button', onclick: () => {
      try { prof = lensProfile(0, f.R1, f.D / 2, f.t, f.R2, f.D / 2); commit(); fit(); } catch (e) { setErr(e.message); }
    } }, 'この形に置き換え'));
    return box;
  })();
  const underlayInput = h('input', { type: 'file', accept: 'image/*' });
  const ul = { z0: 0, r0: 0, width: 20, opacity: 0.4 };
  underlayInput.addEventListener('change', () => {
    const f = underlayInput.files[0]; if (!f) return;
    const img = new Image(); img.onload = () => { underlay = img; draw(); }; img.src = URL.createObjectURL(f);
  });
  const ulFields = ['z0', 'r0', 'width', 'opacity'].map((k) => {
    const label = { z0: '左端 z', r0: '下端 r', width: '幅', opacity: '不透明度' }[k];
    const inp = h('input', { type: 'text', value: String(ul[k]), title: k === 'width' ? '画像の横幅 [mm]' : k === 'opacity' ? '0〜1' : '[mm]' });
    inp.addEventListener('input', () => { const v = parseNumber(inp.value); if (Number.isFinite(v)) { ul[k] = v; draw(); } });
    return h('label', { class: 'field' }, h('span', {}, label), inp);
  });

  dialog.append(
    h('div', { class: 'pe-head' }, h('h2', {}, '断面エディタ'), h('label', { class: 'field' }, h('span', {}, '部品名'), nameInput), h('div', { class: 'pe-actions' }, saveBtn, h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'キャンセル'))),
    h('div', { class: 'pe-toolbar' }, ...toolBtns,
      h('button', { type: 'button', title: '最後の点から始点へ直線で閉じる(C)', onclick: closeContour }, '閉じる'),
      h('span', { class: 'sep' }),
      h('button', { type: 'button', title: '元に戻す(Ctrl+Z)', onclick: undo }, '↶ 元に戻す'),
      h('button', { type: 'button', title: 'やり直す(Ctrl+Y)', onclick: redo }, '↷ やり直す'),
      h('button', { type: 'button', title: '最後のセグメントを削除(Delete)', onclick: () => { if (prof.segments.length) { prof.segments.pop(); commit(); } else if (prof.start) { prof.start = null; commit(); } } }, '最後を削除'),
      h('button', { type: 'button', title: 'すべて消す', onclick: () => { prof = { start: null, segments: [] }; commit(); } }, '新規'),
      h('span', { class: 'sep' }),
      h('label', { class: 'check' }, (() => { const c = h('input', { type: 'checkbox', checked: true }); c.addEventListener('change', () => { grid = c.checked; draw(); }); return c; })(), ' グリッド'),
      h('label', { class: 'check' }, (() => { const c = h('input', { type: 'checkbox', checked: true }); c.addEventListener('change', () => { snap = c.checked; }); return c; })(), ' スナップ'),
      h('button', { type: 'button', onclick: () => fit() }, '全体表示')),
    h('div', { class: 'pe-body' },
      h('div', { class: 'pe-main' }, canvas, hint, status, errs),
      h('div', { class: 'pe-side' }, templateForm, asphereForm,
        h('fieldset', {}, h('legend', {}, '下絵(画像)'), h('label', { class: 'file' }, '画像を選ぶ…', underlayInput), ...ulFields),
        h('h3', {}, '数値で編集'), table)),
  );

  function setErr(m) { errs.textContent = m; }
  function endPoint() { return prof.segments.length ? prof.segments[prof.segments.length - 1].to : prof.start; }
  function commit() {
    hist.length = hpos + 1; hist.push(clone(prof)); hpos = hist.length - 1;
    pending = []; refresh();
  }
  function undo() { if (hpos > 0) { prof = clone(hist[--hpos]); pending = []; refresh(); } }
  function redo() { if (hpos < hist.length - 1) { prof = clone(hist[++hpos]); pending = []; refresh(); } }
  function closeContour() {
    const e = endPoint();
    if (!prof.start || !e || !prof.segments.length) return;
    if (Math.hypot(e[0] - prof.start[0], e[1] - prof.start[1]) > 1e-9) prof.segments.push({ type: 'line', to: [...prof.start] });
    else prof.segments[prof.segments.length - 1].to = [...prof.start];
    commit(); setTool('select');
  }
  function setTool(t) {
    tool = t; pending = [];
    toolBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    hint.textContent = HINT[t];
    asphereForm.classList.toggle('hl', t === 'asphere');
    draw();
  }

  // ---- 表示変換 ----
  function fit() {
    const W = canvas.clientWidth || 600, H = canvas.clientHeight || 400;
    let r1 = 5, z0 = -1, z1 = 5;
    if (prof.start) {
      const pts = [prof.start, ...prof.segments.flatMap((s) => [s.to, s.c1, s.c2, ...(s.through ?? [])].filter(Boolean))];
      r1 = Math.max(1, ...pts.map((p) => p[0])); z0 = Math.min(...pts.map((p) => p[1])); z1 = Math.max(...pts.map((p) => p[1]));
    }
    const span = Math.max(z1 - z0, 1e-3), pad = 0.15;
    const scale = Math.min(W / (span * (1 + 2 * pad)), H / (2 * r1 * (1 + pad)));
    view = { scale, cz: (z0 + z1) / 2, cr: 0 };
    draw();
  }
  const X = (z) => canvas.clientWidth / 2 + (z - view.cz) * view.scale;
  const Y = (r) => canvas.clientHeight / 2 - (r - view.cr) * view.scale;
  const toWorld = (px, py) => [view.cr - (py - canvas.clientHeight / 2) / view.scale, view.cz + (px - canvas.clientWidth / 2) / view.scale];
  function gridStep() { const target = 60 / view.scale; const p = 10 ** Math.floor(Math.log10(target)); return [1, 2, 5, 10].map((k) => k * p).find((v) => v >= target); }
  function snapPoint(p) {
    // 既存の点へ(8 px 以内)→ グリッドへ
    for (const q of allPoints()) if (Math.hypot((q.p[1] - p[1]) * view.scale, (q.p[0] - p[0]) * view.scale) < 8) return [...q.p];
    if (!snap) return p;
    const g = gridStep() / 5;
    return [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
  }
  function allPoints() {
    const out = [];
    if (prof.start) out.push({ p: prof.start, ref: ['start'], kind: 'end' });
    prof.segments.forEach((s, i) => {
      out.push({ p: s.to, ref: [i, 'to'], kind: 'end' });
      if (s.c1) { out.push({ p: s.c1, ref: [i, 'c1'], kind: 'ctrl' }); out.push({ p: s.c2, ref: [i, 'c2'], kind: 'ctrl' }); }
      (s.through ?? []).forEach((q, k) => out.push({ p: q, ref: [i, 'through', k], kind: 'ctrl' }));
    });
    return out;
  }

  function draw() {
    if (!view) return;
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--fg').trim() || '#222', muted = css.getPropertyValue('--muted').trim() || '#888', line = css.getPropertyValue('--line').trim() || '#ddd', accent = css.getPropertyValue('--accent').trim() || '#2b6cb0';
    ctx.clearRect(0, 0, W, H);
    if (underlay) {
      ctx.globalAlpha = ul.opacity;
      const w = ul.width * view.scale, hh = (underlay.naturalHeight / underlay.naturalWidth) * w;
      ctx.drawImage(underlay, X(ul.z0), Y(ul.r0) - hh, w, hh);
      ctx.globalAlpha = 1;
    }
    if (grid) {
      const g = gridStep();
      ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.fillStyle = muted; ctx.font = '10px system-ui, sans-serif';
      const [rTop, zL] = toWorld(0, 0), [rBot, zR] = toWorld(W, H);
      for (let z = Math.ceil(zL / g) * g; z <= zR; z += g) { ctx.beginPath(); ctx.moveTo(X(z), 0); ctx.lineTo(X(z), H); ctx.stroke(); ctx.fillText(fmt(z, 3), X(z) + 2, H - 4); }
      for (let r = Math.ceil(rBot / g) * g; r <= rTop; r += g) { ctx.beginPath(); ctx.moveTo(0, Y(r)); ctx.lineTo(W, Y(r)); ctx.stroke(); ctx.fillText(fmt(r, 3), 2, Y(r) - 2); }
    }
    // 光軸
    ctx.strokeStyle = muted; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = muted; ctx.fillText('光軸 (r = 0) →  z', 6, Y(0) - 4);
    if (!prof.start) return;
    // 輪郭(上半分 = 編集対象、下半分 = 鏡映のうすい表示)
    const v = validateProfile(prof);
    const pathOf = (mirror) => {
      ctx.beginPath();
      ctx.moveTo(X(prof.start[1]), Y(mirror * prof.start[0]));
      let cur = prof.start;
      prof.segments.forEach((s) => {
        let ev; try { ev = segmentEvaluator(cur, s); } catch { ev = null; }
        for (let k = 1; k <= 64 && ev; k++) { const p = ev.at(k / 64); if (p.every(Number.isFinite)) ctx.lineTo(X(p[1]), Y(mirror * p[0])); }
        cur = s.to;
      });
    };
    if (v.ok) { pathOf(1); ctx.fillStyle = 'rgba(110,165,230,0.25)'; ctx.fill(); pathOf(-1); ctx.fillStyle = 'rgba(110,165,230,0.10)'; ctx.fill(); }
    pathOf(1); ctx.strokeStyle = v.ok ? fg : '#d93025'; ctx.lineWidth = 2; ctx.stroke();
    // 制御線
    let cur = prof.start;
    ctx.strokeStyle = muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    prof.segments.forEach((s) => { if (s.c1) { ctx.beginPath(); ctx.moveTo(X(cur[1]), Y(cur[0])); ctx.lineTo(X(s.c1[1]), Y(s.c1[0])); ctx.moveTo(X(s.to[1]), Y(s.to[0])); ctx.lineTo(X(s.c2[1]), Y(s.c2[0])); ctx.stroke(); } cur = s.to; });
    ctx.setLineDash([]);
    for (const q of allPoints()) {
      ctx.fillStyle = q === hover ? accent : q.kind === 'end' ? '#fff' : '#ffd166'; ctx.strokeStyle = fg; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (q.kind === 'end') ctx.arc(X(q.p[1]), Y(q.p[0]), 4.5, 0, 2 * Math.PI); else ctx.rect(X(q.p[1]) - 3.5, Y(q.p[0]) - 3.5, 7, 7);
      ctx.fill(); ctx.stroke();
    }
    // 作図中のプレビュー
    if (cursor && tool !== 'select' && tool !== 'asphere' && prof.start) {
      const e = endPoint(), pts = [...pending, cursor];
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      const seg = previewSeg(e, pts);
      if (seg) {
        let ev; try { ev = segmentEvaluator(e, seg); } catch { ev = null; }
        ctx.beginPath(); ctx.moveTo(X(e[1]), Y(e[0]));
        for (let k = 1; k <= 48 && ev; k++) { const p = ev.at(k / 48); ctx.lineTo(X(p[1]), Y(p[0])); }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const p of pending) { ctx.fillStyle = accent; ctx.fillRect(X(p[1]) - 3, Y(p[0]) - 3, 6, 6); }
    }
  }
  function previewSeg(e, pts) {
    if (tool === 'line') return { type: 'line', to: pts[pts.length - 1] };
    if (tool === 'arc') return pts.length >= 2 ? arcThrough(e, pts[0], pts[1]) : { type: 'line', to: pts[0] };
    if (tool === 'bezier') return { type: 'bezier', c1: pts[0], c2: pts[1] ?? pts[0], to: pts[2] ?? pts[pts.length - 1] };
    if (tool === 'spline') return pts.length >= 2 ? { type: 'spline', through: pts.slice(0, -1), to: pts[pts.length - 1] } : { type: 'line', to: pts[0] };
    return null;
  }

  function refresh() {
    const v = validateProfile(prof);
    saveBtn.disabled = !v.ok;
    errs.textContent = prof.start ? (v.ok ? '' : `この断面はまだ使えません: ${v.errors.join(' / ')}`) : '';
    if (v.ok) {
      const b = bounds(tessellate(prof));
      status.dataset.dims = `外径 Φ${fmt(2 * b.rMax, 3)} mm、厚み ${fmt(b.zMax - b.zMin, 3)} mm(z ${fmt(b.zMin, 3)} 〜 ${fmt(b.zMax, 3)})`;
    } else status.dataset.dims = '';
    updateStatus(); renderTable(); draw();
  }
  function updateStatus() {
    status.textContent = [cursor ? `カーソル r = ${fmt(cursor[0], 3)}, z = ${fmt(cursor[1], 3)} mm` : '', status.dataset.dims].filter(Boolean).join('  |  ');
  }

  // ---- 数値表 ----
  function renderTable() {
    table.replaceChildren();
    if (!prof.start) { table.append(h('p', { class: 'note' }, '描画領域をクリックして始点を置くか、「レンズのひな形」から始めてください。')); return; }
    const num = (obj, idx, label, onSet) => {
      const inp = h('input', { type: 'text', value: fmt(obj[idx], 6), 'aria-label': label });
      inp.addEventListener('change', () => { const v = parseNumber(inp.value); if (Number.isFinite(v)) { onSet(v); commit(); } else inp.classList.add('invalid'); });
      return h('label', { class: 'field' }, h('span', {}, label), inp);
    };
    const pt = (p, label, onChange) => h('div', { class: 'pe-pt' }, h('b', {}, label), num(p, 0, 'r', (v) => { p[0] = v; onChange?.(); }), num(p, 1, 'z', (v) => { p[1] = v; onChange?.(); }));
    table.append(pt(prof.start, '始点'));
    let cur = prof.start;
    prof.segments.forEach((s, i) => {
      const label = { line: '直線', arc: '円弧', bezier: 'ベジェ', spline: 'スプライン', asphere: '非球面' }[s.type];
      const row = h('div', { class: 'pe-seg' }, h('div', { class: 'pe-seg-h' }, `${i + 1}. ${label}`, segInfo(cur, s)));
      if (s.type === 'arc') {
        const mid = segmentEvaluator(cur, s).at(0.5), start = cur;
        row.append(pt(s.to, '終点', () => Object.assign(s, arcThrough(start, mid, s.to))));
        const R = Math.hypot(s.to[0] - s.center[0], s.to[1] - s.center[1]);
        row.append(h('div', { class: 'note' }, `中心 r=${fmt(s.center[0], 4)}, z=${fmt(s.center[1], 4)}、半径 ${fmt(R, 4)} mm`));
      } else if (s.type === 'asphere') {
        const fields = h('div', { class: 'pe-pt' }, num(s, 'z0', 'z0', (v) => { s.z0 = v; s.to[1] = asphereSag(s, s.to[0]); }), num(s, 'c', 'c=1/R', (v) => { s.c = v; s.to[1] = asphereSag(s, s.to[0]); }), num(s, 'k', 'k', (v) => { s.k = v; s.to[1] = asphereSag(s, s.to[0]); }));
        s.A.forEach((_, k) => fields.append(num(s.A, k, `A${4 + 2 * k}`, (v) => { s.A[k] = v; s.to[1] = asphereSag(s, s.to[0]); })));
        row.append(fields, h('div', { class: 'pe-pt' }, h('b', {}, '終点'), num(s.to, 0, 'r', (v) => { s.to[0] = v; s.to[1] = asphereSag(s, v); })));
      } else {
        if (s.c1) { row.append(pt(s.c1, '制御点 1')); row.append(pt(s.c2, '制御点 2')); }
        (s.through ?? []).forEach((q, k) => row.append(pt(q, `通過点 ${k + 1}`)));
        row.append(pt(s.to, '終点'));
      }
      table.append(row);
      cur = s.to;
    });
  }
  function segInfo(a, s) {
    if (s.type === 'line') return h('small', {}, ` 長さ ${fmt(Math.hypot(s.to[0] - a[0], s.to[1] - a[1]), 4)} mm`);
    if (s.type === 'arc') return h('small', {}, ` R ${fmt(Math.hypot(a[0] - s.center[0], a[1] - s.center[1]), 4)} mm`);
    return null;
  }

  // ---- 操作 ----
  const evPos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function hitPoint(px, py) {
    let best = null, bd = 9;
    for (const q of allPoints()) { const d = Math.hypot(X(q.p[1]) - px, Y(q.p[0]) - py); if (d < bd) { bd = d; best = q; } }
    return best;
  }
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const [px, py] = evPos(e);
    const w = snapPoint(toWorld(px, py));
    if (tool === 'select') {
      const q = hitPoint(px, py);
      if (q) { drag = { q, arcMids: arcMidsAround(q) }; canvas.setPointerCapture(e.pointerId); }
      else { drag = { pan: true, x: px, y: py, cz: view.cz, cr: view.cr }; canvas.setPointerCapture(e.pointerId); }
      return;
    }
    if (!prof.start) { prof.start = [Math.max(0, w[0]), w[1]]; commit(); return; }
    if (tool === 'asphere') return;
    pending.push([Math.max(0, w[0]), w[1]]);
    const e0 = endPoint();
    const need = { line: 1, arc: 2, bezier: 3 }[tool];
    if (need && pending.length >= need) { prof.segments.push(previewSeg(e0, pending)); commit(); }
    draw();
  });
  canvas.addEventListener('dblclick', () => {
    if (tool === 'spline' && pending.length >= 1) { prof.segments.push(previewSeg(endPoint(), pending)); commit(); }
  });
  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = evPos(e);
    cursor = snapPoint(toWorld(px, py));
    if (drag?.pan) { view.cz = drag.cz - (px - drag.x) / view.scale; view.cr = drag.cr + (py - drag.y) / view.scale; draw(); return; }
    if (drag?.q) {
      const ref = drag.q.ref, p = [Math.max(0, cursor[0]), cursor[1]];
      if (ref[0] === 'start') { prof.start = p; if (prof.segments.length) { const last = prof.segments[prof.segments.length - 1]; if (Math.hypot(last.to[0] - drag.q.p[0], last.to[1] - drag.q.p[1]) < 1e-9) last.to = [...p]; } }
      else if (ref[1] === 'through') prof.segments[ref[0]].through[ref[2]] = p;
      else prof.segments[ref[0]][ref[1]] = p;
      drag.q.p = ref[0] === 'start' ? prof.start : ref[1] === 'through' ? prof.segments[ref[0]].through[ref[2]] : prof.segments[ref[0]][ref[1]];
      fixArcs(drag.arcMids);
      refresh(); return;
    }
    hover = tool === 'select' ? hitPoint(px, py) : null;
    updateStatus(); draw();
  });
  canvas.addEventListener('pointerup', () => { if (drag?.q) commit(); drag = null; });
  canvas.addEventListener('pointerleave', () => { cursor = null; draw(); updateStatus(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = evPos(e), before = toWorld(px, py);
    view.scale *= Math.exp(-e.deltaY * 0.0015);
    const after = toWorld(px, py);
    view.cz += before[1] - after[1]; view.cr += before[0] - after[0];
    draw();
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if (k === 'enter' && tool === 'spline' && pending.length) { prof.segments.push(previewSeg(endPoint(), pending)); commit(); return; }
    if (k === 'escape') { pending = []; draw(); return; }
    if (k === 'delete' || k === 'backspace') { if (prof.segments.length) { prof.segments.pop(); commit(); } return; }
    if (k === 'c') { closeContour(); return; }
    const t = TOOLS.find((x) => x[2].toLowerCase() === k);
    if (t) setTool(t[0]);
  });
  /** 動かす点に接する円弧について、弧の中点を覚えておく(端点を動かしても弧の形を保つ) */
  function arcMidsAround(q) {
    const out = [];
    let cur = prof.start;
    prof.segments.forEach((s, i) => {
      if (s.type === 'arc') out.push({ i, mid: segmentEvaluator(cur, s).at(0.5) });
      cur = s.to;
    });
    void q;
    return out;
  }
  function fixArcs(mids) {
    let cur = prof.start;
    prof.segments.forEach((s, i) => {
      const m = mids.find((x) => x.i === i);
      if (s.type === 'arc' && m) Object.assign(s, arcThrough(cur, m.mid, s.to));
      cur = s.to;
    });
  }

  new ResizeObserver(() => draw()).observe(canvas);
  dialog.showModal();
  requestAnimationFrame(() => { fit(); setTool(tool); refresh(); });
}
