// SVG・DXF・CSV の取り込み → 図面座標の輪郭 → 断面プロファイル
import { chainSegments, contoursToProfiles } from './contour.js';

// ================= SVG =================
const IDENT = [1, 0, 0, 1, 0, 0]; // [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f
const mulM = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

export function parseTransform(str = '') {
  let m = IDENT;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str))) {
    const v = (t[2].match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    let n = IDENT;
    if (t[1] === 'matrix') n = v.slice(0, 6);
    else if (t[1] === 'translate') n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (t[1] === 'scale') n = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (t[1] === 'rotate') {
      const a = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      n = [c, s, -s, c, 0, 0];
      if (v.length >= 3) n = mulM(mulM([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
    } else if (t[1] === 'skewX') n = [1, 0, Math.tan((v[0] * Math.PI) / 180), 1, 0, 0];
    else if (t[1] === 'skewY') n = [1, Math.tan((v[0] * Math.PI) / 180), 0, 1, 0, 0];
    m = mulM(m, n);
  }
  return m;
}

function attrs(s) {
  const o = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let a;
  while ((a = re.exec(s))) o[a[1]] = a[3] ?? a[4];
  return o;
}

/** SVG 円弧(端点表現)→ 中心表現。F.6.5 */
function arcCenter(p1, p2, rx, ry, phiDeg, fa, fs) {
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (p1[0] - p2[0]) / 2, dy = (p1[1] - p2[1]) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1, den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let k = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) k = -k;
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = cp * cx1 - sp * cy1 + (p1[0] + p2[0]) / 2, cy = sp * cx1 + cp * cy1 + (p1[1] + p2[1]) / 2;
  const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
  const th1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dth = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI; else if (fs && dth < 0) dth += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, th1, dth };
}

/** 楕円弧を小さなベジェ列に(1 区間 ≤ 10°: 誤差 ~1e-9·半径) */
function ellipseToBeziers(a, m) {
  const n = Math.max(1, Math.ceil(Math.abs(a.dth) / ((10 * Math.PI) / 180)));
  const d = a.dth / n, k = (4 / 3) * Math.tan(d / 4);
  const pt = (t) => { const c = Math.cos(t), s = Math.sin(t); return [a.cx + a.rx * c * Math.cos(a.phi) - a.ry * s * Math.sin(a.phi), a.cy + a.rx * c * Math.sin(a.phi) + a.ry * s * Math.cos(a.phi)]; };
  const dpt = (t) => { const c = Math.cos(t), s = Math.sin(t); return [-a.rx * s * Math.cos(a.phi) - a.ry * c * Math.sin(a.phi), -a.rx * s * Math.sin(a.phi) + a.ry * c * Math.cos(a.phi)]; };
  const segs = [];
  for (let i = 0; i < n; i++) {
    const t0 = a.th1 + i * d, t1 = t0 + d, p0 = pt(t0), p1 = pt(t1), d0 = dpt(t0), d1 = dpt(t1);
    segs.push({ type: 'bezier', c1: apply(m, [p0[0] + k * d0[0], p0[1] + k * d0[1]]), c2: apply(m, [p1[0] - k * d1[0], p1[1] - k * d1[1]]), to: apply(m, p1) });
  }
  return segs;
}

function isSimilarity(m) {
  return Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < 1e-9 * Math.hypot(m[0], m[1]) && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 * (m[0] * m[0] + m[1] * m[1]);
}

/** path の d → 輪郭の配列(変換 m を適用済み)。開いた部分パスは open に入れる */
export function parsePathData(d, m = IDENT) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const contours = [], open = [];
  let i = 0, cmd = null, cur = [0, 0], startPt = [0, 0], segs = [], lastC = null, lastQ = null;
  const det = m[0] * m[3] - m[1] * m[2];
  const num = () => Number(tokens[i++]);
  const flag = () => {
    // フラグは "01" のように詰めて書かれることがある
    const t = tokens[i];
    if (t === '0' || t === '1') { i++; return Number(t); }
    const f = Number(t[0]); tokens[i] = t.slice(1); return f;
  };
  const finish = (closed) => {
    if (!segs.length) return;
    const c = { start: apply(m, startPt), segments: segs };
    if (closed) {
      const end = segs[segs.length - 1].to, s = c.start;
      if (Math.hypot(end[0] - s[0], end[1] - s[1]) > 1e-9) segs.push({ type: 'line', to: [...s] }); else segs[segs.length - 1].to = [...s];
      contours.push(c);
    } else open.push(c);
    segs = [];
  };
  const lineTo = (p) => { segs.push({ type: 'line', to: apply(m, p) }); cur = p; };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const o = rel ? cur : [0, 0];
    switch (cmd.toUpperCase()) {
      case 'M': {
        finish(false);
        cur = [o[0] + num(), o[1] + num()]; startPt = cur;
        cmd = rel ? 'l' : 'L'; lastC = lastQ = null; break;
      }
      case 'L': lineTo([o[0] + num(), o[1] + num()]); lastC = lastQ = null; break;
      case 'H': lineTo([(rel ? cur[0] : 0) + num(), cur[1]]); lastC = lastQ = null; break;
      case 'V': lineTo([cur[0], (rel ? cur[1] : 0) + num()]); lastC = lastQ = null; break;
      case 'C': case 'S': {
        let c1;
        if (cmd.toUpperCase() === 'C') c1 = [o[0] + num(), o[1] + num()];
        else c1 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur;
        const c2 = [o[0] + num(), o[1] + num()], p = [o[0] + num(), o[1] + num()];
        segs.push({ type: 'bezier', c1: apply(m, c1), c2: apply(m, c2), to: apply(m, p) });
        lastC = c2; lastQ = null; cur = p; break;
      }
      case 'Q': case 'T': {
        let q;
        if (cmd.toUpperCase() === 'Q') q = [o[0] + num(), o[1] + num()];
        else q = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p = [o[0] + num(), o[1] + num()];
        const c1 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], c2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])];
        segs.push({ type: 'bezier', c1: apply(m, c1), c2: apply(m, c2), to: apply(m, p) });
        lastQ = q; lastC = null; cur = p; break;
      }
      case 'A': {
        const rx = num(), ry = num(), phi = num(), fa = flag(), fs = flag();
        const p = [o[0] + num(), o[1] + num()];
        if (rx === 0 || ry === 0) { lineTo(p); break; }
        const a = arcCenter(cur, p, rx, ry, phi, fa, fs);
        if (Math.abs(a.rx - a.ry) < 1e-9 * a.rx && isSimilarity(m)) {
          // 円弧: (x, y) 平面での向き。SVG の dth > 0 は y 下向き座標で時計回り → 数学座標の ccw と同じ符号(変換前)
          segs.push({ type: 'arc', to: apply(m, p), center: apply(m, [a.cx, a.cy]), ccw: (a.dth > 0) === (det > 0) });
        } else segs.push(...ellipseToBeziers(a, m));
        cur = p; lastC = lastQ = null; break;
      }
      case 'Z': finish(true); cur = startPt; lastC = lastQ = null; break;
      default: i++;
    }
  }
  finish(false);
  return { contours, open };
}

