// 起動・状態管理・再計算
import { defaultSystem, validateSystem, SAMPLE_SYSTEMS } from '../core/system.js';
import { focusScreen } from '../core/paraxial.js';
import { makePattern, PATTERN_NAMES } from '../core/patterns.js';
import { composeImage, mergeScatterCfg } from '../core/stray.js';
import { createEditor, parseNumber, fmt } from './editor.js';
import { createLayoutView, layoutData, WL_COLOR } from './layout-view.js';
import { drawLinearImage, loadImageFile } from './image-view.js';
import { renderChromatic, renderZernike, renderScatterPanels, renderFocus } from './analysis-view.js';
import { focusBest } from '../core/focus.js';
import { computeAll } from './worker.js';
import { initAppearance, defaultAppearance } from './appearance/app.js';
import { systemPalette } from './material-colors.js';

const $ = (id) => document.getElementById(id);

const state = {
  sys: defaultSystem(),
  valid: defaultSystem(),
  patternName: 'arrow',
  customImage: null,
  scatterCfg: mergeScatterCfg(),
  settings: { fieldGrid: 3, nPupil: 24, rays: 20000, fresnel: true, ghost: true, stray: true },
  result: null,
  resultStale: false,
  ui: { zField: 0, zWl: 0.52, tab: 'focus' },
  edited: false,
  sampleKey: 'achromat',
};

// ---------- 物体 ----------
function objectImage() {
  return state.customImage ?? makePattern(state.patternName, 256);
}
function drawObject() {
  const o = objectImage();
  drawLinearImage($('obj-canvas'), o.data, o.size);
  const s = state.valid;
  $('obj-cap').textContent = `物体(一辺 ${fmt(2 * s.object.height)} mm、物体距離 ${fmt(s.surfaces[0].thickness)} mm)`;
}

// ---------- 再計算(軽い解析) ----------
let timer = null;
function scheduleAnalysis() {
  clearTimeout(timer);
  timer = setTimeout(runAnalysis, 200);
}
const STORE_KEY = 'optraining.system.v1';
const AP_KEY = 'optraining.appearance.v1';
const toJSON = (sys) => JSON.stringify(sys, (k, v) => (v === Infinity ? 'inf' : v === -Infinity ? '-inf' : v), 1);
const fromJSON = (text) => JSON.parse(text, (k, v) => (v === 'inf' ? Infinity : v === '-inf' ? -Infinity : v));
function saveLocal() {
  try { localStorage.setItem(STORE_KEY, toJSON({ sys: state.valid, sample: state.sampleKey, edited: state.edited })); } catch { /* 保存できない環境では無視 */ }
}
function markEdited() {
  if (state.edited) return;
  state.edited = true;
  const opt = $('sample').selectedOptions[0];
  if (opt && !opt.textContent.endsWith('(編集済み)')) opt.textContent += '(編集済み)';
}
function runAnalysis(refit = false) {
  const v = validateSystem(state.sys);
  if (v.ok) { state.valid = structuredClone(state.sys); saveLocal(); }
  const sys = state.valid;
  try {
    renderLegend();
    layout.update(layoutData(sys, { rays: 7, ghosts: $('show-ghost').checked }), refit);
  } catch (e) { console.error(e); }
  renderTab();
  drawObject();
  if (state.result) { state.resultStale = true; showResult(); }
}

function renderTab() {
  const sys = state.valid;
  const t = state.ui.tab;
  try {
    if (t === 'focus') renderFocus($('tab-focus'), sys, { onBest: bestFocusAndImage, onInfinity: infinityFocusAndImage });
    else if (t === 'chroma') renderChromatic($('tab-chroma'), sys);
    else if (t === 'zern') renderZernike($('tab-zern'), sys, state.ui);
  } catch (e) {
    console.error(e);
    $(`tab-${t}`).textContent = `計算できませんでした: ${e.message}`;
  }
}

