import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downscaleImage, srgbToLinear, linearToSrgb } from '../../src/ui/image-view.js';

function fake(W, H, fill = (x, y) => [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(fill(x, y), (y * W + x) * 4);
  return { data, width: W, height: H };
}

test('4000x3000 is reduced to <= 512 keeping aspect', () => {
  const t = Date.now();
  const r = downscaleImage(fake(4000, 3000), 512);
  assert.equal(r.size, 512);
  // 縦は 384 行分だけ中身があり、上下は黒
  const rowHas = (y) => r.data[(y * 512 + 256) * 3] > 0;
  assert.ok(!rowHas(0) && rowHas(64) && rowHas(447) && !rowHas(511));
  assert.ok(Date.now() - t < 5000);
});
test('small image is not upscaled', () => {
  const r = downscaleImage(fake(100, 50), 512);
  assert.equal(r.size, 100);
});
test('sRGB round trip and linearization', () => {
  for (const v of [0, 0.01, 0.2, 0.5, 1]) assert.ok(Math.abs(linearToSrgb(srgbToLinear(v)) - v) < 1e-9);
  assert.ok(Math.abs(srgbToLinear(0.5) - 0.214) < 1e-3);
});
test('orientation preserved (top row stays top)', () => {
  const r = downscaleImage(fake(4, 4, (x, y) => (y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 255])), 512);
  assert.ok(r.data[0] > 0.99 && r.data[(3 * 4) * 3] === 0);
});
