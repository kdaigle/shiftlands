import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CAMP, connectedStep, distance, flood, neighbors, NODE_LAYOUT, onLand, RANGE, SHIFT_MS, SPEED, STARTER_WALL, surgeHeight, TILES, tileAt, tileCenter, type Node, type Player, type Resource, type Wall, type World } from './shared.js';
export class Rejection extends Error {}
type Row = { id: string; name: string; x: number; y: number; wood: number; stone: number; gathered: number; objectiveBuilt: number; held: number; built: number; swept: number; notice: string };
type State = { tide: number; shifts: number; stage: World['stage']; remainingMs: number; stageMs: number; lastFlooded: number[]; flooded: number[]; bank: Record<Resource, number>; lookout: boolean; events: string[] };
export type Timings = { periodMs?: number; warningMs?: number; surgeMs?: number; recedeMs?: number };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export class Game {
  readonly db: DatabaseSync;
  private lastTick: number;
  private wasActive = false;
  readonly timings: Required<Timings>;
  constructor(path: string, private clock = Date.now, options: Timings = {}) {
    this.timings = {
      periodMs: options.periodMs ?? Number(process.env.TIDE_PERIOD_MS ?? SHIFT_MS),
      warningMs: options.warningMs ?? Number(process.env.TIDE_WARNING_MS ?? 15_000),
      surgeMs: options.surgeMs ?? Number(process.env.TIDE_SURGE_MS ?? 8_000),
      recedeMs: options.recedeMs ?? Number(process.env.TIDE_RECEDE_MS ?? 5_000)
    };
    if (Object.values(this.timings).some(n => !Number.isSafeInteger(n) || n < 100) || this.timings.warningMs >= this.timings.periodMs) throw new Error('Invalid tide timings.');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, wood INTEGER NOT NULL DEFAULT 0 CHECK(wood>=0), crystal INTEGER NOT NULL DEFAULT 0 CHECK(crystal>=0), amber INTEGER NOT NULL DEFAULT 0 CHECK(amber>=0));
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, remaining INTEGER NOT NULL CHECK(remaining>=0));
      CREATE TABLE IF NOT EXISTS tide_state(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS walls(tile INTEGER PRIMARY KEY, kind TEXT NOT NULL, hp INTEGER NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS salvage(tile INTEGER PRIMARY KEY, remaining INTEGER NOT NULL CHECK(remaining>=0));`);
    const columns = (this.db.prepare('PRAGMA table_info(players)').all() as { name: string }[]).map(c => c.name);
    this.transaction(() => {
      for (const [name, definition] of Object.entries({ stone: 'INTEGER NOT NULL DEFAULT 0 CHECK(stone>=0)', gathered: 'INTEGER NOT NULL DEFAULT 0', objectiveBuilt: 'INTEGER NOT NULL DEFAULT 0', held: 'INTEGER NOT NULL DEFAULT 0', built: 'INTEGER NOT NULL DEFAULT 0', swept: 'INTEGER NOT NULL DEFAULT 0', notice: "TEXT NOT NULL DEFAULT ''" })) {
        if (!columns.includes(name)) this.db.exec(`ALTER TABLE players ADD COLUMN ${name} ${definition}`);
      }
      if (!columns.includes('stone')) this.db.exec('UPDATE players SET stone=crystal+amber');
      if (!this.db.prepare('SELECT id FROM tide_state WHERE id=1').get()) {
        let bank = { wood: 0, stone: 0 };
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world'").get()) {
          const legacy = this.db.prepare('SELECT wood,crystal FROM world WHERE id=1').get() as { wood: number; crystal: number } | undefined;
          if (legacy) bank = { wood: Math.min(12, Math.max(0, legacy.wood)), stone: Math.min(8, Math.max(0, legacy.crystal)) };
        }
        this.save({ tide: 1, shifts: 0, stage: 'calm', remainingMs: this.timings.periodMs, stageMs: 0, lastFlooded: [], flooded: [], bank, lookout: bank.wood >= 12 && bank.stone >= 8, events: ['Build the marked western wall before the first tide.'] });
        this.db.prepare('UPDATE players SET x=?,y=?,notice=?').run(CAMP.x, CAMP.y, 'Welcome to Rising Tide. Your identity and materials are safe.');
      }
      for (const node of NODE_LAYOUT) this.db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?)').run(node.id, node.capacity);
      if (this.db.prepare('SELECT tile FROM walls WHERE tile=?').get(STARTER_WALL)) this.db.prepare('UPDATE players SET objectiveBuilt=1').run();
    });
    this.lastTick = this.clock();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private state(): State { return JSON.parse((this.db.prepare('SELECT data FROM tide_state WHERE id=1').get() as { data: string }).data) as State; }
  private save(state: State) { this.db.prepare('INSERT INTO tide_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(state)); }
  get world(): World {
    const state = this.state(), walls = this.db.prepare('SELECT * FROM walls ORDER BY tile').all() as Wall[];
    const height = surgeHeight(state.tide), forecast = state.stage === 'surge' ? state.flooded : flood(height, walls), warningMs = this.timings.warningMs * (state.lookout ? 2 : 1);
    const nextHeights = state.lookout ? [surgeHeight(state.tide + 1), surgeHeight(state.tide + 2)] : [];
    return { ...state, height, warningMs, periodMs: this.timings.periodMs, walls, forecast, salvage: this.db.prepare('SELECT * FROM salvage WHERE remaining>0 ORDER BY tile').all() as World['salvage'], dryLand: TILES.filter(t => t.elevation > 0 && !state.lastFlooded.includes(t.id)).length, builders: this.db.prepare('SELECT name,built FROM players WHERE built>0 ORDER BY built DESC,id LIMIT 5').all() as World['builders'], nextHeights, nextForecasts: nextHeights.map(height => ({ height, tiles: flood(height, walls) })) };
  }
  get nodes(): Node[] {
    return NODE_LAYOUT.map(node => ({ ...node, remaining: (this.db.prepare('SELECT remaining FROM nodes WHERE id=?').get(node.id) as { remaining: number }).remaining }));
  }
  player(id: string): Player {
    const row = this.db.prepare('SELECT * FROM players WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Rejection('Unknown traveler.');
    return { id: row.id, name: row.name, x: row.x, y: row.y, inventory: { wood: row.wood, stone: row.stone }, objective: { gathered: row.gathered, built: !!row.objectiveBuilt, held: !!row.held }, built: row.built, swept: row.swept, notice: row.notice };
  }
  join(name: unknown, token?: unknown): { token: string; player: Player } {
    if (token !== undefined) return { token: token as string, player: this.player(this.authenticate(token)) };
    if (typeof name !== 'string' || !/^[\p{L}\p{N} _-]{1,18}$/u.test(name.trim())) throw new Rejection('Use 1–18 letters, numbers, spaces, _ or -.');
    const bearer = randomBytes(32).toString('base64url'), id = randomBytes(12).toString('hex');
    const starterBuilt = !!this.db.prepare('SELECT tile FROM walls WHERE tile=?').get(STARTER_WALL);
    this.db.prepare('INSERT INTO players(id,token,name,x,y,objectiveBuilt) VALUES(?,?,?,?,?,?)').run(id, hash(bearer), name.trim(), CAMP.x, CAMP.y, starterBuilt ? 1 : 0);
    return { token: bearer, player: this.player(id) };
  }
  authenticate(token: unknown) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Rejection('Invalid private identity.');
    const row = this.db.prepare('SELECT id FROM players WHERE token=?').get(hash(token)) as { id: string } | undefined;
    if (!row) throw new Rejection('Invalid private identity.');
    return row.id;
  }
  move(id: string, dx: number, dy: number, dt: number) {
    if (![dx, dy, dt].every(Number.isFinite) || Math.abs(dx) > 1 || Math.abs(dy) > 1 || dt < 0 || dt > .1) throw new Rejection('Invalid movement.');
    const p = this.player(id), scale = SPEED * dt / Math.max(1, Math.hypot(dx, dy)), nx = p.x + dx * scale, ny = p.y + dy * scale;
    if (connectedStep(p.x, p.y, nx, ny, this.world)) this.db.prepare('UPDATE players SET x=?,y=? WHERE id=?').run(nx, ny, id);
  }
  gather(id: string, nodeId: string) {
    return this.transaction(() => {
      const p = this.player(id), node = this.nodes.find(n => n.id === nodeId);
      if (!node) throw new Rejection('Unknown resource node.');
      if (distance(p, node) > RANGE) throw new Rejection('Too far away. Walk closer to a resource.');
      if (!onLand(node.x, node.y, this.world)) throw new Rejection('That resource is flooded.');
      if (node.remaining === 0) throw new Rejection('Empty. Only dry groves recover after recession.');
      this.packSpace(p);
      this.db.prepare('UPDATE nodes SET remaining=remaining-1 WHERE id=? AND remaining>0').run(node.id);
      this.db.prepare(`UPDATE players SET ${node.resource}=${node.resource}+1,gathered=gathered+? WHERE id=?`).run(node.resource === 'wood' ? 1 : 0, id);
      return `Gathered 1 ${node.resource}.`;
    });
  }
  private packSpace(p: Player) { if (p.inventory.wood + p.inventory.stone >= 30) throw new Rejection('Pack full. Build or bank materials at the haven.'); }
  contribute(id: string, resource: Resource) {
    if (resource !== 'wood' && resource !== 'stone') throw new Rejection('Unknown resource.');
    return this.transaction(() => {
      const p = this.player(id), state = this.state();
      if (distance(p, CAMP) > RANGE) throw new Rejection('Too far away. Bank beside the haven.');
      if (state.bank[resource] >= (resource === 'wood' ? 12 : 8)) throw new Rejection(`Enough ${resource} banked. Keep the rest in your pack.`);
      if (p.inventory[resource] < 1) throw new Rejection(`No ${resource} in your pack.`);
      this.db.prepare(`UPDATE players SET ${resource}=${resource}-1 WHERE id=?`).run(id);
      state.bank[resource]++;
      state.lookout = state.bank.wood >= 12 && state.bank.stone >= 8;
      if (state.lookout) { state.events.unshift('Lookout built! Longer warnings and two future forecasts unlocked.'); if (state.stage === 'calm' && state.remainingMs <= this.timings.warningMs * 2) state.stage = 'warning'; }
      this.save(state);
      return state.lookout ? 'Lookout built! Future tides revealed.' : `Banked 1 ${resource} for the Lookout.`;
    });
  }
  private target(id: string, tile: number) {
    if (!Number.isInteger(tile) || !TILES[tile]) throw new Rejection('Invalid tile.');
    const p = this.player(id), center = tileCenter(tile);
    if (distance(p, center) > RANGE) throw new Rejection('Too far away. Walk closer to that tile.');
    if (!onLand(center.x, center.y, this.world)) throw new Rejection('Cannot work on flooded or sea tiles.');
    return p;
  }
  build(id: string, tile: number, kind: Resource) {
    if (kind !== 'wood' && kind !== 'stone') throw new Rejection('Unknown wall kind.');
    return this.transaction(() => {
      const p = this.target(id, tile);
      if (TILES[tile].elevation >= 6 || NODE_LAYOUT.some(n => n.tile === tile)) throw new Rejection('Build on low ground, not a grove or the haven.');
      const standing = tileAt(p.x, p.y)!;
      if (Math.abs(standing.x - TILES[tile].x) + Math.abs(standing.y - TILES[tile].y) !== 1) throw new Rejection('Build on an adjacent tile, not underfoot or diagonally.');
      const old = this.world.walls.find(w => w.tile === tile);
      if (old && old.hp > 0) throw new Rejection(tile === STARTER_WALL ? 'The marked wall is already built together. Repair it when worn, then help it hold!' : 'A wall already stands there.');
      const wood = kind === 'wood' ? 3 : 1, stone = kind === 'stone' ? 3 : 0;
      if (p.inventory.wood < wood || p.inventory.stone < stone) throw new Rejection(kind === 'wood' ? 'Need 3 wood.' : 'Need 3 stone and 1 wood.');
      this.db.prepare('UPDATE players SET wood=wood-?,stone=stone-?,built=built+1,objectiveBuilt=MAX(objectiveBuilt,?) WHERE id=?').run(wood, stone, tile === STARTER_WALL ? 1 : 0, id);
      if (tile === STARTER_WALL) this.db.prepare('UPDATE players SET objectiveBuilt=1').run();
      this.db.prepare('INSERT INTO walls VALUES(?,?,?,?) ON CONFLICT(tile) DO UPDATE SET kind=excluded.kind,hp=excluded.hp,owner=excluded.owner').run(tile, kind, kind === 'wood' ? 3 : 5, id);
      return `${kind === 'wood' ? 'Wood' : 'Stone'} wall built. Holds tides up to height ${kind === 'wood' ? 3 : 5}.`;
    });
  }
  repair(id: string, tile: number) {
    return this.transaction(() => {
      const p = this.target(id, tile), wall = this.world.walls.find(w => w.tile === tile);
      if (!wall) throw new Rejection('No wall to repair.');
      const max = wall.kind === 'wood' ? 3 : 5;
      if (wall.hp >= max) throw new Rejection('Wall is already sound.');
      if (p.inventory[wall.kind] < 1) throw new Rejection(`Need 1 ${wall.kind} to repair.`);
      this.db.prepare(`UPDATE players SET ${wall.kind}=${wall.kind}-1 WHERE id=?`).run(id);
      this.db.prepare('UPDATE walls SET hp=? WHERE tile=?').run(max, tile);
      return `Repaired ${wall.kind} wall.`;
    });
  }
  salvage(id: string, tile: number) {
    return this.transaction(() => {
      const p = this.target(id, tile), pile = this.db.prepare('SELECT remaining FROM salvage WHERE tile=?').get(tile) as { remaining: number } | undefined;
      if (!pile || pile.remaining < 1) throw new Rejection('No driftwood left here.');
      this.packSpace(p);
      this.db.prepare('UPDATE salvage SET remaining=remaining-1 WHERE tile=?').run(tile);
      this.db.prepare('UPDATE players SET wood=wood+1 WHERE id=?').run(id);
      return 'Salvaged 1 driftwood.';
    });
  }
  private surge(state: State) {
    const walls = this.world.walls, height = surgeHeight(state.tide), wet = flood(height, walls), wetSet = new Set(wet);
    this.db.prepare('UPDATE players SET notice=?').run(`Tide ${state.tide} surged at height ${height}. Exposed walls and nodes may be lost; inspect your defenses.`);
    for (const wall of walls.filter(w => w.hp > 0)) {
      const without = flood(height, walls.filter(w => w.tile !== wall.tile));
      const held = neighbors(wall.tile).some(id => !wetSet.has(id) && without.includes(id) && TILES[id].elevation > 0 && TILES[id].elevation < height);
      const exposed = TILES[wall.tile].elevation < height && (wall.kind === 'wood' ? 3 : 5) >= height && neighbors(wall.tile).some(id => wetSet.has(id));
      if (held) {
        const pocket = STARTER_WALL + 1;
        const objectiveHeld = wall.tile === STARTER_WALL && !wetSet.has(pocket) && without.includes(pocket);
        this.db.prepare('UPDATE players SET notice=? WHERE id=?').run(`Your wall held back tide ${state.tide}!`, wall.owner);
        if (objectiveHeld) this.db.prepare('UPDATE players SET held=1,notice=? WHERE gathered>=3').run(`Together, your marked wall held back tide ${state.tide}!`);
      }
      if (held || exposed) this.db.prepare('UPDATE walls SET hp=MAX(0,hp-1) WHERE tile=?').run(wall.tile);
      else if (wetSet.has(wall.tile)) this.db.prepare('UPDATE walls SET hp=0 WHERE tile=?').run(wall.tile);
    }
    for (const node of NODE_LAYOUT) if (wetSet.has(node.tile)) this.db.prepare('UPDATE nodes SET remaining=0 WHERE id=?').run(node.id);
    for (const tile of wet) this.db.prepare('DELETE FROM salvage WHERE tile=?').run(tile);
    for (const row of this.db.prepare('SELECT id,x,y FROM players').all() as { id: string; x: number; y: number }[]) {
      const tile = tileAt(row.x, row.y);
      if (!tile || wetSet.has(tile.id)) this.db.prepare('UPDATE players SET x=?,y=?,wood=0,stone=0,swept=swept+1,notice=? WHERE id=?').run(CAMP.x, CAMP.y, `Swept by tide ${state.tide}. Your carried pack was lost; bank, walls and progress are safe.`, row.id);
    }
    state.flooded = wet; state.lastFlooded = wet; state.stage = 'surge'; state.stageMs = this.timings.surgeMs; state.remainingMs = 0; state.shifts++;
    state.events.unshift(`Tide ${state.tide}: height ${height}${height === 6 ? ' — KING TIDE' : ''}. ${TILES.filter(t => t.elevation > 0 && !wetSet.has(t.id)).length} dry tiles.`);
    state.events = state.events.slice(0, 6);
  }
  shift(active = true) {
    const now = this.clock(), elapsed = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (!active) { this.wasActive = false; return false; }
    if (!this.wasActive) { this.wasActive = true; return false; }
    if (!elapsed) return false;
    return this.transaction(() => {
      const state = this.state();
      let changed = false;
      // One transition per tick: a stalled process never catches up missed tides.
      if (state.stage === 'calm' || state.stage === 'warning') {
        state.remainingMs = Math.max(0, state.remainingMs - elapsed);
        if (state.remainingMs === 0) { this.surge(state); changed = true; }
        else if (state.remainingMs <= this.timings.warningMs * (state.lookout ? 2 : 1) && state.stage !== 'warning') { state.stage = 'warning'; changed = true; }
      } else {
        state.stageMs = Math.max(0, state.stageMs - elapsed);
        if (!state.stageMs && state.stage === 'surge') {
          state.stage = 'recede'; state.stageMs = this.timings.recedeMs; state.flooded = [];
          for (const node of NODE_LAYOUT) if (!state.lastFlooded.includes(node.tile)) this.db.prepare('UPDATE nodes SET remaining=? WHERE id=?').run(node.capacity, node.id);
          for (const tile of state.lastFlooded) if (TILES[tile].elevation > 0) this.db.prepare('INSERT INTO salvage VALUES(?,2) ON CONFLICT(tile) DO UPDATE SET remaining=2').run(tile);
          changed = true;
        } else if (!state.stageMs && state.stage === 'recede') {
          state.tide++; state.stage = 'calm'; state.remainingMs = this.timings.periodMs; changed = true;
        }
      }
      this.save(state);
      return changed;
    });
  }
  close() { this.db.close(); }
}