// ---------- 結像(重い計算) ----------
let worker = null, jobId = 0;
function getWorker() {
  if (worker !== null) return worker;
  try {
    const url = URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' }));
    worker = new Worker(url);
  } catch (e) {
    console.warn('Web Worker を使えないため UI スレッドで計算します', e);
    worker = false;
  }
  return worker;
}
function setProgress(p, label) {
  const box = $('progress');
  box.hidden = p >= 1;
  box.querySelector('i').style.width = `${Math.round(p * 100)}%`;
  box.querySelector('span').textContent = `${label}… ${Math.round(p * 100)}%`;
}
function runImage() {
  const msg = {
    id: ++jobId, sys: state.valid, objectImg: objectImage(), scatterCfg: state.scatterCfg,
    settings: { ...state.settings, stray: state.settings.stray },
  };
  $('btn-image').disabled = true; $('btn-best').disabled = true;
  $('btn-image').textContent = '計算中…';
  setProgress(0, '準備');
  const done = (r) => {
    $('btn-image').disabled = false; $('btn-best').disabled = false; $('btn-image').textContent = 'いまの位置で結像';
    state.result = r; state.resultStale = false; showResult();
  };
  const fail = (m) => {
    $('btn-image').disabled = false; $('btn-best').disabled = false; $('btn-image').textContent = 'いまの位置で結像';
    setProgress(1, ''); $('img-cap').textContent = `エラー: ${m}`;
  };
  const w = getWorker();
  if (w) {
    w.onmessage = (e) => {
      if (e.data.id !== jobId) return;
      if (e.data.type === 'progress') setProgress(e.data.p, e.data.label);
      else if (e.data.type === 'done') done(e.data.result);
      else fail(e.data.message);
    };
    w.onerror = (e) => { worker = false; fail(e.message || 'Worker エラー'); };
    w.postMessage(msg);
  } else {
    setTimeout(() => {
      try { done(computeAll(msg, () => {})); } catch (e) { fail(e.message); }
    }, 30);
  }
}

function showResult() {
  const r = state.result;
  if (!r) return;
  const P = r.P;
  const n = P * P * 3;
  const gain = +$('stray-gain').value;
  const ramanImg = r.stray && $('c-raman').checked ? r.stray.raman : null;
  // 露出は 0..1 クリップ前に掛ける
  let gainExp;
  if ($('c-auto').checked) {
    // 直接光の 99.5 パーセンタイルを白に
    const vals = Array.from(r.direct).filter((v) => v > 0).sort((a, b) => a - b);
    const ref = vals.length ? vals[Math.floor(vals.length * 0.995)] : 1;
    gainExp = ref > 0 ? 1 / ref : 1;
  } else gainExp = 2 ** +$('exposure').value;
  $('exposure-out').textContent = `×${gainExp < 10 ? gainExp.toFixed(2) : gainExp.toPrecision(3)}`;
  const raw = composeImage(
    $('c-direct').checked ? r.direct : new Float32Array(n),
    $('c-ghost').checked ? r.ghost : null,
    $('c-stray').checked && r.stray ? r.stray.image : null,
    { direct: 1, ghost: 1, stray: gain, raman: gain, exposure: gainExp },
    ramanImg,
  );
  drawLinearImage($('img-canvas'), raw, P);
  const s = state.valid;
  const modes = [...new Set(r.psfModes.map((m) => (m.mode === 'diffraction' ? '回折' : m.mode === 'geometric' ? '幾何' : '—')))].join('・');
  $('img-cap').textContent = r.message
    ? r.message
    : `結像(スクリーン一辺 ${fmt(s.screen.width)} mm、${P}×${P} px、PSF: ${modes}、${(r.ms / 1000).toFixed(1)} 秒)${state.resultStale ? ' ※入力変更後は再計算してください' : ''}`;
  $('img-cap').classList.toggle('warn', !!r.message || state.resultStale);
  // エネルギー収支
  const b = r.stray?.budget;
  const box = $('budget');
  box.replaceChildren();
  if (b) {
    const names = { transmitted: '透過(直接光)', ghost: 'ゴースト(多重反射)', glassScatter: 'ガラス内部散乱', surfaceScatter: '表面散乱', mediumScatter: '空間(霧)散乱', raman: 'ラマン', backscatter: '後方へ戻る光', lost: '遮蔽・系外へ' };
    const t = document.createElement('table');
    t.className = 'kv budget';
    t.innerHTML = '<caption>光のエネルギー収支(モンテカルロ、入射 = 100 %)</caption>';
    for (const [k, label] of Object.entries(names)) {
      const tr = t.insertRow();
      tr.insertCell().textContent = label;
      const c = tr.insertCell(); c.className = 'num';
      c.textContent = `${(b[k] * 100).toPrecision(3)} %`;
    }
    box.append(t);
  }
}

