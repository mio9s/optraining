// STL 取り込みダイアログ: 単位・光軸の向き・置き方を選び、立体(三角形メッシュ)をそのまま部品にする
import { importSTL, encodeMesh, meshBounds, perpAxes, cadToScene } from '../../appearance/mesh.js';
import { parseNumber } from '../editor.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null && v !== false) e.setAttribute(k, v); }
  for (const c of kids) if (c != null) e.append(c);
  return e;
};
const fmt = (v, d = 3) => (Number.isFinite(v) ? String(+v.toFixed(d)) : '—');
export const UNITS = [['1', 'mm'], ['10', 'cm'], ['1000', 'm'], ['25.4', 'inch'], ['0.001', 'µm']];

/** 三角形の y = yc 平面での切り口(z, x の線分) */
export function sliceXZ(V, F, yc, offset = [0, 0, 0]) {
  const segs = [];
  for (let t = 0; t < F.length; t += 3) {
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const a = F[t + k] * 3, b = F[t + ((k + 1) % 3)] * 3;
      const ya = V[a + 1] + offset[1] - yc, yb = V[b + 1] + offset[1] - yc;
      if ((ya < 0) === (yb < 0)) continue;
      const s = ya / (ya - yb);
      pts.push([V[a + 2] + s * (V[b + 2] - V[a + 2]) + offset[2], V[a] + s * (V[b] - V[a]) + offset[0]]);
    }
    if (pts.length === 2) segs.push(pts);
  }
  return segs;
}

/**
 * ダイアログを開く。onAdd(bodies, opts) で部品を追加する。
 * bodies: [{name, mesh:{key, v, f}, triangles, open, offset}]、opts: {creaseDeg, contactTol, frame:{axis, flip, scale, offset}}
 * frame: 前に取り込んだ STL の座標系(あれば「同じ座標系」を既定にして相対位置を保つ)
 */
