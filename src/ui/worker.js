// 重い計算(結像・ゴースト・迷光)を UI スレッド外で行う
import { formImage } from '../core/imaging.js';
import { ghostImage } from '../core/fresnel.js';
import { strayLight } from '../core/stray.js';

export function computeAll(msg, progress) {
  const { sys, objectImg, scatterCfg, settings } = msg;
  const t0 = Date.now();
  const direct = formImage(sys, objectImg, {
    fieldGrid: settings.fieldGrid, nPupil: settings.nPupil, fresnel: settings.fresnel,
    onProgress: (p) => progress(0.6 * p, '直接光(PSF 畳み込み)'),
  });
  let ghost = null, stray = null;
  if (settings.ghost) { progress(0.62, 'ゴースト'); ghost = ghostImage(sys, objectImg, { objectSamples: 24, nPupil: 6 }); }
  if (settings.stray) { progress(0.8, '散乱・ラマン(モンテカルロ)'); stray = strayLight(sys, objectImg, scatterCfg, { rays: settings.rays, seed: 1 }); }
  progress(1, '完了');
  return {
    direct: direct.data, P: direct.P, peak: direct.peak, message: direct.message,
    psfModes: direct.psfs.map((p) => ({ lambda: p.lambda, mode: p.psf?.mode ?? 'none', rms: p.rmsWaves })),
    ghost, stray: stray && { image: stray.image, raman: stray.raman, budget: stray.budget, backscatterBy: stray.backscatterBy },
    ms: Date.now() - t0,
  };
}

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    try {
      const r = computeAll(e.data, (p, label) => self.postMessage({ type: 'progress', p, label, id: e.data.id }));
      self.postMessage({ type: 'done', id: e.data.id, result: r });
    } catch (err) {
      self.postMessage({ type: 'error', id: e.data.id, message: String(err?.message ?? err) });
    }
  };
}
