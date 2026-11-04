// 屈折率・分散計算
import { GLASS } from './glass-data.js';

export const WAVELENGTHS = [0.45, 0.52, 0.62]; // µm
export const LINES = { F: 0.4861327, d: 0.5875618, C: 0.6562725 }; // µm

function sellmeier(g, l) {
  const l2 = l * l;
  let s = 1;
  for (let i = 0; i < g.B.length; i++) s += (g.B[i] * l2) / (l2 - g.C[i]);
  return Math.sqrt(s);
}

// モデルガラス: 2 項コーシー式 n(λ) = A + B/λ²(nd と vd を厳密に再現)
function cauchy(nd, vd, l) {
  const B = (nd - 1) / vd / (1 / LINES.F ** 2 - 1 / LINES.C ** 2);
  const A = nd - B / LINES.d ** 2;
  return A + B / (l * l);
}

export function refractiveIndex(material, lambdaUm) {
  if (!material || material.type === 'air') return 1;
  if (material.type === 'model') return cauchy(material.nd, material.vd, lambdaUm);
  if (material.type === 'preset') {
    const g = GLASS[material.name];
    if (!g) throw new Error(`unknown glass: ${material.name}`);
    return sellmeier(g, lambdaUm);
  }
  throw new Error(`unknown material type: ${material.type}`);
}

export function abbeFromPreset(name) {
  const n = (l) => refractiveIndex({ type: 'preset', name }, l);
  const nd = n(LINES.d);
  return { nd, vd: (nd - 1) / (n(LINES.F) - n(LINES.C)) };
}

export function listPresets() {
  return Object.keys(GLASS).map((name) => ({ name, ...abbeFromPreset(name) }));
}

export function materialLabel(m) {
  if (!m || m.type === 'air') return '空気';
  if (m.type === 'preset') return m.name;
  return `n=${m.nd}, ν=${m.vd}`;
}
