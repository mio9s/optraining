import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paraxialTrace, chromatic } from '../../src/core/paraxial.js';
import { defaultSystem } from '../../src/core/system.js';

const air = { type: 'air' };
function lens(R1, R2, t, mat, objDist = 1e6, back = 100, height = 5) {
  return {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: objDist, material: air, diameter: 1e7 },
      { kind: 'surface', radius: R1, thickness: t, material: mat, diameter: 20 },
      { kind: 'surface', radius: R2, thickness: back, material: air, diameter: 20 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 50 },
    ],
    object: { height }, screen: { width: 10, pixels: 64 }, wavelengths: [0.45, 0.52, 0.62],
  };
}

test('thin-lens limit matches 1/f = (n-1)(1/R1-1/R2)', () => {
  const m = { type: 'model', nd: 1.5, vd: 1e12 };
  const { efl } = paraxialTrace(lens(100, -100, 1e-4, m), 0.5);
  assert.ok(Math.abs(efl / 100 - 1) < 1e-3, `efl=${efl}`);
});
test('finite conjugate: thin lens imaging equation', () => {
  const m = { type: 'model', nd: 1.5, vd: 1e12 };
  const sys = lens(100, -100, 1e-4, m, 200);
  const r = paraxialTrace(sys, 0.5);
  assert.ok(Math.abs(r.imageZ - 200 - 200) < 0.05, `imageZ=${r.imageZ}`);
  assert.ok(Math.abs(r.magnification + 1) < 1e-3, `m=${r.magnification}`);
});
test('axial color is zero when n is wavelength-independent', () => {
  const sys = lens(51.68, Infinity, 4, { type: 'model', nd: 1.5168, vd: 1e12 }, 1000, 98, 5);
  const c = chromatic(sys);
  assert.ok(Math.abs(c.axialColor) < 1e-9, String(c.axialColor));
  assert.ok(Math.abs(c.lateralColor) < 1e-9, String(c.lateralColor));
});
test('axial color non-zero for BK7 singlet', () => {
  const c = chromatic(lens(51.68, Infinity, 4, { type: 'preset', name: 'N-BK7' }));
  assert.ok(c.axialColor < -0.5, String(c.axialColor)); // 青の像が手前(z 小)
});
test('lateral color is zero for on-axis object height 0', () => {
  const c = chromatic(lens(51.68, Infinity, 4, { type: 'preset', name: 'N-BK7' }, 1000, 98, 0));
  assert.ok(Math.abs(c.lateralColor) < 1e-12);
});
test('default system: screen is near paraxial image and achromat reduces axial color', () => {
  const sys = defaultSystem();
  const r = paraxialTrace(sys, 0.52);
  const zScreen = sys.surfaces.reduce((a, s) => a + s.thickness, 0);
  assert.ok(Math.abs(r.imageZ - zScreen) < 0.5, `image ${r.imageZ} screen ${zScreen}`);
  const c = chromatic(sys);
  const bk7 = chromatic(lens(51.68, Infinity, 4, { type: 'preset', name: 'N-BK7' }, 200));
  assert.ok(Math.abs(c.axialColor) < Math.abs(bk7.axialColor) / 3);
});
