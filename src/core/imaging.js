// 物体パターン → スクリーン上の結像画像
// 物体: 物体面上の一辺 2h の正方形(h = sys.object.height)、行 0 = +y。
// スクリーン: 一辺 sys.screen.width、P×P 画素、行 0 = +y。
// 照度モデル: E = L · V(r) · cos⁴θ · J(r) · (NA/NA_REF)²
//   V: ケラレ(瞳光線の生存率), θ: 物体側主光線角, J: 歪曲による面積比(中心で 1), NA: 像側近軸 NA。
//   T: 各面のフレネル透過率の積(無コート、主光線で評価)。NA_REF = 0.1(F/5 相当)で露出 1。
import { surfaceZ } from './system.js';
import { aimRay, traceRay, findStop, fanRays } from './trace.js';
import { ynuTrace } from './ynu.js';
import { wavefront } from './wavefront.js';
import { psf } from './psf.js';
import { fft2d, nextPow2 } from './fft.js';
import { fresnelT } from './fresnel.js';

export const NA_REF = 0.1;
const MAX_KERNEL = 513; // PSF カーネルの最大画素数(一辺)
const MAX_MARGIN = 192; // 幾何像の余白(画素)
const MSG_BLACK = '像が形成されません(光線が遮蔽されています)';

/** 波長 → RGB チャネル(最も近い代表波長: B 0.45, G 0.52, R 0.62) */
export function channelOf(lambda) {
  const ref = [0.62, 0.52, 0.45];
  let best = 0;
  ref.forEach((l, i) => { if (Math.abs(lambda - l) < Math.abs(lambda - ref[best])) best = i; });
  return best; // 0=R,1=G,2=B
}

function lastPowerSurface(sys) {
  for (let i = sys.surfaces.length - 2; i >= 1; i--) if (sys.surfaces[i].kind === 'surface') return i;
  return sys.surfaces.length - 2;
}

/** 像側近軸 NA(軸上物点、絞り縁を通る近軸光線) */
export function imageNA(sys, lambda) {
  const stop = findStop(sys, lambda);
  const B = ynuTrace(sys, lambda, 0, 1).y[stop];
  const u0 = sys.surfaces[stop].diameter / 2 / B;
  const k = lastPowerSurface(sys);
  const u = Math.abs(ynuTrace(sys, lambda, 0, u0).u[k]);
  return u / Math.sqrt(1 + u * u);
}

/** 半径方向の写像表: r_obj → 主光線像高 g(符号付き)・照度係数 W */
export function radialMap(sys, lambda, K = 33, opts = {}) {
  const h = sys.object.height;
  const rMax = Math.max(h * Math.SQRT2, 1e-6);
  const stop = findStop(sys, lambda);
  const r = [], g = [], V = [], c4 = [], T = [];
  const fres = opts.fresnel === false ? undefined : fresnelT;
  for (let k = 0; k < K; k++) {
    const ro = (rMax * k) / (K - 1);
    const obj = [0, ro, 0];
    const chief = aimRay(sys, obj, lambda, 0, 0, stop);
    const t = traceRay(sys, chief, { ignoreApertures: true, fresnel: fres });
    T.push(t.alive ? t.final.intensity : 0);
    const gy = t.alive ? t.points[t.points.length - 1][1] : NaN;
    const fan = fanRays(sys, obj, lambda, 8);
    const alive = fan.filter((f) => traceRay(sys, f).alive).length;
    r.push(ro); g.push(gy); V.push(fan.length ? alive / fan.length : 0); c4.push(chief.d[2] ** 4);
  }
  // 中心の倍率(微小物体高)
  const eps = rMax * 1e-4;
  const t0 = traceRay(sys, aimRay(sys, [0, eps, 0], lambda, 0, 0, stop), { ignoreApertures: true });
  const m0 = t0.alive ? t0.points[t0.points.length - 1][1] / eps : NaN;
  const J = r.map((ro, k) => {
    if (k === 0) return 1;
    const k0 = Math.max(0, k - 1), k1 = Math.min(K - 1, k + 1);
    const dg = Math.abs(g[k1]) - Math.abs(g[k0]), dr = r[k1] - r[k0];
    const ratio = (ro / Math.abs(g[k])) * (dr / dg) * m0 * m0;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  });
  const exp = (imageNA(sys, lambda) / NA_REF) ** 2;
  const W = r.map((_, k) => (Number.isFinite(g[k]) ? V[k] * c4[k] * J[k] * T[k] * exp : 0));
  return { r, g, W, V, T, m0, rMax, exposure: exp };
}

