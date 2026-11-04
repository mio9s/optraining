// 図面座標 (x, y) の閉じた輪郭 → 断面プロファイル [r, z] への変換(取り込みの共通処理)
// Contour = { start: [x, y], segments: [...] } セグメントは profile.js と同じ種類(arc の ccw は (x, y) 平面での向き)
import { segmentEvaluator, validateProfile } from './profile.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// 図面座標 [x, y] の円弧の ccw は通常の (x, y) 平面での向き。profile.js の評価関数は [縦, 横] の並びを
// 前提にしているので、座標を入れ替えて評価する。
const swap = (p) => [p[1], p[0]];
function swapSeg(s) {
  const o = { ...s, to: swap(s.to) };
  if (s.c1) { o.c1 = swap(s.c1); o.c2 = swap(s.c2); }
  if (s.through) o.through = s.through.map(swap);
  if (s.center) o.center = swap(s.center);
  return o;
}
/** 図面座標の輪郭セグメントの評価関数 */
export function contourEvaluator(start, s) {
  const ev = segmentEvaluator(swap(start), swapSeg(s));
  return { at: (t) => swap(ev.at(t)) };
}

/** 輪郭の全点の範囲(制御点は除き、曲線上の点で評価) */
export function contourBounds(contours) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const c of contours) {
    let cur = c.start;
    for (const s of c.segments) {
      const ev = contourEvaluator(cur, s);
      for (let i = 0; i <= 32; i++) { const p = ev.at(i / 32); x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      cur = s.to;
    }
  }
  return { x0, x1, y0, y1 };
}

/** アフィン写像 (x, y) → [r, z] を輪郭に適用。lin = [[a, b], [c, d]] で r = a x + b y + e, z = c x + d y + f */
export function mapContour(c, map) {
  const f = (p) => [map.a * p[0] + map.b * p[1] + map.e, map.c * p[0] + map.d * p[1] + map.f];
  // profile.js の円弧の向きは (z, r) 平面基準。(x, y) → (z, r) の行列式で向きが保たれるか決まる
  const det = map.c * map.b - map.d * map.a; // z = c x + d y, r = a x + b y → [[c, d], [a, b]] の行列式
  const sR = Math.abs(Math.hypot(map.a, map.b) - Math.hypot(map.c, map.d)) < 1e-12 * Math.hypot(map.a, map.b) && Math.abs(map.a * map.c + map.b * map.d) < 1e-12;
  return {
    start: f(c.start),
    segments: c.segments.map((s) => {
      const o = { ...s, to: f(s.to) };
      if (s.c1) { o.c1 = f(s.c1); o.c2 = f(s.c2); }
      if (s.through) o.through = s.through.map(f);
      if (s.type === 'arc') {
        if (!sR) throw new Error('円弧に一様でない拡大縮小がかかっています');
        o.center = f(s.center); o.ccw = det > 0 ? s.ccw : !s.ccw;
      }
      return o;
    }),
  };
}

// ---- セグメントの分割 ----
function splitSegment(start, s, t) {
  const ev = segmentEvaluator(start, s);
  const P = ev.at(t);
  if (s.type === 'line') return [{ type: 'line', to: P }, { type: 'line', to: s.to }];
  if (s.type === 'arc') return [{ type: 'arc', to: P, center: s.center, ccw: s.ccw }, { type: 'arc', to: s.to, center: s.center, ccw: s.ccw }];
  if (s.type === 'bezier') {
    const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const p01 = lerp(start, s.c1), p12 = lerp(s.c1, s.c2), p23 = lerp(s.c2, s.to);
    const a = lerp(p01, p12), b = lerp(p12, p23), m = lerp(a, b);
    return [{ type: 'bezier', c1: p01, c2: a, to: m }, { type: 'bezier', c1: b, c2: p23, to: s.to }];
  }
  // spline などは密な通過点で近似
  const pts = (t0, t1) => Array.from({ length: 31 }, (_, i) => ev.at(t0 + ((t1 - t0) * (i + 1)) / 32));
  return [{ type: 'spline', through: pts(0, t), to: P }, { type: 'spline', through: pts(t, 1), to: s.to }];
}

