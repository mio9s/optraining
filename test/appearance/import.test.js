import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importProfiles, parsePathData, parseTransform } from '../../src/appearance/import.js';
import { tessellate, bounds } from '../../src/appearance/profile.js';

const R = 51.68, RE = 12.5, T = 4;
const sag = (r) => R - Math.sqrt(R * R - r * r);
const S = sag(RE);
const TH = 2 * Math.asin(RE / R);

// 前面(球面)上の点が理論のサグに一致するか。戻り値: 最大誤差 [mm]
function frontError(profile, withMid = true) {
  let mx = 0, n = 0;
  for (const e of tessellate(profile)) for (const p of withMid ? [e.a, e.b, [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]] : [e.a, e.b]) {
    if (p[1] < T - 1e-6 && p[0] < RE - 1e-6 && p[0] > 1e-9 && p[1] < S + 1e-9) { mx = Math.max(mx, Math.abs(p[1] - sag(p[0]))); n++; }
  }
  assert.ok(n > 10);
  return mx;
}
function checkLens(res) {
  assert.equal(res.profiles.length, 1, res.warnings.join());
  const p = res.profiles[0];
  const b = bounds(tessellate(p));
  assert.ok(Math.abs(b.rMax - RE) < 1e-6 && Math.abs(b.zMin) < 1e-6 && Math.abs(b.zMax - T) < 1e-6, JSON.stringify(b));
  const err = frontError(p);
  assert.ok(err < 1e-3, `front sag error ${err} mm`);
  return frontError(p, false); // 分割点での誤差(円弧が正確に保たれていれば ~0)
}

test('SVG path with arc (full symmetric section)', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
    <path d="M ${S} ${-RE} A ${R} ${R} 0 0 0 ${S} ${RE} L ${T} ${RE} L ${T} ${-RE} Z"/></svg>`;
  const res = importProfiles(svg, 'svg');
  assert.equal(res.mmPerUnit, 1);
  assert.ok(checkLens(res) < 1e-9);
});
test('SVG with group transform, relative commands and unit scale', () => {
  // 1 単位 = 0.1 mm の図面。パスは mm の値で書き、scale(10) で単位に直す(円弧は相似変換なので円弧のまま)
  const svg = `<svg width="200mm" viewBox="0 0 2000 2000"><g transform="translate(500 300) scale(10)">
    <path d="m ${S} ${-RE} a ${R} ${R} 0 0 0 0 ${2 * RE} h ${T - S} v ${-2 * RE} z"/></g></svg>`;
  const res = importProfiles(svg, 'svg');
  assert.ok(Math.abs(res.mmPerUnit - 0.1) < 1e-12);
  checkLens({ ...res, profiles: res.profiles.map((p) => p) });
});
test('SVG drawn as upper half only (axis at bottom)', () => {
  const svg = `<svg><path d="M 0 0 A ${R} ${R} 0 0 1 ${S} ${-RE} L ${T} ${-RE} L ${T} 0 Z"/></svg>`;
  const res = importProfiles(svg, 'svg', { axisMode: 'max', mmPerUnit: 1 }); // SVG は y 下向き: 光軸は y の最大側
  checkLens(res);
});
test('DXF LWPOLYLINE with bulge', () => {
  const b = -Math.tan(TH / 4);
  const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '90', '4', '70', '1', '10', S, '20', -RE, '42', b, '10', S, '20', RE, '10', T, '20', RE, '10', T, '20', -RE,
    '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const res = importProfiles(dxf, 'dxf');
  assert.equal(res.mmPerUnit, 1);
  assert.ok(checkLens(res) < 1e-9);
});
test('DXF LINE + ARC entities (chained, any order)', () => {
  const a0 = 180 - (TH / 2) * (180 / Math.PI), a1 = 180 + (TH / 2) * (180 / Math.PI);
  const ent = (...kv) => kv.map(String);
  const dxf = ['0', 'SECTION', '2', 'ENTITIES',
    ...ent('0', 'LINE', '10', T, '20', RE, '11', T, '21', -RE),
    ...ent('0', 'ARC', '10', R, '20', 0, '40', R, '50', a0, '51', a1),
    ...ent('0', 'LINE', '10', T, '20', RE, '11', S, '21', RE),
    ...ent('0', 'LINE', '10', S, '20', -RE, '11', T, '21', -RE),
    '0', 'ENDSEC', '0', 'EOF'].join('\n');
  checkLens(importProfiles(dxf, 'dxf'));
});
test('DXF SPLINE (degree 3) is evaluated', () => {
  // 直線上に並んだ制御点のスプライン = 直線
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'SPLINE', '71', '3', ...[0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => ['40', k]),
    ...[[0, 0], [0, 1], [0, 2], [0, 3]].flatMap(([x, y]) => ['10', x, '20', y]),
    '0', 'LINE', '10', 0, '20', 3, '11', 2, '21', 3, '0', 'LINE', '10', 2, '20', 3, '11', 2, '21', 0, '0', 'LINE', '10', 2, '20', 0, '11', 0, '21', 0,
    '0', 'ENDSEC'].map(String).join('\n');
  const res = importProfiles(dxf, 'dxf', { axisMode: 'min' });
  assert.equal(res.profiles.length, 1, res.warnings.join());
});
test('CSV smooth points reproduce the sphere within 1 µm; polyline is coarser', () => {
  const rows = [];
  for (let i = 0; i <= 40; i++) { const r = -RE + (2 * RE * i) / 40; rows.push(`${sag(Math.abs(r))},${r}`); }
  rows.push(`${T},${RE}`, `${T},${-RE}`);
  const csv = 'z,r\n' + rows.join('\n');
  const smooth = importProfiles(csv, 'csv', { smooth: true });
  const e1 = checkLens(smooth);
  const poly = importProfiles(csv, 'csv', { smooth: false });
  assert.equal(poly.profiles.length, 1);
  assert.ok(frontError(poly.profiles[0]) > e1);
});
test('parseTransform and path parsing details', () => {
  const m = parseTransform('translate(10,20) rotate(90)');
  assert.ok(Math.abs(m[4] - 10) < 1e-12 && Math.abs(m[1] - 1) < 1e-12);
  const r = parsePathData('M0,0L10,0L10,10Z M20 20 h5');
  assert.equal(r.contours.length, 1);
  assert.equal(r.open.length, 1);
  // 詰めた円弧フラグ "a1 1 0 01 2 0"
  const a = parsePathData('M0 0a1 1 0 01 2 0z');
  assert.equal(a.contours[0].segments[0].type, 'arc');
});
test('warnings for no closed contour', () => {
  const res = importProfiles('<svg><line x1="0" y1="0" x2="1" y2="1"/></svg>', 'svg');
  assert.equal(res.profiles.length, 0);
  assert.ok(res.warnings.length > 0);
});
