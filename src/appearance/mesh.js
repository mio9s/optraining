// 三角形メッシュ(STL)の読み込みと光線交差。外観モードで図面の立体をそのまま扱う。
// 座標は mm、Z = 光軸(取り込み時に軸の対応を指定)。

// ---------- STL の読み込み ----------
/** ArrayBuffer → {solids: [{name, tris: Float32Array(9n)}]}。バイナリ/ASCII を自動判定 */
export function parseSTL(buf) {
  const u8 = new Uint8Array(buf);
  const head = new TextDecoder('ascii').decode(u8.subarray(0, Math.min(512, u8.length))).trimStart().toLowerCase();
  if (u8.length >= 84) {
    const n = new DataView(buf).getUint32(80, true);
    if (84 + n * 50 === u8.length) return parseBinary(buf, n); // サイズが一致すればバイナリ(先頭が "solid" でも)
  }
  if (head.startsWith('solid')) return parseASCII(new TextDecoder('utf-8').decode(u8));
  throw new Error('STL として読めません(バイナリでも ASCII でもありません)');
}
function parseBinary(buf, n) {
  const dv = new DataView(buf), tris = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12; // 法線(12 バイト)は使わず頂点の巻き方向から求める
    for (let k = 0; k < 9; k++) tris[i * 9 + k] = dv.getFloat32(o + k * 4, true);
  }
  return { solids: [{ name: 'STL', tris }] };
}
function parseASCII(text) {
  const solids = [];
  const re = /solid\s*([^\n\r]*)([\s\S]*?)endsolid/gi;
  let m;
  while ((m = re.exec(text))) {
    const nums = [];
    const vre = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    let v;
    while ((v = vre.exec(m[2]))) nums.push(+v[1], +v[2], +v[3]);
    if (nums.length >= 9) solids.push({ name: m[1].trim() || `solid ${solids.length + 1}`, tris: Float32Array.from(nums.slice(0, nums.length - (nums.length % 9))) });
  }
  if (!solids.length) throw new Error('ASCII STL に三角形が見つかりません');
  return { solids };
}

// ---------- 整形: 頂点の統合・分割・向き ----------
/** 同じ位置の頂点を統合(格子ハッシュ、許容差 tol mm) → {V: Float64Array, F: Uint32Array} */
export function weld(tris, tol = 1e-5) {
  const map = new Map(), V = [], F = new Uint32Array(tris.length / 3);
  const q = (x) => Math.round(x / tol);
  for (let i = 0; i < tris.length; i += 3) {
    const key = `${q(tris[i])},${q(tris[i + 1])},${q(tris[i + 2])}`;
    let id = map.get(key);
    if (id === undefined) { id = V.length / 3; map.set(key, id); V.push(tris[i], tris[i + 1], tris[i + 2]); }
    F[i / 3] = id;
  }
  // 縮退三角形(同じ頂点を含む)を除く
  const keep = [];
  for (let t = 0; t < F.length; t += 3) if (F[t] !== F[t + 1] && F[t + 1] !== F[t + 2] && F[t] !== F[t + 2]) keep.push(F[t], F[t + 1], F[t + 2]);
  return { V: Float64Array.from(V), F: Uint32Array.from(keep) };
}

const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);

