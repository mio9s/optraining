// 解析パネル: 色収差 / ゼルニケ / 散乱公式
import uPlot from 'uplot';
import { paraxialTrace, chromatic } from '../core/paraxial.js';
import { wavefront, fitZernike, zernikeName, bestFocus } from '../core/wavefront.js';
import { rayleigh, rayleighPhase, mie, miePhase, henyeyGreenstein, forwardBackward, surfaceTIS, surfaceTIST, ramanShift, ramanAntiStokesRatio } from '../core/scatter.js';
import { LINES } from '../core/glass.js';
import { imageNA } from '../core/imaging.js';
import { powerSummary, bestImagePlane } from '../core/focus.js';
import { WL_COLOR } from './layout-view.js';
import { parseNumber } from './editor.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
};
const f = (v, d = 4) => (Number.isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d) : '—');
const g = (v, d = 4) => (Number.isFinite(v) ? (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e5 ? v.toPrecision(d) : v.toExponential(d - 1)) : '—');
const cssVar = (n, fb) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;

function chart(container, series, data, { xLabel = '', yLabel = '', logY = false, bars = false, height = 200, xRange, minSpan = 0 } = {}) {
  container.replaceChildren();
  const fg = cssVar('--fg', '#222'), grid = cssVar('--line', '#ddd');
  const axis = (label) => ({ label, stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } });
  const opts = {
    width: Math.max(260, container.clientWidth || 300), height,
    scales: {
      x: { time: false, ...(xRange ? { range: xRange } : {}) },
      y: logY ? { distr: 3 } : minSpan ? { range: (u, lo, hi) => { const c = (lo + hi) / 2, s = Math.max(hi - lo, minSpan) * 0.55; return [c - s, c + s]; } } : {},
    },
    axes: [axis(xLabel), axis(yLabel)],
    series: [{}, ...series.map((s) => ({ ...s, width: 1.5, ...(bars ? { paths: uPlot.paths.bars({ size: [0.7] }), fill: s.stroke } : {}) }))],
    legend: { show: series.length > 1 },
    cursor: { drag: { x: false, y: false } },
  };
  return new uPlot(opts, data, container);
}

