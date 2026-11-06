// 外観の部品(STL・回転体)から、結像・収差モード用のレンズデータ(逐次の面の並び)を作る。
// 光軸(x = y = 0)に沿って界面を順に拾い、各面を光軸まわりの点で球面に当てはめる。
import { buildTraceScene, intersect, interfaceAt, T_MIN } from './nstrace.js';
import { validateSystem } from '../core/system.js';
import { powerSummary } from '../core/focus.js';

const DZ = [0, 0, 1];
const AZ = 12; // 方位の数
const NR = 48; // 半径方向の刻み
const idOf = (e) => (e ? e.part.id : 'air');

/** (x, y) を通る +z 方向の直線が横切る界面の列: [{z, key, before, after, nz}] */
function eventsAlong(scene, x, y, z0) {
  const out = [];
  let p = [x, y, z0], prev = null;
  for (let g = 0; g < 200; g++) {
    const hit = intersect(scene, p, DZ, T_MIN, Infinity, prev);
    if (!hit) break;
    const f = interfaceAt(scene, hit, DZ, 0.5876);
    out.push({ z: hit.point[2], key: `${idOf(f.before)}>${idOf(f.after)}`, before: f.before, after: f.after, nz: Math.abs(f.normal[2]), opaque: f.opaque });
    p = hit.point; prev = hit;
  }
  return out;
}

const sameKeys = (a, b) => a.length === b.length && a.every((e, i) => e.key === b[i].key);

/** 頂点 z0 を通る球面 r² + dz² = 2R·dz の最小二乗(平面なら R = ∞) */
export function fitSphere(pts) {
  let num = 0, den = 0, maxDz = 0;
  for (const [r, dz] of pts) { num += 2 * dz * (r * r + dz * dz); den += 4 * dz * dz; maxDz = Math.max(maxDz, Math.abs(dz)); }
  const R = maxDz < 1e-7 || den === 0 ? Infinity : num / den;
  const sag = (r) => (Number.isFinite(R) ? R - Math.sign(R) * Math.sqrt(Math.max(0, R * R - r * r)) : 0);
  let ss = 0;
  for (const [r, dz] of pts) ss += (dz - sag(r)) ** 2;
  const rms = pts.length ? Math.sqrt(ss / pts.length) : 0;
  return { R: Number.isFinite(R) && Math.abs(R) > 1e7 ? Infinity : R, rms };
}

const matOf = (e) => (e ? { ...e.part.material } : { type: 'air' });
const matName = (m) => (m.type === 'air' ? '空気' : m.type === 'preset' ? m.name : m.type === 'model' ? `nd ${m.nd} / νd ${m.vd}` : '不透明');

/**
 * parts: 外観の部品(非表示は除く。空洞の擬似部品を含めてよい)。base: 物体・スクリーン・波長を引き継ぐ元のレンズデータ。
 * opts.tol: 球面・回転対称とみなす許容差 [mm](有効径の決め方)
 * 返り値: {ok, message?, system, rows: [{z, R, rms, asym, before, after, nameBefore, nameAfter}], aperture, warnings}
 */
