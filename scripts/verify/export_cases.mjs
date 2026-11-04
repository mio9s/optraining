// 本実装の系と光線を rayoptics 形式へ書き出し、本実装の結果も保存
import { writeFileSync } from 'node:fs';
import { defaultSystem, SAMPLE_SYSTEMS } from '../../src/core/system.js';
import { traceRay, aimRay } from '../../src/core/trace.js';
import { refractiveIndex } from '../../src/core/glass.js';
import { normalize } from '../../src/core/vec.js';

const systems = { achromat: defaultSystem(), bk7: SAMPLE_SYSTEMS.bk7.make() };
// 強く曲がったメニスカス + 厚いレンズ(スキュー光線の検証用)
const air = { type: 'air' };
systems.meniscus = {
  surfaces: [
    { kind: 'object', radius: Infinity, thickness: 80, material: air, diameter: 100 },
    { kind: 'surface', radius: -30, thickness: 8, material: { type: 'preset', name: 'N-SF11' }, diameter: 30 },
    { kind: 'surface', radius: -22, thickness: 6, material: air, diameter: 30 },
    { kind: 'surface', radius: 40, thickness: 12, material: { type: 'preset', name: 'N-LAK9' }, diameter: 30 },
    { kind: 'surface', radius: -90, thickness: 50, material: air, diameter: 30 },
    { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 100 },
  ], object: { height: 10 }, screen: { width: 20, pixels: 64 }, wavelengths: [0.45, 0.52, 0.62],
};
const spec = [], ours = [];
for (const [name, sys] of Object.entries(systems)) for (const wvl of [0.45, 0.52, 0.62]) {
  const rays = [];
  const res = [];
  const h = sys.object.height;
  for (const [ox, oy, px, py] of [[0, 0, 0, 0.7], [0, 0, 0.5, 0.5], [0, h, 0, -0.9], [0, h, 0.8, 0.2], [0.6 * h, 0.4 * h, -0.5, 0.6], [-0.3 * h, -h, 0.3, -0.7]]) {
    const r = aimRay(sys, [ox, oy, 0], wvl, px, py);
    const t = traceRay(sys, r, { ignoreApertures: true });
    if (!t.alive) continue;
    rays.push([r.p, r.d]);
    res.push({ last: t.points[t.points.length - 1], opl: t.opl });
  }
  const surfs = sys.surfaces.slice(1, -1).map((s) => ({
    r: Number.isFinite(s.radius) && s.kind === 'surface' ? s.radius : null,
    t: s.thickness,
    mat: s.kind === 'surface' && s.material.type === 'preset' ? s.material.name.replace('Fused Silica', 'F_SILICA') : null,
  }));
  const idx = sys.surfaces.slice(0, -1).map((s, i) => refractiveIndex(s.kind === 'surface' || s.kind === 'object' ? s.material : sys.surfaces[i - 1].material, wvl));
  spec.push({ name: `${name}@${wvl}`, obj: sys.surfaces[0].thickness, wvl, surfs, rays });
  ours.push({ name: `${name}@${wvl}`, rays: res, indices: idx });
}
writeFileSync(process.argv[2], JSON.stringify(spec));
writeFileSync(process.argv[3], JSON.stringify(ours));
console.log('cases', spec.length, 'rays', spec.reduce((a, c) => a + c.rays.length, 0));
