import { CAMP, distance, NODE_LAYOUT, RANGE, type Resource, type Snapshot } from './shared.js';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = el<HTMLCanvasElement>('world');
const ctx = canvas.getContext('2d')!;
let state: Snapshot | undefined, socket: WebSocket | undefined, seq = 0, selected: Resource = 'wood', backend = '', token = '', reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connected = false, manualClose = false, errors = 0;
const keys = new Set<string>();
const names = { wood: 'Willow', crystal: 'Quartz', amber: 'Sunstone' };
const params = new URLSearchParams(location.search);
el<HTMLInputElement>('backend').value = params.get('backend') || (location.protocol.startsWith('http') ? location.origin : '');
try { el<HTMLInputElement>('nickname').value = localStorage.getItem('shiftlands.name') || ''; } catch {}
function notice(message: string) { el('notice').textContent = message; }
function send(data: Record<string, unknown>) { if (socket?.readyState === WebSocket.OPEN && connected) socket.send(JSON.stringify({ ...data, seq: seq++ })); }
function interact() {
  if (!state) return;
  const p = state.players.find(p => p.id === state!.you);
  if (!p) return;
  if (distance(p, CAMP) <= RANGE) {
    const needed: Resource[] = state.world.tier === 0 ? ['wood', 'crystal'] : ['amber'];
    if (!needed.includes(selected) || p.inventory[selected] === 0) selected = needed.find(r => p.inventory[r] > 0) ?? selected;
    send({ type: 'contribute', resource: selected });
  } else {
    const nodes = state.nodes.filter(n => n.resource !== 'amber' || state!.world.tier >= 1);
    const nearest = nodes.sort((a, b) => distance(p, a) - distance(p, b))[0];
    send({ type: 'gather', node: nearest.id });
  }
}
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
    manualClose = true;
    old.onclose = null;
    old.addEventListener('close', () => { if (socket === old) { socket = undefined; connect(); } }, { once: true });
    old.close();
    return;
  }
  connected = false; seq = 0; manualClose = false;
  el('connection').textContent = 'CONNECTING';
  const ws = new WebSocket(backend.replace(/^http/, 'ws') + '/socket');
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = event => {
    const data = JSON.parse(event.data) as Snapshot | { type: string; message?: string };
    if (data.type === 'welcome') { connected = true; errors = 0; el('connection').textContent = 'ONLINE · PACK SAVED'; canvas.focus(); }
    if (data.type === 'snapshot') { state = data as Snapshot; renderHud(); }
    if (data.type === 'notice' || data.type === 'error') {
      notice(data.message ?? '');
      if (data.message?.includes('another tab') || data.message?.includes('private identity')) manualClose = true;
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    connected = false; keys.clear(); el('connection').textContent = 'OFFLINE · PACK SAVED';
    if (!manualClose) { notice('Connection lost. Your pack is saved; reconnecting…'); reconnectTimer = setTimeout(connect, Math.min(5000, 800 + errors++ * 600)); }
  };
  ws.onerror = () => {};
}
el('join-form').addEventListener('submit', event => { event.preventDefault(); void join(); });
el('reconnect').addEventListener('click', connect);
el('interact').addEventListener('click', interact);
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-resource]')) button.addEventListener('click', () => { selected = button.dataset.resource as Resource; if (state) renderHud(); canvas.focus(); });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-key]')) {
  button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); keys.add(button.dataset.key!); });
  const release = () => keys.delete(button.dataset.key!);
  button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release); button.addEventListener('lostpointercapture', release);
}
window.addEventListener('keydown', event => {
  if (!el('join').hidden || (event.target instanceof HTMLInputElement)) return;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','e','W','A','S','D','E'].includes(event.key)) event.preventDefault();
  if (event.key.toLowerCase() === 'e' && !event.repeat) interact();
  else keys.add(event.key.toLowerCase().startsWith('arrow') ? event.key : event.key.toLowerCase());
});
window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase().startsWith('arrow') ? event.key : event.key.toLowerCase()));
window.addEventListener('blur', () => { keys.clear(); send({ type: 'input', dx: 0, dy: 0 }); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { keys.clear(); send({ type: 'input', dx: 0, dy: 0 }); } });
setInterval(() => send({ type: 'input', dx: Number(keys.has('d') || keys.has('ArrowRight')) - Number(keys.has('a') || keys.has('ArrowLeft')), dy: Number(keys.has('s') || keys.has('ArrowDown')) - Number(keys.has('w') || keys.has('ArrowUp')) }), 100);
function renderHud() {
  if (!state) return;
  const p = state.players.find(p => p.id === state!.you);
  if (!p) return;
  const w = state.world, remaining = Math.max(0, Math.ceil((w.nextShift - state.now) / 1000));
  const needed: Resource[] = w.tier === 0 ? ['wood', 'crystal'] : ['amber'];
  if (!needed.includes(selected)) selected = needed.find(r => p.inventory[r] > 0) ?? needed[0];
  el('camp-title').textContent = w.tier === 0 ? 'Build the southern bridge' : w.tier === 1 ? 'Light the haven beacon' : 'A haven that stays';
  el('progress').textContent = w.tier === 0 ? `Willow ${w.bank.wood} / 4 · Quartz ${w.bank.crystal} / 2` : w.tier === 1 ? `Sunstone ${w.bank.amber} / 3 · Southern island unlocked` : 'Beacon complete · Gather, explore, and weather the tides together';
  el('countdown').textContent = `${remaining}s`;
  el('tide-label').textContent = remaining <= 12 ? 'SHIFT INCOMING · PACK SAFE' : 'NEXT SHIFT';
  el('countdown').parentElement!.classList.toggle('warning', remaining <= 12);
  el('route').textContent = `${w.phase === 0 ? 'West' : 'East'} northern route · Tide ${w.shifts + 1}`;
  el('population').textContent = `${state.players.length} traveler${state.players.length === 1 ? '' : 's'}`;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-resource]')) {
    const resource = button.dataset.resource as Resource;
    button.querySelector('b')!.textContent = String(p.inventory[resource]);
    button.classList.toggle('selected', selected === resource);
  }
  let hint: string;
  const nearest = state.nodes.filter(n => n.resource !== 'amber' || w.tier >= 1).sort((a, b) => distance(p, a) - distance(p, b))[0];
  if (distance(p, CAMP) <= RANGE) hint = w.tier === 2 ? 'Beacon lit! Explore the changing northern route; your pack stays safe.' : needed.some(r => p.inventory[r] > 0) ? `E · Contribute ${names[selected]} to shared camp` : w.tier === 0 ? 'Gather Willow ← and Quartz →. Return here to contribute.' : 'The southern bridge is open. Walk ↓ for Sunstone.';
  else if (distance(p, nearest) <= RANGE) hint = `E · Gather ${names[nearest.resource]} (${nearest.remaining} remaining)`;
  else hint = 'Follow a bridge to a resource. E too far away will be rejected.';
  el('hint').textContent = hint;
}
function path(ax: number, ay: number, bx: number, by: number, active = true) {
  ctx.lineCap = 'round'; ctx.strokeStyle = active ? '#142f35' : '#274c53'; ctx.lineWidth = 48; ctx.beginPath(); ctx.moveTo(ax, ay + 8); ctx.lineTo(bx, by + 8); ctx.stroke();
  ctx.strokeStyle = active ? '#a6986b' : '#36595c'; ctx.lineWidth = 35; ctx.setLineDash(active ? [] : [7, 12]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
  if (!active) return;
  const len = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / len, ny = (bx - ax) / len;
  ctx.strokeStyle = '#736c4d'; ctx.lineWidth = 2;
  for (let t = 0.04; t < 0.98; t += 12 / len) { const x = ax + (bx - ax) * t, y = ay + (by - ay) * t; ctx.beginPath(); ctx.moveTo(x + nx * 14, y + ny * 14); ctx.lineTo(x - nx * 14, y - ny * 14); ctx.stroke(); }
}
function island(x: number, y: number, rx: number, ry: number, color = '#6a9678') {
  ctx.fillStyle = '#0c2830'; ctx.beginPath(); ctx.ellipse(x, y + 13, rx + 8, ry + 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#445f4e'; ctx.beginPath(); ctx.ellipse(x, y + 8, rx + 3, ry + 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c2bb8a'; ctx.beginPath(); ctx.ellipse(x, y, rx + 4, ry + 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y - 3, rx - 5, ry - 5, 0, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 18; i++) {
    const angle = i * 2.4, r = .35 + (i % 5) * .1, gx = x + Math.cos(angle) * rx * r, gy = y + Math.sin(angle) * ry * r;
    ctx.strokeStyle = '#507c60'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(gx - 3, gy); ctx.lineTo(gx - 1, gy - 5); ctx.moveTo(gx + 1, gy); ctx.lineTo(gx + 3, gy - 4); ctx.stroke();
  }
}
function label(text: string, x: number, y: number, color = '#e8e3be', size = 10) {
  ctx.font = `600 ${size}px system-ui`; ctx.textAlign = 'center'; ctx.fillStyle = '#122f32'; ctx.fillText(text, x + 1, y + 1); ctx.fillStyle = color; ctx.fillText(text, x, y);
}
function tree(x: number, y: number, size = 1) {
  ctx.fillStyle = '#324e3a'; ctx.fillRect(x - 3 * size, y - 14 * size, 6 * size, 22 * size);
  ctx.fillStyle = '#345f4b'; ctx.beginPath(); ctx.ellipse(x, y - 24 * size, 22 * size, 24 * size, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8cbb7e'; ctx.beginPath(); ctx.ellipse(x - 3 * size, y - 30 * size, 17 * size, 17 * size, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#b2cf87'; ctx.beginPath(); ctx.ellipse(x - 8 * size, y - 33 * size, 8 * size, 10 * size, -.3, 0, Math.PI * 2); ctx.fill();
}
function crystal(x: number, y: number, amber = false) {
  ctx.fillStyle = '#33595b'; ctx.beginPath(); ctx.ellipse(x, y + 4, 22, 9, 0, 0, Math.PI * 2); ctx.fill();
  for (const [dx, height, width] of [[-14,24,11],[3,40,16],[20,21,9]]) {
    ctx.fillStyle = amber ? '#e8b64e' : '#83dbd1'; ctx.beginPath(); ctx.moveTo(x + dx - width / 2, y); ctx.lineTo(x + dx - width / 2, y - height * .7); ctx.lineTo(x + dx, y - height); ctx.lineTo(x + dx + width / 2, y - height * .7); ctx.lineTo(x + dx + width / 2, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = amber ? '#fff0a3' : '#d7fff0'; ctx.beginPath(); ctx.moveTo(x + dx, y - height); ctx.lineTo(x + dx + width / 2, y - height * .7); ctx.lineTo(x + dx, y); ctx.closePath(); ctx.fill();
  }
}
function draw(time: number) {
  ctx.fillStyle = '#103846'; ctx.fillRect(0, 0, 800, 600);
  for (let row = 0; row < 16; row++) for (let col = 0; col < 19; col++) {
    const x = col * 47 + (row % 2) * 22 + Math.sin(time / 2000 + row) * 3, y = row * 39 + 17;
    ctx.strokeStyle = (row + col) % 3 === 0 ? '#215361' : '#194651'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 7, y + 3, x + 14, y); ctx.stroke();
  }
  const w = state?.world ?? { tier: 0, phase: 0 };
  path(w.phase === 0 ? 600 : 200, 275, 400, 105, false);
  path(w.phase === 0 ? 200 : 600, 275, 400, 105);
  path(180, 300, 620, 300);
  if (w.tier >= 1) path(400, 340, 400, 500); else path(400, 375, 400, 465, false);
  island(400,105,74,49,'#769586'); island(180,300,90,72); island(620,300,90,72,'#6c998c'); island(400,300,112,86,'#8da27d');
  if (w.tier >= 1) island(400,500,87,59,'#a0a474');
  else { ctx.globalAlpha=.3; island(400,500,87,59,'#607b6f'); ctx.globalAlpha=1; }
  tree(144,280,.85); tree(178,299,1.2); tree(214,279,.8); crystal(620,299);
  tree(349,274,.6); tree(456,270,.55); crystal(400,501,true);
  ctx.fillStyle = '#63543b'; ctx.fillRect(384,284,32,19); ctx.fillStyle = '#e8c08a'; ctx.beginPath(); ctx.moveTo(376,285);ctx.lineTo(400,249);ctx.lineTo(424,285);ctx.closePath();ctx.fill();ctx.fillStyle='#a5744c';ctx.beginPath();ctx.moveTo(400,249);ctx.lineTo(400,286);ctx.lineTo(424,285);ctx.closePath();ctx.fill();ctx.fillStyle='#5b4438';ctx.fillRect(395,282,10,21);
  ctx.fillStyle='#b5b491';ctx.fillRect(393,92,14,24);ctx.fillStyle='#ecdb9c';ctx.beginPath();ctx.moveTo(388,93);ctx.lineTo(400,72);ctx.lineTo(412,93);ctx.closePath();ctx.fill();
  if (w.tier >= 2) {
    const glow=ctx.createRadialGradient(400,82,2,400,82,67);glow.addColorStop(0,'#ffe0a399');glow.addColorStop(1,'#ffdf9800');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(400,82,67,0,Math.PI*2);ctx.fill();
    label('BEACON LIT',400,143,'#ffe8ac');
  } else label('TIDEWATCH',400,143);
  label('WILLOW GROVE',180,345);label('QUARTZ REACH',620,345);label(w.tier>=1?'SUNSTONE · OPEN':'SUNSTONE · BUILD BRIDGE',400,541,w.tier>=1?'#f7dc8a':'#94aba2');
  label(w.tier===0?'CAMP · 4 WILLOW + 2 QUARTZ':w.tier===1?'CAMP · 3 SUNSTONE':'HAVEN · COMPLETE',400,326,'#fff0bd',9);
  for (const node of state?.nodes ?? []) if (node.resource !== 'amber' || w.tier >= 1) label(`${node.remaining} available`,node.x,node.y+62,'#c6d6bf',9);
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
Object.defineProperty(window, 'shiftlands', { get: () => state ? JSON.parse(JSON.stringify({ ...state, connected })) : null, configurable: false });
requestAnimationFrame(draw);
