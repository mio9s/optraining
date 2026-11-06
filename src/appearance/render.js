// 外観のスペクトル描画(非逐次・分岐追跡、プログレッシブ)
// 放射輝度の単位: 環境の「白」= 1(等エネルギースペクトル)。画像は線形 RGB(白 = 1)。
import { intersect, interfaceAt, T_MIN, buildTraceScene, materialIndex } from './nstrace.js';
import { thinFilm, bareR } from './thinfilm.js';
import { refract, reflect } from '../core/trace.js';
import { spectralToRGB, spectralToY, sampleLambda } from './color.js';
import { bounds } from './profile.js';
import { partBounds } from './scene.js';

// ---------- 乱数 ----------
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (x, y, p) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(p + 1, 83492791)) >>> 0;

// ---------- ベクトル ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addS = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const norm = (a) => { const L = Math.hypot(a[0], a[1], a[2]); return [a[0] / L, a[1] / L, a[2] / L]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---------- カメラ ----------
/** camera: {target, azimuth(°), elevation(°), distance, fov(°)}。az=0, el=0 で −z 側(物体側)から +z を見る */
export function cameraBasis(cam) {
  const az = (cam.azimuth * Math.PI) / 180, el = (cam.elevation * Math.PI) / 180;
  const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
  const pos = addS(cam.target, dir, cam.distance);
  const fwd = norm(sub(cam.target, pos));
  let up = [0, 1, 0];
  if (Math.abs(dot(up, fwd)) > 0.999) up = [1, 0, 0];
  const right = norm(cross(fwd, up)), trueUp = cross(right, fwd);
  return { pos, fwd, right, up: trueUp, tanHalf: Math.tan(((cam.fov ?? 30) * Math.PI) / 360) };
}
export function primaryRay(cb, u, v, aspect) {
  // u, v ∈ [−1, 1](v は上向き)
  const d = norm(addS(addS(cb.fwd, cb.right, u * cb.tanHalf * aspect), cb.up, v * cb.tanHalf));
  return { o: cb.pos, d };
}

/** シーンを見やすく収めるカメラの既定値 */
export function defaultCamera(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    if (p.visible === false) continue; // 非表示の部品は視野に入れない
    let b; try { b = partBounds(p); } catch { continue; }
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.lo[k]); hi[k] = Math.max(hi[k], b.hi[k]); }
  }
  if (!Number.isFinite(lo[0])) return { target: [0, 0, 0], azimuth: 35, elevation: 20, distance: 60, fov: 30 };
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1);
  return { target: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], azimuth: 35, elevation: 20, distance: size * 3.2, fov: 30 };
}

// ---------- 環境 ----------
export const ENV_PRESETS = {
  room: { label: '明るい室内' },
  dark: { label: '暗室 + スポット光' },
  white: { label: '白背景' },
  grid: { label: '格子パネル(歪みの確認)' },
  black: { label: '黒背景' },
};
/**
 * 環境放射輝度。d: 方向(単位)、o: 光線の始点(格子パネルとの交点を求めるのに使う)。
 * grid: レンズの後ろに、カメラと正対する平らな格子パネル(env.plane)を置く。レンズの外では格子は直線に見え、
 *       レンズを通した部分だけが屈折で歪む。パネルに当たらない方向は一様な灰色。
 */