// 辺のまわりの角度差がこれ未満の三角形は、接合された相手の部品の同じ面(三角形の分け方が違っても)とみなす [rad]
const SAME_FACE = 0.01;
/** 辺でつながった三角形の塊ごとに分ける → [{V, F}] */
export function splitComponents({ V, F }) {
  const nT = F.length / 3, parent = Int32Array.from({ length: nT }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent[a] = b; };
  const byEdge = new Map();
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
    const e = edgeKey(F[t * 3 + k], F[t * 3 + ((k + 1) % 3)]);
    const l = byEdge.get(e);
    if (l) l.push(t); else byEdge.set(e, [t]);
  }
  // 巻き方向の慣習(STL は外向きが標準。全体の体積が負なら内向きで書かれている)
  const sgn = signedVolume({ V, F }) < 0 ? -1 : 1;
  for (const [e, ts] of byEdge) {
    if (ts.length <= 2) { if (ts.length === 2) union(ts[0], ts[1]); continue; }
    // 3 枚以上が共有する辺(接合された 2 部品の境目など): 各三角形から、その内側(法線の反対側)へ
    // 辺のまわりに回して最初に出会う三角形と組にする。同じ位置の面(角度差 0)は相手の部品なので組にしない
    const [ia, ib] = e.split(',').map(Number);
    const A = [V[ia * 3], V[ia * 3 + 1], V[ia * 3 + 2]];
    const ax = [V[ib * 3] - A[0], V[ib * 3 + 1] - A[1], V[ib * 3 + 2] - A[2]];
    const L = Math.hypot(...ax); ax[0] /= L; ax[1] /= L; ax[2] /= L;
    const cr = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const ref = Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = cr(ax, ref), Lu = Math.hypot(...u); u[0] /= Lu; u[1] /= Lu; u[2] /= Lu;
    const v = cr(ax, u);
    const info = ts.map((t) => {
      const ids = [F[t * 3], F[t * 3 + 1], F[t * 3 + 2]], c = ids.find((x) => x !== ia && x !== ib);
      const P = (i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
      const p0 = P(ids[0]), p1 = P(ids[1]), p2 = P(ids[2]);
      const n = cr([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]);
      const w0 = [V[c * 3] - A[0], V[c * 3 + 1] - A[1], V[c * 3 + 2] - A[2]], k = dot(w0, ax);
      const w = [w0[0] - k * ax[0], w0[1] - k * ax[1], w0[2] - k * ax[2]];
      const th = Math.atan2(dot(w, v), dot(w, u));
      const s = (dot(cr(ax, w), n) > 0 ? -1 : 1) * sgn; // 法線の反対側(部品の内側)へ回る向き
      const fwd = ids.findIndex((x, j) => x === ia && ids[(j + 1) % 3] === ib) >= 0; // 辺を ia→ib の向きにたどるか
      return { t, th, s, fwd };
    });
    for (const a of info) {
      let best = null, bd = Infinity;
      for (const b of info) {
        if (b === a || b.fwd === a.fwd) continue; // 同じ立体の隣どうしは辺を逆向きにたどる
        let d = (a.s * (b.th - a.th)) % (2 * Math.PI);
        if (d < 0) d += 2 * Math.PI;
        if (d > SAME_FACE && d < 2 * Math.PI - SAME_FACE && d < bd) { bd = d; best = b; }
      }
      if (best) union(a.t, best.t);
    }
  }
  const groups = new Map();
  for (let t = 0; t < nT; t++) { const r = find(t); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }
  return [...groups.values()].map((ts) => {
    const remap = new Map(), Vn = [], Fn = [];
    for (const t of ts) for (let k = 0; k < 3; k++) {
      const v = F[t * 3 + k];
      let id = remap.get(v);
      if (id === undefined) { id = Vn.length / 3; remap.set(v, id); Vn.push(V[v * 3], V[v * 3 + 1], V[v * 3 + 2]); }
      Fn.push(id);
    }
    return { V: Float64Array.from(Vn), F: Uint32Array.from(Fn) };
  });
}

/** 閉じているか(各辺がちょうど 2 枚の三角形に共有される)。返り値: 開いた辺の数 */
export function openEdges({ F }) {
  const cnt = new Map();
  for (let t = 0; t < F.length; t += 3) for (let k = 0; k < 3; k++) { const e = edgeKey(F[t + k], F[t + ((k + 1) % 3)]); cnt.set(e, (cnt.get(e) ?? 0) + 1); }
  let open = 0;
  for (const c of cnt.values()) if (c !== 2) open++;
  return open;
}

/** 符号付き体積(外向きの巻き方向で正) */
export function signedVolume({ V, F }) {
  let s = 0;
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t] * 3, b = F[t + 1] * 3, c = F[t + 2] * 3;
    s += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
  }
  return s / 6;
}
/** 体積が負なら全三角形の巻き方向を反転(法線を外向きに) */
export function orientOutward(mesh) {
  if (signedVolume(mesh) >= 0) return mesh;
  const F = mesh.F.slice();
  for (let t = 0; t < F.length; t += 3) { const x = F[t + 1]; F[t + 1] = F[t + 2]; F[t + 2] = x; }
  return { ...mesh, F };
}

