// 迷光モンテカルロ: フレネル反射(ゴースト/後方)、ガラス内部散乱(レイリー型)とラマン、
// 表面散乱(TIS, Lambert 分布)、空間の霧(ミー)。
// 分散低減: 主光線は各媒質区間で「散乱パケット」(重み w·P_int)、各面で「反射パケット」(w·R)・
//   「表面散乱パケット」(w·T·TIS) を確定的に分岐させ、自身は残りの重みで直進する。
//   分岐したパケットはアナログ(確率的)に追跡する。期待値でエネルギーを保存する。
// 重みの単位は formImage と同じ「スクリーン画素あたり照度」。
import { add, scale, dot, normalize, cross } from './vec.js';
import { refractiveIndex } from './glass.js';
import { surfaceZ, mediumAfter } from './system.js';
import { intersectSphere, surfaceNormal, refract, reflect, aimRay, findStop } from './trace.js';
import { fresnel } from './fresnel.js';
import { mie, miePhase, ramanShift, ramanAntiStokesRatio, surfaceTIST, SCATTER_DEFAULTS } from './scatter.js';
import { channelOf, imageNA, NA_REF, radialMap } from './imaging.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function basis(d) {
  const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(d, a));
  return [u, cross(d, u)];
}
function rotate(d, cosT, phi) {
  const [u, v] = basis(d);
  const s = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  return normalize(add(add(scale(d, cosT), scale(u, s * Math.cos(phi))), scale(v, s * Math.sin(phi))));
}
/** レイリー位相 (1+cos²θ) の逆関数サンプリング */
function sampleRayleighCos(u) {
  // CDF F(c) = (3c + c³ + 4)/8 → 3次方程式を解く
  const q = 8 * u - 4;
  const D = Math.sqrt(q * q / 4 + 1);
  return Math.cbrt(q / 2 + D) + Math.cbrt(q / 2 - D);
}
function makeTableSampler(mu, p) {
  // mu: cosθ(降順 1..−1)、p: 位相関数。CDF を θ について台形で作る
  const n = mu.length, cdf = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    const t0 = Math.acos(mu[k - 1]), t1 = Math.acos(mu[k]);
    cdf[k] = cdf[k - 1] + 0.5 * (p[k - 1] * Math.sin(t0) + p[k] * Math.sin(t1)) * (t1 - t0);
  }
  const tot = cdf[n - 1];
  return (u) => {
    const x = u * tot;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cdf[m] < x) lo = m; else hi = m; }
    const f = (x - cdf[lo]) / (cdf[hi] - cdf[lo] || 1);
    const t = Math.acos(mu[lo]) + f * (Math.acos(mu[hi]) - Math.acos(mu[lo]));
    return Math.cos(t);
  };
}

export function mergeScatterCfg(cfg = {}) {
  return {
    glass: { ...SCATTER_DEFAULTS.glass, ...cfg.glass },
    surface: { ...SCATTER_DEFAULTS.surface, ...cfg.surface },
    medium: { ...SCATTER_DEFAULTS.medium, ...cfg.medium },
  };
}

/**
 * @returns {image, raman:{stokes, antiStokes, wavelengths}, budget}
 */