// ---------- 設定タブ ----------
function renderSettings() {
  const el = $('tab-settings');
  el.replaceChildren();
  const cfg = state.scatterCfg, st = state.settings;
  const mk = (label, get, set, unit, title, check = (v) => v >= 0) => {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.inputMode = 'decimal'; inp.value = String(get()); inp.title = title;
    inp.addEventListener('input', () => {
      const v = parseNumber(inp.value);
      const ok = Number.isFinite(v) && check(v);
      inp.classList.toggle('invalid', !ok);
      if (ok) { set(v); if (state.result) { state.resultStale = true; showResult(); } }
    });
    const l = document.createElement('label'); l.className = 'field'; l.title = title;
    l.append(Object.assign(document.createElement('span'), { textContent: label }), inp, Object.assign(document.createElement('small'), { textContent: unit }));
    return l;
  };
  const chk = (label, key, title) => {
    const l = document.createElement('label'); l.className = 'check'; l.title = title;
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = st[key];
    c.addEventListener('change', () => { st[key] = c.checked; });
    l.append(c, ` ${label}`);
    return l;
  };
  const sec = (title, ...kids) => {
    const f = document.createElement('fieldset');
    f.append(Object.assign(document.createElement('legend'), { textContent: title }), ...kids);
    return f;
  };
  el.append(
    sec('ガラス内部',
      mk('散乱係数(550 nm)', () => cfg.glass.scatterCoef, (v) => (cfg.glass.scatterCoef = v), '1/mm', 'レイリー型(λ⁻⁴ で波長換算)。1 mm 進む間に散乱される割合'),
      mk('ラマン係数', () => cfg.glass.ramanCoef, (v) => (cfg.glass.ramanCoef = v), '1/mm', '1 mm 進む間にラマン散乱される割合'),
      mk('ラマンシフト', () => cfg.glass.ramanShift, (v) => (cfg.glass.ramanShift = v), 'cm⁻¹', 'SiO₂ の主ピーク 465 cm⁻¹', (v) => v > 0),
      mk('温度', () => cfg.glass.tempK, (v) => (cfg.glass.tempK = v), 'K', '反ストークス光の強さに影響', (v) => v > 0)),
    sec('レンズ表面',
      mk('RMS 粗さ+汚れ', () => cfg.surface.sigmaNm, (v) => (cfg.surface.sigmaNm = v), 'nm', '全積分散乱 TIS の計算に使用')),
    sec('空間(霧・粒子)',
      mk('粒子密度', () => cfg.medium.density, (v) => (cfg.medium.density = v), '個/mm³', '0 で霧なし。例: 100 で濃い霧'),
      mk('粒子径', () => cfg.medium.particleUm, (v) => (cfg.medium.particleUm = v), 'µm', 'ミー散乱で計算', (v) => v > 0),
      mk('粒子屈折率', () => cfg.medium.nParticle, (v) => (cfg.medium.nParticle = v), '', '水滴 ≈ 1.33', (v) => v > 0)),
    sec('計算',
      mk('モンテカルロ光線数', () => st.rays, (v) => (st.rays = Math.round(v)), '本', '散乱・ゴーストの統計に使う光線数', (v) => v >= 100 && v <= 1e6),
      mk('視野の分割数', () => st.fieldGrid, (v) => (st.fieldGrid = Math.round(v)), '× 分割', 'PSF を計算するパッチ数(一辺)。多いほど正確で遅い', (v) => v >= 1 && v <= 7),
      mk('瞳サンプル数', () => st.nPupil, (v) => (st.nPupil = Math.round(v)), '× 点', '波面計算の格子(一辺)', (v) => v >= 8 && v <= 64),
      chk('フレネル透過損失を含める', 'fresnel', '無コート面の反射による減光'),
      chk('ゴーストを計算', 'ghost', '2 回反射の経路を追跡'),
      chk('散乱・ラマンを計算', 'stray', 'モンテカルロ(時間がかかります)')),
    Object.assign(document.createElement('p'), { className: 'note', textContent: '設定の変更は次の結像の計算から反映されます。' }),
  );
}

