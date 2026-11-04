// 非逐次光線追跡: 回転体の部品(断面の折れ線を回転した円錐台の集合)と光線の交点、界面の媒質判定
import { tessellate, containsPoint } from './profile.js';
import { placedProfile, OPAQUE } from './scene.js';
import { refractiveIndex } from '../core/glass.js';
import { COATINGS } from './thinfilm.js';

export const T_MIN = 1e-6; // 自己交差を避ける最小距離 [mm]
const MERGE = 1e-6; // 同じ位置とみなす交点距離の差 [mm]

/** 部品群から追跡用シーンを作る */
export function buildTraceScene(parts) {
  const list = parts.filter((p) => p.visible !== false).map((p, pi) => {
    const all = tessellate(placedProfile(p));
    const edges = all.filter((e) => !e.onAxis);
    const nodes = buildBVH(edges);
    return { part: p, index: pi, all, edges, nodes };
  });
  return { list, mediumAt: (x, y, z) => mediumAt(list, x, y, z) };
}

function edgeBox(e) {
  return { z0: Math.min(e.a[1], e.b[1]), z1: Math.max(e.a[1], e.b[1]), r0: Math.min(e.a[0], e.b[0]), r1: Math.max(e.a[0], e.b[0]) };
}
function buildBVH(edges) {
  // 輪郭順の連続区間で 2 分木(隣り合う辺は空間的にも近い)
  const nodes = [];
  const build = (lo, hi) => {
    const id = nodes.length;
    nodes.push(null);
    let box;
    if (hi - lo <= 4) {
      box = edges.slice(lo, hi).map(edgeBox).reduce(mergeBox);
      nodes[id] = { ...box, lo, hi, leaf: true };
    } else {
      const mid = (lo + hi) >> 1;
      const l = build(lo, mid), r = build(mid, hi);
      box = mergeBox(nodes[l], nodes[r]);
      nodes[id] = { ...box, l, r, leaf: false };
    }
    return id;
  };
  if (edges.length) build(0, edges.length);
  return nodes;
}
const mergeBox = (a, b) => ({ z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1), r0: Math.min(a.r0, b.r0), r1: Math.max(a.r1, b.r1) });

/** 光線が (z, r) の箱を回転した領域を [tmin, tmax] 内で通りうるか */
function boxHit(b, o, d, tmin, tmax) {
  let ta = tmin, tb = tmax;
  if (Math.abs(d[2]) < 1e-15) { if (o[2] < b.z0 - 1e-9 || o[2] > b.z1 + 1e-9) return false; }
  else {
    let t0 = (b.z0 - 1e-9 - o[2]) / d[2], t1 = (b.z1 + 1e-9 - o[2]) / d[2];
    if (t0 > t1) [t0, t1] = [t1, t0];
    ta = Math.max(ta, t0); tb = Math.min(tb, t1);
    if (ta > tb) return false;
  }
  // ρ²(t) = |o_xy + t d_xy|² は t の 2 次関数
  const A = d[0] * d[0] + d[1] * d[1], B = 2 * (o[0] * d[0] + o[1] * d[1]), C = o[0] * o[0] + o[1] * o[1];
  const rho2 = (t) => (A * t + B) * t + C;
  let mn = Math.min(rho2(ta), rho2(tb)), mx = Math.max(rho2(ta), rho2(tb));
  if (A > 0) { const tv = -B / (2 * A); if (tv > ta && tv < tb) mn = Math.min(mn, rho2(tv)); }
  const lo = Math.max(0, b.r0 - 1e-9), hi = b.r1 + 1e-9;
  return !(mx < lo * lo || mn > hi * hi);
}

/** 辺(円錐台)と光線の交点 t の候補 */
function edgeHits(e, o, d, tmin, out) {
  const [r0, z0] = e.a, [r1, z1] = e.b;
  const dzE = z1 - z0;
  if (Math.abs(dzE) < 1e-15) { // 円環(平面)
    if (Math.abs(d[2]) < 1e-15) return;
    const t = (z0 - o[2]) / d[2];
    if (t < tmin) return;
    const x = o[0] + t * d[0], y = o[1] + t * d[1], rho = Math.hypot(x, y);
    const lo = Math.min(r0, r1), hi = Math.max(r0, r1);
    if (rho >= lo - 1e-12 && rho <= hi + 1e-12) out.push({ t, s: hi > lo ? (rho - r0) / (r1 - r0) : 0.5, x, y, rho });
    return;
  }
  const k = (r1 - r0) / dzE;
  const w = r0 + k * (o[2] - z0); // t=0 での円錐半径
  const A = d[0] * d[0] + d[1] * d[1] - k * k * d[2] * d[2];
  const B = 2 * (o[0] * d[0] + o[1] * d[1] - k * d[2] * w);
  const C = o[0] * o[0] + o[1] * o[1] - w * w;
  const roots = [];
  if (Math.abs(A) < 1e-14) { if (Math.abs(B) > 1e-300) roots.push(-C / B); }
  else {
    const D = B * B - 4 * A * C;
    if (D < 0) return;
    const sq = Math.sqrt(D), q = -0.5 * (B + (B >= 0 ? sq : -sq));
    if (q !== 0) roots.push(C / q);
    roots.push(q / A);
  }
  for (const t of roots) {
    if (!(t >= tmin)) continue;
    const z = o[2] + t * d[2];
    const s = (z - z0) / dzE;
    if (s < -1e-12 || s > 1 + 1e-12) continue;
    const rc = r0 + k * (z - z0);
    if (rc < -1e-12) continue; // 円錐の反対側の葉
    const x = o[0] + t * d[0], y = o[1] + t * d[1];
    out.push({ t, s: Math.min(1, Math.max(0, s)), x, y, rho: Math.hypot(x, y) });
  }
}