export function strayLight(sys, objectImg, scatterCfg, opts = {}) {
  const cfg = mergeScatterCfg(scatterCfg);
  const N = opts.rays ?? 20000;
  const rnd = mulberry32(opts.seed ?? 1);
  const S = sys.surfaces, Z = surfaceZ(sys), last = S.length - 1;
  const P = sys.screen.pixels, w = sys.screen.width, pitch = w / P, h = sys.object.height;
  const image = new Float32Array(P * P * 3);
  const stokesImg = new Float32Array(P * P), antiImg = new Float32Array(P * P);
  const budget = { transmitted: 0, ghost: 0, glassScatter: 0, surfaceScatter: 0, mediumScatter: 0, raman: 0, backscatter: 0, lost: 0 };
  const ramanW = {};
  const ramanTotal = { stokes: 0, antiStokes: 0 }; // スクリーン面(画面外含む)に到達したラマン光
  const backscatterBy = {}; // 後方散乱の発生原因別内訳
  const back = (ph) => { budget.backscatter += ph.w; backscatterBy[ph.cat] = (backscatterBy[ph.cat] ?? 0) + ph.w; };

  // ---- 光源: 波長ごとの総光束と物体画素の CDF ----
  const npx = objectImg.size * objectImg.size;
  const Apix = ((2 * h) / objectImg.size) ** 2;
  const src = sys.wavelengths.map((lambda) => {
    const ch = channelOf(lambda);
    const cdf = new Float64Array(npx);
    let s = 0;
    for (let i = 0; i < npx; i++) { s += Math.max(0, objectImg.data[i * 3 + ch]); cdf[i] = s; }
    const m0 = radialMap(sys, lambda, 3).m0;
    const E0 = (imageNA(sys, lambda) / NA_REF) ** 2;
    return { lambda, cdf, flux: Number.isFinite(m0) ? s * E0 * Apix * m0 * m0 / (pitch * pitch) : 0 };
  });
  const total = src.reduce((a, b) => a + b.flux, 0);
  const result = () => {
    const tot = Object.values(budget).reduce((a, b) => a + b, 0) || 1;
    const frac = Object.fromEntries(Object.entries(budget).map(([k, v]) => [k, v / tot]));
    const by = Object.fromEntries(Object.entries(backscatterBy).map(([k, v]) => [k, v / tot]));
    return { image, raman: { stokes: stokesImg, antiStokes: antiImg, wavelengths: ramanW, total: ramanTotal }, budget: frac, backscatterBy: by, totalFlux: total };
  };
  if (!(total > 0)) return result();

  const stop = findStop(sys);
  const nCache = new Map();
  const nOf = (mat, l) => {
    const k = JSON.stringify(mat) + l;
    if (!nCache.has(k)) nCache.set(k, refractiveIndex(mat, l));
    return nCache.get(k);
  };
  const mieCache = new Map();
  const fog = (l) => {
    if (!(cfg.medium.density > 0)) return { mu: 0 };
    if (!mieCache.has(l)) {
      const x = (Math.PI * cfg.medium.particleUm) / l;
      const r = mie(x, cfg.medium.nParticle, 0, 181);
      const csca = r.Qsca * Math.PI * (cfg.medium.particleUm / 2) ** 2 * 1e-6; // mm²
      mieCache.set(l, { mu: cfg.medium.density * csca, sample: makeTableSampler(r.mu, miePhase(r, x)) });
    }
    return mieCache.get(l);
  };
  // 区間 k(面 k と k+1 の間)の媒質と散乱係数
  const segment = (k, l) => {
    const mat = mediumAfter(sys, k);
    if (mat.type === 'air') { const f = fog(l); return { n: 1, muS: f.mu, muR: 0, kind: 'medium', sample: f.sample }; }
    return {
      n: nOf(mat, l), muS: cfg.glass.scatterCoef * (0.55 / l) ** 4, muR: cfg.glass.ramanCoef, kind: 'glass',
    };
  };

  const deposit = (ph) => {
    const ix = Math.floor((ph.p[0] + w / 2) / pitch), iy = Math.floor((w / 2 - ph.p[1]) / pitch);
    const inside = ix >= 0 && iy >= 0 && ix < P && iy < P;
    if (ph.cat === 'transmitted') { budget.transmitted += ph.w; return; }
    if (ph.cat === 'raman') {
      budget.raman += ph.w;
      ramanTotal[ph.raman] += ph.w;
      if (inside) (ph.raman === 'stokes' ? stokesImg : antiImg)[iy * P + ix] += ph.w;
      return;
    }
    budget[ph.cat] += ph.w;
    if (ph.cat !== 'ghost' && inside) image[(iy * P + ix) * 3 + channelOf(ph.lambda)] += ph.w;
  };

  // パケット: {p, d, lambda, w, seg(直前に通過した面 index), cat, raman}
  function run(ph, main) {
    for (let ev = 0; ev < 200; ev++) {
      const fwd = ph.d[2] > 0;
      const next = fwd ? ph.seg + 1 : ph.seg;
      if (!fwd && ph.seg === 0) { back(ph); return; } // 物体側へ戻った
      if (next > last) { budget.lost += ph.w; return; }
      const s = S[next];
      const radius = s.kind === 'surface' ? s.radius : Infinity;
      const t = intersectSphere(ph.p, ph.d, Z[next], radius);
      if (t === null || t < -1e-6) { budget.lost += ph.w; return; }
      // 区間内の体積散乱
      const sg = segment(ph.seg, ph.lambda);
      const mu = sg.muS + sg.muR;
      if (mu > 0) {
        const Pint = 1 - Math.exp(-mu * t);
        if (main) {
          if (Pint > 0) {
            const dist = -Math.log(1 - rnd() * Pint) / mu;
            const at = add(ph.p, scale(ph.d, dist));
            if (sg.muS > 0) run(volumeScatter({ ...ph, p: at, w: ph.w * Pint * (sg.muS / mu) }, sg, false), false);
            if (sg.muR > 0) run(volumeScatter({ ...ph, p: at, w: ph.w * Pint * (sg.muR / mu) }, sg, true), false);
            ph.w *= 1 - Pint;
          }
        } else {
          const dist = -Math.log(1 - rnd()) / mu;
          if (dist < t) { ph = volumeScatter({ ...ph, p: add(ph.p, scale(ph.d, dist)) }, sg, rnd() < sg.muR / mu); continue; }
        }
      }
      const Pn = add(ph.p, scale(ph.d, t));
      ph = { ...ph, p: Pn };
      if (next === last) {
        if (fwd) { deposit(ph); return; }
        budget.lost += ph.w; return;
      }
      if (Math.hypot(Pn[0], Pn[1]) > s.diameter / 2) { budget.lost += ph.w; return; }
      if (s.kind !== 'surface') { ph.seg = fwd ? next : next - 1; continue; }
      const nFront = nOf(mediumAfter(sys, next - 1), ph.lambda), nBack = nOf(s.material, ph.lambda);
      const [n1, n2] = fwd ? [nFront, nBack] : [nBack, nFront];
      const Nn = surfaceNormal(Pn, Z[next], radius);
      const cosI = Math.abs(dot(ph.d, Nn));
      const F = fresnel(n1, n2, cosI);
      const tis = Math.min(1, surfaceTIST(cfg.surface.sigmaNm, ph.lambda, n1, n2, cosI));
      const refl = { ...ph, d: reflect(ph.d, Nn), seg: fwd ? next - 1 : next, cat: ph.cat === 'transmitted' ? 'ghost' : ph.cat };
      const dt = F.T > 0 ? refract(ph.d, Nn, n1, n2) : null;
      const segAfter = fwd ? next : next - 1;
      const scatterDir = () => {
        // 透過側の半球に Lambert 分布
        const nT = dot(Nn, dt) > 0 ? Nn : scale(Nn, -1);
        return rotate(nT, Math.sqrt(rnd()), 2 * Math.PI * rnd());
      };
      if (main) {
        if (F.R > 0) run({ ...refl, w: ph.w * F.R }, false);
        if (!dt) return;
        if (tis > 0) run({ ...ph, d: scatterDir(), seg: segAfter, w: ph.w * F.T * tis, cat: 'surfaceScatter' }, false);
        ph = { ...ph, d: dt, seg: segAfter, w: ph.w * F.T * (1 - tis) };
      } else {
        if (!dt || rnd() < F.R) { ph = refl; continue; }
        if (rnd() < tis) ph = { ...ph, d: scatterDir(), seg: segAfter, cat: ph.cat === 'transmitted' ? 'surfaceScatter' : ph.cat };
        else ph = { ...ph, d: dt, seg: segAfter };
      }
    }
    budget.lost += ph.w;
  }

  function volumeScatter(ph, sg, isRaman) {
    if (isRaman) {
      const q = ramanAntiStokesRatio(ph.lambda, cfg.glass.ramanShift, cfg.glass.tempK);
      const sh = ramanShift(ph.lambda, cfg.glass.ramanShift);
      const anti = rnd() < q / (1 + q);
      const l = anti ? sh.antiStokes : sh.stokes;
      ramanW[anti ? 'antiStokes' : 'stokes'] = ramanW[anti ? 'antiStokes' : 'stokes'] ?? {};
      ramanW[anti ? 'antiStokes' : 'stokes'][ph.lambda] = l;
      return { ...ph, lambda: l, d: rotate(ph.d, sampleRayleighCos(rnd()), 2 * Math.PI * rnd()), cat: 'raman', raman: anti ? 'antiStokes' : 'stokes' };
    }
    const c = sg.kind === 'medium' && sg.sample ? sg.sample(rnd()) : sampleRayleighCos(rnd());
    const cat = ph.cat === 'transmitted' ? (sg.kind === 'medium' ? 'mediumScatter' : 'glassScatter') : ph.cat;
    return { ...ph, d: rotate(ph.d, c, 2 * Math.PI * rnd()), cat };
  }

  // ---- 光線の発生 ----
  for (let i = 0; i < N; i++) {
    let u = rnd() * total, si = 0;
    while (si < src.length - 1 && u > src[si].flux) { u -= src[si].flux; si++; }
    const sc = src[si];
    if (!(sc.flux > 0)) continue;
    const x = rnd() * sc.cdf[npx - 1];
    let lo = 0, hi = npx - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sc.cdf[m] < x) lo = m + 1; else hi = m; }
    const px = lo % objectImg.size, py = Math.floor(lo / objectImg.size);
    const ox = -h + ((px + rnd()) / objectImg.size) * 2 * h, oy = h - ((py + rnd()) / objectImg.size) * 2 * h;
    const r = Math.sqrt(rnd()), a = 2 * Math.PI * rnd();
    const ray = aimRay(sys, [ox, oy, 0], sc.lambda, r * Math.cos(a), r * Math.sin(a), stop);
    run({ p: ray.p, d: ray.d, lambda: sc.lambda, w: total / N, seg: 0, cat: 'transmitted' }, true);
  }
  return result();
}

/** 直接光・ゴースト・迷光・ラマンを合成し 0..1 にクランプ(線形) */
export function composeImage(direct, ghost, stray, weights = {}, raman = null) {
  const { direct: wd = 1, ghost: wg = 1, stray: ws = 1, raman: wr = 1, exposure = 1 } = weights;
  const out = new Float32Array(direct.length);
  const STOKES = [1, 0.55, 0], ANTI = [0.6, 0.2, 1]; // ラマン表示色(3 波長とは別の色)
  for (let i = 0; i < direct.length; i++) {
    let v = wd * direct[i] + (ghost ? wg * ghost[i] : 0) + (stray ? ws * stray[i] : 0);
    if (raman && wr) { const p = Math.floor(i / 3), c = i % 3; v += wr * (raman.stokes[p] * STOKES[c] + raman.antiStokes[p] * ANTI[c]); }
    out[i] = Math.min(1, Math.max(0, v * exposure));
  }
  return out;
}
