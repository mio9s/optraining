// 光線追跡の独立検証(複数の方法)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { traceRay, aimRay, intersectSphere } from '../src/core/trace.js';
import { defaultSystem, SAMPLE_SYSTEMS, surfaceZ, mediumAfter } from '../src/core/system.js';
import { refractiveIndex, abbeFromPreset } from '../src/core/glass.js';
import { add, scale, sub, norm, normalize, cross, dot } from '../src/core/vec.js';

const air = { type: 'air' };
const meniscus = () => ({
  surfaces: [
    { kind: 'object', radius: Infinity, thickness: 80, material: air, diameter: 100 },
    { kind: 'surface', radius: -30, thickness: 8, material: { type: 'preset', name: 'N-SF11' }, diameter: 30 },
    { kind: 'surface', radius: -22, thickness: 6, material: air, diameter: 30 },
    { kind: 'surface', radius: 40, thickness: 12, material: { type: 'preset', name: 'N-LAK9' }, diameter: 30 },
    { kind: 'surface', radius: -90, thickness: 50, material: air, diameter: 30 },
    { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 100 },
  ], object: { height: 10 }, screen: { width: 20, pixels: 64 }, wavelengths: [0.45, 0.52, 0.62],
});
const SYSTEMS = { achromat: defaultSystem, bk7: SAMPLE_SYSTEMS.bk7.make, meniscus };

// 1) 第三者実装 rayoptics 0.9.10 との比較(子午・スキュー光線 36 本、3 系 × 3 波長)
test('matches rayoptics: screen intercepts and optical path length', () => {
  const ref = JSON.parse(readFileSync(new URL('./fixtures/rayoptics-reference.json', import.meta.url)));
  let n = 0;
  for (const c of ref.cases) {
    const [name, wl] = c.name.split('@');
    const sys = SYSTEMS[name]();
    const lambda = +wl;
    for (const r of c.rays) {
      const t = traceRay(sys, { p: r.p, d: r.d, lambda }, { ignoreApertures: true });
      assert.ok(t.alive);
      const q = t.points[t.points.length - 1];
      assert.ok(Math.hypot(q[0] - r.last[0], q[1] - r.last[1]) < 1e-9, `${c.name}`);
      // rayoptics の区間長 × 本実装の屈折率 = 光路長
      const opl = r.seg.reduce((a, L, j) => a + L * refractiveIndex(mediumAfter(sys, j), lambda), 0);
      assert.ok(Math.abs(opl - t.opl) < 1e-9);
      n++;
    }
  }
  assert.ok(n >= 30);
});

// 2) 可逆性: スクリーンから逆向きに追跡すると物体点へ戻る
function traceBackward(sys, p, d, lambda) {
  const S = sys.surfaces, z = surfaceZ(sys);
  for (let i = S.length - 2; i >= 0; i--) {
    const s = S[i];
    const R = s.kind === 'surface' ? s.radius : Infinity;
    const t = intersectSphere(p, d, z[i], R);
    p = add(p, scale(d, t));
    if (s.kind === 'surface') {
      const n1 = refractiveIndex(s.material, lambda), n2 = refractiveIndex(mediumAfter(sys, i - 1), lambda);
      const cv = Number.isFinite(R) ? 1 / R : 0;
      let N = normalize([-cv * p[0], -cv * p[1], 1 - cv * (p[2] - z[i])]);
      let c = dot(d, N); if (c < 0) { N = scale(N, -1); c = -c; }
      const eta = n1 / n2, k = 1 - eta * eta * (1 - c * c);
      d = normalize(add(scale(d, eta), scale(N, Math.sqrt(k) - eta * c)));
    }
  }
  return p;
}
test('reversibility: backward trace returns to the object point', () => {
  for (const make of Object.values(SYSTEMS)) {
    const sys = make();
    for (const [ox, oy, px, py] of [[0, 0, 0.3, 0.6], [1, 3, -0.5, 0.4], [-2, -4, 0.7, -0.1]]) {
      const r = aimRay(sys, [ox, oy, 0], 0.52, px, py);
      const t = traceRay(sys, r, { ignoreApertures: true });
      const back = traceBackward(sys, t.final.p, scale(t.final.d, -1), 0.52);
      assert.ok(norm(sub(back, [ox, oy, 0])) < 1e-9, String(back));
    }
  }
});

// 3) スキュー不変量: 回転対称系では n·(x·M − y·L) が全区間で保存される
test('skew invariant n(xM − yL) is conserved for skew rays', () => {
  const sys = meniscus();
  const lambda = 0.45;
  const r = aimRay(sys, [3, -2, 0], lambda, 0.6, 0.5);
  const t = traceRay(sys, r, { ignoreApertures: true });
  // 各区間の方向を点列から復元
  const inv = [];
  for (let i = 0; i + 1 < t.points.length; i++) {
    const a = t.points[i], b = t.points[i + 1];
    const d = normalize(sub(b, a));
    const n = refractiveIndex(mediumAfter(sys, i), lambda);
    inv.push(n * (a[0] * d[1] - a[1] * d[0]));
  }
  assert.ok(Math.abs(inv[0]) > 1e-3); // 実際にスキュー光線
  for (const v of inv) assert.ok(Math.abs(v - inv[0]) < 1e-10, inv.join(','));
});