// ---------- 起動 ----------
const layout = createLayoutView($('layout'));
const editor = createEditor($('editor'), () => state.sys, () => { markEdited(); scheduleAnalysis(); });

function syncSysFields() {
  $('obj-h').value = fmt(state.sys.object.height);
  $('scr-w').value = fmt(state.sys.screen.width);
  $('scr-px').value = String(state.sys.screen.pixels);
  $('wl-list').replaceChildren(...state.sys.wavelengths.map((l) => {
    const s = document.createElement('span'); s.className = 'wl';
    s.innerHTML = `<i class="sw" style="background:${WL_COLOR(l)}"></i>${(l * 1000).toFixed(0)} nm`;
    return s;
  }));
  renderLegend();
}
function renderLegend() {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const mats = [...systemPalette(state.valid).values()].map((c) => `<span class="mat-legend"><i class="sw mat" style="background:${c.fill(0.55)};border-color:${c.solid}"></i>${esc(c.name)}</span>`).join('');
  $('layout-legend').innerHTML = state.valid.wavelengths.map((l) => `<span><i class="sw" style="background:${WL_COLOR(l)}"></i>${(l * 1000).toFixed(0)} nm 光線</span>`).join('') + mats + '<span><i class="sw ghost"></i>ゴースト</span>';
}
function bindSysField(id, apply) {
  $(id).addEventListener('input', () => { apply(parseNumber($(id).value)); markEdited(); editor.markErrors(); scheduleAnalysis(); });
}
bindSysField('obj-h', (v) => (state.sys.object.height = v));
bindSysField('scr-w', (v) => (state.sys.screen.width = v));
bindSysField('scr-px', (v) => (state.sys.screen.pixels = v));

