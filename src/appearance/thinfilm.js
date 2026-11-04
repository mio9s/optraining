// 薄膜(単層・多層)の反射率・透過率: 特性行列法(Macleod)。s・p 偏光別、無偏光は平均。
// 吸収のない層を想定(屈折率は実数)。全反射やエバネッセント層は複素 cosθ で扱う。
// n0: 入射側媒質、layers: 入射側から順に [{n, d /* nm */}]、ns: 射出側媒質、cos0: 入射角の cos、λ: µm

const C = (re, im = 0) => ({ re, im });
const add = (a, b) => C(a.re + b.re, a.im + b.im);
const sub = (a, b) => C(a.re - b.re, a.im - b.im);
const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const abs2 = (a) => a.re * a.re + a.im * a.im;
function csqrt(a) { // 主値。エバネッセント側は Im > 0 を選ぶ(減衰)
  const r = Math.hypot(a.re, a.im);
  let re = Math.sqrt(Math.max(0, (r + a.re) / 2)), im = Math.sqrt(Math.max(0, (r - a.re) / 2));
  if (a.im < 0) im = -im;
  if (im < 0 || (im === 0 && re < 0)) { re = -re; im = -im; }
  return C(re, im);
}
const ccos = (z) => C(Math.cos(z.re) * Math.cosh(z.im), -Math.sin(z.re) * Math.sinh(z.im));
const csin = (z) => C(Math.sin(z.re) * Math.cosh(z.im), Math.cos(z.re) * Math.sinh(z.im));

/** 媒質 n での cosθ(Snell: n0 sinθ0 = n sinθ) */
function cosIn(n, n0, sin0) {
  const s = (n0 * sin0) / n;
  return csqrt(C(1 - s * s));
}

function solve(n0, layers, ns, cos0, lambda, pol) {
  const sin0 = Math.sqrt(Math.max(0, 1 - cos0 * cos0));
  const eta = (n, c) => (pol === 's' ? mul(C(n), c) : div(C(n), c));
  const eta0 = eta(n0, C(cos0));
  let m11 = C(1), m12 = C(0), m21 = C(0), m22 = C(1);
  for (const L of layers) {
    const c = cosIn(L.n, n0, sin0);
    const e = eta(L.n, c);
    const delta = mul(C((2 * Math.PI * L.n * L.d * 1e-3) / lambda), c);
    const cd = ccos(delta), sd = csin(delta);
    const a11 = cd, a12 = div(mul(C(0, 1), sd), e), a21 = mul(mul(C(0, 1), e), sd), a22 = cd;
    [m11, m12, m21, m22] = [add(mul(m11, a11), mul(m12, a21)), add(mul(m11, a12), mul(m12, a22)), add(mul(m21, a11), mul(m22, a21)), add(mul(m21, a12), mul(m22, a22))];
  }
  const cs = cosIn(ns, n0, sin0);
  const etas = eta(ns, cs);
  const B = add(m11, mul(m12, etas)), Cc = add(m21, mul(m22, etas));
  const den = add(mul(eta0, B), Cc);
  const r = div(sub(mul(eta0, B), Cc), den);
  const R = Math.min(1, abs2(r));
  const T = Math.max(0, (4 * eta0.re * etas.re) / abs2(den));
  return { R, T };
}

/** 無コート界面の無偏光反射率だけ(割り当てなしの最速版) */
export function bareR(n1, n2, cosI) {
  const c = cosI < 1 ? cosI : 1;
  const st = (n1 / n2) * Math.sqrt(Math.max(0, 1 - c * c));
  if (st >= 1) return 1;
  const ct = Math.sqrt(1 - st * st);
  const rs = (n1 * c - n2 * ct) / (n1 * c + n2 * ct), rp = (n1 * ct - n2 * c) / (n1 * ct + n2 * c);
  return (rs * rs + rp * rp) / 2;
}

