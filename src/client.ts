import { CAMP, distance, RANGE, TILES, TILE_SIZE, WIDTH, HEIGHT, STARTER_WALL, tileAt, tileCenter, type Resource, type Snapshot } from './shared.js';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = el<HTMLCanvasElement>('world');
const ctx = canvas.getContext('2d')!;
let state: Snapshot | undefined, socket: WebSocket | undefined, seq = 0, selected: Resource = 'wood', backend = '', token = '', reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connected = false, manualClose = false, errors = 0, generation = 0, snapshotGeneration = 0;
const keys = new Set<string>();
let facing = { x: -1, y: 0 }, selectedTile: number | undefined, previousSweeps: number | undefined, previousShifts: number | undefined, previousNotice = '', forecastView = -1;
const params = new URLSearchParams(location.search);
el<HTMLInputElement>('backend').value = params.get('backend') || (location.protocol.startsWith('http') ? location.origin : '');
try { el<HTMLInputElement>('nickname').value = localStorage.getItem('shiftlands.name') || ''; } catch {}
function notice(message: string) { el('notice').textContent = message; }
function send(data: Record<string, unknown>) { if (socket?.readyState === WebSocket.OPEN && connected) socket.send(JSON.stringify({ ...data, seq: seq++ })); }
function interact() {
  if (!state) return;
  const p = state.players.find(p => p.id === state!.you);
  if (!p) return;
  const nearest = state.nodes.filter(n => n.remaining > 0).sort((a, b) => distance(p, a) - distance(p, b))[0];
  if (distance(p, CAMP) <= RANGE && (!nearest || distance(p, CAMP) <= distance(p, nearest))) {
    send({ type: 'contribute', resource: selected });
  } else {
    const salvage = state.world.salvage.filter(s => s.remaining > 0).sort((a, b) => distance(p, tileCenter(a.tile)) - distance(p, tileCenter(b.tile)))[0];
    if (salvage && distance(p, tileCenter(salvage.tile)) <= RANGE) { send({ type: 'salvage', tile: salvage.tile }); return; }
    if (nearest) send({ type: 'gather', node: nearest.id });
    else notice('No resources nearby. Receding water leaves driftwood; dry groves regrow.');
  }
}
function targetTile() {
  const p = state?.players.find(p => p.id === state!.you);
  if (!p) return undefined;
  const current = tileAt(p.x, p.y);
  if (!current) return undefined;
  if (selectedTile !== undefined) {
    const tile = TILES[selectedTile];
    if (tile && Math.abs(tile.x - current.x) + Math.abs(tile.y - current.y) === 1) return tile.id;
  }
  const x = current.x + facing.x, y = current.y + facing.y;
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT ? y * WIDTH + x : undefined;
}
function build(kind: 'wood' | 'stone') {
  const tile = targetTile();
  if (tile !== undefined) send({ type: 'build', tile, kind });
}
function repair() { const tile = targetTile(); if (tile !== undefined) send({ type: 'repair', tile }); }
async function join() {
  el('join-error').textContent = '';
  try {
    const parsed = new URL(el<HTMLInputElement>('backend').value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Use a backend origin, e.g. https://server.example (no path).');
    if (location.protocol === 'https:' && parsed.protocol !== 'https:') throw new Error('An HTTPS page needs an HTTPS / WSS backend.');
    backend = parsed.origin;
    try { token = localStorage.getItem(`shiftlands.identity:${backend}`) || ''; } catch { token = ''; }
    const response = await fetch(backend + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: el<HTMLInputElement>('nickname').value, ...(token ? { token } : {}) }) });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json() as { token: string; name: string };
    token = data.token;
    try { localStorage.setItem(`shiftlands.identity:${backend}`, token); localStorage.setItem('shiftlands.name', data.name); } catch { notice('Browser storage unavailable: keep this tab open to preserve your private identity.'); }
    el('join').hidden = true; el('play').hidden = false;
    connect();
  } catch (e) { el('join-error').textContent = e instanceof Error ? e.message : 'Unable to connect.'; }
}
function connect() {
  clearTimeout(reconnectTimer);
  if (socket && socket.readyState < WebSocket.CLOSED) {
    const old = socket;
    connected = false;
    keys.clear();
    el('connection').textContent = 'CONNECTING';
    manualClose = true;
    old.onclose = null;
    old.addEventListener('close', () => { if (socket === old) { socket = undefined; connect(); } }, { once: true });
    old.close();
    return;
  }
  connected = false; seq = 0; manualClose = false;
  el('connection').textContent = 'CONNECTING';
  const ws = new WebSocket(backend.replace(/^http/, 'ws') + '/socket');
  let duplicateSession = false, retryAfterMs = 20_500;
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = event => {
    if (socket !== ws) return;
    const data = JSON.parse(event.data) as Snapshot | { type: string; message?: string };
    if (data.type === 'welcome') { connected = true; generation++; errors = 0; el('connection').textContent = 'ONLINE · PACK SAVED'; if (generation > 1 || el('notice').textContent?.includes('another tab')) notice('Reconnected. Your private pack and shared haven are saved.'); canvas.focus(); }
    if (data.type === 'snapshot') { state = data as Snapshot; snapshotGeneration = generation; renderHud(); }
    if (data.type === 'notice' || data.type === 'error') {
      notice(data.message ?? '');
      if (data.message?.includes('another tab')) {
        duplicateSession = true;
        if ('retryAfterMs' in data && typeof data.retryAfterMs === 'number' && Number.isFinite(data.retryAfterMs)) retryAfterMs = Math.min(30_000, Math.max(500, data.retryAfterMs));
      }
      if (data.message?.includes('private identity')) manualClose = true;
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    connected = false; keys.clear(); el('connection').textContent = 'OFFLINE · PACK SAVED';
    if (!manualClose) {
      if (!duplicateSession) notice('Connection lost. Your pack is saved; reconnecting…');
      reconnectTimer = setTimeout(connect, duplicateSession ? retryAfterMs : Math.min(5000, 800 + errors++ * 600));
    }
  };
  ws.onerror = () => {};
}
el('join-form').addEventListener('submit', event => { event.preventDefault(); void join(); });
el('reconnect').addEventListener('click', connect);
el('interact').addEventListener('click', interact);
el('build-wood').addEventListener('click', () => build('wood'));
el('build-stone').addEventListener('click', () => build('stone'));
el('repair').addEventListener('click', repair);
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-forecast]')) button.addEventListener('click', () => {
  forecastView = Number(button.dataset.forecast);
  if (state) renderHud();
});
canvas.addEventListener('click', event => {
  const rect = canvas.getBoundingClientRect();
  selectedTile = tileAt((event.clientX - rect.left) / rect.width * canvas.width, (event.clientY - rect.top) / rect.height * canvas.height)?.id;
  canvas.focus();
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-resource]')) button.addEventListener('click', () => { selected = button.dataset.resource as Resource; if (state) renderHud(); canvas.focus(); });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-key]')) {
  button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); keys.add(button.dataset.key!); face(button.dataset.key!); });
  const release = () => keys.delete(button.dataset.key!);
  button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release); button.addEventListener('lostpointercapture', release);
}
window.addEventListener('keydown', event => {
  if (!el('join').hidden || (event.target instanceof HTMLInputElement)) return;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','e','b','v','r'].includes(event.key.toLowerCase().startsWith('arrow') ? event.key : event.key.toLowerCase())) event.preventDefault();
  if (event.key.toLowerCase() === 'e' && !event.repeat) interact();
  else if (event.key.toLowerCase() === 'b' && !event.repeat) build('wood');
  else if (event.key.toLowerCase() === 'v' && !event.repeat) build('stone');
  else if (event.key.toLowerCase() === 'r' && !event.repeat) repair();
  else {
    const key = event.key.toLowerCase().startsWith('arrow') ? event.key : event.key.toLowerCase();
    keys.add(key); face(key);
  }
});
function face(key: string) {
  const direction: Record<string, { x: number; y: number }> = { a: { x: -1, y: 0 }, ArrowLeft: { x: -1, y: 0 }, d: { x: 1, y: 0 }, ArrowRight: { x: 1, y: 0 }, w: { x: 0, y: -1 }, ArrowUp: { x: 0, y: -1 }, s: { x: 0, y: 1 }, ArrowDown: { x: 0, y: 1 } };
  if (direction[key]) { facing = direction[key]; selectedTile = undefined; }
}
window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase().startsWith('arrow') ? event.key : event.key.toLowerCase()));
window.addEventListener('blur', () => { keys.clear(); send({ type: 'input', dx: 0, dy: 0 }); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { keys.clear(); send({ type: 'input', dx: 0, dy: 0 }); } });
setInterval(() => send({ type: 'input', dx: Number(keys.has('d') || keys.has('ArrowRight')) - Number(keys.has('a') || keys.has('ArrowLeft')), dy: Number(keys.has('s') || keys.has('ArrowDown')) - Number(keys.has('w') || keys.has('ArrowUp')) }), 100);
function renderHud() {
  if (!state) return;
  const p = state.players.find(p => p.id === state!.you);
  if (!p) return;
  const w = state.world, remaining = Math.max(0, Math.ceil(w.remainingMs / 1000));
  el('countdown').textContent = `SURGE IN ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} · height ${w.height}`;
  el('tide-label').textContent = `${w.stage.toUpperCase()} · TIDE ${w.tide}${w.height === 6 ? ' · KING TIDE' : ''}`;
  el('countdown').parentElement!.classList.toggle('warning', w.stage === 'warning' || w.stage === 'surge');
  el('route').textContent = w.stage === 'surge' ? 'Water is up! Flooded tiles are impassable.' : w.stage === 'recede' ? 'Water recedes · collect the driftwood!' : 'Red tiles will flood · every 8th tide is height 6';
  el('forecast').textContent = w.lookout ? `LOOKOUT · Next heights: ${w.nextHeights.join(' → ')}` : 'Bank 12 wood + 8 stone for the Lookout';
  el('forecast-controls').hidden = !w.lookout;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-forecast]')) {
    const index = Number(button.dataset.forecast);
    button.classList.toggle('selected', forecastView === index);
    if (index >= 0) button.textContent = `+${index + 1} tide · height ${w.nextHeights[index] ?? '?'}`;
  }
  el('progress').textContent = w.lookout ? 'Lookout built · longer warnings · two-tide forecast' : `Lookout bank: ${w.bank.wood}/12 wood · ${w.bank.stone}/8 stone`;
  el('board-stats').textContent = `${w.dryLand} dry land held · ${w.shifts} tides weathered`;
  el('builders').textContent = `Top builders: ${w.builders.map(b => `${b.name} ${b.built}`).join(' · ') || 'Be the first!'}`;
  el('tide-events').textContent = w.events[0] ?? '';
  const objective = p.objective;
  const texts = [`Gather 3 wood from a grove. (${Math.min(3, objective.gathered)}/3)`, 'Build a wall at the glowing marker before the surge.', 'Watch your wall hold back the sea.'];
  const done = [objective.gathered >= 3, objective.built, objective.held];
  for (const [i, li] of [...el('objectives').children].entries()) { li.textContent = `${done[i] ? '✓ ' : ''}${texts[i]}`; li.classList.toggle('done', done[i]); }
  el('what-next').textContent = objective.held ? 'What next: protect more land, repair walls, or contribute to the Lookout.' : 'The glowing wall marker protects the small grove to the west.';
  if (previousSweeps !== undefined && p.swept > previousSweeps) notice('SWEPT TO THE HAVEN! Your carried materials washed away. Banked materials and shared walls are safe.');
  else if (previousShifts !== undefined && w.shifts > previousShifts) notice(`SURGE! ${w.lastFlooded.filter(id => TILES[id].elevation > 0).length} land tiles flooded; exposed nodes washed away. ${objective.held ? 'Your wall held back the sea!' : 'Repair walls and protect more land.'}`);
  if (p.notice && p.notice !== previousNotice) notice(p.notice);
  previousNotice = p.notice;
  previousSweeps = p.swept; previousShifts = w.shifts;
  el('population').textContent = `${state.players.length} traveler${state.players.length === 1 ? '' : 's'}`;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-resource]')) {
    const resource = button.dataset.resource as Resource;
    button.querySelector('b')!.textContent = String(p.inventory[resource]);
    button.classList.toggle('selected', selected === resource);
  }
  let hint: string;
  const nearest = state.nodes.filter(n => n.remaining > 0).sort((a, b) => distance(p, a) - distance(p, b))[0];
  const target = targetTile(), wall = w.walls.find(wall => wall.tile === target);
  if (wall) hint = `${wall.kind} wall · durability ${wall.hp} · R to repair (1 ${wall.kind === 'stone' ? 'stone' : 'wood'})`;
  else if (distance(p, CAMP) <= RANGE && (!nearest || distance(p, CAMP) <= distance(p, nearest))) hint = `E · Bank 1 ${selected} at the storehouse (safe from the sea)`;
  else if (w.salvage.some(s => s.remaining > 0 && distance(p, tileCenter(s.tile)) <= RANGE)) hint = 'E · Collect driftwood salvage';
  else if (nearest && distance(p, nearest) <= RANGE) hint = `E · Gather ${nearest.resource} (${nearest.remaining} remaining)`;
  else hint = 'Low shores are rich but dangerous. Highlight an adjacent tile to build.';
  el('hint').textContent = hint;
}
function label(text: string, x: number, y: number, color = '#e8e3be', size = 10) {
  ctx.font = `600 ${size}px system-ui`; ctx.textAlign = 'center'; ctx.fillStyle = '#122f32'; ctx.fillText(text, x + 1, y + 1); ctx.fillStyle = color; ctx.fillText(text, x, y);
}
function draw(time: number) {
  const w = state?.world;
  const flooded = new Set(w?.flooded), forecast = new Set(w?.forecast);
  const future = new Set(w?.lookout && forecastView >= 0 ? w.nextForecasts[forecastView]?.tiles : []);
  ctx.fillStyle = '#103846'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const tile of TILES) {
    const x = tile.x * TILE_SIZE, y = tile.y * TILE_SIZE;
    if (tile.elevation > 0 && !flooded.has(tile.id)) {
      ctx.fillStyle = tile.elevation >= 7 ? '#9aaf83' : tile.elevation >= 5 ? '#739477' : tile.elevation >= 3 ? '#648b70' : '#b0a377';
      ctx.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      ctx.fillStyle = '#163d3330'; ctx.fillRect(x + 1, y + TILE_SIZE - 4, TILE_SIZE - 2, 3);
      if (w?.stage === 'warning' && forecast.has(tile.id)) {
        ctx.fillStyle = '#ed5b5b88'; ctx.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        ctx.strokeStyle = '#ffc4b4'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + TILE_SIZE - 4, y + TILE_SIZE - 4); ctx.stroke();
      } else if (future.has(tile.id)) {
        ctx.strokeStyle = '#a4e7ef'; ctx.lineWidth = 2; ctx.strokeRect(x + 3, y + 3, TILE_SIZE - 6, TILE_SIZE - 6);
      }
      label(String(tile.elevation), x + 26, y + 28, '#e8edca99', 8);
    } else {
      ctx.strokeStyle = flooded.has(tile.id) ? '#80c4cc' : '#31606d';
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 8, y + 16); ctx.quadraticCurveTo(x + 16, y + 20 + Math.sin(time / 500 + tile.x), x + 24, y + 16); ctx.stroke();
    }
  }
  if (!state?.players.find(p => p.id === state?.you)?.objective.held) {
    const marker = tileCenter(STARTER_WALL);
    ctx.strokeStyle = '#ffe69a'; ctx.lineWidth = 3; ctx.setLineDash([5, 3]); ctx.strokeRect(marker.x - 15, marker.y - 15, 30, 30); ctx.setLineDash([]);
    label('BUILD HERE', marker.x - 23, marker.y - 22, '#ffe69a', 9);
  }
  for (const node of state?.nodes ?? []) if (node.remaining > 0) {
    if (node.resource === 'wood') {
      ctx.fillStyle = '#5c4d36'; ctx.fillRect(node.x - 2, node.y - 1, 4, 10);
      ctx.fillStyle = '#284f3e'; ctx.beginPath(); ctx.arc(node.x, node.y - 5, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#b8d890'; ctx.beginPath(); ctx.arc(node.x - 3, node.y - 9, 7, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#c5c9b9'; ctx.beginPath(); ctx.moveTo(node.x - 11, node.y + 5); ctx.lineTo(node.x - 5, node.y - 9); ctx.lineTo(node.x + 5, node.y - 12); ctx.lineTo(node.x + 11, node.y + 5); ctx.closePath(); ctx.fill();
    }
    label(String(node.remaining), node.x + 12, node.y - 9, '#fff3ce', 9);
  }
  for (const salvage of w?.salvage ?? []) if (salvage.remaining > 0) {
    const p = tileCenter(salvage.tile);
    ctx.strokeStyle = '#e3c392'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(p.x - 6, p.y + 3); ctx.lineTo(p.x + 6, p.y - 2); ctx.stroke();
  }
  for (const wall of w?.walls ?? []) {
    const p = tileCenter(wall.tile);
    ctx.fillStyle = wall.hp <= 0 ? '#4e4b46' : wall.kind === 'stone' ? '#d9ded0' : '#b67d4c';
    ctx.fillRect(p.x - 13, p.y - 10, 26, wall.hp <= 0 ? 6 : 20);
    ctx.strokeStyle = '#423e34'; ctx.lineWidth = 2; ctx.strokeRect(p.x - 13, p.y - 10, 26, wall.hp <= 0 ? 6 : 20);
    label(wall.hp > 0 ? String(wall.hp) : 'BROKEN', p.x, p.y + 3, '#fff4ce', 9);
  }
  const target = targetTile();
  if (target !== undefined) {
    const p = tileCenter(target);
    ctx.strokeStyle = '#ffffffbb'; ctx.lineWidth = 2; ctx.strokeRect(p.x - 14, p.y - 14, 28, 28);
  }
  ctx.fillStyle = '#5c4d36'; ctx.fillRect(CAMP.x - 12, CAMP.y - 8, 24, 21);
  ctx.fillStyle = '#e5c084'; ctx.beginPath(); ctx.moveTo(CAMP.x - 17, CAMP.y - 8); ctx.lineTo(CAMP.x, CAMP.y - 26); ctx.lineTo(CAMP.x + 17, CAMP.y - 8); ctx.closePath(); ctx.fill();
  label(w?.lookout ? 'STOREHOUSE + LOOKOUT' : 'STOREHOUSE · E TO BANK', CAMP.x + 30, CAMP.y + 27, '#fff0bd', 9);
  label('STARTER GROVE', 9 * TILE_SIZE + 26, 6 * TILE_SIZE + 12, '#ffe9b6', 9);
  label('LOW OUTER SHORES · RICH, BUT FIRST TO FLOOD', canvas.width / 2, canvas.height - 18, '#b8d6cc', 10);
  for (const p of state?.players ?? []) {
    const you = p.id === state?.you;
    ctx.fillStyle='#193a3c88';ctx.beginPath();ctx.ellipse(p.x,p.y+6,11,5,0,0,Math.PI*2);ctx.fill();
    if(you){ctx.strokeStyle='#ffe5a4';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(p.x,p.y+3,14,7,0,0,Math.PI*2);ctx.stroke();}
    ctx.fillStyle=you?'#e9bb70':'#9cd8c9';ctx.beginPath();ctx.roundRect(p.x-7,p.y-13,14,18,5);ctx.fill();
    ctx.fillStyle='#f5ddbc';ctx.beginPath();ctx.arc(p.x,p.y-17,6,0,Math.PI*2);ctx.fill();ctx.fillStyle=you?'#f4d293':'#b7eddf';ctx.beginPath();ctx.ellipse(p.x,p.y-21,9,4,0,0,Math.PI*2);ctx.fill();
    label(p.name+(you?' · YOU':''),p.x,p.y-33,you?'#ffe4a1':'#d6eee1',10);
  }
  requestAnimationFrame(draw);
}
Object.defineProperty(window, 'shiftlands', { get: () => state ? JSON.parse(JSON.stringify({ ...state, connected, generation, snapshotGeneration })) : null, configurable: false });
requestAnimationFrame(draw);
