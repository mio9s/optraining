// 部品の断面(プロファイル): (r, z) 平面上の閉じた輪郭。点は [r, z](r: 光軸からの高さ ≥ 0、z: 光軸方向)。
// Profile = { start: [r, z], segments: Segment[] }(最後のセグメントの終点 = start で閉じる)
// Segment:
//   {type:'line', to}
//   {type:'arc', to, center, ccw}            円弧(中心 center、(r,z) 平面で ccw = 反時計回り。r 軸を縦、z 軸を横にとった図で見た向き)
//   {type:'bezier', c1, c2, to}              3 次ベジェ
//   {type:'spline', through: [[r,z]...], to} 通過点を通る自然 3 次スプライン(弦長パラメータ)
//   {type:'asphere', z0, c, k, A: [A4, A6, ...], to}  z = z0 + c r²/(1+√(1−(1+k)c²r²)) + A4 r⁴ + A6 r⁶ …(r で始点→終点)

export const TOL = 1e-4; // 分割の弦誤差 [mm] = 0.1 µm
const EPS = 1e-9;

const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len2 = (a) => Math.hypot(a[0], a[1]);

export function asphereSag(seg, r) {
  const { c = 0, k = 0, A = [] } = seg;
  const q = 1 - (1 + k) * c * c * r * r;
  if (q < 0) return NaN;
  let z = (c * r * r) / (1 + Math.sqrt(q));
  A.forEach((a, i) => { z += a * r ** (4 + 2 * i); });
  return seg.z0 + z;
}

function splineCoeffs(pts) {
  // 弦長パラメータの自然 3 次スプライン(各座標独立)
  const n = pts.length;
  const t = [0];
  for (let i = 1; i < n; i++) t.push(t[i - 1] + Math.max(len2(sub2(pts[i], pts[i - 1])), 1e-12));
  const coef = [0, 1].map((d) => {
    const y = pts.map((p) => p[d]);
    const h = t.slice(1).map((v, i) => v - t[i]);
    const m = new Array(n).fill(0);
    if (n > 2) {
      // 三重対角(自然境界 m0 = mn = 0)
      const a = [], b = [], c = [], r = [];
      for (let i = 1; i < n - 1; i++) {
        a.push(h[i - 1]); b.push(2 * (h[i - 1] + h[i])); c.push(h[i]);
        r.push(6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]));
      }
      for (let i = 1; i < b.length; i++) { const w = a[i] / b[i - 1]; b[i] -= w * c[i - 1]; r[i] -= w * r[i - 1]; }
      const x = new Array(b.length);
      for (let i = b.length - 1; i >= 0; i--) x[i] = (r[i] - (i + 1 < b.length ? c[i] * x[i + 1] : 0)) / b[i];
      for (let i = 1; i < n - 1; i++) m[i] = x[i - 1];
    }
    return { y, h, m };
  });
  return { t, coef };
}

