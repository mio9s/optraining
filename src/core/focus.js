// 屈折力(ジオプター)・焦点位置と、最良像面(結像性が最もよいスクリーン位置)の探索
import { ynuTrace } from './ynu.js';
import { surfaceZ } from './system.js';
import { paraxialTrace } from './paraxial.js';
import { fanRays, traceRay, findStop } from './trace.js';
import { LINES } from './glass.js';

function lastPowerSurface(sys) {
  for (let i = sys.surfaces.length - 2; i >= 1; i--) if (sys.surfaces[i].kind === 'surface') return i;
  return 1;
}
function firstPowerSurface(sys) {
  for (let i = 1; i < sys.surfaces.length - 1; i++) if (sys.surfaces[i].kind === 'surface') return i;
  return 1;
}

/**
 * 屈折力と焦点位置(近軸、波長 λ µm、既定 d 線)。長さは mm、屈折力は D(1/m)。
 * - power: 系の屈折力 1000/f'
 * - bvp: 後方頂点屈折力 1000/BFL(眼鏡のレンズメーターで測る値)
 * - fvp: 前方頂点屈折力 1000/FFL
 * - rearFocusZ / frontFocusZ: 後側・前側焦点の位置(物体面 z = 0 基準)
 * - imageZ: いまの物体距離での近軸像の位置、imageDistance: 最終面から像までの距離
 */
export function powerSummary(sys, lambda = LINES.d) {
  const z = surfaceZ(sys);
  const k = lastPowerSurface(sys), f1 = firstPowerSurface(sys);
  const p = paraxialTrace(sys, lambda);
  const efl = p.efl;
  const power = 1000 / efl;
  const bfl = p.bfl;
  // 前側焦点: 出口で光軸に平行になる光線が入射側で光軸を横切る点。
  // 第 1 面の手前の基準面 Q(面 f1−1)から 2 本の近軸光線 (y=1,u=0)・(y=0,u=1) を出し、出口角 u' が線形なことを使う:
  // 基準面の手前 s で光軸を通る光線は Q で y = s·u → u' = s·u·ua + u·ub = 0 → s = −ub/ua
  const a = ynuTrace(sys, lambda, 1, 0, f1 - 1), b = ynuTrace(sys, lambda, 0, 1, f1 - 1);
  const sQ = -b.u[k] / a.u[k];
  const frontFocusZ = z[f1 - 1] - sQ;
  const ffl = z[f1] - frontFocusZ;
  const gapBefore = sys.surfaces[f1 - 1].thickness;
  const zFirst = z[f1], zLast = z[k];
  return {
    lambda, efl, power, bfl, bvp: 1000 / bfl, ffl, fvp: 1000 / ffl,
    rearFocusZ: zLast + bfl, frontFocusZ,
    imageZ: p.imageZ, imageDistance: p.imageZ - zLast, magnification: p.magnification,
    objectDistance: zFirst, gapBefore, lastSurface: k,
  };
}

