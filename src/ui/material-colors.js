// 材料ごとの表示色(断面図・レンズデータの表・外観の部品で共通)
// プリセットガラスは青系から、nd・νd 指定の媒質はオレンジ系から順に割り当てる。同じ材料は同じ色。
const GLASS = [[110, 165, 230], [70, 190, 175], [150, 130, 230], [80, 140, 200], [120, 200, 120], [190, 120, 200]];
const CUSTOM = [[230, 160, 40], [215, 110, 80], [200, 170, 90], [230, 120, 160], [170, 130, 70], [240, 200, 60]];

export function materialKey(m) {
  if (!m || m.type === 'air') return null;
  if (m.type === 'preset') return `preset:${m.name}`;
  if (m.type === 'model') return `model:${+m.nd}/${+m.vd}`;
  if (m.type === 'opaque') return `opaque:${m.kind}`;
  return null;
}
export function materialName(m) {
  if (m.type === 'preset') return m.name;
  if (m.type === 'model') return `nd ${m.nd} / νd ${m.vd}`;
  return m.kind;
}

/** 材料の配列(出現順)から {key → {rgb, fill(alpha), solid}} を作る */
export function materialPalette(materials) {
  const map = new Map();
  let g = 0, c = 0;
  for (const m of materials) {
    const key = materialKey(m);
    if (!key || map.has(key) || m.type === 'opaque') continue;
    const rgb = m.type === 'preset' ? GLASS[g++ % GLASS.length] : CUSTOM[c++ % CUSTOM.length];
    map.set(key, { rgb, name: materialName(m), fill: (a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`, solid: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` });
  }
  return map;
}

/** レンズデータ(逐次系)の面の材料の出現順パレット */
export function systemPalette(sys) {
  return materialPalette(sys.surfaces.filter((s) => s.kind === 'surface' || s.kind === 'object').map((s) => s.material));
}
