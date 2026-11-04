// 外観シーン: 回転体の部品の集合
// Part = { id, name, profile, material, coatings: {[segIndex]: coatingKey | {layers}}, zOffset, source, visible }
// material: ガラス {type:'preset'|'model'}、または不透明 {type:'opaque', kind}
import { surfaceZ } from '../core/system.js';
import { sphericalSegment, validateProfile, tessellate, containsPoint, bounds, translateProfile } from './profile.js';

export const OPAQUE = {
  black: { label: '黒つや消し', diffuse: 0.03, specular: 0 },
  anodized: { label: '黒アルマイト', diffuse: 0.05, specular: 0.04 },
  aluminum: { label: 'アルミ(鏡面)', diffuse: 0.05, specular: 0.85 },
  white: { label: '白(拡散)', diffuse: 0.8, specular: 0 },
  absorber: { label: '完全吸収体(光トラップ)', diffuse: 0, specular: 0 },
};

let idSeq = 0;
export const newId = () => `p${Date.now().toString(36)}${(idSeq++).toString(36)}`;

/** 球面(R, 頂点 zv)の r における z */
const sagZ = (zv, R, r) => (Number.isFinite(R) ? zv + R - Math.sign(R) * Math.sqrt(R * R - r * r) : zv);

/**
 * 前面(zf, Rf, rf)・後面(zb, Rb, rb)からなるレンズ断面。外径 = max(rf, rb, outer)。
 * 径が小さい側は平らな段(フランジ)で外径までつなぐ。
 */
export function lensProfile(zf, Rf, rf, zb, Rb, rb, outer = 0) {
  const ro = Math.max(rf, rb, outer);
  if (Number.isFinite(Rf) && rf > Math.abs(Rf) + 1e-12) throw new Error('前面の半径が曲率半径より大きい');
  if (Number.isFinite(Rb) && rb > Math.abs(Rb) + 1e-12) throw new Error('後面の半径が曲率半径より大きい');
  const zfe = sagZ(zf, Rf, rf), zbe = sagZ(zb, Rb, rb);
  if (zbe - zfe <= 1e-9) throw new Error(`コバ厚が 0 以下です(${(zbe - zfe).toFixed(4)} mm)`);
  if (sagZ(zb, Rb, 0) - sagZ(zf, Rf, 0) <= 1e-9) throw new Error('中心厚が 0 以下です');
  const front = sphericalSegment(zf, Rf, 0, rf);
  const segs = [front.seg];
  if (ro > rf + 1e-12) segs.push({ type: 'line', to: [ro, zfe] });
  segs.push({ type: 'line', to: [ro, zbe] });
  if (ro > rb + 1e-12) segs.push({ type: 'line', to: [rb, zbe] });
  const back = sphericalSegment(zb, Rb, rb, 0);
  segs.push(back.seg);
  segs.push({ type: 'line', to: [...front.from] });
  return { start: front.from, segments: segs };
}

/** 現在のレンズデータから部品を自動生成 */
export function partsFromSystem(sys, { iris = true, barrel = false } = {}) {
  const S = sys.surfaces, z = surfaceZ(sys);
  const parts = [], warnings = [];
  for (let i = 1; i < S.length - 1; i++) {
    const s = S[i];
    if (s.kind !== 'surface' || s.material?.type === 'air') continue;
    let j = i + 1;
    while (j < S.length && S[j].kind === 'iris') j++;
    if (j >= S.length - 1 || S[j].kind !== 'surface') { warnings.push(`面 ${i}: 後ろに面がないため部品を作れません`); continue; }
    try {
      const profile = lensProfile(z[i], s.radius, s.diameter / 2, z[j], S[j].radius, S[j].diameter / 2);
      const isLiquid = s.material.type === 'model';
      parts.push({ id: `auto-${i}`, name: `${isLiquid ? '媒質' : 'レンズ'} ${i}–${j}`, profile, material: { ...s.material }, coatings: {}, zOffset: 0, source: 'auto', visible: true, surfaces: [i, j] });
    } catch (e) { warnings.push(`面 ${i}–${j}: ${e.message}`); }
  }
  // 部品の外径(鏡筒・アイリス板の大きさの基準)
  let rAll = 0, zMin = Infinity, zMax = -Infinity;
  for (const p of parts) { const b = bounds(tessellate(p.profile)); rAll = Math.max(rAll, b.rMax); zMin = Math.min(zMin, b.zMin); zMax = Math.max(zMax, b.zMax); }
  if (iris) S.forEach((s, i) => {
    if (s.kind !== 'iris') return;
    // 空気中のアイリスのみ(ガラスの中は部品と重なるので作らない)
    const inGlass = parts.some((p) => containsPoint(tessellate(p.profile), s.diameter / 2 + 1e-3, z[i]));
    if (inGlass) return;
    const r0 = s.diameter / 2, r1 = Math.max(r0 + 2, rAll + 1), t = 0.3;
    parts.push({ id: `auto-iris-${i}`, name: `アイリス ${i}`, profile: rect(r0, r1, z[i] - t / 2, z[i] + t / 2), material: { type: 'opaque', kind: 'black' }, coatings: {}, zOffset: 0, source: 'auto', visible: true });
  });
  if (barrel && parts.length) {
    const r0 = rAll + 0.02, r1 = r0 + 1.5;
    parts.push({ id: 'auto-barrel', name: '鏡筒', profile: rect(r0, r1, zMin - 1, zMax + 1), material: { type: 'opaque', kind: 'anodized' }, coatings: {}, zOffset: 0, source: 'auto', visible: true });
  }
  return { parts, warnings };
}

export function rect(r0, r1, z0, z1) {
  return { start: [r0, z0], segments: [{ type: 'line', to: [r1, z0] }, { type: 'line', to: [r1, z1] }, { type: 'line', to: [r0, z1] }, { type: 'line', to: [r0, z0] }] };
}

/** 部品の z オフセットを反映した断面 */
export const placedProfile = (p) => (p.zOffset ? translateProfile(p.profile, p.zOffset) : p.profile);

/** シーンの検証: 各部品の断面と、部品どうしの重なり */
export function validateScene(parts) {
  const errors = [];
  const ed = parts.map((p) => {
    const v = validateProfile(placedProfile(p));
    if (!v.ok) errors.push({ part: p.id, message: `${p.name}: ${v.errors.join('、')}` });
    return v.ok ? v.edges : null;
  });
  for (let a = 0; a < parts.length; a++) for (let b = 0; b < parts.length; b++) {
    if (a === b || !ed[a] || !ed[b] || !parts[a].visible || !parts[b].visible) continue;
    const ba = bounds(ed[a]), bb = bounds(ed[b]);
    if (ba.zMax < bb.zMin || bb.zMax < ba.zMin) continue;
    // a の境界のすぐ内側の点が b の内部にあれば重なり
    const hit = ed[a].some((e) => {
      const m = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], n = [(e.na[0] + e.nb[0]) / 2, (e.na[1] + e.nb[1]) / 2];
      const q = [m[0] - n[0] * 1e-5, m[1] - n[1] * 1e-5];
      return q[0] > 0 && containsPoint(ed[b], q[0], q[1]);
    });
    if (hit && a < b) errors.push({ part: parts[a].id, message: `${parts[a].name} と ${parts[b].name} が重なっています` });
  }
  return { ok: errors.length === 0, errors };
}

/** 点 (r, z) を含む部品の index(なければ −1 = 周囲の空気) */
export function partAt(partsEdges, r, z) {
  for (let i = 0; i < partsEdges.length; i++) if (partsEdges[i] && containsPoint(partsEdges[i], r, z)) return i;
  return -1;
}
