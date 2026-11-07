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

/**
 * parts には、閉じた空洞(部品に囲まれ外とつながらない隙間)の媒質を指定する
 * 擬似部品 {kind:'cavity', material} を 1 つ含めてよい(空気なら省略と同じ)
 */
export function buildTraceScene(parts) {
  let mergeTol = MERGE;
  const cavPart = parts.find((p) => p.kind === 'cavity' && ((p.material && p.material.type !== 'air') || Object.values(p.materials ?? {}).some((m) => m && m.type !== 'air') || (p.assign ?? []).some((a) => a.material?.type !== 'air') || p.detect));
  const vis = parts.filter((p) => p.visible !== false && p.kind !== 'cavity');
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
  const scene = { list, mergeTol };
  // 画面で作った空洞の格子があれば使う(Worker が作り直さない)
  scene.cavity = cavPart && list.length ? (cavPart.data ? cavityFromData(cavPart.data) : buildCavity(scene, cavPart)) : null;
  scene.mediumAt = (x, y, z) => mediumAt(scene, x, y, z);
  return scene;
}

// ---------- 閉じた空洞 ----------
const CAV_N = 200, CAV_MAX = 1.6e7, AIR = { type: 'air' };
/** 3 次元の 0/1 配列を直方体(半径 rx, ry, rz 格子)で膨張(軸ごとの累積和で O(N)) */
function dilateBox(M, nx, ny, nz, r) {
  let A = M;
  const dims = [nx, ny, nz], stride = [1, nx, nx * ny];
  for (let ax = 0; ax < 3; ax++) {
    const R = r[ax];
    if (R <= 0) continue;
    const n = dims[ax], st = stride[ax], B = new Uint8Array(A.length), pre = new Int32Array(n + 1);
    const o1 = ax === 0 ? 1 : 0, o2 = ax === 2 ? 1 : 2; // 残り 2 軸
    const d1 = dims[o1 === ax ? 1 : o1], d2 = dims[o2];
    const s1 = stride[o1 === ax ? 1 : o1], s2 = stride[o2];
    for (let q = 0; q < d2; q++) for (let p = 0; p < d1; p++) {
      const base = p * s1 + q * s2;
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + A[base + i * st];
      for (let i = 0; i < n; i++) if (pre[Math.min(n, i + R + 1)] - pre[Math.max(0, i - R)] > 0) B[base + i * st] = 1;
    }
    A = B;
  }
  return A;
}
/**
 * 部品の外接箱を格子に分け、各格子が部品の中か外かを z 方向の光線で調べ、箱の外側から外の格子をたどる(塗りつぶし)。
 * たどれなかった外の格子 = 閉じた空洞。つながりごとに別の空洞とし、光軸方向(z)の重心の順に番号を付ける。
 * z 方向の格子は、z 方向に並ぶ最も薄い層(膜など)の半分以下にする。
 * cavPart: {material(既定), materials: {番号: material}(空洞ごと), seal(この幅より細い通路はふさぐ mm)}
 */
