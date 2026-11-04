// 外観のスペクトル描画(非逐次・分岐追跡、プログレッシブ)
// 放射輝度の単位: 環境の「白」= 1(等エネルギースペクトル)。画像は線形 RGB(白 = 1)。
import { intersect, interfaceAt, T_MIN, buildTraceScene } from './nstrace.js';
import { thinFilm } from './thinfilm.js';
import { refract, reflect } from '../core/trace.js';
import { spectralToRGB, spectralToY, sampleLambda } from './color.js';
import { bounds } from './profile.js';

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
  let r = 1, z0 = Infinity, z1 = -Infinity;
  for (const p of parts) {
    // 粗い範囲(制御点込み)でよい
    const pts = [p.profile.start, ...p.profile.segments.map((s) => s.to)];
    for (const q of pts) { r = Math.max(r, q[0]); z0 = Math.min(z0, q[1] + (p.zOffset ?? 0)); z1 = Math.max(z1, q[1] + (p.zOffset ?? 0)); }
  }
  if (!Number.isFinite(z0)) { z0 = 0; z1 = 1; }
  const size = Math.max(2 * r, z1 - z0);
  return { target: [0, 0, (z0 + z1) / 2], azimuth: 35, elevation: 20, distance: size * 3.2, fov: 30 };
}