export function openStlImport(dlg, fileName, buf, { zEnd, newId, onAdd, frame = null }) {
  dlg.replaceChildren();
  const opts = { unit: '1', customScale: undefined, axis: 'z', flip: false, split: true, same: !!frame, axisAt: 'center', pu: undefined, pv: undefined, zAt: Number.isFinite(zEnd) ? 'after' : 'zero', creaseDeg: 30, contactUm: 2 };
  if (frame) { opts.axis = frame.axis; opts.flip = frame.flip; opts.customScale = frame.scale; }
  const preview = h('canvas', { class: 'ap-import-preview', 'aria-label': '取り込む立体の横からの投影(z が右向き = 光の進む向き)' });
  const msg = h('div', { class: 'note' });
  const warn = h('div', { class: 'warn' });
  const list = h('ul', { class: 'ap-stl-list' });
  let result = null, err = null;
  const scale = () => opts.customScale ?? +opts.unit;
  const update = () => {
    try { result = importSTL(buf, { scale: scale(), axis: opts.axis, flip: opts.flip, split: opts.split }); err = null; } catch (e) { result = null; err = e.message; }
    list.replaceChildren(); warn.textContent = '';
    const ctx = preview.getContext('2d'), W = (preview.width = 420), H = (preview.height = 220);
    ctx.clearRect(0, 0, W, H);
    if (!result || !result.bodies.length) { msg.textContent = err ? `読み込めません: ${err}` : '三角形がありません'; return; }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let nt = 0;
    for (const b of result.bodies) { nt += b.triangles; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.bounds.lo[k]); hi[k] = Math.max(hi[k], b.bounds.hi[k]); } }
    const size = hi.map((v, k) => v - lo[k]);
    msg.textContent = `${result.bodies.length} 個の立体、三角形 ${nt.toLocaleString()} 枚。大きさ X ${fmt(size[0])} × Y ${fmt(size[1])} × Z(光軸) ${fmt(size[2])} mm`;
    const w = [...result.warnings];
    if (result.bodies.some((b) => b.flipped)) w.push('面の向き(表裏)が内向きの立体があったため、外向きに直しました');
    if (nt > 300000) w.push(`三角形が多い(${nt.toLocaleString()} 枚)ため、描画とファイル保存に時間がかかります`);
    if (Math.max(...size) > 2000 || Math.max(...size) < 0.05) w.push('大きさが極端です。単位の選び方を確認してください');
    warn.textContent = w.join(' / ');
    for (const b of result.bodies) list.append(h('li', {}, `${b.name}: 三角形 ${b.triangles.toLocaleString()} 枚、体積 ${fmt(b.volume, 3)} mm³${b.open ? `、閉じていない辺 ${b.open} 本` : '、閉じた立体'}`));
    // 横から見た投影(z 右向き、x 上向き): 三角形の辺をうすく、y = 中心の切り口を濃く
    const s = Math.min((W - 20) / Math.max(size[2], 1e-6), (H - 20) / Math.max(size[0], 1e-6));
    const X = (z) => 10 + (z - lo[2]) * s + (W - 20 - size[2] * s) / 2, Y = (x) => H / 2 - (x - (lo[0] + hi[0]) / 2) * s;
    // 光軸(選んだ「光軸が通る位置」)の x
    let axX = 0;
    if (opts.same && frame) axX = -frame.offset[0];
    else if (opts.axisAt === 'center') axX = (lo[0] + hi[0]) / 2;
    else if (opts.axisAt === 'point') { const [a, b] = perpAxes(opts.axis), P = [0, 0, 0]; P['XYZ'.indexOf(a)] = opts.pu ?? 0; P['XYZ'.indexOf(b)] = opts.pv ?? 0; axX = cadToScene(P, { axis: opts.axis, flip: opts.flip, scale: scale() })[0]; }
    ctx.strokeStyle = 'rgba(255,140,0,0.95)'; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(0, Y(axX)); ctx.lineTo(W, Y(axX)); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(43,108,176,0.12)'; ctx.lineWidth = 0.5;
    for (const b of result.bodies) {
      const step = Math.max(1, Math.floor(b.triangles / 20000)) * 3;
      ctx.beginPath();
      for (let t = 0; t < b.F.length; t += step) {
        const a = b.F[t] * 3, c = b.F[t + 1] * 3, d = b.F[t + 2] * 3;
        ctx.moveTo(X(b.V[a + 2]), Y(b.V[a])); ctx.lineTo(X(b.V[c + 2]), Y(b.V[c])); ctx.lineTo(X(b.V[d + 2]), Y(b.V[d])); ctx.closePath();
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#2b6cb0'; ctx.lineWidth = 1.5;
    for (const b of result.bodies) {
      ctx.beginPath();
      for (const [p, q] of sliceXZ(b.V, b.F, (lo[1] + hi[1]) / 2)) { ctx.moveTo(X(p[0]), Y(p[1])); ctx.lineTo(X(q[0]), Y(q[1])); }
      ctx.stroke();
    }
    ctx.fillStyle = '#c06000'; ctx.font = '11px system-ui, sans-serif'; ctx.fillText('光軸 z →', W - 60, Y(axX) - 4); ctx.fillStyle = '#666'; ctx.fillText('↑ x', 4, 14);
  };
  const field = (label, el, title) => h('label', { class: 'field', title }, h('span', {}, label), el);
  const sel = (key, options, title) => {
    const s = h('select', { 'aria-label': title }, ...options.map(([v, l]) => h('option', { value: v }, l)));
    s.value = String(opts[key]);
    s.addEventListener('change', () => { opts[key] = s.value === 'true' ? true : s.value === 'false' ? false : s.value; update(); });
    return s;
  };
  const num = (key, ph, after) => {
    const i = h('input', { type: 'text', placeholder: ph, class: 'num', value: opts[key] == null ? '' : String(opts[key]) });
    const signed = key === 'pu' || key === 'pv';
    i.addEventListener('input', () => { const v = parseNumber(i.value); const ok = signed ? Number.isFinite(v) : v > 0; i.classList.toggle('invalid', i.value !== '' && !ok); opts[key] = ok ? v : undefined; after?.(); });
    return i;
  };
  const pAx = h('span'), lu = h('span'), lv = h('span');
  const pu = num('pu', '0', update), pv = num('pv', '0', update);
  const pointRow = h('div', { class: 'ap-row' }, lu, pu, lv, pv, h('small', {}, '(図面の座標、単位は図面のまま)'));
  const geo = [];
  const refresh = () => {
    const [a, b] = perpAxes(opts.axis);
    pAx.textContent = `図面の ${opts.axis.toUpperCase()} 軸が光軸(z)。シーンの x = 図面の ${a}、y = 図面の ${b}`;
    lu.textContent = `${a} =`; lv.textContent = `${b} =`;
    pointRow.hidden = opts.axisAt !== 'point' || opts.same;
    for (const el of geo) el.disabled = opts.same;
  };
  const geoSel = (...a) => { const e = sel(...a); geo.push(e); e.addEventListener('change', refresh); return e; };
  const scaleIn = num('customScale', '単位どおり', update); geo.push(scaleIn);
  if (frame) scaleIn.value = String(frame.scale);
  const sameSel = sel('same', [['true', '前に取り込んだ STL と同じ(相対位置を保つ)'], ['false', 'このファイルで決める']], '座標系');
  sameSel.addEventListener('change', () => { if (opts.same && frame) { opts.axis = frame.axis; opts.flip = frame.flip; opts.customScale = frame.scale; } refresh(); update(); });
  dlg.append(h('h2', {}, `STL の取り込み: ${fileName}`),
    h('p', { class: 'note' }, '三角形メッシュを回転させずにそのまま立体として使います。光は +z 方向に進み、光軸は x = y = 0 の直線です。'),
    h('div', { class: 'ap-import-grid' },
      frame ? field('座標系', sameSel, '同じ CAD の座標で書き出した複数の STL は「同じ」にすると、前のファイルと同じ単位・向き・移動量で置かれ、部品どうしの位置関係が保たれます') : null,
      field('単位', geoSel('unit', UNITS, 'STL の 1 単位'), 'STL には単位の情報がありません。CAD で書き出したときの単位を選びます'),
      field('倍率(任意)', scaleIn, '1 単位 = 何 mm か。入力すると「単位」より優先します'),
      field('光軸にする軸', geoSel('axis', [['z', 'STL の Z 軸'], ['x', 'STL の X 軸'], ['y', 'STL の Y 軸']], '光軸にする軸'), 'CAD 上でレンズの光軸がどの軸に沿っているか'),
      field('光の向きを反転', geoSel('flip', [['false', 'しない'], ['true', 'する(CAD の −方向から光が入る)']], '光の向きを反転'), '光軸の向きを逆にします(Y 軸まわりに 180° 回転)'),
      field('光軸が通る位置', geoSel('axisAt', [['center', '図形の中心(外接箱の中心)'], ['origin', 'STL の原点'], ['point', '座標で指定']], '光軸が通る位置'), 'レンズの光学中心が図形の中心と違うときは「座標で指定」で図面上の座標を入れます。取り込んだ後も「STL の位置(光軸の位置)…」で変えられます'),
      field('光軸方向の位置', geoSel('zAt', [['after', '既存の部品の後ろ(z)に並べる'], ['zero', '先頭を z = 0 に'], ['asis', 'STL の座標のまま']], '光軸方向の位置'), ''),
      field('立体の分け方', sel('split', [['true', 'つながりごとに別の部品'], ['false', 'ファイル内の solid ごと']], '立体の分け方'), '1 つの STL に複数のレンズが入っているとき、つながっていない立体を別々の部品(別の材質)にできます'),
      field('滑らかにする角度', num('creaseDeg', '30'), '隣り合う三角形の折れ角がこれ未満なら、法線を補間して曲面として扱います(多角形の角が光って見えるのを防ぐ)。これ以上の角(コバの縁など)は角として残します'),
      field('接触とみなす距離 [µm]', num('contactUm', '2'), '別の部品の面がこの距離以内なら、同じ 1 つの界面(接合面)として扱います。書き出しの丸め誤差で空気層ができるのを防ぎます')),
    h('p', { class: 'note' }, pAx), pointRow,
    preview, msg, list, warn,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: () => {
        if (!result?.bodies.length) return;
        // 置き方: 全立体をまとめて平行移動(相対位置は保つ)
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const b of result.bodies) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.bounds.lo[k]); hi[k] = Math.max(hi[k], b.bounds.hi[k]); }
        const fr = { axis: opts.axis, flip: opts.flip, scale: scale() };
        let off;
        if (opts.same && frame) off = [...frame.offset];
        else {
          off = [0, 0, 0];
          if (opts.axisAt === 'center') { off[0] = -(lo[0] + hi[0]) / 2; off[1] = -(lo[1] + hi[1]) / 2; }
          else if (opts.axisAt === 'point') {
            // 図面の点(光軸に垂直な 2 座標、光軸方向は 0)をシーンへ移した位置が x = y = 0 になるように
            const [a, b] = perpAxes(opts.axis), P = [0, 0, 0];
            P['XYZ'.indexOf(a)] = opts.pu ?? 0; P['XYZ'.indexOf(b)] = opts.pv ?? 0;
            const q = cadToScene(P, fr); off[0] = -q[0]; off[1] = -q[1];
          }
          if (opts.zAt === 'after' && Number.isFinite(zEnd)) off[2] = zEnd + 1 - lo[2];
          else if (opts.zAt === 'zero' || opts.zAt === 'after') off[2] = -lo[2];
        }
        const base = fileName.replace(/\.[^.]+$/, '');
        const bodies = result.bodies.map((b, k) => ({
          name: result.bodies.length > 1 ? `${base}-${k + 1}` : base,
          mesh: { key: newId(), ...encodeMesh(b), triangles: b.triangles, open: b.open },
          offset: off.map((v) => +v.toFixed(6)),
        }));
        onAdd(bodies, { creaseDeg: opts.creaseDeg ?? 30, contactTol: (opts.contactUm ?? 2) / 1000, frame: { ...fr, offset: off.map((v) => +v.toFixed(6)) } });
        dlg.close();
      } }, '部品として追加'),
      h('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, 'キャンセル')));
  dlg.showModal();
  refresh();
  update();
}

export { meshBounds };
