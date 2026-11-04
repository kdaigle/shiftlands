import { build } from 'esbuild';
import { mkdir, rm, copyFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/public', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/server.ts'], outfile: 'dist/server.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } }),
  build({ entryPoints: ['src/client.ts'], outfile: 'dist/public/game.js', bundle: true, platform: 'browser', format: 'esm', minify: true, target: 'es2022' }),
  copyFile('src/index.html', 'dist/public/index.html'),
  copyFile('src/style.css', 'dist/public/style.css')
]);
console.log('Built self-contained dist/server.mjs and dist/public.');
