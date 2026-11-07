import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formImage, geometricImage, radialMap } from '../../src/core/imaging.js';
import { makePattern } from '../../src/core/patterns.js';
import { defaultSystem } from '../../src/core/system.js';

function small() { const s = defaultSystem(); s.screen.pixels = 64; return s; }
function pointObject(size, ix, iy) {
  const data = new Float32Array(size * size * 3);
  for (let c = 0; c < 3; c++) data[(iy * size + ix) * 3 + c] = 1;
  return { data, size };
}
const rowOfPeak = (img, P, ch = 1) => {
  let best = -1, idx = 0;
  for (let i = 0; i < P * P; i++) if (img.data[i * 3 + ch] > best) { best = img.data[i * 3 + ch]; idx = i; }
  return [Math.floor(idx / P), idx % P];
};

test('patterns are generated', () => {
  for (const n of ['arrow', 'letterF', 'chart', 'grid', 'points', 'color']) {
    const p = makePattern(n, 64);
    assert.equal(p.data.length, 64 * 64 * 3);
    assert.ok(p.data.some((v) => v > 0));
  }
});
test('image of point source is inverted (y and x)', () => {
  const sys = small();
  // 物体の右上(+x, +y)に点 → 像は左下
  const obj = { ...pointObject(32, 24, 6) };
  // 点を少し太らせる
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]]) for (let c = 0; c < 3; c++) obj.data[((6 + dy) * 32 + 24 + dx) * 3 + c] = 1;
  const r = formImage(sys, obj, { fieldGrid: 1, nPupil: 16 });
  assert.ok(!r.message);
  const [row, col] = rowOfPeak(r, r.P);
  assert.ok(row > r.P / 2, `row=${row}`);
  assert.ok(col < r.P / 2, `col=${col}`);
});
test('magnification of geometric image matches chief ray map', () => {
  const sys = small();
  const map = radialMap(sys, 0.52);
  assert.ok(map.m0 < 0); // 倒立
  assert.ok(map.W[0] > 0);
});
test('all rays vignetted gives black image + message', () => {
  const sys = small();
  sys.surfaces[1].diameter = 1e-6;
  const r = formImage(sys, makePattern('arrow', 32), { fieldGrid: 1, nPupil: 8 });
  assert.ok(r.message);
  assert.ok(r.data.every((v) => v === 0));
});
test('no NaN in output for default system', () => {
  const r = formImage(small(), makePattern('chart', 64), { fieldGrid: 2, nPupil: 12 });
  assert.ok(r.data.every(Number.isFinite));
  assert.ok(r.peak > 0);
});
test('stopping down iris changes the image', () => {
  const a = small(), b = small();
  b.surfaces[1].diameter = 3;
  const pat = makePattern('grid', 64);
  const ra = formImage(a, pat, { fieldGrid: 1, nPupil: 12 });
  const rb = formImage(b, pat, { fieldGrid: 1, nPupil: 12 });
  let diff = 0; for (let i = 0; i < ra.data.length; i++) diff += Math.abs(ra.data[i] - rb.data[i]);
  assert.ok(diff > 1);
  assert.ok(rb.peak < ra.peak); // 暗くなる
});
test('screen far from focus still gives finite image', () => {
  const s = small(); s.surfaces[s.surfaces.length - 2].thickness += 20;
  const r = formImage(s, makePattern('arrow', 32), { fieldGrid: 1, nPupil: 12 });
  assert.ok(r.data.every(Number.isFinite));
});

test('uniform object stays uniform under heavy defocus (no truncation/tiling artifacts)', () => {
  const white = { data: new Float32Array(64 * 64 * 3).fill(1), size: 64 };
  const a = small(); a.object.height = 30; // 物体はスクリーンより十分大きい
  const b = small(); b.object.height = 30; b.surfaces[5].thickness = 150; // 大きく焦点外
  const ra = formImage(a, white, { fieldGrid: 3, nPupil: 12 });
  const rb = formImage(b, white, { fieldGrid: 3, nPupil: 12 });
  const P = 64, c = (r, x, y) => r.data[(y * P + x) * 3 + 1];
  // 中央の照度は同程度(スクリーンが遠いぶん主光線の写像が拡大し、やや暗くなる)
  const ratio = c(rb, 32, 32) / c(ra, 32, 32);
  assert.ok(ratio > 0.3 && ratio < 1.5, String(ratio));
  // 一様性: 中央 32×32 の変動係数が小さい
  let s = 0, s2 = 0, n = 0;
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) { const v = c(rb, x, y); s += v; s2 += v * v; n++; }
  const mean = s / n, cv = Math.sqrt(s2 / n - mean * mean) / mean;
  assert.ok(cv < 0.05, `cv=${cv}`);
});
