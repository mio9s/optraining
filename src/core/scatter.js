// 散乱モデル: レイリー / ミー (BHMIE 移植) / Henyey-Greenstein / 表面散乱 TIS / ラマン
// 位相関数はすべて立体角あたりで規格化(∫ p dΩ = 1)。

// ---- 複素数 ----
const C = (re, im = 0) => ({ re, im });
const cadd = (a, b) => C(a.re + b.re, a.im + b.im);
const csub = (a, b) => C(a.re - b.re, a.im - b.im);
const cmul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const cdiv = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const cscale = (a, s) => C(a.re * s, a.im * s);
const cabs2 = (a) => a.re * a.re + a.im * a.im;

/** レイリー散乱。d: 粒子直径 µm、λ: 真空波長 µm */
export function rayleigh(theta, lambdaUm, diameterUm, nParticle, nMedium = 1) {
  const lam = lambdaUm / nMedium, m = nParticle / nMedium;
  const K = (m * m - 1) / (m * m + 2);
  const crossSection = ((2 * Math.PI ** 5) / 3) * (diameterUm ** 6 / lam ** 4) * K * K;
  const c = Math.cos(theta);
  return { phase: (3 / (16 * Math.PI)) * (1 + c * c), crossSection };
}
export const rayleighPhase = (cosT) => (3 / (16 * Math.PI)) * (1 + cosT * cosT);

/**
 * ミー散乱(Bohren & Huffman BHMIE)。x = π d n_medium / λ、m = mRe + i·mIm(mIm > 0 で吸収)。
 * S11 は θ = 0..π を nAngles 点、(|S1|² + |S2|²)/2。
 */
export function mie(x, mRe, mIm = 0, nAngles = 181) {
  const m = C(mRe, mIm);
  const y = cmul(m, C(x));
  const xstop = x + 4 * Math.cbrt(x) + 2;
  const nstop = Math.round(xstop);
  const ymod = Math.hypot(y.re, y.im);
  const nmx = Math.round(Math.max(xstop, ymod)) + 15;
  const D = new Array(nmx + 1).fill(null).map(() => C(0));
  for (let n = nmx; n >= 2; n--) {
    const ny = cdiv(C(n), y);
    D[n - 1] = csub(ny, cdiv(C(1), cadd(D[n], ny)));
  }
  const mu = Float64Array.from({ length: nAngles }, (_, k) => Math.cos((Math.PI * k) / (nAngles - 1)));
  const S1 = Array.from({ length: nAngles }, () => C(0)), S2 = Array.from({ length: nAngles }, () => C(0));
  const pi0 = new Float64Array(nAngles), pi1 = new Float64Array(nAngles).fill(1);
  let psi0 = Math.cos(x), psi1 = Math.sin(x), chi0 = -Math.sin(x), chi1 = Math.cos(x);
  let xi1 = C(psi1, -chi1);
  let qsca = 0, gsca = 0, an1 = C(0), bn1 = C(0);
  for (let n = 1; n <= nstop; n++) {
    const fn = (2 * n + 1) / (n * (n + 1));
    const psi = ((2 * n - 1) * psi1) / x - psi0;
    const chi = ((2 * n - 1) * chi1) / x - chi0;
    const xi = C(psi, -chi);
    const da = cadd(cdiv(D[n], m), C(n / x));
    const db = cadd(cmul(m, D[n]), C(n / x));
    const an = cdiv(csub(cscale(da, psi), C(psi1)), csub(cmul(da, xi), xi1));
    const bn = cdiv(csub(cscale(db, psi), C(psi1)), csub(cmul(db, xi), xi1));
    qsca += (2 * n + 1) * (cabs2(an) + cabs2(bn));
    gsca += fn * (an.re * bn.re + an.im * bn.im);
    if (n > 1) gsca += (((n - 1) * (n + 1)) / n) * (an1.re * an.re + an1.im * an.im + bn1.re * bn.re + bn1.im * bn.im);
    for (let k = 0; k < nAngles; k++) {
      const p = pi1[k];
      const t = n * mu[k] * p - (n + 1) * pi0[k];
      S1[k] = cadd(S1[k], cscale(cadd(cscale(an, p), cscale(bn, t)), fn));
      S2[k] = cadd(S2[k], cscale(cadd(cscale(an, t), cscale(bn, p)), fn));
      const pn = ((2 * n + 1) * mu[k] * p - (n + 1) * pi0[k]) / n;
      pi0[k] = p; pi1[k] = pn;
    }
    psi0 = psi1; psi1 = psi; chi0 = chi1; chi1 = chi; xi1 = C(psi1, -chi1);
    an1 = an; bn1 = bn;
  }
  qsca *= 2 / (x * x);
  const Qext = (4 / (x * x)) * S1[0].re;
  const Qback = (4 * cabs2(S1[nAngles - 1])) / (x * x);
  const g = (4 * gsca) / (qsca * x * x);
  const S11 = Float64Array.from({ length: nAngles }, (_, k) => (cabs2(S1[k]) + cabs2(S2[k])) / 2);
  return { Qext, Qsca: qsca, Qback, g, S11, mu, S1, S2 };
}

