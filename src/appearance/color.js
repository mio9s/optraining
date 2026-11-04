// スペクトル → 色。CIE 1931 2° 等色関数は Wyman, Sloan, Shirley (2013) の多峰ガウス近似(誤差 ~1 %)。
// 照明はすべて等エネルギー(平坦スペクトル)とみなし、等エネルギー白が sRGB の中性灰になるよう白色補正する。

const g = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
/** λ: nm → [x̄, ȳ, z̄] */
export function cmf(nm) {
  const x = 1.056 * g(nm, 599.8, 37.9, 31.0) + 0.362 * g(nm, 442.0, 16.0, 26.7) - 0.065 * g(nm, 501.1, 20.4, 26.2);
  const y = 0.821 * g(nm, 568.8, 46.9, 40.5) + 0.286 * g(nm, 530.9, 16.3, 31.1);
  const z = 1.217 * g(nm, 437.0, 11.8, 36.0) + 0.681 * g(nm, 459.0, 26.0, 13.8);
  return [x, y, z];
}

export const LAMBDA_MIN = 400, LAMBDA_MAX = 700;

// XYZ → 線形 sRGB(D65)
const M = [[3.2404542, -1.5371385, -0.4985314], [-0.969266, 1.8760108, 0.041556], [0.0556434, -0.2040259, 1.0572252]];
const xyz2rgb = ([X, Y, Z]) => M.map((r) => r[0] * X + r[1] * Y + r[2] * Z);

// 等エネルギー白の XYZ(400〜700 nm の平均)と白色補正係数
const WHITE = (() => {
  const s = [0, 0, 0]; const N = 300;
  for (let i = 0; i < N; i++) { const c = cmf(LAMBDA_MIN + ((i + 0.5) * (LAMBDA_MAX - LAMBDA_MIN)) / N); s[0] += c[0] / N; s[1] += c[1] / N; s[2] += c[2] / N; }
  return s;
})();
const WB = xyz2rgb(WHITE).map((v) => 1 / v);
export const WHITE_Y = WHITE[1];

/**
 * 波長 nm のサンプルに重み w を与えたときの線形 RGB の寄与(平坦スペクトル w=1 を
 * 区間全体で平均すると (1,1,1))。
 */
export function spectralToRGB(nm, w = 1) {
  const c = cmf(nm);
  const rgb = xyz2rgb(c);
  return [rgb[0] * WB[0] * w, rgb[1] * WB[1] * w, rgb[2] * WB[2] * w];
}
/** 輝度(白 = 1 に規格化) */
export function spectralToY(nm, w = 1) { return (cmf(nm)[1] / WHITE_Y) * w; }

/** 線形 RGB の輝度 Y(白色補正後の基準で白 = 1) */
export function luminance(r, g2, b) {
  // 白色補正した RGB 空間での輝度係数 = sRGB の Y 行 / WB
  return (0.2126729 * r) / WB[0] / WHITE_Y + (0.7151522 * g2) / WB[1] / WHITE_Y + (0.072175 * b) / WB[2] / WHITE_Y;
}

export const linearToSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** 層化した波長サンプル k / n(0 ≤ k < n)と乱数 u → nm */
export const sampleLambda = (k, n, u) => LAMBDA_MIN + ((k + u) / n) * (LAMBDA_MAX - LAMBDA_MIN);
