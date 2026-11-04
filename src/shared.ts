export type Resource = 'wood' | 'crystal' | 'amber';
export type Player = { id: string; name: string; x: number; y: number; inventory: Record<Resource, number> };
export type Node = { id: string; x: number; y: number; resource: Resource; remaining: number };
export type World = { phase: number; nextShift: number; tier: number; bank: Record<Resource, number>; shifts: number };
export type Snapshot = { type: 'snapshot'; you: string; players: Player[]; nodes: Node[]; world: World; now: number };
export const SHIFT_MS = 75_000;
export const SPEED = 125;
export const RANGE = 60;
export const CAMP = { x: 400, y: 300 };
export const NODE_LAYOUT: Omit<Node, 'remaining'>[] = [
  { id: 'willow', x: 180, y: 300, resource: 'wood' },
  { id: 'quartz', x: 620, y: 300, resource: 'crystal' },
  { id: 'sunstone', x: 400, y: 500, resource: 'amber' }
];
export const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const ellipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
function segment(x: number, y: number, ax: number, ay: number, bx: number, by: number, width: number) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= width;
}
export function onLand(x: number, y: number, world: Pick<World, 'phase' | 'tier'>) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 18 || x > 782 || y < 18 || y > 582) return false;
  return ellipse(x, y, 400, 300, 112, 86)
    || ellipse(x, y, 180, 300, 90, 72) || ellipse(x, y, 620, 300, 90, 72)
    || segment(x, y, 180, 300, 620, 300, 19)
    || ellipse(x, y, 400, 105, 74, 49)
    || segment(x, y, world.phase === 0 ? 200 : 600, 275, 400, 105, 18)
    || (world.tier >= 1 && (segment(x, y, 400, 340, 400, 500, 20) || ellipse(x, y, 400, 500, 87, 59)));
}
export function connectedStep(x: number, y: number, nx: number, ny: number, world: Pick<World, 'phase' | 'tier'>) {
  const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) / 4));
  for (let i = 1; i <= steps; i++) if (!onLand(x + (nx - x) * i / steps, y + (ny - y) * i / steps, world)) return false;
  return true;
}
