// 子午面(y-z)断面図。光軸 +z を右向き、+y を上向きに描く。
import { surfaceZ } from '../core/system.js';
import { traceRay, meridionalFan, findStop } from '../core/trace.js';
import { traceGhosts } from '../core/fresnel.js';
import { systemPalette, materialKey } from './material-colors.js';

export const WL_COLOR = (l) => (l < 0.485 ? '#2f6bff' : l < 0.57 ? '#1fa64a' : '#e5372c');
const FIELDS = [0, 0.7, 1.0];

function sag(y, R) {
  if (!Number.isFinite(R)) return 0;
  const v = R * R - y * y;
  return v < 0 ? NaN : R - Math.sign(R) * Math.sqrt(v);
}
const cssVar = (n, fb) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;

/** 描画データ(DOM 非依存): 面形状と光線 */
export function layoutData(sys, { rays = 7, ghosts = false } = {}) {
  const z = surfaceZ(sys);
  const S = sys.surfaces;
  const shapes = S.map((s, i) => {
    const h = s.kind === 'screen' ? sys.screen.width / 2 : s.kind === 'object' ? sys.object.height : s.diameter / 2;
    const pts = [];
    const R = s.kind === 'surface' ? s.radius : Infinity;
    const hh = Number.isFinite(R) ? Math.min(h, Math.abs(R)) : h;
    for (let k = 0; k <= 40; k++) { const y = -hh + (2 * hh * k) / 40; pts.push([z[i] + sag(y, R), y]); }
    return { kind: s.kind, z: z[i], h: hh, pts, glassAfter: s.kind === 'surface' && s.material?.type !== 'air', matKey: s.kind === 'surface' ? materialKey(s.material) : null };
  });
  const out = [];
  const ghostPaths = [];
  const stop = findStop(sys);
  for (const f of FIELDS) {
    for (const l of sys.wavelengths) {
      for (const r of meridionalFan(sys, [0, f * sys.object.height, 0], l, rays)) {
        const t = traceRay(sys, r);
        out.push({ lambda: l, field: f, points: t.points, alive: t.alive, reason: t.reason });
        if (ghosts && f === 0 && l === sys.wavelengths[1]) {
          for (const g of traceGhosts(sys, r)) if (g.alive) ghostPaths.push({ points: g.points, intensity: g.intensity, surfaces: g.surfaces });
        }
      }
    }
  }
  return { shapes, rays: out, ghostPaths, stop, zMax: z[z.length - 1], palette: systemPalette(sys) };
}

