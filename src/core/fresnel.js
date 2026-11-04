// フレネル反射(無偏光)とゴースト(2 回反射)追跡
import { add, scale, dot } from './vec.js';
import { refractiveIndex } from './glass.js';
import { surfaceZ, mediumAfter } from './system.js';
import { intersectSphere, surfaceNormal, refract, reflect, fanRays } from './trace.js';
import { radialMap, channelOf } from './imaging.js';

export function fresnel(n1, n2, cosI) {
  cosI = Math.min(1, Math.abs(cosI));
  const sinT = (n1 / n2) * Math.sqrt(1 - cosI * cosI);
  if (sinT >= 1) return { Rs: 1, Rp: 1, R: 1, T: 0 };
  const cosT = Math.sqrt(1 - sinT * sinT);
  const rs = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
  const rp = (n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI);
  const Rs = rs * rs, Rp = rp * rp, R = (Rs + Rp) / 2;
  return { Rs, Rp, R, T: 1 - R };
}

export const fresnelT = (n1, n2, cosI) => fresnel(n1, n2, cosI).T;

/** 反射可能な面(屈折面で前後の屈折率が異なるもの)の index */
export function reflectingSurfaces(sys, lambda) {
  const out = [];
  sys.surfaces.forEach((s, i) => {
    if (s.kind !== 'surface') return;
    const a = refractiveIndex(mediumAfter(sys, i - 1), lambda), b = refractiveIndex(s.material, lambda);
    if (Math.abs(a - b) > 1e-12) out.push(i);
  });
  return out;
}

/**
 * 面の列に沿って光線を進める。steps: [{i, act:'t'|'r'}]
 * 面 i の「前側」= 物体側。前進中は前側から、後退中は後側から入射する。
 */
function traceSteps(sys, ray, steps) {
  const S = sys.surfaces, z = surfaceZ(sys), L = ray.lambda;
  let p = ray.p, d = ray.d, I = ray.intensity ?? 1;
  const points = [p];
  for (const { i, act } of steps) {
    const s = S[i];
    const radius = s.kind === 'surface' ? s.radius : Infinity;
    const t = intersectSphere(p, d, z[i], radius);
    if (t === null || t < -1e-6) return { points, intensity: 0, alive: false };
    p = add(p, scale(d, t)); points.push(p);
    if (s.kind !== 'screen' && Math.hypot(p[0], p[1]) > s.diameter / 2) return { points, intensity: 0, alive: false };
    if (s.kind !== 'surface') continue;
    const forward = d[2] > 0;
    const nFront = refractiveIndex(mediumAfter(sys, i - 1), L), nBack = refractiveIndex(s.material, L);
    const [n1, n2] = forward ? [nFront, nBack] : [nBack, nFront];
    const N = surfaceNormal(p, z[i], radius);
    const cosI = Math.abs(dot(d, N));
    const F = fresnel(n1, n2, cosI);
    if (act === 'r') { d = reflect(d, N); I *= F.R; }
    else { const dn = refract(d, N, n1, n2); if (!dn) return { points, intensity: 0, alive: false }; d = dn; I *= F.T; }
  }
  return { points, intensity: I, alive: true, final: { p, d } };
}

/** 面 i で反射 → 面 j (<i) で反射 → スクリーン、の全ての 2 回反射経路 */
export function traceGhosts(sys, ray, minIntensity = 1e-6) {
  const refl = reflectingSurfaces(sys, ray.lambda);
  const last = sys.surfaces.length - 1;
  const out = [];
  for (const i of refl) for (const j of refl) {
    if (j >= i) continue;
    const steps = [];
    for (let k = 1; k < i; k++) steps.push({ i: k, act: 't' });
    steps.push({ i, act: 'r' });
    for (let k = i - 1; k > j; k--) steps.push({ i: k, act: 't' });
    steps.push({ i: j, act: 'r' });
    for (let k = j + 1; k <= last; k++) steps.push({ i: k, act: 't' });
    const r = traceSteps(sys, ray, steps);
    out.push({ surfaces: [i, j], points: r.points, intensity: r.intensity, alive: r.alive && r.intensity >= minIntensity });
  }
  return out;
}

/**
 * ゴースト像(結像画像と同じ照度スケール)。opts: {objectSamples=24, nPupil=6}
 * 返り値 Float32Array(P*P*3)
 */
export function ghostImage(sys, objectImg, opts = {}) {
  const P = sys.screen.pixels, w = sys.screen.width, pitch = w / P, h = sys.object.height;
  const ns = opts.objectSamples ?? 24, np = opts.nPupil ?? 6;
  const out = new Float32Array(P * P * 3);
  for (const lambda of sys.wavelengths) {
    const ch = channelOf(lambda);
    const map = radialMap(sys, lambda, 9);
    const E0 = map.exposure;
    const cellObj = (2 * h) / ns;
    const areaFactor = (cellObj * cellObj * map.m0 * map.m0) / (pitch * pitch);
    for (let sy = 0; sy < ns; sy++) for (let sx = 0; sx < ns; sx++) {
      // 物体輝度(セル平均を中心画素で近似)
      const u = Math.min(objectImg.size - 1, Math.floor(((sx + 0.5) / ns) * objectImg.size));
      const v = Math.min(objectImg.size - 1, Math.floor(((sy + 0.5) / ns) * objectImg.size));
      const Lum = objectImg.data[(v * objectImg.size + u) * 3 + ch];
      if (!(Lum > 0)) continue;
      const obj = [-h + (sx + 0.5) * cellObj, h - (sy + 0.5) * cellObj, 0];
      const rays = fanRays(sys, obj, lambda, np);
      const wRay = (E0 * Lum * areaFactor) / rays.length;
      for (const r of rays) for (const g of traceGhosts(sys, r)) {
        if (!g.alive) continue;
        const Q = g.points[g.points.length - 1];
        const ix = Math.floor((Q[0] + w / 2) / pitch), iy = Math.floor((w / 2 - Q[1]) / pitch);
        if (ix < 0 || iy < 0 || ix >= P || iy >= P) continue;
        out[(iy * P + ix) * 3 + ch] += wRay * g.intensity;
      }
    }
  }
  return out;
}