function circleContour(cx, cy, r, m) {
  // 2 つの半円弧(楕円 rx≠ry は path に変換して処理)
  return parsePathData(`M ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`, m).contours;
}

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

/** SVG 文字列 → {contours, open, mmPerUnit(推定)} */
export function parseSVG(text) {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const re = /<\s*(\/)?\s*([a-zA-Z][\w:.-]*)([^>]*?)(\/)?\s*>/g;
  const stack = [IDENT];
  const contours = [], open = [];
  let mmPerUnit = null, t;
  while ((t = re.exec(clean))) {
    const [, closing, name, rest, selfClose] = t;
    const tag = name.toLowerCase().replace(/^svg:/, '');
    if (closing) { if (['g', 'svg', 'a', 'symbol'].includes(tag) && stack.length > 1) stack.pop(); continue; }
    const at = attrs(rest);
    const m = mulM(stack[stack.length - 1], parseTransform(at.transform));
    if (tag === 'svg' && mmPerUnit === null) {
      const w = /^([\d.]+)\s*([a-z]*)$/i.exec(at.width ?? '');
      const vb = (at.viewBox ?? at.viewbox ?? '').split(/[\s,]+/).map(Number);
      if (w && vb.length === 4 && vb[2] > 0) mmPerUnit = (Number(w[1]) * (UNIT_MM[w[2].toLowerCase()] ?? UNIT_MM.px)) / vb[2];
      else if (w) mmPerUnit = UNIT_MM[w[2].toLowerCase()] ?? UNIT_MM.px;
    }
    if (['g', 'svg', 'a', 'symbol'].includes(tag)) { if (!selfClose) stack.push(m); continue; }
    if (['defs', 'clippath', 'mask', 'pattern', 'marker'].includes(tag)) continue;
    const n = (k, def = 0) => (at[k] === undefined ? def : parseFloat(at[k]));
    let res = null;
    if (tag === 'path' && at.d) res = parsePathData(at.d, m);
    else if (tag === 'polygon' || tag === 'polyline') {
      const v = (at.points ?? '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
      if (v.length >= 4) res = parsePathData(`M ${v.slice(0, 2).join(' ')} L ${v.slice(2).join(' ')} ${tag === 'polygon' ? 'Z' : ''}`, m);
    } else if (tag === 'rect') {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      if (w > 0 && h > 0) res = parsePathData(`M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`, m);
    } else if (tag === 'circle') res = { contours: circleContour(n('cx'), n('cy'), n('r'), m), open: [] };
    else if (tag === 'ellipse') {
      const cx = n('cx'), cy = n('cy'), rx = n('rx'), ry = n('ry');
      res = parsePathData(`M ${cx + rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy} Z`, m);
    } else if (tag === 'line') res = { contours: [], open: [{ start: apply(m, [n('x1'), n('y1')]), segments: [{ type: 'line', to: apply(m, [n('x2'), n('y2')]) }] }] };
    if (res) { contours.push(...res.contours); open.push(...res.open); }
  }
  // 開いたパス・線分は端点でつないでみる
  if (open.length) {
    const items = [];
    for (const c of open) { let cur = c.start; for (const s of c.segments) { items.push({ from: cur, seg: s }); cur = s.to; } }
    const r = chainSegments(items, 1e-6);
    contours.push(...r.contours);
    return { contours, openCount: r.open.length, mmPerUnit: mmPerUnit ?? 1 };
  }
  return { contours, openCount: 0, mmPerUnit: mmPerUnit ?? 1 };
}

// ================= DXF =================
const INSUNITS_MM = { 0: null, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 25.4e-6, 9: 25.4e-3, 10: 914.4, 13: 1e-3, 14: 1e-4 };

function deBoor(k, knots, ctrl, t) {
  let s = k;
  while (s < knots.length - k - 2 && t >= knots[s + 1]) s++;
  const d = [];
  for (let j = 0; j <= k; j++) d.push([...ctrl[j + s - k]]);
  for (let r = 1; r <= k; r++) for (let j = k; j >= r; j--) {
    const i = j + s - k, den = knots[i + k + 1 - r] - knots[i];
    const a = den === 0 ? 0 : (t - knots[i]) / den;
    d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
  }
  return d[k];
}

/** bulge 付き頂点 a → b の円弧(bulge = tan(θ/4)、正で反時計回り) */
function bulgeArc(a, b, bulge) {
  const th = 4 * Math.atan(bulge), c = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
  const R = c / Math.sin(Math.abs(th) / 2);
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const h = Math.sqrt(Math.max(0, R * R - c * c)) * Math.sign(bulge) * (Math.abs(th) > Math.PI ? -1 : 1);
  const ux = -(b[1] - a[1]) / (2 * c), uy = (b[0] - a[0]) / (2 * c);
  return { type: 'arc', to: b, center: [mx + ux * h, my + uy * h], ccw: bulge > 0 };
}

/** DXF 文字列 → {contours, openCount, mmPerUnit} */
export function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let mmPerUnit = null;
  for (let i = 0; i < pairs.length; i++) if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') mmPerUnit = INSUNITS_MM[parseInt(pairs[i + 1][1], 10)] ?? null;
  // ENTITIES セクションだけを見る
  let a = pairs.findIndex((p, i) => p[0] === 2 && p[1] === 'ENTITIES' && pairs[i - 1]?.[1] === 'SECTION');
  if (a < 0) a = 0;
  const ents = [];
  let cur = null;
  for (let i = a + 1; i < pairs.length; i++) {
    const [code, val] = pairs[i];
    if (code === 0) { if (val === 'ENDSEC') break; cur = { type: val, g: [] }; ents.push(cur); continue; }
    cur?.g.push([code, val]);
  }
  const items = [], contours = [];
  const get = (e, c) => { const p = e.g.find((x) => x[0] === c); return p ? Number(p[1]) : undefined; };
  for (let k = 0; k < ents.length; k++) {
    const e = ents[k];
    if (e.type === 'LINE') items.push({ from: [get(e, 10), get(e, 20)], seg: { type: 'line', to: [get(e, 11), get(e, 21)] } });
    else if (e.type === 'ARC') {
      const c = [get(e, 10), get(e, 20)], R = get(e, 40), a0 = (get(e, 50) * Math.PI) / 180, a1 = (get(e, 51) * Math.PI) / 180;
      items.push({ from: [c[0] + R * Math.cos(a0), c[1] + R * Math.sin(a0)], seg: { type: 'arc', to: [c[0] + R * Math.cos(a1), c[1] + R * Math.sin(a1)], center: c, ccw: true } });
    } else if (e.type === 'CIRCLE') {
      const c = [get(e, 10), get(e, 20)], R = get(e, 40);
      contours.push({ start: [c[0] + R, c[1]], segments: [{ type: 'arc', to: [c[0] - R, c[1]], center: c, ccw: true }, { type: 'arc', to: [c[0] + R, c[1]], center: c, ccw: true }] });
    } else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
      const verts = [];
      let closed;
      if (e.type === 'LWPOLYLINE') {
        closed = (get(e, 70) ?? 0) & 1;
        for (const [c, v] of e.g) { if (c === 10) verts.push({ p: [Number(v), 0], b: 0 }); else if (c === 20) verts[verts.length - 1].p[1] = Number(v); else if (c === 42 && verts.length) verts[verts.length - 1].b = Number(v); }
      } else {
        closed = (get(e, 70) ?? 0) & 1;
        while (ents[k + 1]?.type === 'VERTEX') { k++; const v = ents[k]; verts.push({ p: [get(v, 10), get(v, 20)], b: get(v, 42) ?? 0 }); }
        if (ents[k + 1]?.type === 'SEQEND') k++;
      }
      const n = verts.length, last = closed ? n : n - 1;
      for (let j = 0; j < last; j++) {
        const A = verts[j], B = verts[(j + 1) % n];
        items.push({ from: A.p, seg: A.b ? bulgeArc(A.p, B.p, A.b) : { type: 'line', to: B.p } });
      }
    } else if (e.type === 'SPLINE') {
      const deg = get(e, 71) ?? 3, knots = [], ctrl = [];
      for (const [c, v] of e.g) { if (c === 40) knots.push(Number(v)); else if (c === 10) ctrl.push([Number(v), 0]); else if (c === 20) ctrl[ctrl.length - 1][1] = Number(v); }
      const t0 = knots[deg], t1 = knots[knots.length - deg - 1];
      const N = Math.max(32, ctrl.length * 8);
      const pts = Array.from({ length: N + 1 }, (_, j) => deBoor(deg, knots, ctrl, t0 + ((t1 - t0) * j) / N));
      items.push({ from: pts[0], seg: { type: 'spline', through: pts.slice(1, -1), to: pts[N] } });
    }
  }
  const r = chainSegments(items, 1e-6);
  return { contours: [...contours, ...r.contours], openCount: r.open.length, mmPerUnit: mmPerUnit ?? 1 };
}

