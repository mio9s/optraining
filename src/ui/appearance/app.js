// 外観画面の制御: 部品リスト、取り込み、照明、描画ビュー、数値(反射率・断面・判定・寄与)、角度一覧
import uPlot from 'uplot';
import { partsFromSystem, validateScene, OPAQUE, newId, placedProfile, partBounds, isMesh, meshData } from '../../appearance/scene.js';
import { openStlImport, sliceXZ } from './stl-import.js';
import { importProfiles } from '../../appearance/import.js';
import { tessellate, bounds, segmentEvaluator } from '../../appearance/profile.js';
import { COATINGS } from '../../appearance/thinfilm.js';
import { ENV_PRESETS, defaultCamera, internalVisibility, cameraBasis } from '../../appearance/render.js';
import { reflectanceVsAngle, reflectanceVsWavelength, lineProfile, boundaryContrast, contributionTable } from '../../appearance/analysis.js';
import { buildTraceScene } from '../../appearance/nstrace.js';
import { listPresets, refractiveIndex } from '../../core/glass.js';
import { parseNumber } from '../editor.js';
import { createPool, createRenderView, renderStill, drawBuffer } from './render-view.js';
import { materialPalette, materialKey } from '../material-colors.js';
import { openProfileEditor } from './profile-editor.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null && v !== false) e.setAttribute(k, v); }
  for (const c of kids) if (c != null) e.append(c);
  return e;
};
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 3) => (Number.isFinite(v) ? String(+v.toFixed(d)) : '—');
const PRESETS = listPresets();
const RES = { s: [320, 240], m: [640, 480], l: [960, 720] };

export const defaultAppearance = () => ({ parts: null, env: 'room', lights: [], camera: null, res: 'm', threshold: 2, quality: 'standard', autoParts: { iris: true, barrel: false } });

/** 面の名前(前面/後面/コバ/段) */
export function faceLabel(part, seg) {
  if (isMesh(part)) return seg === 0 ? '表面' : null;
  const edges = tessellate(placedProfile(part)).filter((e) => e.seg === seg && !e.onAxis);
  if (!edges.length) return null;
  const e = edges[Math.floor(edges.length / 2)];
  const n = [(e.na[0] + e.nb[0]) / 2, (e.na[1] + e.nb[1]) / 2];
  if (Math.abs(n[1]) > 0.7) return n[1] < 0 ? '前面' : '後面';
  if (n[0] > 0.7) return 'コバ(外周)';
  return n[0] < -0.7 ? '内周' : '斜面';
}

