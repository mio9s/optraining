import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceRay, intersectSphere, refract, fanRays, findStop, aimRay } from '../../src/core/trace.js';
import { LINES } from '../../src/core/glass.js';
import { defaultSystem, surfaceZ } from '../../src/core/system.js';

const air = { type: 'air' };
const bk7 = { type: 'preset', name: 'N-BK7' };
function plano({ iris = null } = {}) {
  const S = [
    { kind: 'object', radius: Infinity, thickness: 10, material: air, diameter: 20 },
    { kind: 'surface', radius: 51.68, thickness: 4, material: bk7, diameter: 20 },
    { kind: 'surface', radius: Infinity, thickness: 100, material: air, diameter: 20 },
    { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 40 },
  ];
  if (iris) S.splice(1, 0, iris);
  return { surfaces: S, object: { height: 1 }, screen: { width: 10, pixels: 64 }, wavelengths: [LINES.d] };
}
const ray = (y, d = [0, 0, 1], x = 0) => ({ p: [x, y, 0], d, lambda: LINES.d, intensity: 1 });

test('on-axis ray passes straight', () => {
  const r = traceRay(plano(), ray(0));
  assert.ok(r.alive);
  for (const p of r.points) { assert.ok(Math.abs(p[0]) < 1e-12 && Math.abs(p[1]) < 1e-12); }
  assert.equal(r.points.length, 4);
});
test('Snell law at flat interface', () => {
  const s30 = Math.sin(Math.PI / 6);
  const t = refract([0, s30, Math.cos(Math.PI / 6)], [0, 0, 1], 1, 1.5);
  assert.ok(Math.abs(s30 / t[1] - 1.5) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...t) - 1) < 1e-12);
});
test('normal orientation does not matter', () => {
  const d = [0, 0.3, Math.sqrt(1 - 0.09)];
  assert.deepEqual(refract(d, [0, 0, 1], 1, 1.5), refract(d, [0, 0, -1], 1, 1.5));
});
test('sphere intersection: plane and sphere', () => {
  assert.ok(Math.abs(intersectSphere([0, 1, 0], [0, 0, 1], 5, Infinity) - 5) < 1e-12);
  // R=10 頂点 z=5, 高さ 6 → サグ 10-8=2 → z=7
  assert.ok(Math.abs(intersectSphere([0, 6, 0], [0, 0, 1], 5, 10) - 7) < 1e-12);
  assert.ok(Math.abs(intersectSphere([0, 6, 0], [0, 0, 1], 5, -10) - 3) < 1e-12);
  assert.equal(intersectSphere([0, 11, 0], [0, 0, 1], 5, 10), null);
});
test('BK7 plano-convex focus matches lensmaker', () => {
  const sys = plano();
  const h = 0.5;
  const r = traceRay(sys, ray(h));
  assert.ok(r.alive);
  const d = r.final.d;
  const efl = h / (-d[1] / d[2]);
  const n = 1.5168;
  const fTheory = 51.68 / (n - 1);
  assert.ok(Math.abs(efl / fTheory - 1) < 1e-3, `efl=${efl}`);
  // 光軸を横切る z は 後主点(平面側頂点 − t/n)から f の位置(BFL = f − t/n)
  const z = surfaceZ(sys);
  const last = r.points[2];
  const zCross = last[2] - last[1] * d[2] / d[1];
  const H2 = z[2] - 4 / n;
  assert.ok(Math.abs((zCross - H2) / fTheory - 1) < 1e-3, `f from H'=${zCross - H2}`);
});
test('ray outside diameter is vignetted', () => {
  const r = traceRay(plano(), ray(10.5));
  assert.equal(r.alive, false); assert.equal(r.reason, 'vignetted');
});
test('ray missing sphere returns miss', () => {
  const sys = plano(); sys.surfaces[1].diameter = 200;
  const r = traceRay(sys, ray(60));
  assert.equal(r.alive, false); assert.equal(r.reason, 'miss');
});
test('TIR returns tir', () => {
  // ガラス中から平面へ 60° 入射(n=1.5 → 臨界角 41.8°)
  const g = { type: 'model', nd: 1.5, vd: 60 };
  const sys = {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: 1, material: g, diameter: 100 },
      { kind: 'surface', radius: Infinity, thickness: 1, material: air, diameter: 100 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 100 },
    ], object: { height: 1 }, screen: { width: 1, pixels: 8 }, wavelengths: [0.5],
  };
  const r = traceRay(sys, { p: [0, 0, 0], d: [0, Math.sin(1.047), Math.cos(1.047)], lambda: 0.5, intensity: 1 });
  assert.equal(r.reason, 'tir');
});
test('iris at zero thickness acts as aperture', () => {
  const sys = plano({ iris: { kind: 'iris', radius: Infinity, thickness: 0, material: air, diameter: 2 } });
  sys.surfaces[0].thickness = 10;
  assert.equal(traceRay(sys, ray(1.5)).reason, 'vignetted');
  const ok = traceRay(sys, ray(0.5));
  assert.ok(ok.alive);
  assert.ok(ok.points.every((p) => p.every(Number.isFinite)));
});
test('findStop picks the limiting iris', () => {
  const sys = plano({ iris: { kind: 'iris', radius: Infinity, thickness: 0, material: air, diameter: 2 } });
  assert.equal(findStop(sys), 1);
  assert.equal(findStop(defaultSystem()), 1);
});
test('fanRays all hit stop inside its radius', () => {
  const sys = defaultSystem();
  const stop = findStop(sys);
  const R = sys.surfaces[stop].diameter / 2;
  const rays = fanRays(sys, [0, 7, 0], 0.52, 9);
  assert.ok(rays.length > 40);
  for (const r of rays) {
    const t = traceRay(sys, r, { toSurface: stop, ignoreApertures: true });
    const p = t.points[stop];
    assert.ok(Math.hypot(p[0], p[1]) <= R * (1 + 1e-6));
    assert.ok(Math.abs(p[0] - r.pupil[0] * R) < 1e-6 && Math.abs(p[1] - r.pupil[1] * R) < 1e-6);
  }
});
test('aimRay hits stop when stop is behind a lens', () => {
  const sys = defaultSystem();
  // iris を レンズ間に移動
  const iris = sys.surfaces.splice(1, 1)[0];
  sys.surfaces[0].thickness = 203;
  sys.surfaces[2].thickness = 0.25; iris.thickness = 0.25; iris.diameter = 8;
  sys.surfaces.splice(3, 0, iris);
  assert.equal(findStop(sys), 3);
  const r = aimRay(sys, [0, 8, 0], 0.45, 0, 1);
  const t = traceRay(sys, r, { toSurface: 3, ignoreApertures: true });
  assert.ok(Math.abs(t.points[3][1] - 4) < 1e-6, String(t.points[3][1]));
});