export function systemFromParts(parts, base, opts = {}) {
  const scene = buildTraceScene(parts);
  if (!scene.list.length) return { ok: false, message: '表示している部品がありません' };
  let zMin = Infinity, rMax = 0;
  for (const e of scene.list) {
    const b = e.kind === 'mesh' ? e.box3 : null;
    if (b) { zMin = Math.min(zMin, b[2]); rMax = Math.max(rMax, ...[0, 1, 3, 4].map((k) => Math.abs(b[k]))); }
    else for (const x of e.all) { zMin = Math.min(zMin, x.a[1], x.b[1]); rMax = Math.max(rMax, x.a[0], x.b[0]); }
  }
  const z0 = zMin - 1;
  // 光軸上(頂点・辺をちょうど通らないよう、ごくわずかにずらす)
  const ax = eventsAlong(scene, 1e-7, 0.7e-7, z0);
  if (!ax.length) return { ok: false, message: '光軸(x = y = 0)上に部品がありません。部品の位置(Δx・Δy)か、取り込み時の「光軸が通る位置」を確認してください' };
  const op = ax.find((e) => e.opaque);
  if (op) return { ok: false, message: `光軸上に不透明な部品(${(op.after ?? op.before).part.name})があり、光が通りません` };
  const warnings = [];
  ax.forEach((e, i) => { if (e.nz < 0.999) warnings.push(`面 ${i + 1}: 光軸上で面が ${(Math.acos(Math.min(1, e.nz)) * 180 / Math.PI).toFixed(2)}° 傾いています(光軸の向き・位置を確認してください)`); });
  // 有効径: 光軸と同じ界面の並びを横切る最大の半径(全方位で)
  // 有効径は、(1) 全方位で光軸と同じ面の並びを横切り、(2) 各面が球面・回転対称とみなせる(許容差 tol 以内)最大の半径
  const tol = opts.tol ?? 0.002;
  const pts = ax.map(() => []);
  let aperture = 0, stopReason = '';
  const dr = rMax / NR;
  for (let k = 1; k <= NR; k++) {
    const r = k * dr, ring = [];
    let ok = true;
    for (let a = 0; a < AZ; a++) {
      const th = (2 * Math.PI * (a + 0.5)) / AZ;
      const ev = eventsAlong(scene, r * Math.cos(th), r * Math.sin(th), z0);
      if (!sameKeys(ev, ax)) { ok = false; stopReason = `半径 ${r.toFixed(2)} mm で面の並びが変わる(部品の端・段差)`; break; }
      ring.push(ev);
    }
    if (!ok) break;
    const trial = pts.map((p, i) => [...p, ...ring.map((ev) => [r, ev[i].z - ax[i].z, k])]);
    const bad = trial.findIndex((p, i) => {
      const zs = ring.map((ev) => ev[i].z);
      return fitSphere(p).rms > tol || Math.max(...zs) - Math.min(...zs) > 2 * tol;
    });
    if (bad >= 0 && k > 1) { stopReason = `半径 ${r.toFixed(2)} mm で面 ${bad + 1} が球面・回転対称から ${(tol * 1000).toFixed(0)} µm 以上ずれる`; break; }
    trial.forEach((p, i) => { pts[i] = p; });
    aperture = r;
  }
  if (aperture === 0) warnings.push('光軸のすぐ近くで面の並びが変わります。有効径を決められないため、光軸付近の値だけで作りました');
  const rows = ax.map((e, i) => {
    const f = fitSphere(pts[i]);
    // 回転対称からのずれ: 同じ半径での z のばらつき(最大)
    let asym = 0;
    for (let k = 1; k <= NR; k++) {
      const zs = pts[i].filter((p) => p[2] === k).map((p) => p[1]);
      if (zs.length > 1) asym = Math.max(asym, Math.max(...zs) - Math.min(...zs));
    }
    return { z: e.z, R: f.R, rms: f.rms, asym, before: matOf(e.before), after: matOf(e.after), nameBefore: e.before?.part.name ?? '空気', nameAfter: e.after?.part.name ?? '空気' };
  });
  rows.forEach((r, i) => {
    if (r.rms > 1e-3 || r.asym > 2e-3) warnings.push(`面 ${i + 1}(${r.nameBefore} → ${r.nameAfter}): 球面・回転対称からのずれが大きい(当てはめ誤差 ${(r.rms * 1000).toFixed(1)} µm、方位による差 ${(r.asym * 1000).toFixed(1)} µm)。結像の結果は近似です`);
  });
  if (rows[rows.length - 1].after.type !== 'air') warnings.push('最後の面の後ろが空気ではありません');
  // レンズデータを組み立てる
  const air = { type: 'air' };
  const S0 = base.surfaces[0];
  const dia = +(2 * (aperture || dr)).toFixed(4);
  const surfaces = [{ ...S0, material: rows[0].before.type === 'air' ? S0.material : rows[0].before }];
  rows.forEach((r, i) => surfaces.push({ kind: 'surface', radius: Number.isFinite(r.R) ? +r.R.toFixed(4) : Infinity, thickness: i < rows.length - 1 ? +(rows[i + 1].z - r.z).toFixed(5) : 50, material: r.after, diameter: dia }));
  const last = base.surfaces[base.surfaces.length - 1];
  surfaces.push({ ...last, kind: 'screen', material: air, thickness: 0, diameter: Math.max(last.diameter ?? dia, dia) });
  const system = { ...structuredClone({ object: base.object, screen: base.screen, wavelengths: base.wavelengths }), surfaces };
  // 後側距離: 近軸の像位置(求まらない・負なら 50 mm のまま)
  try {
    const ps = powerSummary(system);
    if (Number.isFinite(ps.imageDistance) && ps.imageDistance > 0.1 && ps.imageDistance < 1e5) system.surfaces[system.surfaces.length - 2].thickness = +ps.imageDistance.toFixed(4);
  } catch { /* 近軸計算できなければそのまま */ }
  const v = validateSystem(system);
  if (!v.ok) return { ok: false, message: `レンズデータを作れませんでした: ${v.errors.map((e) => e.message).join('、')}`, rows, warnings };
  return { ok: true, system, rows, aperture, stopReason, warnings, matName };
}

export { matName };
