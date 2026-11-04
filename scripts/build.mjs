// src/ui/main.js をバンドルし、CSS とともに 1 つの HTML (dist/optraining.html) にインライン化する
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const result = await build({
  entryPoints: [new URL('src/ui/main.js', root).pathname],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2022',
  write: false,
  legalComments: 'inline',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = read('node_modules/uplot/dist/uPlot.min.css') + '\n' + read('src/styles.css');
const html = read('src/index.html')
  .replace('<!--APP_CSS-->', () => `<style>\n${css}\n</style>`)
  .replace('<!--APP_JS-->', () => `<script>\n${js}\n</script>`);
mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/optraining.html', root), html);
console.log(`dist/optraining.html ${(html.length / 1024).toFixed(1)} KiB`);