/**
 * 図面座標 → シーン座標。axis: 光軸(シーンの Z)にする図面の軸 'x'|'y'|'z'、flip: 光軸の向きを反転、
 * scale: 1 単位の mm、offset: [dx, dy, dz](変換後に足す)
 */
export function transformVertices(V, { axis = 'z', flip = false, scale = 1, offset = [0, 0, 0] } = {}) {
  const out = new Float64Array(V.length);
  for (let i = 0; i < V.length; i += 3) {
    let x = V[i], y = V[i + 1], z = V[i + 2];
    // 右手系を保つ巡回置換
    if (axis === 'x') [x, y, z] = [y, z, x];
    else if (axis === 'y') [x, y, z] = [z, x, y];
    if (flip) { x = -x; z = -z; } // Y 軸まわりの 180° 回転(右手系のまま)
    out[i] = x * scale + offset[0]; out[i + 1] = y * scale + offset[1]; out[i + 2] = z * scale + offset[2];
  }
  return out;
}

export function meshBounds(V) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], V[i + k]); hi[k] = Math.max(hi[k], V[i + k]); }
  return { lo, hi };
}

// ---------- 保存用の符号化 ----------
const b64e = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64d = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
export const encodeMesh = ({ V, F }) => ({ v: b64e(new Uint8Array(Float32Array.from(V).buffer)), f: b64e(new Uint8Array(Uint32Array.from(F).buffer)) });
export function decodeMesh(m) {
  const vb = b64d(m.v), fb = b64d(m.f);
  return { V: Float64Array.from(new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4)), F: new Uint32Array(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength)) };
}

// ---------- 交差用の構造 ----------
/**
 * {V, F} と平行移動 offset から、法線(面法線と、折れ角 creaseDeg 未満で平均した頂点ごとの滑らかな法線)と BVH を作る
 */
