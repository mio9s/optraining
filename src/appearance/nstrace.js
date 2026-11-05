// 非逐次光線追跡: 回転体の部品(断面の折れ線を回転した円錐台の集合)と光線の交点、界面の媒質判定
import { tessellate, containsPoint } from './profile.js';
import { placedProfile, OPAQUE, isMesh, meshData, meshAccel } from './scene.js';
import { buildMeshAccel, meshHits, meshContains } from './mesh.js';
import { refractiveIndex } from '../core/glass.js';
import { COATINGS } from './thinfilm.js';

export const T_MIN = 1e-6; // 自己交差を避ける最小距離 [mm]
const MERGE = 1e-6; // 同じ位置とみなす交点距離の差 [mm]

/**
 * 部品群から追跡用シーンを作る。
 * 光軸上に中心がある円弧(球面)と直線(平面・円筒・円錐)は、分割せず 1 つの図形として厳密に交差させる(高速・高精度)。
 * それ以外(ベジェ・スプライン・非球面・軸外中心の円弧)は細かい円錐台に分割して BVH で探す。
 */
const MESH_SEG = { seg: 0 }; // メッシュは全体を 1 つの面として扱う
/**
 * メッシュの頂点(ワールド座標)。接触許容差以内にある別メッシュの頂点へ寄せ、接する面を厳密に一致させる
 * (STL は部品ごとに書き出されるため、接合面の頂点が丸め誤差でずれていることが多い)
 */
function snappedMeshes(meshParts, tol) {
  const grid = new Map(), cell = Math.max(tol, 1e-9);
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const out = new Map();
  for (const p of meshParts) {
    const { V, F } = meshData(p), o = p.offset ?? [0, 0, 0];
    const W = new Float64Array(V.length);
    const mine = [];
    for (let i = 0; i < V.length; i += 3) {
      let x = V[i] + o[0], y = V[i + 1] + o[1], z = V[i + 2] + o[2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let best = null, bd = tol;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        for (const q of grid.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
          const dd = Math.hypot(q[0] - x, q[1] - y, q[2] - z);
          if (dd <= bd) { bd = dd; best = q; }
        }
      }
      if (best) { x = best[0]; y = best[1]; z = best[2]; }
      W[i] = x; W[i + 1] = y; W[i + 2] = z;
      mine.push([x, y, z]);
    }
    for (const q of mine) { const k = key(...q); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(q); }
    out.set(p, { V: W, F });
  }
  return out;
}

export function buildTraceScene(parts) {
  let mergeTol = MERGE;
  const vis = parts.filter((p) => p.visible !== false);
  const meshParts = vis.filter(isMesh);
  const tol = meshParts.reduce((m, p) => Math.max(m, p.contactTol ?? 0.002), 0);
  const snapped = meshParts.length > 1 ? snappedMeshes(meshParts, tol) : null;
  const list = vis.map((p, pi) => {
    if (isMesh(p)) {
      const acc = snapped ? buildMeshAccel(snapped.get(p), { creaseDeg: p.creaseDeg ?? 30 }) : meshAccel(p);
      mergeTol = Math.max(mergeTol, p.contactTol ?? 0.002);
      return { part: p, index: pi, kind: 'mesh', acc, box3: acc.box, edges: [], nodes: [], prims: [], all: [] };
    }
    const prof = placedProfile(p);
    const all = tessellate(prof);
    const prims = [];
    const exact = new Set();
    let cur = prof.start;
    prof.segments.forEach((sg, si) => {
      const from = cur; cur = sg.to;
      const mine = all.filter((e) => e.seg === si && !e.onAxis);
      if (!mine.length) return;
      if (sg.type === 'line') { prims.push({ kind: 'edge', edge: mine[0] }); exact.add(si); return; }
      if (sg.type === 'arc' && Math.abs(sg.center[0]) < 1e-12) {
        const zc = sg.center[1], R = Math.hypot(from[0] - sg.center[0], from[1] - zc);
        const ang = (q) => Math.atan2(q[0], q[1] - zc);
        const a0 = ang(from), a1 = ang(sg.to);
        const m = mine[Math.floor(mine.length / 2)], mp = [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2];
        const radial = [mp[0], mp[1] - zc];
        const sign = (radial[0] * (m.na[0] + m.nb[0]) + radial[1] * (m.na[1] + m.nb[1])) >= 0 ? 1 : -1; // 外向き = 中心から外か
        prims.push({ kind: 'sphere', seg: si, zc, R, a0: Math.min(a0, a1), a1: Math.max(a0, a1), sign,
          box: { z0: Math.min(...mine.map((e) => Math.min(e.a[1], e.b[1]))), z1: Math.max(...mine.map((e) => Math.max(e.a[1], e.b[1]))), r0: Math.min(...mine.map((e) => Math.min(e.a[0], e.b[0]))), r1: Math.max(...mine.map((e) => Math.max(e.a[0], e.b[0]))) } });
        exact.add(si);
      }
    });
    const edges = all.filter((e) => !e.onAxis && !exact.has(e.seg));
    const nodes = buildBVH(edges);
    let box = null;
    for (const e of all) { const b = edgeBox(e); box = box ? mergeBox(box, b) : b; }
    return { part: p, index: pi, all, edges, nodes, prims, box };
  });
  return { list, mergeTol, mediumAt: (x, y, z) => mediumAt(list, x, y, z) };
}

