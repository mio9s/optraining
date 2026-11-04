// 3D 実光線追跡
import { add, scale, dot, normalize, sub } from './vec.js';
import { refractiveIndex } from './glass.js';
import { surfaceZ, mediumAfter } from './system.js';
import { ynuTrace, indicesAt } from './ynu.js';

const EPS_T = -1e-6;

/**
 * 頂点 z=zVertex、曲率半径 radius の球面(Infinity は平面)と光線 p + t d の交点パラメータ t。
 * 球は 2 点で交わるので、頂点側の半球(cv·(z − zVertex) < 1、レンズ面として使う側)にあり、
 * かつ前方 (t > −1e-9) にある根のうち最小のものを返す。交差しなければ null。
 * 根は桁落ちを避ける形 t₁ = C/q, t₂ = q/A(q = −(B + sign(B)√D))で求める。
 */
export function intersectSphere(p, d, zVertex, radius) {
  const cv = Number.isFinite(radius) ? 1 / radius : 0;
  const q = [p[0], p[1], p[2] - zVertex];
  // cv·t² + 2B·t + C = 0
  const B = cv * dot(q, d) - d[2];
  const C = cv * dot(q, q) - 2 * q[2];
  const D = B * B - cv * C;
  if (D < 0) return null;
  const qq = -(B + (B >= 0 ? 1 : -1) * Math.sqrt(D));
  const roots = [];
  if (qq !== 0) roots.push(C / qq);
  if (cv !== 0 && qq !== 0) roots.push(qq / cv);
  let best = null;
  for (const t of roots) {
    if (!Number.isFinite(t) || t < -1e-9) continue;
    const zl = q[2] + t * d[2];
    if (cv * zl >= 1) continue; // 曲率中心より向こう側(反対の半球)
    if (best === null || t < best) best = t;
  }
  return best;
}

/** 面上の点 P(頂点基準座標系)での単位法線(おおむね +z 向き) */
export function surfaceNormal(P, zVertex, radius) {
  const cv = Number.isFinite(radius) ? 1 / radius : 0;
  return normalize([-cv * P[0], -cv * P[1], 1 - cv * (P[2] - zVertex)]);
}

/** ベクトル形スネルの法則。法線の向きは任意。全反射なら null */
export function refract(d, normal, n1, n2) {
  let N = normal, cosI = dot(d, N);
  if (cosI < 0) { N = scale(N, -1); cosI = -cosI; }
  const eta = n1 / n2;
  const k = 1 - eta * eta * (1 - cosI * cosI);
  if (k < 0) return null;
  return normalize(add(scale(d, eta), scale(N, Math.sqrt(k) - eta * cosI)));
}

/** 鏡面反射 */
export function reflect(d, normal) {
  return normalize(sub(d, scale(normal, 2 * dot(d, normal))));
}

/**
 * 光線を物体側から順に追跡。
 * opts: {toSurface, ignoreApertures, fresnel(関数: (n1,n2,cosI)=>T)}
 */
export function traceRay(sys, ray, opts = {}) {
  const S = sys.surfaces;
  const z = surfaceZ(sys);
  const last = opts.toSurface ?? S.length - 1;
  const points = [ray.p];
  let p = ray.p, d = ray.d, opl = 0, intensity = ray.intensity ?? 1;
  let n1 = refractiveIndex(mediumAfter(sys, 0), ray.lambda);
  for (let i = 1; i <= last; i++) {
    const s = S[i];
    const radius = s.kind === 'surface' ? s.radius : Infinity;
    const t = intersectSphere(p, d, z[i], radius);
    const fail = (reason) => ({ points, opl, alive: false, reason, failedAt: i, final: { p, d, lambda: ray.lambda, intensity } });
    if (t === null || t < EPS_T) return fail('miss');
    const P = add(p, scale(d, t));
    opl += n1 * t;
    points.push(P);
    p = P;
    if (!opts.ignoreApertures && s.kind !== 'screen' && Math.hypot(P[0], P[1]) > s.diameter / 2) return fail('vignetted');
    if (s.kind === 'surface') {
      const n2 = refractiveIndex(s.material, ray.lambda);
      const N = surfaceNormal(P, z[i], radius);
      const dn = refract(d, N, n1, n2);
      if (!dn) return fail('tir');
      if (opts.fresnel) intensity *= opts.fresnel(n1, n2, Math.abs(dot(d, N)));
      d = dn; n1 = n2;
    }
  }
  return { points, opl, alive: true, final: { p, d, lambda: ray.lambda, intensity } };
}

