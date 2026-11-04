// 近軸 y-nu 追跡(低レベル)。trace.js と paraxial.js の双方から使う。
import { refractiveIndex } from './glass.js';
import { mediumAfter } from './system.js';

/** 面 i の前後の屈折率 [n_before, n_after] */
export function indicesAt(sys, i, lambda) {
  const nb = refractiveIndex(mediumAfter(sys, i - 1), lambda);
  const s = sys.surfaces[i];
  const na = s.kind === 'surface' ? refractiveIndex(s.material, lambda) : nb;
  return [nb, na];
}

/**
 * 近軸光線 (y0, u0) を物体面 z=0 から追跡。返り値: 各面の高さ y[i] と、面 i 直後の角度 u[i]、屈折率 n[i](面 i 直後)。
 * from 面から開始することも可能(y0 は面 from 上の高さ、u0 は from 直後の角度)。
 */
export function ynuTrace(sys, lambda, y0, u0, from = 0) {
  const S = sys.surfaces;
  const y = new Array(S.length).fill(NaN), u = new Array(S.length).fill(NaN), n = new Array(S.length).fill(NaN);
  y[from] = y0; u[from] = u0;
  n[from] = refractiveIndex(mediumAfter(sys, from), lambda);
  for (let i = from + 1; i < S.length; i++) {
    y[i] = y[i - 1] + S[i - 1].thickness * u[i - 1];
    const [nb, na] = indicesAt(sys, i, lambda);
    const c = S[i].kind === 'surface' && Number.isFinite(S[i].radius) ? 1 / S[i].radius : 0;
    u[i] = (nb * u[i - 1] - y[i] * (na - nb) * c) / na;
    n[i] = na;
  }
  return { y, u, n };
}
