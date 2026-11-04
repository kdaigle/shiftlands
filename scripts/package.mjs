import { mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('artifacts', { recursive: true });
await rm('.work/package', { recursive: true, force: true });
await mkdir('.work/package/runtime/public', { recursive: true });
await mkdir('.work/package/itch', { recursive: true });
await copyFile('dist/server.mjs', '.work/package/runtime/server.mjs');
for (const asset of ['index.html','game.js','style.css']) {
  await copyFile(`dist/public/${asset}`, `.work/package/runtime/public/${asset}`);
  await copyFile(`dist/public/${asset}`, `.work/package/itch/${asset}`);
}
await copyFile('LICENSE', '.work/package/runtime/LICENSE');
await copyFile('LICENSE', '.work/package/itch/LICENSE');
await writeFile('.work/package/runtime/START.txt', 'Shiftlands runtime — Node >=22.13, no npm install required.\nUse a writable DB OUTSIDE this runtime directory.\nExample from runtime directory:\nHOST=127.0.0.1 PORT=3000 DB_PATH=../save/world.sqlite node server.mjs\nOpen http://127.0.0.1:3000\nProduction: terminate TLS with your own reverse proxy, enable WebSocket upgrades. Never expose your database.\n');
await writeFile('.work/package/itch/BACKEND.txt', 'Static client only — requires your own running Shiftlands backend. No backend is deployed by this package.\nUpload ZIP as an HTML game, index.html at root, recommended iframe 1100x850, allow fullscreen.\nEnter https://your-server.example in the join screen, or append ?backend=https%3A%2F%2Fyour-server.example\nHTTPS itch pages require an HTTPS backend and WSS. Private identities stay per browser/backend. Do not share bearer tokens.\n');
for (const [dir, name] of [['runtime','shiftlands-runtime.zip'],['itch','shiftlands-itch.zip']]) {
  await rm(`artifacts/${name}`, { force: true });
  const result = spawnSync('zip', ['-qr', `../../../artifacts/${name}`, '.'], { cwd: `.work/package/${dir}`, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`zip failed: ${name}`);
}
console.log('Packaged artifacts/shiftlands-runtime.zip (self-contained server) and shiftlands-itch.zip (static client).');