const EDITED = '(編集済み)';
function resetSampleLabels() {
  // 読み込んだファイルの項目は残し、「(編集済み)」だけ外す(サンプルを選び直したときに消す)
  for (const o of [...$('sample').options]) { if (SAMPLE_SYSTEMS[o.value]) o.textContent = SAMPLE_SYSTEMS[o.value].label; else if (o.textContent.endsWith(EDITED)) o.textContent = o.textContent.slice(0, -EDITED.length); }
}
function loadSystem(sys, { edited = false } = {}) {
  state.sys = sys; state.result = null;
  resetSampleLabels(); state.edited = false;
  if (edited) markEdited();
  editor.render(); syncSysFields();
  $('img-cap').textContent = '結像画像(「最良像面へ合わせて結像」または「いまの位置で結像」を押してください)';
  $('img-cap').classList.remove('warn');
  const c = $('img-canvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  $('budget').replaceChildren();
  runAnalysis(true);
}

for (const [k, v] of Object.entries(SAMPLE_SYSTEMS)) $('sample').append(new Option(v.label, k));
$('sample').addEventListener('change', () => {
  if (state.edited && !confirm('編集中のレンズデータを破棄してサンプル系を読み込みますか?(必要なら先に「保存」してください)')) {
    $('sample').value = state.sampleKey; return;
  }
  if (!SAMPLE_SYSTEMS[$('sample').value]) return;
  $('sample').querySelector('option[value="file"]')?.remove();
  state.sampleKey = $('sample').value;
  loadSystem(SAMPLE_SYSTEMS[state.sampleKey].make());
});
/** 最良像面へスクリーンを移し、結像画像まで計算する */
function bestFocusAndImage() {
  if (!validateSystem(state.sys).ok) { alert('入力エラーを先に直してください'); return; }
  const { system, result } = focusBest(state.valid);
  if (!result.ok) { alert(result.message); return; }
  loadSystem(system, { edited: true });
  selectTab('focus');
  runImage();
}
$('btn-best').addEventListener('click', bestFocusAndImage);
/** 物体を無限遠(1 km)に置き、焦点面(最良像面)で結像。視野の角度は保つよう物体の大きさも比例させる */
function infinityFocusAndImage() {
  if (!validateSystem(state.sys).ok) { alert('入力エラーを先に直してください'); return; }
  const s = structuredClone(state.valid);
  const far = 1e6, k = far / s.surfaces[0].thickness;
  s.surfaces[0].thickness = far; s.object.height *= k; s.surfaces[0].diameter = Math.max(s.surfaces[0].diameter * k, 2.5 * s.object.height);
  const { system, result } = focusBest(s);
  if (!result.ok) { alert(result.message); return; }
  loadSystem(system, { edited: true });
  selectTab('focus');
  runImage();
}
$('btn-focus').addEventListener('click', () => {
  if (!validateSystem(state.sys).ok) { alert('入力エラーを先に直してください'); return; }
  loadSystem(focusScreen(state.sys, 0.52), { edited: true });
});
$('btn-save').addEventListener('click', () => {
  const blob = new Blob([toJSON({ format: 'optraining', version: 2, system: state.valid, appearance: appearanceState })], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'optraining-system.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('file-sys').addEventListener('change', async () => {
  const f = $('file-sys').files[0];
  $('file-sys').value = '';
  if (!f) return;
  try {
    const obj = fromJSON(await f.text());
    // 旧形式(レンズデータのみ)と新形式 {system, appearance} の両方を受け付ける
    const sys = obj.surfaces ? obj : obj.system;
    if (!sys) throw new Error('optraining のファイルではありません');
    const v = validateSystem(sys);
    if (!v.ok) throw new Error(v.errors.map((e) => `行 ${e.row}: ${e.message}`).join('\n'));
    loadSystem(sys, { edited: false });
    // サンプル欄に読み込んだファイル名を表示
    $('sample').querySelector('option[value="file"]')?.remove();
    $('sample').append(new Option(`ファイル: ${f.name}`, 'file', true, true));
    $('sample').value = 'file'; state.sampleKey = 'file'; state.edited = false;
    // 外観の設定はレンズデータを反映した後に読み込む(読み込んだ部品を自動再生成で消さない)
    if (obj.appearance) { Object.assign(appearanceState, defaultAppearance(), obj.appearance); appearance.reload(); saveAppearance(); }
  } catch (e) { alert(`レンズデータを読み込めませんでした:\n${e.message}`); }
});
$('btn-help').addEventListener('click', () => $('help').showModal());
$('btn-fit').addEventListener('click', () => layout.fit());
$('btn-lens').addEventListener('click', () => layout.fit(true));
$('show-ghost').addEventListener('change', () => runAnalysis());
$('btn-image').addEventListener('click', runImage);
for (const id of ['c-direct', 'c-ghost', 'c-stray', 'c-raman', 'c-auto', 'stray-gain']) $(id).addEventListener('change', showResult);
$('exposure').addEventListener('input', () => { $('c-auto').checked = false; showResult(); });

for (const [k, v] of Object.entries(PATTERN_NAMES)) $('pattern').append(new Option(v, k));
$('pattern').append(new Option('読み込んだ画像', 'custom'));
$('pattern').querySelector('[value="custom"]').disabled = true;
$('pattern').addEventListener('change', () => {
  const v = $('pattern').value;
  if (v !== 'custom') { state.customImage = null; state.patternName = v; $('file-info').textContent = ''; }
  drawObject();
});
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  $('file-info').textContent = '読み込み中…';
  try {
    state.customImage = await loadImageFile(f, 512);
    const opt = $('pattern').querySelector('[value="custom"]');
    opt.disabled = false; $('pattern').value = 'custom';
    $('file-info').textContent = `${f.name}(${state.customImage.sourceWidth}×${state.customImage.sourceHeight} → ${state.customImage.size}×${state.customImage.size} px)`;
    drawObject();
  } catch (e) {
    $('file-info').textContent = e.message;
  }
  $('file').value = '';
});

