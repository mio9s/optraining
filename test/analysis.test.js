import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflectanceVsAngle, reflectanceVsWavelength, lineProfile, boundaryContrast, contributionTable } from '../src/appearance/analysis.js';
import { COATINGS } from '../src/appearance/thinfilm.js';

test('reflectance vs angle: Brewster dip for p, grazing → 1', () => {
  const r = reflectanceVsAngle(1, [], 1.5, 0.55, 0.5);
  const ib = Math.round(((Math.atan(1.5) * 180) / Math.PI) * 2);
  assert.ok(r.Rp[ib] < 1e-4, String(r.Rp[ib]));
  assert.ok(r.R[r.R.length - 1] > 0.9);
  assert.ok(Math.abs(r.R[0] - 0.04) < 1e-12);
});
test('reflectance vs wavelength for MgF2 is minimum near 550 nm', () => {
  const r = reflectanceVsWavelength(() => 1, COATINGS.mgf2.layers, () => 1.5168, 0);
  const i = r.R.indexOf(Math.min(...r.R));
  assert.ok(Math.abs(r.nm[i] - 550) <= 10);
});
test('line profile samples bilinearly along the line', () => {
  const w = 10, h = 2, Y = new Float32Array(w * h).map((_, i) => i % w);
  const p = lineProfile(Y, w, h, [0.5, 1], [9.5, 1], 10);
  p.values.forEach((v, i) => assert.ok(Math.abs(v - i) < 1e-6));
});
test('boundary contrast and verdict', () => {
  const flat = new Array(50).fill(0.5);
  const line = [...flat]; line[25] = 0.53; // +6 %
  const c = boundaryContrast(line);
  assert.ok(Math.abs(c.contrast - 0.06) < 1e-9 && c.visible && c.index === 25);
  const faint = [...flat]; faint[20] = 0.505; // +1 %
  assert.ok(!boundaryContrast(faint).visible);
  assert.ok(boundaryContrast(faint, 0.005).visible);
  const dark = [...flat]; dark[30] = 0.45; // −10 %(暗い線)
  assert.ok(boundaryContrast(dark).contrast < -0.09);
});
test('contribution table sorted with fractions', () => {
  const t = contributionTable({ a: 1, b: 3, c: 0 }, 8, { a: 'A' });
  assert.deepEqual(t.map((r) => r.key), ['b', 'a']);
  assert.equal(t[1].name, 'A');
  assert.ok(Math.abs(t[0].fraction - 0.375) < 1e-12);
});