export function envRadiance(env, d, o) {
  const t = env?.type ?? 'room';
  if (typeof env?.fn === 'function') return env.fn(d);
  if (t === 'black') return 0;
  if (t === 'white') return 1;
  if (t === 'dark') return 0.01;
  if (t === 'grid') {
    const pl = env.plane;
    if (!pl || !o) return 0.75;
    const den = d[0] * pl.n[0] + d[1] * pl.n[1] + d[2] * pl.n[2];
    if (den >= -1e-9) return 0.6; // パネルと反対側(カメラ側)へ向かう光
    const tt = ((pl.p[0] - o[0]) * pl.n[0] + (pl.p[1] - o[1]) * pl.n[1] + (pl.p[2] - o[2]) * pl.n[2]) / den;
    if (tt <= 0) return 0.6;
    const q = [o[0] + tt * d[0] - pl.p[0], o[1] + tt * d[1] - pl.p[1], o[2] + tt * d[2] - pl.p[2]];
    const a = (q[0] * pl.u[0] + q[1] * pl.u[1] + q[2] * pl.u[2]) / pl.spacing, b = (q[0] * pl.v[0] + q[1] * pl.v[1] + q[2] * pl.v[2]) / pl.spacing;
    const near = (x) => { const f = x - Math.floor(x); return Math.min(f, 1 - f) < pl.halfWidth; };
    return near(a) || near(b) ? 0.05 : 0.9;
  }
  // room: 天井が明るく床が暗いグラデーション + 窓(+x 側の明るい長方形)
  const y = d[1];
  let L = y > 0 ? 0.55 + 0.45 * y : 0.55 + 0.35 * y;
  const az = Math.atan2(d[0], d[2]), el = Math.asin(Math.max(-1, Math.min(1, y)));
  if (Math.abs(az - Math.PI / 2) < 0.35 && el > 0.05 && el < 0.55) L = 3;
  return L;
}

// ---------- 光源 ----------
// {type:'point', pos, radius, radiance} / {type:'rect', center, u, v(半辺ベクトル), radiance, twoSided}
function lightHit(lights, o, d, tmax) {
  let best = tmax, L = 0;
  for (const l of lights ?? []) {
    if (l.type === 'point') {
      const oc = sub(o, l.pos), b = dot(oc, d), c = dot(oc, oc) - l.radius * l.radius, D = b * b - c;
      if (D < 0) continue;
      const t = -b - Math.sqrt(D);
      if (t > T_MIN && t < best) { best = t; L = l.radiance; }
    } else if (l.type === 'rect') {
      const n = norm(cross(l.u, l.v)), den = dot(n, d);
      if (Math.abs(den) < 1e-12 || (!l.twoSided && den > 0)) continue;
      const t = dot(sub(l.center, o), n) / den;
      if (t < T_MIN || t >= best) continue;
      const p = sub(addS(o, d, t), l.center);
      if (Math.abs(dot(p, l.u)) <= dot(l.u, l.u) && Math.abs(dot(p, l.v)) <= dot(l.v, l.v)) { best = t; L = l.radiance; }
    }
  }
  return { t: best, L };
}

/** プリセット環境に付属する光源 */
export function presetLights(env, scene) {
  if ((env?.type ?? 'room') !== 'dark') return [];
  const c = scene.center ?? [0, 0, 0], s = scene.size ?? 20;
  return [{ type: 'point', pos: [c[0] + s * 1.2, c[1] + s * 1.5, c[2] - s * 1.5], radius: s * 0.06, radiance: 60 }];
}

