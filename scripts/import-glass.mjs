// refractiveindex.info-database (CC0) から Sellmeier 係数を取り込み src/core/glass-data.js を生成する。
// 使い方: node scripts/import-glass.mjs
import { writeFileSync } from 'node:fs';

const SHA = 'c5c2f188e848453def5970e347399d653df2ffc2';
const BASE = `https://raw.githubusercontent.com/polyanskiy/refractiveindex.info-database/${SHA}/database/data/`;
const SOURCES = {
  'N-BK7': 'specs/schott/optical/N-BK7.yml',
  'N-SF11': 'specs/schott/optical/N-SF11.yml',
  'N-SF5': 'specs/schott/optical/N-SF5.yml',
  'N-SK16': 'specs/schott/optical/N-SK16.yml',
  'N-F2': 'specs/schott/optical/N-F2.yml',
  'N-LAK9': 'specs/schott/optical/N-LAK9.yml',
  'N-BAF10': 'specs/schott/optical/N-BAF10.yml',
  'Fused Silica': 'main/SiO2/nk/Malitson.yml',
};

function parse(yaml) {
  const type = yaml.match(/type:\s*formula\s*(\d+)/);
  const coef = yaml.match(/coefficients:\s*([^\n]+)/);
  if (!type || !coef) throw new Error('formula not found');
  const v = coef[1].trim().split(/\s+/).map(Number);
  const B = [], C = [];
  for (let i = 1; i + 1 < v.length; i += 2) {
    B.push(v[i]);
    // formula 1: λ²/(λ² − C²) (C は µm) / formula 2: λ²/(λ² − C) (C は µm²) → C を µm² に揃える
    C.push(type[1] === '1' ? v[i + 1] ** 2 : v[i + 1]);
  }
  return { B, C };
}

const out = {};
for (const [name, path] of Object.entries(SOURCES)) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  out[name] = { ...parse(await res.text()), source: path };
}

const body = `// 生成ファイル(scripts/import-glass.mjs)。手で編集しないこと。
// 出典: refractiveindex.info-database https://github.com/polyanskiy/refractiveindex.info-database
//       commit ${SHA}
// ライセンス: CC0 1.0 (public domain)
// Sellmeier: n² = 1 + Σ Bᵢ λ² / (λ² − Cᵢ)   (λ: µm, Cᵢ: µm²)
export const GLASS_SOURCE_SHA = '${SHA}';
export const GLASS = ${JSON.stringify(out, null, 2)};
`;
writeFileSync(new URL('../src/core/glass-data.js', import.meta.url), body);
console.log('wrote', Object.keys(out).length, 'glasses');