export function buildMeshAccel({ V, F }, { offset = [0, 0, 0], creaseDeg = 30 } = {}) {
  const nT = F.length / 3;
  const P = new Float64Array(V.length);
  for (let i = 0; i < V.length; i += 3) { P[i] = V[i] + offset[0]; P[i + 1] = V[i + 1] + offset[1]; P[i + 2] = V[i + 2] + offset[2]; }
  const FN = new Float64Array(nT * 3); // 面法線(単位、外向き = 巻き方向)
  for (let t = 0; t < nT; t++) {
    const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    FN[t * 3] = nx / L; FN[t * 3 + 1] = ny / L; FN[t * 3 + 2] = nz / L;
  }
  // 頂点ごとに接する面の一覧 → 角ごとの滑らかな法線
  const vf = Array.from({ length: V.length / 3 }, () => []);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) vf[F[t * 3 + k]].push(t);
  const cosC = Math.cos((creaseDeg * Math.PI) / 180);
  const CN = new Float64Array(nT * 9);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
    let sx = 0, sy = 0, sz = 0;
    for (const u of vf[F[t * 3 + k]]) {
      const d = FN[t * 3] * FN[u * 3] + FN[t * 3 + 1] * FN[u * 3 + 1] + FN[t * 3 + 2] * FN[u * 3 + 2];
      if (d >= cosC) { sx += FN[u * 3]; sy += FN[u * 3 + 1]; sz += FN[u * 3 + 2]; }
    }
    const L = Math.hypot(sx, sy, sz) || 1;
    CN[t * 9 + k * 3] = sx / L; CN[t * 9 + k * 3 + 1] = sy / L; CN[t * 9 + k * 3 + 2] = sz / L;
  }
  // BVH(SAH: 12 区間の表面積ヒューリスティックで分割、葉 ≤ 4 三角形)
  const order = Uint32Array.from({ length: nT }, (_, i) => i);
  const cen = new Float64Array(nT * 3), TB = new Float64Array(nT * 6);
  for (let t = 0; t < nT; t++) for (let c = 0; c < 3; c++) {
    const x = P[F[t * 3] * 3 + c], y = P[F[t * 3 + 1] * 3 + c], z = P[F[t * 3 + 2] * 3 + c];
    TB[t * 6 + c] = Math.min(x, y, z); TB[t * 6 + 3 + c] = Math.max(x, y, z); cen[t * 3 + c] = (x + y + z) / 3;
  }
  const NBIN = 12, binB = new Float64Array(NBIN * 6), binN = new Int32Array(NBIN), accL = new Float64Array(NBIN), accR = new Float64Array(NBIN);
  const area = (bb, o) => { const x = bb[o + 3] - bb[o], y = bb[o + 4] - bb[o + 1], z = bb[o + 5] - bb[o + 2]; return x * y + y * z + z * x; };
  const nodes = [];
  const build = (lo, hi) => {
    const id = nodes.length;
    const node = { lo, hi, b: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], l: -1, r: -1 };
    nodes.push(node);
    const cb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const t = order[i];
      for (let c = 0; c < 3; c++) {
        if (TB[t * 6 + c] < node.b[c]) node.b[c] = TB[t * 6 + c];
        if (TB[t * 6 + 3 + c] > node.b[c + 3]) node.b[c + 3] = TB[t * 6 + 3 + c];
        const v = cen[t * 3 + c]; if (v < cb[c]) cb[c] = v; if (v > cb[c + 3]) cb[c + 3] = v;
      }
    }
    const n = hi - lo;
    if (n <= 4) return id;
    let bestCost = Infinity, bestAx = -1, bestBin = -1;
    for (let ax = 0; ax < 3; ax++) {
      const ext = cb[ax + 3] - cb[ax];
      if (!(ext > 1e-12)) continue;
      binN.fill(0);
      for (let k = 0; k < NBIN; k++) { binB[k * 6] = binB[k * 6 + 1] = binB[k * 6 + 2] = Infinity; binB[k * 6 + 3] = binB[k * 6 + 4] = binB[k * 6 + 5] = -Infinity; }
      for (let i = lo; i < hi; i++) {
        const t = order[i], k = Math.min(NBIN - 1, Math.floor(((cen[t * 3 + ax] - cb[ax]) / ext) * NBIN));
        binN[k]++;
        for (let c = 0; c < 3; c++) { if (TB[t * 6 + c] < binB[k * 6 + c]) binB[k * 6 + c] = TB[t * 6 + c]; if (TB[t * 6 + 3 + c] > binB[k * 6 + 3 + c]) binB[k * 6 + 3 + c] = TB[t * 6 + 3 + c]; }
      }
      // 左から・右からの累積(面積 × 個数)
      const run = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      let cnt = 0;
      for (let k = 0; k < NBIN - 1; k++) {
        cnt += binN[k];
        for (let c = 0; c < 3; c++) { run[c] = Math.min(run[c], binB[k * 6 + c]); run[c + 3] = Math.max(run[c + 3], binB[k * 6 + 3 + c]); }
        accL[k] = cnt ? area(run, 0) * cnt : 0;
      }
      run.fill(Infinity, 0, 3); run.fill(-Infinity, 3, 6); cnt = 0;
      for (let k = NBIN - 1; k > 0; k--) {
        cnt += binN[k];
        for (let c = 0; c < 3; c++) { run[c] = Math.min(run[c], binB[k * 6 + c]); run[c + 3] = Math.max(run[c + 3], binB[k * 6 + 3 + c]); }
        accR[k - 1] = cnt ? area(run, 0) * cnt : 0;
      }
      for (let k = 0; k < NBIN - 1; k++) { const cost = accL[k] + accR[k]; if (cost < bestCost) { bestCost = cost; bestAx = ax; bestBin = k; } }
    }
    let mid;
    if (bestAx < 0) mid = (lo + hi) >> 1; // 重心がすべて同じ: 半分に
    else {
      const ext = cb[bestAx + 3] - cb[bestAx];
      let i = lo, j = hi - 1;
      while (i <= j) {
        const k = Math.min(NBIN - 1, Math.floor(((cen[order[i] * 3 + bestAx] - cb[bestAx]) / ext) * NBIN));
        if (k <= bestBin) i++; else { const x = order[i]; order[i] = order[j]; order[j] = x; j--; }
      }
      mid = i;
      if (mid === lo || mid === hi) mid = (lo + hi) >> 1;
    }
    node.l = build(lo, mid); node.r = build(mid, hi);
    return id;
  };
  if (nT) build(0, nT);
  // 走査用に平らな配列へ(箱 6 値、子、三角形の範囲)
  const nN = nodes.length, NB = new Float64Array(nN * 6), NL = new Int32Array(nN), NR = new Int32Array(nN), NLO = new Int32Array(nN), NHI = new Int32Array(nN);
  nodes.forEach((n, i) => { NB.set(n.b, i * 6); NL[i] = n.l; NR[i] = n.r; NLO[i] = n.lo; NHI[i] = n.hi; });
  // 三角形の頂点 0 と 2 辺を木の順に並べて持つ(交差計算でのメモリの飛びを減らす)
  const TRI = new Float64Array(nT * 9);
  for (let i = 0; i < nT; i++) {
    const t = order[i], a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
    TRI.set([P[a], P[a + 1], P[a + 2], P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2], P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]], i * 9);
  }
  return { P, F, FN, CN, order, TRI, nNodes: nN, NB, NL, NR, NLO, NHI, box: nodes[0]?.b ?? [0, 0, 0, 0, 0, 0] };
}