// ---------- 拡散面の照度(ノイズなしの近似) ----------
// 環境光を余弦重みで積分した照度を法線方向の表にしておき、光源の直接光を足す(遮蔽は無視する近似)。
const irrCache = new Map();
function envIrradianceTable(env) {
  const key = env?.fn ? env.fn : (env?.type ?? 'room');
  let t = irrCache.get(key);
  if (t) return t;
  const NT = 16, NP = 32, S = 24;
  t = new Float64Array(NT * NP);
  for (let i = 0; i < NT; i++) for (let j = 0; j < NP; j++) {
    const th = (Math.PI * (i + 0.5)) / NT, ph = (2 * Math.PI * (j + 0.5)) / NP;
    const N = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    const t1 = norm(Math.abs(N[0]) < 0.9 ? cross(N, [1, 0, 0]) : cross(N, [0, 1, 0])), t2 = cross(N, t1);
    let E = 0;
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
      const u1 = (a + 0.5) / S, u2 = (b + 0.5) / S, r = Math.sqrt(u1), q = 2 * Math.PI * u2;
      const wi = norm(addS(addS(addS([0, 0, 0], t1, r * Math.cos(q)), t2, r * Math.sin(q)), N, Math.sqrt(1 - u1)));
      E += envRadiance(env, wi);
    }
    t[i * NP + j] = (Math.PI * E) / (S * S); // E = π · 余弦重み平均
  }
  irrCache.set(key, t);
  return t;
}
function diffuseRadiance(ctx, P, N, albedo) {
  const t = envIrradianceTable(ctx.env), NT = 16, NP = 32;
  const th = Math.acos(Math.max(-1, Math.min(1, N[1]))), ph = (Math.atan2(N[2], N[0]) + 2 * Math.PI) % (2 * Math.PI);
  const fi = Math.max(0, Math.min(NT - 1.001, (th / Math.PI) * NT - 0.5)), fj = (ph / (2 * Math.PI)) * NP - 0.5;
  const i0 = Math.floor(fi), ai = fi - i0, j0 = Math.floor(fj), aj = fj - j0;
  const g = (i, j) => t[Math.min(NT - 1, i) * NP + ((j % NP) + NP) % NP];
  let E = (1 - ai) * ((1 - aj) * g(i0, j0) + aj * g(i0, j0 + 1)) + ai * ((1 - aj) * g(i0 + 1, j0) + aj * g(i0 + 1, j0 + 1));
  for (const l of ctx.lights ?? []) {
    const c = l.type === 'point' ? l.pos : l.center, v = sub(c, P), d2 = dot(v, v), dl = Math.sqrt(d2), dir = [v[0] / dl, v[1] / dl, v[2] / dl];
    const cosN = dot(N, dir);
    if (cosN <= 0) continue;
    if (l.type === 'point') E += (l.radiance * Math.PI * l.radius * l.radius * cosN) / d2;
    else { const n = norm(cross(l.u, l.v)), area = 4 * Math.hypot(...cross(l.u, l.v)); E += (l.radiance * area * Math.abs(dot(n, dir)) * cosN) / d2; }
  }
  return (albedo * E) / Math.PI;
}

// ---------- 追跡 ----------
const MAX_DEPTH = 12, SPLIT_DEPTH = 3, SPLIT_WEIGHT = 1e-4;

/**
 * 1 本の光線の放射輝度(波長 λ nm)。w は画素から見た経路の重み。
 * 光源・環境に届いたとき、最初に反射した界面(firstRefl)へ w·L を寄与として積算する(ctx.contrib)。
 */
function radiance(ctx, o, d, lam, depth, firstRefl, w, prev = null) {
  if (depth > MAX_DEPTH || w < 1e-7) return 0;
  const hit = intersect(ctx.scene, o, d, T_MIN, Infinity, prev);
  const lh = lightHit(ctx.lights, o, d, hit ? hit.t : Infinity);
  const term = (L) => { if (firstRefl && ctx.contrib) ctx.contrib[firstRefl] = (ctx.contrib[firstRefl] ?? 0) + w * L; return L; };
  if (lh.t < (hit ? hit.t : Infinity)) return term(lh.L);
  if (!hit) return term(envRadiance(ctx.env, d, o));
  const f = interfaceAt(ctx.scene, hit, d, lam / 1000);
  const P = hit.point;
  const key = faceKey(hit, f);
  if (f.opaque) return shadeOpaque(ctx, f, P, d, lam, depth, firstRefl ?? key, w);
  const tf = thinFilm(f.nBefore, f.layers, f.nAfter, f.cosI, lam / 1000);
  // 比較用: 内部界面(部品どうしの接合面)の反射を消す(屈折はそのまま)
  const internal = !!(f.before && f.after); // 部品どうし(空洞の媒質を含む)の界面
  const R = ctx.suppressInternal && internal && f.cosI > 0 && tf.R < 1 ? 0 : tf.R, T = 1 - R;
  const rd = reflect(d, f.normal);
  const td = T > 1e-12 ? refract(d, f.normal, f.nBefore, f.nAfter) : null;
  if (!td) return radiance(ctx, P, rd, lam, depth + 1, firstRefl ?? key, w, hit);
  // 重みの大きい分岐は両方を追い(ノイズなし)、寄与が無視できる深い分岐だけ確率的に選ぶ
  if (depth < SPLIT_DEPTH || w * Math.min(R, T) > SPLIT_WEIGHT) {
    const lr = R > 0 ? R * radiance(ctx, P, rd, lam, depth + 1, firstRefl ?? key, w * R, hit) : 0;
    return lr + T * radiance(ctx, P, td, lam, depth + 1, firstRefl, w * T, hit);
  }
  return ctx.rand() < R ? radiance(ctx, P, rd, lam, depth + 1, firstRefl ?? key, w, hit) : radiance(ctx, P, td, lam, depth + 1, firstRefl, w, hit);
}