function numInput(label, value, unit, title, onInput, cls = '') {
  const inp = h('input', { type: 'text', inputmode: 'decimal', value: String(value), title, class: cls, spellcheck: 'false' });
  inp.addEventListener('input', () => onInput(parseNumber(inp.value), inp));
  return h('label', { class: 'field', title }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
}

// ---------- 焦点・屈折力 ----------
const sgn = (v, d) => { if (!Number.isFinite(v)) return '—'; const r = Math.abs(v) < 0.5 * 10 ** -d ? 0 : v; return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(d)}`; };
export function renderFocus(el, sys, { onBest, onInfinity } = {}) {
  el.replaceChildren();
  const p = powerSummary(sys, LINES.d);
  const b = bestImagePlane(sys);
  const k = p.lastSurface;
  const dist = (v) => (Number.isFinite(v) ? `${f(v, 2)} mm` : '∞');
  el.append(
    h('div', { class: 'metrics' },
      h('div', { class: 'metric big', title: '系の屈折力 P = 1000 / f′(d 線 587.6 nm、像側は空気)' }, h('span', {}, '屈折力(ジオプター)'), h('b', {}, `${sgn(p.power, 3)} D`), h('small', {}, `焦点距離 f′ = ${dist(p.efl)}`)),
      h('div', { class: 'metric', title: '後方頂点屈折力 = 1000 / バックフォーカス。眼鏡のレンズメーターで測る値' }, h('span', {}, '後方頂点屈折力'), h('b', {}, `${sgn(p.bvp, 3)} D`), h('small', {}, `バックフォーカス ${dist(p.bfl)}`)),
      h('div', { class: 'metric', title: '前方頂点屈折力 = 1000 / フロントフォーカス' }, h('span', {}, '前方頂点屈折力'), h('b', {}, `${sgn(p.fvp, 3)} D`), h('small', {}, `フロントフォーカス ${dist(p.ffl)}`)),
    ),
    h('table', { class: 'kv' }, h('tbody', {},
      h('tr', {}, h('td', {}, '後側焦点(平行光が集まる位置)'), h('td', {}, `最終面から ${dist(p.bfl)}(z = ${f(p.rearFocusZ, 2)})`)),
      h('tr', {}, h('td', {}, '前側焦点'), h('td', {}, `第 1 面から手前へ ${dist(p.ffl)}(z = ${f(p.frontFocusZ, 2)})`)),
      h('tr', {}, h('td', {}, p.objectDistance >= 1e5 ? 'いまの物体距離(無限遠、1 km 以上)での像の位置(d 線)' : `いまの物体距離 ${f(p.objectDistance, 1)} mm での像の位置(d 線)`), h('td', {}, `最終面から ${dist(p.imageDistance)}(近軸、横倍率 ${f(p.magnification, 4)})`)),
    )),
  );
  // 波長ごとの像の位置
  const rows = sys.wavelengths.map((l) => { const q = powerSummary(sys, l); return h('tr', {}, h('td', {}, h('span', { class: 'sw', style: `background:${WL_COLOR(l)}` }), ` ${(l * 1000).toFixed(0)} nm`), h('td', { class: 'num' }, `${sgn(q.power, 3)} D`), h('td', { class: 'num' }, f(q.imageDistance, 2))); });
  el.append(h('h4', {}, '波長ごと'), h('table', { class: 'kv' }, h('thead', {}, h('tr', {}, h('th', {}, '波長'), h('th', {}, '屈折力'), h('th', {}, '最終面 → 像 [mm]'))), h('tbody', {}, ...rows)));
  // 最良像面
  el.append(h('h4', {}, '最良像面(結像性が最もよいスクリーン位置)'));
  if (!b.ok) { el.append(h('p', { class: 'warn' }, b.message)); return; }
  const cur = sys.surfaces[k].thickness;
  const here = Math.abs(cur - b.distance) < 0.01;
  el.append(
    h('div', { class: 'metrics' },
      h('div', { class: 'metric big' }, h('span', {}, '最良像面'), h('b', {}, `最終面から ${f(b.distance, 2)} mm`), h('small', {}, `近軸像面(520 nm)から ${sgn(b.distance - b.paraxialDistance, 2)} mm`)),
      h('div', { class: 'metric' }, h('span', {}, 'その位置のぼけ(RMS スポット半径)'), h('b', {}, `${f(b.rms * 1000, 1)} µm`), h('small', {}, `視野 0 / 70 / 100 %: ${b.perField.map((x) => f(x.rms * 1000, 1)).join(' / ')} µm`)),
    ),
    h('p', { class: here ? 'note' : 'warn' }, here ? 'スクリーンは最良像面にあります。' : `いまのスクリーンは最終面から ${f(cur, 2)} mm(ぼけ ${f(b.rmsAtCurrent * 1000, 1)} µm)。`),
    h('p', { class: 'note' }, p.objectDistance >= 1e5
      ? `物体は無限遠(1 km 以上)にあるので、最良像面はレンズ固有の焦点(最終面から ${dist(p.bfl)}、近軸 d 線)の付近になります。収差と色収差のバランスで少しずれます。`
      : `最良像面は、いまの物体距離(${f(p.objectDistance, 1)} mm)にある物体の像が最もシャープになるスクリーン位置です(物体は動かしません)。レンズ固有の焦点(物体が無限遠のとき)は最終面から ${dist(p.bfl)} です。`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: () => onBest?.() }, here ? 'この位置で結像' : 'スクリーンを最良像面へ移して結像'),
      Number.isFinite(p.efl) && p.objectDistance < 1e5 ? h('button', { type: 'button', class: 'secondary', title: '物体を 1 km 先へ移し(視野の角度は保つよう物体の大きさも比例させる)、焦点面で結像します', onclick: () => onInfinity?.() }, '物体を無限遠に置いて焦点面で結像') : null),
    h('p', { class: 'note' }, '最良像面 = 3 波長を明所視の視感度で重み付けした多色の RMS スポット半径を、視野 0 / 70 / 100 %(重み 1 / 1 / 0.5)で合計した値が最小になる位置。屈折力・焦点は d 線の近軸値。'),
  );
  // ピント位置とぼけのグラフ
  const box = h('div', { class: 'chart' });
  el.append(h('h4', {}, 'スクリーン位置とぼけ(RMS スポット半径)'), box);
  const xs = b.curve.map((c) => +c.distance.toFixed(3)), ys = b.curve.map((c) => c.rms * 1000);
  const mark = (x) => xs.map((v) => (Math.abs(v - x) <= (xs[1] - xs[0]) / 2 ? ys[xs.indexOf(v)] : null));
  requestAnimationFrame(() => {
    const fg = cssVar('--fg', '#222');
    const axis = (label) => ({ label, stroke: fg, grid: { stroke: 'rgba(128,128,128,0.25)' } });
    new uPlot({
      width: Math.max(260, box.clientWidth || 300), height: 190, scales: { x: { time: false } },
      axes: [axis('最終面 → スクリーン [mm]'), axis('µm')],
      series: [{}, { label: 'ぼけ', stroke: cssVar('--accent', '#2b6cb0'), width: 2 },
        { label: '最良', stroke: '#1fa64a', width: 0, points: { show: true, size: 10, fill: '#1fa64a' } },
        { label: 'いま', stroke: '#e5372c', width: 0, points: { show: true, size: 9, fill: '#e5372c' } }],
    }, [xs, ys, mark(b.distance), mark(cur)], box);
  });
}

// ---------- 色収差 ----------
export function renderChromatic(el, sys) {
  el.replaceChildren();
  const W = [...sys.wavelengths].sort((a, b) => a - b);
  const c = chromatic(sys);
  const pd = paraxialTrace(sys, LINES.d);
  const zScreen = sys.surfaces.reduce((a, s) => a + s.thickness, 0);
  const na = imageNA(sys, LINES.d);
  const tbl = h('table', { class: 'kv' },
    h('thead', {}, h('tr', {}, h('th', {}, '波長'), h('th', { title: '近軸焦点距離' }, 'EFL [mm]'), h('th', { title: '物体面 z=0 から測った近軸像位置' }, '近軸像位置 z [mm]'), h('th', { title: '近軸像位置 − スクリーン位置(+ は像がスクリーンより奥)' }, '像面ずれ [mm]'), h('th', { title: '最大物体高の実主光線のスクリーン上の像高' }, '主光線像高 [mm]'))),
    h('tbody', {}, ...W.map((l) => {
      const p = paraxialTrace(sys, l);
      return h('tr', {}, h('td', {}, h('span', { class: 'sw', style: `background:${WL_COLOR(l)}` }), ` ${(l * 1000).toFixed(0)} nm`), h('td', {}, f(p.efl, 3)), h('td', {}, f(c.longitudinal[l], 4)), h('td', {}, f(c.longitudinal[l] - zScreen, 4)), h('td', {}, f(c.chiefHeights[l], 5)));
    })));
  const lo = (W[0] * 1000).toFixed(0), hi = (W[W.length - 1] * 1000).toFixed(0);
  el.append(
    h('div', { class: 'metrics' },
      h('div', { class: 'metric' }, h('span', {}, `縦色収差 z(${lo}) − z(${hi})`), h('b', {}, `${f(c.axialColor, 4)} mm`), h('small', {}, `= ${f(c.axialColor * 1000, 1)} µm`)),
      h('div', { class: 'metric' }, h('span', {}, `倍率色収差 y(${lo}) − y(${hi})`), h('b', {}, `${f(c.lateralColor * 1000, 2)} µm`), h('small', {}, `物体高 ${sys.object.height} mm の主光線`)),
    ),
    tbl,
    h('p', { class: 'note' }, `d 線 (587.6 nm): EFL ${f(pd.efl, 3)} mm、BFL ${f(pd.bfl, 3)} mm、近軸横倍率 ${f(pd.magnification, 4)}、像側 NA ${f(na, 4)}(実効 F 値 ${f(1 / (2 * na), 2)})`),
  );
  // 焦点位置の波長依存(連続)
  const box = h('div', { class: 'chart' });
  el.append(h('h4', {}, '近軸像位置の波長依存(スクリーン基準)'), box);
  const xs = [], ys = [];
  for (let l = 0.43; l <= 0.66 + 1e-9; l += 0.005) { xs.push(+(l * 1000).toFixed(1)); ys.push(paraxialTrace(sys, l).imageZ - zScreen); }
  requestAnimationFrame(() => chart(box, [{ label: '像位置 − スクリーン [mm]', stroke: cssVar('--accent', '#2b6cb0') }], [xs, ys], { xLabel: '波長 [nm]', yLabel: 'mm', minSpan: 0.01 }));
}

// ---------- ゼルニケ ----------
export function renderZernike(el, sys, state) {
  el.replaceChildren();
  const fieldSel = h('select', { 'aria-label': '視野' }, ...[0, 0.7, 1].map((v) => h('option', { value: v }, `視野 ${v * 100}%(y = ${(v * sys.object.height).toFixed(2)} mm)`)));
  const wlSel = h('select', { 'aria-label': '波長' }, ...sys.wavelengths.map((l) => h('option', { value: l }, `${(l * 1000).toFixed(0)} nm`)));
  fieldSel.value = String(state.zField ?? 0); wlSel.value = String(state.zWl ?? sys.wavelengths[1]);
  const body = h('div');
  const run = () => {
    state.zField = +fieldSel.value; state.zWl = +wlSel.value;
    const lam = state.zWl;
    const wf = wavefront(sys, [0, state.zField * sys.object.height, 0], lam, 32);
    body.replaceChildren();
    if (!wf.chief) { body.append(h('p', { class: 'warn' }, 'この視野の主光線が遮蔽されているため波面を計算できません。')); return; }
    const c = fitZernike(wf.grid, wf.n, 37);
    const strehl = Math.exp(-((2 * Math.PI * wf.rmsWaves) ** 2));
    body.append(h('div', { class: 'metrics' },
      h('div', { class: 'metric' }, h('span', {}, 'RMS 波面収差'), h('b', {}, `${f(wf.rmsWaves, 4)} λ`)),
      h('div', { class: 'metric' }, h('span', {}, 'PV'), h('b', {}, `${f(wf.pvWaves, 4)} λ`)),
      h('div', { class: 'metric', title: 'マレシャル近似 exp(−(2π·RMS)²)。RMS が大きいと不正確' }, h('span', {}, 'ストレール比(近似)'), h('b', {}, f(strehl, 3))),
    ));
    const bf = bestFocus(sys, [0, state.zField * sys.object.height, 0], lam, 24);
    if (bf) body.append(h('p', { class: 'note' },
      `RMS が最小になる焦点(Z4 = 0)はスクリーンから ${bf.shift >= 0 ? '+' : ''}${f(bf.shift, 3)} mm(+ は奥)。そこでの RMS = ${f(bf.rmsAtBest, 3)} λ。`,
      'Z4(デフォーカス)はこの最良焦点とスクリーンのずれを表し、軸外では像面湾曲も含みます。'));
    const map = h('canvas', { class: 'wfmap', width: wf.n, height: wf.n, title: '射出瞳上の OPD(平均を引いた値。赤 = 正、青 = 負、上 = +y)' });
    let sum = 0, cnt = 0; for (const v of wf.grid) if (Number.isFinite(v)) { sum += v; cnt++; }
    const mean = sum / cnt;
    drawWavefront(map, wf, mean);
    let mx = 0; for (const v of wf.grid) if (Number.isFinite(v)) mx = Math.max(mx, Math.abs(v - mean));
    body.append(h('h4', {}, '波面マップ(射出瞳、平均を除去)'), h('div', { class: 'wfwrap' }, map, h('div', { class: 'cbar' }, h('span', {}, `+${f(mx, 3)} λ`), h('i'), h('span', {}, `−${f(mx, 3)} λ`))));
    const barBox = h('div', { class: 'chart' });
    body.append(h('h4', {}, '係数(Noll 番号、RMS 規格化、単位 λ)'), barBox);
    requestAnimationFrame(() => chart(barBox, [{ label: '係数 [λ]', stroke: cssVar('--accent', '#2b6cb0') }], [c.map((_, i) => i + 1), c], { xLabel: 'j', yLabel: 'λ', bars: true, xRange: [0, 38] }));
    const rows = c.map((v, i) => h('tr', { class: Math.abs(v) >= 0.05 * Math.max(...c.map(Math.abs)) ? 'hi' : '' }, h('td', {}, `Z${i + 1}`), h('td', { class: 'name' }, zernikeName(i + 1)), h('td', { class: 'num' }, f(v, 5))));
    body.append(h('details', { open: true }, h('summary', {}, '係数一覧'), h('table', { class: 'kv' }, h('thead', {}, h('tr', {}, h('th', {}, 'j'), h('th', {}, '名称'), h('th', {}, '係数 [λ]'))), h('tbody', {}, ...rows))));
    body.append(h('p', { class: 'note' }, 'OPD = 光線の光路長 − 主光線の光路長(参照球: 中心 = 主光線のスクリーン交点、射出瞳基準)。補正不足の球面収差で Z11 < 0。y 方向の視野によるコマは Z7。Z1(ピストン)は像に影響しません。'));
  };
  fieldSel.addEventListener('change', run); wlSel.addEventListener('change', run);
  el.append(h('div', { class: 'row' }, fieldSel, wlSel), body);
  run();
}

function drawWavefront(canvas, wf, mean) {
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(wf.n, wf.n);
  let mx = 1e-12; for (const v of wf.grid) if (Number.isFinite(v)) mx = Math.max(mx, Math.abs(v - mean));
  for (let iy = 0; iy < wf.n; iy++) for (let ix = 0; ix < wf.n; ix++) {
    const v = wf.grid[iy * wf.n + ix] - mean;
    const o = ((wf.n - 1 - iy) * wf.n + ix) * 4; // +y を上に
    if (!Number.isFinite(v)) { id.data[o + 3] = 0; continue; }
    const t = v / mx; // −1..1 → 青-白-赤
    const r = t > 0 ? 255 : Math.round(255 * (1 + t)), b = t < 0 ? 255 : Math.round(255 * (1 - t)), gg = Math.round(255 * (1 - Math.abs(t)));
    id.data[o] = r; id.data[o + 1] = gg; id.data[o + 2] = b; id.data[o + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

// ---------- 散乱公式パネル ----------
export function renderScatterPanels(el) {
  el.replaceChildren();
  el.append(h('p', { class: 'note' }, '各公式を単独で計算します(結像計算とは独立)。入力を変えると即座に更新されます。'));
  el.append(rayleighPanel(), miePanel(), hgPanel(), tisPanel(), ramanPanel());
}

function panel(title, formula, inputs, out) {
  return h('details', { class: 'fpanel', open: true }, h('summary', {}, title), h('div', { class: 'formula' }, formula), h('div', { class: 'inputs' }, ...inputs), out);
}

function rayleighPanel() {
  const p = { lam: 0.52, d: 0.03, np: 1.5, nm: 1.0 };
  const out = h('div'), box = h('div', { class: 'chart' });
  const upd = () => {
    if (![p.lam, p.d, p.np, p.nm].every((v) => v > 0)) { out.replaceChildren(h('p', { class: 'warn' }, '正の値を入力してください')); return; }
    const r = rayleigh(0, p.lam, p.d, p.np, p.nm);
    const x = (Math.PI * p.d * p.nm) / p.lam;
    out.replaceChildren(h('p', {}, `散乱断面積 σ = ${g(r.crossSection)} µm²、 サイズパラメータ x = ${f(x, 3)}`, x > 0.3 ? h('span', { class: 'warn' }, '(x > 0.3: レイリー近似の適用外。ミー散乱を使ってください)') : null), box);
    const th = [], v = [];
    for (let k = 0; k <= 180; k += 2) { th.push(k); v.push(rayleighPhase(Math.cos((k * Math.PI) / 180))); }
    requestAnimationFrame(() => chart(box, [{ label: '位相関数 p(θ) [1/sr]', stroke: '#2f6bff' }], [th, v], { xLabel: '散乱角 θ [°]', yLabel: '1/sr', height: 160 }));
  };
  const inp = [
    numInput('波長 λ', p.lam, 'µm', '真空中の波長', (v) => { p.lam = v; upd(); }),
    numInput('粒子径 d', p.d, 'µm', '粒子の直径', (v) => { p.d = v; upd(); }),
    numInput('粒子の屈折率', p.np, '', '', (v) => { p.np = v; upd(); }),
    numInput('媒質の屈折率', p.nm, '', '', (v) => { p.nm = v; upd(); }),
  ];
  const el = panel('レイリー散乱', 'σ = (2π⁵/3)·d⁶/λ⁴·((m²−1)/(m²+2))²、 p(θ) = 3(1+cos²θ)/(16π)(λ は媒質中、m = n粒子/n媒質)', inp, out);
  upd(); return el;
}

function miePanel() {
  const p = { lam: 0.52, d: 1.0, mr: 1.33, mi: 0, nm: 1.0 };
  const out = h('div'), box = h('div', { class: 'chart' });
  const upd = () => {
    if (![p.lam, p.d, p.mr, p.nm].every((v) => v > 0) || !(p.mi >= 0)) { out.replaceChildren(h('p', { class: 'warn' }, '正の値を入力してください(虚部は 0 以上)')); return; }
    const x = (Math.PI * p.d * p.nm) / p.lam;
    if (x > 2000) { out.replaceChildren(h('p', { class: 'warn' }, 'x が大きすぎます(≤ 2000)')); return; }
    const r = mie(x, p.mr / p.nm, p.mi / p.nm, 361);
    const ph = miePhase(r, x);
    const fb = (() => { let fw = 0, bw = 0; for (let k = 1; k < 361; k++) { const t = (Math.PI * (k - 0.5)) / 360; const v = 0.5 * (ph[k] + ph[k - 1]) * Math.sin(t); if (t < Math.PI / 2) fw += v; else bw += v; } return { fw: fw / (fw + bw), bw: bw / (fw + bw) }; })();
    out.replaceChildren(h('p', {}, `x = ${f(x, 3)}、 Qext = ${f(r.Qext, 5)}、 Qsca = ${f(r.Qsca, 5)}、 Qback = ${f(r.Qback, 5)}、 g = ⟨cosθ⟩ = ${f(r.g, 4)}`),
      h('p', {}, `前方散乱 ${f(fb.fw * 100, 1)} %、 後方散乱 ${f(fb.bw * 100, 1)} %、 散乱断面積 ${g(r.Qsca * Math.PI * (p.d / 2) ** 2)} µm²`), box);
    const th = Array.from({ length: 361 }, (_, k) => k / 2);
    requestAnimationFrame(() => chart(box, [{ label: '位相関数 p(θ) [1/sr](対数)', stroke: '#e5372c' }], [th, Array.from(ph, (v) => Math.max(v, 1e-12))], { xLabel: '散乱角 θ [°]', yLabel: '1/sr', logY: true, height: 180 }));
  };
  const inp = [
    numInput('波長 λ', p.lam, 'µm', '真空中の波長', (v) => { p.lam = v; upd(); }),
    numInput('粒子径 d', p.d, 'µm', '球形粒子の直径', (v) => { p.d = v; upd(); }),
    numInput('粒子屈折率 実部', p.mr, '', '', (v) => { p.mr = v; upd(); }),
    numInput('虚部 k', p.mi, '', '吸収(0 = 非吸収)', (v) => { p.mi = v; upd(); }),
    numInput('媒質の屈折率', p.nm, '', '', (v) => { p.nm = v; upd(); }),
  ];
  const el = panel('ミー散乱', 'Bohren–Huffman BHMIE。x = π d n媒質 / λ、 m = (n + ik) / n媒質。p(θ) = (|S₁|²+|S₂|²)/2 ÷ (π x² Qsca)', inp, out);
  upd(); return el;
}

function hgPanel() {
  const p = { g: 0.7 };
  const out = h('div'), box = h('div', { class: 'chart' });
  const upd = () => {
    if (!(p.g > -1 && p.g < 1)) { out.replaceChildren(h('p', { class: 'warn' }, 'g は −1 < g < 1')); return; }
    const fb = forwardBackward((c) => henyeyGreenstein(c, p.g));
    out.replaceChildren(h('p', {}, `前方散乱 ${f(fb.forward * 100, 1)} %、 後方散乱 ${f(fb.backward * 100, 1)} %`), box);
    const th = [], v = [];
    for (let k = 0; k <= 180; k += 1) { th.push(k); v.push(henyeyGreenstein(Math.cos((k * Math.PI) / 180), p.g)); }
    requestAnimationFrame(() => chart(box, [{ label: 'p(θ) [1/sr](対数)', stroke: '#1fa64a' }], [th, v], { xLabel: '散乱角 θ [°]', yLabel: '1/sr', logY: true, height: 160 }));
  };
  const el = panel('前方/後方散乱(Henyey–Greenstein)', 'p(θ) = (1−g²) / (4π (1+g²−2g cosθ)^{3/2})、 g = ⟨cosθ⟩(正: 前方、負: 後方)',
    [numInput('非対称因子 g', p.g, '', '−1 < g < 1', (v) => { p.g = v; upd(); })], out);
  upd(); return el;
}

function tisPanel() {
  const p = { s: 2, lam: 0.52, ang: 0, n1: 1, n2: 1.5168 };
  const out = h('div');
  const upd = () => {
    if (!(p.s >= 0 && p.lam > 0 && p.ang >= 0 && p.ang < 90)) { out.replaceChildren(h('p', { class: 'warn' }, '値を確認してください(角度 0〜90°)')); return; }
    const c = Math.cos((p.ang * Math.PI) / 180);
    out.replaceChildren(h('p', {}, `反射側 TIS = ${g(surfaceTIS(p.s, p.lam, c))}、 透過側 TIS = ${g(surfaceTIST(p.s, p.lam, p.n1, p.n2, c))}(入射光に対する散乱光の割合)`));
  };
  const el = panel('表面散乱(粗さ・汚れ)', '反射: TIS = (4π σ cosθ / λ)²、 透過: TIS = (2π σ |n₁cosθ − n₂cosθ′| / λ)²(σ: RMS 粗さ)', [
    numInput('RMS 粗さ σ', p.s, 'nm', '表面粗さ+汚れを合わせた RMS 値', (v) => { p.s = v; upd(); }),
    numInput('波長 λ', p.lam, 'µm', '', (v) => { p.lam = v; upd(); }),
    numInput('入射角', p.ang, '°', '', (v) => { p.ang = v; upd(); }),
    numInput('入射側 n₁', p.n1, '', '', (v) => { p.n1 = v; upd(); }),
    numInput('透過側 n₂', p.n2, '', '', (v) => { p.n2 = v; upd(); }),
  ], out);
  upd(); return el;
}

function ramanPanel() {
  const p = { lam: 0.52, shift: 465, T: 293 };
  const out = h('div');
  const upd = () => {
    if (!(p.lam > 0 && p.shift > 0 && p.T > 0)) { out.replaceChildren(h('p', { class: 'warn' }, '正の値を入力してください')); return; }
    const r = ramanShift(p.lam, p.shift);
    if (!(r.stokes > 0)) { out.replaceChildren(h('p', { class: 'warn' }, 'シフトが大きすぎます')); return; }
    out.replaceChildren(h('p', {}, h('span', { class: 'sw', style: 'background:#ff8c00' }), ` ストークス光 ${f(r.stokes * 1000, 2)} nm、 `, h('span', { class: 'sw', style: 'background:#9933ff' }), ` 反ストークス光 ${f(r.antiStokes * 1000, 2)} nm`),
      h('p', {}, `反ストークス/ストークス強度比 = ${f(ramanAntiStokesRatio(p.lam, p.shift, p.T), 4)}`), h('p', { class: 'note' }, '結像画像では、ストークス光をオレンジ、反ストークス光を紫で表示します(元の 3 波長とは別の色)。'));
  };
  const el = panel('ラマン散乱', '1/λ_s = 1/λ − Δν、 1/λ_as = 1/λ + Δν、 I_as/I_s = (λ_s/λ_as)⁴ · exp(−hcΔν / kT)', [
    numInput('励起波長 λ', p.lam, 'µm', '', (v) => { p.lam = v; upd(); }),
    numInput('ラマンシフト Δν', p.shift, 'cm⁻¹', 'SiO₂ の主ピークは約 465 cm⁻¹', (v) => { p.shift = v; upd(); }),
    numInput('温度', p.T, 'K', '', (v) => { p.T = v; upd(); }),
  ], out);
  upd(); return el;
}
