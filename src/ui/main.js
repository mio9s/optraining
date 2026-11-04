// 起動・状態管理・再計算
import { defaultSystem, validateSystem, SAMPLE_SYSTEMS } from '../core/system.js';
import { focusScreen } from '../core/paraxial.js';
import { makePattern, PATTERN_NAMES } from '../core/patterns.js';
import { composeImage, mergeScatterCfg } from '../core/stray.js';
import { createEditor, parseNumber, fmt } from './editor.js';
import { createLayoutView, layoutData, WL_COLOR } from './layout-view.js';
import { drawLinearImage, loadImageFile } from './image-view.js';
import { renderChromatic, renderZernike, renderScatterPanels } from './analysis-view.js';
import { computeAll } from './worker.js';

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
  ui: { zField: 0, zWl: 0.52, tab: 'chroma' },
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
function runAnalysis(refit = false) {
  const v = validateSystem(state.sys);
  if (v.ok) state.valid = structuredClone(state.sys);
  const sys = state.valid;
  try {
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
    if (t === 'chroma') renderChromatic($('tab-chroma'), sys);
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
  $('btn-image').disabled = true;
  $('btn-image').textContent = '計算中…';
  setProgress(0, '準備');
  const done = (r) => {
    $('btn-image').disabled = false; $('btn-image').textContent = '結像を計算';
    state.result = r; state.resultStale = false; showResult();
  };
  const fail = (m) => {
    $('btn-image').disabled = false; $('btn-image').textContent = '結像を計算';
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
    Object.assign(document.createElement('p'), { className: 'note', textContent: '設定の変更は次の「結像を計算」から反映されます。' }),
  );
}

// ---------- 起動 ----------
const layout = createLayoutView($('layout'));
const editor = createEditor($('editor'), () => state.sys, () => scheduleAnalysis());

function syncSysFields() {
  $('obj-h').value = fmt(state.sys.object.height);
  $('scr-w').value = fmt(state.sys.screen.width);
  $('scr-px').value = String(state.sys.screen.pixels);
  $('wl-list').replaceChildren(...state.sys.wavelengths.map((l) => {
    const s = document.createElement('span'); s.className = 'wl';
    s.innerHTML = `<i class="sw" style="background:${WL_COLOR(l)}"></i>${(l * 1000).toFixed(0)} nm`;
    return s;
  }));
  $('layout-legend').innerHTML = state.sys.wavelengths.map((l) => `<span><i class="sw" style="background:${WL_COLOR(l)}"></i>${(l * 1000).toFixed(0)} nm</span>`).join('') + '<span><i class="sw ghost"></i>ゴースト</span>';
}
function bindSysField(id, apply) {
  $(id).addEventListener('input', () => { apply(parseNumber($(id).value)); editor.markErrors(); scheduleAnalysis(); });
}
bindSysField('obj-h', (v) => (state.sys.object.height = v));
bindSysField('scr-w', (v) => (state.sys.screen.width = v));
bindSysField('scr-px', (v) => (state.sys.screen.pixels = v));

function loadSystem(sys) {
  state.sys = sys; state.result = null;
  editor.render(); syncSysFields();
  $('img-cap').textContent = '結像画像(「結像を計算」を押してください)';
  $('img-cap').classList.remove('warn');
  const c = $('img-canvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  $('budget').replaceChildren();
  runAnalysis(true);
}

for (const [k, v] of Object.entries(SAMPLE_SYSTEMS)) $('sample').append(new Option(v.label, k));
$('sample').addEventListener('change', () => loadSystem(SAMPLE_SYSTEMS[$('sample').value].make()));
$('btn-focus').addEventListener('click', () => {
  if (!validateSystem(state.sys).ok) { alert('入力エラーを先に直してください'); return; }
  loadSystem(focusScreen(state.sys, 0.52));
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

document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => {
  state.ui.tab = b.dataset.tab;
  document.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
  renderTab();
}));

renderScatterPanels($('tab-scatter'));
renderSettings();
syncSysFields();
runAnalysis(true);