function shadeOpaque(ctx, f, P, d, lam, depth, key, w) {
  let L = 0;
  const N = f.normal;
  const sp = f.opaque.specular, df = f.opaque.diffuse;
  if (sp > 0) L += sp * radiance(ctx, P, reflect(d, N), lam, depth + 1, key, w * sp);
  if (df > 0) L += diffuseRadiance(ctx, P, N, df);
  return L;
}

// ---------- まとめ追跡(16 波長を 1 本の経路で) ----------
const NB = 16;
const LAMS = Array.from({ length: NB }, (_, b) => sampleLambda(b, NB, 0.5));
const RGBW = LAMS.map((l) => spectralToRGB(l, 1 / NB));
const YW = LAMS.map((l) => spectralToY(l, 1 / NB));
const idxCache = new WeakMap();
const AIR_N = new Float64Array(NB).fill(1);
function indices(entry) {
  if (!entry) return AIR_N;
  const m = entry.part.material;
  let v = idxCache.get(m);
  if (!v) { v = Float64Array.from(LAMS, (l) => (m.type === 'opaque' ? NaN : materialIndex(m, l / 1000))); idxCache.set(m, v); }
  return v;
}
const YSUM = YW.reduce((a, b) => a + b, 0);
const lum = (v) => { let s = 0; for (let b = 0; b < NB; b++) s += YW[b] * v[b]; return s; };
const filled = (x) => { const v = new Float64Array(NB); if (x) v.fill(x); return v; };
const scaled = (v, k) => { const o = new Float64Array(NB); for (let b = 0; b < NB; b++) o[b] = v[b] * k; return o; };

// 深さごとの作業用バッファ(割り当てなし)。子の結果は受け取った直後に親が足し込むので、同じ深さで使い回せる
const BUF_L = Array.from({ length: MAX_DEPTH + 2 }, () => new Float64Array(NB));
const BUF_R = Array.from({ length: MAX_DEPTH + 2 }, () => new Float64Array(NB));
const BUF_T = Array.from({ length: MAX_DEPTH + 3 }, () => new Float64Array(NB));

/**
 * 16 波長の放射輝度ベクトル(BUF_L[depth] を返す。呼び出し側はすぐに使うこと)。
 * 経路の形は ctx.lamG(nm)で決め、反射率・透過率は波長ごとに計算する。thr は画素から見た経路の重み(波長ごと)。
 */
