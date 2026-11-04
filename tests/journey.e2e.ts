import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CAMP, HEIGHT, SPEED, STARTER_WALL, TILE_SIZE, WIDTH, TILES, tileCenter, type Snapshot } from '../src/shared.js';

type Observation = Snapshot & { connected: boolean; generation: number; snapshotGeneration: number };
const URL = 'http://127.0.0.1:3102';
const PERIOD = 45_000;
const STARTER_FIELD = STARTER_WALL + 1;
async function snapshot(page: Page): Promise<Observation> {
  return page.evaluate(() => (window as unknown as { shiftlands: Observation }).shiftlands);
}
async function self(page: Page) {
  const state = await snapshot(page);
  return state.players.find(player => player.id === state.you)!;
}
function tileAt(point: { x: number; y: number }) {
  return Math.floor(point.y / TILE_SIZE) * WIDTH + Math.floor(point.x / TILE_SIZE);
}
function center(tile: number) { return tileCenter(tile); }

async function walkPoint(page: Page, target: { x: number; y: number }) {
  await page.locator('canvas').focus();
  for (let attempt = 0; attempt < 30; attempt++) {
    const player = await self(page), dx = target.x - player.x, dy = target.y - player.y;
    if (Math.hypot(dx, dy) < 7) return;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const delta = horizontal ? Math.abs(dx) : Math.abs(dy);
    const key = horizontal ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w');
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.min(250, Math.max(100, (delta - 3) / SPEED * 1000)));
    await page.keyboard.up(key);
    await page.waitForTimeout(120);
  }
  throw new Error(`Keyboard walk blocked: ${JSON.stringify({ target, player: await self(page) })}`);
}

async function walkTile(page: Page, target: number) {
  const state = await snapshot(page), start = tileAt(await self(page));
  const flooded = new Set(state.world.flooded);
  const walls = new Set(state.world.walls.map(wall => wall.tile));
  const queue = [start], previous = new Map<number, number>([[start, -1]]);
  for (let index = 0; index < queue.length && !previous.has(target); index++) {
    const tile = queue[index], col = tile % WIDTH, row = Math.floor(tile / WIDTH);
    for (const [x, y] of [[col - 1, row], [col + 1, row], [col, row - 1], [col, row + 1]]) {
      const next = y * WIDTH + x;
      if (x < 0 || x >= WIDTH || y < 0 || next >= TILES.length || previous.has(next)) continue;
      if (TILES[next].elevation <= 0 || flooded.has(next) || walls.has(next)) continue;
      previous.set(next, tile); queue.push(next);
    }
  }
  expect(previous.has(target), `A walkable route to tile ${target}`).toBe(true);
  const route: number[] = [];
  for (let tile = target; tile !== start; tile = previous.get(tile)!) route.unshift(tile);
  for (const tile of route) await walkPoint(page, center(tile));
  await walkPoint(page, center(target));
}
async function interact(page: Page, count = 1) {
  await page.locator('canvas').focus();
  for (let i = 0; i < count; i++) {
    await page.waitForTimeout(420);
    await page.keyboard.press('e');
    await page.waitForTimeout(150);
  }
}

