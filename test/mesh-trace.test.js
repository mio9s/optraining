// STL メッシュ部品の非逐次追跡: 回転体部品と同じ答えになるか、接する部品の界面が 1 つにまとまるか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceScene, intersect, interfaceAt } from '../src/appearance/nstrace.js';
import { renderImage } from '../src/appearance/render.js';
import { rect, lensProfile, partBounds } from '../src/appearance/scene.js';
import { importSTL, encodeMesh } from '../src/appearance/mesh.js';
import { refract } from '../src/core/trace.js';
import { refractiveIndex } from '../src/core/glass.js';
import { fresnel } from '../src/core/fresnel.js';
import { cmf, LAMBDA_MIN, LAMBDA_MAX } from '../src/appearance/color.js';
import { boxTris, revolveTris, toBinarySTL } from './mesh-helpers.js';

const bk7 = { type: 'preset', name: 'N-BK7' };
const oil = { type: 'model', nd: 1.54, vd: 24 };
let seq = 0;
function meshPart(tris, material = bk7, extra = {}) {
  const { bodies } = importSTL(toBinarySTL(tris));
  assert.equal(bodies.length, 1);
  const id = `m${seq++}`;
  return { id, name: id, kind: 'mesh', mesh: { key: id, ...encodeMesh(bodies[0]) }, material, coatings: {}, offset: [0, 0, 0], visible: true, ...extra };
}
const revPart = (profile, material = bk7) => ({ id: `r${seq++}`, name: 'r', profile, material, coatings: {}, visible: true });

function transmitPath(scene, o, d, lambda) {
  const pts = [], events = [];
  let prev = null;
  for (let k = 0; k < 50; k++) {
    const hit = intersect(scene, o, d, 1e-6, Infinity, prev);
    if (!hit) break;
    const f = interfaceAt(scene, hit, d, lambda);
    events.push(f);
    const nd = refract(d, f.normal, f.nBefore, f.nAfter);
    pts.push(hit.point);
    if (!nd) return { pts, events, tir: true, d };
    o = hit.point; d = nd; prev = hit;
  }
  return { pts, events, d };
}
const chain = (ev) => ev.map((e) => `${e.nBefore.toFixed(3)}>${e.nAfter.toFixed(3)}`).join(' ');

test('mesh box window: air→glass→air with parallel exit, same as revolved slab', () => {
  const mesh = buildTraceScene([meshPart(boxTris(-15, 15, -15, 15, 0, 5))]);
  const rev = buildTraceScene([revPart(rect(0, 21.3, 0, 5))]);
  const d0 = [0.3, -0.2, 1].map((x) => x / Math.hypot(0.3, -0.2, 1));
  const a = transmitPath(mesh, [1, 2, -10], d0, 0.55), b = transmitPath(rev, [1, 2, -10], d0, 0.55);
  assert.equal(a.events.length, 2);
  assert.equal(chain(a.events), chain(b.events));
  a.pts.forEach((p, i) => assert.ok(Math.hypot(...p.map((v, k) => v - b.pts[i][k])) < 1e-9));
  assert.ok(Math.hypot(...a.d.map((v, k) => v - d0[k])) < 1e-12);
});

test('mesh lens (revolved, 256 sectors) refracts like the exact revolved lens within chord error', () => {
  const prof = lensProfile(0, 30, 10, 4, -60, 10);
  const mesh = buildTraceScene([meshPart(revolveTris(prof, 256))]);
  const rev = buildTraceScene([revPart(prof)]);
  for (const [o, d] of [[[0, 3, -20], [0, 0, 1]], [[2, -4, -20], [0.05, 0.08, 1]], [[-6, 1, -20], [0.1, -0.02, 1]]]) {
    const dn = d.map((x) => x / Math.hypot(...d));
    const a = transmitPath(mesh, o, dn, 0.55), b = transmitPath(rev, o, dn, 0.55);
    assert.equal(a.events.length, 2);
    assert.equal(chain(a.events), chain(b.events));
    assert.ok(Math.hypot(...a.d.map((v, k) => v - b.d[k])) < 2e-3, `dir ${a.d} vs ${b.d}`);
    a.pts.forEach((p, i) => assert.ok(Math.hypot(...p.map((v, k) => v - b.pts[i][k])) < 2e-3));
  }
});