function buildCavity(scene, cavPart) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const e of scene.list) {
    let b;
    if (e.kind === 'mesh') b = e.box3;
    else { const r = Math.max(...e.all.map((x) => Math.max(x.a[0], x.b[0]))); const z = e.all.flatMap((x) => [x.a[1], x.b[1]]); b = [-r, -r, Math.min(...z), r, r, Math.max(...z)]; }
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[k]); hi[k] = Math.max(hi[k], b[k + 3]); }
  }
  const seal = cavPart.seal ?? 0;
  let cell = Math.max(hi[0] - lo[0], hi[1] - lo[1]) / CAV_N;
  if (!(cell > 0)) cell = (hi[2] - lo[2]) / CAV_N;
  // まず z 方向の光線で各列の界面を集める(列は xy の格子の中心)
  const dz = [0, 0, 1];
  const columns = (c) => {
    // 外周の余白は、通路をふさぐときの膨らみ(seal/2)より広くとる(狭いと、部品の外の角が外から切り離されて空洞に見える)
    const pad = Math.max(2, Math.ceil(seal / 2 / c) + 3);
    const nx = Math.ceil((hi[0] - lo[0]) / c) + 2 * pad, ny = Math.ceil((hi[1] - lo[1]) / c) + 2 * pad, o = [lo[0] - pad * c, lo[1] - pad * c];
    const cols = new Array(nx * ny);
    let thin = Infinity;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = o[0] + (i + 0.5) * c + c * 1.3e-4, y = o[1] + (j + 0.5) * c + c * 0.7e-4;
      let p = [x, y, lo[2] - 1], prev = null, inside = null, zPrev = null;
      const ev = [];
      for (let g = 0; g < 400; g++) {
        const hit = intersect(scene, p, dz, T_MIN, Infinity, prev);
        if (!hit) break;
        const f = interfaceAt(scene, hit, dz, 0.55), z = hit.point[2];
        // 部品の層(膜など)の最も薄い厚み。くさび形に細る隙間は対象外。10 µm 未満は書き出しの丸めとみなす
        if (inside && zPrev !== null && z - zPrev > 0.01) thin = Math.min(thin, z - zPrev);
        ev.push([zPrev, z, inside ? 1 : 0]);
        inside = f.after; zPrev = z; p = hit.point; prev = hit;
      }
      cols[j * nx + i] = ev;
    }
    return { nx, ny, o, cols, thin };
  };
  let C = columns(cell);
  let cz = Math.min(cell, Math.max(0.005, (Number.isFinite(C.thin) ? C.thin : cell) / 2.5));
  const pz = (c) => Math.max(2, Math.ceil(seal / 2 / c) + 3);
  let nz = Math.ceil((hi[2] - lo[2]) / cz) + 2 * pz(cz);
  while (C.nx * C.ny * nz > CAV_MAX) { // 大きすぎる: 横の格子を粗くする
    cell *= 1.25; C = columns(cell);
    cz = Math.min(cell, Math.max(0.005, (Number.isFinite(C.thin) ? C.thin : cell) / 2.5));
    nz = Math.ceil((hi[2] - lo[2]) / cz) + 2 * pz(cz);
  }
  const { nx, ny } = C, oz = lo[2] - pz(cz) * cz;
  const o = [C.o[0], C.o[1], oz];
  const G = new Uint8Array(nx * ny * nz); // 0 外, 1 部品, 2 空洞
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  for (let q = 0; q < nx * ny; q++) {
    const i = q % nx, j = (q - i) / nx;
    for (const [z0, z1, inside] of C.cols[q]) {
      if (!inside || z0 === null) continue;
      const k0 = Math.max(0, Math.ceil((z0 - oz) / cz - 0.5)), k1 = Math.min(nz - 1, Math.floor((z1 - oz) / cz - 0.5));
      for (let k = k0; k <= k1; k++) G[idx(i, j, k)] = 1;
    }
  }
  // 細い通路をふさぐ: 部品を半径 seal/2 だけ膨らませた所は、外からたどるときだけ通れない(収縮 → 塗りつぶし → 膨張)
  const r = [Math.round(seal / 2 / cell), Math.round(seal / 2 / cell), Math.round(seal / 2 / cz)];
  const sealing = r.some((x) => x > 0);
  let blocked = null;
  if (sealing) { const P = new Uint8Array(G.length); for (let q = 0; q < G.length; q++) P[q] = G[q] === 1 ? 1 : 0; blocked = dilateBox(P, nx, ny, nz, r); }
  const open = (q) => !G[q] && (!blocked || !blocked[q]);
  const seen = new Uint8Array(G.length), stack = [];
  const push = (q) => { if (open(q) && !seen[q]) { seen[q] = 1; stack.push(q); } };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { push(idx(i, j, 0)); push(idx(i, j, nz - 1)); }
  for (let k = 0; k < nz; k++) { for (let i = 0; i < nx; i++) { push(idx(i, 0, k)); push(idx(i, ny - 1, k)); } for (let j = 0; j < ny; j++) { push(idx(0, j, k)); push(idx(nx - 1, j, k)); } }
  const flood = (ok, mark, val) => {
    while (stack.length) {
      const q = stack.pop(), i = q % nx, j = ((q - i) / nx) % ny, k = Math.floor(q / (nx * ny));
      const nb = [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, j > 0 ? q - nx : -1, j < ny - 1 ? q + nx : -1, k > 0 ? q - nx * ny : -1, k < nz - 1 ? q + nx * ny : -1];
      for (const w of nb) if (w >= 0 && ok(w) && !mark[w]) { mark[w] = val; stack.push(w); }
    }
  };
  flood(open, seen, 1);
  if (sealing) { // 膨張: たどれた外の領域を同じだけ空きへ広げる(部品の近くの外気を戻す。通路の入口は外気 = 栓)
    const back = dilateBox(seen, nx, ny, nz, r);
    for (let q = 0; q < G.length; q++) if (back[q] && !G[q]) seen[q] = 1;
  }
  // ふさがずにたどった外(通路をふさいだから閉じたのか、もともと閉じているのかを分けるため)
  let seen0 = null;
  if (sealing) {
    seen0 = new Uint8Array(G.length);
    const push0 = (q) => { if (!G[q] && !seen0[q]) { seen0[q] = 1; stack.push(q); } };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { push0(idx(i, j, 0)); push0(idx(i, j, nz - 1)); }
    for (let k = 0; k < nz; k++) { for (let i = 0; i < nx; i++) { push0(idx(i, 0, k)); push0(idx(i, ny - 1, k)); } for (let j = 0; j < ny; j++) { push0(idx(0, j, k)); push0(idx(nx - 1, j, k)); } }
    flood((q) => !G[q], seen0, 1);
  }
  // 空洞をつながりごとに分ける
  const comp = new Int32Array(G.length).fill(-1), info = [];
  for (let q = 0; q < G.length; q++) {
    if (G[q] || seen[q] || comp[q] >= 0) continue;
    const id = info.length;
    comp[q] = id; stack.push(q);
    let n = 0, sz = 0, sx = 0, sy = 0, sealed = false;
    const qi = q % nx, qj = ((q - qi) / nx) % ny, qk = Math.floor(q / (nx * ny));
    const seed = [o[0] + (qi + 0.5) * cell, o[1] + (qj + 0.5) * cell, oz + (qk + 0.5) * cz]; // 空洞の中にある点(重心は曲がった空洞の外に出ることがある)
    while (stack.length) {
      const u = stack.pop(), i = u % nx, j = ((u - i) / nx) % ny, k = Math.floor(u / (nx * ny));
      n++; sx += i; sy += j; sz += k;
      if (seen0 && seen0[u]) sealed = true; // 通路をふさがなければ外とつながっている
      const nb = [i > 0 ? u - 1 : -1, i < nx - 1 ? u + 1 : -1, j > 0 ? u - nx : -1, j < ny - 1 ? u + nx : -1, k > 0 ? u - nx * ny : -1, k < nz - 1 ? u + nx * ny : -1];
      for (const w of nb) if (w >= 0 && !G[w] && !seen[w] && comp[w] < 0) { comp[w] = id; stack.push(w); }
    }
    info.push({ id, cells: n, seed, sealed, centroid: [o[0] + (sx / n + 0.5) * cell, o[1] + (sy / n + 0.5) * cell, oz + (sz / n + 0.5) * cz] });
  }
  // 小さすぎる空洞は、縁の丸め・部品の合わせ目の隙間とみなして除く(最大の空洞の 0.5 % 未満かつ 1 mm³ 未満)
  const vcell = cell * cell * cz, vmax = Math.max(0, ...info.map((c) => c.cells)) * vcell;
  let real = info.filter((c) => c.cells * vcell >= Math.min(1, 0.005 * vmax) && c.cells * vcell > 1e-3);
  // 空洞の番号は格子に 1 バイトで持つので 255 個まで。超えたら体積の大きい順に残し、残りは空気として数だけ知らせる
  // (一覧に出して計算で使わない、という食い違いを作らない)
  let overflow = 0;
  if (real.length > 255) { real.sort((a, b) => b.cells - a.cells); overflow = real.length - 255; real = real.slice(0, 255); }
  real.sort((a, b) => a.centroid[2] - b.centroid[2]);
  // 空洞ごとの媒質(判定はここだけで行い、画面もこの結果 comps[].assign を使う):
  //   assign = [{part, local, material}] … 部品 part の位置(offset / zOffset)からの相対位置 local にある空洞。部品を動かすと一緒に動く
  //            [{at, material}]          … シーンの絶対位置(古い保存データ)
  //   その点を含む空洞(点が空洞の格子の上になければ、まわり 2 格子以内の空洞)に当てる。見つからない指定は使わない(画面で知らせる)
  //   materials = {番号: material} は z 順の番号に。どれもなければ既定の material。
  //   既定は完全に閉じた空洞だけに使う。細い通路をふさいだから閉じた空洞(sealed)は、外とつながる隙間(部品の縁の丸みと膜の間など)も
  //   含むので、個別に選んだときだけ媒質を変える(それ以外は空気)
  const byPart = new Map(scene.list.map((e) => [e.part.id, e.part]));
  const cellIdx = (x, y, z) => { const i = Math.floor((x - o[0]) / cell), j = Math.floor((y - o[1]) / cell), k = Math.floor((z - oz) / cz); return i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? -1 : idx(i, j, k); };
  const realIndex = new Map(real.map((c, n) => [c.id, n]));
  const compAtPoint = (p) => {
    const q = cellIdx(...p);
    if (q >= 0 && comp[q] >= 0 && realIndex.has(comp[q])) return realIndex.get(comp[q]);
    for (let r = 1; r <= 2; r++) for (let dk = -r; dk <= r; dk++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const w = cellIdx(p[0] + di * cell, p[1] + dj * cell, p[2] + dk * cz);
      if (w >= 0 && comp[w] >= 0 && realIndex.has(comp[w])) return realIndex.get(comp[w]);
    }
    return -1;
  };
  const assigned = new Map();
  (cavPart.assign ?? []).forEach((a, ai) => {
    const pt = assignPoint(a, byPart);
    if (!pt) return;
    const n = compAtPoint(pt);
    if (n >= 0 && !assigned.has(n)) assigned.set(n, ai);
  });
  const comps = real.map((c, n) => {
    const ai = assigned.has(n) ? assigned.get(n) : -1;
    const mat = ai >= 0 ? cavPart.assign[ai].material : cavPart.materials?.[n] ?? (c.sealed ? AIR : cavPart.material);
    return { index: n, volume: c.cells * vcell, centroid: c.centroid, seed: c.seed, sealed: c.sealed, assign: ai, material: mat,
      entry: mat && mat.type !== 'air' ? { part: { id: `cavity${n}`, name: `空洞 ${n + 1}`, material: mat, coatings: {} }, kind: 'cavity' } : null };
  });
  // 残すのは 1 格子 1 バイトの 2 枚だけ: G(0 外 / 1 部品 / 2 媒質の入った空洞)と C(空洞の番号 + 1。0 = 空洞でない)
  // (つながりの番号 comp は Int32 で 4 バイト/格子あり、Worker ごとに持つと重いので捨てる)
  const CN = new Uint8Array(G.length);
  for (let q = 0; q < G.length; q++) {
    const n = comp[q] >= 0 ? realIndex.get(comp[q]) : undefined;
    if (n === undefined) { if (comp[q] >= 0) G[q] = 0; continue; }
    CN[q] = n + 1; G[q] = comps[n].entry ? 2 : 0;
  }
  const used = new Set(comps.map((c) => c.assign).filter((x) => x >= 0));
  const unmatched = (cavPart.assign ?? []).map((_, i) => i).filter((i) => !used.has(i));
  return cavityFromData({ G, C: CN, o, nx, ny, nz, cell, cz, comps: comps.map(({ entry, ...c }) => c), unmatched, overflow });
}