test('Rising Tide: two real travelers gather, defend, get swept, reconnect and survive an actual SQLite restart', async ({ browser }) => {
  await mkdir('.work/e2e', { recursive: true });
  await mkdir('evidence', { recursive: true });
  const directory = await mkdtemp(join('.work/e2e', 'rising-tide-')), db = join(directory, 'world.sqlite');
  let server: ChildProcess | undefined, log = '', serverErrors = '', backendStopped = false, expectedTransportErrors = 0;
  const start = async () => {
    server = spawn(process.execPath, ['dist/server.mjs'], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: '3102', DB_PATH: db, TIDE_PERIOD_MS: String(PERIOD), TIDE_WARNING_MS: '12000' },
      stdio: 'pipe'
    });
    server.stdout?.on('data', data => { log += data.toString(); });
    server.stderr?.on('data', data => { serverErrors += data.toString(); });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(URL + '/health')).ok) { backendStopped = false; return; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Production server failed to start: ' + serverErrors);
  };
  const stop = async () => {
    if (!server) return;
    backendStopped = true;
    const process = server;
    process.kill('SIGTERM');
    await new Promise<void>(resolve => { if (process.exitCode !== null) resolve(); else process.once('exit', () => resolve()); });
    server = undefined;
  };
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [fern, moss] = pages, consoleErrors: string[] = [], events: string[] = [];
  const began = Date.now(), record = (event: string) => events.push(`+${((Date.now() - began) / 1000).toFixed(1)}s ${event}`);
  const observeErrors = (page: Page) => {
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (backendStopped && message.text().includes('net::ERR_CONNECTION_REFUSED')) expectedTransportErrors++;
      else consoleErrors.push(message.text());
    });
  };
  pages.forEach(observeErrors);
  try {
    await start();
    for (let i = 0; i < pages.length; i++) {
      await pages[i].goto(URL);
      await expect(pages[i].locator('#goal')).toContainText(/sea rises/i);
      if (i === 0) await pages[i].screenshot({ path: 'evidence/join-screen.png' });
      await pages[i].getByLabel('Traveler nickname').fill(i === 0 ? 'Fern' : 'Moss');
      await pages[i].getByRole('button', { name: 'Enter the islands' }).click();
      await pages[i].waitForFunction(() => (window as unknown as { shiftlands: Observation }).shiftlands?.connected);
      await expect(pages[i].locator('#play-goal')).toContainText(/sea rises/i);
      await expect(pages[i].locator('#countdown')).toHaveText(/SURGE IN \d:\d{2} · height \d/);
      await expect(pages[i].locator('#objectives li')).toHaveCount(3);
    }
    await expect.poll(async () => (await snapshot(fern)).players.length).toBe(2);
    const identities = [(await snapshot(fern)).you, (await snapshot(moss)).you];
    const initialRemaining = (await snapshot(fern)).world.remainingMs;
    expect(initialRemaining).toBeGreaterThan(0);
    expect(initialRemaining).toBeLessThanOrEqual(PERIOD);
    expect(identities[0]).not.toBe(identities[1]);
    await fern.screenshot({ path: 'evidence/start.png' });
    record('Two isolated browsers joined through nickname UI; both show the sea-rise goal, three objectives and a live surge countdown.');
    const duplicate = await contexts[0].newPage();
    observeErrors(duplicate);
    await duplicate.goto(URL);
    await duplicate.getByRole('button', { name: 'Enter the islands' }).click();
    await expect(duplicate.locator('#notice')).toContainText('another tab');
    expect((await snapshot(fern)).connected).toBe(true);
    await duplicate.close();
    expect((await snapshot(fern)).world.remainingMs).toBeLessThan(initialRemaining);
    record('Duplicate bearer session visibly rejected without disconnecting the original traveler.');

    await fern.locator('canvas').focus();
    await fern.keyboard.press('b');
    await expect(fern.locator('#notice')).toContainText(/wood|need|cost/i);
    record('Real B with an empty pack produces visible invalid-action feedback.');
    const initial = await snapshot(fern);
    const grove = initial.nodes.find(node => tileAt(node) === STARTER_FIELD && node.resource === 'wood')!;
    expect(grove).toBeTruthy();
    await walkTile(fern, STARTER_FIELD);
    await interact(fern, 3);
    await expect.poll(async () => (await self(fern)).inventory.wood).toBe(3);
    expect((await self(fern)).objective.gathered).toBe(3);
    await expect.poll(async () => (await snapshot(moss)).nodes.find(node => node.id === grove.id)!.remaining).toBe(grove.remaining - 3);
    await expect.poll(async () => tileAt((await snapshot(moss)).players.find(player => player.id === identities[0])!)).toBe(STARTER_FIELD);
    const canvas = fern.locator('canvas'), bounds = await canvas.boundingBox();
    expect(bounds).toBeTruthy();
    const marker = center(STARTER_WALL);
    await canvas.click({ position: { x: marker.x / (WIDTH * TILE_SIZE) * bounds!.width, y: marker.y / (HEIGHT * TILE_SIZE) * bounds!.height } });
    expect(tileAt(await self(fern))).toBe(STARTER_FIELD);
    await fern.keyboard.press('b');
    await expect.poll(async () => (await snapshot(fern)).world.walls.some(wall => wall.tile === STARTER_WALL)).toBe(true);
    const wallBefore = (await snapshot(fern)).world.walls.find(wall => wall.tile === STARTER_WALL)!;
    expect(wallBefore.kind).toBe('wood');
    expect((await self(fern)).objective.built).toBe(true);
    await expect.poll(async () => (await snapshot(moss)).world.walls).toEqual((await snapshot(fern)).world.walls);
    record('Fern walked to the starter grove, gathered three real E actions, clicked the adjacent glowing marker and built its wall with B; Moss observed movement, depletion and the same wall.');

    await interact(fern, 2);
    await walkPoint(fern, CAMP);
    await interact(fern);
    const bankBefore = (await snapshot(fern)).world.bank;
    expect(bankBefore.wood).toBeGreaterThan(0);
    const outside = (await snapshot(moss)).nodes.find(node => node.resource === 'wood' && tileAt(node) !== STARTER_FIELD && TILES[tileAt(node)].elevation <= 2)!;
    expect(outside, 'An unprotected low-lying resource grove').toBeTruthy();
    await walkTile(moss, tileAt(outside));
    await interact(moss, 2);
    const carried = (await self(moss)).inventory;
    expect(carried.wood + carried.stone).toBeGreaterThan(0);
    const unprotectedBefore = (await snapshot(fern)).nodes.find(node => node.id === outside.id)!;
    expect(unprotectedBefore.remaining).toBeGreaterThan(0);
    const fernPack = (await self(fern)).inventory;
    expect(fernPack.wood).toBeGreaterThan(0);

    await expect.poll(async () => (await snapshot(fern)).world.stage, { timeout: PERIOD }).toBe('warning');
    const warning = await snapshot(fern);
    expect(warning.world.forecast).toContain(tileAt(outside));
    expect(warning.world.forecast).not.toContain(STARTER_FIELD);
    await expect.poll(async () => (await snapshot(moss)).world.forecast).toEqual(warning.world.forecast);
    await fern.screenshot({ path: 'evidence/warning.png' });
    record(`Real warning forecasts ${warning.world.forecast.length} flooded tiles; protected starter field is excluded and Moss's exposed grove is included in both browsers.`);
    await expect.poll(async () => (await snapshot(fern)).world.remainingMs, { timeout: 15_000 }).toBeLessThan(2500);
    const beforeSurge = await snapshot(fern);
    await fern.screenshot({ path: 'evidence/before-surge.png' });
    expect(tileAt(await self(moss))).toBe(tileAt(outside));
    await expect.poll(async () => (await snapshot(fern)).world.shifts, { timeout: 12_000 }).toBe(beforeSurge.world.shifts + 1);
    const surge = await snapshot(fern);
    expect(surge.world.stage).toBe('surge');
    expect(surge.world.flooded).toContain(tileAt(outside));
    expect(surge.world.flooded).not.toContain(STARTER_FIELD);
    await expect.poll(async () => (await snapshot(moss)).world.flooded).toEqual(surge.world.flooded);
    await expect.poll(async () => (await snapshot(moss)).nodes.find(node => node.id === outside.id)!.remaining).toBeLessThan(unprotectedBefore.remaining);
    expect(surge.nodes.find(node => node.id === grove.id)!.remaining).toBe(beforeSurge.nodes.find(node => node.id === grove.id)!.remaining);
    await expect.poll(async () => (await snapshot(moss)).nodes).toEqual(surge.nodes);
    const wallAfter = surge.world.walls.find(wall => wall.tile === STARTER_WALL)!;
    expect(wallAfter.hp).toBeGreaterThan(0);
    expect(wallAfter.hp).toBeLessThan(wallBefore.hp);
    expect((await self(fern)).inventory).toEqual(fernPack);
    expect(surge.world.bank).toEqual(bankBefore);
    await expect.poll(async () => (await self(fern)).objective.held).toBe(true);
    expect((await self(fern)).objective.gathered).toBeGreaterThanOrEqual(3);
    expect((await self(fern)).objective).toMatchObject({ built: true, held: true });
    await expect.poll(async () => tileAt(await self(moss))).toBe(tileAt(CAMP));
    expect((await self(moss)).inventory).toEqual({ wood: 0, stone: 0 });
    await expect(moss.locator('#notice')).toContainText(/swept|haven|carried/i);
    await fern.screenshot({ path: 'evidence/after-surge.png' });
    await moss.screenshot({ path: 'evidence/swept-player.png' });
    record(`Real surge flooded ${surge.world.flooded.length} shared tiles and washed the exposed resource; wall wore ${wallBefore.hp}→${wallAfter.hp} while protecting the pocket. Moss was swept to haven and lost only carried goods; Fern's pack, shared bank and construction survived.`);
    await expect(fern.locator('#objectives')).toContainText(/held|survived|hold/i);
    await expect(fern.locator('#board')).toContainText(/dry|builder|tide/i);

    const generation = (await snapshot(fern)).generation, reconnectAt = Date.now();
    await fern.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect.poll(async () => {
      const state = await snapshot(fern);
      return state.connected && state.generation > generation && state.snapshotGeneration === state.generation && state.now > reconnectAt;
    }).toBe(true);
    expect((await snapshot(fern)).you).toBe(identities[0]);
    expect((await self(fern)).inventory).toEqual(fernPack);
    record('UI Reconnect produced a fresh authenticated generation and snapshot, retaining Fern identity and inventory.');

    await expect.poll(async () => (await snapshot(fern)).world.stage, { timeout: 20_000 }).toBe('calm');
    const saved = await snapshot(fern), generations = await Promise.all(pages.map(async page => (await snapshot(page)).generation));
    const savedObjectives = await Promise.all(pages.map(async page => (await self(page)).objective));
    await stop();
    await expect(fern.locator('#connection')).toContainText('OFFLINE');
    let refused = false;
    try { await fetch(URL + '/health'); } catch { refused = true; }
    expect(refused).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const restartAt = Date.now();
    await start();
    for (let i = 0; i < pages.length; i++) await expect.poll(async () => {
      const state = await snapshot(pages[i]);
      return state.connected && state.generation > generations[i] && state.snapshotGeneration === state.generation && state.now > restartAt;
    }, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await snapshot(fern)).players.length).toBe(2);
    const restored = await snapshot(fern);
    for (const key of ['tide', 'shifts', 'stage', 'height', 'walls', 'bank', 'lookout', 'lastFlooded', 'flooded', 'salvage', 'dryLand', 'builders', 'periodMs', 'warningMs'] as const) {
      expect(restored.world[key], `Persisted world.${key}`).toEqual(saved.world[key]);
    }
    expect(restored.nodes).toEqual(saved.nodes);
    expect(restored.world.remainingMs).toBeGreaterThan(0);
    expect(restored.world.remainingMs).toBeLessThanOrEqual(saved.world.remainingMs + 1000);
    expect(restored.you).toBe(identities[0]);
    expect((await self(fern)).inventory).toEqual(fernPack);
    expect((await self(moss)).inventory).toEqual({ wood: 0, stone: 0 });
    expect((await self(fern)).objective).toEqual(savedObjectives[0]);
    expect((await self(moss)).objective).toEqual(savedObjectives[1]);
    record(`Actual SIGTERM made health unavailable; a new production process opened the SAME ${db}. Fresh welcome generations retain identities, inventory, walls, bank, lookout, tide, height, phase and shift count, with a ticking deadline.`);

    const embed = await contexts[0].newPage();
    observeErrors(embed);
    await embed.route(URL + '/embed-test', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body style="margin:0"><iframe title="Shiftlands embedded game" src="${URL}" width="720" height="650" style="border:0"></iframe></body></html>`
    }));
    await embed.goto(URL + '/embed-test');
    await expect(embed.frameLocator('iframe').getByRole('button', { name: 'Enter the islands' })).toBeVisible();
    await fern.setViewportSize({ width: 720, height: 650 });
    await expect(fern.locator('canvas')).toBeVisible();
    await expect(fern.locator('#countdown')).toBeVisible();
    const geometry = await fern.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, width: innerWidth,
      canvas: document.querySelector('canvas')!.getBoundingClientRect().width
    }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    expect(geometry.canvas).toBeGreaterThan(500);
    await embed.close();
    record('A real 720×650 iframe loaded the join screen; active gameplay at that viewport retained readable countdown and canvas without horizontal overflow.');

    const returning = await contexts[0].newPage();
    observeErrors(returning);
    await returning.goto(URL);
    await returning.getByRole('button', { name: 'Enter the islands' }).click();
    await expect(returning.locator('#notice')).toContainText('another tab');
    expect((await snapshot(fern)).connected).toBe(true);
    await fern.close();
    await returning.waitForFunction(() => (window as unknown as { shiftlands: Observation }).shiftlands?.connected, {}, { timeout: 30_000 });
    expect((await snapshot(returning)).you).toBe(identities[0]);
    expect((await self(returning)).inventory).toEqual(fernPack);
    record('Duplicate tab automatically recovered the same saved identity and pack after the original tab closed.');
    expect(consoleErrors).toEqual([]);
    expect(serverErrors.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature(?: and might change at any time)?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g, '')).toBe('');
    await writeFile('evidence/verification.txt', `Rising Tide verification — ${new Date().toISOString()}\nNode ${process.version}; bundled production server; two isolated Chromium contexts; genuine keyboard/pointer gameplay; read-only window.shiftlands observations; no socket mocks, teleports, internal actions or database edits.\n${events.join('\n')}\nConsole/page errors: 0; ${expectedTransportErrors} expected connection-refused logs only while backend stopped.\nScreenshots: join-screen.png, start.png, warning.png, before-surge.png, after-surge.png, swept-player.png.\nProcess log: ${log.trim().replace(/\n/g, ' | ')}\n`);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