/** 最も近い交点(同じ位置の共有面はまとめる)。返り値 null または {t, point, hits:[{entry, edge, s, normal}]} */
export function intersect(scene, o, d, tmin = T_MIN, tmax = Infinity) {
  let best = tmax;
  const found = [];
  const tmp = [];
  for (const entry of scene.list) {
    const { nodes, edges } = entry;
    if (!nodes.length) continue;
    const stack = [0];
    while (stack.length) {
      const n = nodes[stack.pop()];
      if (!boxHit(n, o, d, tmin, best + MERGE)) continue;
      if (!n.leaf) { stack.push(n.l, n.r); continue; }
      for (let i = n.lo; i < n.hi; i++) {
        tmp.length = 0;
        edgeHits(edges[i], o, d, tmin, tmp);
        for (const h of tmp) if (h.t <= best + MERGE) {
          found.push({ entry, edge: edges[i], ...h });
          if (h.t < best) best = h.t;
        }
      }
    }
  }
  if (!found.length || best === tmax) return null;
  const hits = found.filter((h) => h.t <= best + MERGE);
  // 同じ部品の隣接辺の重複(頂点上)は 1 つに
  const uniq = [];
  for (const h of hits) if (!uniq.some((u) => u.entry === h.entry)) uniq.push(h);
  const point = [o[0] + best * d[0], o[1] + best * d[1], o[2] + best * d[2]];
  const mapped = uniq.map((h) => ({ entry: h.entry, edge: h.edge, s: h.s, normal: normal3(h) }));
  return { t: best, point, hits: mapped, primary: mapped[0] };
}

/** 外向き法線(元の曲線の法線を補間) */
function normal3(h) {
  const e = h.edge, s = h.s;
  let nr = e.na[0] * (1 - s) + e.nb[0] * s, nz = e.na[1] * (1 - s) + e.nb[1] * s;
  const L = Math.hypot(nr, nz) || 1; nr /= L; nz /= L;
  if (h.rho < 1e-12) return [0, 0, Math.sign(nz) || 1];
  return [(nr * h.x) / h.rho, (nr * h.y) / h.rho, nz];
}

function mediumAt(list, x, y, z) {
  const r = Math.hypot(x, y);
  for (const e of list) if (containsPoint(e.all, r, z)) return e;
  return null; // 周囲(空気)
}

export function materialIndex(mat, lambdaUm) {
  if (!mat || mat.type === 'air') return 1;
  if (mat.type === 'opaque') return NaN;
  return refractiveIndex(mat, lambdaUm);
}

function coatingLayers(c) {
  if (!c) return [];
  if (typeof c === 'string') return COATINGS[c]?.layers ?? [];
  return c.layers ?? [];
}

/**
 * 交点での界面情報。
 * 返り値: {nBefore, nAfter, before, after (entry|null), normal(入射側を向く単位法線), cosI, layers(入射側→射出側の順), opaque}
 */
export function interfaceAt(scene, hit, d, lambdaUm) {
  const h = hit.primary;
  const N = h.normal;
  // 部品は重ならないので、面の内側 = 当たった部品、外側 = 同じ位置で当たった共有面の相手(なければ空気)
  const other = hit.hits.find((x) => x.entry !== h.entry);
  const inside = h.entry, outside = other ? other.entry : null;
  const entering = d[0] * N[0] + d[1] * N[1] + d[2] * N[2] < 0;
  const before = entering ? outside : inside, after = entering ? inside : outside;
  const toward = entering ? N : [-N[0], -N[1], -N[2]]; // 入射側を向く法線
  const cosI = -(d[0] * toward[0] + d[1] * toward[1] + d[2] * toward[2]);
  // コート: まとめた面のうち、割り当てのあるもの。層は「部品の外側 → 部品(基板)」の順で定義
  let layers = [];
  for (const x of hit.hits) {
    const c = coatingLayers(x.entry.part.coatings?.[x.edge.seg]);
    if (!c.length) continue;
    // その部品へ入る向きなら定義順、出る向きなら逆順
    const ent = d[0] * x.normal[0] + d[1] * x.normal[1] + d[2] * x.normal[2] < 0;
    layers = ent ? c : [...c].reverse();
    break;
  }
  const matB = before?.part.material, matA = after?.part.material;
  const opaque = matA?.type === 'opaque' ? matA : matB?.type === 'opaque' ? matB : null;
  return {
    before, after, normal: toward, cosI,
    nBefore: materialIndex(matB, lambdaUm), nAfter: materialIndex(matA, lambdaUm),
    layers, opaque: opaque ? { ...OPAQUE[opaque.kind], kind: opaque.kind } : null,
  };
}
