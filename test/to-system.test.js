import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemFromParts, fitSphere } from '../src/appearance/to-system.js';
import { partsFromSystem, lensProfile, rect } from '../src/appearance/scene.js';
import { importSTL, encodeMesh } from '../src/appearance/mesh.js';
import { defaultSystem } from '../src/core/system.js';
import { powerSummary } from '../src/core/focus.js';
import { revolveTris, boxTris, toBinarySTL } from './mesh-helpers.js';

const bk7 = { type: 'preset', name: 'N-BK7' }, oil = { type: 'model', nd: 1.54, vd: 24 };
let seq = 0;
const meshPart = (tris, material = bk7) => { const b = importSTL(toBinarySTL(tris)).bodies[0]; const id = `t${seq++}`; return { id, name: id, kind: 'mesh', mesh: { key: id, ...encodeMesh(b) }, material, coatings: {}, offset: [0, 0, 0], visible: true }; };
const surf = (sys) => sys.surfaces.filter((s) => s.kind === 'surface');

test('fitSphere recovers R and flat', () => {
  const R = -42, pts = Array.from({ length: 30 }, (_, i) => { const r = i * 0.3; return [r, R - Math.sign(R) * Math.sqrt(R * R - r * r)]; });
  assert.ok(Math.abs(fitSphere(pts).R - R) < 1e-9);
  assert.equal(fitSphere(pts.map(([r]) => [r, 0])).R, Infinity);
});

test('round trip: lens data → appearance parts → lens data reproduces radii, thicknesses, materials and power', () => {
  const sys = defaultSystem();
  const { parts } = partsFromSystem(sys, { iris: false });
  const r = systemFromParts(parts, sys);
  assert.ok(r.ok, r.message);
  const a = surf(sys), b = surf(r.system);
  assert.equal(b.length, a.length);
  a.forEach((s, i) => {
    assert.ok(Math.abs(b[i].radius - s.radius) / Math.abs(s.radius) < 1e-6, `R ${b[i].radius} vs ${s.radius}`);
    assert.deepEqual(b[i].material.type, s.material.type);
    if (i < a.length - 1) assert.ok(Math.abs(b[i].thickness - s.thickness) < 1e-5);
  });
  const p0 = powerSummary(sys), p1 = powerSummary(r.system);
  assert.ok(Math.abs(p1.efl / p0.efl - 1) < 1e-6);
  assert.ok(Math.abs(r.aperture - 10) < 0.5);
  assert.deepEqual(r.warnings, []);
});

test('STL mesh lens converts to the same sphere radii within 0.2 %', () => {
  const r = systemFromParts([meshPart(revolveTris(lensProfile(0, 30, 10, 4, -60, 10), 256))], defaultSystem());
  assert.ok(r.ok, r.message);
  const s = surf(r.system);
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0].radius / 30 - 1) < 2e-3, `${s[0].radius}`);
  assert.ok(Math.abs(s[1].radius / -60 - 1) < 2e-3, `${s[1].radius}`);
  assert.ok(Math.abs(s[0].thickness - 4) < 1e-3);
});

test('cavity medium becomes the gap material; off-axis parts are reported', () => {
  const cup = { start: [0, 0], segments: [{ type: 'line', to: [10, 0] }, { type: 'line', to: [10, 3] }, { type: 'line', to: [5, 3] }, { type: 'line', to: [5, 2] }, { type: 'line', to: [0, 2] }, { type: 'line', to: [0, 0] }] };
  const parts = [meshPart(revolveTris(cup, 64)), meshPart(boxTris(-12, 12, -12, 12, 3, 5)), { id: 'c', kind: 'cavity', material: oil }];
  const r = systemFromParts(parts, defaultSystem());
  assert.ok(r.ok, r.message);
  assert.deepEqual(surf(r.system).map((s) => s.material.type), ['preset', 'model', 'preset', 'air']);
  assert.deepEqual(surf(r.system).map((s) => s.thickness).slice(0, 3), [2, 1, 2]);
  assert.ok(Math.abs(r.aperture - 5) < 0.6); // 空洞の径で決まる
  const off = { ...meshPart(boxTris(20, 30, 20, 30, 0, 2)) };
  assert.equal(systemFromParts([off], defaultSystem()).ok, false);
});
