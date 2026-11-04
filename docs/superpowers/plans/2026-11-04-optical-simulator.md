# 光学シミュレーター (optraining) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 球面レンズ系の 3D 光線追跡・結像・収差解析・反射散乱を行う、オフライン動作の単一 HTML シミュレーターを作る。

**Architecture:** 物理計算は DOM に依存しない ES モジュール群 (`src/core/`) に分け、Node の `node:test` で単体テストする。UI (`src/ui/`) はそれらを呼ぶだけ。`scripts/build.mjs` が全モジュールと埋め込みライブラリ・ガラスデータを 1 つの `dist/optraining.html` にインライン化する。

**Tech Stack:** Vanilla JS (ES2022 modules), Node 24 (`node:test`, ビルド), esbuild (バンドル, devDependency), uPlot (グラフ, MIT, バンドルに同梱), refractiveindex.info-database (ガラス Sellmeier 係数, CC0)。FFT と Mie 計算は自前実装 (依存を増やさないため; 小さく、テストで正しさを固定できる)。

**Spec:** `docs/superpowers/specs/2026-11-04-optical-simulator-design.md`

## Global Constraints

- 成果物は単一 HTML (`dist/optraining.html`)。CDN 参照禁止、全コード・データをインライン化し、オフラインで動作。
- 光学計算は 3 次元。表示は 2 次元断面(子午面 = y-z 平面)。
- 波長: 0.45 / 0.52 / 0.62 µm(配列 `WAVELENGTHS` で保持し、要素追加で拡張可能)。光源は無偏光。
- 単位: 長さ mm、波長 µm。光軸は +z。
- 符号規約: 曲率半径は曲率中心が面の +z 側にあれば正。`Infinity` = 平面。厚みは次面までの z 距離。
- 物理的正しさを見た目より優先する(スペックのアンチゴール)。
- リポジトリ: https://github.com/mio9s/optraining(公開)。コミット末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

1. 光線が面の直径外・球面と交差しない(半径 < 開口半径)・全反射する → その光線は「遮蔽 (vignetted)」として除外し、例外を投げずに描画・統計から外す。
2. 曲率半径に `0`、厚みに負値、直径に 0 以下、空欄を入力 → エディタがその行を赤表示し、計算は直前の有効状態を保持。
3. スクリーン位置が焦点から大きく外れる/全光線が遮蔽される → 結像画像は空(黒)とメッセージを表示し、NaN を描かない。
4. 大きな画像ファイル(例 4000×3000)の読み込み → 内部で最大 512×512 に縮小し、UI がフリーズしない。
5. アイリスをレンズ面と同じ位置(厚み 0)に置く → 正しく開口として働き、0 除算しない。

各項目のテストは、所有タスク(1→Task 3, 2→Task 2, 3→Task 6, 4→Task 10, 5→Task 3)に含める。

---

## File Structure

```
package.json                 scripts: test, build
scripts/build.mjs            esbuild でバンドル → HTML テンプレートへインライン化
scripts/import-glass.mjs     refractiveindex.info YAML → src/core/glass-data.js 生成
src/index.html               HTML テンプレート(<!--APP_JS--> <!--APP_CSS--> プレースホルダ)
src/styles.css
src/core/vec.js              3D ベクトル演算
src/core/glass.js            分散計算・プリセット検索
src/core/glass-data.js       生成物: プリセットの Sellmeier 係数
src/core/system.js           レンズ系モデル・検証・既定系
src/core/trace.js            実光線追跡
src/core/paraxial.js         近軸解析(EFL, 像位置, 色収差)
src/core/wavefront.js        OPD 計算・ゼルニケフィット
src/core/fft.js              2D FFT
src/core/psf.js              PSF 計算
src/core/imaging.js          物体パターン → 結像画像
src/core/fresnel.js          フレネル反射・ゴースト追跡
src/core/scatter.js          レイリー/ミー/HG/表面散乱/ラマン
src/core/patterns.js         内蔵物体パターン生成
src/ui/main.js               起動・状態管理・再計算
src/ui/editor.js             レンズデータエディタ
src/ui/layout-view.js        断面図 Canvas
src/ui/image-view.js         物体/結像画像表示・画像読込
src/ui/analysis-view.js      色収差・ゼルニケ・散乱パネル
test/*.test.js               core 各モジュールのテスト
```

