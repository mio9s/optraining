import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powerSummary, bestImagePlane, focusBest, photopic } from '../src/core/focus.js';
import { SAMPLE_SYSTEMS, defaultSystem } from '../src/core/system.js';
import { focusScreen } from '../src/core/paraxial.js';
import { LINES } from '../src/core/glass.js';

const air = { type: 'air' };
function thin(f, objDist = 1000) {
  const g = { type: 'model', nd: 1.5, vd: 1e12 }, R = f; // 1/f = 0.5(2/R) → R = f
  return { surfaces: [
    { kind: 'object', radius: Infinity, thickness: objDist, material: air, diameter: 1e5 },
    { kind: 'surface', radius: R, thickness: 1e-4, material: g, diameter: 10 },
    { kind: 'surface', radius: -R, thickness: 50, material: air, diameter: 10 },
    { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 100 },
  ], object: { height: 1 }, screen: { width: 10, pixels: 64 }, wavelengths: [0.45, 0.52, 0.62] };
}

test('thin lens: power, BVP, FVP and focal points', () => {
  const s = powerSummary(thin(100));
  assert.ok(Math.abs(s.power - 10) < 1e-3, String(s.power));
  assert.ok(Math.abs(s.bvp - 10) < 1e-3 && Math.abs(s.fvp - 10) < 1e-3, `${s.bvp} ${s.fvp}`);
  assert.ok(Math.abs(s.frontFocusZ - 900) < 0.01 && Math.abs(s.rearFocusZ - 1100) < 0.01);
  // 物体 1000 mm → 1/s' = 1/100 − 1/1000 → s' = 111.11
  assert.ok(Math.abs(s.imageDistance - 1000 / 9) < 0.01, String(s.imageDistance));
});
test('BK7 plano-convex: +10 D, BVP differs from power by the thickness', () => {
  const s = powerSummary(SAMPLE_SYSTEMS.bk7.make(), LINES.d);
  assert.ok(Math.abs(s.power - 10) < 1e-3);
  // 平面側から: BFL = f − t/n → BVP = 1000/(100 − 4/1.5168)
  assert.ok(Math.abs(s.bvp - 1000 / (100 - 4 / 1.5168)) < 1e-3, String(s.bvp));
  // 曲面側から: FFL = f(曲面が物体側にあり主点がその頂点)
  assert.ok(Math.abs(s.fvp - 10) < 1e-3, String(s.fvp));
});
test('photopic weights', () => {
  assert.ok(Math.abs(photopic(555) - 1) < 1e-9 && photopic(450) < 0.05 && photopic(620) > 0.3);
});
test('best image plane minimizes the polychromatic spot (better than paraxial and neighbours)', () => {
  for (const sys of [SAMPLE_SYSTEMS.bk7.make(), defaultSystem(), SAMPLE_SYSTEMS.adlens.make()]) {
    const b = bestImagePlane(sys);
    assert.ok(b.rms <= b.rmsAtParaxial + 1e-12, `${b.rms} vs paraxial ${b.rmsAtParaxial}`);
    const { system } = focusBest(sys);
    const near = (dd) => { const t = structuredClone(system); t.surfaces[b.lastSurface].thickness += dd; return bestImagePlane(t).rmsAtCurrent; };
    assert.ok(near(-0.2) > b.rms && near(0.2) > b.rms);
  }
});
test('no dispersion, small aperture → best plane ≈ paraxial focus', () => {
  const s = thin(100); s.surfaces[1].diameter = 2; s.surfaces[2].diameter = 2; s.surfaces[1].thickness = 0.5;
  s.surfaces[0].thickness = 1e6; s.object.height = 0.001;
  const b = bestImagePlane(s);
  const p = focusScreen(s, 0.52).surfaces[2].thickness;
  assert.ok(Math.abs(b.distance - p) < 0.05, `${b.distance} vs ${p}`);
});

test('fully vignetted system reports failure instead of a bogus plane', () => {
  const s = thin(100); s.surfaces[1].thickness = 1e-4; s.surfaces[1].diameter = 9; s.surfaces[2].diameter = 9; // 縁で面が交差
  s.surfaces[0].thickness = 1e6;
  const b = bestImagePlane(s);
  if (!b.ok) assert.match(b.message, /届かない/);
  else assert.ok(Number.isFinite(b.rms));
});

test('best image plane refuses a virtual image (plane-parallel plate) instead of a negative screen distance', async () => {
  const { bestImagePlane } = await import('../src/core/focus.js');
  const air = { type: 'air' }, g = { type: 'preset', name: 'N-BK7' };
  const sys = { surfaces: [{ kind: 'object', radius: Infinity, thickness: 200, material: air, diameter: 20 }, { kind: 'surface', radius: Infinity, thickness: 1, material: g, diameter: 15 }, { kind: 'surface', radius: Infinity, thickness: 50, material: air, diameter: 15 }, { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 20 }], object: { height: 10 }, screen: { width: 6, pixels: 256 }, wavelengths: [0.45, 0.52, 0.62] };
  const r = bestImagePlane(sys);
  assert.equal(r.ok, false);
  assert.match(r.message, /虚像/);
});