test('two touching mesh parts (1 µm export misalignment) form ONE interface, no spurious air gap', () => {
  const A = meshPart(boxTris(-10, 10, -10, 10, 0, 3));
  const B = meshPart(boxTris(-10, 10, -10, 10, 3.001, 6), oil); // 1 µm ずれた接合面
  const sc = buildTraceScene([A, B]);
  for (const d of [[0, 0, 1], [0.2, 0.1, 1], [-0.3, 0.25, 1]]) {
    const dn = d.map((x) => x / Math.hypot(...d));
    const r = transmitPath(sc, [0.5, -0.7, -5], dn, 0.55);
    const nB = refractiveIndex(bk7, 0.55).toFixed(3), nO = refractiveIndex(oil, 0.55).toFixed(3);
    assert.equal(chain(r.events), `1.000>${nB} ${nB}>${nO} ${nO}>1.000`);
  }
});

test('mesh touching a revolved part along a plane is one interface', () => {
  const A = revPart(rect(0, 12, 0, 3));
  const B = meshPart(boxTris(-8, 8, -8, 8, 3, 5), oil);
  const sc = buildTraceScene([A, B]);
  const r = transmitPath(sc, [1, 1, -5], [0, 0, 1], 0.55);
  assert.equal(r.events.length, 3);
  assert.ok(r.events[1].before && r.events[1].after);
});

test('rendered reflectance of a mesh window equals 2R/(1+R) like the revolved one', () => {
  const halfWhite = { type: 'fn', fn: (d) => (d[2] < 0 ? 1 : 0) };
  const view = { camera: { target: [0, 0, 2.5], azimuth: 0, elevation: 0, distance: 60, fov: 4 }, env: halfWhite, width: 4, height: 4, passes: 32 };
  const img = renderImage([meshPart(boxTris(-15, 15, -15, 15, 0, 5))], view);
  let num = 0, den = 0;
  for (let l = LAMBDA_MIN; l <= LAMBDA_MAX; l += 1) {
    const R = fresnel(1, refractiveIndex(bk7, l / 1000), 1).R, y = cmf(l)[1];
    num += (y * 2 * R) / (1 + R); den += y;
  }
  const got = img.y.reduce((a, b) => a + b, 0) / img.y.length;
  assert.ok(Math.abs(got / (num / den) - 1) < 0.02, `got ${got}`);
  assert.ok(Object.keys(img.contrib).some((k) => k.includes(':0')));
});

test('partBounds of a mesh includes its offset', () => {
  const p = meshPart(boxTris(-1, 2, -3, 4, 0, 5), bk7, { offset: [10, 0, -2] });
  const b = partBounds(p);
  assert.deepEqual(b.lo.map((v) => +v.toFixed(6)), [9, -3, -2]);
  assert.deepEqual(b.hi.map((v) => +v.toFixed(6)), [12, 4, 3]);
});

test('validateScene reports a mesh overlapping a revolved part or another mesh, but not touching ones', async () => {
  const { validateScene } = await import('../src/appearance/scene.js');
  const A = revPart(rect(0, 12, 0, 3));
  assert.equal(validateScene([A, meshPart(boxTris(-8, 8, -8, 8, 3, 5), oil)]).ok, true); // 接触
  assert.equal(validateScene([A, meshPart(boxTris(-8, 8, -8, 8, 2, 5), oil)]).ok, false); // 1 mm 重なり
  const M = meshPart(boxTris(-5, 5, -5, 5, 10, 12));
  assert.equal(validateScene([M, meshPart(boxTris(-5, 5, -5, 5, 12.001, 14))]).ok, true);
  const v = validateScene([M, meshPart(boxTris(-5, 5, -5, 5, 11, 14))]);
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 1);
  assert.equal(validateScene([A, { ...meshPart(boxTris(-8, 8, -8, 8, 2, 5)), visible: false }]).ok, true);
});