---

### Task 1: 足場・ベクトル・ガラス分散

**Files:**
- Create: `package.json`, `scripts/build.mjs`, `scripts/import-glass.mjs`, `src/index.html`, `src/styles.css`, `src/ui/main.js`(空起動のみ), `src/core/vec.js`, `src/core/glass.js`, `src/core/glass-data.js`, `test/glass.test.js`, `.gitignore`(`node_modules/`, `dist/` は **コミットする**ので除外しない)

**Interfaces:**
- Produces:
  - `vec.js`: `add(a,b)`, `sub(a,b)`, `scale(a,s)`, `dot(a,b)`, `norm(a)`, `normalize(a)`(すべて `[x,y,z]` 配列)
  - `glass.js`: `WAVELENGTHS = [0.45, 0.52, 0.62]`; `LINES = {F:0.4861327, d:0.5875618, C:0.6562725}`; `refractiveIndex(material, lambdaUm) -> number`; `material` は `{type:'air'}` | `{type:'model', nd, vd}` | `{type:'preset', name}`; `listPresets() -> [{name, nd, vd}]`; `abbeFromPreset(name) -> {nd, vd}`
  - `glass-data.js`: `export const GLASS = { 'N-BK7': {B:[..3], C:[..3]}, ... }`(Sellmeier: n² = 1 + Σ Bᵢλ²/(λ² − Cᵢ))

- [ ] **Step 1: `npm init -y`、`npm i -D esbuild uplot`、`package.json` に `"type":"module"`, `"test":"node --test test/"`, `"build":"node scripts/build.mjs"` を設定**
- [ ] **Step 2: `scripts/import-glass.mjs` を書く** — GitHub `polyanskiy/refractiveindex.info-database` の固定コミットから `data-nk/glass/schott/` の N-BK7, N-SF11, N-SF5, N-SK16, N-F2, N-LAK9, N-BAF10 と `main/SiO2/Malitson`(石英)の YAML を取得し、`formula 2`(Sellmeier)係数を `glass-data.js` に書き出す。取得元コミット SHA とライセンス (CC0) をファイル先頭コメントに記録。実行して `glass-data.js` を生成。
- [ ] **Step 3: 失敗するテストを書く** `test/glass.test.js`

```js
test('N-BK7 preset nd matches catalog', () => {
  assert.ok(Math.abs(refractiveIndex({type:'preset',name:'N-BK7'}, LINES.d) - 1.5168) < 1e-4);
});
test('N-BK7 preset Abbe number ~64.17', () => {
  const {vd} = abbeFromPreset('N-BK7'); assert.ok(Math.abs(vd - 64.17) < 0.05);
});
test('model glass reproduces nd and vd', () => {
  const m = {type:'model', nd:1.6, vd:40};
  const n = l => refractiveIndex(m, l);
  assert.ok(Math.abs(n(LINES.d) - 1.6) < 1e-9);
  assert.ok(Math.abs((n(LINES.d)-1)/(n(LINES.F)-n(LINES.C)) - 40) < 1e-9);
});
test('blue index > red index (normal dispersion)', () => {
  const m = {type:'model', nd:1.5168, vd:64.17};
  assert.ok(refractiveIndex(m,0.45) > refractiveIndex(m,0.62));
});
test('air is 1.0', () => assert.equal(refractiveIndex({type:'air'},0.52), 1));
```

