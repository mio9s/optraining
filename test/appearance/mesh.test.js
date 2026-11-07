import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importSTL, buildMeshAccel, meshHits, meshContains, encodeMesh, decodeMesh, transformVertices, signedVolume, orientOutward, weld } from '../../src/appearance/mesh.js';
import { boxTris, revolveTris, toBinarySTL, toAsciiSTL } from '../helpers/mesh-helpers.js';
import { lensProfile } from '../../src/appearance/scene.js';

test('binary STL box: welded, closed, volume and bounds', () => {
  const r = importSTL(toBinarySTL(boxTris(0, 10, 0, 20, 0, 5)));
  assert.equal(r.bodies.length, 1);
  const b = r.bodies[0];
  assert.equal(b.V.length / 3, 8); assert.equal(b.triangles, 12); assert.equal(b.open, 0);
  assert.ok(Math.abs(b.volume - 1000) < 1e-6);
  assert.deepEqual(b.bounds.hi, [10, 20, 5]);
});
test('ASCII STL with two solids and inverted winding', () => {
  const inv = boxTris(0, 1, 0, 1, 0, 1); // 巻き方向を反転
  for (let i = 0; i < inv.length; i += 9) for (let k = 0; k < 3; k++) { const t = inv[i + 3 + k]; inv[i + 3 + k] = inv[i + 6 + k]; inv[i + 6 + k] = t; }
  const r = importSTL(toAsciiSTL([['A', boxTris(0, 1, 0, 1, 0, 1)], ['B', inv]]));
  assert.equal(r.bodies.length, 2);
  assert.ok(r.bodies[1].flipped);
  assert.ok(signedVolume(r.bodies[1]) > 0 && signedVolume(r.bodies[0]) > 0);
});
test('disconnected shells in one binary STL are split into separate bodies', () => {
  const two = Float32Array.from([...boxTris(0, 1, 0, 1, 0, 1), ...boxTris(5, 6, 0, 1, 0, 1)]);
  assert.equal(importSTL(toBinarySTL(two)).bodies.length, 2);
  assert.equal(importSTL(toBinarySTL(two), { split: false }).bodies.length, 1);
});
test('open mesh is reported', () => {
  const t = boxTris(0, 1, 0, 1, 0, 1).slice(0, 9 * 10); // 2 枚抜く
  const r = importSTL(toBinarySTL(t));
  assert.ok(r.bodies[0].open > 0 && r.warnings.length === 1);
});
test('axis mapping keeps right-handedness, scale and offset', () => {
  const V = Float64Array.from([1, 2, 3]);
  assert.deepEqual([...transformVertices(V, { axis: 'x' })], [2, 3, 1]); // 図面の x が光軸 Z に
  assert.deepEqual([...transformVertices(V, { axis: 'y' })], [3, 1, 2]);
  transformVertices(V, { scale: 25.4, offset: [0, 0, 10] }).forEach((v, i) => assert.ok(Math.abs(v - [25.4, 50.8, 86.2][i]) < 1e-9));
  assert.deepEqual([...transformVertices(V, { flip: true })], [-1, 2, -3]);
  // 巡回置換・反転のあとも体積の符号(=右手系)が保たれる
  const m = weld(boxTris(0, 2, 0, 3, 0, 4));
  for (const o of [{ axis: 'x' }, { axis: 'y' }, { flip: true }]) assert.ok(signedVolume({ V: transformVertices(m.V, o), F: m.F }) > 0);
});
test('encode/decode round trip', () => {
  const m = weld(boxTris(0, 1, 0, 2, 0, 3));
  const d = decodeMesh(encodeMesh(m));
  assert.deepEqual([...d.F], [...m.F]);
  assert.ok(d.V.every((v, i) => Math.abs(v - m.V[i]) < 1e-6));
});
test('ray-mesh hits: box faces, normals outward, containment', () => {
  const acc = buildMeshAccel(orientOutward(weld(boxTris(-5, 5, -5, 5, 0, 4))));
  const hits = []; meshHits(acc, [1, 2, -10], [0, 0, 1], 1e-9, Infinity, hits);
  hits.sort((a, b) => a.t - b.t);
  assert.equal(hits.length, 2);
  assert.ok(Math.abs(hits[0].t - 10) < 1e-9 && Math.abs(hits[1].t - 14) < 1e-9);
  assert.ok(hits[0].gnormal[2] < -0.999 && hits[1].gnormal[2] > 0.999); // 前面は −z、後面は +z
  assert.ok(meshContains(acc, [0, 0, 2]) && !meshContains(acc, [0, 0, 5]) && !meshContains(acc, [6, 0, 2]));
});
test('smooth normals on a revolved lens follow the sphere; edges stay sharp', () => {
  const R = 51.68, prof = lensProfile(0, R, 12.5, 4, Infinity, 12.5);
  const acc = buildMeshAccel(orientOutward(weld(revolveTris(prof, 128))), { creaseDeg: 30 });
  const hits = []; meshHits(acc, [3, 4, -10], [0, 0, 1], 1e-9, Infinity, hits);
  hits.sort((a, b) => a.t - b.t);
  const n = hits[0].normal, c = [0, 0, R], p = [3, 4, hits[0].t - 10];
  const exp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], L = Math.hypot(...exp);
  const dot = (n[0] * exp[0] + n[1] * exp[1] + n[2] * exp[2]) / L; // 外向き = 球の中心から交点への向き
  assert.ok(dot > 0.99999, String(dot));
  // 平らな後面の法線は +z のまま(コバとの角で丸まらない)
  assert.ok(hits[1].normal[2] > 0.99999);
});

