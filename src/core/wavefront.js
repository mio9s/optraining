// 波面収差(OPD)とゼルニケ分解
// 規約: Noll 番号付け、単位円上で RMS = 1 に規格化。θ は +x 軸から +y 軸へ。
//   偶数 j → cos(mθ)、奇数 j → sin(mθ)。子午面は y-z 面なので y 方向のコマは Z7、チルトは Z3。
// OPD = OPL(参照球まで) − OPL(主光線)、単位 waves。参照球: 中心 = 主光線とスクリーンの交点、
//   半径 = 射出瞳(開口絞りの近軸像)面上の主光線位置からその点まで。
import { fanRays, traceRay, findStop, aimRay } from './trace.js';
import { ynuTrace } from './ynu.js';
import { surfaceZ } from './system.js';
import { add, scale, dot, sub, norm } from './vec.js';

export function nollToNM(j) {
  let n = 0;
  while (((n + 1) * (n + 2)) / 2 < j) n++;
  const k = j - (n * (n + 1)) / 2 - 1;
  const am = n % 2 === 0 ? 2 * Math.floor((k + 1) / 2) : 2 * Math.floor(k / 2) + 1;
  const m = am === 0 ? 0 : j % 2 === 0 ? am : -am;
  return [n, m];
}

const fact = (k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };

const ZCACHE = [];
function zinfo(j) {
  if (ZCACHE[j]) return ZCACHE[j];
  const [n, m] = nollToNM(j);
  const am = Math.abs(m);
  const terms = [];
  for (let k = 0; k <= (n - am) / 2; k++)
    terms.push([((k % 2 ? -1 : 1) * fact(n - k)) / (fact(k) * fact((n + am) / 2 - k) * fact((n - am) / 2 - k)), n - 2 * k]);
  return (ZCACHE[j] = { m, am, terms, norm: m === 0 ? Math.sqrt(n + 1) : Math.sqrt(2 * (n + 1)) });
}

export function zernike(j, rho, theta) {
  const { m, am, terms, norm } = zinfo(j);
  let R = 0;
  for (const [c, p] of terms) R += c * rho ** p;
  if (m === 0) return norm * R;
  return norm * R * (m > 0 ? Math.cos(am * theta) : Math.sin(am * theta));
}

/** j = 1..jMax をまとめて評価(out[j-1])。ρ のべき・cos/sin(mθ) を共有して高速化 */
export function zernikeAll(jMax, rho, theta, out = new Float64Array(jMax)) {
  const nMax = nollToNM(jMax)[0] + 1;
  const pw = [1];
  for (let k = 1; k <= nMax; k++) pw[k] = pw[k - 1] * rho;
  const cs = [1], sn = [0];
  const c1 = Math.cos(theta), s1 = Math.sin(theta);
  for (let k = 1; k <= nMax; k++) { cs[k] = cs[k - 1] * c1 - sn[k - 1] * s1; sn[k] = sn[k - 1] * c1 + cs[k - 1] * s1; }
  for (let j = 1; j <= jMax; j++) {
    const { m, am, terms, norm } = zinfo(j);
    let R = 0;
    for (const [c, p] of terms) R += c * pw[p];
    out[j - 1] = m === 0 ? norm * R : norm * R * (m > 0 ? cs[am] : sn[am]);
  }
  return out;
}

export const ZERNIKE_NAMES = {
  1: 'ピストン', 2: 'チルト X', 3: 'チルト Y', 4: 'デフォーカス(像面湾曲)',
  5: '非点収差 45°', 6: '非点収差 0°', 7: 'コマ Y', 8: 'コマ X', 9: 'トレフォイル Y', 10: 'トレフォイル X',
  11: '球面収差(3 次)', 12: '2 次非点 0°', 13: '2 次非点 45°', 14: 'テトラフォイル 0°', 15: 'テトラフォイル 45°',
  16: '2 次コマ X', 17: '2 次コマ Y', 22: '球面収差(5 次)', 37: '球面収差(7 次)',
};
export function zernikeName(j) {
  const [n, m] = nollToNM(j);
  return ZERNIKE_NAMES[j] ?? `Z${j} (n=${n}, m=${m})`;
}

/** 格子セル中心の規格化瞳座標(fanRays と同じ規約) */
export function gridCoord(ix, iy, n) {
  return [((ix + 0.5) / n) * 2 - 1, ((iy + 0.5) / n) * 2 - 1];
}

function solve(A, b) {
  const N = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < N; c++) {
    let p = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) continue;
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-300 ? 0 : row[N] / row[i]));
}

