import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tessellate, validateProfile, containsPoint, sphericalSegment, asphereSag, segmentEvaluator, translateProfile, TOL } from '../../src/appearance/profile.js';

export function planoConvex(R = 51.68, t = 4, rEdge = 12.5) {
  const front = sphericalSegment(0, R, 0, rEdge);
  return {
    start: front.from,
    segments: [front.seg, { type: 'line', to: [rEdge, t] }, { type: 'line', to: [0, t] }, { type: 'line', to: front.from }],
  };
}
const sphereZ = (R, r) => R - Math.sqrt(R * R - r * r);

test('arc tessellation follows the sphere within 0.1 µm (vertices and chord midpoints)', () => {
  const R = 51.68, edges = tessellate(planoConvex(R));
  const front = edges.filter((e) => e.seg === 0);
  assert.ok(front.length > 20);
  for (const e of front) {
    for (const p of [e.a, e.b]) assert.ok(Math.abs(p[1] - sphereZ(R, p[0])) < 1e-9);
    const m = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    assert.ok(Math.abs(m[1] - sphereZ(R, m[0])) < TOL * 1.01);
  }
});
test('outward normals: front vertex points to −z, edge to +r, back to +z', () => {
  const edges = tessellate(planoConvex());
  const f = edges.find((e) => e.seg === 0);
  assert.ok(Math.abs(f.na[0]) < 1e-9 && Math.abs(f.na[1] + 1) < 1e-9, String(f.na));
  const side = edges.find((e) => e.seg === 1);
  assert.ok(Math.abs(side.na[0] - 1) < 1e-9);
  const back = edges.find((e) => e.seg === 2);
  assert.ok(Math.abs(back.na[1] - 1) < 1e-9);
  assert.ok(edges.find((e) => e.seg === 3).onAxis);
  // 曲線の法線は球の中心を向く(外向き = 中心と反対)
  const e = edges.filter((x) => x.seg === 0)[10];
  const toC = [0 - e.a[0], 51.68 - e.a[1]], L = Math.hypot(...toC);
  assert.ok(Math.abs(e.na[0] + toC[0] / L) < 1e-9 && Math.abs(e.na[1] + toC[1] / L) < 1e-9);
});
test('orientation independent normals (reversed contour)', () => {
  const p = planoConvex();
  // 逆回りで同じ形を作る
  const rev = { start: [0, 0], segments: [{ type: 'line', to: [0, 4] }, { type: 'line', to: [12.5, 4] }, { type: 'line', to: p.segments[0].to }, { type: 'arc', to: [0, 0], center: p.segments[0].center, ccw: !p.segments[0].ccw }] };
  assert.ok(validateProfile(rev).ok, validateProfile(rev).errors.join());
  const back = tessellate(rev).find((e) => e.seg === 1);
  assert.ok(Math.abs(back.na[1] - 1) < 1e-9);
});
test('validate: closed, self-intersection, r < 0', () => {
  assert.ok(validateProfile(planoConvex()).ok);
  const open = planoConvex(); open.segments.pop();
  assert.ok(!validateProfile(open).ok);
  const bow = { start: [0, 0], segments: [{ type: 'line', to: [5, 5] }, { type: 'line', to: [5, 0] }, { type: 'line', to: [0, 5] }, { type: 'line', to: [0, 0] }] };
  assert.ok(validateProfile(bow).errors.some((m) => m.includes('交差')));
  const neg = { start: [0, 0], segments: [{ type: 'line', to: [-1, 1] }, { type: 'line', to: [0, 2] }, { type: 'line', to: [0, 0] }] };
  assert.ok(validateProfile(neg).errors.some((m) => m.includes('r < 0')));
});
test('containsPoint', () => {
  const e = tessellate(planoConvex());
  assert.ok(containsPoint(e, 5, 2));
  assert.ok(!containsPoint(e, 5, -0.1));
  assert.ok(!containsPoint(e, 13, 2));
  assert.ok(!containsPoint(e, 5, 4.1));
});
test('asphere with k=0, no A equals sphere; parabola k=-1', () => {
  const c = 1 / 40;
  for (const r of [0, 3, 8, 12]) {
    assert.ok(Math.abs(asphereSag({ z0: 1, c, k: 0 }, r) - (1 + sphereZ(40, r))) < 1e-12);
    assert.ok(Math.abs(asphereSag({ z0: 0, c, k: -1 }, r) - (c * r * r) / 2) < 1e-12);
  }
  const seg = { type: 'asphere', z0: 0, c, k: -0.5, A: [1e-6], to: [10, asphereSag({ z0: 0, c, k: -0.5, A: [1e-6] }, 10)] };
  const p = { start: [0, 0], segments: [seg, { type: 'line', to: [10, 5] }, { type: 'line', to: [0, 5] }, { type: 'line', to: [0, 0] }] };
  assert.ok(validateProfile(p).ok, validateProfile(p).errors.join());
  for (const e of tessellate(p).filter((x) => x.seg === 0)) assert.ok(Math.abs(e.a[1] - asphereSag(seg, e.a[0])) < 1e-9);
});
test('bezier and spline pass through their end/through points', () => {
  const b = segmentEvaluator([0, 0], { type: 'bezier', c1: [1, 2], c2: [3, 2], to: [4, 0] });
  assert.deepEqual(b.at(0), [0, 0]); assert.deepEqual(b.at(1), [4, 0]);
  const s = segmentEvaluator([0, 0], { type: 'spline', through: [[1, 1], [2, 0.5]], to: [3, 2] });
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
  assert.ok(near(s.at(0), [0, 0]) && near(s.at(1), [3, 2]));
  // 通過点を通る(t は弦長比)
  let hit1 = false;
  for (let i = 0; i <= 2000; i++) if (near(s.at(i / 2000), [1, 1]) || Math.hypot(s.at(i / 2000)[0] - 1, s.at(i / 2000)[1] - 1) < 2e-3) hit1 = true;
  assert.ok(hit1);
});
test('translateProfile shifts z only', () => {
  const p = translateProfile(planoConvex(), 10);
  const e = tessellate(p).filter((x) => x.seg === 0);
  for (const x of e) assert.ok(Math.abs(x.a[1] - 10 - sphereZ(51.68, x.a[0])) < 1e-9);
});
