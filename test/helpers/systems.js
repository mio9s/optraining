// テスト用のレンズ系(複数のテストで共有。テストファイルどうしを import すると、そのテストが二重に走るため分ける)
import { SAMPLE_SYSTEMS } from '../../src/core/system.js';

/** BK7 平凸の後ろにオイル 3 mm、空気 1 mm、BK7 平板 1 mm */
export function oilSystem() {
  const s = SAMPLE_SYSTEMS.bk7.make();
  const air = { type: 'air' }, oil = { type: 'model', nd: 1.54, vd: 24 }, bk7 = { type: 'preset', name: 'N-BK7' };
  s.surfaces.splice(3, 1,
    { kind: 'surface', radius: Infinity, thickness: 3, material: oil, diameter: 25 },
    { kind: 'surface', radius: Infinity, thickness: 1, material: air, diameter: 25 },
    { kind: 'surface', radius: Infinity, thickness: 1, material: bk7, diameter: 25 },
    { kind: 'surface', radius: Infinity, thickness: 104.089, material: air, diameter: 25 });
  return s;
}
