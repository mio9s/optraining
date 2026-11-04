// 近軸解析(y-nu 法)と色収差
import { ynuTrace } from './ynu.js';
import { surfaceZ } from './system.js';
import { aimRay, traceRay, findStop } from './trace.js';

function lastPowerSurface(sys) {
  for (let i = sys.surfaces.length - 2; i >= 1; i--) if (sys.surfaces[i].kind === 'surface') return i;
  return sys.surfaces.length - 2;
}

/** 近軸諸量: efl, bfl(最終レンズ面から), imageZ(物体面 z=0 基準の像位置), magnification */
export function paraxialTrace(sys, lambda) {
  const z = surfaceZ(sys);
  const k = lastPowerSurface(sys);
  // 平行光(物体面上 y=1, u=0)。像空間が空気なので f' = -y1/u'
  const inf = ynuTrace(sys, lambda, 1, 0);
  const y1 = inf.y[1];
  const bfl = -inf.y[k] / inf.u[k];
  // 軸上物点からのマージナル光線
  const u0 = 1e-3;
  const mar = ynuTrace(sys, lambda, 0, u0);
  const imageZ = z[k] + -mar.y[k] / mar.u[k];
  const magnification = (mar.n[0] * u0) / (mar.n[k] * mar.u[k]);
  return { efl: -(inf.n[k] * y1) / (inf.n[k] * inf.u[k]), bfl, imageZ, magnification, imageIndex: inf.n[k] };
}

/** 主光線(実光線)のスクリーン上の像高 */
export function chiefRayHeight(sys, objHeight, lambda) {
  const r = aimRay(sys, [0, objHeight, 0], lambda, 0, 0, findStop(sys, lambda));
  const t = traceRay(sys, r, { ignoreApertures: true });
  if (!t.alive) return NaN;
  return t.points[t.points.length - 1][1];
}

/** 色収差: 縦(近軸像位置の差)・倍率(最大物体高の実主光線像高の差、スクリーン面上) */
export function chromatic(sys) {
  const W = [...sys.wavelengths].sort((a, b) => a - b);
  const longitudinal = {}, chiefHeights = {};
  for (const l of W) {
    longitudinal[l] = paraxialTrace(sys, l).imageZ;
    chiefHeights[l] = sys.object.height === 0 ? 0 : chiefRayHeight(sys, sys.object.height, l);
  }
  const lo = W[0], hi = W[W.length - 1];
  return {
    longitudinal,
    chiefHeights,
    axialColor: longitudinal[lo] - longitudinal[hi],
    lateralColor: chiefHeights[lo] - chiefHeights[hi],
  };
}

/** スクリーンを近軸像面(波長 lambda)へ移動した系を返す */
export function focusScreen(sys, lambda) {
  const s = structuredClone(sys);
  const r = paraxialTrace(s, lambda);
  const z = surfaceZ(s);
  const k = s.surfaces.length - 2;
  const t = r.imageZ - z[k];
  if (Number.isFinite(t) && t >= 0) s.surfaces[k].thickness = Math.round(t * 1e4) / 1e4;
  return s;
}