function radianceV(ctx, o, d, depth, firstRefl, thr, prev = null) {
  const L = BUF_L[depth];
  L.fill(0);
  const w = lum(thr) / YSUM;
  if (depth > MAX_DEPTH || w < 1e-7) return L;
  const hit = intersect(ctx.scene, o, d, T_MIN, Infinity, prev);
  const lh = lightHit(ctx.lights, o, d, hit ? hit.t : Infinity);
  let Lterm = -1;
  if (lh.t < (hit ? hit.t : Infinity)) Lterm = lh.L;
  else if (!hit) Lterm = envRadiance(ctx.env, d, o);
  if (Lterm >= 0) {
    if (firstRefl && ctx.contrib) ctx.contrib[firstRefl] = (ctx.contrib[firstRefl] ?? 0) + lum(thr) * Lterm;
    L.fill(Lterm);
    return L;
  }
  const f = interfaceAt(ctx.scene, hit, d, ctx.lamG / 1000);
  const P = hit.point;
  const child = BUF_T[depth + 1];
  if (f.opaque) {
    const key = firstRefl ?? faceKey(hit, f);
    const N = f.normal, sp = f.opaque.specular, df = f.opaque.diffuse;
    const acc = new Float64Array(NB);
    if (sp > 0) { for (let b = 0; b < NB; b++) child[b] = thr[b] * sp; const Lr = radianceV(ctx, P, reflect(d, N), depth + 1, key, child, hit); for (let b = 0; b < NB; b++) acc[b] += sp * Lr[b]; }
    if (df > 0) { const Ld = diffuseRadiance(ctx, P, N, df); for (let b = 0; b < NB; b++) acc[b] += Ld; }
    L.set(acc);
    return L;
  }
  const rd = reflect(d, f.normal);
  const td = refract(d, f.normal, f.nBefore, f.nAfter);
  if (!td) { // 全反射: そのまま子の結果を返す
    const key = firstRefl ?? faceKey(hit, f);
    for (let b = 0; b < NB; b++) child[b] = thr[b];
    const Lr = radianceV(ctx, P, rd, depth + 1, key, child, hit);
    L.set(Lr);
    return L;
  }
  const internal = !!(f.before && f.after); // 部品どうし(空洞の媒質を含む)の界面
  const nb = indices(f.before), na = indices(f.after);
  const R = BUF_R[depth];
  R.fill(0);
  if (!(ctx.suppressInternal && internal)) {
    const ci = Math.abs(f.cosI);
    if (!f.layers.length) for (let b = 0; b < NB; b++) R[b] = bareR(nb[b], na[b], ci);
    else for (let b = 0; b < NB; b++) R[b] = thinFilm(nb[b], f.layers, na[b], ci, LAMS[b] / 1000).R;
  }
  let Rm = 0, Ysum = 0;
  for (let b = 0; b < NB; b++) { Rm += YW[b] * R[b] * thr[b]; Ysum += YW[b] * thr[b]; }
  Rm = Ysum > 0 ? Rm / Ysum : 0;
  let doR = Rm > 0, doT = true, sR = 1, sT = 1;
  if (doR && !(depth < SPLIT_DEPTH || w * Math.min(Rm, 1 - Rm) > SPLIT_WEIGHT)) {
    if (ctx.rand() < Rm) { doT = false; sR = Rm; } else { doR = false; sT = 1 - Rm; }
  }
  if (doR) {
    for (let b = 0; b < NB; b++) child[b] = (thr[b] * R[b]) / sR;
    const Lr = radianceV(ctx, P, rd, depth + 1, firstRefl ?? faceKey(hit, f), child, hit);
    for (let b = 0; b < NB; b++) L[b] += (R[b] / sR) * Lr[b];
  }
  if (doT) {
    for (let b = 0; b < NB; b++) child[b] = (thr[b] * (1 - R[b])) / sT;
    const Lt = radianceV(ctx, P, td, depth + 1, firstRefl, child, hit);
    for (let b = 0; b < NB; b++) L[b] += ((1 - R[b]) / sT) * Lt[b];
  }
  return L;
}

/** 界面の識別子(共有面は部品名の組) */
function faceKey(hit, f) {
  const k = hit.hits.map((h) => `${h.entry.part.id}:${h.edge.seg}`);
  if (f) for (const e of [f.before, f.after]) if (e?.kind === 'cavity') k.push(`${e.part.id}:0`);
  return k.sort().join('|');
}

