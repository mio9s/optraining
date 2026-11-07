import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflectanceVsAngle, reflectanceVsWavelength, lineProfile, boundaryContrast, contributionTable } from '../../src/appearance/analysis.js';
import { COATINGS } from '../../src/appearance/thinfilm.js';

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
  // 3 画素幅の境界(平滑化しても値が保たれる)
  const line = [...flat]; line[24] = line[25] = line[26] = 0.53; // +6 %
  const c = boundaryContrast(line);
  assert.ok(Math.abs(c.contrast - 0.06) < 1e-9 && c.visible && c.index === 25, JSON.stringify(c));
  const faint = [...flat]; faint[19] = faint[20] = faint[21] = 0.505; // +1 %
  assert.ok(!boundaryContrast(faint).visible);
  assert.ok(boundaryContrast(faint, 0.005).visible);
  const dark = [...flat]; dark[29] = dark[30] = dark[31] = 0.45; // −10 %(暗い線)
  assert.ok(boundaryContrast(dark).contrast < -0.09);
});
test('noise-only profile is not judged visible', () => {
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noisy = Array.from({ length: 200 }, () => 0.5 * (1 + 0.04 * (rnd() - 0.5) * 2)); // ±4 % の白色ノイズ
  const c = boundaryContrast(noisy);
  assert.notEqual(c.verdict, 'visible');
  assert.ok(c.noise > 0.005);
});
test('contribution table sorted with fractions', () => {
  const t = contributionTable({ a: 1, b: 3, c: 0 }, 8, { a: 'A' });
  assert.deepEqual(t.map((r) => r.key), ['b', 'a']);
  assert.equal(t[1].name, 'A');
  assert.ok(Math.abs(t[0].fraction - 0.375) < 1e-12);
});

test('smooth background gradient is not a boundary; a line on a gradient is', () => {
  const grad = Array.from({ length: 200 }, (_, i) => 0.23 - (0.01 * i) / 199); // 0.23 → 0.22(±2.3 %)
  assert.equal(boundaryContrast(grad).verdict, 'invisible');
  const withLine = [...grad]; for (const i of [99, 100, 101]) withLine[i] *= 1.05;
  const c = boundaryContrast(withLine);
  assert.equal(c.verdict, 'visible'); assert.ok(Math.abs(c.contrast - 0.05) < 0.005, String(c.contrast));
});
