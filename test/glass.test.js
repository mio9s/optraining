import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refractiveIndex, abbeFromPreset, listPresets, LINES, WAVELENGTHS } from '../src/core/glass.js';
import { add, sub, scale, dot, norm, normalize, cross } from '../src/core/vec.js';

test('N-BK7 preset nd matches catalog', () => {
  assert.ok(Math.abs(refractiveIndex({ type: 'preset', name: 'N-BK7' }, LINES.d) - 1.5168) < 1e-4);
});
test('N-BK7 preset Abbe number ~64.17', () => {
  const { vd } = abbeFromPreset('N-BK7');
  assert.ok(Math.abs(vd - 64.17) < 0.05, `vd=${vd}`);
});
test('fused silica nd ~1.4585', () => {
  assert.ok(Math.abs(refractiveIndex({ type: 'preset', name: 'Fused Silica' }, LINES.d) - 1.4585) < 2e-4);
});
test('model glass reproduces nd and vd', () => {
  const m = { type: 'model', nd: 1.6, vd: 40 };
  const n = (l) => refractiveIndex(m, l);
  assert.ok(Math.abs(n(LINES.d) - 1.6) < 1e-9);
  assert.ok(Math.abs((n(LINES.d) - 1) / (n(LINES.F) - n(LINES.C)) - 40) < 1e-9);
});
test('blue index > red index (normal dispersion)', () => {
  const m = { type: 'model', nd: 1.5168, vd: 64.17 };
  assert.ok(refractiveIndex(m, 0.45) > refractiveIndex(m, 0.62));
});
test('air is 1.0', () => assert.equal(refractiveIndex({ type: 'air' }, 0.52), 1));
test('presets listed with nd/vd', () => {
  const p = listPresets();
  assert.ok(p.length >= 8);
  assert.ok(p.every((g) => g.nd > 1.4 && g.vd > 20));
});
test('wavelengths default', () => assert.deepEqual(WAVELENGTHS, [0.45, 0.52, 0.62]));
test('vector helpers', () => {
  assert.deepEqual(add([1, 2, 3], [1, 1, 1]), [2, 3, 4]);
  assert.deepEqual(sub([1, 2, 3], [1, 1, 1]), [0, 1, 2]);
  assert.deepEqual(scale([1, 2, 3], 2), [2, 4, 6]);
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
  assert.equal(norm([3, 4, 0]), 5);
  assert.deepEqual(normalize([0, 0, 2]), [0, 0, 1]);
  assert.deepEqual(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
});
