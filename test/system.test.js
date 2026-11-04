import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSystem, surfaceZ, defaultSystem, mediumAfter } from '../src/core/system.js';

const air = { type: 'air' };
const bk7 = { type: 'preset', name: 'N-BK7' };
function singlet() {
  return {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: 200, material: air, diameter: 20 },
      { kind: 'surface', radius: 50, thickness: 5, material: bk7, diameter: 20 },
      { kind: 'iris', radius: Infinity, thickness: 0, material: air, diameter: 10 },
      { kind: 'surface', radius: -50, thickness: 50, material: air, diameter: 20 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 20 },
    ],
    object: { height: 5 },
    screen: { width: 10, pixels: 128 },
    wavelengths: [0.45, 0.52, 0.62],
  };
}
const hasErr = (r, row, field) => r.errors.some((e) => e.row === row && e.field === field);

test('valid singlet passes', () => assert.ok(validateSystem(singlet()).ok));
test('radius 0 is rejected', () => {
  const s = singlet(); s.surfaces[1].radius = 0;
  const r = validateSystem(s); assert.ok(!r.ok); assert.ok(hasErr(r, 1, 'radius'));
});
test('negative thickness is rejected', () => {
  const s = singlet(); s.surfaces[1].thickness = -1;
  assert.ok(hasErr(validateSystem(s), 1, 'thickness'));
});
test('diameter <= 0 is rejected', () => {
  const s = singlet(); s.surfaces[2].diameter = 0;
  assert.ok(hasErr(validateSystem(s), 2, 'diameter'));
});
test('empty/NaN field is rejected', () => {
  const s = singlet(); s.surfaces[3].radius = NaN; s.surfaces[1].thickness = undefined;
  const r = validateSystem(s);
  assert.ok(hasErr(r, 3, 'radius')); assert.ok(hasErr(r, 1, 'thickness'));
});
test('bad model glass rejected', () => {
  const s = singlet(); s.surfaces[1].material = { type: 'model', nd: 0.9, vd: 50 };
  assert.ok(hasErr(validateSystem(s), 1, 'material'));
});
test('first must be object, last must be screen', () => {
  const s = singlet(); s.surfaces.pop();
  assert.ok(!validateSystem(s).ok);
  const t = singlet(); t.surfaces[0].kind = 'surface';
  assert.ok(!validateSystem(t).ok);
});
test('surfaceZ accumulates thicknesses', () => {
  const s = singlet();
  [200, 5, 0, 50].forEach((t, i) => (s.surfaces[i].thickness = t));
  assert.deepEqual(surfaceZ(s), [0, 200, 205, 205, 255]);
});
test('iris inherits preceding medium', () => {
  const s = singlet();
  assert.deepEqual(mediumAfter(s, 2), bk7);
  assert.deepEqual(mediumAfter(s, 3), air);
});
test('defaultSystem validates', () => assert.ok(validateSystem(defaultSystem()).ok, JSON.stringify(validateSystem(defaultSystem()).errors)));