- [ ] **Step 4: `npm test` → FAIL(未定義)を確認**
- [ ] **Step 5: `vec.js`, `glass.js` を実装** — モデルガラスは 2 項コーシー式 n(λ)=A+B/λ²、B=(nd−1)/vd / (1/λF² − 1/λC²)、A=nd − B/λd²。この式を設計書 §6 に追記(実装者判断の明記)。
- [ ] **Step 6: `scripts/build.mjs` を書く** — esbuild で `src/ui/main.js` を IIFE バンドル(uPlot 含む)→ `src/index.html` の `<!--APP_JS-->` に `<script>` で、`styles.css` と `uplot/dist/uPlot.min.css` を `<!--APP_CSS-->` に `<style>` で埋め込み `dist/optraining.html` を書く。
- [ ] **Step 7: `npm test` PASS、`npm run build` で `dist/optraining.html` が生成されることを確認**
- [ ] **Step 8: Commit** `feat: scaffold build, vector math, glass dispersion`

---

### Task 2: レンズ系モデルと検証

**Files:** Create `src/core/system.js`, `test/system.test.js`

**Interfaces:**
- Consumes: `refractiveIndex`, material 型 (Task 1)
- Produces:
  - Surface 型: `{kind:'object'|'surface'|'iris'|'screen', radius:number, thickness:number, material:Material, diameter:number}`(`material` は「この面の後ろ側の媒質」。`iris`/`screen`/`object` の radius は `Infinity`)
  - System 型: `{surfaces: Surface[], object:{height:number}, screen:{width:number, pixels:number}, wavelengths:number[]}`。`surfaces[0]` は必ず `object`、最後は必ず `screen`。
  - `validateSystem(sys) -> {ok:boolean, errors:[{row:number, field:string, message:string}]}`
  - `surfaceZ(sys) -> number[]`(各面の頂点 z。物体面 z = 0)
  - `defaultSystem() -> System`(物体距離 200 mm、BK7 両凸 + 空気間隔 + SF5 凹のアクロマート風 2 枚、アイリス、スクリーン)

- [ ] **Step 1: 失敗するテスト**

```js
test('radius 0 is rejected', () => { /* row の radius=0 → errors に {row, field:'radius'} */ });
test('negative thickness is rejected', ...);
test('diameter <= 0 is rejected', ...);
test('empty/NaN field is rejected', ...);
test('first must be object, last must be screen', ...);
test('surfaceZ accumulates thicknesses', () => {
  // thickness [200, 5, 0, 50] → z [0, 200, 205, 205, 255]
});
test('defaultSystem validates', () => assert.ok(validateSystem(defaultSystem()).ok));
```

- [ ] **Step 2: FAIL を確認** — Run `npm test`
- [ ] **Step 3: 実装**
- [ ] **Step 4: PASS を確認**
- [ ] **Step 5: Commit** `feat: lens system model and validation`

---

### Task 3: 3D 実光線追跡

**Files:** Create `src/core/trace.js`, `test/trace.test.js`

**Interfaces:**
- Consumes: System, `surfaceZ`, `refractiveIndex`, vec (Task 1–2)
- Produces:
  - Ray 型: `{p:[x,y,z], d:[l,m,n](単位), lambda:number, intensity:number}`
  - `traceRay(sys, ray, opts?) -> {points:[x,y,z][], opl:number, alive:boolean, reason?:'vignetted'|'miss'|'tir', final:Ray}` — `points[i]` は面 i での交点。`opl` は物体点からスクリーンまでの光路長 Σ n·距離 (mm)。
  - `intersectSphere(p, d, zVertex, radius) -> number|null`(平面は `radius===Infinity`)
  - `refract(d, normal, n1, n2) -> [l,m,n] | null`(全反射で null)
  - `fanRays(sys, objPoint:[x,y,z], lambda, nPupil) -> Ray[]` — 入射瞳を開口絞り(最小開口を制限する iris、なければ最初の面)の像としてではなく、**開口絞り面上の正方格子点を狙う** 反復(各光線の y,x 方向をニュートン 3 回で修正)で生成。`nPupil` は 1 方向の点数、円内のみ。
  - `findStop(sys) -> index`(近軸マージナル光線高/直径 比が最大の面)

- [ ] **Step 1: 失敗するテスト**