/**
 * 空洞の格子と一覧から、追跡で使う形(at・entryAt・媒質の entry)を作る。
 * buildCavity の結果を Worker へ渡すときもこれで復元する(Worker で作り直さない。格子は 2 バイト/格子)
 */
export function cavityFromData(d) {
  const { G, C, o, nx, ny, nz, cell, cz } = d;
  const comps = d.comps.map((c) => ({ ...c, entry: c.material && c.material.type !== 'air' ? { part: { id: `cavity${c.index}`, name: `空洞 ${c.index + 1}`, material: c.material, coatings: {} }, kind: 'cavity' } : null }));
  const cellOf = (x, y, z) => {
    const i = Math.floor((x - o[0]) / cell), j = Math.floor((y - o[1]) / cell), k = Math.floor((z - o[2]) / cz);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    return (k * ny + j) * nx + i;
  };
  const at = (x, y, z) => { const q = cellOf(x, y, z); return q < 0 ? 0 : G[q]; };
  const entryAt = (x, y, z) => { const q = cellOf(x, y, z); if (q < 0 || G[q] !== 2) return null; return comps[C[q] - 1]?.entry ?? null; };
  const filled = comps.filter((c) => c.entry);
  return { comps, unmatched: d.unmatched ?? [], overflow: d.overflow ?? 0, entry: filled[0]?.entry ?? null, volume: filled.reduce((a, c) => a + c.volume, 0), cell, cz, at, entryAt, grid: { G, C, o, nx, ny, nz, cz },
    /** Worker へ渡す形(関数・entry を含まない) */
    data: () => ({ G, C, o, nx, ny, nz, cell, cz, comps: d.comps, unmatched: d.unmatched ?? [], overflow: d.overflow ?? 0 }) };
}

