// PSF 計算
// 返す PSF カーネルの向き: data[iy*m + ix]、ix 増加 = +x、iy 増加 = −y(画像と同じく行 0 が上 = +y)。
// 中心 ((m−1)/2, (m−1)/2) が主光線像点(参照球中心)。総和 1 に正規化。
// 方式:
//   1) 回折: 波面をゼルニケ 37 項でフィットし、位相の段差が 1 サンプル 0.25 波以下になる細かさ(≤256)で
//      瞳を再サンプル → ゼロパディング FFT → |·|²。
//   2) それでも足りないほど収差が大きい場合は幾何スポット(光線のスクリーン交点ヒストグラム)を
//      回折限界 PSF で畳み込む(幾何光学極限)。
import { fft2d, nextPow2 } from './fft.js';
import { fitZernike, zernikeAll, gridCoord } from './wavefront.js';

function finiteCount(grid) { let c = 0; for (const v of grid) if (Number.isFinite(v)) c++; return c; }

const ZB = new Float64Array(37);
function evalZ(coef, x, y) {
  zernikeAll(coef.length, Math.hypot(x, y), Math.atan2(y, x), ZB);
  let s = 0;
  for (let j = 0; j < coef.length; j++) s += coef[j] * ZB[j];
  return s;
}

/** 回折 PSF を細かい像面格子で計算: {I: Float64Array(N*N)(中心 N/2), N, ds} */
function diffractionFine(grid, n, coef, nf, lambdaMm, D, R) {
  const N = nf <= 64 ? 4 * nf : 2 * nf;
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  const off = (N - nf) / 2;
  for (let iy = 0; iy < nf; iy++) for (let ix = 0; ix < nf; ix++) {
    const [x, y] = gridCoord(ix, iy, nf);
    if (x * x + y * y > 1) continue;
    const cx = Math.min(n - 1, Math.floor(((x + 1) / 2) * n)), cy = Math.min(n - 1, Math.floor(((y + 1) / 2) * n));
    if (!Number.isFinite(grid[cy * n + cx])) continue;
    const ph = 2 * Math.PI * (coef ? evalZ(coef, x, y) : 0);
    // 行 = −y 向き(画像の向き)に置く
    const k = (off + (nf - 1 - iy)) * N + off + ix;
    re[k] = Math.cos(ph); im[k] = Math.sin(ph);
  }
  fft2d(re, im, N);
  const I = new Float64Array(N * N);
  const h = N / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x;
    I[((y + h) % N) * N + ((x + h) % N)] = re[k] * re[k] + im[k] * im[k];
  }
  const dx = D / nf;
  return { I, N, ds: (lambdaMm * R) / (N * dx) };
}

/** 細かい格子 PSF を画素ピッチ pixelMm の m×m に変換 */
function resample(fine, pixelMm, maxM) {
  const { I, N, ds } = fine;
  const halfExt = Math.min((N / 2) * ds * 0.95, ((maxM - 1) / 2 + 0.5) * pixelMm);
  const hm = Math.max(0, Math.floor(halfExt / pixelMm));
  const m = 2 * hm + 1;
  const out = new Float64Array(m * m);
  const c = N / 2;
  if (pixelMm >= 2 * ds) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const ox = Math.round(((x - c) * ds) / pixelMm) + hm, oy = Math.round(((y - c) * ds) / pixelMm) + hm;
      if (ox >= 0 && oy >= 0 && ox < m && oy < m) out[oy * m + ox] += I[y * N + x];
    }
  } else {
    for (let oy = 0; oy < m; oy++) for (let ox = 0; ox < m; ox++) {
      const fx = ((ox - hm) * pixelMm) / ds + c, fy = ((oy - hm) * pixelMm) / ds + c;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= N || y0 + 1 >= N) continue;
      out[oy * m + ox] = (1 - ay) * ((1 - ax) * I[y0 * N + x0] + ax * I[y0 * N + x0 + 1]) + ay * ((1 - ax) * I[(y0 + 1) * N + x0] + ax * I[(y0 + 1) * N + x0 + 1]);
    }
  }
  return { out, m };
}