```js
test('on-axis ray passes straight', ...);           // y=0, d=[0,0,1] → 全交点 x=y=0
test('Snell law at flat interface', ...);           // 空気→n=1.5, 入射30° → sin比 1.5
test('BK7 plano-convex focus matches lensmaker', () => {
  // R1=51.68, R2=∞, t=4, N-BK7, λ=d線。物体距離 1e9 相当の平行光、h=0.5 mm の近軸光線が
  // 光軸を横切る z と 後主点から計算した f=R1/(n-1)=100.0 が 0.1% 以内
});
test('ray outside diameter is vignetted', ...);     // reason==='vignetted', 例外なし
test('ray missing sphere returns miss', ...);       // |h| > |R| → reason==='miss'
test('TIR returns tir', ...);
test('iris at zero thickness acts as aperture', ...); // 直径 2mm iris, h=1.5 → vignetted; h=0.5 → alive
test('fanRays all hit stop inside its radius', ...);
```

- [ ] **Step 2: FAIL を確認**
- [ ] **Step 3: 実装** — 球面交点は頂点基準の二次方程式(数値安定形 `c/(-b∓√D)`)で、光線進行方向に近い根を選ぶ。法線は曲率中心向きを入射側に揃えてから `refract`。
- [ ] **Step 4: PASS を確認**
- [ ] **Step 5: Commit** `feat: 3D real ray tracing`

---

### Task 4: 近軸解析と色収差

**Files:** Create `src/core/paraxial.js`, `test/paraxial.test.js`

**Interfaces:**
- Consumes: System, `refractiveIndex`, `findStop`, `traceRay`
- Produces:
  - `paraxialTrace(sys, lambda) -> {efl, bfl, imageZ, magnification}`(y-nu 法)
  - `chromatic(sys) -> {longitudinal: {[lambda]: imageZ}, axialColor:number /*imageZ(0.45)-imageZ(0.62) mm*/, lateralColor:number /* 最大物体高での主光線像高 y(0.45)-y(0.62) mm, 実光線 */}`

- [ ] **Step 1: 失敗するテスト**

```js
test('thin-lens limit matches 1/f = (n-1)(1/R1-1/R2)', ...);  // 0.1%
test('axial color is zero when n is wavelength-independent', ...); // vd=1e12 のモデルガラス → |axialColor|<1e-9
test('axial color non-zero for BK7 singlet', ...);             // > 0.5 mm (f=100)
test('lateral color is zero for on-axis object height 0', ...);
```

- [ ] **Step 2–4: FAIL → 実装 → PASS**
- [ ] **Step 5: Commit** `feat: paraxial analysis and chromatic aberration`

---

### Task 5: 波面収差とゼルニケ分解

**Files:** Create `src/core/wavefront.js`, `test/wavefront.test.js`

**Interfaces:**
- Consumes: `fanRays`, `traceRay`, `paraxialTrace`
- Produces:
  - `zernike(j, rho, theta) -> number`(**Noll 番号付け, 規格化 RMS=1**, j=1..37)
  - `ZERNIKE_NAMES`(j → 日本語名: 1 ピストン, 2/3 チルト, 4 デフォーカス, 5/6 非点収差, 7/8 コマ, 11 球面収差 …)
  - `wavefront(sys, objPoint, lambda, n=32) -> {grid: Float64Array(n*n) /* OPD [waves], 瞳外は NaN */, n, rmsWaves, pvWaves}` — 参照球は主光線とスクリーンの交点を中心、半径 = 射出瞳(開口絞りの近軸像)からその点までの距離。OPD = OPL(参照球まで) − OPL(主光線)。
  - `fitZernike(grid, n, jMax=37) -> number[]`(最小二乗、係数 [waves], index 0 は j=1)
  - この規約(Noll, RMS 規格化)を設計書 §6 に追記。

- [ ] **Step 1: 失敗するテスト**

```js
test('Noll Z4 = sqrt(3)(2rho^2-1)', ...);
test('Zernike orthonormality over unit disk (j=1..15)', ...); // 数値積分で δ_ij ±1e-3
test('fit recovers synthetic coefficients', ...);  // 0.3*Z4 + 0.1*Z8 + 0.05*Z11 → 誤差 1e-6
test('BK7 singlet on-axis: Z11 (spherical) dominant, coma ~0', ...);  // |c8|<1e-3*|c11|
test('off-axis object produces coma Z7/Z8', ...);  // |c8| > 0.01 waves
```

