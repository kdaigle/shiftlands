import { mkdir, rm, copyFile, writeFile, readFile, readdir, stat, chmod, utimes } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revisionResult.status !== 0) throw new Error('Packaging requires a Git revision.');
const revision = revisionResult.stdout.trim();
if (process.env.RELEASE_SHA && process.env.RELEASE_SHA !== revision) throw new Error(`RELEASE_SHA must match checked-out revision ${revision}.`);
const status = spawnSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'package.json', 'package-lock.json', 'README.md', 'ASSETS.txt', 'LICENSE', 'tsconfig.json'], { encoding: 'utf8' });
if (status.status !== 0) throw new Error('Unable to verify packaging source status.');
if (process.env.RELEASE_SHA && status.stdout.trim()) throw new Error('Exact-SHA packaging requires committed runtime/build/documentation inputs.');
const dateResult = spawnSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' });
if (dateResult.status !== 0 || !/^\d+$/.test(dateResult.stdout.trim())) throw new Error('Unable to read source commit timestamp.');
const sourceDate = new Date(Number(dateResult.stdout.trim()) * 1000);
const archiveDate = new Date(Math.max(sourceDate.getTime(), Date.UTC(1980, 0, 1)));
const revisionMarker = JSON.stringify({ revision, sourceDirty: Boolean(status.stdout.trim()), sourceDate: sourceDate.toISOString(), node: process.version }, null, 2) + '\n';
await mkdir('artifacts', { recursive: true });
await rm('.work/package', { recursive: true, force: true });
await mkdir('.work/package/runtime/public', { recursive: true });
await mkdir('.work/package/itch', { recursive: true });
await copyFile('dist/server.mjs', '.work/package/runtime/server.mjs');
for (const asset of ['index.html','game.js','style.css']) {
  await copyFile(`dist/public/${asset}`, `.work/package/runtime/public/${asset}`);
  await copyFile(`dist/public/${asset}`, `.work/package/itch/${asset}`);
}
for (const dir of ['runtime', 'itch']) {
  await copyFile('LICENSE', `.work/package/${dir}/LICENSE`);
  await copyFile('ASSETS.txt', `.work/package/${dir}/ASSETS.txt`);
  await copyFile('README.md', `.work/package/${dir}/README.md`);
  await writeFile(`.work/package/${dir}/REVISION.json`, revisionMarker);
}
const ws = JSON.parse(await readFile('node_modules/ws/package.json', 'utf8'));
const esbuild = JSON.parse(await readFile('node_modules/esbuild/package.json', 'utf8'));
const esbuildNotice = `esbuild ${esbuild.version} — https://github.com/evanw/esbuild\nBuild tool only; its compiler executable is not distributed. This notice also covers any generated bundler runtime helpers.\n\n${await readFile('node_modules/esbuild/LICENSE.md', 'utf8')}`;
await writeFile('.work/package/runtime/THIRD_PARTY_NOTICES.txt', `Shiftlands bundled software notices\n==================================\n\nws ${ws.version} — https://github.com/websockets/ws\nBundled into server.mjs. Optional native extensions are not included.\n\n${await readFile('node_modules/ws/LICENSE', 'utf8')}\n\n${esbuildNotice}\n\nNode.js is supplied separately by the operator and is not included in this ZIP. Other development/test dependencies are not distributed.\n`);
await writeFile('.work/package/itch/THIRD_PARTY_NOTICES.txt', `Shiftlands static client software notices\n========================================\n\nNo ws server code or development/test dependencies are included in this static client.\n\n${esbuildNotice}`);
await writeFile('.work/package/runtime/START.txt', 'Shiftlands runtime — Node >=22.13, no npm install required.\nUse a writable DB OUTSIDE this runtime directory.\nExample from runtime directory:\nHOST=127.0.0.1 PORT=3000 DB_PATH=../save/world.sqlite node server.mjs\nOpen http://127.0.0.1:3000\nProduction: terminate TLS with your own reverse proxy, enable WebSocket upgrades. Never expose your database.\n');
await writeFile('.work/package/itch/BACKEND.txt', 'Static client only — requires your own running Shiftlands backend. No backend is deployed by this package.\nUpload ZIP as an HTML game, index.html at root, recommended iframe 1100x850, allow fullscreen.\nEnter https://your-server.example in the join screen, or append ?backend=https%3A%2F%2Fyour-server.example\nHTTPS itch pages require an HTTPS backend and WSS. Private identities stay per browser/backend. Do not share bearer tokens.\n');
for (const [dir, name] of [['runtime','shiftlands-runtime.zip'],['itch','shiftlands-itch.zip']]) {
  const root = `.work/package/${dir}`, files = [];
  for (const file of (await readdir(root, { recursive: true })).sort()) {
    const path = `${root}/${file}`;
    if (!(await stat(path)).isFile()) continue;
    await chmod(path, 0o644);
    await utimes(path, archiveDate, archiveDate);
    files.push(file);
  }
  await rm(`artifacts/${name}`, { force: true });
  const result = spawnSync('zip', ['-Xq', `../../../artifacts/${name}`, ...files], { cwd: root, env: { ...process.env, TZ: 'UTC' }, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`zip failed: ${name}`);
}
console.log('Packaged artifacts/shiftlands-runtime.zip (self-contained server) and shiftlands-itch.zip (static client).');
