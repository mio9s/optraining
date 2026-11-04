import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderImage, cameraBasis } from '../src/appearance/render.js';
import { rect } from '../src/appearance/scene.js';
import { refractiveIndex } from '../src/core/glass.js';
import { fresnel } from '../src/core/fresnel.js';
import { cmf, LAMBDA_MIN, LAMBDA_MAX, spectralToRGB } from '../src/appearance/color.js';
import { thinFilm, COATINGS } from '../src/appearance/thinfilm.js';

const bk7 = { type: 'preset', name: 'N-BK7' };
const part = (id, profile, coatings = {}, material = bk7) => ({ id, name: id, profile, material, coatings, visible: true });
// カメラ側(−z)の半球だけが白い環境: 写るのは反射光のみ
const halfWhite = { type: 'fn', fn: (d) => (d[2] < 0 ? 1 : 0) };
const view = { camera: { target: [0, 0, 2.5], azimuth: 0, elevation: 0, distance: 60, fov: 4 }, env: halfWhite, width: 4, height: 4 };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test('camera at az=0, el=0 looks along +z from the object side', () => {
  const cb = cameraBasis({ target: [0, 0, 10], azimuth: 0, elevation: 0, distance: 50, fov: 30 });
  assert.ok(Math.abs(cb.pos[2] + 40) < 1e-9 && Math.abs(cb.fwd[2] - 1) < 1e-12);
});
test('uncoated BK7 window: reflected luminance = 2R/(1+R) (incl. multiple reflections) within 2 %', () => {
  const img = renderImage([part('w', rect(0, 15, 0, 5))], { ...view, passes: 64 });
  // 期待値: 輝度重み付きの波長平均
  let num = 0, den = 0;
  for (let l = LAMBDA_MIN; l <= LAMBDA_MAX; l += 1) {
    const R = fresnel(1, refractiveIndex(bk7, l / 1000), 1).R, y = cmf(l)[1];
    num += y * (2 * R) / (1 + R); den += y;
  }
  const expected = num / den, got = mean(img.y);
  assert.ok(Math.abs(got / expected - 1) < 0.02, `got ${got} expected ${expected}`);
  // 寄与: 前面の反射が最大、後面がそれに次ぐ
  const keys = Object.entries(img.contrib).sort((a, b) => b[1] - a[1]);
  assert.ok(keys.length >= 2);
  const tot = Object.values(img.contrib).reduce((a, b) => a + b, 0) / 16;
  assert.ok(Math.abs(tot / got - 1) < 1e-6); // 寄与の合計 = 画像の明るさ(反射光のみの環境)
});
test('index-matched cemented interface is invisible (zero reflection contribution, same image)', () => {
  const single = renderImage([part('w', rect(0, 15, 0, 5))], { ...view, passes: 64 });
  const cem = renderImage([part('a', rect(0, 15, 0, 2.5)), part('b', rect(0, 15, 2.5, 5))], { ...view, passes: 64 });
  // 共有面(キーに '|' を含む)からの反射の寄与は 0(R = 0 なので記録自体がない)
  const shared = Object.entries(cem.contrib).filter(([k, v]) => k.includes('|') && v > 0);
  assert.equal(shared.length, 0);
  assert.ok(Math.abs(mean(cem.y) / mean(single.y) - 1) < 0.005);
});
test('MgF2-coated reflection looks purple; uncoated is neutral', () => {
  const ratio = (img) => { let r = 0, g = 0, b = 0; for (let i = 0; i < img.rgb.length; i += 3) { r += img.rgb[i]; g += img.rgb[i + 1]; b += img.rgb[i + 2]; } return { rb: (r + b) / 2 / g, r, g, b }; };
  // 後面は黒い吸収体で覆い、前面の反射だけを見る
  const absorber = part('abs', rect(0, 15, 5, 6), {}, { type: 'opaque', kind: 'absorber' });
  const opts = { ...view, passes: 96 };
  const plain = ratio(renderImage([part('w', rect(0, 15, 0, 5)), absorber], opts));
  const coated = ratio(renderImage([part('w', rect(0, 15, 0, 5), { 0: 'mgf2' }), absorber], opts));
  // 理論: 反射スペクトル R(λ) を等色関数で積分した色比
  let c = [0, 0, 0];
  for (let l = LAMBDA_MIN; l <= LAMBDA_MAX; l++) {
    const R = thinFilm(1, COATINGS.mgf2.layers, refractiveIndex(bk7, l / 1000), 1, l / 1000).R;
    c = c.map((v, k) => v + spectralToRGB(l, R)[k]);
  }
  const theory = (c[0] + c[2]) / 2 / c[1];
  assert.ok(theory > 1.15); // 紫(青と赤が緑より強い)
  assert.ok(Math.abs(plain.rb - 1) < 0.05, `plain ${plain.rb}`);
  assert.ok(Math.abs(coated.rb / theory - 1) < 0.03, `coated ${coated.rb} theory ${theory}`);
  assert.ok(coated.g < plain.g * 0.5); // 反射が大きく減る
});
