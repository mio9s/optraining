import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psf, psfCentroid } from '../src/core/psf.js';
import { wavefront, zernike, gridCoord } from '../src/core/wavefront.js';
import { paraxialTrace } from '../src/core/paraxial.js';

function flatWf(n = 32, fn = () => 0) {
  const grid = new Float64Array(n * n);
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const [x, y] = gridCoord(ix, iy, n);
    grid[iy * n + ix] = x * x + y * y > 1 ? NaN : fn(x, y);
  }
  return { grid, n, spots: [] };
}

test('aberration-free PSF matches Airy first zero 1.22 λ N', () => {
  const lam = 0.5, D = 10, R = 50, pix = 0.1e-3;
  const p = psf(flatWf(), lam, D, R, pix);
  assert.equal(p.mode, 'diffraction');
  const h = (p.m - 1) / 2;
  const row = Array.from({ length: p.m - h }, (_, k) => p.data[h * p.m + h + k]);
  let k = 1; while (k + 1 < row.length && row[k + 1] < row[k]) k++;
  const zero = k * pix, theory = 1.22 * lam * 1e-3 * (R / D);
  assert.ok(Math.abs(zero / theory - 1) < 0.05, `zero=${zero} theory=${theory}`);
  // ピークは中心
  assert.ok(p.data[h * p.m + h] === Math.max(...p.data));
});
test('PSF sums to 1', () => {
  const p = psf(flatWf(32, (x, y) => 0.3 * zernike(8, Math.hypot(x, y), Math.atan2(y, x))), 0.5, 10, 50, 1e-3);
  const s = p.data.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - 1) < 1e-5);
});
test('PSF orientation: +y wavefront tilt matches geometric ray direction', () => {
  // OPD = OPL(光線) − OPL(参照) の規約では実波面は +W 側で参照球より外側にあり、
  // 法線(光線)は +∂W/∂y の向きに傾く → 横収差 Δy = +R ∂W/∂y_pupil
  const lam = 0.5, D = 10, R = 50, a = 2;
  const p = psf(flatWf(32, (x, y) => a * y), lam, D, R, 0.5e-3);
  const [cx, cy] = psfCentroid(p);
  const expected = R * (a * lam * 1e-3) / (D / 2);
  assert.ok(Math.abs(cx) < 2e-4);
  assert.ok(Math.abs(cy / expected - 1) < 0.1, `cy=${cy} expected=${expected}`);
});
test('diffraction PSF centroid agrees with geometric spot centroid (coma)', () => {
  const air = { type: 'air' };
  const sys = {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: 1e4, material: air, diameter: 1e6 },
      { kind: 'surface', radius: 51.68, thickness: 4, material: { type: 'preset', name: 'N-BK7' }, diameter: 6 },
      { kind: 'surface', radius: Infinity, thickness: 100, material: air, diameter: 6 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 50 },
    ], object: { height: 1 }, screen: { width: 1, pixels: 8 }, wavelengths: [0.52],
  };
  sys.surfaces[2].thickness = paraxialTrace(sys, 0.52).imageZ - 1e4 - 4;
  const wf = wavefront(sys, [0, 600, 0], 0.52, 32);
  const p = psf(wf, 0.52, wf.pupilDiamMm, wf.chief.Rref, 0.5e-3);
  const [, cy] = psfCentroid(p);
  const gy = wf.spots.reduce((a, s) => a + s[1], 0) / wf.spots.length;
  assert.ok(Math.abs(cy - gy) < 0.15 * Math.abs(gy) + 5e-4, `diff ${cy} geo ${gy} mode ${p.mode}`);
});
test('no rays → null', () => assert.equal(psf(flatWf(8, () => NaN), 0.5, 10, 50, 1e-3), null));