/** 部品の位置(STL は offset、回転体は zOffset) */
const partOffset = (p) => (p.kind === 'mesh' ? p.offset ?? [0, 0, 0] : [0, 0, p.zOffset ?? 0]);
/** 空洞の指定の点(シーン座標)。部品に結び付いた指定はその部品の今の位置から */
function assignPoint(a, byPart) {
  if (a.part !== undefined) { const p = byPart.get(a.part); if (!p) return null; const o = partOffset(p); return a.local.map((v, k) => v + o[k]); }
  return a.at ?? null;
}
/**
 * 空洞の中の点 p を、近くの部品に結び付けた指定に変える: {part, local}。
 * 光軸方向(−z, +z)に光線を出して最初に当たった部品を基準にする(空洞を囲む部品なので、一緒に動けば空洞も一緒に動く)
 */
export function cavityAnchor(scene, p) {
  let best = null;
  for (const d of [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]) {
    const h = intersect(scene, p, d);
    if (h && h.primary.entry.part && h.primary.entry.kind !== 'cavity' && (!best || h.t < best.t)) best = { t: h.t, part: h.primary.entry.part };
  }
  if (!best) return { at: [...p] };
  const o = partOffset(best.part);
  return { part: best.part.id, local: p.map((v, k) => +(v - o[k]).toFixed(6)) };
}