// 明所視の視感度 V(λ)(CIE 1924 の表から線形補間)。最良像面の波長の重みに使う
const V_TABLE = [[400, 0.0004], [420, 0.004], [440, 0.023], [450, 0.038], [460, 0.06], [480, 0.139], [500, 0.323], [510, 0.503], [520, 0.71], [530, 0.862], [550, 0.995], [555, 1], [570, 0.952], [590, 0.757], [600, 0.631], [620, 0.381], [640, 0.175], [660, 0.061], [680, 0.017], [700, 0.0041]];
export function photopic(nm) {
  if (nm <= V_TABLE[0][0]) return V_TABLE[0][1];
  for (let i = 1; i < V_TABLE.length; i++) if (nm <= V_TABLE[i][0]) {
    const [x0, y0] = V_TABLE[i - 1], [x1, y1] = V_TABLE[i];
    return y0 + ((nm - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 0;
}

/**
 * 最良像面: スクリーン位置(最終面からの距離)を動かし、視感度で重み付けした多色の RMS スポット半径を
 * 視野(0 / 70 / 100 %、重み 1 / 1 / 0.5)で合計した値が最小になる位置を探す。
 * 光線は最終面まで 1 度だけ追跡し、スクリーン位置ごとの交点は直線の式で求める(高速)。
 * opts: {fields, fieldWeights, nPupil, wavelengths}
 * 返り値: {distance(最終面からスクリーンまで), z, rms(合計の指標 mm), perField[{field, rms}], curve:[{distance, rms}], paraxial}
 */
export function bestImagePlane(sys, opts = {}) {
  const fields = opts.fields ?? [0, 0.7, 1];
  const fw = opts.fieldWeights ?? [1, 1, 0.5];
  const nPupil = opts.nPupil ?? 12;
  const W = opts.wavelengths ?? sys.wavelengths;
  const S = sys.surfaces, k = S.length - 2;
  const z = surfaceZ(sys);
  const zk = z[k];
  // 各視野・各波長の光線の、最終面(スクリーン直前の面)を出た位置と方向
  const bundles = fields.map((f) => {
    const rays = [];
    for (const lam of W) {
      const wgt = photopic(lam * 1000);
      for (const r of fanRays(sys, [0, f * sys.object.height, 0], lam, nPupil)) {
        const t = traceRay(sys, r, { toSurface: k });
        if (!t.alive) continue;
        rays.push({ p: t.final.p, d: t.final.d, w: wgt });
      }
    }
    return rays;
  });
  const rmsAt = (dist) => {
    const zs = zk + dist;
    let tot = 0, used = 0;
    const per = bundles.map((rays, i) => {
      let sw = 0, sx = 0, sy = 0;
      const pts = [];
      for (const r of rays) {
        if (r.d[2] <= 0) continue;
        const t = (zs - r.p[2]) / r.d[2];
        const x = r.p[0] + t * r.d[0], y = r.p[1] + t * r.d[1];
        pts.push([x, y, r.w]); sw += r.w; sx += r.w * x; sy += r.w * y;
      }
      if (!sw) return { field: fields[i], rms: NaN };
      const cx = sx / sw, cy = sy / sw;
      let s2 = 0;
      for (const [x, y, w] of pts) s2 += w * ((x - cx) ** 2 + (y - cy) ** 2);
      const rms = Math.sqrt(s2 / sw);
      tot += fw[i] * rms * rms; used += fw[i];
      return { field: fields[i], rms };
    });
    // 光線が 1 本も通らない視野は除き、どの視野も通らなければ評価不能(∞)
    return { rms: used > 0 ? Math.sqrt(tot / used) : Infinity, per };
  };
  // 探索範囲: 各波長の近軸像位置の前後
  const parax = W.map((l) => paraxialTrace(sys, l).imageZ - zk).filter(Number.isFinite);
  // 像が最終面より手前(虚像)、または無限遠: スクリーンには結像しない(平行平板・発散系など)
  if (!parax.length || Math.max(...parax) <= 1e-3) return { ok: false, message: '近軸の像が最終面より手前の虚像か無限遠にできるため、スクリーン上に結像しません(屈折力がほぼ 0 の平行平板や発散系)。物体を見る用途なら、像のずれは「焦点・屈折力」の数値で確認してください', curve: [], lastSurface: k, paraxialDistance: parax[0], currentDistance: S[k].thickness };
  let lo = Math.min(...parax), hi = Math.max(...parax);
  const span = Math.max(hi - lo, 0.05 * Math.abs((lo + hi) / 2), 1);
  lo -= span; hi += span;
  lo = Math.max(lo, 1e-3);
  // 粗い走査 → 黄金分割で詰める
  const N = 81, curve = [];
  let bi = 0;
  for (let i = 0; i < N; i++) {
    const d = lo + ((hi - lo) * i) / (N - 1);
    const r = rmsAt(d).rms;
    curve.push({ distance: d, rms: r });
    if (!(r >= curve[bi].rms)) bi = i;
  }
  let a = curve[Math.max(0, bi - 1)].distance, b = curve[Math.min(N - 1, bi + 1)].distance;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = rmsAt(c).rms, fd = rmsAt(d).rms;
  for (let it = 0; it < 60 && b - a > 1e-6; it++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = rmsAt(c).rms; }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = rmsAt(d).rms; }
  }
  const best = (a + b) / 2;
  const r = rmsAt(best);
  if (!Number.isFinite(r.rms)) return { ok: false, message: '光線がスクリーンに届かないため最良像面を求められません(遮蔽を確認してください)', curve, lastSurface: k, paraxialDistance: parax[0], currentDistance: S[k].thickness };
  const p520 = paraxialTrace(sys, sys.wavelengths[Math.floor(sys.wavelengths.length / 2)] ?? 0.52).imageZ - zk;
  return { ok: true, distance: best, z: zk + best, rms: r.rms, perField: r.per, curve, paraxialDistance: p520, rmsAtParaxial: rmsAt(p520).rms, rmsAtCurrent: rmsAt(S[k].thickness).rms, currentDistance: S[k].thickness, lastSurface: k };
}

/** スクリーンを最良像面へ移した系 */
export function focusBest(sys, opts) {
  const b = bestImagePlane(sys, opts);
  if (!b.ok) return { system: sys, result: b };
  const s = structuredClone(sys);
  s.surfaces[b.lastSurface].thickness = Math.round(b.distance * 1e4) / 1e4;
  return { system: s, result: b };
}
