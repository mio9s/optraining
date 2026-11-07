import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmf, spectralToRGB, spectralToY, luminance, LAMBDA_MIN, LAMBDA_MAX } from '../../src/appearance/color.js';

const avg = (fn, N = 600) => { let s = [0, 0, 0]; for (let i = 0; i < N; i++) { const v = fn(LAMBDA_MIN + ((i + 0.5) * (LAMBDA_MAX - LAMBDA_MIN)) / N); s = s.map((a, k) => a + v[k] / N); } return s; };

test('CMF peaks near the known wavelengths', () => {
  const argmax = (k) => { let b = 0, bl = 0; for (let l = 380; l <= 780; l++) { const v = cmf(l)[k]; if (v > b) { b = v; bl = l; } } return [bl, b]; };
  const [ly, vy] = argmax(1); assert.ok(Math.abs(ly - 556) < 4 && Math.abs(vy - 1) < 0.02, `${ly} ${vy}`);
  const [lx] = argmax(0); assert.ok(Math.abs(lx - 599) < 4);
  const [lz] = argmax(2); assert.ok(Math.abs(lz - 446) < 5);
});
test('flat spectrum maps to neutral white (1,1,1) and Y = 1', () => {
  const c = avg((l) => spectralToRGB(l));
  for (const v of c) assert.ok(Math.abs(v - 1) < 1e-5, String(c));
  const y = avg((l) => [spectralToY(l), 0, 0])[0];
  assert.ok(Math.abs(y - 1) < 1e-5);
  assert.ok(Math.abs(luminance(...c) - 1) < 1e-3);
});
test('monochromatic hues', () => {
  const blue = spectralToRGB(450), red = spectralToRGB(630), green = spectralToRGB(530);
  assert.ok(blue[2] > blue[0] && blue[2] > blue[1]);
  assert.ok(red[0] > red[1] && red[0] > red[2]);
  assert.ok(green[1] > green[0] && green[1] > green[2]);
});
test('luminance of a spectrum equals average spectral Y', () => {
  const w = (l) => (l < 500 ? 2 : 0.5);
  const rgb = avg((l) => spectralToRGB(l, w(l)));
  const y = avg((l) => [spectralToY(l, w(l)), 0, 0])[0];
  assert.ok(Math.abs(luminance(...rgb) - y) < 2e-3 * y, `${luminance(...rgb)} ${y}`);
});
