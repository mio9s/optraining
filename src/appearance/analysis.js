// 外観の数値解析: 反射率曲線、輝度断面、境界コントラストと判定
import { thinFilm } from './thinfilm.js';

/** 入射角 0..89° の反射率(指定波長) → {angles, Rs, Rp, R} */
export function reflectanceVsAngle(n0, layers, ns, lambdaUm, step = 1) {
  const angles = [], Rs = [], Rp = [], R = [];
  for (let a = 0; a <= 89; a += step) {
    const r = thinFilm(n0, layers, ns, Math.cos((a * Math.PI) / 180), lambdaUm);
    angles.push(a); Rs.push(r.Rs); Rp.push(r.Rp); R.push(r.R);
  }
  return { angles, Rs, Rp, R };
}
/** 波長 400..700 nm の反射率(指定入射角) */
export function reflectanceVsWavelength(n0Fn, layers, nsFn, angleDeg, step = 5) {
  const nm = [], R = [];
  for (let l = 400; l <= 700; l += step) {
    nm.push(l);
    R.push(thinFilm(n0Fn(l / 1000), layers, nsFn(l / 1000), Math.cos((angleDeg * Math.PI) / 180), l / 1000).R);
  }
  return { nm, R };
}

/** 画像(輝度 Y, w×h)上の線分 p0→p1(画素座標)に沿った双線形サンプル */
export function lineProfile(Y, w, h, p0, p1, n) {
  const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  n = n ?? Math.max(2, Math.ceil(L) + 1);
  const at = (x, y) => {
    x = Math.max(0, Math.min(w - 1, x - 0.5)); y = Math.max(0, Math.min(h - 1, y - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), ax = x - x0, ay = y - y0;
    return (1 - ay) * ((1 - ax) * Y[y0 * w + x0] + ax * Y[y0 * w + x1]) + ay * ((1 - ax) * Y[y1 * w + x0] + ax * Y[y1 * w + x1]);
  };
  const values = [], dist = [];
  for (let i = 0; i < n; i++) { const t = i / (n - 1); values.push(at(p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1]))); dist.push(t * L); }
  return { values, dist };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * 境界のウェーバーコントラスト: 背景 = 断面の中央値、境界 = 背景から最も外れた点(両端の 10 % は除く)。
 * C = (L_境界 − L_背景) / L_背景。判定は |C| ≥ threshold(既定 2 %)で「見える」
 */
export function boundaryContrast(raw, threshold = 0.02) {
  // 3 点移動平均で画素ノイズを抑える(境界は数画素の幅を持つ)
  const values = raw.map((v, i) => (raw[Math.max(0, i - 1)] + v + raw[Math.min(raw.length - 1, i + 1)]) / 3);
  const n = values.length, lo = Math.floor(n * 0.1), hi = Math.ceil(n * 0.9);
  const bg = median(values);
  let k = lo, dev = 0;
  for (let i = lo; i < hi; i++) { const v = Math.abs(values[i] - bg); if (v > dev) { dev = v; k = i; } }
  const C = bg > 1e-9 ? (values[k] - bg) / bg : values[k] > 1e-9 ? Infinity : 0;
  // ノイズ: 隣り合う生の値の差の中央値から推定した標準偏差(平滑化後)
  const diffs = []; for (let i = 1; i < raw.length; i++) diffs.push(Math.abs(raw[i] - raw[i - 1]));
  const sigma = diffs.length ? (1.4826 * median(diffs)) / Math.SQRT2 / Math.sqrt(3) : 0;
  const noise = bg > 1e-9 ? sigma / bg : 0;
  const aboveNoise = dev > 4 * sigma;
  const exceeds = Math.abs(C) >= threshold;
  const verdict = exceeds && aboveNoise ? 'visible' : exceeds ? 'uncertain' : 'invisible';
  return { background: bg, peak: values[k], index: k, contrast: C, noise, visible: verdict === 'visible', verdict, threshold };
}

/** 寄与(Y の和)を割合の表に。names: key → 表示名 */
export function contributionTable(contrib, totalY, names = {}) {
  const rows = Object.entries(contrib).filter(([, v]) => v > 0).map(([key, v]) => ({ key, name: names[key] ?? key, fraction: v / (totalY || 1) }));
  rows.sort((a, b) => b.fraction - a.fraction);
  return rows;
}