export function createLayoutView(canvas) {
  let data = null, view = null, drag = null;
  const ctx = canvas.getContext('2d');

  function fit(lensOnly = false) {
    if (!data) return;
    const shapes = lensOnly ? data.shapes.slice(1) : data.shapes;
    const ys = shapes.map((s) => s.h);
    const yMax = Math.max(...ys, 1e-3) * 1.15;
    const z0 = lensOnly ? shapes[0].z : 0, z1 = data.zMax;
    const pad = (z1 - z0) * 0.04 || 1;
    const zMin = z0 - pad, zMax = z1 + pad;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const scale = Math.min(w / (zMax - zMin), h / (2 * yMax));
    view = { scale, cz: (zMin + zMax) / 2, cy: 0 };
  }
  const X = (z) => canvas.clientWidth / 2 + (z - view.cz) * view.scale;
  const Y = (y) => canvas.clientHeight / 2 - (y - view.cy) * view.scale;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!data) return;
    if (!view) fit();
    const fg = cssVar('--fg', '#222'), muted = cssVar('--muted', '#888'), glass = cssVar('--glass', 'rgba(120,170,230,0.25)');
    // 光軸
    ctx.strokeStyle = muted; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke(); ctx.setLineDash([]);
    // レンズ(ガラス部分を塗る)
    const S = data.shapes;
    for (let i = 0; i < S.length - 1; i++) {
      if (!S[i].glassAfter) continue;
      let j = i + 1; while (j < S.length && S[j].kind === 'iris') j++;
      if (j >= S.length) continue;
      const a = S[i].pts, b = S[j].pts;
      const col = data.palette?.get(S[i].matKey);
      ctx.fillStyle = col ? col.fill(0.38) : glass; ctx.beginPath();
      a.forEach(([z, y], k) => (k ? ctx.lineTo(X(z), Y(y)) : ctx.moveTo(X(z), Y(y))));
      [...b].reverse().forEach(([z, y]) => ctx.lineTo(X(z), Y(y)));
      ctx.closePath(); ctx.fill();
    }
    // 面
    let lastLabel = -Infinity;
    S.forEach((s, i) => {
      ctx.lineWidth = s.kind === 'screen' ? 2.5 : 1.5;
      ctx.strokeStyle = s.kind === 'object' ? muted : fg;
      if (s.kind === 'iris') {
        const ext = Math.max(2, s.h * 0.35);
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(X(s.z), Y(s.h)); ctx.lineTo(X(s.z), Y(s.h + ext));
        ctx.moveTo(X(s.z), Y(-s.h)); ctx.lineTo(X(s.z), Y(-s.h - ext)); ctx.stroke();
      } else if (s.kind === 'object') {
        // 物体: 矢印
        ctx.strokeStyle = fg; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(X(s.z), Y(0)); ctx.lineTo(X(s.z), Y(s.h)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(X(s.z) - 5, Y(s.h) + 8); ctx.lineTo(X(s.z), Y(s.h)); ctx.lineTo(X(s.z) + 5, Y(s.h) + 8); ctx.stroke();
      } else {
        ctx.beginPath();
        s.pts.forEach(([z, y], k) => { if (Number.isFinite(z)) (k ? ctx.lineTo(X(z), Y(y)) : ctx.moveTo(X(z), Y(y))); });
        ctx.stroke();
      }
      ctx.fillStyle = muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
      const lx = X(s.z);
      if (i === 0 || lx - lastLabel > 16) { // 重なる番号は省略(拡大すると表示)
        ctx.fillText(i === data.stop ? `${i} 絞り` : String(i), lx, Y(-s.h) + 14);
        lastLabel = lx + (i === data.stop ? 14 : 0);
      }
    });
    // 光線
    ctx.lineWidth = 1;
    for (const r of data.rays) {
      ctx.strokeStyle = WL_COLOR(r.lambda);
      ctx.globalAlpha = r.alive ? 0.85 : 0.35;
      ctx.beginPath();
      r.points.forEach(([, y, z], k) => (k ? ctx.lineTo(X(z), Y(y)) : ctx.moveTo(X(z), Y(y))));
      ctx.stroke();
      if (!r.alive && r.points.length) { // 遮蔽位置に × 印
        const [, y, z] = r.points[r.points.length - 1];
        ctx.beginPath(); ctx.moveTo(X(z) - 3, Y(y) - 3); ctx.lineTo(X(z) + 3, Y(y) + 3); ctx.moveTo(X(z) + 3, Y(y) - 3); ctx.lineTo(X(z) - 3, Y(y) + 3); ctx.stroke();
      }
    }
    ctx.globalAlpha = 0.6; ctx.strokeStyle = cssVar('--ghost', '#c77dff'); ctx.setLineDash([3, 3]);
    for (const g of data.ghostPaths) {
      ctx.beginPath(); g.points.forEach(([, y, z], k) => (k ? ctx.lineTo(X(z), Y(y)) : ctx.moveTo(X(z), Y(y)))); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // スケールバー
    const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const len = nice.find((v) => v * view.scale > 60) ?? 1000;
    ctx.strokeStyle = fg; ctx.fillStyle = fg; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(12, h - 14); ctx.lineTo(12 + len * view.scale, h - 14); ctx.stroke();
    ctx.textAlign = 'left'; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(`${len} mm`, 14, h - 20);
  }

  canvas.addEventListener('wheel', (e) => {
    if (!view) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const z0 = view.cz + (mx - canvas.clientWidth / 2) / view.scale, y0 = view.cy - (my - canvas.clientHeight / 2) / view.scale;
    const f = Math.exp(-e.deltaY * 0.0015);
    view.scale *= f;
    view.cz = z0 - (mx - canvas.clientWidth / 2) / view.scale;
    view.cy = y0 + (my - canvas.clientHeight / 2) / view.scale;
    draw();
  }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cz: view?.cz, cy: view?.cy }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !view) return;
    view.cz = drag.cz - (e.clientX - drag.x) / view.scale; view.cy = drag.cy + (e.clientY - drag.y) / view.scale; draw();
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('dblclick', () => { fit(); draw(); });
  new ResizeObserver(() => draw()).observe(canvas);

  return {
    update(d, refit = false) { data = d; if (refit || !view) fit(); draw(); },
    fit(lensOnly = false) { fit(lensOnly); draw(); },
    redraw: draw,
  };
}