- [ ] **Step 2–4: FAIL → 実装 → PASS**
- [ ] **Step 5: Commit** `feat: wavefront OPD and Zernike decomposition`

---

### Task 6: FFT・PSF・結像画像

**Files:** Create `src/core/fft.js`, `src/core/psf.js`, `src/core/imaging.js`, `src/core/patterns.js`, `test/fft.test.js`, `test/psf.test.js`, `test/imaging.test.js`

**Interfaces:**
- Consumes: `wavefront`, `traceRay`, `paraxialTrace`, System
- Produces:
  - `fft2d(re, im, n, inverse=false)`(in-place, radix-2, n は 2 の冪)
  - `psf(wf, lambda, pupilDiamMm, imageDistMm, pixelMm) -> {data: Float32Array(m*m), m, pixelMm}` — 瞳関数 = 振幅 × exp(i2π·OPD) を 4 倍ゼロパディングで FFT、|·|²、総和 1 に正規化、スクリーン画素ピッチへリサンプル。
  - `patterns.js`: `makePattern(name:'arrow'|'chart'|'grid'|'letterF', size=256) -> {data:Float32Array(size*size*3), size}`(RGB 0..1)
  - `formImage(sys, objectImg:{data,size,width?}, opts:{fieldGrid=3}) -> {data:Float32Array(P*P*3), P, message?:string}` — P = `sys.screen.pixels`。各波長について: (a) 物体面を `fieldGrid×fieldGrid` のパッチに分け、パッチ中心ごとに PSF を計算(アイソプラナティック近似)、(b) 物体画素 → スクリーン座標は実主光線で写像(歪曲・倍率色収差を含む)、(c) 写像後の画像をパッチ PSF で畳み込み、隣接パッチは双線形重みでブレンド。RGB チャネルへ: 0.45→B, 0.52→G, 0.62→R。
  - 全光線が遮蔽 or 結果に NaN → 黒画像と `message:'像が形成されません(光線が遮蔽されています)'`。

- [ ] **Step 1: 失敗するテスト**

```js
test('fft of delta is flat', ...);
test('fft inverse round-trip', ...);                 // 誤差 1e-9
test('aberration-free PSF matches Airy first zero 1.22 λ N', ...); // 5% 以内
test('PSF sums to 1', ...);
test('image of point source is inverted', ...);      // 物体 +y の点 → スクリーン −y に輝度ピーク
test('all rays vignetted gives black image + message', ...); // iris 直径 1e-6
test('no NaN in output for default system', ...);
test('stopping down iris changes the image', ...);   // iris 直径変更で出力が変わる
```

- [ ] **Step 2–4: FAIL → 実装 → PASS**
- [ ] **Step 5: Commit** `feat: FFT, PSF and image formation`

---

### Task 7: フレネル反射とゴースト

**Files:** Create `src/core/fresnel.js`, `test/fresnel.test.js`; Modify `src/core/trace.js`(各面で透過率を `intensity` に乗算するオプション `opts.fresnel`)

**Interfaces:**
- Produces:
  - `fresnel(n1, n2, cosI) -> {Rs, Rp, R /*(Rs+Rp)/2 無偏光*/, T}`
  - `traceGhosts(sys, ray, minIntensity=1e-6) -> [{surfaces:[i,j], points, intensity, alive}]` — 全ての面ペア (j<i) について i で反射→j で反射→スクリーンへの 2 回反射経路を追跡。
  - `ghostImage(sys, objectImg, opts) -> Float32Array`(ゴースト光を `formImage` と同サイズで、幾何的にスプラット)

- [ ] **Step 1: 失敗するテスト**

```js
test('normal incidence R = ((n1-n2)/(n1+n2))^2', ...); // 1→1.5 で 0.04
test('Brewster angle Rp = 0', ...);
test('R + T = 1', ...);
test('TIR gives R = 1', ...);
test('singlet has exactly one ghost pair (2,1)', ...); // 面 2 反射→面 1 反射
test('ghost intensity ~ R1*R2*T^2', ...);
```

