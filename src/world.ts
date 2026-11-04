import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CAMP, connectedStep, distance, NODE_LAYOUT, onLand, RANGE, SHIFT_MS, SPEED, type Node, type Player, type Resource, type World } from './shared.js';
export class Rejection extends Error {}
type Row = { id: string; name: string; x: number; y: number; wood: number; crystal: number; amber: number };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export class Game {
  readonly db: DatabaseSync;
  constructor(path: string, private clock = Date.now) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, wood INTEGER NOT NULL DEFAULT 0 CHECK(wood>=0), crystal INTEGER NOT NULL DEFAULT 0 CHECK(crystal>=0), amber INTEGER NOT NULL DEFAULT 0 CHECK(amber>=0));
      CREATE TABLE IF NOT EXISTS world(id INTEGER PRIMARY KEY CHECK(id=1), phase INTEGER NOT NULL, nextShift INTEGER NOT NULL, tier INTEGER NOT NULL, wood INTEGER NOT NULL DEFAULT 0, crystal INTEGER NOT NULL DEFAULT 0, amber INTEGER NOT NULL DEFAULT 0, shifts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, remaining INTEGER NOT NULL CHECK(remaining>=0));`);
    this.db.prepare('INSERT OR IGNORE INTO world(id,phase,nextShift,tier) VALUES(1,0,?,0)').run(this.clock() + SHIFT_MS);
    for (const node of NODE_LAYOUT) this.db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,8)').run(node.id);
    this.shift();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get world(): World {
    const row = this.db.prepare('SELECT * FROM world WHERE id=1').get() as { phase: number; nextShift: number; tier: number; wood: number; crystal: number; amber: number; shifts: number };
    return { phase: row.phase, nextShift: row.nextShift, tier: row.tier, shifts: row.shifts, bank: { wood: row.wood, crystal: row.crystal, amber: row.amber } };
  }
  get nodes(): Node[] {
    return NODE_LAYOUT.map(node => ({ ...node, remaining: (this.db.prepare('SELECT remaining FROM nodes WHERE id=?').get(node.id) as { remaining: number }).remaining }));
  }
  player(id: string): Player {
    const row = this.db.prepare('SELECT id,name,x,y,wood,crystal,amber FROM players WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Rejection('Unknown traveler.');
    return { id: row.id, name: row.name, x: row.x, y: row.y, inventory: { wood: row.wood, crystal: row.crystal, amber: row.amber } };
  }
  join(name: unknown, token?: unknown): { token: string; player: Player } {
    if (token !== undefined) {
      const id = this.authenticate(token);
      return { token: token as string, player: this.player(id) };
    }
    if (typeof name !== 'string' || !/^[\p{L}\p{N} _-]{1,18}$/u.test(name.trim())) throw new Rejection('Use 1–18 letters, numbers, spaces, _ or -.');
    const bearer = randomBytes(32).toString('base64url');
    const id = randomBytes(12).toString('hex');
    this.db.prepare('INSERT INTO players(id,token,name,x,y) VALUES(?,?,?,?,?)').run(id, hash(bearer), name.trim(), 400, 340);
    return { token: bearer, player: this.player(id) };
  }
  authenticate(token: unknown) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Rejection('Invalid private identity.');
    const row = this.db.prepare('SELECT id FROM players WHERE token=?').get(hash(token)) as { id: string } | undefined;
    if (!row) throw new Rejection('Invalid private identity.');
    return row.id;
  }
  move(id: string, dx: number, dy: number, dt: number) {
    if (![dx, dy, dt].every(Number.isFinite) || Math.abs(dx) > 1 || Math.abs(dy) > 1 || dt < 0 || dt > 0.1) throw new Rejection('Invalid movement.');
    const p = this.player(id), scale = SPEED * dt / Math.max(1, Math.hypot(dx, dy));
    const nx = p.x + dx * scale, ny = p.y + dy * scale;
    if (connectedStep(p.x, p.y, nx, ny, this.world)) this.db.prepare('UPDATE players SET x=?,y=? WHERE id=?').run(nx, ny, id);
  }
  gather(id: string, nodeId: string) {
    return this.transaction(() => {
      const p = this.player(id), node = this.nodes.find(n => n.id === nodeId);
      if (!node || (node.resource === 'amber' && this.world.tier < 1)) throw new Rejection('That island is not open yet.');
      if (distance(p, node) > RANGE) throw new Rejection('Too far away. Walk closer to a resource.');
      if (node.remaining === 0) throw new Rejection('Empty until the next shift.');
      if (Object.values(p.inventory).reduce((a, b) => a + b, 0) >= 30) throw new Rejection('Pack full. Contribute at camp.');
      this.db.prepare('UPDATE nodes SET remaining=remaining-1 WHERE id=? AND remaining>0').run(node.id);
      this.db.prepare(`UPDATE players SET ${node.resource}=${node.resource}+1 WHERE id=?`).run(id);
      return `Gathered 1 ${node.resource}. Return to camp to contribute.`;
    });
  }
  contribute(id: string, resource: Resource) {
    if (!['wood', 'crystal', 'amber'].includes(resource)) throw new Rejection('Unknown resource.');
    return this.transaction(() => {
      const p = this.player(id), world = this.world;
      if (distance(p, CAMP) > RANGE) throw new Rejection('Too far away. Contribute beside camp.');
      if (p.inventory[resource] < 1) throw new Rejection(`No ${resource} in your pack.`);
      if ((resource === 'amber' && world.tier === 0) || (resource !== 'amber' && world.tier >= 1) || world.tier >= 2) throw new Rejection('Camp does not need that resource.');
      const required = resource === 'wood' ? 4 : resource === 'crystal' ? 2 : 3;
      if (world.bank[resource] >= required) throw new Rejection(`Enough ${resource} contributed. Keep the rest in your pack.`);
      this.db.prepare(`UPDATE players SET ${resource}=${resource}-1 WHERE id=? AND ${resource}>0`).run(id);
      this.db.prepare(`UPDATE world SET ${resource}=${resource}+1 WHERE id=1`).run();
      const next = this.world;
      if (next.tier === 0 && next.bank.wood >= 4 && next.bank.crystal >= 2) {
        this.db.prepare('UPDATE world SET tier=1 WHERE id=1').run();
        return 'Bridge built! The southern Sunstone island is now reachable.';
      }
      if (next.tier === 1 && next.bank.amber >= 3) {
        this.db.prepare('UPDATE world SET tier=2 WHERE id=1').run();
        return 'Beacon lit! Your shared haven will weather every shift.';
      }
      return `Contributed 1 ${resource} to the shared camp.`;
    });
  }
  shift() {
    const now = this.clock(), world = this.world;
    if (now < world.nextShift) return false;
    this.transaction(() => {
      const elapsed = Math.floor((now - world.nextShift) / SHIFT_MS) + 1;
      this.db.prepare('UPDATE world SET phase=?,nextShift=?,shifts=shifts+? WHERE id=1').run((world.phase + elapsed) % 2, world.nextShift + elapsed * SHIFT_MS, elapsed);
      this.db.prepare('UPDATE nodes SET remaining=8').run();
      const shifted = this.world;
      for (const row of this.db.prepare('SELECT id,x,y FROM players').all() as { id: string; x: number; y: number }[]) {
        if (!onLand(row.x, row.y, shifted)) this.db.prepare('UPDATE players SET x=400,y=340 WHERE id=?').run(row.id);
      }
    });
    return true;
  }
  close() { this.db.close(); }
}
