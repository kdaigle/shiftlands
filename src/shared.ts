export type Resource = 'wood' | 'stone';
export type Player = { id: string; name: string; x: number; y: number; inventory: Record<Resource, number>; objective: { gathered: number; built: boolean; held: boolean }; built: number; swept: number; notice: string };
export type Tile = { id: number; x: number; y: number; elevation: number };
export type Node = { id: string; tile: number; x: number; y: number; resource: Resource; remaining: number; capacity: number };
export type Wall = { tile: number; kind: Resource; hp: number; owner: string };
export type World = { tide: number; shifts: number; stage: 'calm' | 'warning' | 'surge' | 'recede'; remainingMs: number; height: number; warningMs: number; periodMs: number; flooded: number[]; forecast: number[]; lastFlooded: number[]; walls: Wall[]; salvage: { tile: number; remaining: number }[]; bank: Record<Resource, number>; lookout: boolean; dryLand: number; builders: { name: string; built: number }[]; nextHeights: number[]; nextForecasts: { height: number; tiles: number[] }[]; events: string[] };
export type Snapshot = { type: 'snapshot'; you: string; players: Player[]; nodes: Node[]; world: World; now: number };
export const TILE_SIZE = 32, WIDTH = 24, HEIGHT = 16;
export const SHIFT_MS = 90_000, SPEED = 125, RANGE = 60;
// Low western field has one sea entrance; the eastern ridge leads to the haven.
const rows = [
  '000000000000000000000000',
  '001112222111111222211100',
  '012223333222223333322210',
  '012334444333334444332210',
  '012345555444445555432210',
  '012345666666666655432210',
  '012345666666777665432210',
  '011111112266777665432210',
  '012345666677887765432210',
  '012345666677777665432210',
  '012345555666666555432210',
  '012344444555555444432210',
  '012233333444444333322210',
  '011222222333333222222110',
  '001111111222222111111100',
  '000000000000000000000000'
];
export const TILES: Tile[] = rows.flatMap((row, y) => [...row].map((elevation, x) => ({ id: y * WIDTH + x, x, y, elevation: Number(elevation) })));
export const STARTER_WALL = 7 * WIDTH + 8;
export function tileAt(x: number, y: number): Tile | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= WIDTH * TILE_SIZE || y >= HEIGHT * TILE_SIZE) return undefined;
  return TILES[Math.floor(y / TILE_SIZE) * WIDTH + Math.floor(x / TILE_SIZE)];
}
export function tileCenter(id: number) {
  const tile = TILES[id];
  if (!Number.isInteger(id) || !tile) throw new RangeError('Invalid tile.');
  return { x: (tile.x + .5) * TILE_SIZE, y: (tile.y + .5) * TILE_SIZE };
}
export const CAMP = tileCenter(8 * WIDTH + 12);
export const surgeHeight = (tide: number) => tide % 8 === 0 ? 6 : [3, 4, 3, 5, 4, 5, 3][((tide - 1) % 8 + 8) % 8] ?? 3;
export const neighbors = (id: number) => {
  const tile = TILES[id];
  if (!tile) return [];
  return [tile.x > 0 ? id - 1 : -1, tile.x < WIDTH - 1 ? id + 1 : -1, tile.y > 0 ? id - WIDTH : -1, tile.y < HEIGHT - 1 ? id + WIDTH : -1].filter(n => n >= 0);
};
export function flood(height: number, walls: Wall[] = []): number[] {
  const blocked = new Set(walls.filter(w => w.hp > 0 && (w.kind === 'wood' ? 3 : 5) >= height).map(w => w.tile));
  const wet = new Set<number>(), queue: number[] = [];
  const add = (id: number) => { if (!wet.has(id) && TILES[id].elevation < height && !blocked.has(id)) { wet.add(id); queue.push(id); } };
  for (const tile of TILES) if (tile.x === 0 || tile.y === 0 || tile.x === WIDTH - 1 || tile.y === HEIGHT - 1) add(tile.id);
  for (let i = 0; i < queue.length; i++) for (const id of neighbors(queue[i])) add(id);
  return [...wet].sort((a, b) => a - b);
}
export const NODE_LAYOUT: Omit<Node, 'remaining'>[] = [
  { id: 'grove', tile: 7 * WIDTH + 9, resource: 'wood', capacity: 12 },
  { id: 'haven-grove', tile: 8 * WIDTH + 11, resource: 'wood', capacity: 8 },
  { id: 'haven-stone', tile: 9 * WIDTH + 12, resource: 'stone', capacity: 8 },
  { id: 'shore-grove', tile: 7 * WIDTH + 5, resource: 'wood', capacity: 18 },
  { id: 'shore-stone', tile: 11 * WIDTH + 18, resource: 'stone', capacity: 18 }
].map(node => ({ ...node, ...tileCenter(node.tile), resource: node.resource as Resource }));
export const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export function onLand(x: number, y: number, world: Pick<World, 'flooded'>) {
  const tile = tileAt(x, y);
  return !!tile && tile.elevation > 0 && !world.flooded.includes(tile.id);
}
export function connectedStep(x: number, y: number, nx: number, ny: number, world: Pick<World, 'flooded'>) {
  const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) / 4));
  for (let i = 1; i <= steps; i++) if (!onLand(x + (nx - x) * i / steps, y + (ny - y) * i / steps, world)) return false;
  return true;
}
