import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { Game, Rejection } from '../src/world.js';
import { connectedStep, onLand, SHIFT_MS, SPEED } from '../src/shared.js';
let counter = 0;
function fixture() {
  const path = `.work/tests/unit-${process.pid}-${counter++}.sqlite`;
  rmSync(path, { force: true });
  let now = 1_000_000;
  const game = new Game(path, () => now);
  return { game, path, advance: (ms: number) => { now += ms; } };
}
function position(game: Game, id: string, x: number, y: number) {
  game.db.prepare('UPDATE players SET x=?,y=? WHERE id=?').run(x,y,id);
}
test('private bearer identity cannot be reclaimed with nickname, player ID, malformed or fake token', () => {
  const {game} = fixture();
  try {
    const a=game.join('Fern'), b=game.join('Fern');
    assert.notEqual(a.token,b.token); assert.notEqual(a.player.id,b.player.id);
    assert.equal(game.join('ignored',a.token).player.id,a.player.id);
    for(const token of [a.player.id,'Fern','x'.repeat(43),null,{},[],42]) assert.throws(()=>game.authenticate(token),Rejection);
    for(const name of ['<img onerror=x>','a'.repeat(19),'',null]) assert.throws(()=>game.join(name),Rejection);
    const rows=game.db.prepare('SELECT token FROM players').all() as {token:string}[];
    assert.ok(rows.every(row=>row.token!==a.token && row.token!==b.token));
  } finally {game.close();}
});
test('movement is normalized, bounded, connected, finite and limited to authoritative speed', () => {
  const {game} = fixture();
  try {
    const {player}=game.join('Runner');
    const start=game.player(player.id);game.move(player.id,1,1,.1);
    const end=game.player(player.id);assert.ok(Math.hypot(end.x-start.x,end.y-start.y)<=SPEED*.1+.0001);
    for(const args of [[Infinity,0,.1],[2,0,.1],[0,NaN,.1],[1,0,1],[0,0,-1]]) assert.throws(()=>game.move(player.id,args[0],args[1],args[2]),Rejection);
    position(game,player.id,400,370); for(let i=0;i<40;i++) game.move(player.id,0,1,.1);
    assert.ok(game.player(player.id).y<390);
    assert.equal(onLand(-1,300,game.world),false);
    assert.equal(onLand(400,450,game.world),false);
    assert.equal(connectedStep(180,300,400,105,{phase:1,tier:0}),false);
  } finally {game.close();}
});
test('range, locked island, empty inventory and resource schema reject without minting', () => {
  const {game}=fixture();
  try {
    const {player}=game.join('Keeper');
    assert.throws(()=>game.gather(player.id,'willow'),/Too far/);
    assert.throws(()=>game.gather(player.id,'sunstone'),/not open/);
    assert.throws(()=>game.gather(player.id,'__proto__'),Rejection);
    assert.throws(()=>game.contribute(player.id,'wood'),/No wood/);
    assert.throws(()=>game.contribute(player.id,'wood=99' as 'wood'),/Unknown resource/);
    assert.deepEqual(game.player(player.id).inventory,{wood:0,crystal:0,amber:0});
    assert.deepEqual(game.world.bank,{wood:0,crystal:0,amber:0});
  } finally {game.close();}
});
test('concurrent claims of the final node cannot mint twice; failed and double contributions conserve resources', async () => {
  const {game}=fixture();
  try {
    const a=game.join('A').player,b=game.join('B').player;
    position(game,a.id,180,300);position(game,b.id,180,300);
    game.db.prepare("UPDATE nodes SET remaining=1 WHERE id='willow'").run();
    const claims=await Promise.allSettled([Promise.resolve().then(()=>game.gather(a.id,'willow')),Promise.resolve().then(()=>game.gather(b.id,'willow'))]);
    assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(game.player(a.id).inventory.wood+game.player(b.id).inventory.wood,1);
    assert.equal(game.nodes[0].remaining,0);
    const winner=game.player(a.id).inventory.wood ? a : b;
    assert.throws(()=>game.contribute(winner.id,'wood'),/Too far/);
    assert.equal(game.player(winner.id).inventory.wood,1);
    position(game,winner.id,400,340);
    const contributions=await Promise.allSettled([Promise.resolve().then(()=>game.contribute(winner.id,'wood')),Promise.resolve().then(()=>game.contribute(winner.id,'wood'))]);
    assert.equal(contributions.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(game.world.bank.wood,1);assert.equal(game.player(winner.id).inventory.wood,0);
  } finally {game.close();}
});
test('transaction rollback is atomic; inventory, upgrades, world clock, offline players survive DB reopen', () => {
  const f=fixture();const game=f.game;
  const p=game.join('Persistent').player;
  game.db.prepare('UPDATE players SET wood=4,crystal=2,amber=4 WHERE id=?').run(p.id);
  assert.throws(()=>game.transaction(()=>{game.db.prepare('UPDATE players SET wood=0 WHERE id=?').run(p.id);throw Error('abort');}),/abort/);
  assert.equal(game.player(p.id).inventory.wood,4);
  for(let i=0;i<4;i++)game.contribute(p.id,'wood');
  for(let i=0;i<2;i++)game.contribute(p.id,'crystal');
  assert.equal(game.world.tier,1);assert.equal(onLand(400,450,game.world),true);
  for(let i=0;i<3;i++)game.contribute(p.id,'amber');
  assert.equal(game.world.tier,2);
  position(game,p.id,300,190);const pack=game.player(p.id).inventory;
  f.advance(SHIFT_MS);assert.equal(game.shift(),true);
  assert.equal(game.world.phase,1);assert.deepEqual(game.player(p.id).inventory,pack);assert.equal(game.player(p.id).x,400);
  const expected=game.world;game.close();
  const reopen=new Game(f.path,()=>1_000_000+SHIFT_MS);
  try {assert.deepEqual(reopen.world,expected);assert.deepEqual(reopen.player(p.id).inventory,pack);}finally{reopen.close();}
  const offline=new Game(f.path,()=>1_000_000+SHIFT_MS*4);
  try {assert.equal(offline.world.shifts,4);assert.equal(offline.world.tier,2);assert.deepEqual(offline.player(p.id).inventory,pack);}finally{offline.close();}
});
test('completed requirements reject surplus contributions without consuming the pack', () => {
  const {game}=fixture();
  try {
    const p=game.join('Surplus').player;
    game.db.prepare('UPDATE players SET wood=6 WHERE id=?').run(p.id);
    for(let i=0;i<4;i++)game.contribute(p.id,'wood');
    assert.throws(()=>game.contribute(p.id,'wood'),/Enough wood/);
    assert.equal(game.world.bank.wood,4);assert.equal(game.player(p.id).inventory.wood,2);
  } finally {game.close();}
});
function awaitMessage(ws:WebSocket,predicate:(data:Record<string,unknown>)=>boolean,timeout=3000):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.off('message',handle);reject(Error('WS message timeout'));},timeout);
    const handle=(raw:Buffer)=>{const data=JSON.parse(raw.toString()) as Record<string,unknown>;if(predicate(data)){clearTimeout(timer);ws.off('message',handle);resolve(data);}};
    ws.on('message',handle);
  });
}
async function socket(token: string) {
  const ws=new WebSocket('ws://127.0.0.1:3101/socket');
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const welcome=awaitMessage(ws,d=>d.type==='welcome'||d.type==='error');
  ws.send(JSON.stringify({type:'auth',token}));return {ws,result:await welcome};
}
test('real protocol rejects stolen IDs, duplicate sessions/sequences, teleport/schema/payload/rate abuse', async () => {
  const path=`.work/tests/network-${process.pid}.sqlite`;rmSync(path,{force:true});
  const processServer:ChildProcess=spawn(process.execPath,['dist/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'3101',DB_PATH:path},stdio:'pipe'});
  const connections:WebSocket[]=[];
  let serverLog='';processServer.stderr?.on('data',d=>{serverLog+=d.toString();});
  try {
    for(let i=0;i<80;i++){try{if((await fetch('http://127.0.0.1:3101/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
    const join=async(name:string)=>await (await fetch('http://127.0.0.1:3101/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})).json() as {token:string;id:string};
    const a=await join('Protocol'),b=await join('Protocol');
    assert.notEqual(a.id,b.id);
    const primary=await socket(a.token);connections.push(primary.ws);assert.equal(primary.result.type,'welcome');
    const duplicate=await socket(a.token);connections.push(duplicate.ws);assert.match(String(duplicate.result.message),/another tab/);
    const stolen=await socket(a.id);connections.push(stolen.ws);assert.match(String(stolen.result.message),/Invalid private/);
    const second=await socket(b.token);connections.push(second.ws);assert.equal(second.result.type,'welcome');
    const ws=primary.ws;
    const rejects=async(command:unknown,pattern:RegExp)=>{
      const received=awaitMessage(ws,d=>d.type==='error');ws.send(typeof command==='string'?command:JSON.stringify(command));assert.match(String((await received).message),pattern);
    };
    await rejects({type:'input',seq:0,dx:999,dy:0},/Invalid movement/);
    await rejects({type:'input',seq:0,dx:0,dy:0,x:180,y:300},/Invalid movement/);
    await rejects({type:'gather',seq:0,node:'willow'},/Too far/);
    await rejects({type:'gather',seq:0,node:'willow'},/Duplicate/);
    await rejects({type:'contribute',seq:1,resource:'wood'},/breath/);
    await rejects('{"type":',/Invalid command/);
    await rejects({type:'input',seq:1.2,dx:0,dy:0},/sequence/);
    const snap=await awaitMessage(ws,d=>d.type==='snapshot');
    assert.ok(!JSON.stringify(snap).includes(a.token));assert.ok(!JSON.stringify(snap).includes(b.token));
    const player=(snap.players as {id:string;x:number;y:number;inventory:{wood:number}}[]).find(p=>p.id===a.id)!;
    assert.equal(player.x,400);assert.equal(player.y,340);assert.equal(player.inventory.wood,0);
    // SQL only sets adversarial fixtures; gameplay E2E never mutates world state.
    const fixtureDb=new Game(path);
    try {
      position(fixtureDb,a.id,180,300);position(fixtureDb,b.id,180,300);
      fixtureDb.db.prepare("UPDATE nodes SET remaining=1 WHERE id='willow'").run();
      await new Promise(r=>setTimeout(r,400));
      const claims=[awaitMessage(ws,d=>d.type==='notice'||d.type==='error'),awaitMessage(second.ws,d=>d.type==='notice'||d.type==='error')];
      ws.send(JSON.stringify({type:'gather',seq:100,node:'willow'}));
      second.ws.send(JSON.stringify({type:'gather',seq:100,node:'willow'}));
      const results=await Promise.all(claims);
      assert.equal(results.filter(d=>d.type==='notice').length,1);
      assert.equal(fixtureDb.player(a.id).inventory.wood+fixtureDb.player(b.id).inventory.wood,1);
      assert.equal(fixtureDb.nodes[0].remaining,0);
      const winner=fixtureDb.player(a.id).inventory.wood?a.id:b.id;
      const winnerWs=winner===a.id?ws:second.ws;
      position(fixtureDb,winner,400,300);await new Promise(r=>setTimeout(r,400));
      const notices=awaitMessage(winnerWs,d=>d.type==='notice');
      const rejection=awaitMessage(winnerWs,d=>d.type==='error');
      winnerWs.send(JSON.stringify({type:'contribute',seq:101,resource:'wood'}));
      winnerWs.send(JSON.stringify({type:'contribute',seq:101,resource:'wood'}));
      await notices;assert.match(String((await rejection).message),/Duplicate/);
      assert.equal(fixtureDb.world.bank.wood,1);assert.equal(fixtureDb.player(winner).inventory.wood,0);
    } finally {fixtureDb.close();}
    const close=new Promise<number>(r=>ws.once('close',code=>r(code)));
    for(let i=0;i<45;i++)ws.send(JSON.stringify({type:'input',seq:200+i,dx:0,dy:0}));
    assert.equal(await close,1008);
    const huge=await socket(b.token+'x');connections.push(huge.ws);
    const payloadClose=new Promise<number>(r=>huge.ws.once('close',code=>r(code)));
    huge.ws.send('x'.repeat(2048));assert.equal(await payloadClose,1009);
    assert.equal((await fetch('http://127.0.0.1:3101/health')).status,200);
    assert.equal((await fetch('http://127.0.0.1:3101/.work/world.sqlite')).status,404);
    assert.equal((await fetch('http://127.0.0.1:3101/api/join',{method:'POST',body:JSON.stringify({name:'<script>x</script>'})})).status,400);
  } finally {
    for(const ws of connections)ws.terminate();
    processServer.kill('SIGTERM');
    await new Promise<void>(r=>{if(processServer.exitCode!==null)r();else processServer.once('exit',()=>r());});
    assert.ok(!serverLog.includes('TypeError'),serverLog);
  }
});