/** 無コート界面の閉じた式(高速) */
function bare(n1, n2, cosI) {
  const c = Math.min(1, Math.abs(cosI));
  const sinT = (n1 / n2) * Math.sqrt(Math.max(0, 1 - c * c));
  if (sinT >= 1) return { Rs: 1, Rp: 1, R: 1, Ts: 0, Tp: 0, T: 0 };
  const ct = Math.sqrt(1 - sinT * sinT);
  const rs = (n1 * c - n2 * ct) / (n1 * c + n2 * ct), rp = (n1 * ct - n2 * c) / (n1 * ct + n2 * c);
  const Rs = rs * rs, Rp = rp * rp;
  return { Rs, Rp, R: (Rs + Rp) / 2, Ts: 1 - Rs, Tp: 1 - Rp, T: 1 - (Rs + Rp) / 2 };
}

/**
 * 実数だけの高速版: 吸収のない層で、どの層でも全反射が起きない(cosθ が実数)場合。
 * 特性行列は [[A, iB], [iC, D]](A, B, C, D は実数)の形を保つ。
 */
function realFast(n0, layers, ns, cos0, lambda, pol) {
  const sin0 = Math.sqrt(Math.max(0, 1 - cos0 * cos0));
  const cosOf = (n) => { const s = (n0 * sin0) / n; const q = 1 - s * s; return q > 0 ? Math.sqrt(q) : -1; };
  const eta = (n, c) => (pol === 's' ? n * c : n / c);
  let A = 1, B = 0, C = 0, D = 1;
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i], c = cosOf(L.n);
    if (c < 0) return null;
    const e = eta(L.n, c), dl = (2 * Math.PI * L.n * L.d * 1e-3 * c) / lambda;
    const cd = Math.cos(dl), sd = Math.sin(dl);
    // [[A, iB], [iC, D]] × [[cd, i sd/e], [i e sd, cd]]
    const nA = A * cd - B * e * sd, nB = (A * sd) / e + B * cd, nC = C * cd + D * e * sd, nD = D * cd - (C * sd) / e;
    A = nA; B = nB; C = nC; D = nD;
  }
  const cs = cosOf(ns);
  if (cs < 0) return null;
  const e0 = eta(n0, cos0), es = eta(ns, cs);
  const nr = e0 * A - D * es, ni = e0 * B * es - C, dr = e0 * A + D * es, di = e0 * B * es + C;
  const den = dr * dr + di * di;
  return { R: Math.min(1, (nr * nr + ni * ni) / den), T: (4 * e0 * es) / den };
}

export function thinFilm(n0, layers, ns, cos0, lambda) {
  if (!layers || !layers.length) return bare(n0, ns, cos0);
  {
    const c0 = Math.min(1, Math.abs(cos0));
    const fs = realFast(n0, layers, ns, c0, lambda, 's'), fp = fs && realFast(n0, layers, ns, c0, lambda, 'p');
    if (fs && fp) return { Rs: fs.R, Rp: fp.R, R: (fs.R + fp.R) / 2, Ts: fs.T, Tp: fp.T, T: (fs.T + fp.T) / 2 };
  }
  const s = solve(n0, layers ?? [], ns, Math.min(1, Math.abs(cos0)), lambda, 's');
  const p = solve(n0, layers ?? [], ns, Math.min(1, Math.abs(cos0)), lambda, 'p');
  return { Rs: s.R, Rp: p.R, R: (s.R + p.R) / 2, Ts: s.T, Tp: p.T, T: (s.T + p.T) / 2 };
}

/** 代表的なコートのプリセット(層は空気側 → 基板側の順、設計波長 550 nm、BK7 基板向け) */
const q = (n, f = 1) => ({ n, d: (550 / 4 / n) * f });
export const COATINGS = {
  none: { label: '無コート', layers: [] },
  mgf2: { label: 'MgF₂ 単層 λ/4', layers: [q(1.38)] },
  vcoat: { label: '2 層 V コート(MgF₂ / n 1.70)', layers: [q(1.38), q(1.7)] },
  bbar: { label: '3 層 広帯域 AR(λ/4・λ/2・λ/4)', layers: [q(1.38), q(2.1, 2), q(1.63)] },
};
