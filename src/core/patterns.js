// 内蔵物体パターン(RGB 0..1、行 0 が上 = +y)
export const PATTERN_NAMES = { arrow: '矢印', letterF: '文字 F', chart: '解像力チャート', grid: '格子', points: '点光源列', color: 'カラーバー' };

export function makePattern(name, size = 256) {
  const data = new Float32Array(size * size * 3);
  const set = (x, y, r, g = r, b = r) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const k = (y * size + x) * 3; data[k] = r; data[k + 1] = g; data[k + 2] = b;
  };
  const rect = (x0, y0, x1, y1, ...c) => {
    for (let y = Math.round(y0 * size); y < Math.round(y1 * size); y++)
      for (let x = Math.round(x0 * size); x < Math.round(x1 * size); x++) set(x, y, ...(c.length ? c : [1]));
  };
  if (name === 'arrow') {
    rect(0.45, 0.35, 0.55, 0.85);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / size - 0.5, v = y / size;
      if (v >= 0.12 && v < 0.38 && Math.abs(u) < (v - 0.12) * 0.85) set(x, y, 1);
    }
    rect(0.62, 0.6, 0.78, 0.68); // 左右判別用の横棒(右側)
  } else if (name === 'letterF') {
    rect(0.3, 0.15, 0.42, 0.85); rect(0.3, 0.15, 0.72, 0.27); rect(0.3, 0.45, 0.62, 0.56);
  } else if (name === 'chart') {
    // 線幅が段階的に細くなる縦横 3 本線の組
    const groups = [0.06, 0.04, 0.026, 0.017, 0.011, 0.007];
    groups.forEach((w, i) => {
      const x0 = 0.06 + (i % 3) * 0.31, y0 = 0.08 + Math.floor(i / 3) * 0.46;
      for (let k = 0; k < 3; k++) rect(x0 + 2 * k * w, y0, x0 + (2 * k + 1) * w, y0 + 0.17);
      for (let k = 0; k < 3; k++) rect(x0, y0 + 0.2 + 2 * k * w, x0 + 0.17, y0 + 0.2 + (2 * k + 1) * w);
    });
  } else if (name === 'grid') {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const g = size / 8;
      if (x % g < Math.max(1, size / 128) || y % g < Math.max(1, size / 128) || x === size - 1 || y === size - 1) set(x, y, 1);
    }
  } else if (name === 'points') {
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) set(Math.round(((i + 0.5) / 5) * size), Math.round(((j + 0.5) / 5) * size), 1);
  } else if (name === 'color') {
    const cols = [[1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1]];
    cols.forEach((c, i) => rect(0.05 + i * 0.13, 0.2, 0.05 + i * 0.13 + 0.1, 0.8, ...c));
  } else throw new Error(`unknown pattern ${name}`);
  return { data, size };
}
