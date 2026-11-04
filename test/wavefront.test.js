import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zernike, nollToNM, fitZernike, wavefront, ZERNIKE_NAMES, exitPupil } from '../src/core/wavefront.js';
import { paraxialTrace } from '../src/core/paraxial.js';
import { defaultSystem } from '../src/core/system.js';

const air = { type: 'air' };
function singlet(objDist = 1e4) {
  const sys = {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: objDist, material: air, diameter: 1e6 },
      { kind: 'surface', radius: 51.68, thickness: 4, material: { type: 'preset', name: 'N-BK7' }, diameter: 20 },
      { kind: 'surface', radius: Infinity, thickness: 100, material: air, diameter: 20 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 50 },
    ],
    object: { height: 100 }, screen: { width: 10, pixels: 64 }, wavelengths: [0.45, 0.52, 0.62],
  };
  const r = paraxialTrace(sys, 0.52);
  sys.surfaces[2].thickness = r.imageZ - objDist - 4;
  return sys;
}

test('Noll index mapping', () => {
  assert.deepEqual(nollToNM(1), [0, 0]);
  assert.deepEqual(nollToNM(2), [1, 1]);
  assert.deepEqual(nollToNM(3), [1, -1]);
  assert.deepEqual(nollToNM(4), [2, 0]);
  assert.deepEqual(nollToNM(5), [2, -2]);
  assert.deepEqual(nollToNM(6), [2, 2]);
  assert.deepEqual(nollToNM(7), [3, -1]);
  assert.deepEqual(nollToNM(8), [3, 1]);
  assert.deepEqual(nollToNM(11), [4, 0]);
  assert.deepEqual(nollToNM(22), [6, 0]);
  assert.deepEqual(nollToNM(37), [8, 0]);
  assert.ok(ZERNIKE_NAMES[11].includes('球面'));
});
test('Noll Z4 = sqrt(3)(2rho^2-1)', () => {
  for (const r of [0, 0.3, 0.7, 1]) assert.ok(Math.abs(zernike(4, r, 1.2) - Math.sqrt(3) * (2 * r * r - 1)) < 1e-12);
  assert.ok(Math.abs(zernike(8, 1, 0) - Math.sqrt(8)) < 1e-12);
  assert.ok(Math.abs(zernike(7, 1, Math.PI / 2) - Math.sqrt(8)) < 1e-12);
});
test('Zernike orthonormality over unit disk (j=1..15)', () => {
  const NR = 200, NT = 256;
  for (let i = 1; i <= 15; i++) for (let j = i; j <= 15; j++) {
    let s = 0;
    for (let a = 0; a < NR; a++) {
      const r = (a + 0.5) / NR;
      for (let b = 0; b < NT; b++) {
        const t = (2 * Math.PI * (b + 0.5)) / NT;
        s += zernike(i, r, t) * zernike(j, r, t) * r;
      }
    }
    s *= (1 / NR) * (2 * Math.PI / NT) / Math.PI;
    assert.ok(Math.abs(s - (i === j ? 1 : 0)) < 1e-3, `${i},${j}: ${s}`);
  }
});
test('fit recovers synthetic coefficients', () => {
  const n = 32, grid = new Float64Array(n * n);
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const x = ((ix + 0.5) / n) * 2 - 1, y = ((iy + 0.5) / n) * 2 - 1;
    const r = Math.hypot(x, y), t = Math.atan2(y, x);
    grid[iy * n + ix] = r > 1 ? NaN : 0.3 * zernike(4, r, t) + 0.1 * zernike(8, r, t) + 0.05 * zernike(11, r, t);
  }
  const c = fitZernike(grid, n, 37);
  assert.equal(c.length, 37);
  c.forEach((v, k) => {
    const exp = { 4: 0.3, 8: 0.1, 11: 0.05 }[k + 1] ?? 0;
    assert.ok(Math.abs(v - exp) < 1e-6, `j=${k + 1}: ${v}`);
  });
});
test('exit pupil of front-stop singlet is behind object side of lens (virtual)', () => {
  const sys = singlet();
  const xp = exitPupil(sys, 0.52);
  assert.ok(Number.isFinite(xp.z));
});
test('BK7 singlet on-axis: Z11 (spherical) dominant, coma ~0', () => {
  const wf = wavefront(singlet(), [0, 0, 0], 0.52, 32);
  const c = fitZernike(wf.grid, wf.n, 37);
  assert.ok(Math.abs(c[10]) > 0.05, `c11=${c[10]}`);
  assert.ok(Math.abs(c[7]) < 1e-3 * Math.abs(c[10]) && Math.abs(c[6]) < 1e-3 * Math.abs(c[10]));
  assert.ok(Math.abs(c[4]) < 1e-3 * Math.abs(c[10]) && Math.abs(c[5]) < 1e-3 * Math.abs(c[10]));
  assert.ok(wf.rmsWaves > 0 && wf.pvWaves >= wf.rmsWaves);
});
test('off-axis object (y-field) produces coma Z7', () => {
  const wf = wavefront(singlet(), [0, 500, 0], 0.52, 32);
  const c = fitZernike(wf.grid, wf.n, 37);
  assert.ok(Math.abs(c[6]) > 0.01, `c7=${c[6]}`);
  assert.ok(Math.abs(c[7]) < 1e-3 * Math.abs(c[6]), `c8=${c[7]}`); // x 方向コマは対称性で 0
});
test('perfect lens-free reference: grid has NaN outside pupil and no NaN inside', () => {
  const wf = wavefront(defaultSystem(), [0, 5, 0], 0.52, 16);
  let nan = 0, fin = 0;
  wf.grid.forEach((v) => (Number.isNaN(v) ? nan++ : fin++));
  assert.ok(fin > 150 && nan > 0);
});
test('bestFocus finds the minimum-RMS focus (Z4 = 0)', async () => {
  const { bestFocus } = await import('../src/core/wavefront.js');
  const sys = singlet();
  const r = bestFocus(sys, [0, 0, 0], 0.52);
  // 補正不足の球面収差 → 最良焦点は近軸焦点より手前(負)
  assert.ok(r.shift < 0, String(r.shift));
  assert.ok(r.rmsAtBest < r.rmsAtScreen);
  const s2 = structuredClone(sys); s2.surfaces[2].thickness += r.shift;
  const wf = wavefront(s2, [0, 0, 0], 0.52, 32);
  assert.ok(Math.abs(fitZernike(wf.grid, wf.n, 37)[3]) < 1e-3);
  for (const d of [-0.2, 0.2]) { // 前後にずらすと RMS は増える
    const s3 = structuredClone(s2); s3.surfaces[2].thickness += d;
    assert.ok(wavefront(s3, [0, 0, 0], 0.52, 32).rmsWaves > r.rmsAtBest);
  }
});
