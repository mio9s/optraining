// src/ui/main.js をバンドルし、CSS とともに 1 つの HTML (dist/optraining.html) にインライン化する。
// 計算用 Web Worker (src/ui/worker.js) も別途バンドルし、文字列として埋め込む(Blob URL で起動)。
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const common = { bundle: true, format: 'iife', minify: true, target: 'es2022', write: false, charset: 'ascii', legalComments: 'none' };

const worker = await build({ ...common, entryPoints: [new URL('src/ui/worker.js', root).pathname] });
const main = await build({
  ...common,
  entryPoints: [new URL('src/ui/main.js', root).pathname],
  define: { __WORKER_SRC__: JSON.stringify(worker.outputFiles[0].text) },
});
const js = main.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const uplotLicense = '/*! uPlot (c) Leon Sorokin, MIT License https://github.com/leeoniya/uPlot */';
const css = read('node_modules/uplot/dist/uPlot.min.css') + '\n' + read('src/styles.css');
const html = read('src/index.html')
  .replace('<!--APP_CSS-->', () => `<style>\n${css}\n</style>`)
  .replace('<!--APP_JS-->', () => `<script>\n${uplotLicense}\n${js}\n</script>`);
if (/[^\x00-\x7F]/.test(js)) throw new Error('JS に非 ASCII 文字が残っています');
mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/optraining.html', root), html, 'utf8');
console.log(`dist/optraining.html ${(html.length / 1024).toFixed(1)} KiB`);