/** 開口絞り: 近軸マージナル光線高 / 半径 が最大の面(物体面・スクリーンを除く) */
export function findStop(sys, lambda = sys.wavelengths?.[1] ?? 0.55) {
  const { y } = ynuTrace(sys, lambda, 0, 1e-3);
  let best = 1, ratio = -1;
  for (let i = 1; i < sys.surfaces.length - 1; i++) {
    const r = Math.abs(y[i]) / (sys.surfaces[i].diameter / 2);
    if (r > ratio + 1e-12) { ratio = r; best = i; }
  }
  return best;
}

function dirFromSlopes(a, b) { return normalize([a, b, 1]); }

/**
 * 物体点 objPoint から、開口絞り上の規格化座標 (px, py)(|·|≤1 で絞り半径に対応)を通る光線を求める。
 * 近軸で初期値を作り、数値ヤコビアンのニュートン法で修正する。
 */
export function aimRay(sys, objPoint, lambda, px, py, stop = findStop(sys, lambda)) {
  const R = sys.surfaces[stop].diameter / 2;
  const target = [px * R, py * R];
  // 近軸: 絞り上の高さ = A·y0 + B·u0
  const A = ynuTrace(sys, lambda, 1, 0).y[stop];
  const B = ynuTrace(sys, lambda, 0, 1).y[stop];
  let a = (target[0] - A * objPoint[0]) / B;
  let b = (target[1] - A * objPoint[1]) / B;
  const at = (a, b) => {
    const r = traceRay(sys, { p: objPoint, d: dirFromSlopes(a, b), lambda }, { toSurface: stop, ignoreApertures: true });
    return r.points.length > stop ? r.points[stop] : null;
  };
  for (let it = 0; it < 12; it++) {
    const P = at(a, b);
    if (!P) break;
    const ex = P[0] - target[0], ey = P[1] - target[1];
    if (Math.hypot(ex, ey) < 1e-10 * Math.max(1, R)) break;
    const h = 1e-7;
    const Pa = at(a + h, b), Pb = at(a, b + h);
    if (!Pa || !Pb) break;
    const j11 = (Pa[0] - P[0]) / h, j21 = (Pa[1] - P[1]) / h;
    const j12 = (Pb[0] - P[0]) / h, j22 = (Pb[1] - P[1]) / h;
    const det = j11 * j22 - j12 * j21;
    if (!det) break;
    a -= (j22 * ex - j12 * ey) / det;
    b -= (-j21 * ex + j11 * ey) / det;
  }
  return { p: objPoint, d: dirFromSlopes(a, b), lambda, intensity: 1, pupil: [px, py] };
}

/** 開口絞り上の nPupil×nPupil セル中心格子(円内のみ)を狙う光線群 */
export function fanRays(sys, objPoint, lambda, nPupil) {
  const stop = findStop(sys, lambda);
  const rays = [];
  for (let iy = 0; iy < nPupil; iy++) {
    for (let ix = 0; ix < nPupil; ix++) {
      const px = nPupil === 1 ? 0 : ((ix + 0.5) / nPupil) * 2 - 1;
      const py = nPupil === 1 ? 0 : ((iy + 0.5) / nPupil) * 2 - 1;
      if (px * px + py * py > 1) continue;
      const r = aimRay(sys, objPoint, lambda, px, py, stop);
      r.grid = [ix, iy];
      rays.push(r);
    }
  }
  return rays;
}

/** 子午面(y-z)の扇状光線: py = -1..1 を nRays 本 */
export function meridionalFan(sys, objPoint, lambda, nRays) {
  const stop = findStop(sys, lambda);
  const out = [];
  for (let k = 0; k < nRays; k++) {
    const py = nRays === 1 ? 0 : -1 + (2 * k) / (nRays - 1);
    out.push(aimRay(sys, objPoint, lambda, 0, py, stop));
  }
  return out;
}

export { indicesAt };
