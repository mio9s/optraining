import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rayleigh, mie, miePhase, henyeyGreenstein, sampleHG, forwardBackward, surfaceTIS, surfaceTIST, ramanShift, ramanAntiStokesRatio, rayleighPhase } from '../src/core/scatter.js';

const rel = (a, b) => Math.abs(a / b - 1);

test('Rayleigh cross-section scales as lambda^-4', () => {
  const a = rayleigh(0, 0.45, 0.01, 1.5).crossSection, b = rayleigh(0, 0.62, 0.01, 1.5).crossSection;
  assert.ok(rel(a / b, (0.62 / 0.45) ** 4) < 1e-12);
});
test('Rayleigh phase forward/backward symmetric and normalized', () => {
  const fb = forwardBackward(rayleighPhase);
  assert.ok(Math.abs(fb.forward - 0.5) < 1e-6);
  let s = 0; const N = 4000;
  for (let k = 0; k < N; k++) { const t = (Math.PI * (k + 0.5)) / N; s += rayleighPhase(Math.cos(t)) * 2 * Math.PI * Math.sin(t) * (Math.PI / N); }
  assert.ok(Math.abs(s - 1) < 1e-5);
});
test('Mie: x→0 approaches Rayleigh Qsca', () => {
  const x = 0.01, m = 1.33;
  const K = (m * m - 1) / (m * m + 2);
  const qR = (8 / 3) * x ** 4 * K * K;
  assert.ok(rel(mie(x, m).Qsca, qR) < 0.01);
  // 同じことを断面積で: d = 2x·λ/(2π)
  const lam = 0.5, d = (x * lam) / Math.PI;
  const sig = rayleigh(0, lam, d, m).crossSection;
  assert.ok(rel(sig / (Math.PI * (d / 2) ** 2), qR) < 1e-9);
});
// 参照値: miepython 3.3.1(efficiencies_mx)で算出。miepython は m = n − ik 規約、本実装は n + ik。
test('Mie: matches reference x=1, m=1.5', () => {
  const r = mie(1, 1.5);
  assert.ok(Math.abs(r.Qext - 0.21509759604288553) < 1e-4);
  assert.ok(Math.abs(r.Qsca - 0.21509759604288553) < 1e-4);
  assert.ok(Math.abs(r.Qback - 0.1865863103004153) < 1e-4);
  assert.ok(Math.abs(r.g - 0.19894249463608737) < 1e-4);
});
test('Mie: matches reference x=10, m=1.33 and absorbing sphere', () => {
  const r = mie(10, 1.33);
  assert.ok(Math.abs(r.Qsca - 2.206548710184618) < 1e-4);
  assert.ok(Math.abs(r.Qback - 0.5611794296163868) < 1e-4);
  assert.ok(Math.abs(r.g - 0.7124592696732813) < 1e-4);
  const a = mie(3, 1.5, 0.1);
  assert.ok(Math.abs(a.Qext - 3.0219982482769723) < 1e-4);
  assert.ok(Math.abs(a.Qsca - 2.126748707816867) < 1e-4);
  assert.ok(Math.abs(a.Qback - 0.09714586973161601) < 1e-4);
  assert.ok(Math.abs(a.g - 0.7821280572225866) < 1e-4);
});
test('Mie: S11 integrates to Qsca and phase function is normalized', () => {
  const x = 5, r = mie(x, 1.5, 0, 2001);
  let s = 0;
  for (let k = 1; k < 2001; k++) {
    const t0 = (Math.PI * (k - 1)) / 2000, t1 = (Math.PI * k) / 2000;
    s += 0.5 * (r.S11[k - 1] * Math.sin(t0) + r.S11[k] * Math.sin(t1)) * (t1 - t0);
  }
  assert.ok(rel((2 / (x * x)) * s, r.Qsca) < 1e-4);
  const p = miePhase(r, x);
  let n = 0;
  for (let k = 1; k < 2001; k++) {
    const t0 = (Math.PI * (k - 1)) / 2000, t1 = (Math.PI * k) / 2000;
    n += 0.5 * (p[k - 1] * Math.sin(t0) + p[k] * Math.sin(t1)) * (t1 - t0) * 2 * Math.PI;
  }
  assert.ok(Math.abs(n - 1) < 1e-4);
});
test('Mie: large x has g > 0.7 (forward dominant)', () => assert.ok(mie(50, 1.33).g > 0.7));
test('Mie: Qext → 2 for large x (extinction paradox)', () => {
  // miepython: x=200 → 2.0555578558451177, x=400 → 2.030845902137621(2 へゆっくり収束)
  assert.ok(Math.abs(mie(200, 1.33).Qext - 2.0555578558451177) < 1e-3);
  assert.ok(Math.abs(mie(400, 1.33).Qext - 2) < Math.abs(mie(200, 1.33).Qext - 2));
});
test('HG integrates to 1 and mean cos = g', () => {
  for (const g of [0, 0.5, -0.3, 0.9]) {
    let s = 0, m = 0; const N = 20000;
    for (let k = 0; k < N; k++) {
      const t = (Math.PI * (k + 0.5)) / N, w = 2 * Math.PI * Math.sin(t) * (Math.PI / N);
      const p = henyeyGreenstein(Math.cos(t), g); s += p * w; m += p * Math.cos(t) * w;
    }
    assert.ok(Math.abs(s - 1) < 1e-4, `g=${g} s=${s}`);
    assert.ok(Math.abs(m - g) < 1e-3, `g=${g} mean=${m}`);
  }
});
test('sampleHG has mean g', () => {
  const g = 0.6; let s = 0; const N = 100000;
  for (let k = 0; k < N; k++) s += sampleHG(g, (k + 0.5) / N);
  assert.ok(Math.abs(s / N - g) < 1e-3);
});
test('surface TIS formula', () => {
  assert.ok(rel(surfaceTIS(2, 0.5, 1), (4 * Math.PI * 0.002 / 0.5) ** 2) < 1e-12);
  assert.ok(surfaceTIS(2, 0.45, 1) > surfaceTIS(2, 0.62, 1));
  // 透過面: 垂直入射で (2πσ(n2−n1)/λ)²
  assert.ok(rel(surfaceTIST(2, 0.5, 1, 1.5, 1), (2 * Math.PI * 0.002 * 0.5 / 0.5) ** 2) < 1e-12);
});
test('Raman 520nm with 465cm-1 → stokes ≈ 0.5328 µm', () => {
  const r = ramanShift(0.52, 465);
  assert.ok(Math.abs(r.stokes - 0.53288) < 1e-4, String(r.stokes));
  assert.ok(r.antiStokes < 0.52 && Math.abs(r.antiStokes - 0.50766) < 1e-4, String(r.antiStokes));
});
test('anti-Stokes weaker than Stokes at room temperature', () => {
  const q = ramanAntiStokesRatio(0.52, 465, 293);
  assert.ok(q > 0.05 && q < 0.2, String(q));
  assert.ok(ramanAntiStokesRatio(0.52, 465, 600) > q);
});