function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) {
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + t * (ys[i] - ys[i - 1]);
  }
  return NaN;
}

/** 像点 (X,Y) → 物体点 (x,y)。範囲外は null */
function inverseMap(map, X, Y) {
  const R = Math.hypot(X, Y);
  if (R === 0) return [0, 0, 0];
  const absg = map.g.map(Math.abs);
  // |g| が単調増加の区間で逆補間
  let k = 1;
  while (k < absg.length && Number.isFinite(absg[k]) && absg[k] < R) {
    if (absg[k] < absg[k - 1]) return null;
    k++;
  }
  if (k >= absg.length || !Number.isFinite(absg[k])) return null;
  const t = (R - absg[k - 1]) / (absg[k] - absg[k - 1]);
  const ro = map.r[k - 1] + t * (map.r[k] - map.r[k - 1]);
  const s = Math.sign(map.m0) || -1; // 倒立なら −1
  return [(s * X * ro) / R, (s * Y * ro) / R, ro];
}

function sampleBilinear(img, ch, u, v) {
  const n = img.size;
  if (u < -0.5 || v < -0.5 || u > n - 0.5 || v > n - 0.5) return 0;
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(u))), y0 = Math.max(0, Math.min(n - 1, Math.floor(v)));
  const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, u - x0)), ay = Math.max(0, Math.min(1, v - y0));
  const p = (x, y) => img.data[(y * n + x) * 3 + ch];
  return (1 - ay) * ((1 - ax) * p(x0, y0) + ax * p(x1, y0)) + ay * ((1 - ax) * p(x0, y1) + ax * p(x1, y1));
}

/**
 * 幾何像(PSF なし): Float64Array(Pe*Pe)、Pe = P + 2·margin。
 * margin はスクリーン外側の余白画素(PSF の裾でスクリーン内に入り込む光のため)。
 */
export function geometricImage(sys, objectImg, lambda, map = radialMap(sys, lambda), margin = 0) {
  const P = sys.screen.pixels, w = sys.screen.width, pitch = w / P, h = sys.object.height;
  const Pe = P + 2 * margin;
  const out = new Float64Array(Pe * Pe);
  const ch = channelOf(lambda);
  for (let iy = 0; iy < Pe; iy++) for (let ix = 0; ix < Pe; ix++) {
    const X = (ix - margin + 0.5) * pitch - w / 2, Y = w / 2 - (iy - margin + 0.5) * pitch;
    const o = inverseMap(map, X, Y);
    if (!o) continue;
    const Wt = interp(map.r, map.W, o[2]);
    if (!(Wt > 0)) continue;
    const u = ((o[0] + h) / (2 * h)) * objectImg.size - 0.5, v = ((h - o[1]) / (2 * h)) * objectImg.size - 0.5;
    out[iy * Pe + ix] = sampleBilinear(objectImg, ch, u, v) * Wt;
  }
  return out;
}

/** img (P×P) を kernel (m×m, 中心 (m−1)/2) で畳み込んだ FFT 結果の準備 */
function kernelFFT(k, m, N) {
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  const h = (m - 1) / 2;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++)
    re[((y - h + N) % N) * N + ((x - h + N) % N)] += k[y * m + x];
  fft2d(re, im, N);
  return [re, im];
}

/**
 * 余白付き幾何像 geo (Pe×Pe, 余白 mg) を、G×G パッチの PSF で畳み込み、双線形の重みで混ぜる。
 * 各パッチは重みが正になる領域だけをタイル FFT で計算する。返り値 Float64Array(P*P)。
 */
