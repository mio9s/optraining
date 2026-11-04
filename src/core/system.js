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

/** サンプル系 */
export const SAMPLE_SYSTEMS = {
  achromat: { label: 'アクロマート(BK7 + SF5、既定)', make: () => defaultSystem() },
  bk7: {
    label: 'BK7 平凸単レンズ(f = 100 mm)',
    make: () => {
      const air = { type: 'air' };
      return {
        surfaces: [
          { kind: 'object', radius: Infinity, thickness: 1000, material: air, diameter: 30 },
          { kind: 'iris', radius: Infinity, thickness: 0, material: air, diameter: 20 },
          { kind: 'surface', radius: 51.68, thickness: 4, material: { type: 'preset', name: 'N-BK7' }, diameter: 25 },
          { kind: 'surface', radius: Infinity, thickness: 107.683, material: air, diameter: 25 },
          { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 20 },
        ],
        object: { height: 30 }, screen: { width: 8, pixels: 256 }, wavelengths: [...WAVELENGTHS],
      };
    },
  },
  adlens: {
    label: '流体充填可変焦点レンズ(特許 6831374 の実施形態を基にした推定構成)',
    make: () => {
      // 特許第 6831374 号 段落 0069〜0084 の層構成(前から): TPU 膜 220 µm / フェニル系シリコーン油 / TPU 受け部後壁 50 µm /
      // 粘着剤 (3M 8211) 25 µm / 後部レンズ(前面平面・後面凹)。
      // 特許に無い値は推定: 曲率・流体厚・後部レンズ材質(PC と仮定)・各材料のアッベ数。膜は +3.0 D に膨らませた読書状態。
      const air = { type: 'air' };
      const tpu = { type: 'model', nd: 1.505, vd: 50 }, oil = { type: 'model', nd: 1.579, vd: 30 };
      const psa = { type: 'model', nd: 1.474, vd: 55 }, pc = { type: 'model', nd: 1.586, vd: 30 };
      const R1 = (oil.nd - 1) / 3.0 * 1000; // 膜+流体の屈折力 +3.0 D
      const R7 = (pc.nd - 1) / 0.5 * 1000; // 後部レンズ後面 −0.5 D
      return {
        surfaces: [
          { kind: 'object', radius: Infinity, thickness: 1000, material: air, diameter: 200 },
          { kind: 'surface', radius: +R1.toFixed(3), thickness: 0.22, material: tpu, diameter: 40 },
          { kind: 'surface', radius: +(R1 - 0.22).toFixed(3), thickness: 2.0, material: oil, diameter: 40 },
          { kind: 'surface', radius: Infinity, thickness: 0.05, material: tpu, diameter: 40 },
          { kind: 'surface', radius: Infinity, thickness: 0.025, material: psa, diameter: 40 },
          { kind: 'surface', radius: Infinity, thickness: 1.8, material: pc, diameter: 40 },
          { kind: 'surface', radius: +R7.toFixed(3), thickness: 666, material: air, diameter: 40 },
          { kind: 'screen', radius: Infinity, thickness: 0, material: air, diameter: 120 },
        ],
        object: { height: 60 }, screen: { width: 90, pixels: 256 }, wavelengths: [...WAVELENGTHS],
      };
    },
  },
  nodisp: {
    label: '無分散ガラス単レンズ(色収差 0 の確認用)',
    make: () => {
      const s = SAMPLE_SYSTEMS.bk7.make();
      s.surfaces[2].material = { type: 'model', nd: 1.5168, vd: 1e12 };
      s.surfaces[3].thickness = 108.474; // 近軸像面(n = nd 一定)
      return s;
    },
  },
};