/** r(t) = 0 となる t ∈ (0, 1) の列(符号が変わる点。サンプルがちょうど 0 の場合も含む) */
function axisRoots(start, s) {
  const ev = segmentEvaluator(start, s);
  const N = 64, roots = [];
  const r = (t) => ev.at(t)[0];
  let tp = 0, rp = r(0);
  for (let i = 1; i <= N; i++) {
    const t = i / N, rv = r(t);
    if (rv === 0 && i < N) {
      // ちょうど 0: 前後で符号が変わるなら根
      const rn = r(Math.min(1, t + 1 / N));
      if (rp * rn < 0) roots.push(t);
      tp = t; rp = rn === 0 ? rp : rp; // 0 の点は前の符号を保持
      continue;
    }
    if (rp * rv < 0 && rp !== 0) {
      let a = tp, b = t, ra = rp;
      for (let k = 0; k < 60; k++) { const m = (a + b) / 2, rm = r(m); if (rm === 0) { a = b = m; break; } if ((rm < 0) === (ra < 0)) { a = m; ra = rm; } else b = m; }
      const tr = (a + b) / 2;
      if (tr > 1e-9 && tr < 1 - 1e-9 && !roots.some((x) => Math.abs(x - tr) < 1e-9)) roots.push(tr);
    }
    if (rv !== 0) { tp = t; rp = rv; }
  }
  return roots.sort((a, b) => a - b);
}

/**
 * [r, z] の閉じた輪郭を r ≥ 0 側に切り取って断面プロファイルの配列にする。
 * 全体が r < 0 なら鏡映して使う。光軸上は直線で閉じる。
 */
export function clipToHalf(c, tol = 1e-9) {
  // 区間に分割
  const pieces = [];
  let cur = c.start;
  for (const s of c.segments) {
    let seg = s, st = cur;
    const roots = axisRoots(cur, s);
    let consumed = 0;
    for (const r of roots) {
      const tl = (r - consumed) / (1 - consumed);
      const [a, b] = splitSegment(st, seg, tl);
      a.to = [0, a.to[1]];
      pieces.push({ from: st, seg: a });
      st = a.to; seg = b; consumed = r;
    }
    pieces.push({ from: st, seg });
    cur = s.to;
  }
  const mid = (p) => segmentEvaluator(p.from, p.seg).at(0.5)[0];
  const allNeg = pieces.every((p) => mid(p) <= tol);
  if (allNeg) {
    const mirror = (q) => [-q[0], q[1]];
    const m = { start: mirror(c.start), segments: c.segments.map((s) => {
      const o = { ...s, to: mirror(s.to) };
      if (s.c1) { o.c1 = mirror(s.c1); o.c2 = mirror(s.c2); }
      if (s.through) o.through = s.through.map(mirror);
      if (s.center) { o.center = mirror(s.center); o.ccw = !s.ccw; }
      return o;
    }) };
    return clipToHalf(m, tol);
  }
  const keep = pieces.map((p) => mid(p) > tol || (Math.abs(p.from[0]) <= tol && Math.abs(p.seg.to[0]) <= tol));
  if (keep.every(Boolean)) return [c];
  // 残す区間をつないで鎖にし、両端(光軸上)を直線で閉じる
  const n = pieces.length;
  let s0 = keep.findIndex((k, i) => k && !keep[(i - 1 + n) % n]);
  const out = [];
  const visited = new Array(n).fill(false);
  while (s0 >= 0) {
    const chain = [];
    let i = s0;
    while (keep[i] && !visited[i]) { visited[i] = true; chain.push(pieces[i]); i = (i + 1) % n; }
    const start = chain[0].from, end = chain[chain.length - 1].seg.to;
    const segs = chain.map((p) => p.seg);
    if (dist(start, end) > tol) segs.push({ type: 'line', to: [0, start[1]] });
    segs[segs.length - 1].to = [...start];
    out.push({ start: [...start], segments: segs });
    s0 = keep.findIndex((k, j) => k && !visited[j] && !keep[(j - 1 + n) % n]);
  }
  return out;
}

