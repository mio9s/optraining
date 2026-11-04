import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceScene, intersect, interfaceAt } from '../src/appearance/nstrace.js';
import { partsFromSystem, rect } from '../src/appearance/scene.js';
import { refract } from '../src/core/trace.js';
import { traceRay, aimRay } from '../src/core/trace.js';
import { defaultSystem, SAMPLE_SYSTEMS } from '../src/core/system.js';
import { oilSystem } from './scene.test.js';

/** 透過だけを選んで追跡(検証用) */
function transmitPath(scene, o, d, lambda) {
  const pts = [o], events = [];
  for (let k = 0; k < 50; k++) {
    const hit = intersect(scene, o, d);
    if (!hit) break;
    const f = interfaceAt(scene, hit, d, lambda);
    events.push(f);
    const nd = refract(d, f.normal, f.nBefore, f.nAfter);
    pts.push(hit.point);
    if (!nd) return { pts, events, tir: true, d };
    o = hit.point; d = nd;
  }
  return { pts, events, d };
}

function compare(sys, objPoint, px, py, lambda) {
  const { parts } = partsFromSystem(sys, { iris: false });
  const scene = buildTraceScene(parts);
  const r = aimRay(sys, objPoint, lambda, px, py);
  const seq = traceRay(sys, r);
  assert.ok(seq.alive);
  const ns = transmitPath(scene, r.p, r.d, lambda);
  // 逐次の屈折面の交点(iris・スクリーンを除く、前後で屈折率が変わる面)
  const surfPts = seq.points.filter((_, i) => sys.surfaces[i]?.kind === 'surface');
  assert.equal(ns.pts.length - 1, surfPts.length, `events ${ns.pts.length - 1} vs ${surfPts.length}`);
  ns.pts.slice(1).forEach((p, i) => {
    const q = surfPts[i];
    assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 2e-4, `point ${i}: ${p} vs ${q}`);
  });
  const dd = seq.final.d;
  assert.ok(Math.hypot(ns.d[0] - dd[0], ns.d[1] - dd[1], ns.d[2] - dd[2]) < 1e-6, `dir ${ns.d} vs ${dd}`);
  return ns;
}

test('non-sequential transmit path equals sequential trace (achromat, meridional and skew)', () => {
  const sys = defaultSystem();
  compare(sys, [0, 0, 0], 0, 0.8, 0.52);
  compare(sys, [0, 6, 0], 0.5, -0.6, 0.45);
  compare(sys, [-3, 4, 0], 0.7, 0.3, 0.62);
});
test('oil-coupled system: shared faces are single interfaces with correct media', () => {
  const sys = oilSystem();
  const ns = compare(sys, [0, 20, 0], 0.3, 0.6, 0.52);
  assert.equal(ns.events.length, 5);
  const n = ns.events.map((e) => [e.nBefore.toFixed(4), e.nAfter.toFixed(4)].join('→'));
  assert.equal(n[0], '1.0000→1.5202'); // 空気→BK7
  assert.equal(n[1], '1.5202→1.5494'); // BK7→オイル(共有面)
  assert.equal(n[2], '1.5494→1.0000'); // オイル→空気
  assert.equal(n[3], '1.0000→1.5202'); // 空気→BK7 平板
  assert.equal(n[4], '1.5202→1.0000');
});
test('ray from the side hits the edge cylinder; TIR inside is detected', () => {
  const scene = buildTraceScene([{ id: 'a', name: 'blk', profile: rect(0, 10, 0, 5), material: { type: 'model', nd: 1.5, vd: 1e12 }, coatings: {}, visible: true }]);
  // 横(+x 方向)から入る
  const h = intersect(scene, [-20, 0, 2.5], [1, 0, 0]);
  assert.ok(Math.abs(h.point[0] + 10) < 1e-9);
  const f = interfaceAt(scene, h, [1, 0, 0], 0.55);
  assert.equal(f.nBefore, 1); assert.ok(Math.abs(f.nAfter - 1.5) < 1e-9);
  assert.ok(Math.abs(f.normal[0] + 1) < 1e-9);
  // 内部から上面へ 60° で当たる → 全反射
  const o = [0, 0, 2.5], d = [Math.sin(1.05), 0, Math.cos(1.05)];
  const h2 = intersect(scene, o, d);
  const f2 = interfaceAt(scene, h2, d, 0.55);
  assert.equal(refract(d, f2.normal, f2.nBefore, f2.nAfter), null);
});
test('coating is oriented: layers listed from outside into the part', () => {
  const part = { id: 'a', name: 'w', profile: rect(0, 10, 0, 5), material: { type: 'preset', name: 'N-BK7' }, coatings: { 0: 'vcoat' }, visible: true };
  const scene = buildTraceScene([part]);
  const enter = interfaceAt(scene, intersect(scene, [1, 0, -5], [0, 0, 1]), [0, 0, 1], 0.55);
  assert.equal(enter.layers[0].n, 1.38);
  // 前面(seg 0 は z = 0 の面)へ内側から出る
  const exit = interfaceAt(scene, intersect(scene, [1, 0, 2], [0, 0, -1]), [0, 0, -1], 0.55);
  assert.equal(exit.layers[0].n, 1.7);
});
test('BVH culling gives the same nearest hit as brute force', () => {
  const { parts } = partsFromSystem(SAMPLE_SYSTEMS.bk7.make());
  const scene = buildTraceScene(parts);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 200; k++) {
    const o = [(rnd() - 0.5) * 60, (rnd() - 0.5) * 60, 980 + rnd() * 50];
    const tgt = [(rnd() - 0.5) * 20, (rnd() - 0.5) * 20, 1000 + rnd() * 5];
    const v = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]], L = Math.hypot(...v), d = v.map((x) => x / L);
    const h = intersect(scene, o, d);
    // 総当たり
    const big = { list: scene.list.map((e) => ({ ...e, nodes: [{ z0: -1e9, z1: 1e9, r0: 0, r1: 1e9, leaf: true, lo: 0, hi: e.edges.length }] })), mediumAt: scene.mediumAt };
    const b = intersect(big, o, d);
    assert.equal(!!h, !!b);
    if (h) assert.ok(Math.abs(h.t - b.t) < 1e-9);
  }
});