/**
 * 画像のタイルを描画して蓄積バッファに足す。
 * job: {parts, camera, env, lights, width, height, pass, x0, y0, w, h, scale(粗描画の画素サイズ)}
 * 返り値: {rgb: Float32Array(w*h*3), y: Float32Array(w*h), contrib: {key: Y の和}}
 */
export function renderTile(sceneCache, job) {
  const scene = sceneCache.scene;
  const cb = cameraBasis(job.camera);
  const env = gridPanel(job.env, cb, job.camera, sceneCache);
  const aspect = job.width / job.height;
  const rgb = new Float32Array(job.w * job.h * 3), Y = new Float32Array(job.w * job.h);
  const contrib = {};
  const nBins = 16;
  for (let j = 0; j < job.h; j++) for (let i = 0; i < job.w; i++) {
    const px = job.x0 + i, py = job.y0 + j;
    const rand = rng(hash(px, py, job.pass));
    const ju = job.pass === 0 ? 0.5 : rand(), jv = job.pass === 0 ? 0.5 : rand();
    const u = ((px + ju) / job.width) * 2 - 1, v = 1 - ((py + jv) / job.height) * 2;
    const ray = primaryRay(cb, u, v, aspect);
    // 波長は 16 帯の中心を巡回(16 パスごとに全画素が同じ波長の組を通るので、灰色の背景で色・輝度ノイズが出ない)
    const bin = (job.pass + ((px * 7 + py * 13) % nBins)) % nBins;
    const lam = sampleLambda(bin, nBins, 0.5);
    const pc = {};
    const k = j * job.w + i;
    if (job.exactSpectral) {
      // 正確モード: 1 サンプル 1 波長(分散による光路の違いもサンプルごとに厳密)
      const ctx = { scene, env, lights: job.lights, rand, contrib: pc, suppressInternal: !!job.suppressInternal };
      const L = radiance(ctx, ray.o, ray.d, lam, 0, null, 1);
      const yb = spectralToY(lam, 1);
      for (const key in pc) contrib[key] = (contrib[key] ?? 0) + pc[key] * yb;
      const c = spectralToRGB(lam, L);
      rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2];
      Y[k] = spectralToY(lam, L);
    } else {
      // まとめモード(既定): 経路は 1 本、反射率は 16 波長ぶん。経路の波長はパスごとに巡回(分散は平均として入る)
      const lamG = job.pass === 0 ? 550 : lam;
      const ctx = { scene, env, lights: job.lights, rand, contrib: pc, suppressInternal: !!job.suppressInternal, lamG };
      const L = radianceV(ctx, ray.o, ray.d, 0, null, BUF_T[0].fill(1));
      let r = 0, g = 0, bl = 0, yy = 0;
      for (let b = 0; b < NB; b++) { r += RGBW[b][0] * L[b]; g += RGBW[b][1] * L[b]; bl += RGBW[b][2] * L[b]; yy += YW[b] * L[b]; }
      for (const key in pc) contrib[key] = (contrib[key] ?? 0) + pc[key];
      rgb[k * 3] = r; rgb[k * 3 + 1] = g; rgb[k * 3 + 2] = bl;
      Y[k] = yy;
    }
  }
  return { rgb, y: Y, contrib };
}

/**
 * 格子パネル: 注視点からカメラと反対側へ、シーンの大きさの 1.5 倍の位置に、カメラと正対させて置く。
 * 格子の間隔はシーンの大きさの約 1/6 を切りのよい値(1・2・5 × 10ⁿ mm)に丸める。
 */
