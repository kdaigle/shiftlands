import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Game, Rejection } from './world.js';
import type { Resource } from './shared.js';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3000);
const HEARTBEAT_MS = process.env.NODE_ENV === 'test' ? Number(process.env.TEST_HEARTBEAT_MS ?? 10_000) : 10_000;
if (!Number.isInteger(HEARTBEAT_MS) || HEARTBEAT_MS < 50 || HEARTBEAT_MS > 10_000) throw new Error('Invalid test heartbeat interval.');
const DB_PATH = resolve(process.env.DB_PATH ?? '.work/world.sqlite');
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
if (DB_PATH === publicDir || DB_PATH.startsWith(publicDir + '/') || DB_PATH.startsWith(resolve(dirname(fileURLToPath(import.meta.url))) + '/')) throw new Error('DB_PATH must be outside the immutable runtime bundle.');
const game = new Game(DB_PATH);
const active = new Map<string, { socket: WebSocket; dx: number; dy: number; inputAt: number; seq: number; actionAt: number }>();
const actionTimes = new Map<string, number>();
const upgrades = new Map<string, { count: number; start: number }>();
const joins = new Map<string, { count: number; start: number }>();
function allowed(ip: string) {
  const now = Date.now(), current = joins.get(ip);
  if (!current || now - current.start > 60_000) { joins.set(ip, { count: 1, start: now }); return true; }
  return ++current.count <= 20;
}
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(204); res.end(); return; }
  if (req.url === '/health' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, game: 'Shiftlands', players: active.size })); return; }
  if (req.url === '/api/join' && req.method === 'POST') {
    if (!allowed(req.socket.remoteAddress ?? 'unknown')) { res.writeHead(429); res.end('Too many joins. Try again in a minute.'); return; }
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 512) throw new Rejection('Join request too large.'); }
      const data: unknown = JSON.parse(body);
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['name', 'token'].includes(k))) throw new Rejection('Invalid join request.');
      const { name, token } = data as { name?: unknown; token?: unknown };
      const result = game.join(name, token);
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ token: result.token, id: result.player.id, name: result.player.name }));
    } catch (e) { res.writeHead(400); res.end(e instanceof Rejection ? e.message : 'Invalid join request.'); }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const paths: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/game.js': ['game.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const entry = paths[req.url ?? '/'];
  if (!entry) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const contents = await readFile(resolve(publicDir, entry[0]));
    res.setHeader('Content-Type', entry[1]);
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data:; base-uri 'none'; object-src 'none'");
    res.setHeader('Cache-Control', entry[0] === 'index.html' ? 'no-cache' : 'public, max-age=3600');
    res.end(req.method === 'HEAD' ? undefined : contents);
  } catch { res.writeHead(500); res.end('Build assets with npm run build.'); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
const awaitingPong = new Set<WebSocket>();
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/socket' || wss.clients.size >= 32) { socket.destroy(); return; }
  const ip = req.socket.remoteAddress ?? 'unknown', now = Date.now(), entry = upgrades.get(ip);
  if (!entry || now - entry.start >= 60_000) upgrades.set(ip, { count: 1, start: now });
  else if (++entry.count > 60) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
const exact = (data: Record<string, unknown>, keys: string[]) => Object.keys(data).length === keys.length && Object.keys(data).every(k => keys.includes(k));
const send = (ws: WebSocket, value: unknown) => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65_536) ws.send(JSON.stringify(value)); };
wss.on('connection', ws => {
  ws.on('pong', () => awaitingPong.delete(ws));
  let id: string | undefined;
  let count = 0, windowAt = Date.now();
  const authTimer = setTimeout(() => ws.close(1008, 'Authenticate first'), 5000);
  ws.on('message', raw => {
    try {
      const now = Date.now();
      if (now - windowAt >= 1000) { count = 0; windowAt = now; }
      if (++count > 35) { ws.close(1008, 'Rate limit'); return; }
      const value: unknown = JSON.parse(raw.toString());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Rejection('Invalid command.');
      const data = value as Record<string, unknown>;
      if (!id) {
        if (data.type !== 'auth' || !exact(data, ['type', 'token'])) throw new Rejection('Private identity required.');
        const candidate = game.authenticate(data.token);
        if (active.has(candidate)) { send(ws, { type: 'error', message: 'Already playing in another tab. Close that tab, or wait for an interrupted connection to expire.', retryAfterMs: HEARTBEAT_MS * 2 + 500 }); ws.close(1008, 'Duplicate session'); return; }
        id = candidate;
        clearTimeout(authTimer);
        active.set(id, { socket: ws, dx: 0, dy: 0, inputAt: now, seq: -1, actionAt: actionTimes.get(id) ?? 0 });
        send(ws, { type: 'welcome', id });
        return;
      }
      const session = active.get(id)!;
      if (typeof data.seq !== 'number' || !Number.isSafeInteger(data.seq) || data.seq < 0 || data.seq <= session.seq) throw new Rejection('Duplicate or invalid command sequence.');
      if (data.type === 'input') {
        if (!exact(data, ['type', 'seq', 'dx', 'dy']) || typeof data.dx !== 'number' || typeof data.dy !== 'number' || !Number.isFinite(data.dx) || !Number.isFinite(data.dy) || Math.abs(data.dx) > 1 || Math.abs(data.dy) > 1) throw new Rejection('Invalid movement.');
        session.seq = data.seq; session.dx = data.dx; session.dy = data.dy; session.inputAt = now;
      } else if (data.type === 'gather' || data.type === 'contribute') {
        if (!exact(data, data.type === 'gather' ? ['type', 'seq', 'node'] : ['type', 'seq', 'resource']) || typeof (data.type === 'gather' ? data.node : data.resource) !== 'string') throw new Rejection('Invalid action.');
        session.seq = data.seq;
        if (now - session.actionAt < 350) throw new Rejection('Take a breath before the next action.');
        session.actionAt = now;
        actionTimes.set(id, now);
        const message = data.type === 'gather' ? game.gather(id, data.node as string) : game.contribute(id, data.resource as Resource);
        send(ws, { type: 'notice', message });
      } else throw new Rejection('Unknown command.');
    } catch (e) {
      send(ws, { type: 'error', message: e instanceof Rejection ? e.message : 'Invalid command.' });
    }
  });
  ws.on('error', () => {});
  ws.on('close', () => { clearTimeout(authTimer); awaitingPong.delete(ws); if (id && active.get(id)?.socket === ws) active.delete(id); });
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (awaitingPong.has(ws)) ws.terminate();
    else if (ws.readyState === WebSocket.OPEN) { awaitingPong.add(ws); ws.ping(); }
  }
}, HEARTBEAT_MS);
let lastTick = Date.now();
const timer = setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  const shifted = game.shift();
  for (const [id, session] of active) {
    if (now - session.inputAt < 300) game.move(id, session.dx, session.dy, dt);
    if (shifted) send(session.socket, { type: 'notice', message: 'The islands shifted! Northern route changed; loose travelers returned safely to camp. Your pack is safe.' });
  }
  const players = [...active.keys()].map(id => game.player(id));
  for (const [id, session] of active) send(session.socket, { type: 'snapshot', you: id, players, nodes: game.nodes, world: game.world, now });
  for (const [ip, entry] of joins) if (now - entry.start > 60_000) joins.delete(ip);
  for (const [ip, entry] of upgrades) if (now - entry.start > 60_000) upgrades.delete(ip);
  for (const [id, time] of actionTimes) if (now - time > 60_000) actionTimes.delete(id);
}, 100);
server.listen(PORT, HOST, () => console.log(`Shiftlands listening http://${HOST}:${PORT}; DB ${DB_PATH}; cap 32 connections`));
function shutdown() {
  clearInterval(timer);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  wss.close();
  server.close(() => { game.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
