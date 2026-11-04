import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strayLight, composeImage } from '../src/core/stray.js';
import { makePattern } from '../src/core/patterns.js';
import { defaultSystem } from '../src/core/system.js';
import { traceRay, aimRay } from '../src/core/trace.js';
import { fresnelT } from '../src/core/fresnel.js';

const sys = () => { const s = defaultSystem(); s.screen.pixels = 64; return s; };
const zero = { glass: { scatterCoef: 0, ramanCoef: 0 }, surface: { sigmaNm: 0 }, medium: { density: 0 } };
const sum = (a) => a.reduce((x, y) => x + y, 0);
function centerDot(size = 32) {
  const d = new Float32Array(size * size * 3);
  for (let c = 0; c < 3; c++) d[((size / 2) * size + size / 2) * 3 + c] = 1;
  return { data: d, size };
}

test('zero scatter coefficients → stray image all zero', () => {
  const r = strayLight(sys(), makePattern('arrow', 32), zero, { rays: 2000 });
  assert.ok(r.image.every((v) => v === 0));
  assert.ok(r.raman.stokes.every((v) => v === 0));
});
test('energy budget sums to 1 and transmitted ≈ Fresnel transmittance', () => {
  const s = sys();
  const r = strayLight(s, centerDot(), zero, { rays: 3000 });
  const tot = sum(Object.values(r.budget));
  assert.ok(Math.abs(tot - 1) < 0.02);
  // 軸付近の点: 透過率は主光線の 4 面フレネル透過の積に近い
  const t = traceRay(s, aimRay(s, [0, 0, 0], 0.52, 0, 0), { fresnel: fresnelT }).final.intensity;
  assert.ok(Math.abs(r.budget.transmitted - t) < 0.02, `${r.budget.transmitted} vs ${t}`);
  assert.ok(r.budget.ghost + r.budget.backscatter > 0.1); // 無コート 4 面 → 約 15% が反射
});
test('fog density increases veil and backscatter', () => {
  const a = strayLight(sys(), makePattern('arrow', 32), zero, { rays: 3000 });
  const b = strayLight(sys(), makePattern('arrow', 32), { ...zero, medium: { density: 50, particleUm: 1, nParticle: 1.33 } }, { rays: 3000 });
  assert.ok(sum(b.image) > sum(a.image));
  assert.ok(b.budget.mediumScatter > 0);
  // 霧による後方散乱が発生する(霧なしでは 0)。合計はレンズ面反射の減少と相殺しうるため原因別に見る
  assert.equal(a.backscatterBy.mediumScatter ?? 0, 0);
  assert.ok(b.backscatterBy.mediumScatter > 0);
  assert.ok(b.budget.transmitted < a.budget.transmitted);
});
test('Raman image is produced at stokes wavelength', () => {
  const r = strayLight(sys(), makePattern('arrow', 32), { ...zero, glass: { scatterCoef: 0, ramanCoef: 1e-3, ramanShift: 465 } }, { rays: 3000 });
  assert.ok(sum(r.raman.stokes) > 0);
  // 反ストークス/ストークス比 ≈ q(室温で約 0.12)
  const q = r.raman.total.antiStokes / r.raman.total.stokes;
  assert.ok(q > 0.08 && q < 0.17, String(q));
  assert.ok(Math.abs(r.raman.wavelengths.stokes[0.52] - 0.53288) < 1e-4);
});
test('glass and surface scatter produce stray light', () => {
  const g = strayLight(sys(), makePattern('arrow', 32), { ...zero, glass: { scatterCoef: 1e-2, ramanCoef: 0 } }, { rays: 2000 });
  assert.ok(g.budget.glassScatter > 0 && sum(g.image) > 0);
  const s = strayLight(sys(), makePattern('arrow', 32), { ...zero, surface: { sigmaNm: 20 } }, { rays: 2000 });
  assert.ok(s.budget.surfaceScatter > 0 && sum(s.image) > 0);
});
test('same seed gives identical result', () => {
  const a = strayLight(sys(), makePattern('arrow', 32), { medium: { density: 10 } }, { rays: 1000, seed: 7 });
  const b = strayLight(sys(), makePattern('arrow', 32), { medium: { density: 10 } }, { rays: 1000, seed: 7 });
  assert.deepEqual(a.image, b.image);
});
test('composeImage clamps to 0..1', () => {
  const o = composeImage(Float32Array.of(0.5, 2, -1), Float32Array.of(0.1, 0, 0), null);
  assert.deepEqual([...o], [0.6000000238418579, 1, 0]);
});