function normalize(a) {
  let s = 0; for (const v of a) s += v;
  const f = new Float32Array(a.length);
  if (s > 0) for (let i = 0; i < a.length; i++) f[i] = a[i] / s;
  return f;
}

/** 波面の最大勾配 [waves / 規格化瞳半径] */
function maxSlope(coef, grid, n) {
  let mx = 0;
  const h = 1e-3;
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    if (!Number.isFinite(grid[iy * n + ix])) continue;
    const [x, y] = gridCoord(ix, iy, n);
    const gx = (evalZ(coef, x + h, y) - evalZ(coef, x - h, y)) / (2 * h);
    const gy = (evalZ(coef, x, y + h) - evalZ(coef, x, y - h)) / (2 * h);
    mx = Math.max(mx, Math.hypot(gx, gy));
  }
  return mx;
}

function convolve2(a, ma, b, mb) {
  const m = ma + mb - 1, out = new Float64Array(m * m);
  for (let ay = 0; ay < ma; ay++) for (let ax = 0; ax < ma; ax++) {
    const v = a[ay * ma + ax]; if (!v) continue;
    for (let by = 0; by < mb; by++) for (let bx = 0; bx < mb; bx++) out[(ay + by) * m + ax + bx] += v * b[by * mb + bx];
  }
  return { out, m };
}

/**
 * @param wf wavefront() の結果({grid, n, spots})
 * @returns {data: Float32Array(m*m), m, pixelMm, mode} | null(光線なし)
 */
export function psf(wf, lambda, pupilDiamMm, imageDistMm, pixelMm, opts = {}) {
  const maxM = opts.maxM ?? 129;
  if (!wf || !wf.grid || finiteCount(wf.grid) < 8 || !(pupilDiamMm > 0) || !(imageDistMm > 0)) return null;
  const lambdaMm = lambda * 1e-3;
  const coef = fitZernike(wf.grid, wf.n, 37);
  const slope = maxSlope(coef, wf.grid, wf.n);
  const need = 8 * slope;
  if (need <= 256 || !wf.spots?.length) {
    const nf = Math.min(256, nextPow2(Math.max(64, Math.ceil(need))));
    const { out, m } = resample(diffractionFine(wf.grid, wf.n, coef, nf, lambdaMm, pupilDiamMm, imageDistMm), pixelMm, maxM);
    return { data: normalize(out), m, pixelMm, mode: 'diffraction' };
  }
  // 幾何スポット + 回折限界
  let rmax = 0;
  for (const [x, y] of wf.spots) rmax = Math.max(rmax, Math.hypot(x, y));
  const hg = Math.min((maxM - 1) / 2, Math.ceil(rmax / pixelMm) + 1);
  const mg = 2 * hg + 1;
  const hist = new Float64Array(mg * mg);
  for (const [x, y] of wf.spots) {
    const ox = Math.round(x / pixelMm) + hg, oy = Math.round(-y / pixelMm) + hg;
    if (ox >= 0 && oy >= 0 && ox < mg && oy < mg) hist[oy * mg + ox] += 1;
  }
  const airy = resample(diffractionFine(wf.grid, wf.n, null, 64, lambdaMm, pupilDiamMm, imageDistMm), pixelMm, 31);
  let { out, m } = convolve2(hist, mg, airy.out, airy.m);
  if (m > maxM) { // 中央を切り出し
    const c = (m - maxM) / 2, cut = new Float64Array(maxM * maxM);
    for (let y = 0; y < maxM; y++) for (let x = 0; x < maxM; x++) cut[y * maxM + x] = out[(y + c) * m + x + c];
    out = cut; m = maxM;
  }
  return { data: normalize(out), m, pixelMm, mode: 'geometric' };
}

/** PSF 重心 [mm](+x, +y) */
export function psfCentroid(p) {
  const h = (p.m - 1) / 2;
  let sx = 0, sy = 0, s = 0;
  for (let y = 0; y < p.m; y++) for (let x = 0; x < p.m; x++) {
    const v = p.data[y * p.m + x]; s += v; sx += v * (x - h); sy += v * (h - y);
  }
  return [(sx / s) * p.pixelMm, (sy / s) * p.pixelMm];
}