function convolvePatched(geo, Pe, mg, kernels, P, G) {
  const acc = new Float64Array(P * P);
  const cell = P / G;
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const kk = kernels[gy * G + gx];
    const hm = (kk.m - 1) / 2;
    const y0 = G === 1 ? 0 : Math.max(0, Math.floor((gy - 0.5) * cell)), y1 = G === 1 ? P : Math.min(P, Math.ceil((gy + 1.5) * cell));
    const x0 = G === 1 ? 0 : Math.max(0, Math.floor((gx - 0.5) * cell)), x1 = G === 1 ? P : Math.min(P, Math.ceil((gx + 1.5) * cell));
    const tx0 = Math.max(0, x0 + mg - hm), ty0 = Math.max(0, y0 + mg - hm), tx1 = Math.min(Pe, x1 + mg + hm), ty1 = Math.min(Pe, y1 + mg + hm);
    const tw = tx1 - tx0, th = ty1 - ty0;
    const N = nextPow2(Math.max(tw, th) + kk.m);
    const re = new Float64Array(N * N), im = new Float64Array(N * N);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) re[y * N + x] = geo[(y + ty0) * Pe + x + tx0];
    fft2d(re, im, N);
    const [kr, ki] = kernelFFT(kk.data, kk.m, N);
    for (let i = 0; i < N * N; i++) { const a = re[i], b = im[i]; re[i] = a * kr[i] - b * ki[i]; im[i] = a * ki[i] + b * kr[i]; }
    fft2d(re, im, N, true);
    for (let y = y0; y < y1; y++) {
      const fy = Math.max(0, Math.min(G - 1, (y + 0.5) / cell - 0.5));
      const wy = G === 1 ? 1 : Math.max(0, 1 - Math.abs(fy - gy));
      if (!wy) continue;
      for (let x = x0; x < x1; x++) {
        const fx = Math.max(0, Math.min(G - 1, (x + 0.5) / cell - 0.5));
        const wx = G === 1 ? 1 : Math.max(0, 1 - Math.abs(fx - gx));
        if (wx) acc[y * P + x] += wx * wy * re[(y + mg - ty0) * N + (x + mg - tx0)];
      }
    }
  }
  return acc;
}

const COARSE_LIMIT = 129; // これより大きい PSF は粗い格子で畳み込む(大きなボケに細部はない)

/**
 * 結像画像。opts: {fieldGrid=3, nPupil=24, fresnel=true, onProgress(frac)}
 * 返り値: {data: Float32Array(P*P*3), P, peak, psfs, message?}
 */