test('one STL with two cemented lenses (shared face, non-manifold edges) splits into two closed bodies', async () => {
  const { lensProfile } = await import('../../src/appearance/scene.js');
  const a = revolveTris(lensProfile(0, 30, 10, 4, -60, 10), 64);
  const b = revolveTris(lensProfile(4, -60, 10, 6, Infinity, 10), 64);
  const all = new Float32Array(a.length + b.length); all.set(a); all.set(b, a.length);
  // 外向き(STL の標準)と内向き(テスト用の回転体は内向き)の両方
  const out = Float32Array.from(all);
  for (let i = 0; i < out.length; i += 9) for (let k = 0; k < 3; k++) { const x = out[i + 3 + k]; out[i + 3 + k] = out[i + 6 + k]; out[i + 6 + k] = x; }
  const r2 = importSTL(toBinarySTL(out));
  assert.equal(r2.bodies.length, 2);
  for (const body of r2.bodies) { assert.equal(body.open, 0); assert.equal(body.flipped, false); }
  const r = importSTL(toBinarySTL(all));
  assert.equal(r.bodies.length, 2);
  for (const body of r.bodies) { assert.equal(body.open, 0); assert.equal(body.flipped, true); }
  assert.deepEqual(r2.warnings, []);
  const zs = r.bodies.map((x) => [+x.bounds.lo[2].toFixed(3), +x.bounds.hi[2].toFixed(3)]).sort((p, q) => p[0] - q[0]);
  assert.equal(zs[0][1] > 3 && zs[0][1] < 4.01, true);
  assert.equal(zs[1][0] > 3, true);
});

test('zero-volume CAD fragments are dropped with a warning, the real body kept', () => {
  const box = boxTris(0, 10, 0, 10, 0, 2);
  const sliver = Float32Array.from([3, 3, 1, 3.1, 3, 1, 3, 3.1, 1]); // 1 枚の面(体積 0、開いた立体)
  const all = new Float32Array(box.length + sliver.length); all.set(box); all.set(sliver, box.length);
  const r = importSTL(toBinarySTL(all));
  assert.equal(r.bodies.length, 1);
  assert.equal(r.bodies[0].open, 0);
  assert.ok(r.warnings.some((w) => w.includes('微小な断片')));
});

test('CAD ↔ scene coordinates are inverse for every axis / flip, and name the perpendicular CAD axes', async () => {
  const { cadToScene, sceneToCad, perpAxes } = await import('../../src/appearance/mesh.js');
  for (const axis of ['x', 'y', 'z']) for (const flip of [false, true]) {
    const f = { axis, flip, scale: 25.4 }, p = [1.5, -2, 3.25];
    const q = cadToScene(p, f);
    sceneToCad(q, f).forEach((v, k) => assert.ok(Math.abs(v - p[k]) < 1e-12));
    // シーンの z は光軸にした図面の軸
    const iz = { x: 0, y: 1, z: 2 }[axis];
    assert.ok(Math.abs(Math.abs(q[2]) - Math.abs(p[iz]) * 25.4) < 1e-9);
    const [a, b] = perpAxes(axis), ia = 'XYZ'.indexOf(a), ib = 'XYZ'.indexOf(b);
    assert.ok(Math.abs(Math.abs(q[0]) - Math.abs(p[ia]) * 25.4) < 1e-9 && Math.abs(Math.abs(q[1]) - Math.abs(p[ib]) * 25.4) < 1e-9);
  }
});
