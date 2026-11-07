// テスト用: 直方体と回転体メッシュを作り、STL(バイナリ/ASCII)にする
import { tessellate } from '../../src/appearance/profile.js';

export function boxTris(x0, x1, y0, y1, z0, z1) {
  const p = (x, y, z) => [x, y, z];
  const c = [p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0), p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)];
  // 外向きの巻き方向
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  const out = [];
  for (const [a, b, cc, d] of q) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
  return Float32Array.from(out);
}
/** 断面(profile)を光軸まわりに n 分割で回転させたメッシュ */
export function revolveTris(profile, n = 96) {
  const out = [];
  for (const e of tessellate(profile)) {
    if (e.onAxis) continue;
    for (let k = 0; k < n; k++) {
      const a0 = (2 * Math.PI * k) / n, a1 = (2 * Math.PI * (k + 1)) / n;
      const P = (pt, a) => [pt[0] * Math.cos(a), pt[0] * Math.sin(a), pt[1]];
      const A = P(e.a, a0), B = P(e.b, a0), C = P(e.b, a1), D = P(e.a, a1);
      if (e.a[0] > 1e-12) out.push(...A, ...B, ...C); else out.push(...A, ...B, ...C);
      if (e.b[0] > 1e-12 && e.a[0] > 1e-12) out.push(...A, ...C, ...D);
      else if (e.a[0] > 1e-12) out.push(...A, ...C, ...D);
    }
  }
  return Float32Array.from(out);
}
export function toBinarySTL(tris) {
  const n = tris.length / 9, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + i * 50 + 12 + k * 4, tris[i * 9 + k], true);
  return buf;
}
export function toAsciiSTL(solids) {
  let s = '';
  for (const [name, tris] of solids) {
    s += `solid ${name}\n`;
    for (let i = 0; i < tris.length; i += 9) {
      s += ' facet normal 0 0 0\n  outer loop\n';
      for (let k = 0; k < 9; k += 3) s += `   vertex ${tris[i + k]} ${tris[i + k + 1]} ${tris[i + k + 2]}\n`;
      s += '  endloop\n endfacet\n';
    }
    s += `endsolid ${name}\n`;
  }
  return new TextEncoder().encode(s).buffer;
}
