import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
await mkdir('.work',{recursive:true});
const root = resolve(await mkdtemp(join('.work','release-smoke-')));
for (const dir of ['runtime','static','save']) await mkdir(`${root}/${dir}`, { recursive: true });
for (const [zip, dir] of [['runtime','runtime'],['itch','static']]) {
  const result = spawnSync('unzip', ['-q', resolve(`artifacts/shiftlands-${zip}.zip`), '-d', `${root}/${dir}`], { stdio: 'inherit' });
  assert.equal(result.status, 0);
}
assert.ok(!(await readdir(`${root}/runtime`)).includes('node_modules'));
assert.ok(!(await readdir(`${root}/static`)).includes('server.mjs'));
const expectedRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
for (const dir of ['runtime', 'static']) {
  const marker=JSON.parse(await readFile(`${root}/${dir}/REVISION.json`,'utf8'));
  assert.equal(marker.revision,expectedRevision);
  assert.equal(typeof marker.sourceDirty,'boolean');
  assert.equal(await readFile(`${root}/${dir}/LICENSE`, 'utf8'), await readFile('LICENSE', 'utf8'));
  assert.equal(await readFile(`${root}/${dir}/ASSETS.txt`, 'utf8'), await readFile('ASSETS.txt', 'utf8'));
  assert.equal(await readFile(`${root}/${dir}/README.md`, 'utf8'), await readFile('README.md', 'utf8'));
  assert.ok((await readFile(`${root}/${dir}/THIRD_PARTY_NOTICES.txt`, 'utf8')).includes(await readFile('node_modules/esbuild/LICENSE.md', 'utf8')));
}
assert.ok((await readFile(`${root}/runtime/THIRD_PARTY_NOTICES.txt`, 'utf8')).includes(await readFile('node_modules/ws/LICENSE', 'utf8')));
const bundled = await readFile(`${root}/runtime/server.mjs`, 'utf8');
assert.ok(!/from ["'](?:ws|esbuild|typescript)["']/.test(bundled));
const runtime = spawn(process.execPath, ['server.mjs'], { cwd: `${root}/runtime`, env: { ...process.env, HOST: '127.0.0.1', PORT: '3103', DB_PATH: `${root}/save/world.sqlite` }, stdio: 'pipe' });
let log = '';
runtime.stderr.on('data', data => { log += data.toString(); });
const staticServer = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!['index.html','game.js','style.css'].includes(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css');
  res.end(await readFile(`${root}/static/${file}`));
});
let browser;
try {
  await new Promise(r => staticServer.listen(3104, '127.0.0.1', r));
  let healthy = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch('http://127.0.0.1:3103/health')).ok) { healthy = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(healthy, log);
  assert.equal((await fetch('http://127.0.0.1:3103/favicon.ico')).status,204);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:3104/?backend=http%3A%2F%2F127.0.0.1%3A3103');
  assert.ok((await page.locator('link[rel=icon]').getAttribute('href')).startsWith('data:image/svg+xml,'));
  assert.equal(await page.getByLabel('Backend address', { exact: false }).inputValue(), 'http://127.0.0.1:3103');
  await page.getByLabel('Traveler nickname').fill('Packaged Fern');
  await page.getByRole('button', { name: 'Enter the islands' }).click();
  await page.waitForFunction(() => window.shiftlands?.connected);
  assert.equal((await (await fetch('http://127.0.0.1:3103/health')).json()).players, 1);
  await page.keyboard.press('e');
  await page.getByText('No wood in your pack.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Both ZIPs extracted: LICENSE, exact ASSETS.txt and bundled software notices verified; runtime launched from its own directory with external SQLite DB, no npm install; static ZIP genuinely joined cross-origin backend through URL-configured UI. Browser errors: 0.');
} finally {
  await browser?.close();
  await new Promise(r => staticServer.close(r));
  runtime.kill('SIGTERM');
  await new Promise(r => { if (runtime.exitCode !== null) r(); else runtime.once('exit', r); });
  await rm(root,{recursive:true,force:true});
}