export function initAppearance({ getSystem, getState, setState }) {
  const st = getState();
  const pool = createPool();
  let view = null, plot = null;

  // ---------- 部品 ----------
  function ensureParts() {
    if (!st.parts) regenerate();
  }
  function regenerate() {
    const r = partsFromSystem(getSystem(), st.autoParts);
    st.parts = r.parts;
    $('ap-warn').textContent = r.warnings.join(' / ');
    st.camera = defaultCamera(st.parts);
  }
  /** 既存部品の最も後ろの z(なければ −∞) */
  function zEndOf(parts) {
    let zEnd = -Infinity;
    for (const p of parts) { try { zEnd = Math.max(zEnd, partBounds(p).zMax); } catch { /* */ } }
    return zEnd;
  }
  function materialSelect(p) {
    const sel = h('select', { 'aria-label': `${p.name} の材質` });
    const g = h('optgroup', { label: 'ガラス' });
    for (const x of PRESETS) g.append(h('option', { value: `preset:${x.name}` }, x.name));
    const o = h('optgroup', { label: '不透明' });
    for (const [k, v] of Object.entries(OPAQUE)) o.append(h('option', { value: `opaque:${k}` }, v.label));
    sel.append(g, h('option', { value: 'model' }, 'カスタム (nd・νd)'), o);
    const m = p.material;
    sel.value = m.type === 'preset' ? `preset:${m.name}` : m.type === 'opaque' ? `opaque:${m.kind}` : 'model';
    sel.addEventListener('change', () => {
      const v = sel.value;
      p.material = v.startsWith('preset:') ? { type: 'preset', name: v.slice(7) } : v.startsWith('opaque:') ? { type: 'opaque', kind: v.slice(7) } : { type: 'model', nd: 1.5, vd: 50 };
      changed(true);
    });
    return sel;
  }
  function renderParts() {
    const box = $('ap-parts');
    box.replaceChildren();
    const v = validateScene(st.parts);
    const bad = new Set(v.errors.map((e) => e.part));
    const pal = materialPalette(st.parts.map((p) => p.material));
    st.parts.forEach((p, i) => {
      const vis = h('input', { type: 'checkbox', title: '表示する', 'aria-label': `${p.name} を表示` }); vis.checked = p.visible !== false;
      vis.addEventListener('change', () => { p.visible = vis.checked; changed(true); });
      const name = h('input', { type: 'text', value: p.name, class: 'ap-name', 'aria-label': '部品名' });
      name.addEventListener('change', () => { p.name = name.value; changed(false); });
      const mesh = isMesh(p);
      const offInput = (axis, k) => {
        const cur = mesh ? (p.offset ?? [0, 0, 0])[k] : p.zOffset ?? 0;
        const inp = h('input', { type: 'text', value: String(+cur.toFixed(6)), class: 'num', title: `${axis} 方向の移動量 [mm]`, 'aria-label': `${p.name} の ${axis} 方向の移動量` });
        inp.addEventListener('change', () => {
          const x = parseNumber(inp.value);
          if (!Number.isFinite(x)) { inp.classList.add('invalid'); return; }
          if (mesh) { p.offset = [...(p.offset ?? [0, 0, 0])]; p.offset[k] = x; } else p.zOffset = x;
          changed(true);
        });
        return h('label', { class: 'field' }, h('span', {}, `Δ${axis}`), inp, h('small', {}, 'mm'));
      };
      const moves = mesh ? [offInput('x', 0), offInput('y', 1), offInput('z', 2)] : [offInput('z', 2)];
      const col = pal.get(materialKey(p.material));
      const row = h('div', { class: `ap-part${bad.has(p.id) ? ' invalid' : ''}`, style: col ? `border-left: 5px solid ${col.solid}` : p.material.type === 'opaque' ? 'border-left: 5px solid #555' : null },
        h('div', { class: 'ap-row' }, vis, name, h('span', { class: 'muted', title: mesh ? `三角形 ${(p.mesh.triangles ?? 0).toLocaleString()} 枚${p.mesh.open ? `、閉じていない辺 ${p.mesh.open} 本` : ''}` : null }, p.source === 'auto' ? '自動' : p.source === 'stl' ? `STL(${(p.mesh.triangles ?? 0).toLocaleString()} 面)` : p.source === 'import' ? '取込' : '描画')),
        h('div', { class: 'ap-row' }, materialSelect(p),
          p.material.type === 'model' ? modelInputs(p) : null),
        h('div', { class: 'ap-row' }, ...moves),
        mesh && p.mesh.open ? h('div', { class: 'warn' }, `閉じていない立体です(開いた辺 ${p.mesh.open} 本)。内外の判定が誤ることがあります`) : null,
        h('div', { class: 'ap-row' },
          mesh ? null : h('button', { type: 'button', onclick: () => openProfileEditor($('pe-dialog'), p, (np) => { Object.assign(p, np, { source: p.source === 'auto' ? 'draw' : p.source }); changed(true); }) }, '断面を編集…'),
          h('button', { type: 'button', onclick: () => openCoatings(p) }, `コート…${Object.keys(p.coatings ?? {}).length ? `(${Object.keys(p.coatings).length})` : ''}`),
          h('button', { type: 'button', title: '複製', onclick: () => { st.parts.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(p)), id: newId(), name: `${p.name} のコピー`, source: mesh ? 'stl' : 'draw' }); changed(true); } }, '複製'),
          h('button', { type: 'button', title: '削除', onclick: () => { st.parts.splice(i, 1); changed(true); } }, '✕')),
      );
      box.append(row);
    });
    $('ap-errors').textContent = v.errors.map((e) => e.message).join(' / ');
    drawSection();
  }
  function modelInputs(p) {
    const mk = (k, label) => {
      const inp = h('input', { type: 'text', value: String(p.material[k]), class: 'num', 'aria-label': label });
      inp.addEventListener('change', () => { const v = parseNumber(inp.value); if (Number.isFinite(v) && v > 0) { p.material[k] = v; changed(true); } else inp.classList.add('invalid'); });
      return h('label', { class: 'field' }, h('span', {}, label), inp);
    };
    return h('span', { class: 'ap-model' }, mk('nd', 'nd'), mk('vd', 'νd'));
  }
  function openCoatings(p) {
    const dlg = $('ap-dialog');
    dlg.replaceChildren();
    const rows = (isMesh(p) ? [0] : p.profile.segments.map((_, i) => i)).map((seg) => {
      const label = faceLabel(p, seg);
      if (!label) return null;
      const sel = h('select', {}, ...Object.entries(COATINGS).map(([k, c]) => h('option', { value: k }, c.label)), h('option', { value: 'custom' }, 'カスタム(層を入力)'));
      const cur = p.coatings?.[seg];
      const custom = h('input', { type: 'text', class: 'ap-layers', placeholder: '例: 1.38/99.6, 2.1/65.5(屈折率/膜厚 nm を外側から)', value: cur && typeof cur === 'object' ? cur.layers.map((l) => `${l.n}/${+l.d.toFixed(2)}`).join(', ') : '' });
      sel.value = typeof cur === 'string' ? cur : cur ? 'custom' : 'none';
      custom.hidden = sel.value !== 'custom';
      sel.addEventListener('change', () => { custom.hidden = sel.value !== 'custom'; });
      return { seg, label, sel, custom };
    }).filter(Boolean);
    dlg.append(h('h2', {}, `${p.name} のコート`), h('p', { class: 'note' }, '層は「部品の外側(空気側)→ 部品(基板)」の順に並べます。接着剤・オイルの薄い層もここで表せます。'),
      h('table', { class: 'kv' }, h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, isMesh(p) ? '表面全体(STL)' : `面 ${r.seg + 1}(${r.label})`), h('td', {}, r.sel, r.custom))))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => {
          const c = {};
          for (const r of rows) {
            if (r.sel.value === 'custom') {
              const layers = r.custom.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [n, d] = s.split('/').map(Number); return { n, d }; });
              if (layers.some((l) => !(l.n > 0) || !(l.d >= 0))) { r.custom.classList.add('invalid'); return; }
              if (layers.length) c[r.seg] = { layers };
            } else if (r.sel.value !== 'none') c[r.seg] = r.sel.value;
          }
          p.coatings = c; dlg.close(); changed(true);
        } }, '適用'),
        h('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, 'キャンセル')));
    dlg.showModal();
  }

  // ---------- 断面のプレビュー(全部品) ----------
  function drawSection() {
    const c = $('ap-section'), ctx = c.getContext('2d');
    const W = c.clientWidth, H = c.clientHeight, dpr = devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const vis = st.parts.filter((p) => p.visible !== false);
    if (!vis.length) return;
    let rMax = 1, z0 = Infinity, z1 = -Infinity;
    // 回転体は断面、STL は y = 0 の平面での切り口(z–x)を描く
    const ed = vis.map((p) => {
      try {
        const b = partBounds(p);
        rMax = Math.max(rMax, isMesh(p) ? Math.max(Math.abs(b.lo[0]), Math.abs(b.hi[0])) : b.rMax); z0 = Math.min(z0, b.zMin); z1 = Math.max(z1, b.zMax);
        if (isMesh(p)) { const m = meshData(p); return { cut: sliceXZ(m.V, m.F, 0, p.offset ?? [0, 0, 0]) }; }
        return tessellate(placedProfile(p));
      } catch { return []; }
    });
    const s = Math.min((W - 20) / Math.max(z1 - z0, 1e-3), (H - 20) / (2 * rMax));
    const X = (z) => 10 + (z - z0) * s + ((W - 20) - (z1 - z0) * s) / 2, Y = (r) => H / 2 - r * s;
    const pal = materialPalette(st.parts.map((p) => p.material));
    vis.forEach((p, i) => {
      if (ed[i].cut) {
        ctx.strokeStyle = p.material.type === 'opaque' ? 'rgba(60,60,60,0.9)' : pal.get(materialKey(p.material))?.solid ?? '#2b6cb0';
        ctx.lineWidth = 1.6; ctx.beginPath();
        for (const [a, b] of ed[i].cut) { ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(b[0]), Y(b[1])); }
        ctx.stroke();
        return;
      }
      for (const m of [1, -1]) {
        ctx.beginPath();
        ed[i].forEach((e, k) => { if (!k) ctx.moveTo(X(e.a[1]), Y(m * e.a[0])); ctx.lineTo(X(e.b[1]), Y(m * e.b[0])); });
        ctx.closePath();
        ctx.fillStyle = p.material.type === 'opaque' ? 'rgba(60,60,60,0.8)' : pal.get(materialKey(p.material))?.fill(0.45) ?? 'rgba(110,165,230,0.35)';
        ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.8; ctx.stroke();
      }
    });
    ctx.strokeStyle = '#888'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke(); ctx.setLineDash([]);
  }

  // ---------- 取り込み ----------
  $('ap-file').addEventListener('change', async () => {
    const f = $('ap-file').files[0]; $('ap-file').value = '';
    if (!f) return;
    const ext = f.name.toLowerCase().split('.').pop();
    if (ext === 'stl') {
      const buf = await f.arrayBuffer();
      openStlImport($('ap-dialog'), f.name, buf, {
        zEnd: zEndOf(st.parts), newId,
        onAdd: (bodies, o) => {
          for (const b of bodies) st.parts.push({ id: newId(), name: b.name, kind: 'mesh', mesh: b.mesh, offset: b.offset, creaseDeg: o.creaseDeg, contactTol: o.contactTol, material: { type: 'preset', name: 'N-BK7' }, coatings: {}, source: 'stl', visible: true });
          changed(true, true);
        },
      });
      return;
    }
    const format = ext === 'svg' ? 'svg' : ext === 'dxf' ? 'dxf' : 'csv';
    const text = await f.text();
    openImport(f.name, text, format);
  });
  function openImport(fileName, text, format) {
    const dlg = $('ap-dialog');
    dlg.replaceChildren();
    const opts = { axis: 'x', axisMode: 'center', axisValue: 0, smooth: true, mmPerUnit: undefined, flipZ: false };
    const preview = h('canvas', { class: 'ap-import-preview' });
    const msg = h('div', { class: 'note' });
    let result = null;
    const update = () => {
      result = importProfiles(text, format, { ...opts, mmPerUnit: opts.mmPerUnit });
      msg.textContent = `${result.profiles.length} 個の輪郭を取り込めます(1 単位 = ${fmt(result.mmPerUnit, 5)} mm)。${result.warnings.join(' / ')}`;
      const ctx = preview.getContext('2d'), W = (preview.width = 420), H = (preview.height = 220);
      ctx.clearRect(0, 0, W, H);
      const all = result.profiles.map((p) => tessellate(p));
      if (!all.length) return;
      let r = 1, z0 = Infinity, z1 = -Infinity;
      for (const e of all) { const b = bounds(e); r = Math.max(r, b.rMax); z0 = Math.min(z0, b.zMin); z1 = Math.max(z1, b.zMax); }
      const s = Math.min((W - 20) / Math.max(z1 - z0, 1e-3), (H - 20) / (2 * r));
      ctx.strokeStyle = '#888'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke(); ctx.setLineDash([]);
      for (const e of all) for (const m of [1, -1]) {
        ctx.beginPath(); e.forEach((x, k) => { const px = 10 + (x.a[1] - z0) * s, py = H / 2 - m * x.a[0] * s; if (!k) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
        ctx.closePath(); ctx.fillStyle = m > 0 ? 'rgba(110,165,230,0.4)' : 'rgba(110,165,230,0.15)'; ctx.fill(); ctx.strokeStyle = '#2b6cb0'; ctx.stroke();
      }
    };
    const field = (label, el, title) => h('label', { class: 'field', title }, h('span', {}, label), el);
    const sel = (key, options) => { const s = h('select', {}, ...options.map(([v, l]) => h('option', { value: v }, l))); s.value = String(opts[key]); s.addEventListener('change', () => { opts[key] = s.value === 'true' ? true : s.value === 'false' ? false : s.value; update(); }); return s; };
    const num = (key, ph) => { const i = h('input', { type: 'text', placeholder: ph, class: 'num' }); i.addEventListener('input', () => { const v = parseNumber(i.value); opts[key] = Number.isFinite(v) ? v : undefined; update(); }); return i; };
    dlg.append(h('h2', {}, `取り込み: ${fileName}`),
      h('div', { class: 'ap-import-grid' },
        field('光軸の向き', sel('axis', [['x', '図面の横方向(x)'], ['y', '図面の縦方向(y)']]), '図面上で光軸と平行な方向'),
        field('光軸の位置', sel('axisMode', [['center', '図形の中心線(上下対称の全断面)'], ['min', '図形の下端/左端'], ['max', '図形の上端/右端(SVG の上半分のみ)'], ['value', '座標で指定']]), '断面を回転させる軸'),
        field('軸の座標', num('axisValue', '0'), '「座標で指定」のときの光軸の位置(図面の単位)'),
        field('1 単位 =', num('mmPerUnit', '自動'), '図面の 1 単位が何 mm か。空欄ならファイルの指定(SVG の width/viewBox、DXF の $INSUNITS)'),
        field('z を反転', sel('flipZ', [['false', 'しない'], ['true', 'する(右から光が入る図面)']]), ''),
        format === 'csv' ? field('点のつなぎ方', sel('smooth', [['true', 'なめらか(角は残す)'], ['false', '折れ線']]), '') : null),
      preview, msg,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => {
          if (!result?.profiles.length) return;
          // 取り込んだ部品は既存部品の後ろ(z)に並べて置く
          const zEnd = zEndOf(st.parts);
          result.profiles.forEach((profile, k) => st.parts.push({ id: newId(), name: `${fileName.replace(/\.[^.]+$/, '')}${result.profiles.length > 1 ? `-${k + 1}` : ''}`, profile, material: { type: 'preset', name: 'N-BK7' }, coatings: {}, zOffset: Number.isFinite(zEnd) ? zEnd + 1 : 0, source: 'import', visible: true }));
          dlg.close(); changed(true, true);
        } }, '部品として追加'),
        h('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, 'キャンセル')));
    dlg.showModal();
    update();
  }

  // ---------- 照明 ----------
  // 光源: ID で管理し、一覧の削除・点灯はまとめて 1 か所で受ける(行の作り直しに影響されない)
  let lightSeq = 0;
  function ensureLightIds() {
    for (const l of st.lights) {
      if (!l.id) l.id = `L${Date.now().toString(36)}${(lightSeq++).toString(36)}`;
      if (l.on === undefined) l.on = true;
    }
  }
  function addLight(type) {
    ensureLightIds();
    const k = st.lights.filter((l) => l.type === type).length;
    const base = type === 'point' ? { type, az: 40, el: 35, dist: 2.5, size: 4, power: 80 } : { type, az: -30, el: 50, dist: 2.5, size: 60, power: 8 };
    // 追加するたびに少しずつ方向をずらす(同じ位置に重ならないように)
    st.lights.push({ ...base, az: base.az + 25 * k, id: `L${Date.now().toString(36)}${(lightSeq++).toString(36)}`, on: true });
    renderLights(); viewChanged();
  }
  function renderLights() {
    ensureLightIds();
    const box = $('ap-lights');
    box.replaceChildren();
    if (!st.lights.length) { box.append(h('p', { class: 'note' }, '追加した光源はありません(背景・照明のプリセットの光だけで描画しています)。')); return; }
    st.lights.forEach((l, i) => {
      const f = (k, label, unit, title) => {
        const inp = h('input', { type: 'text', value: String(l[k]), class: 'num', title, 'aria-label': `光源 ${i + 1} の${label}` });
        inp.addEventListener('change', () => { const v = parseNumber(inp.value); if (Number.isFinite(v)) { inp.classList.remove('invalid'); l[k] = v; viewChanged(); } else inp.classList.add('invalid'); });
        return h('label', { class: 'field', title }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
      };
      const on = h('input', { type: 'checkbox', 'data-light-toggle': l.id, 'aria-label': `光源 ${i + 1} を点灯` });
      on.checked = l.on !== false;
      box.append(h('div', { class: `ap-light${l.on === false ? ' off' : ''}`, 'data-light': l.id },
        h('div', { class: 'ap-light-head' },
          h('label', { class: 'check', title: 'チェックを外すと一時的に消灯します' }, on, h('b', {}, ` 光源 ${i + 1}: ${l.type === 'point' ? '点光源' : '面光源(蛍光灯)'}`)),
          h('button', { type: 'button', class: 'danger', 'data-light-del': l.id, title: 'この光源を削除', 'aria-label': `光源 ${i + 1} を削除` }, '削除')),
        h('div', { class: 'ap-light-body' },
          f('az', '方位', '°', '光源の方向(0° = 物体側、90° = +X 側)'), f('el', '仰角', '°', '上向きが +'),
          f('dist', '距離', '× シーン径', 'シーンの大きさに対する倍率'),
          f('size', l.type === 'point' ? '直径' : '長さ', 'mm', l.type === 'point' ? '光る球の直径' : '長さ(幅はその 1/8)'),
          f('power', '明るさ', '', '環境の白 = 1 に対する放射輝度'))));
    });
  }
  function worldLights() {
    const info = { center: st.camera?.target ?? [0, 0, 0] };
    const size = (() => { let r = 1; for (const p of st.parts) { try { r = Math.max(r, partBounds(p).rMax * 2); } catch { /* */ } } return r; })();
    return st.lights.filter((l) => l.on !== false).map((l) => {
      const az = (l.az * Math.PI) / 180, el = (l.el * Math.PI) / 180, d = l.dist * size;
      const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
      const pos = [info.center[0] + dir[0] * d, info.center[1] + dir[1] * d, info.center[2] + dir[2] * d];
      if (l.type === 'point') return { type: 'point', pos, radius: l.size / 2, radiance: l.power };
      // 中心を向く長方形(長辺は水平)
      const fwd = dir.map((x) => -x);
      let u = [fwd[2], 0, -fwd[0]]; const lu = Math.hypot(...u) || 1; u = u.map((x) => (x / lu) * (l.size / 2));
      const v0 = [fwd[1] * u[2] - fwd[2] * u[1], fwd[2] * u[0] - fwd[0] * u[2], fwd[0] * u[1] - fwd[1] * u[0]];
      const lv = Math.hypot(...v0) || 1, v = v0.map((x) => (x / lv) * (l.size / 16));
      return { type: 'rect', center: pos, u, v, radiance: l.power, twoSided: true };
    });
  }

  // ---------- 描画 ----------
  function renderState() {
    const [w, h0] = RES[st.res] ?? RES.m;
    return { parts: st.parts.filter((p) => p.visible !== false), camera: st.camera, env: { type: st.env }, lights: worldLights(), width: w, height: h0, exactSpectral: st.quality === 'exact' };
  }
  function syncCameraInputs() {
    for (const k of ['azimuth', 'elevation', 'distance', 'fov']) $(`ap-cam-${k}`).value = fmt(st.camera[k], k === 'distance' ? 2 : 1);
  }
  function startRender(keepLine = false) {
    if (!validateScene(st.parts).ok) { $('ap-status').textContent = '部品にエラーがあるため描画できません'; return; }
    view.setMaxPasses(st.quality === 'standard' ? 4 : 32);
    view.update(renderState(), { keepLine });
  }
  /** 右下の座標軸(一般的な 3D ソフトと同じ X 赤・Y 緑・Z 青。Z = 光軸 = 光の進む向き) */
  function drawAxes() {
    const c = $('ap-axes');
    if (!c || !st.camera) return;
    const css = 108, dpr = devicePixelRatio || 1;
    c.width = css * dpr; c.height = css * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    const cb = cameraBasis(st.camera), o = css / 2, L = 34;
    ctx.fillStyle = 'rgba(18,18,22,0.62)'; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(o, o, o - 2, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    const axes = [['X', [1, 0, 0], '#ff5c5c'], ['Y', [0, 1, 0], '#5fe36b'], ['Z', [0, 0, 1], '#5c9dff']]
      .map(([n, v, col]) => ({ n, col, x: v[0] * cb.right[0] + v[1] * cb.right[1] + v[2] * cb.right[2], y: -(v[0] * cb.up[0] + v[1] * cb.up[1] + v[2] * cb.up[2]), depth: v[0] * cb.fwd[0] + v[1] * cb.fwd[1] + v[2] * cb.fwd[2] }))
      .sort((a, b) => b.depth - a.depth); // 奥へ向かう軸から先に描く
    for (const a of axes) {
      const ex = o + a.x * L, ey = o + a.y * L, len = Math.hypot(a.x, a.y);
      ctx.globalAlpha = a.depth > 0.3 ? 0.55 : 1; // 画面の奥へ向かう軸はうすく
      ctx.strokeStyle = a.col; ctx.fillStyle = a.col; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(o, o); ctx.lineTo(ex, ey); ctx.stroke();
      if (len > 0.15) { // 矢印の先
        const ux = a.x / len, uy = a.y / len;
        ctx.beginPath(); ctx.moveTo(ex + ux * 6, ey + uy * 6); ctx.lineTo(ex - uy * 4, ey + ux * 4); ctx.lineTo(ex + uy * 4, ey - ux * 4); ctx.closePath(); ctx.fill();
      } else { ctx.beginPath(); ctx.arc(o, o, 4, 0, 2 * Math.PI); ctx.fill(); } // ほぼ視線方向: 点で表示
      const lx = len > 0.15 ? ex + (a.x / len) * 14 : o + 10, ly = len > 0.15 ? ey + (a.y / len) * 14 : o - 10;
      ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(a.n, lx, ly); ctx.fillText(a.n, lx, ly);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '9px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Z = 光軸', o, css - 9);
  }

  /** 視点・照明だけの変更(部品リストは作り直さない) */
  function viewChanged() { syncCameraInputs(); drawAxes(); setState(st); startRender(); }
  function changed(geometry, refit = false) {
    if (refit) st.camera = defaultCamera(st.parts);
    renderParts(); syncCameraInputs(); setState(st);
    if (geometry) renderFaces();
    startRender();
  }

  // ---------- 数値: 反射率 ----------
  function faceList() {
    const out = [];
    const scene = buildTraceScene(st.parts);
    st.parts.forEach((p) => {
      if (p.visible === false || p.material.type === 'opaque') return;
      if (isMesh(p)) { out.push({ part: p, seg: 0, label: `${p.name} 表面(STL、空気との界面として表示)`, outside: { type: 'air' } }); return; }
      const edges = tessellate(placedProfile(p));
      p.profile.segments.forEach((_, seg) => {
        const label = faceLabel(p, seg);
        if (!label) return;
        const es = edges.filter((e) => e.seg === seg && !e.onAxis), e = es[Math.floor(es.length / 2)];
        const n = [(e.na[0] + e.nb[0]) / 2, (e.na[1] + e.nb[1]) / 2], m = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
        const outPt = [m[0] + n[0] * 1e-4, m[1] + n[1] * 1e-4];
        const other = scene.mediumAt(outPt[0], 0, outPt[1]);
        if (other && other.part.id < p.id && other.part.material.type !== 'opaque') return; // 共有面は一度だけ
        out.push({ part: p, seg, label: `${p.name} ${label}${other ? ` / ${other.part.name}` : '(空気)'}`, outside: other?.part.material ?? { type: 'air' } });
      });
    });
    return out;
  }
  function renderFaces() {
    const sel = $('ap-face');
    const list = faceList();
    sel.replaceChildren(...list.map((f, i) => h('option', { value: i }, f.label)));
    sel._list = list;
    plotReflectance();
  }
  function plotReflectance() {
    const sel = $('ap-face'), f = sel._list?.[+sel.value];
    const box = $('ap-refl');
    box.replaceChildren();
    if (!f) return;
    const n = (mat) => (l) => (mat.type === 'air' ? 1 : refractiveIndex(mat, l));
    const c = f.part.coatings?.[f.seg];
    const layers = typeof c === 'string' ? COATINGS[c]?.layers ?? [] : c?.layers ?? [];
    const n0 = n(f.outside)(0.55), ns = n(f.part.material)(0.55);
    const a = reflectanceVsAngle(n0, layers, ns, 0.55);
    const angle = parseNumber($('ap-angle').value);
    const wl = reflectanceVsWavelength(n(f.outside), layers, n(f.part.material), Number.isFinite(angle) ? angle : 0);
    const R0 = a.R[0];
    box.append(h('p', { class: 'note' }, `550 nm・垂直入射の反射率 ${fmt(R0 * 100, 4)} %(n ${fmt(n0, 4)} → ${fmt(ns, 4)}${layers.length ? `、コート ${layers.length} 層` : '、無コート'})`));
    const c1 = h('div', { class: 'chart' }), c2 = h('div', { class: 'chart' });
    box.append(c1, c2);
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#222';
    const axis = (label) => ({ label, stroke: fg, grid: { stroke: 'rgba(128,128,128,0.25)' } });
    requestAnimationFrame(() => {
      const W = Math.max(260, box.clientWidth || 300);
      new uPlot({ width: W, height: 170, scales: { x: { time: false } }, axes: [axis('入射角 [°]'), axis('反射率 [%]')], series: [{}, { label: 's', stroke: '#2f6bff' }, { label: 'p', stroke: '#e5372c' }, { label: '平均', stroke: fg, width: 2 }] }, [a.angles, a.Rs.map((v) => v * 100), a.Rp.map((v) => v * 100), a.R.map((v) => v * 100)], c1);
      new uPlot({ width: W, height: 150, scales: { x: { time: false } }, axes: [axis('波長 [nm]'), axis('反射率 [%]')], series: [{}, { label: `入射角 ${fmt(angle, 0)}°`, stroke: '#1fa64a', width: 2 }] }, [wl.nm, wl.R.map((v) => v * 100)], c2);
    });
  }

  // ---------- 数値: 明るさ断面と判定 ----------
  function onLine(line, lum) {
    if (!lum) return;
    const p = lineProfile(lum.Y, lum.w, lum.h, line[0], line[1]);
    const thr = (st.threshold ?? 2) / 100;
    const c = boundaryContrast(p.values, thr);
    const badge = { visible: ['vis', '見える'], invisible: ['invis', '見えにくい'], uncertain: ['unc', '判定できません(ノイズと同程度)'] }[c.verdict];
    $('ap-verdict').replaceChildren(...[
      h('div', { class: `ap-badge ${badge[0]}` }, badge[1]),
      h('div', {}, `境界のコントラスト C = ${c.contrast >= 0 ? '+' : ''}${fmt(c.contrast * 100, 2)} %(閾値 ±${fmt(thr * 100, 2)} %、画像ノイズ ±${fmt(c.noise * 100, 2)} %)`),
      c.verdict === 'uncertain' ? h('div', { class: 'warn' }, '描画が終わるまで待つか、解像度を下げてパス数を稼いでください。') : null,
      h('div', { class: 'note' }, `背景の輝度 ${fmt(c.background, 4)}、境界 ${fmt(c.peak, 4)}(線上 ${fmt(p.dist[c.index], 0)} px 付近)`)].filter(Boolean));
    const box = $('ap-profile');
    box.replaceChildren();
    plot = new uPlot({ width: Math.max(260, box.clientWidth || 300), height: 150, scales: { x: { time: false } }, axes: [{ label: '線上の位置 [px]' }, { label: '輝度 Y' }], series: [{}, { label: '輝度', stroke: '#2b6cb0', width: 1.5 }, { label: '背景', stroke: '#999', dash: [4, 3] }] }, [p.dist, p.values, p.values.map(() => c.background)], box);
  }

  // ---------- 数値: 寄与 ----------
  function names() {
    const byId = Object.fromEntries(st.parts.map((p) => [p.id, p]));
    return (key) => key.split('|').map((k) => { const [id, seg] = k.split(':'); const p = byId[id]; return p ? `${p.name} ${faceLabel(p, +seg) ?? `面${+seg + 1}`}` : k; }).join(' / ');
  }
  function onFrame(buf) {
    const tot = buf.y.reduce((a, b) => a + b, 0);
    const nm = names();
    const rows = contributionTable(buf.contrib, tot).slice(0, 12);
    const t = $('ap-contrib');
    t.replaceChildren(h('caption', {}, '画像の明るさのうち、各面での反射を経た光の割合(最初の反射面で分類)'),
      ...rows.map((r) => h('tr', {}, h('td', {}, nm(r.key)), h('td', { class: 'num' }, `${fmt(r.fraction * 100, 3)} %`))));
    if (!rows.length) t.append(h('tr', {}, h('td', {}, '反射光は写っていません')));
  }

  // ---------- 内部界面の見え方マップ ----------
  let mapTag = 2e9;
  async function internalMap() {
    const btn = $('ap-map-btn'), out = $('ap-map');
    const tag = ++mapTag;
    btn.disabled = true;
    const base = { ...renderState() };
    const [w, hh] = [Math.round(base.width / 2), Math.round(base.height / 2)];
    const passes = 4;
    out.replaceChildren(h('p', { class: 'note' }, '計算中…(通常の画像と、内部界面の反射を消した画像を描いて比べます)'));
    try {
      const a = await renderStill(pool, { ...base, width: w, height: hh }, passes, tag);
      const b = a && (await renderStill(pool, { ...base, width: w, height: hh, suppressInternal: true }, passes, tag));
      if (!a || !b || tag !== mapTag) return;
      const thr = (st.threshold ?? 2) / 100;
      const v = internalVisibility(a, b, thr);
      const c = h('canvas', { class: 'ap-map-canvas', title: '赤 = 閾値以上、黄 = 閾値の 1/4 以上' });
      drawBuffer(c, a, { auto: true });
      const ctx = c.getContext('2d'), img = ctx.getImageData(0, 0, w, hh);
      for (let i = 0; i < v.C.length; i++) {
        const x = Math.abs(v.C[i]) / thr;
        if (x < 0.25) continue;
        const k = i * 4, t = Math.min(1, x);
        const col = x >= 1 ? [255, 40, 40] : [255, 200, 0];
        for (let q = 0; q < 3; q++) img.data[k + q] = Math.round(img.data[k + q] * (1 - 0.7 * t) + col[q] * 0.7 * t);
      }
      ctx.putImageData(img, 0, 0);
      const verdict = Math.abs(v.max) >= thr;
      out.replaceChildren(
        h('div', { class: `ap-badge ${verdict ? 'vis' : 'invis'}` }, verdict ? '内部界面が見える部分があります' : '内部界面は見えにくい'),
        h('div', {}, `内部界面による明るさの変化: 最大 ${v.max >= 0 ? '+' : ''}${fmt(v.max * 100, 2)} %、閾値 ±${fmt(thr * 100, 2)} % を超える画素 ${fmt(v.fraction * 100, 2)} %`),
        c,
        h('p', { class: 'note' }, '内部界面 = 部品どうしが接する面(接着面・膜と液体など)。その反射だけを 0 にした画像との差を、画素ごとのウェーバーコントラストで示します。'));
    } finally { btn.disabled = false; }
  }

  // ---------- 角度一覧 ----------
  async function contactSheet() {
    const dlg = $('ap-dialog');
    dlg.replaceChildren();
    const f = { az0: 0, az1: 75, azs: 15, el0: 0, el1: 0, els: 15 };
    const grid = h('div', { class: 'ap-sheet' });
    const inputs = Object.entries({ az0: '方位 開始', az1: '終了', azs: '刻み', el0: '仰角 開始', el1: '終了', els: '刻み' }).map(([k, label]) => {
      const i = h('input', { type: 'text', value: String(f[k]), class: 'num' });
      i.addEventListener('input', () => { const v = parseNumber(i.value); if (Number.isFinite(v)) f[k] = v; });
      return h('label', { class: 'field' }, h('span', {}, label), i, h('small', {}, '°'));
    });
    let tag = 1e9;
    const run = async () => {
      grid.replaceChildren();
      const shots = [];
      for (let el = f.el0; el <= f.el1 + 1e-9; el += Math.max(1, f.els)) for (let az = f.az0; az <= f.az1 + 1e-9; az += Math.max(1, f.azs)) shots.push({ az, el });
      if (shots.length > 48) { grid.textContent = '枚数が多すぎます(48 枚まで)'; return; }
      const items = shots.map((s) => { const c = h('canvas', { class: 'ap-thumb' }); const fig = h('figure', {}, c, h('figcaption', {}, `方位 ${s.az}°・仰角 ${s.el}°`)); grid.append(fig); return { ...s, c }; });
      const myTag = ++tag;
      for (const it of items) {
        const s = { ...renderState(), camera: { ...st.camera, azimuth: it.az, elevation: it.el }, width: 200, height: 150 };
        await renderStill(pool, s, 4, myTag, (b) => drawBuffer(it.c, b, { auto: true }));
        if (myTag !== tag || !dlg.open) return;
      }
    };
    dlg.append(h('h2', {}, '角度一覧'), h('div', { class: 'row' }, ...inputs), h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: run }, '生成'), h('button', { type: 'button', class: 'secondary', onclick: () => { tag++; dlg.close(); } }, '閉じる')), grid);
    dlg.showModal();
    run();
  }

  // ---------- 起動 ----------
  function init() {
    ensureParts();
    if (!st.camera) st.camera = defaultCamera(st.parts);
    for (const [k, v] of Object.entries(ENV_PRESETS)) $('ap-env').append(h('option', { value: k }, v.label));
    $('ap-env').value = st.env;
    $('ap-env').addEventListener('change', () => { st.env = $('ap-env').value; viewChanged(); });
    $('ap-res').value = st.res;
    $('ap-res').addEventListener('change', () => { st.res = $('ap-res').value; viewChanged(); });
    $('ap-regen').addEventListener('click', () => { if (st.parts.some((p) => p.source !== 'auto') && !confirm('取り込み・描画した部品も消えます。レンズデータから作り直しますか?')) return; st.autoParts = { iris: $('ap-iris').checked, barrel: $('ap-barrel').checked }; regenerate(); changed(true); });
    $('ap-iris').checked = st.autoParts.iris; $('ap-barrel').checked = st.autoParts.barrel;
    $('ap-draw').addEventListener('click', () => {
      const p = { id: newId(), name: '新しい部品', profile: null, material: { type: 'preset', name: 'N-BK7' }, coatings: {}, zOffset: 0, source: 'draw', visible: true };
      openProfileEditor($('pe-dialog'), p, (np) => {
        // 既存の部品の後ろ(z)に置く
        const zEnd = zEndOf(st.parts);
        const zMin = bounds(tessellate(np.profile)).zMin;
        np.zOffset = Number.isFinite(zEnd) ? zEnd + 1 - zMin : 0;
        st.parts.push(np); changed(true, true);
      });
    });
    $('ap-add-point').addEventListener('click', () => addLight('point'));
    $('ap-add-rect').addEventListener('click', () => addLight('rect'));
    $('ap-clear-lights').addEventListener('click', () => { if (!st.lights.length) return; st.lights.splice(0); renderLights(); viewChanged(); });
    $('ap-lights').addEventListener('click', (e) => {
      const del = e.target.closest('[data-light-del]');
      if (!del) return;
      const i = st.lights.findIndex((l) => l.id === del.dataset.lightDel);
      if (i >= 0) { st.lights.splice(i, 1); renderLights(); viewChanged(); }
    });
    $('ap-lights').addEventListener('change', (e) => {
      const t = e.target.closest('[data-light-toggle]');
      if (!t) return;
      const l = st.lights.find((x) => x.id === t.dataset.lightToggle);
      if (l) { l.on = t.checked; t.closest('.ap-light').classList.toggle('off', !l.on); viewChanged(); }
    });
    for (const k of ['azimuth', 'elevation', 'distance', 'fov']) $(`ap-cam-${k}`).addEventListener('change', () => { const v = parseNumber($(`ap-cam-${k}`).value); if (Number.isFinite(v)) { st.camera[k] = v; viewChanged(); } });
    $('ap-cam-reset').addEventListener('click', () => { st.camera = defaultCamera(st.parts); viewChanged(); });
    $('ap-quality').value = st.quality ?? 'standard';
    $('ap-quality').addEventListener('change', () => { st.quality = $('ap-quality').value; viewChanged(); });
    $('ap-line').addEventListener('change', () => view.setLineMode($('ap-line').checked));
    $('ap-threshold').value = String(st.threshold);
    $('ap-threshold').addEventListener('change', () => { const v = parseNumber($('ap-threshold').value); if (v > 0) { st.threshold = v; setState(st); const l = view.line(), b = view.buffer(); if (l && b) onLine(l, { Y: b.y.map((y, k) => (b.n[k] ? y / b.n[k] : 0)), w: b.w, h: b.h }); } });
    $('ap-face').addEventListener('change', plotReflectance);
    $('ap-angle').addEventListener('change', plotReflectance);
    $('ap-sheet').addEventListener('click', contactSheet);
    $('ap-map-btn').addEventListener('click', internalMap);
    $('ap-exposure').addEventListener('input', () => { $('ap-auto').checked = false; view.setExposure(2 ** +$('ap-exposure').value, false); });
    $('ap-auto').addEventListener('change', () => view.setExposure(2 ** +$('ap-exposure').value, $('ap-auto').checked));
    view = createRenderView($('ap-canvas'), pool, {
      onProgress: (p, m, low) => { $('ap-status').textContent = low ? '回転中(粗い表示)…' : p === 0 ? '描画中…' : p < m ? `精細化中… ${p}/${m} パス(色は 1 パス目から正しく表示されます)` : `完了(${m} パス)`; },
      onCamera: () => { syncCameraInputs(); drawAxes(); setState(st); },
      onLine, onFrame,
      onExposure: (ex) => { $('ap-exposure-out').textContent = `×${ex < 10 ? ex.toFixed(2) : ex.toPrecision(3)}`; },
      onError: (m) => { $('ap-status').textContent = `エラー: ${m}`; },
    });
    renderParts(); renderLights(); renderFaces(); syncCameraInputs(); drawAxes();
    new ResizeObserver(() => drawSection()).observe($('ap-section'));
  }
  let started = false;
  const sysSig = () => JSON.stringify(getSystem(), (k, v) => (v === Infinity ? 'inf' : v));
  return {
    show() {
      if (!started) { started = true; init(); }
      // 部品がすべて自動生成なら、レンズデータの変更に追従する
      const sig = sysSig();
      if (st.parts.every((p) => p.source === 'auto') && st.sysSig !== sig) { regenerate(); renderParts(); renderFaces(); syncCameraInputs(); }
      st.sysSig = sig; setState(st);
      startRender(true);
    },
    markSynced() { st.sysSig = sysSig(); setState(st); },
    reload() { st.sysSig = sysSig(); if (started) { if (!st.parts) regenerate(); if (!st.camera) st.camera = defaultCamera(st.parts); $('ap-env').value = st.env; $('ap-res').value = st.res; renderParts(); renderLights(); renderFaces(); syncCameraInputs(); drawAxes(); startRender(); } },
    state: () => st,
  };
}

export { segmentEvaluator };
