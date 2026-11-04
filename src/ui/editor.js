// レンズデータエディタ(Zemax 風の表)
import { listPresets } from '../core/glass.js';
import { validateSystem } from '../core/system.js';

const KIND_LABEL = { object: '物体面', surface: 'レンズ面', iris: 'アイリス', screen: 'スクリーン' };
const PRESETS = listPresets();

export function parseNumber(text, allowInf = false) {
  // 全角数字・記号(０-９ ． － ＋ ｅ)を半角へ。長音符「ー」とマイナス記号「−」もマイナスとみなす
  const t = String(text).trim()
    .replace(/[\uFF10-\uFF19\uFF0E\uFF0D\uFF0B\uFF45\uFF25]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u30FC\u2212]/g, '-');
  if (t === '') return NaN;
  if (allowInf && /^[+-]?(inf|infinity|\u221E)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
  return Number(t);
}
export const fmt = (v) => (v === Infinity ? 'inf' : v === -Infinity ? '-inf' : Number.isFinite(v) ? String(+v.toPrecision(10)) : '');

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

/**
 * エディタを container に描画。onChange(sys) は値が変わるたびに呼ばれる(不正でも呼ぶ)。
 */
export function createEditor(container, getSys, onChange) {
  const table = el('table', { class: 'lde' });
  const errorBox = el('div', { class: 'errors', role: 'alert', 'aria-live': 'polite' });
  container.append(table, errorBox);

  const commit = (structural = false) => {
    const sys = getSys();
    onChange(sys);
    if (structural) render(); else markErrors();
  };

  function numberCell(row, field, value, { allowInf = false, title = '', placeholder = '' } = {}) {
    const input = el('input', {
      type: 'text', inputmode: 'decimal', value: fmt(value), 'data-row': row, 'data-field': field,
      'aria-label': `行 ${row} ${title}`, placeholder, spellcheck: 'false', autocomplete: 'off',
    });
    input.addEventListener('input', () => {
      getSys().surfaces[row][field] = parseNumber(input.value, allowInf);
      commit();
    });
    return el('td', {}, input);
  }
  const dash = (why) => el('td', { class: 'na', title: why }, '—');

  function materialCell(row, s) {
    const sel = el('select', { 'data-row': row, 'data-field': 'material', 'aria-label': `行 ${row} 材質` });
    sel.append(el('option', { value: 'air' }, '空気'));
    const g = el('optgroup', { label: 'ガラス(refractiveindex.info)' });
    for (const p of PRESETS) g.append(el('option', { value: `preset:${p.name}` }, p.name));
    sel.append(g, el('option', { value: 'model' }, 'カスタム'));
    const m = s.material ?? { type: 'air' };
    sel.value = m.type === 'preset' ? `preset:${m.name}` : m.type;
    const td = el('td', { class: 'mat' }, sel);
    if (m.type === 'preset') {
      const pr = PRESETS.find((p) => p.name === m.name);
      if (pr) td.append(el('div', { class: 'sub' }, `nd ${pr.nd.toFixed(4)}  νd ${pr.vd.toFixed(2)}`));
    }
    if (m.type === 'model') {
      const nd = el('input', { type: 'text', inputmode: 'decimal', value: fmt(m.nd), class: 'small', 'data-row': row, 'data-field': 'material', title: '屈折率 nd(d 線 587.6 nm)', 'aria-label': `行 ${row} nd` });
      const vd = el('input', { type: 'text', inputmode: 'decimal', value: fmt(m.vd), class: 'small', 'data-row': row, 'data-field': 'material', title: 'アッベ数 νd(大きいほど分散が小さい。1e12 で無分散)', 'aria-label': `行 ${row} νd` });
      nd.addEventListener('input', () => { getSys().surfaces[row].material.nd = parseNumber(nd.value); commit(); });
      vd.addEventListener('input', () => { getSys().surfaces[row].material.vd = parseNumber(vd.value); commit(); });
      td.append(el('div', { class: 'model' }, el('label', {}, 'nd ', nd), el('label', {}, 'νd ', vd)));
    }
    sel.addEventListener('change', () => {
      const v = sel.value;
      const surf = getSys().surfaces[row];
      if (v === 'air') surf.material = { type: 'air' };
      else if (v === 'model') {
        const prev = surf.material?.type === 'preset' ? PRESETS.find((p) => p.name === surf.material.name) : null;
        surf.material = { type: 'model', nd: +(prev?.nd ?? 1.5168).toFixed(5), vd: +(prev?.vd ?? 64.17).toFixed(2) };
      } else surf.material = { type: 'preset', name: v.slice(7) };
      commit(true);
    });
    return td;
  }

  function kindCell(row, s, n) {
    if (row === 0 || row === n - 1) return el('td', { class: 'kind fixed' }, KIND_LABEL[s.kind]);
    const sel = el('select', { 'data-row': row, 'data-field': 'kind', 'aria-label': `行 ${row} 種別`, title: 'レンズ面: 屈折する面 / アイリス: 開口絞り(光束の太さを制限)' },
      el('option', { value: 'surface' }, KIND_LABEL.surface), el('option', { value: 'iris' }, KIND_LABEL.iris));
    sel.value = s.kind;
    sel.addEventListener('change', () => {
      const surf = getSys().surfaces[row];
      surf.kind = sel.value;
      if (surf.kind === 'iris') { surf.radius = Infinity; surf.material = { type: 'air' }; }
      commit(true);
    });
    return el('td', { class: 'kind' }, sel);
  }

  function actions(row, n) {
    const S = () => getSys().surfaces;
    const btn = (label, title, fn, disabled = false) => el('button', { type: 'button', class: 'icon', title, 'aria-label': title, onclick: fn, disabled }, label);
    const inner = row > 0 && row < n - 1;
    return el('td', { class: 'act' },
      btn('↑', '上へ移動', () => { const s = S(); [s[row - 1], s[row]] = [s[row], s[row - 1]]; commit(true); }, !(inner && row > 1)),
      btn('↓', '下へ移動', () => { const s = S(); [s[row + 1], s[row]] = [s[row], s[row + 1]]; commit(true); }, !(inner && row < n - 2)),
      btn('＋', 'この行の後ろに面を挿入', () => {
        S().splice(row + 1, 0, { kind: 'surface', radius: Infinity, thickness: 5, material: { type: 'air' }, diameter: S()[row].diameter || 20 });
        commit(true);
      }, row === n - 1),
      btn('✕', 'この行を削除', () => { S().splice(row, 1); commit(true); }, !inner),
    );
  }

  function render() {
    const sys = getSys();
    const n = sys.surfaces.length;
    table.replaceChildren();
    table.append(el('thead', {}, el('tr', {},
      el('th', { title: '面番号' }, '#'),
      el('th', { title: '面の種類。物体面は先頭、スクリーンは末尾に固定' }, '種別'),
      el('th', { title: '曲率半径 [mm]。曲率中心が右(+z, 光の進む側)にあれば正。平面は inf' }, '曲率半径 R', el('small', {}, 'mm')),
      el('th', { title: '次の面までの距離 [mm](物体面の行では物体距離)' }, '厚み/間隔', el('small', {}, 'mm')),
      el('th', { title: 'この面の右側(次の面まで)を満たす媒質' }, '材質(右側の媒質)'),
      el('th', { title: '有効径(開口の直径)[mm]。外側を通る光線は遮蔽' }, '直径', el('small', {}, 'mm')),
      el('th', {}, '操作'),
    )));
    const body = el('tbody');
    sys.surfaces.forEach((s, i) => {
      const tr = el('tr', { class: `k-${s.kind}` }, el('td', { class: 'idx' }, String(i)), kindCell(i, s, n));
      if (s.kind === 'surface') tr.append(numberCell(i, 'radius', s.radius, { allowInf: true, title: '曲率半径', placeholder: 'inf' }));
      else tr.append(dash(s.kind === 'iris' ? 'アイリスは平面' : '平面'));
      if (s.kind === 'screen') tr.append(dash('最終面'));
      else tr.append(numberCell(i, 'thickness', s.thickness, { title: s.kind === 'object' ? '物体距離' : '厚み' }));
      if (s.kind === 'surface' || s.kind === 'object') tr.append(materialCell(i, s));
      else tr.append(dash(s.kind === 'iris' ? 'アイリスは前の媒質を引き継ぎます' : '—'));
      if (s.kind === 'surface' || s.kind === 'iris') tr.append(numberCell(i, 'diameter', s.diameter, { title: '直径' }));
      else tr.append(dash(s.kind === 'object' ? '物体の大きさは下の「物体高」で指定' : 'スクリーンの大きさは下で指定'));
      tr.append(actions(i, n));
      body.append(tr);
    });
    table.append(body);
    markErrors();
  }

  function markErrors() {
    const { errors } = validateSystem(getSys());
    table.querySelectorAll('.invalid').forEach((e) => { e.classList.remove('invalid'); e.removeAttribute('aria-invalid'); e.title = e.dataset.title ?? ''; });
    container.querySelectorAll('[data-sysfield].invalid').forEach((e) => e.classList.remove('invalid'));
    for (const er of errors) {
      const sel = table.querySelectorAll(`[data-row="${er.row}"][data-field="${er.field}"]`);
      sel.forEach((e) => { e.dataset.title ??= e.title; e.classList.add('invalid'); e.setAttribute('aria-invalid', 'true'); e.title = er.message; });
      document.querySelectorAll(`[data-sysfield="${er.field}"]`).forEach((e) => e.classList.add('invalid'));
    }
    errorBox.replaceChildren();
    if (errors.length) {
      errorBox.append(el('strong', {}, '入力エラー(直前の正しい状態で計算を続けています)'));
      const ul = el('ul');
      for (const er of errors) ul.append(el('li', {}, `行 ${er.row}: ${er.message}`));
      errorBox.append(ul);
    }
  }

  render();
  return { render, markErrors };
}