/** 箱に入る t(当たらなければ Infinity) */
function slabT(NB, n, ox, oy, oz, ix, iy, iz, tmin, tmax) {
  const b = n * 6;
  let t0 = (NB[b] - 1e-9 - ox) * ix, t1 = (NB[b + 3] + 1e-9 - ox) * ix;
  if (t0 > t1) { const x = t0; t0 = t1; t1 = x; }
  if (t0 > tmin) tmin = t0; if (t1 < tmax) tmax = t1;
  if (tmin > tmax) return Infinity;
  t0 = (NB[b + 1] - 1e-9 - oy) * iy; t1 = (NB[b + 4] + 1e-9 - oy) * iy;
  if (t0 > t1) { const x = t0; t0 = t1; t1 = x; }
  if (t0 > tmin) tmin = t0; if (t1 < tmax) tmax = t1;
  if (tmin > tmax) return Infinity;
  t0 = (NB[b + 2] - 1e-9 - oz) * iz; t1 = (NB[b + 5] + 1e-9 - oz) * iz;
  if (t0 > t1) { const x = t0; t0 = t1; t1 = x; }
  if (t0 > tmin) tmin = t0; if (t1 < tmax) tmax = t1;
  return tmin > tmax ? Infinity : tmin;
}
const STK = { n: new Int32Array(1024), t: new Float64Array(1024) };
const sp0 = () => STK; // meshHits は自分を呼ばないので 1 つで足りる

/**
 * 光線とメッシュの交点(Möller–Trumbore)。out に {t, normal(滑らか), gnormal(面)} を足す。
 * merge を与えると最も近い交点 + merge までに絞って探す(近い箱から順に調べ、遠い箱は飛ばす)。省略時は tmax までの全交点。
 */