// ================= CSV =================
/**
 * CSV(2 列の点列)→ 輪郭(図面座標 = (列1, 列2))。
 * opts.smooth: true で、角(折れ角 > cornerDeg)以外はスプラインでなめらかにつなぐ
 */
export function parseCSV(text, opts = {}) {
  const pts = [];
  for (const line of text.split(/\r?\n/)) {
    const v = line.trim().split(/[\s,;\t]+/).filter(Boolean).map(Number);
    if (v.length >= 2 && v.slice(0, 2).every(Number.isFinite)) pts.push([v[0], v[1]]);
  }
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-12) pts.pop();
  if (pts.length < 3) return { contours: [], openCount: 0, mmPerUnit: 1, error: '3 点以上の数値行が必要です' };
  const n = pts.length;
  if (!opts.smooth) return { contours: [{ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ type: 'line', to: [...p] })) }], openCount: 0, mmPerUnit: 1 };
  const cornerDeg = opts.cornerDeg ?? 30;
  const corner = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const u = [p[0] - a[0], p[1] - a[1]], v = [b[0] - p[0], b[1] - p[1]];
    const c = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v));
    return Math.acos(Math.max(-1, Math.min(1, c))) * (180 / Math.PI) > cornerDeg;
  });
  let s = corner.findIndex(Boolean);
  if (s < 0) s = 0; // 角がない(全体がなめらか)
  const order = Array.from({ length: n + 1 }, (_, i) => pts[(s + i) % n]);
  const isC = Array.from({ length: n + 1 }, (_, i) => corner[(s + i) % n]);
  const segments = [];
  let run = [];
  for (let i = 1; i <= n; i++) {
    if (isC[i] || i === n) {
      if (run.length) segments.push({ type: 'spline', through: run, to: [...order[i]] });
      else segments.push({ type: 'line', to: [...order[i]] });
      run = [];
    } else run.push([...order[i]]);
  }
  return { contours: [{ start: [...order[0]], segments }], openCount: 0, mmPerUnit: 1 };
}

/** 形式を自動判定して断面プロファイル群へ。opts は contoursToProfiles と parseCSV のもの */
export function importProfiles(text, format, opts = {}) {
  const parsed = format === 'svg' ? parseSVG(text) : format === 'dxf' ? parseDXF(text) : parseCSV(text, opts);
  if (parsed.error) return { profiles: [], warnings: [parsed.error], mmPerUnit: 1 };
  const mm = opts.mmPerUnit ?? parsed.mmPerUnit;
  const yUp = format !== 'svg'; // SVG は y 下向き
  const res = contoursToProfiles(parsed.contours, { axis: 'x', axisMode: 'center', ...opts, mmPerUnit: mm, yUp: opts.yUp ?? yUp });
  if (parsed.openCount) res.warnings.push(`閉じていない線が ${parsed.openCount} 本あり、無視しました`);
  if (!parsed.contours.length) res.warnings.push('閉じた輪郭が見つかりませんでした');
  return { ...res, mmPerUnit: mm };
}