- [ ] **Step 2–4: FAIL → 実装 → PASS**
- [ ] **Step 5: Commit** `feat: Fresnel reflection and ghost tracing`

---

### Task 8: 散乱モデル

**Files:** Create `src/core/scatter.js`, `test/scatter.test.js`

**Interfaces:**
- Produces:
  - `rayleigh(theta, lambdaUm, diameterUm, nParticle, nMedium) -> {phase /*(1+cos²θ) 正規化*/, crossSection /*µm²*/}` — σ = (2π⁵/3)(d⁶/λ⁴)((m²−1)/(m²+2))²、λ は媒質中。
  - `mie(x, mRe, mIm=0, nAngles=181) -> {Qext, Qsca, Qback, g, S11:Float64Array}` — Bohren–Huffman BHMIE を移植(x = π d n_medium / λ)。
  - `henyeyGreenstein(cosTheta, g) -> number`;`sampleHG(g, u) -> cosTheta`(逆関数サンプリング)
  - `forwardBackward(phaseFn) -> {forward, backward}`(θ<90° / θ>90° の積分比)
  - `surfaceTIS(sigmaNm, lambdaUm, cosI) -> number` — TIS = (4π σ cosI / λ)²(ここでは粗さ σ と汚れを合わせた RMS として扱う)
  - `ramanShift(lambdaUm, shiftCm1) -> {stokes, antiStokes}`(µm) — 1/λs = 1/λ − Δν·1e-4
  - `ramanAntiStokesRatio(lambdaUm, shiftCm1, tempK=293) -> number`(ボルツマン因子 × (ν_as/ν_s)⁴)
  - `SCATTER_DEFAULTS = {glass:{rayleighCoef:…, ramanShift:465 /*SiO2 主ピーク cm⁻¹*/, ramanCoef:1e-6}, surface:{sigmaNm:2}, medium:{particleUm:1.0, nParticle:1.33, density:0 /* /mm³ 霧オフ*/}}`

- [ ] **Step 1: 失敗するテスト**

```js
test('Rayleigh cross-section scales as lambda^-4', ...); // σ(0.45)/σ(0.62) = (0.62/0.45)^4
test('Rayleigh phase forward/backward symmetric', ...);
test('Mie: x→0 approaches Rayleigh Qsca', ...);   // x=0.01, m=1.33, 1% 以内
test('Mie: matches reference x=1, m=1.5', ...); // 期待値は実装時に miepython (pip, MIT) で算出しテストに固定値として記入, 1e-4
test('Mie: large x has g > 0.7 (forward dominant)', ...);
test('Mie: Qext → 2 for large x', ...);            // x=200
test('HG integrates to 1 and mean cos = g', ...);
test('surface TIS formula', ...);
test('Raman 520nm with 465cm-1 → stokes ≈ 0.5328 µm', ...);
test('anti-Stokes weaker than Stokes at room temperature', ...);
```

- [ ] **Step 2–4: FAIL → 実装 → PASS**
- [ ] **Step 5: Commit** `feat: Rayleigh, Mie, HG, surface scatter and Raman models`

---

### Task 9: 散乱の結像への反映

**Files:** Create `src/core/stray.js`, `test/stray.test.js`

**Interfaces:**
- Consumes: `traceRay`, `scatter.js`, `fresnel.js`, `formImage`, `ghostImage`
- Produces:
  - `strayLight(sys, objectImg, scatterCfg, opts:{rays=20000, seed=1}) -> {image:Float32Array(P*P*3), raman:{stokes:Float32Array, antiStokes:Float32Array, wavelengths:{…}}, budget:{transmitted, ghost, glassScatter, surfaceScatter, mediumScatter, backscatter}}` — モンテカルロ: 物体輝度に比例して光線を発生し、(1) 各ガラス区間で距離 × 散乱係数による確率で散乱(位相関数 HG/Rayleigh)、ラマン確率で波長変換、(2) 各面で TIS の確率で散乱(Lambert 近似の角度分布)、(3) 空間区間で粒子密度 × Mie Csca で散乱(Mie S11 を表引きでサンプル)。後方へ散乱した光線は `budget.backscatter` に計上。スクリーン到達光線をビン詰め。シード付き乱数 (mulberry32) で再現性を持たせる。
  - `composeImage(direct, ghost, stray, weights) -> Float32Array`(0..1 クランプ、トーンマップは線形)