export function meshHits(acc, o, d, tmin, tmax, out, merge = Infinity) {
  if (!acc.nNodes) return;
  const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  const { FN, CN, order, TRI, NB, NL, NR, NLO, NHI } = acc;
  let lim = tmax, sp = 0;
  const t00 = slabT(NB, 0, ox, oy, oz, ix, iy, iz, tmin, lim);
  if (t00 === Infinity) return;
  const stack = sp0(); // 再入(meshContains 中の呼び出しなど)に備えて深さごとの領域を使う
  const SN = stack.n, ST = stack.t;
  SN[sp] = 0; ST[sp++] = t00;
  while (sp) {
    --sp;
    if (ST[sp] > lim) continue; // 箱に入る前に、見つかった交点より遠い
    const n = SN[sp];
    const l = NL[n];
    if (l >= 0) {
      const r = NR[n];
      const tl = slabT(NB, l, ox, oy, oz, ix, iy, iz, tmin, lim), tr = slabT(NB, r, ox, oy, oz, ix, iy, iz, tmin, lim);
      if (sp > SN.length - 3) throw new Error('BVH が深すぎます');
      if (tl <= tr) { if (tr !== Infinity) { SN[sp] = r; ST[sp++] = tr; } if (tl !== Infinity) { SN[sp] = l; ST[sp++] = tl; } }
      else { SN[sp] = l; ST[sp++] = tl; if (tr !== Infinity) { SN[sp] = r; ST[sp++] = tr; } }
      continue;
    }
    for (let i = NLO[n]; i < NHI[n]; i++) {
      const q = i * 9;
      const e1x = TRI[q + 3], e1y = TRI[q + 4], e1z = TRI[q + 5], e2x = TRI[q + 6], e2y = TRI[q + 7], e2z = TRI[q + 8];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-15 && det < 1e-15) continue;
      const id = 1 / det;
      const sx = ox - TRI[q], sy = oy - TRI[q + 1], sz = oz - TRI[q + 2];
      const u = (sx * px + sy * py + sz * pz) * id;
      if (u < -1e-10 || u > 1 + 1e-10) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * id;
      if (v < -1e-10 || u + v > 1 + 1e-10) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * id;
      if (tt < tmin || tt > lim) continue;
      const t = order[i], w = 1 - u - v, k = t * 9;
      const nx = w * CN[k] + u * CN[k + 3] + v * CN[k + 6], ny = w * CN[k + 1] + u * CN[k + 4] + v * CN[k + 7], nz = w * CN[k + 2] + u * CN[k + 5] + v * CN[k + 8];
      const L = Math.hypot(nx, ny, nz) || 1;
      out.push({ t: tt, normal: [nx / L, ny / L, nz / L], gnormal: [FN[t * 3], FN[t * 3 + 1], FN[t * 3 + 2]] });
      if (tt + merge < lim) lim = tt + merge;
    }
  }
}

/** 点がメッシュの内部か(+x 方向の半直線との交差回数の偶奇。斜めの方向も併用して頑健に) */
export function meshContains(acc, p) {
  const dirs = [[1, 0.0003, 0.0007], [0.0005, 1, 0.0002], [0.0003, 0.0002, 1]];
  let votes = 0;
  for (const d0 of dirs) {
    const L = Math.hypot(...d0), d = d0.map((x) => x / L), hits = [];
    meshHits(acc, p, d, 1e-9, Infinity, hits);
    if (hits.length % 2 === 1) votes++;
  }
  return votes >= 2;
}

/**
 * 取り込み: STL の ArrayBuffer → 部品にできるメッシュの配列
 * opts: {scale, axis, flip, offset, split(つながりごとに分ける)}
 * 返り値: {bodies: [{name, V, F, triangles, open(開いた辺の数), flipped, bounds}], warnings}
 */
export function importSTL(buf, opts = {}) {
  const { solids } = parseSTL(buf);
  const bodies = [], warnings = [];
  for (const s of solids) {
    const welded = weld(s.tris, opts.weldTol ?? 1e-5 * Math.max(1, opts.scale ?? 1));
    const parts = opts.split === false ? [welded] : splitComponents(welded);
    parts.forEach((m, i) => {
      const V = transformVertices(m.V, opts);
      const vol = signedVolume({ V, F: m.F });
      const o = orientOutward({ V, F: m.F });
      const open = openEdges(o);
      if (open) warnings.push(`${s.name}${parts.length > 1 ? ` (${i + 1})` : ''}: 閉じていない辺が ${open} 本あります。内側と外側が正しく決まらないことがあります`);
      bodies.push({ name: parts.length > 1 ? `${s.name} (${i + 1})` : s.name, V: o.V, F: o.F, triangles: o.F.length / 3, open, flipped: vol < 0, bounds: meshBounds(o.V), volume: Math.abs(vol) });
    });
  }
  return { bodies, warnings };
}
