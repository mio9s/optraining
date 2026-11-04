// 物体/結像画像の表示と画像読込
// 内部の画像は線形 RGB(0..1)。読込時に sRGB → 線形、表示時に線形 → sRGB へ変換する。

export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * ImageData 風 {data: Uint8ClampedArray RGBA, width, height} を、アスペクト比を保って
 * 一辺 max 以下の正方形(余白は黒)に縮小し、線形 RGB の Float32Array にする。
 * 縮小は面積平均(ボックスフィルタ)。
 */
export function downscaleImage(img, max = 512) {
  const { width: W, height: H, data } = img;
  const scale = Math.min(1, max / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const size = Math.max(w, h);
  const out = new Float32Array(size * size * 3);
  const ox = Math.floor((size - w) / 2), oy = Math.floor((size - h) / 2);
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  const acc = new Float64Array(w * h * 4);
  for (let y = 0; y < H; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / H));
    for (let x = 0; x < W; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / W));
      const k = (y * W + x) * 4, a = (ty * w + tx) * 4;
      const alpha = data[k + 3] / 255;
      acc[a] += lut[data[k]] * alpha; acc[a + 1] += lut[data[k + 1]] * alpha; acc[a + 2] += lut[data[k + 2]] * alpha; acc[a + 3]++;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (y * w + x) * 4, n = acc[a + 3] || 1, o = ((y + oy) * size + x + ox) * 3;
    out[o] = acc[a] / n; out[o + 1] = acc[a + 1] / n; out[o + 2] = acc[a + 2] / n;
  }
  return { data: out, size, sourceWidth: W, sourceHeight: H };
}

/** 線形 RGB 画像を canvas に描画(sRGB へ変換)。gain 倍してから 0..1 にクリップ */
export function drawLinearImage(canvas, rgb, size, gain = 1) {
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, rgb[i * 3 + c] * gain));
      id.data[i * 4 + c] = Math.round(linearToSrgb(v) * 255);
    }
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

/** ファイル → {data, size}(DOM 必須) */
export function loadImageFile(file, max = 512) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('画像ファイル(PNG / JPEG など)を選んでください')); return; }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      // 大きな画像はまずブラウザで max の 2 倍程度に縮小してから面積平均(UI を固めない)
      const pre = Math.min(1, (2 * max) / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.naturalWidth * pre)); c.height = Math.max(1, Math.round(im.naturalHeight * pre));
      const ctx = c.getContext('2d');
      ctx.drawImage(im, 0, 0, c.width, c.height);
      const r = downscaleImage(ctx.getImageData(0, 0, c.width, c.height), max);
      r.sourceWidth = im.naturalWidth; r.sourceHeight = im.naturalHeight;
      URL.revokeObjectURL(url);
      resolve(r);
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    im.src = url;
  });
}