/** セグメントを t∈[0,1] でパラメータ化した評価関数 {at(t) → [r,z], d(t) → 接線} を返す */
export function segmentEvaluator(start, seg) {
  if (seg.type === 'line') {
    const d = sub2(seg.to, start);
    return { at: (t) => [start[0] + d[0] * t, start[1] + d[1] * t], d: () => d };
  }
  if (seg.type === 'arc') {
    const c = seg.center;
    // 角度は (z, r) を (横, 縦) とみたときの atan2(r, z)
    const ang = (p) => Math.atan2(p[0] - c[0], p[1] - c[1]);
    const R = len2(sub2(start, c));
    const a0 = ang(start); let a1 = ang(seg.to);
    if (seg.ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
    const da = a1 - a0;
    return {
      at: (t) => { const a = a0 + da * t; return [c[0] + R * Math.sin(a), c[1] + R * Math.cos(a)]; },
      d: (t) => { const a = a0 + da * t; return [R * Math.cos(a) * da, -R * Math.sin(a) * da]; },
      radius: R, sweep: da,
    };
  }
  if (seg.type === 'bezier') {
    const P = [start, seg.c1, seg.c2, seg.to];
    return {
      at: (t) => { const u = 1 - t; return [0, 1].map((k) => u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]); },
      d: (t) => { const u = 1 - t; return [0, 1].map((k) => 3 * u * u * (P[1][k] - P[0][k]) + 6 * u * t * (P[2][k] - P[1][k]) + 3 * t * t * (P[3][k] - P[2][k])); },
    };
  }
  if (seg.type === 'spline') {
    const pts = [start, ...(seg.through ?? []), seg.to];
    const { t: T, coef } = splineCoeffs(pts);
    const total = T[T.length - 1];
    const locate = (s) => { let i = 0; while (i < T.length - 2 && s > T[i + 1]) i++; return i; };
    const ev = (s, deriv) => coef.map(({ y, h, m }) => {
      const i = locate(s), hi = h[i], A = (T[i + 1] - s) / hi, B = (s - T[i]) / hi;
      if (!deriv) return A * y[i] + B * y[i + 1] + ((A ** 3 - A) * m[i] + (B ** 3 - B) * m[i + 1]) * (hi * hi) / 6;
      return (y[i + 1] - y[i]) / hi + ((1 - 3 * A * A) * m[i] + (3 * B * B - 1) * m[i + 1]) * hi / 6;
    });
    return { at: (t) => ev(t * total, false), d: (t) => ev(t * total, true).map((v) => v * total) };
  }
  if (seg.type === 'asphere') {
    const r0 = start[0], r1 = seg.to[0];
    const h = 1e-6;
    return {
      at: (t) => { const r = r0 + (r1 - r0) * t; return [r, asphereSag(seg, r)]; },
      d: (t) => {
        const r = r0 + (r1 - r0) * t;
        const dz = (asphereSag(seg, r + h) - asphereSag(seg, r - h)) / (2 * h);
        return [(r1 - r0), dz * (r1 - r0)];
      },
    };
  }
  throw new Error(`未知のセグメント種類: ${seg.type}`);
}

/** 区間 [t0,t1] を弦誤差 tol 以下になるまで再帰分割して点列を返す(t1 の点を含まない) */
function subdivide(ev, t0, t1, tol, out, depth = 0) {
  const p0 = ev.at(t0), p1 = ev.at(t1), tm = (t0 + t1) / 2, pm = ev.at(tm);
  // 中点と 1/4・3/4 点の弦からの距離
  const chordErr = (p) => {
    const d = sub2(p1, p0), L = len2(d);
    if (L < 1e-15) return len2(sub2(p, p0));
    return Math.abs(d[0] * (p[1] - p0[1]) - d[1] * (p[0] - p0[0])) / L;
  };
  const e = Math.max(chordErr(pm), chordErr(ev.at(t0 + (t1 - t0) / 4)), chordErr(ev.at(t0 + (3 * (t1 - t0)) / 4)));
  if ((e <= tol && depth >= 2) || depth > 18) { out.push(t0); return; }
  subdivide(ev, t0, tm, tol, out, depth + 1);
  subdivide(ev, tm, t1, tol, out, depth + 1);
}

/** 符号付き面積((z, r) を (x, y) とみなす)。正なら反時計回り */
export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[1] * b[0] - b[1] * a[0];
  }
  return s / 2;
}

/**
 * 分割: 辺の配列 {a, b, na, nb, seg, onAxis} を返す。法線は外向き単位ベクトル [nr, nz](元の曲線の厳密な法線)。
 */