/** 部品の外側の点 p(面の外向き法線 n)がある空洞の媒質(なければ null)。面に接する格子が部品側なら外へ少しずつ進めて調べる */
function cavityEntryAt(cav, p, n) {
  if (!cav?.entry) return null;
  // 格子は z と xy で大きさが違う: 細かい方から、粗い方の 1.5 格子ぶんまで外へ進めて調べる
  const ds = [0.05, 0.5, 1, 1.5, 2].map((k) => k * cav.cz).concat([0.5, 1, 1.5].map((k) => k * cav.cell)).sort((a, b) => a - b);
  for (const d of ds) {
    const x = p[0] + n[0] * d, y = p[1] + n[1] * d, z = p[2] + n[2] * d;
    const g = cav.at(x, y, z);
    if (g !== 1) return g === 2 ? cav.entryAt(x, y, z) : null;
  }
  return null;
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
    // 直前の界面でまとめた部品なら、許容差内の再交差を飛ばす(STL と接する回転体も同じ)
    const skipR = sk && sk.entries.includes(entry) ? sk.dist : -1;
    if (!entry.box || !boxHit(entry.box, o, d, tmin, best + MG)) continue;
    for (const pr of prims) {
      tmp.length = 0;
      if (pr.kind === 'sphere') { if (!boxHit(pr.box, o, d, tmin, best + MG)) continue; sphereHits(pr, o, d, tmin, tmp); }
      else edgeHits(pr.edge, o, d, tmin, tmp);
      for (let q = 0; q < tmp.length; q++) {
        const h = tmp[q];
        if (h.t > best + MG || h.t < skipR) continue;
        h.entry = entry; h.edge = pr.edge ?? pr.segRef ?? (pr.segRef = { seg: pr.seg });
        found.push(h);
        if (h.t < best) best = h.t;
      }
    }
    if (!nodes.length) continue;
    const stack = [0];
    while (stack.length) {
      const n = nodes[stack.pop()];
      if (!boxHit(n, o, d, tmin, best + MG)) continue;
      if (!n.leaf) { stack.push(n.l, n.r); continue; }
      for (let i = n.lo; i < n.hi; i++) {
        tmp.length = 0;
        edgeHits(edges[i], o, d, tmin, tmp);
        for (let q = 0; q < tmp.length; q++) {
          const h = tmp[q];
          if (h.t > best + MG || h.t < skipR) continue;
          h.entry = entry; h.edge = edges[i];
          found.push(h);
          if (h.t < best) best = h.t;
        }
      }
    }
  }
  if (!found.length || best === tmax) return null;
  // 接触とみなす距離(STL の接触の許容差 MG)は、STL の部品が関わる組だけに使う。回転体どうしは厳密(MERGE)にまとめる
  const first = found.reduce((a, h) => (h.t < a.t ? h : a));
  const meshFirst = first.entry.kind === 'mesh';
  const hits = found.filter((h) => h.t <= best + (meshFirst || h.entry.kind === 'mesh' ? MG : MERGE));
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

function mediumAt(scene, x, y, z) {
  const r = Math.hypot(x, y);
  for (const e of scene.list) {
    if (e.kind === 'mesh') { if (meshContains(e.acc, [x, y, z])) return e; continue; }
    if (containsPoint(e.all, r, z)) return e;
  }
  if (scene.cavity?.entry) { const c = scene.cavity.entryAt(x, y, z); if (c) return c; }
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
  // 相手がいなければ空気、ただし閉じた空洞の中なら空洞の媒質
  const inside = h.entry, outside = other ? other.entry : cavityEntryAt(scene.cavity, hit.point, Ng);
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