export function gridPanel(env, cb, camera, cache) {
  if ((env?.type ?? 'room') !== 'grid') return env;
  const size = cache?.size ?? 20;
  const raw = size / 6, p10 = 10 ** Math.floor(Math.log10(raw));
  const spacing = [1, 2, 5, 10].map((k) => k * p10).find((v) => v >= raw * 0.75) ?? raw;
  const p = [camera.target[0] + cb.fwd[0] * size * 1.5, camera.target[1] + cb.fwd[1] * size * 1.5, camera.target[2] + cb.fwd[2] * size * 1.5];
  return { ...env, plane: { p, n: [-cb.fwd[0], -cb.fwd[1], -cb.fwd[2]], u: cb.right, v: cb.up, spacing, halfWidth: 0.045 } };
}

/** 部品の配列から描画用キャッシュを作る(Worker ごとに 1 回) */
export function prepareScene(parts) {
  const scene = buildTraceScene(parts);
  let r = 1, z0 = Infinity, z1 = -Infinity;
  for (const e of scene.list) {
    if (e.kind === 'mesh') { const b = e.box3; r = Math.max(r, Math.abs(b[0]), Math.abs(b[1]), Math.abs(b[3]), Math.abs(b[4])); z0 = Math.min(z0, b[2]); z1 = Math.max(z1, b[5]); continue; }
    const b = bounds(e.all); r = Math.max(r, b.rMax); z0 = Math.min(z0, b.zMin); z1 = Math.max(z1, b.zMax);
  }
  return { scene, center: [0, 0, Number.isFinite(z0) ? (z0 + z1) / 2 : 0], size: Math.max(2 * r, z1 - z0) };
}

/** 画像全体を n パス描画(Node のテスト・角度一覧用の同期版) */
export function renderImage(parts, { camera, env, lights, width, height, passes = 16, suppressInternal = false, exactSpectral = false }) {
  const cache = prepareScene(parts);
  const L = [...(lights ?? []), ...presetLights(env, cache)];
  const rgb = new Float32Array(width * height * 3), y = new Float32Array(width * height);
  const contrib = {};
  for (let p = 0; p < passes; p++) {
    const t = renderTile(cache, { camera, env, lights: L, width, height, pass: p, x0: 0, y0: 0, w: width, h: height, suppressInternal, exactSpectral });
    for (let i = 0; i < rgb.length; i++) rgb[i] += t.rgb[i] / passes;
    for (let i = 0; i < y.length; i++) y[i] += t.y[i] / passes;
    for (const k in t.contrib) contrib[k] = (contrib[k] ?? 0) + t.contrib[k] / passes;
  }
  return { rgb, y, width, height, contrib };
}

/** 部品の面(セグメント)一覧 */
export function listFaces(parts) {
  const out = [];
  for (const p of parts) {
    if (p.kind === 'mesh') { out.push({ partId: p.id, seg: 0, name: `${p.name} 表面` }); continue; }
    p.profile.segments.forEach((s, i) => out.push({ partId: p.id, seg: i, name: `${p.name} 面 ${i + 1}` }));
  }
  return out;
}

/**
 * 内部界面の見え方マップ: 通常の画像 a と内部界面の反射を消した画像 b の輝度から、画素ごとのウェーバーコントラスト
 * C = (Y_a − Y_b) / Y_b を求める。mask は部品が写っている画素(どちらかで部品に当たった)。
 */
export function internalVisibility(a, b, threshold = 0.02, floor = 1e-4) {
  const n = a.y.length, C = new Float32Array(n);
  let max = 0, over = 0, count = 0, maxIdx = -1;
  for (let i = 0; i < n; i++) {
    const ya = a.y[i] / (a.n ? a.n[i] || 1 : 1), yb = b.y[i] / (b.n ? b.n[i] || 1 : 1);
    const c = (ya - yb) / Math.max(yb, floor);
    C[i] = c;
    if (Math.abs(ya - yb) > 0 || yb > 0) count++;
    if (Math.abs(c) > Math.abs(max)) { max = c; maxIdx = i; }
    if (Math.abs(c) >= threshold) over++;
  }
  return { C, max, maxIdx, over, fraction: over / n };
}
