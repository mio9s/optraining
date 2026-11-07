import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partsFromSystem, validateScene, lensProfile, partAt, placedProfile } from '../../src/appearance/scene.js';
import { tessellate, bounds, validateProfile } from '../../src/appearance/profile.js';
import { defaultSystem } from '../../src/core/system.js';
import { oilSystem } from '../helpers/systems.js';

test('achromat → 2 lenses + iris plate, all valid, no overlap', () => {
  const { parts, warnings } = partsFromSystem(defaultSystem());
  assert.deepEqual(warnings, []);
  assert.equal(parts.filter((p) => p.source === 'auto' && p.material.type !== 'opaque').length, 2);
  assert.equal(parts.filter((p) => p.material.type === 'opaque').length, 1);
  const v = validateScene(parts);
  assert.ok(v.ok, v.errors.map((e) => e.message).join());
});
test('lens profile geometry: vertices and edge thickness', () => {
  const p = lensProfile(10, 25.75, 10, 15, -25.75, 10);
  assert.ok(validateProfile(p).ok);
  const b = bounds(tessellate(p));
  assert.ok(Math.abs(b.zMin - 10) < 1e-9 && Math.abs(b.zMax - 15) < 1e-9 && Math.abs(b.rMax - 10) < 1e-9);
  assert.throws(() => lensProfile(0, 10, 9, 1, -10, 9), /コバ厚/);
});
test('different clear diameters produce a flat flange step', () => {
  const p = lensProfile(0, 30, 8, 5, Infinity, 12);
  assert.ok(validateProfile(p).ok);
  assert.ok(p.segments.some((s, i) => s.type === 'line' && i === 1)); // 前面の外側の段
  assert.ok(Math.abs(bounds(tessellate(p)).rMax - 12) < 1e-9);
});
test('oil system: lens, oil and plate share faces without overlap', () => {
  const { parts } = partsFromSystem(oilSystem());
  const media = parts.filter((p) => p.material.type !== 'opaque');
  assert.equal(media.length, 3);
  assert.ok(validateScene(parts).ok, validateScene(parts).errors.map((e) => e.message).join());
  const ed = parts.map((p) => tessellate(placedProfile(p)));
  // 点の所属: レンズ内、オイル内、空気層、平板内
  const name = (r, z) => { const i = partAt(ed, r, z); return i < 0 ? 'air' : parts[i].name; };
  // z は物体面からの絶対位置(レンズ前面の頂点 = 1000 mm)
  assert.match(name(5, 1002), /レンズ 2/);
  assert.match(name(5, 1005.5), /媒質 3/);
  assert.equal(name(5, 1007.5), 'air');
  assert.match(name(5, 1008.5), /レンズ 5/);
  // 共有面: レンズ後面とオイル前面の頂点 z が一致
  const lensBack = ed[0].filter((e) => Math.abs(e.a[1] - 1004) < 1e-12).length, oilFront = ed[1].filter((e) => Math.abs(e.a[1] - 1004) < 1e-12).length;
  assert.ok(lensBack > 0 && oilFront > 0);
});
test('overlap is detected', () => {
  const { parts } = partsFromSystem(defaultSystem());
  parts[1].zOffset = -1; // 2 枚目を 1 mm 前へ → 1 枚目と重なる
  assert.ok(!validateScene(parts).ok);
});
