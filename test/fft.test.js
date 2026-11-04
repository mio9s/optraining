import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft2d } from '../src/core/fft.js';

test('fft of delta is flat', () => {
  const n = 16, re = new Float64Array(n * n), im = new Float64Array(n * n);
  re[0] = 1;
  fft2d(re, im, n);
  for (let i = 0; i < n * n; i++) { assert.ok(Math.abs(re[i] - 1) < 1e-12); assert.ok(Math.abs(im[i]) < 1e-12); }
});
test('fft of plane wave is a delta', () => {
  const n = 8, re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { re[y * n + x] = Math.cos((2 * Math.PI * 3 * x) / n); im[y * n + x] = Math.sin((2 * Math.PI * 3 * x) / n); }
  fft2d(re, im, n); // 順変換 e^{-i2πkx/n} → k=3 に n² のピーク
  for (let i = 0; i < n * n; i++) assert.ok(Math.abs(re[i] - (i === 3 ? n * n : 0)) < 1e-9);
});
test('fft inverse round-trip', () => {
  const n = 32, re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) { re[i] = Math.sin(i * 0.37) + 0.1 * i; im[i] = Math.cos(i * 0.11); }
  const r0 = re.slice(), i0 = im.slice();
  fft2d(re, im, n); fft2d(re, im, n, true);
  for (let i = 0; i < n * n; i++) { assert.ok(Math.abs(re[i] - r0[i]) < 1e-9); assert.ok(Math.abs(im[i] - i0[i]) < 1e-9); }
});
test('non power of two throws', () => assert.throws(() => fft2d(new Float64Array(9), new Float64Array(9), 3)));