- [ ] **Step 1: 失敗するテスト**

```js
test('zero scatter coefficients → stray image all zero', ...);
test('energy budget sums to ~1 (±2%)', ...);
test('fog density increases veil and backscatter', ...);
test('Raman image is produced at stokes wavelength', ...);
test('same seed gives identical result', ...);
```

- [ ] **Step 2–4: FAIL → 実装 → PASS**
- [ ] **Step 5: Commit** `feat: stray light Monte Carlo with ghosts, scatter and Raman`

---

### Task 10: UI

**Files:** Create `src/ui/editor.js`, `src/ui/layout-view.js`, `src/ui/image-view.js`, `src/ui/analysis-view.js`; Modify `src/ui/main.js`, `src/index.html`, `src/styles.css`; Create `test/image-view.test.js`(縮小関数のみ)

**Interfaces:**
- Consumes: core 全モジュール
- Produces(画面構成):
  - 左: レンズデータエディタ(列: 種別 / 曲率半径(`inf` 入力可)/ 厚み / 材質(プリセット選択 or 「カスタム」で nd・vd 入力)/ 直径)。行の追加・削除・上下移動。不正セルは赤枠 + ツールチップ(`validateSystem` の message)、計算は直前の有効状態を保持。
  - 中央上: 断面図 Canvas(面の形状、3 波長の光線、物体高 0/0.7/1.0 の 3 視野 × 7 本、ゴーストの表示切替)。マウスホイールで拡大、ドラッグで移動。
  - 中央下: 物体画像と結像画像を並べて表示。パターン選択 + 画像ファイル読込(`<input type=file>`)。直接光 / ゴースト / 散乱 / ラマン の表示切替チェックボックス。
  - 右: タブ — 「色収差」(縦・倍率の数値と波長別像位置)/「ゼルニケ」(視野・波長選択、係数表と棒グラフ uPlot、RMS/PV)/「散乱」(公式ごとのパネル: Rayleigh, Mie, HG, 表面 TIS, Raman — 入力欄と角度分布の極座標/直交グラフ、前方/後方比)/「設定」(散乱係数・霧密度・光線数)。
  - `downscaleImage(imageData, max=512) -> {data:Float32Array, size}`(アスペクト維持で正方形にパディング)
  - 再計算は入力から 200 ms デバウンス。重い計算(結像・迷光)は「結像を計算」ボタンで実行し、実行中は進捗表示。

- [ ] **Step 1: `downscaleImage` のテスト** — 4000×3000 入力 → size ≤ 512、アスペクト維持。FAIL を確認後に実装 → PASS
- [ ] **Step 2: エディタ・断面図・画像表示・解析パネルを実装**
- [ ] **Step 3: `npm run build` → 内蔵ブラウザで `dist/optraining.html` を開き、コンソールエラー 0 を確認**
- [ ] **Step 4: Commit** `feat: UI (editor, layout, imaging, analysis panels)`

---

### Task 11: 受け入れ確認とリリース

**Files:** Create `README.md`(使い方・物理モデルと規約・ガラスデータ出典/ライセンス); Modify 設計書の状態を「実装済み」に

- [ ] **Step 1: ブラウザで受け入れ基準(設計書 §8)を順に確認し、各結果のスクリーンショットを取る**
  - BK7 平凸の焦点距離が理論値と一致
  - 単レンズで球面収差・色収差が表示される
  - 全波長同一屈折率で色収差 0
  - アイリスを絞ると断面図・結像画像が変化
  - 画像読込で倒立像
  - Review Focus 1–5 の各入力で破綻しない
- [ ] **Step 2: `npm test` 全 PASS、`npm run build` 成功**
- [ ] **Step 3: Commit & push** `docs: README; build dist/optraining.html` → `git push`