// 4) フェルマーの原理: 中間面上の交点をずらすと光路長は 2 次でしか変わらない(停留)
test("Fermat's principle: OPL is stationary w.r.t. intersection points", () => {
  const sys = meniscus();
  const lambda = 0.52;
  const r = aimRay(sys, [0, 5, 0], lambda, 0.3, 0.7);
  const t = traceRay(sys, r, { ignoreApertures: true });
  const z = surfaceZ(sys);
  const pts = t.points.map((p) => [...p]);
  const oplOf = (P) => { let s = 0; for (let i = 0; i + 1 < P.length; i++) s += refractiveIndex(mediumAfter(sys, i), lambda) * norm(sub(P[i + 1], P[i])); return s; };
  const base = oplOf(pts);
  assert.ok(Math.abs(base - t.opl) < 1e-9);
  for (let k = 1; k <= 4; k++) {
    const R = sys.surfaces[k].radius;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const P = pts.map((p) => [...p]);
      const h = 1e-4;
      P[k][0] += dx * h; P[k][1] += dy * h;
      const cv = 1 / R, rr = P[k][0] ** 2 + P[k][1] ** 2;
      P[k][2] = z[k] + (cv * rr) / (1 + Math.sqrt(1 - cv * cv * rr)); // 面上に戻す
      const dOpl = oplOf(P) - base;
      assert.ok(Math.abs(dOpl) < 1e-6, `surface ${k}: ${dOpl}`); // 1 次の変化なら ~1e-4
    }
  }
});

// 5) 解析解: 平行平板による横ずれ Δ = t sinθ (1 − cosθ / √(n² − sin²θ))
test('plane-parallel plate lateral shift matches analytic formula', () => {
  const n = 1.6, T = 10, th = 0.5;
  const g = { type: 'model', nd: n, vd: 1e15 };
  const sys = {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: 10, material: air, diameter: 1e3 },
      { kind: 'surface', radius: Infinity, thickness: T, material: g, diameter: 1e3 },
      { kind: 'surface', radius: Infinity, thickness: 10, material: air, diameter: 1e3 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 1e3 },
    ], object: { height: 1 }, screen: { width: 1, pixels: 8 }, wavelengths: [0.5875618],
  };
  const d = [0, Math.sin(th), Math.cos(th)];
  const t = traceRay(sys, { p: [0, 0, 0], d, lambda: 0.5875618 });
  const straight = 30 * Math.tan(th);
  const shift = (straight - t.points[3][1]) * Math.cos(th);
  const analytic = T * Math.sin(th) * (1 - Math.cos(th) / Math.sqrt(n * n - Math.sin(th) ** 2));
  assert.ok(Math.abs(shift - analytic) < 1e-10, `${shift} vs ${analytic}`);
  assert.ok(Math.abs(t.final.d[1] - d[1]) < 1e-12); // 出射方向は入射と平行
});

// 6) 球レンズの近軸焦点距離 f = nD / (4(n−1))(主点は中心)
test('ball lens EFL = nD/(4(n-1))', () => {
  const n = 1.5168, R = 5;
  const g = { type: 'model', nd: n, vd: 1e15 };
  const sys = {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: 10, material: air, diameter: 100 },
      { kind: 'surface', radius: R, thickness: 2 * R, material: g, diameter: 10 },
      { kind: 'surface', radius: -R, thickness: 20, material: air, diameter: 10 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 100 },
    ], object: { height: 1 }, screen: { width: 1, pixels: 8 }, wavelengths: [0.5875618],
  };
  const h = 0.01;
  const t = traceRay(sys, { p: [0, h, 0], d: [0, 0, 1], lambda: 0.5875618 });
  const efl = h / (-t.final.d[1] / t.final.d[2]);
  assert.ok(Math.abs(efl / ((n * 2 * R) / (4 * (n - 1))) - 1) < 1e-5, String(efl));
});

// 7) ガラスデータ: SCHOTT カタログ値(nd, νd)と照合
test('glass presets match SCHOTT/Malitson catalog nd and vd', () => {
  const cat = { 'N-BK7': [1.5168, 64.17], 'N-SF5': [1.67271, 32.25], 'N-SF11': [1.78472, 25.68], 'N-SK16': [1.62041, 60.32], 'N-F2': [1.62005, 36.43], 'N-LAK9': [1.691, 54.71], 'N-BAF10': [1.67003, 47.11], 'Fused Silica': [1.45846, 67.82] };
  for (const [name, [nd, vd]] of Object.entries(cat)) {
    const r = abbeFromPreset(name);
    assert.ok(Math.abs(r.nd - nd) < 1e-4, `${name} nd ${r.nd}`);
    assert.ok(Math.abs(r.vd - vd) < 0.1, `${name} vd ${r.vd}`);
  }
});