export function formImage(sys, objectImg, opts = {}) {
  const G = opts.fieldGrid ?? 3, nPupil = opts.nPupil ?? 24;
  const P = sys.screen.pixels, w = sys.screen.width, pitch = w / P;
  const out = new Float32Array(P * P * 3);
  const psfs = [];
  const steps = sys.wavelengths.length * G * G;
  let step = 0;
  for (const lambda of sys.wavelengths) {
    const ch = channelOf(lambda);
    const map = radialMap(sys, lambda, 33, { fresnel: opts.fresnel });
    if (!map.W.some((v) => v > 0)) { step += G * G; continue; } // 全遮蔽
    // パッチ中心の波面
    const wfs = [];
    for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
      const X = -w / 2 + ((gx + 0.5) * w) / G, Y = w / 2 - ((gy + 0.5) * w) / G;
      let o = inverseMap(map, X, Y);
      if (!o) { // 視野外 → 最大視野へクランプ
        const R = Math.hypot(X, Y) || 1, s = Math.sign(map.m0) || -1;
        o = [(s * X * map.rMax) / R, (s * Y * map.rMax) / R, map.rMax];
      }
      wfs.push({ wf: wavefront(sys, [o[0], o[1], 0], lambda, nPupil), gx, gy, o });
      opts.onProgress?.(++step / steps);
    }
    const kernelsAt = (px, maxM) => wfs.map(({ wf }) => (wf.chief ? psf(wf, lambda, wf.pupilDiamMm, wf.chief.Rref, px, { maxM }) : null));
    // 実光線スポットの広がりから PSF の大きさを見積もり、粗い格子を使うか先に決める
    const spotPx = Math.max(1, ...wfs.map(({ wf }) => {
      let r = 0; for (const [x, y] of wf.spots ?? []) r = Math.max(r, Math.hypot(x, y));
      return Math.min(MAX_KERNEL, 2 * Math.ceil(r / pitch) + 3);
    }));
    const delta = { data: Float32Array.of(1), m: 1 };
    let ps;
    const record = () => wfs.forEach(({ wf, gx, gy, o }, i) => psfs.push({ lambda, gx, gy, obj: [o[0], o[1]], psf: ps[i], rmsWaves: wf.rmsWaves }));
    if (spotPx <= COARSE_LIMIT) {
      ps = kernelsAt(pitch, Math.min(MAX_KERNEL, 2 * P + 1));
      record();
      const maxM = Math.max(...ps.map((p) => p?.m ?? 1));
      const kernels = ps.map((p) => p ?? delta);
      const mg = Math.min(MAX_MARGIN, (maxM - 1) / 2);
      const geo = geometricImage(sys, objectImg, lambda, map, mg);
      const acc = convolvePatched(geo, P + 2 * mg, mg, kernels, P, G);
      for (let i = 0; i < P * P; i++) out[i * 3 + ch] += Math.max(0, acc[i]);
    } else {
      // 粗い格子: 画素を s 倍にして畳み込み、双線形補間で元の格子へ戻す
      const s = Math.ceil(spotPx / COARSE_LIMIT);
      const Pc = Math.ceil(P / s), pc = pitch * s, wc = Pc * pc;
      ps = kernelsAt(pc, Math.min(COARSE_LIMIT + 4, 2 * Pc + 1));
      record();
      const kernels = ps.map((p) => p ?? delta);
      const mg = Math.min(MAX_MARGIN, Math.max(...kernels.map((k) => (k.m - 1) / 2)));
      // 粗い格子の幾何像は細かい格子で求めてから箱平均(細部のエネルギーを保存)
      const fineMg = mg * s + Math.ceil((wc - w) / pitch / 2);
      const geoF = geometricImage({ ...sys, screen: { width: w, pixels: P } }, objectImg, lambda, map, fineMg);
      const PeF = P + 2 * fineMg, Pe = Pc + 2 * mg;
      const geo = new Float64Array(Pe * Pe);
      const off = fineMg - mg * s - Math.round((wc - w) / pitch / 2); // 粗格子の原点に対応する細格子位置
      for (let y = 0; y < Pe; y++) for (let x = 0; x < Pe; x++) {
        let sum = 0;
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
          const fy = off + y * s + dy, fx = off + x * s + dx;
          if (fy >= 0 && fx >= 0 && fy < PeF && fx < PeF) sum += geoF[fy * PeF + fx];
        }
        geo[y * Pe + x] = sum / (s * s);
      }
      const acc = convolvePatched(geo, Pe, mg, kernels, Pc, G);
      for (let iy = 0; iy < P; iy++) for (let ix = 0; ix < P; ix++) {
        const X = (ix + 0.5) * pitch - w / 2, Y = w / 2 - (iy + 0.5) * pitch;
        const u = (X + wc / 2) / pc - 0.5, v = (wc / 2 - Y) / pc - 0.5;
        const x0 = Math.max(0, Math.min(Pc - 1, Math.floor(u))), y0 = Math.max(0, Math.min(Pc - 1, Math.floor(v)));
        const x1 = Math.min(Pc - 1, x0 + 1), y1 = Math.min(Pc - 1, y0 + 1);
        const ax = Math.max(0, Math.min(1, u - x0)), ay = Math.max(0, Math.min(1, v - y0));
        const val = (1 - ay) * ((1 - ax) * acc[y0 * Pc + x0] + ax * acc[y0 * Pc + x1]) + ay * ((1 - ax) * acc[y1 * Pc + x0] + ax * acc[y1 * Pc + x1]);
        out[(iy * P + ix) * 3 + ch] += Math.max(0, val);
      }
    }
  }
  let peak = 0, bad = false;
  for (const v of out) { if (!Number.isFinite(v)) bad = true; else if (v > peak) peak = v; }
  if (bad || peak < 1e-9) return { data: new Float32Array(P * P * 3), P, peak: 0, psfs, message: MSG_BLACK };
  return { data: out, P, peak, psfs };
}
