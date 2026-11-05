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

/** 辺でつながった三角形の塊ごとに分ける → [{V, F}] */
export function splitComponents({ V, F }) {
  const nT = F.length / 3, parent = Int32Array.from({ length: nT }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const owner = new Map();
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
    const e = edgeKey(F[t * 3 + k], F[t * 3 + ((k + 1) % 3)]);
    const o = owner.get(e);
    if (o === undefined) owner.set(e, t); else { const a = find(o), b = find(t); if (a !== b) parent[a] = b; }
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
  // BVH(重心の最長軸で中央分割、葉 ≤ 4 三角形)
  const order = Uint32Array.from({ length: nT }, (_, i) => i);
  const cen = new Float64Array(nT * 3);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) cen[t * 3 + k] = (P[F[t * 3] * 3 + k] + P[F[t * 3 + 1] * 3 + k] + P[F[t * 3 + 2] * 3 + k]) / 3;
  const nodes = [];
  const build = (lo, hi) => {
    const id = nodes.length;
    const node = { lo, hi, b: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], l: -1, r: -1 };
    nodes.push(node);
    for (let i = lo; i < hi; i++) { const t = order[i]; for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) { const v = P[F[t * 3 + k] * 3 + c]; if (v < node.b[c]) node.b[c] = v; if (v > node.b[c + 3]) node.b[c + 3] = v; } }
    if (hi - lo > 4) {
      let ax = 0, ext = -1;
      for (let c = 0; c < 3; c++) { const e = node.b[c + 3] - node.b[c]; if (e > ext) { ext = e; ax = c; } }
      const sub = Array.from(order.subarray(lo, hi)).sort((a, b) => cen[a * 3 + ax] - cen[b * 3 + ax]);
      order.set(sub, lo);
      const mid = (lo + hi) >> 1;
      node.l = build(lo, mid); node.r = build(mid, hi);
    }
    return id;
  };
  if (nT) build(0, nT);
  return { P, F, FN, CN, nodes, order, box: nodes[0]?.b ?? [0, 0, 0, 0, 0, 0] };
}

function slab(b, o, inv, tmin, tmax) {
  for (let c = 0; c < 3; c++) {
    let t0 = (b[c] - 1e-9 - o[c]) * inv[c], t1 = (b[c + 3] + 1e-9 - o[c]) * inv[c];
    if (t0 > t1) { const x = t0; t0 = t1; t1 = x; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  return true;
}

/** 光線とメッシュの全交点のうち tmax 以下のもの(Möller–Trumbore)。out に {t, normal(滑らか), gnormal(面)} を足す */
export function meshHits(acc, o, d, tmin, tmax, out) {
  if (!acc.nodes.length) return;
  const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
  const { P, F, FN, CN, nodes, order } = acc;
  const stack = [0];
  while (stack.length) {
    const n = nodes[stack.pop()];
    if (!slab(n.b, o, inv, tmin, tmax)) continue;
    if (n.l >= 0) { stack.push(n.l, n.r); continue; }
    for (let i = n.lo; i < n.hi; i++) {
      const t = order[i], a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-15) continue;
      const id = 1 / det;
      const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
      const u = (sx * px + sy * py + sz * pz) * id;
      if (u < -1e-10 || u > 1 + 1e-10) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * id;
      if (v < -1e-10 || u + v > 1 + 1e-10) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * id;
      if (tt < tmin || tt > tmax) continue;
      const w = 1 - u - v;
      let nx = w * CN[t * 9] + u * CN[t * 9 + 3] + v * CN[t * 9 + 6], ny = w * CN[t * 9 + 1] + u * CN[t * 9 + 4] + v * CN[t * 9 + 7], nz = w * CN[t * 9 + 2] + u * CN[t * 9 + 5] + v * CN[t * 9 + 8];
      const L = Math.hypot(nx, ny, nz) || 1;
      out.push({ t: tt, normal: [nx / L, ny / L, nz / L], gnormal: [FN[t * 3], FN[t * 3 + 1], FN[t * 3 + 2]] });
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
