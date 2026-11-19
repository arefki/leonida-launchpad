// Build Leonida Launchpad into docs/ (GitHub Pages serves docs/ on main).
// Bundles src/main.js (SDK + viem) with esbuild and copies the static files.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('docs', { recursive: true, force: true });
await mkdir('docs', { recursive: true });

const result = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'firefox110', 'safari16'],
  outfile: 'docs/app.js',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
});

await cp('src/index.html', 'docs/index.html');
await cp('src/style.css', 'docs/style.css');

console.log('Built docs/ (index.html, style.css, app.js).');
