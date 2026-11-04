// 外観描画 Worker: シーンを受け取り、タイルを描画して返す
import { prepareScene, renderTile } from './render.js';

let cache = null;
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'scene') {
      cache = prepareScene(m.parts);
      self.postMessage({ type: 'ready', id: m.id, center: cache.center, size: cache.size });
    } else if (m.type === 'tile') {
      const r = renderTile(cache, m.job);
      self.postMessage({ type: 'tile', id: m.id, job: m.job, rgb: r.rgb, y: r.y, contrib: r.contrib }, [r.rgb.buffer, r.y.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err?.message ?? err) });
  }
};