// 右パネルのタブ(モード切り替えのボタンは含めない)
function selectTab(name) {
  state.ui.tab = name;
  document.querySelectorAll('#right .tabs [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === name)));
  document.querySelectorAll('#right .tab').forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  renderTab();
}
document.querySelectorAll('#right .tabs [role=tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

renderScatterPanels($('tab-scatter'));
renderSettings();
// ---------- 外観タブ ----------
const appearanceState = (() => {
  try { const v = fromJSON(localStorage.getItem(AP_KEY) ?? 'null'); if (v) return { ...defaultAppearance(), ...v }; } catch { /* */ }
  return defaultAppearance();
})();
// 保存はまとめて(ドラッグ中に毎回 JSON 化しない。STL の部品は大きい)
let apSaveTimer = null, apSaveWarned = false;
function saveAppearance() {
  clearTimeout(apSaveTimer);
  apSaveTimer = setTimeout(() => {
    try { localStorage.setItem(AP_KEY, toJSON(appearanceState)); } catch {
      if (!apSaveWarned && appearanceState.parts?.some((p) => p.kind === 'mesh')) { apSaveWarned = true; const w = $('ap-warn'); if (w) w.textContent = 'STL の部品が大きいため、ブラウザに自動保存できません。「保存」(JSON ファイル)で保存してください。'; }
    }
  }, 400);
}
const appearance = initAppearance({
  getSystem: () => state.valid, getState: () => appearanceState, setState: () => saveAppearance(),
  // 外観の部品から作ったレンズデータを結像モードで開く
  onLoadSystem: (sys) => {
    loadSystem(sys, { edited: false });
    // サンプル欄に出どころを表示(「アクロマート(編集済み)」のように見えないように)
    $('sample').querySelector('option[value="file"]')?.remove();
    $('sample').append(new Option('外観の部品から変換', 'file', true, true));
    $('sample').value = 'file'; state.sampleKey = 'file'; state.edited = false;
    appearance.markSynced(); setMode('imaging');
  },
});
const MODE_TEXT = {
  imaging: ['結像・収差モード', 'レンズデータを入力して、像の写り(PSF)・収差・色収差を解析します。', '① レンズデータ → ② 断面図 → ③ 結像'],
  appearance: ['外観モード', 'レンズを外から色々な角度で見て、部品どうしの界面が境界として見えるかを検証します。', '① 部品 → ② 外観(ドラッグで回転) → ③ 数値'],
};
function setMode(mode, first = false) {
  document.querySelectorAll('.modeswitch [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.view === mode)));
  document.body.dataset.mode = mode;
  $('view-imaging').hidden = mode !== 'imaging';
  $('view-appearance').hidden = mode !== 'appearance';
  const [name, desc, flow] = MODE_TEXT[mode];
  $('modebar').innerHTML = `<b>いまのモード: ${name}</b><span>${desc}</span><span>${flow}</span>`;
  document.title = `${name} — optraining`;
  try { localStorage.setItem('optraining.mode', mode); } catch { /* */ }
  if (mode === 'appearance') appearance.show(); else if (!first) runAnalysis(true);
}
document.querySelectorAll('.modeswitch [role=tab]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.view)));

// 前回の状態を復元
state.sampleKey = 'achromat';
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null', (k, v) => (v === 'inf' ? Infinity : v === '-inf' ? -Infinity : v));
  if (saved?.sys && validateSystem(saved.sys).ok) {
    state.sampleKey = SAMPLE_SYSTEMS[saved.sample] ? saved.sample : 'achromat';
    $('sample').value = state.sampleKey;
    loadSystem(saved.sys, { edited: !!saved.edited });
  }
} catch { /* 復元できなければ既定系 */ }
syncSysFields();
runAnalysis(true);
setMode((() => { try { return localStorage.getItem('optraining.mode') === 'appearance' ? 'appearance' : 'imaging'; } catch { return 'imaging'; } })(), true);
