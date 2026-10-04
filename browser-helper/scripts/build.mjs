import './generate.mjs';
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const out = new URL('../dist/', import.meta.url);
await mkdir(new URL('extension/', out), { recursive: true });
await build({
  entryPoints: { demo: fileURLToPath(new URL('demo/demo.mjs', root)), content: fileURLToPath(new URL('src/content.mjs', root)) },
  outdir: fileURLToPath(out), bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
});
for (const name of ['manifest.json', 'popup.html', 'popup.js']) await copyFile(new URL(`extension/${name}`, root), new URL(`extension/${name}`, out));
await copyFile(new URL('content.js', out), new URL('extension/content.js', out));
console.log('Built browser-helper/dist/extension and local pilot bundles.');