// ---------- 環境 ----------
export const ENV_PRESETS = {
  room: { label: '明るい室内' },
  dark: { label: '暗室 + スポット光' },
  white: { label: '白背景' },
  grid: { label: '格子背景(歪みの確認)' },
  black: { label: '黒背景' },
};
/** 方向 d(単位)の環境放射輝度 */
export function envRadiance(env, d) {
  const t = env?.type ?? 'room';
  if (typeof env?.fn === 'function') return env.fn(d);
  if (t === 'black') return 0;
  if (t === 'white') return 1;
  if (t === 'dark') return 0.01;
  if (t === 'grid') {
    // 緯度経度 10° 刻みの黒い線(太さ 0.6°)
    const lat = (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI, lon = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
    const near = (a) => { const m = ((a % 10) + 10) % 10; return Math.min(m, 10 - m) < 0.3; };
    return near(lat) || near(lon) ? 0.05 : 0.9;
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

// ---------- 追跡 ----------
const MAX_DEPTH = 12, SPLIT_DEPTH = 3;

/**
 * 1 本の光線の放射輝度(波長 λ nm)。w は画素から見た経路の重み。
 * 光源・環境に届いたとき、最初に反射した界面(firstRefl)へ w·L を寄与として積算する(ctx.contrib)。
 */
function radiance(ctx, o, d, lam, depth, firstRefl, w) {
  if (depth > MAX_DEPTH || w < 1e-7) return 0;
  const hit = intersect(ctx.scene, o, d, T_MIN);
  const lh = lightHit(ctx.lights, o, d, hit ? hit.t : Infinity);
  const term = (L) => { if (firstRefl && ctx.contrib) ctx.contrib[firstRefl] = (ctx.contrib[firstRefl] ?? 0) + w * L; return L; };
  if (lh.t < (hit ? hit.t : Infinity)) return term(lh.L);
  if (!hit) return term(envRadiance(ctx.env, d));
  const f = interfaceAt(ctx.scene, hit, d, lam / 1000);
  const P = hit.point;
  const key = faceKey(hit);
  if (f.opaque) return shadeOpaque(ctx, f, P, d, lam, depth, firstRefl ?? key, w);
  const tf = thinFilm(f.nBefore, f.layers, f.nAfter, f.cosI, lam / 1000);
  const R = tf.R, T = 1 - R;
  const rd = reflect(d, f.normal);
  const td = T > 1e-12 ? refract(d, f.normal, f.nBefore, f.nAfter) : null;
  if (!td) return radiance(ctx, P, rd, lam, depth + 1, firstRefl ?? key, w);
  if (depth < SPLIT_DEPTH) {
    const lr = R > 0 ? R * radiance(ctx, P, rd, lam, depth + 1, firstRefl ?? key, w * R) : 0;
    return lr + T * radiance(ctx, P, td, lam, depth + 1, firstRefl, w * T);
  }
  return ctx.rand() < R ? radiance(ctx, P, rd, lam, depth + 1, firstRefl ?? key, w) : radiance(ctx, P, td, lam, depth + 1, firstRefl, w);
}

function shadeOpaque(ctx, f, P, d, lam, depth, key, w) {
  let L = 0;
  const N = f.normal;
  const sp = f.opaque.specular, df = f.opaque.diffuse;
  if (sp > 0) L += sp * radiance(ctx, P, reflect(d, N), lam, depth + 1, key, w * sp);
  if (df > 0) {
    // 余弦重み付きで 1 方向をサンプル(ランバート面)
    const u1 = ctx.rand(), u2 = ctx.rand(), r = Math.sqrt(u1), ph = 2 * Math.PI * u2;
    const t1 = norm(Math.abs(N[0]) < 0.9 ? cross(N, [1, 0, 0]) : cross(N, [0, 1, 0])), t2 = cross(N, t1);
    const wi = norm(addS(addS(addS([0, 0, 0], t1, r * Math.cos(ph)), t2, r * Math.sin(ph)), N, Math.sqrt(1 - u1)));
    L += df * radiance(ctx, P, wi, lam, Math.max(depth + 1, MAX_DEPTH - 2), key, w * df);
  }
  return L;
}

/** 界面の識別子(共有面は部品名の組) */
function faceKey(hit) {
  return hit.hits.map((h) => `${h.entry.part.id}:${h.edge.seg}`).sort().join('|');
}

/**
 * 画像のタイルを描画して蓄積バッファに足す。
 * job: {parts, camera, env, lights, width, height, pass, x0, y0, w, h, scale(粗描画の画素サイズ)}
 * 返り値: {rgb: Float32Array(w*h*3), y: Float32Array(w*h), contrib: {key: Y の和}}
 */
export function renderTile(sceneCache, job) {
  const scene = sceneCache.scene;
  const cb = cameraBasis(job.camera);
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
    const bin = (job.pass + ((px * 7 + py * 13) % nBins)) % nBins;
    const lam = sampleLambda(bin, nBins, rand());
    const pc = {};
    const ctx = { scene, env: job.env, lights: job.lights, rand, contrib: pc };
    const L = radiance(ctx, ray.o, ray.d, lam, 0, null, 1);
    const yb = spectralToY(lam, 1);
    for (const key in pc) contrib[key] = (contrib[key] ?? 0) + pc[key] * yb;
    const c = spectralToRGB(lam, L);
    const k = j * job.w + i;
    rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2];
    Y[k] = spectralToY(lam, L);
  }
  return { rgb, y: Y, contrib };
}

/** 部品の配列から描画用キャッシュを作る(Worker ごとに 1 回) */
export function prepareScene(parts) {
  const scene = buildTraceScene(parts);
  let r = 1, z0 = Infinity, z1 = -Infinity;
  for (const e of scene.list) { const b = bounds(e.all); r = Math.max(r, b.rMax); z0 = Math.min(z0, b.zMin); z1 = Math.max(z1, b.zMax); }
  return { scene, center: [0, 0, Number.isFinite(z0) ? (z0 + z1) / 2 : 0], size: Math.max(2 * r, z1 - z0) };
}

/** 画像全体を n パス描画(Node のテスト・角度一覧用の同期版) */
export function renderImage(parts, { camera, env, lights, width, height, passes = 16 }) {
  const cache = prepareScene(parts);
  const L = [...(lights ?? []), ...presetLights(env, cache)];
  const rgb = new Float32Array(width * height * 3), y = new Float32Array(width * height);
  const contrib = {};
  for (let p = 0; p < passes; p++) {
    const t = renderTile(cache, { camera, env, lights: L, width, height, pass: p, x0: 0, y0: 0, w: width, h: height });
    for (let i = 0; i < rgb.length; i++) rgb[i] += t.rgb[i] / passes;
    for (let i = 0; i < y.length; i++) y[i] += t.y[i] / passes;
    for (const k in t.contrib) contrib[k] = (contrib[k] ?? 0) + t.contrib[k] / passes;
  }
  return { rgb, y, width, height, contrib };
}

/** 部品の面(セグメント)一覧 */
export function listFaces(parts) {
  const out = [];
  for (const p of parts) p.profile.segments.forEach((s, i) => out.push({ partId: p.id, seg: i, name: `${p.name} 面 ${i + 1}` }));
  return out;
}