/** 最小二乗フィット。係数 [waves]、index 0 が j=1 */
export function fitZernike(grid, n, jMax = 37) {
  const A = Array.from({ length: jMax }, () => new Array(jMax).fill(0));
  const b = new Array(jMax).fill(0);
  const z = new Float64Array(jMax);
  let count = 0;
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const v = grid[iy * n + ix];
    if (!Number.isFinite(v)) continue;
    const [x, y] = gridCoord(ix, iy, n);
    const r = Math.hypot(x, y), t = Math.atan2(y, x);
    if (r > 1) continue;
    count++;
    zernikeAll(jMax, r, t, z);
    for (let i = 0; i < jMax; i++) {
      b[i] += z[i] * v;
      for (let j = 0; j < jMax; j++) A[i][j] += z[i] * z[j];
    }
  }
  if (count < jMax) return new Array(jMax).fill(0);
  return solve(A, b);
}

/** 射出瞳: 開口絞りの近軸像。{z, stop} */
export function exitPupil(sys, lambda) {
  const stop = findStop(sys, lambda);
  const S = sys.surfaces;
  let k = -1;
  for (let i = S.length - 2; i > stop; i--) if (S[i].kind === 'surface') { k = i; break; }
  const z = surfaceZ(sys);
  const rStop = S[stop].diameter / 2;
  if (k < 0) return { z: z[stop], stop, radius: rStop };
  const { y, u } = ynuTrace(sys, lambda, 0, 1, stop);
  const zxp = z[k] - y[k] / u[k];
  // 絞り縁の像高: 絞り縁から出る任意の近軸光線は射出瞳面で同じ高さを通る
  const e = ynuTrace(sys, lambda, rStop, 0, stop);
  return { z: zxp, stop, radius: Math.abs(e.y[k] + e.u[k] * (zxp - z[k])) };
}

/**
 * 物体点 objPoint の波面。grid[iy*n+ix] = OPD [waves](瞳外・遮蔽は NaN)。
 */
export function wavefront(sys, objPoint, lambda, n = 32) {
  const S = sys.surfaces;
  const last = S.length - 2; // スクリーン直前の面(像空間の媒質中)
  const grid = new Float64Array(n * n).fill(NaN);
  const empty = { grid, n, rmsWaves: NaN, pvWaves: NaN, chief: null };
  const xp = exitPupil(sys, lambda);
  const chiefRay = aimRay(sys, objPoint, lambda, 0, 0, xp.stop);
  const chief = traceRay(sys, chiefRay);
  if (!chief.alive) return empty;
  const I = chief.points[chief.points.length - 1];
  const nImg = 1; // 像空間は空気(スクリーン手前は空気を前提)
  const cP = chief.points[last], cd = chief.final.d;
  const tE = (xp.z - cP[2]) / cd[2];
  const E = add(cP, scale(cd, tE));
  const Rref = norm(sub(I, E));
  const oplToSphere = (opl, P, d) => {
    const q = sub(P, I);
    const b = dot(d, q), c = dot(q, q) - Rref * Rref;
    const D = b * b - c;
    if (D < 0) return NaN;
    return opl + nImg * (-b - Math.sqrt(D));
  };
  const chiefOpl = oplToSphere(traceRay(sys, chiefRay, { toSurface: last }).opl, cP, cd);
  const lamMm = lambda * 1e-3;
  const spots = [];
  let total = 0;
  for (const ray of fanRays(sys, objPoint, lambda, n)) {
    total++;
    const full = traceRay(sys, ray);
    if (!full.alive) continue;
    const Q = full.points[full.points.length - 1];
    spots.push([Q[0] - I[0], Q[1] - I[1]]);
    const part = traceRay(sys, ray, { toSurface: last });
    const v = (oplToSphere(part.opl, part.points[last], part.final.d) - chiefOpl) / lamMm;
    if (Number.isFinite(v)) grid[ray.grid[1] * n + ray.grid[0]] = v;
  }
  let s = 0, s2 = 0, cnt = 0, mn = Infinity, mx = -Infinity;
  for (const v of grid) if (Number.isFinite(v)) { s += v; s2 += v * v; cnt++; mn = Math.min(mn, v); mx = Math.max(mx, v); }
  if (!cnt) return empty;
  const mean = s / cnt;
  return {
    grid, n, lambda, spots, aliveFraction: total ? spots.length / total : 0,
    rmsWaves: Math.sqrt(Math.max(0, s2 / cnt - mean * mean)), pvWaves: mx - mn,
    pupilDiamMm: 2 * xp.radius, chief: { image: I, exitPupilZ: xp.z, Rref, dir: chief.final.d, objDir: chiefRay.d },
  };
}
