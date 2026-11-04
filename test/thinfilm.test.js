import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinFilm, COATINGS } from '../src/appearance/thinfilm.js';
import { fresnel } from '../src/core/fresnel.js';

test('no layer equals Fresnel at all angles', () => {
  for (const c of [1, 0.9, 0.5, 0.2, 0.01]) {
    const a = thinFilm(1, [], 1.5168, c, 0.55), b = fresnel(1, 1.5168, c);
    assert.ok(Math.abs(a.Rs - b.Rs) < 1e-12 && Math.abs(a.Rp - b.Rp) < 1e-12, `cos ${c}`);
  }
});
test('quarter-wave MgF2 on BK7 at normal incidence', () => {
  const n1 = 1.38, ns = 1.5168, lam = 0.55;
  const r = thinFilm(1, [{ n: n1, d: (lam * 1000) / 4 / n1 }], ns, 1, lam);
  const theory = ((1 * ns - n1 * n1) / (1 * ns + n1 * n1)) ** 2;
  assert.ok(Math.abs(r.R - theory) < 1e-12, `${r.R} vs ${theory}`);
  assert.ok(r.R < 0.013 && fresnel(1, ns, 1).R > 0.04);
  // 反射は青と赤で強い(紫色)
  const at = (l) => thinFilm(1, [{ n: n1, d: (0.55 * 1000) / 4 / n1 }], ns, 1, l).R;
  assert.ok(at(0.42) > at(0.55) && at(0.68) > at(0.55));
});
test('half-wave layer is absentee', () => {
  const r = thinFilm(1, [{ n: 1.8, d: 550 / 2 / 1.8 }], 1.5168, 1, 0.55);
  assert.ok(Math.abs(r.R - fresnel(1, 1.5168, 1).R) < 1e-12);
});
test('Brewster angle: Rp = 0 without coating', () => {
  const th = Math.atan(1.5);
  const r = thinFilm(1, [], 1.5, Math.cos(th), 0.55);
  assert.ok(r.Rp < 1e-12 && r.Rs > 0.1);
});
test('energy conservation R + T = 1 (lossless, multilayer, oblique)', () => {
  for (const key of Object.keys(COATINGS)) for (const c of [1, 0.7, 0.3]) for (const l of [0.42, 0.55, 0.68]) {
    const r = thinFilm(1, COATINGS[key].layers, 1.6, c, l);
    assert.ok(Math.abs(r.Rs + r.Ts - 1) < 1e-10 && Math.abs(r.Rp + r.Tp - 1) < 1e-10, `${key} ${c} ${l}`);
  }
});
test('total internal reflection gives R = 1, also through a thin layer', () => {
  assert.ok(Math.abs(thinFilm(1.5, [], 1, Math.cos(1.0), 0.55).R - 1) < 1e-12);
  const t = thinFilm(1.5, [{ n: 1.38, d: 100 }], 1, Math.cos(1.0), 0.55);
  assert.ok(Math.abs(t.R - 1) < 1e-9 && t.T < 1e-9);
});
test('frustrated TIR: very thin low-index gap transmits', () => {
  // ガラス/薄い空気層/ガラス: 臨界角を超えても層が薄ければ透過する(エバネッセント結合)
  const thin = thinFilm(1.5, [{ n: 1, d: 10 }], 1.5, Math.cos(1.0), 0.55);
  const thick = thinFilm(1.5, [{ n: 1, d: 2000 }], 1.5, Math.cos(1.0), 0.55);
  assert.ok(thin.T > 0.5 && thick.T < 1e-6, `${thin.T} ${thick.T}`);
});
test('V-coat is near zero at design wavelength', () => {
  // 2 層 V コート: n1²·ns = n2²·n0 で反射 0 になる組合せを確認
  const ns = 1.5168, n1 = 1.38, n2 = n1 * Math.sqrt(ns);
  const r = thinFilm(1, [{ n: n1, d: 550 / 4 / n1 }, { n: n2, d: 550 / 4 / n2 }], ns, 1, 0.55);
  assert.ok(r.R < 1e-12, String(r.R));
});