/** 開いた区間の列を、端点の一致で閉じた輪郭にまとめる(DXF の LINE/ARC 群など) */
export function chainSegments(items, tol) {
  // items: [{from, seg}]
  const left = items.map((x) => ({ ...x }));
  const contours = [], open = [];
  const reverse = (it) => {
    const s = it.seg, to = it.from;
    if (s.type === 'line') return { from: s.to, seg: { type: 'line', to } };
    if (s.type === 'arc') return { from: s.to, seg: { type: 'arc', to, center: s.center, ccw: !s.ccw } };
    if (s.type === 'bezier') return { from: s.to, seg: { type: 'bezier', c1: s.c2, c2: s.c1, to } };
    return { from: s.to, seg: { ...s, through: [...(s.through ?? [])].reverse(), to } };
  };
  while (left.length) {
    const first = left.shift();
    const chain = [first];
    let end = first.seg.to;
    let progress = true;
    while (progress && dist(end, chain[0].from) > tol) {
      progress = false;
      for (let i = 0; i < left.length; i++) {
        let it = left[i];
        if (dist(it.from, end) <= tol) { /* そのまま */ } else if (dist(it.seg.to, end) <= tol) it = reverse(it); else continue;
        it.from = end; chain.push(it); end = it.seg.to; left.splice(i, 1); progress = true; break;
      }
    }
    if (dist(end, chain[0].from) <= tol) {
      chain[chain.length - 1].seg.to = [...chain[0].from];
      contours.push({ start: chain[0].from, segments: chain.map((c) => c.seg) });
    } else open.push(chain);
  }
  return { contours, open };
}

/**
 * 図面座標の輪郭群 → 断面プロファイル群。
 * opts: {mmPerUnit, axis: 'x' | 'y'(光軸に平行な図面の軸), axisMode: 'center'|'min'|'max'|'value', axisValue, yUp, flipZ}
 */
export function contoursToProfiles(contours, opts = {}) {
  const s = opts.mmPerUnit ?? 1, axis = opts.axis ?? 'x';
  const b = contourBounds(contours);
  const [p0, p1] = axis === 'x' ? [b.y0, b.y1] : [b.x0, b.x1]; // 光軸に垂直な方向の範囲
  const mode = opts.axisMode ?? 'center';
  const a0 = mode === 'value' ? opts.axisValue : mode === 'min' ? p0 : mode === 'max' ? p1 : (p0 + p1) / 2;
  const [q0, q1] = axis === 'x' ? [b.x0, b.x1] : [b.y0, b.y1];
  const zSign = opts.flipZ ? -1 : 1;
  const zOrigin = zSign > 0 ? q0 : q1;
  // r は光軸からの符号付き距離(どちら側でも clipToHalf が処理)、z は光軸方向
  const rs = (opts.yUp ? 1 : -1) * s; // SVG(y 下向き)なら上側を +r に
  const map = axis === 'x'
    ? { a: 0, b: rs, e: -rs * a0, c: zSign * s, d: 0, f: -zSign * s * zOrigin }
    : { a: s, b: 0, e: -s * a0, c: 0, d: (opts.yUp ? 1 : -1) * zSign * s, f: -(opts.yUp ? 1 : -1) * zSign * s * zOrigin };
  const profiles = [], warnings = [];
  for (const c of contours) {
    let mapped;
    try { mapped = mapContour(c, map); } catch (e) { warnings.push(e.message); continue; }
    for (const p of clipToHalf(mapped)) {
      const v = validateProfile(p);
      if (v.ok) profiles.push(p); else warnings.push(`輪郭を使えません: ${v.errors.join('、')}`);
    }
  }
  return { profiles, warnings };
}
