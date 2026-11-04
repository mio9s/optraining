// レンズ系モデル
// Surface: {kind:'object'|'surface'|'iris'|'screen', radius, thickness, material, diameter}
//   material は「この面の後ろ側の媒質」。iris は直前の媒質を引き継ぐ(material は無視)。
//   曲率半径: 曲率中心が面の +z 側なら正。Infinity = 平面。厚み = 次面までの z 距離。
// System: {surfaces, object:{height /*最大物体高(半高) mm*/}, screen:{width /*mm*/, pixels}, wavelengths}
import { WAVELENGTHS } from './glass.js';

const KINDS = ['object', 'surface', 'iris', 'screen'];
const bad = (v) => typeof v !== 'number' || Number.isNaN(v);

export function validateSystem(sys) {
  const errors = [];
  const err = (row, field, message) => errors.push({ row, field, message });
  const S = sys?.surfaces ?? [];
  if (S.length < 2) err(0, 'kind', '物体面とスクリーンが必要です');
  if (S[0] && S[0].kind !== 'object') err(0, 'kind', '最初の行は物体面にしてください');
  if (S.length && S[S.length - 1].kind !== 'screen') err(S.length - 1, 'kind', '最後の行はスクリーンにしてください');
  S.forEach((s, i) => {
    if (!KINDS.includes(s.kind)) err(i, 'kind', '面種別が不正です');
    if ((s.kind === 'object' && i !== 0) || (s.kind === 'screen' && i !== S.length - 1))
      err(i, 'kind', '物体面は先頭、スクリーンは末尾のみです');
    if (bad(s.radius)) err(i, 'radius', '曲率半径が空欄または数値ではありません');
    else if (s.radius === 0) err(i, 'radius', '曲率半径 0 は不可です(平面は inf)');
    if (bad(s.thickness) || !Number.isFinite(s.thickness)) err(i, 'thickness', '厚みが空欄または数値ではありません');
    else if (s.thickness < 0) err(i, 'thickness', '厚みは 0 以上にしてください');
    if (bad(s.diameter) || !Number.isFinite(s.diameter)) err(i, 'diameter', '直径が空欄または数値ではありません');
    else if (s.diameter <= 0) err(i, 'diameter', '直径は正の値にしてください');
    if (s.kind === 'surface' || s.kind === 'object') {
      const m = s.material;
      if (!m || !['air', 'model', 'preset'].includes(m.type)) err(i, 'material', '材質が不正です');
      else if (m.type === 'model' && (bad(m.nd) || bad(m.vd) || m.nd < 1 || m.vd <= 0))
        err(i, 'material', 'nd ≥ 1, vd > 0 を入力してください');
    }
  });
  if (bad(sys?.object?.height) || sys.object.height < 0) err(0, 'objectHeight', '物体高が不正です');
  if (bad(sys?.screen?.width) || sys.screen.width <= 0) err(S.length - 1, 'screenWidth', 'スクリーン幅が不正です');
  const px = sys?.screen?.pixels;
  if (!Number.isInteger(px) || px < 8 || px > 1024) err(S.length - 1, 'screenPixels', '画素数は 8〜1024 の整数');
  return { ok: errors.length === 0, errors };
}

export function surfaceZ(sys) {
  const z = [0];
  for (let i = 1; i < sys.surfaces.length; i++) z.push(z[i - 1] + sys.surfaces[i - 1].thickness);
  return z;
}

/** 面 i の後ろ側の媒質 */
export function mediumAfter(sys, i) {
  for (let k = i; k >= 0; k--) {
    const s = sys.surfaces[k];
    if (s.kind === 'surface' || s.kind === 'object') return s.material;
  }
  return { type: 'air' };
}

export function cloneSystem(sys) {
  return structuredClone(sys);
}

export function defaultSystem() {
  const air = { type: 'air' };
  return {
    surfaces: [
      { kind: 'object', radius: Infinity, thickness: 200, material: air, diameter: 20 },
      { kind: 'iris', radius: Infinity, thickness: 3, material: air, diameter: 12 },
      { kind: 'surface', radius: 25.75, thickness: 5, material: { type: 'preset', name: 'N-BK7' }, diameter: 20 },
      { kind: 'surface', radius: -25.75, thickness: 0.5, material: air, diameter: 20 },
      { kind: 'surface', radius: -25.75, thickness: 2, material: { type: 'preset', name: 'N-SF5' }, diameter: 20 },
      { kind: 'surface', radius: -128.54, thickness: DEFAULT_BACK, material: air, diameter: 20 },
      { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 20 },
    ],
    object: { height: 10 },
    screen: { width: 6, pixels: 256 },
    wavelengths: [...WAVELENGTHS],
  };
}
// 既定系: 薄肉色消し条件で設計した BK7/SF5 アクロマート(f≈51 mm, 0.45/0.62 µm で縦色収差を相殺)。
// 後側距離は paraxialTrace(0.52 µm) の近軸像位置。
const DEFAULT_BACK = 62.80;