/** S11 から規格化位相関数 p(θ) [1/sr] を作る */
export function miePhase(res, x) {
  return Float64Array.from(res.S11, (v) => v / (Math.PI * x * x * res.Qsca));
}

export function henyeyGreenstein(cosTheta, g) {
  return (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * cosTheta) ** 1.5);
}
/** 逆関数法: u ∈ [0,1) → cosθ */
export function sampleHG(g, u) {
  if (Math.abs(g) < 1e-6) return 2 * u - 1;
  const s = (1 - g * g) / (1 - g + 2 * g * u);
  return Math.max(-1, Math.min(1, (1 + g * g - s * s) / (2 * g)));
}

/** 位相関数 phaseFn(cosθ) の前方 (θ<90°) / 後方 (θ>90°) 比率(和 = 1) */
export function forwardBackward(phaseFn, steps = 2000) {
  let f = 0, b = 0;
  for (let k = 0; k < steps; k++) {
    const t = (Math.PI * (k + 0.5)) / steps;
    const v = phaseFn(Math.cos(t)) * Math.sin(t);
    if (t < Math.PI / 2) f += v; else b += v;
  }
  return { forward: f / (f + b), backward: b / (f + b) };
}

/** 表面の全積分散乱(反射): TIS = (4π σ cosI / λ)²  σ: RMS 粗さ nm */
export function surfaceTIS(sigmaNm, lambdaUm, cosI) {
  return ((4 * Math.PI * sigmaNm * 1e-3 * cosI) / lambdaUm) ** 2;
}
/** 透過面の TIS: (2π σ |n1 cosI − n2 cosT| / λ)² */
export function surfaceTIST(sigmaNm, lambdaUm, n1, n2, cosI) {
  const sinT = (n1 / n2) * Math.sqrt(Math.max(0, 1 - cosI * cosI));
  if (sinT >= 1) return 0;
  const cosT = Math.sqrt(1 - sinT * sinT);
  return ((2 * Math.PI * sigmaNm * 1e-3 * Math.abs(n1 * cosI - n2 * cosT)) / lambdaUm) ** 2;
}

/** ラマンシフト: 1/λ_s = 1/λ − Δν, 1/λ_as = 1/λ + Δν(Δν: cm⁻¹ → µm⁻¹ は ×1e-4) */
export function ramanShift(lambdaUm, shiftCm1) {
  const k = 1 / lambdaUm, dk = shiftCm1 * 1e-4;
  return { stokes: 1 / (k - dk), antiStokes: 1 / (k + dk) };
}
/** 反ストークス/ストークス強度比 = (ν_as/ν_s)⁴ · exp(−hcΔν/kT) */
export function ramanAntiStokesRatio(lambdaUm, shiftCm1, tempK = 293) {
  const { stokes, antiStokes } = ramanShift(lambdaUm, shiftCm1);
  const HC_K = 1.438777; // cm·K
  return (stokes / antiStokes) ** 4 * Math.exp((-HC_K * shiftCm1) / tempK);
}

export const SCATTER_DEFAULTS = {
  glass: { scatterCoef: 1e-4 /* 1/mm @0.55µm(λ⁻⁴ で換算、レイリー型) */, ramanShift: 465 /* SiO₂ 主ピーク cm⁻¹ */, ramanCoef: 1e-5 /* 1/mm */, tempK: 293 },
  surface: { sigmaNm: 2 /* RMS 粗さ+汚れ */ },
  medium: { particleUm: 1.0, nParticle: 1.33, density: 0 /* 個/mm³(0 = 霧なし) */ },
};