function aabbHit(b, o, d, tmin, tmax) {
  for (let c = 0; c < 3; c++) {
    const inv = 1 / d[c];
    let t0 = (b[c] - 1e-9 - o[c]) * inv, t1 = (b[c + 3] + 1e-9 - o[c]) * inv;
    if (t0 > t1) { const x = t0; t0 = t1; t1 = x; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  return true;
}

/** 光軸中心の球面との交点 */
function sphereHits(pr, o, d, tmin, out) {
  const ox = o[0], oy = o[1], oz = o[2] - pr.zc;
  const b = ox * d[0] + oy * d[1] + oz * d[2], c = ox * ox + oy * oy + oz * oz - pr.R * pr.R;
  const D = b * b - c;
  if (D < 0) return;
  const sq = Math.sqrt(D);
  for (const t of [-b - sq, -b + sq]) {
    if (!(t >= tmin)) continue;
    const x = o[0] + t * d[0], y = o[1] + t * d[1], z = o[2] + t * d[2];
    const rho = Math.hypot(x, y), a = Math.atan2(rho, z - pr.zc);
    if (a < pr.a0 - 1e-12 || a > pr.a1 + 1e-12) continue;
    const k = pr.sign / pr.R;
    out.push({ t, x, y, rho, normal: [x * k, y * k, (z - pr.zc) * k] });
  }
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

/**
 * 最も近い交点(同じ位置の共有面はまとめる)。返り値 null または {t, point, hits:[{entry, edge, s, normal}], skip}
 * prev: 直前の交点。メッシュの接触面を許容差でまとめたとき、まとめた部品へのごく近い再交差(許容差内のずれ)を無視する
 */
export function intersect(scene, o, d, tmin = T_MIN, tmax = Infinity, prev = null) {
  let best = tmax;
  const found = [];
  const tmp = [];
  const MG = scene.mergeTol ?? MERGE;
  const sk = prev?.skip;
  for (const entry of scene.list) {
    if (entry.kind === 'mesh') {
      if (!aabbHit(entry.box3, o, d, tmin, best + MG)) continue;
      tmp.length = 0;
      // 直前の界面でまとめたメッシュは、許容差内の再交差を飛ばす(探し始めを遅らせる)
      const t0 = sk && sk.entries.includes(entry) ? Math.max(tmin, sk.dist) : tmin;
      meshHits(entry.acc, o, d, t0, best + MG, tmp, MG);
      for (const h of tmp) { h.entry = entry; h.edge = MESH_SEG; found.push(h); if (h.t < best) best = h.t; }
      continue;
    }
    const { nodes, edges, prims } = entry;
    if (!entry.box || !boxHit(entry.box, o, d, tmin, best + MERGE)) continue;
    for (const pr of prims) {
      tmp.length = 0;
      if (pr.kind === 'sphere') { if (!boxHit(pr.box, o, d, tmin, best + MERGE)) continue; sphereHits(pr, o, d, tmin, tmp); }
      else edgeHits(pr.edge, o, d, tmin, tmp);
      for (let q = 0; q < tmp.length; q++) {
        const h = tmp[q];
        if (h.t > best + MERGE) continue;
        h.entry = entry; h.edge = pr.edge ?? pr.segRef ?? (pr.segRef = { seg: pr.seg });
        found.push(h);
        if (h.t < best) best = h.t;
      }
    }
    if (!nodes.length) continue;
    const stack = [0];
    while (stack.length) {
      const n = nodes[stack.pop()];
      if (!boxHit(n, o, d, tmin, best + MERGE)) continue;
      if (!n.leaf) { stack.push(n.l, n.r); continue; }
      for (let i = n.lo; i < n.hi; i++) {
        tmp.length = 0;
        edgeHits(edges[i], o, d, tmin, tmp);
        for (let q = 0; q < tmp.length; q++) {
          const h = tmp[q];
          if (h.t > best + MERGE) continue;
          h.entry = entry; h.edge = edges[i];
          found.push(h);
          if (h.t < best) best = h.t;
        }
      }
    }
  }
  if (!found.length || best === tmax) return null;
  const hits = found.filter((h) => h.t <= best + MG);
  // 同じ部品の隣接辺の重複(頂点上)は 1 つに
  hits.sort((a, b) => a.t - b.t);
  const uniq = [];
  for (const h of hits) if (!uniq.some((u) => u.entry === h.entry)) uniq.push(h);
  const point = [o[0] + best * d[0], o[1] + best * d[1], o[2] + best * d[2]];
  const mapped = uniq.map((h) => ({ entry: h.entry, edge: h.edge, s: h.s, normal: normal3(h), gnormal: h.gnormal }));
  // 許容差でまとめた(t がずれている)メッシュがあれば、次の光線ではそれらの近い交点を飛ばす
  const spread = uniq.length > 1 ? uniq[uniq.length - 1].t - best : 0;
  const skip = spread > MERGE && uniq.some((h) => h.entry.kind === 'mesh') ? { entries: uniq.map((h) => h.entry), dist: 4 * MG } : null;
  return { t: best, point, hits: mapped, primary: mapped[0], skip };
}

/** 外向き法線(元の曲線の法線を補間) */
function normal3(h) {
  if (h.normal) return h.normal; // 球面(厳密)
  const e = h.edge, s = h.s;
  let nr = e.na[0] * (1 - s) + e.nb[0] * s, nz = e.na[1] * (1 - s) + e.nb[1] * s;
  const L = Math.hypot(nr, nz) || 1; nr /= L; nz /= L;
  if (h.rho < 1e-12) return [0, 0, Math.sign(nz) || 1];
  return [(nr * h.x) / h.rho, (nr * h.y) / h.rho, nz];
}

function mediumAt(list, x, y, z) {
  const r = Math.hypot(x, y);
  for (const e of list) {
    if (e.kind === 'mesh') { if (meshContains(e.acc, [x, y, z])) return e; continue; }
    if (containsPoint(e.all, r, z)) return e;
  }
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
  const Ng = h.gnormal ?? N; // 内外の判定は面の法線(メッシュの滑らかな法線は境界付近で傾くため)
  // 部品は重ならないので、面の内側 = 当たった部品、外側 = 同じ位置で当たった共有面の相手(なければ空気)
  const other = hit.hits.find((x) => x.entry !== h.entry);
  const inside = h.entry, outside = other ? other.entry : null;
  const entering = d[0] * Ng[0] + d[1] * Ng[1] + d[2] * Ng[2] < 0;
  const before = entering ? outside : inside, after = entering ? inside : outside;
  let toward = entering ? N : [-N[0], -N[1], -N[2]]; // 入射側を向く法線(屈折・反射には滑らかな法線)
  if (d[0] * toward[0] + d[1] * toward[1] + d[2] * toward[2] >= 0) toward = entering ? Ng : [-Ng[0], -Ng[1], -Ng[2]];
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