export function tessellate(profile, tol = TOL) {
  const raw = [];
  let cur = profile.start;
  profile.segments.forEach((seg, si) => {
    const ev = segmentEvaluator(cur, seg);
    const ts = [];
    if (seg.type === 'line') ts.push(0); // 直線は分割不要
    else subdivide(ev, 0, 1, tol, ts);
    ts.push(1);
    for (let i = 0; i + 1 < ts.length; i++) {
      raw.push({ a: ev.at(ts[i]), b: ev.at(ts[i + 1]), da: ev.d(ts[i]), db: ev.d(ts[i + 1]), seg: si });
    }
    cur = seg.to;
  });
  const poly = raw.map((e) => e.a);
  const orient = signedArea(poly) >= 0 ? 1 : -1;
  // (z, r) 平面で反時計回りなら外向き法線は接線を時計回りに 90° 回したもの
  const normal = (d) => {
    const L = len2(d) || 1;
    // 接線 (dr, dz) を (x=z, y=r) で (dz, dr) とみて、時計回り 90°: (dr, -dz) → (x, y) = (dr, -dz) → [r, z] = [-dz, dr]
    return orient > 0 ? [-d[1] / L, d[0] / L] : [d[1] / L, -d[0] / L];
  };
  return raw.map((e) => ({
    a: e.a, b: e.b, na: normal(e.da), nb: normal(e.db), seg: e.seg,
    onAxis: Math.abs(e.a[0]) < 1e-9 && Math.abs(e.b[0]) < 1e-9,
  }));
}

function segIntersect(p, q, r, s) {
  // 線分 pq と rs が交わる・接するか(隣り合わない辺どうしに使うので接触も交差とみなす)
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const on = (a, b, c) => Math.min(a[0], b[0]) - EPS <= c[0] && c[0] <= Math.max(a[0], b[0]) + EPS && Math.min(a[1], b[1]) - EPS <= c[1] && c[1] <= Math.max(a[1], b[1]) + EPS;
  const d1 = d(r, s, p), d2 = d(r, s, q), d3 = d(p, q, r), d4 = d(p, q, s);
  const sg = (v) => (v > EPS ? 1 : v < -EPS ? -1 : 0);
  if (sg(d1) * sg(d2) < 0 && sg(d3) * sg(d4) < 0) return true;
  return (sg(d1) === 0 && on(r, s, p)) || (sg(d2) === 0 && on(r, s, q)) || (sg(d3) === 0 && on(p, q, r)) || (sg(d4) === 0 && on(p, q, s));
}

/** 検証: {ok, errors: [message]} */
export function validateProfile(profile) {
  const errors = [];
  if (!profile?.segments?.length) return { ok: false, errors: ['輪郭がありません'] };
  const last = profile.segments[profile.segments.length - 1].to;
  if (len2(sub2(last, profile.start)) > 1e-6) errors.push('輪郭が閉じていません(最後の点を始点に一致させてください)');
  let cur = profile.start;
  profile.segments.forEach((seg, i) => {
    if (seg.type === 'arc') {
      const r0 = len2(sub2(cur, seg.center)), r1 = len2(sub2(seg.to, seg.center));
      if (Math.abs(r0 - r1) > 1e-6 * Math.max(1, r0)) errors.push(`セグメント ${i + 1}(円弧): 始点と終点が中心から等距離ではありません`);
    }
    if (seg.type === 'asphere') {
      if (Math.abs(asphereSag(seg, cur[0]) - cur[1]) > 1e-6 || Math.abs(asphereSag(seg, seg.to[0]) - seg.to[1]) > 1e-6)
        errors.push(`セグメント ${i + 1}(非球面): 始点・終点が非球面式の上にありません`);
      if (Math.abs(seg.to[0] - cur[0]) < 1e-12) errors.push(`セグメント ${i + 1}(非球面): r が変化しません`);
    }
    cur = seg.to;
  });
  if (errors.length) return { ok: false, errors };
  let edges;
  try { edges = tessellate(profile); } catch (e) { return { ok: false, errors: [e.message] }; }
  if (edges.some((e) => !e.a.every(Number.isFinite) || !e.b.every(Number.isFinite))) return { ok: false, errors: ['計算できない点があります(非球面の範囲外など)'] };
  if (edges.some((e) => e.a[0] < -1e-9)) errors.push('r < 0(光軸の反対側)の点があります');
  if (Math.abs(signedArea(edges.map((e) => e.a))) < 1e-12) errors.push('面積が 0 です');
  // 自己交差(粗いグリッドで候補を絞る)
  const n = edges.length;
  const cell = new Map();
  let minR = Infinity, minZ = Infinity, maxR = -Infinity, maxZ = -Infinity;
  for (const e of edges) for (const p of [e.a, e.b]) { minR = Math.min(minR, p[0]); maxR = Math.max(maxR, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
  const G = Math.max(1, Math.ceil(Math.sqrt(n))), sr = (maxR - minR) / G || 1, sz = (maxZ - minZ) / G || 1;
  edges.forEach((e, i) => {
    const r0 = Math.floor((Math.min(e.a[0], e.b[0]) - minR) / sr), r1 = Math.floor((Math.max(e.a[0], e.b[0]) - minR) / sr);
    const z0 = Math.floor((Math.min(e.a[1], e.b[1]) - minZ) / sz), z1 = Math.floor((Math.max(e.a[1], e.b[1]) - minZ) / sz);
    for (let a = r0; a <= r1; a++) for (let b = z0; b <= z1; b++) { const k = a * 100003 + b; if (!cell.has(k)) cell.set(k, []); cell.get(k).push(i); }
  });
  let crossing = false;
  for (const list of cell.values()) {
    for (let x = 0; x < list.length && !crossing; x++) for (let y = x + 1; y < list.length; y++) {
      const i = list[x], j = list[y];
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1) || (j === 0 && i === n - 1)) continue;
      if (segIntersect(edges[i].a, edges[i].b, edges[j].a, edges[j].b)) { crossing = true; break; }
    }
    if (crossing) break;
  }
  if (crossing) errors.push('輪郭が自分自身と交差しています');
  return { ok: errors.length === 0, errors, edges };
}

