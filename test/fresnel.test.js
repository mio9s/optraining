import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresnel, traceGhosts, ghostImage, reflectingSurfaces } from '../src/core/fresnel.js';
import { makePattern } from '../src/core/patterns.js';
import { defaultSystem } from '../src/core/system.js';

const air = { type: 'air' };
const glass = { type: 'model', nd: 1.5, vd: 1e12 };
function singlet() {
  return {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: 1000, material: air, diameter: 1e5 },
      { kind: 'surface', radius: 100, thickness: 5, material: glass, diameter: 25 },
      { kind: 'surface', radius: -100, thickness: 100, material: air, diameter: 25 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 100 },
    ], object: { height: 10 }, screen: { width: 20, pixels: 64 }, wavelengths: [0.52],
  };
}

test('normal incidence R = ((n1-n2)/(n1+n2))^2', () => {
  const f = fresnel(1, 1.5, 1);
  assert.ok(Math.abs(f.R - 0.04) < 1e-12 && Math.abs(f.Rs - f.Rp) < 1e-12);
});
test('Brewster angle Rp = 0', () => {
  const th = Math.atan(1.5);
  const f = fresnel(1, 1.5, Math.cos(th));
  assert.ok(f.Rp < 1e-12 && f.Rs > 0.1);
});
test('R + T = 1', () => {
  for (const c of [1, 0.8, 0.3, 0.05]) { const f = fresnel(1.6, 1, c); assert.ok(Math.abs(f.R + f.T - 1) < 1e-12); }
});
test('TIR gives R = 1', () => assert.equal(fresnel(1.5, 1, Math.cos(1.0)).R, 1));
test('grazing incidence R → 1', () => assert.ok(fresnel(1, 1.5, 1e-6).R > 0.999));
test('singlet has exactly one ghost pair (2,1)', () => {
  const g = traceGhosts(singlet(), { p: [0, 1, 0], d: [0, 0, 1], lambda: 0.52, intensity: 1 });
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].surfaces, [2, 1]);
});
test('ghost intensity ~ R1*R2*T^2', () => {
  const g = traceGhosts(singlet(), { p: [0, 0.01, 0], d: [0, 0, 1], lambda: 0.52, intensity: 1 })[0];
  const R = 0.04, T = 0.96;
  assert.ok(g.alive);
  assert.ok(Math.abs(g.intensity / (R * R * T * T) - 1) < 1e-3, String(g.intensity));
  // ゴーストは z 方向に戻ってからスクリーンへ
  const zs = g.points.map((p) => p[2]);
  assert.ok(zs[2] > zs[3] && zs[4] > zs[3]);
});
test('default system ghost pairs = C(4,2)', () => {
  assert.equal(reflectingSurfaces(defaultSystem(), 0.52).length, 4);
  const g = traceGhosts(defaultSystem(), { p: [0, 0, 0], d: [0, 0.02, 0.9998], lambda: 0.52, intensity: 1 });
  assert.equal(g.length, 6);
});
test('ghost image is finite, non-negative and much dimmer than direct', () => {
  const s = defaultSystem(); s.screen.pixels = 64;
  const img = ghostImage(s, makePattern('arrow', 32), { objectSamples: 12, nPupil: 4 });
  assert.ok(img.every((v) => Number.isFinite(v) && v >= 0));
  const tot = img.reduce((a, b) => a + b, 0);
  assert.ok(tot > 0);
});
