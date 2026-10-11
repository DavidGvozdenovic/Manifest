import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const codeOptions = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2017',
  format: 'iife',
  logLevel: 'info',
};

const uiOptions = {
  entryPoints: ['src/ui/main.tsx'],
  bundle: true,
  write: false,
  target: 'es2020',
  format: 'iife',
  jsx: 'automatic',
  minify: !watch,
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};

async function writeUi(result) {
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = await readFile('src/ui/style.css', 'utf8');
  await mkdir('dist', { recursive: true });
  await writeFile(
    'dist/ui.html',
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`,
  );
}

if (watch) {
  const code = await esbuild.context(codeOptions);
  const ui = await esbuild.context({
    ...uiOptions,
    plugins: [{ name: 'inline-html', setup: (b) => b.onEnd((r) => r.outputFiles && writeUi(r)) }],
  });
  await Promise.all([code.watch(), ui.watch()]);
} else {
  await esbuild.build(codeOptions);
  await writeUi(await esbuild.build(uiOptions));
}