/** 点 (r, z) が輪郭の内部か(偶奇規則)。edges は tessellate の結果 */
export function containsPoint(edges, r, z) {
  let inside = false;
  for (const e of edges) {
    const [r1, z1] = e.a, [r2, z2] = e.b;
    if ((r1 > r) !== (r2 > r)) {
      const zc = z1 + ((r - r1) * (z2 - z1)) / (r2 - r1);
      if (zc > z) inside = !inside;
    }
  }
  return inside;
}

/** 輪郭の (r, z) 範囲 */
export function bounds(edges) {
  let rMax = 0, zMin = Infinity, zMax = -Infinity;
  for (const e of edges) for (const p of [e.a, e.b]) { rMax = Math.max(rMax, p[0]); zMin = Math.min(zMin, p[1]); zMax = Math.max(zMax, p[1]); }
  return { rMax, zMin, zMax };
}

/** 輪郭の z を平行移動 */
export function translateProfile(profile, dz) {
  const m = (p) => [p[0], p[1] + dz];
  return {
    start: m(profile.start),
    segments: profile.segments.map((s) => {
      const o = { ...s, to: m(s.to) };
      if (s.center) o.center = m(s.center);
      if (s.c1) { o.c1 = m(s.c1); o.c2 = m(s.c2); }
      if (s.through) o.through = s.through.map(m);
      if (s.type === 'asphere') o.z0 = s.z0 + dz;
      return o;
    }),
  };
}

/** 球面の円弧セグメント: 頂点 z = zv、曲率半径 R(Infinity は平面)、r = r0 → r1 */
export function sphericalSegment(zv, R, r0, r1) {
  const sag = (r) => (Number.isFinite(R) ? zv + R - Math.sign(R) * Math.sqrt(R * R - r * r) : zv);
  const from = [r0, sag(r0)], to = [r1, sag(r1)];
  if (!Number.isFinite(R)) return { from, seg: { type: 'line', to } };
  const center = [0, zv + R];
  // 向き: 実際の 2 点間の短い弧を選ぶ
  const ang = (p) => Math.atan2(p[0] - center[0], p[1] - center[1]);
  let d = ang(to) - ang(from);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return { from, seg: { type: 'arc', to, center, ccw: d > 0 } };
}
