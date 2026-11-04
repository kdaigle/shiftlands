import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { Game, Rejection, type Timings } from '../src/world.js';
import { CAMP, connectedStep, flood, NODE_LAYOUT, onLand, SHIFT_MS, SPEED, STARTER_WALL, surgeHeight, TILES, tileAt, tileCenter, WIDTH } from '../src/shared.js';
mkdirSync('.work/tests', { recursive: true });
function fixture(options: Timings = {}) {
  const directory=mkdtempSync(join('.work/tests','unit-')),path=join(directory,'world.sqlite');
  let now = 1_000_000;
  const game = new Game(path, () => now, options);
  game.shift(true);
  return { game, path, advance: (ms: number) => { now += ms; }, cleanup:()=>rmSync(directory,{recursive:true,force:true}) };
}
function position(game: Game, id: string, x: number, y: number) {
  game.db.prepare('UPDATE players SET x=?,y=? WHERE id=?').run(x,y,id);
}
function statePatch(game: Game, patch: Record<string, unknown>) {
  const row=game.db.prepare('SELECT data FROM tide_state WHERE id=1').get() as {data:string};
  game.db.prepare('UPDATE tide_state SET data=? WHERE id=1').run(JSON.stringify({...JSON.parse(row.data),...patch}));
}
test('hand-authored terrain, guided single choke and sea-connected four-neighbor flooding',()=>{
  assert.equal(SHIFT_MS,90_000);
  assert.equal(TILES.length,384);
  assert.equal(TILES[7*WIDTH+9].elevation,2);
  assert.equal(tileAt(CAMP.x,CAMP.y)?.elevation,8);
  for(const height of [3,4,5,6]) assert.ok(!flood(height).includes(tileAt(CAMP.x,CAMP.y)!.id));
  assert.ok(flood(3).includes(7*WIDTH+9));
  const wall={tile:STARTER_WALL,kind:'wood' as const,hp:3,owner:'owner'};
  const outer=NODE_LAYOUT.find(n=>n.id==='shore-grove')!;
  assert.equal(outer.tile,7*WIDTH+5);assert.equal(TILES[outer.tile].elevation,1);assert.equal(outer.capacity,18);
  assert.ok(flood(3,[wall]).includes(outer.tile));
  assert.ok(!flood(3,[wall]).includes(7*WIDTH+9));
  assert.ok(flood(4,[wall]).includes(7*WIDTH+9));
  assert.ok(flood(3,[{...wall,hp:0}]).includes(7*WIDTH+9));
  assert.ok(!flood(5,[{...wall,kind:'stone'}]).includes(7*WIDTH+9));
  assert.ok(flood(6,[{...wall,kind:'stone'}]).includes(7*WIDTH+9));
  assert.deepEqual(Array.from({length:16},(_,i)=>surgeHeight(i+1)),[3,4,3,5,4,5,3,6,3,4,3,5,4,5,3,6]);
  for(const n of NODE_LAYOUT.filter(n=>n.id.startsWith('haven-'))) assert.ok(TILES[n.tile].elevation>=7);
  for(const [x,y] of [[NaN,1],[Infinity,0],[-1,0],[768,0],[0,512]]) assert.equal(tileAt(x,y),undefined);
  for(const id of [-1,384,.5,NaN]) assert.throws(()=>tileCenter(id),RangeError);
});
test('wall costs, buildability, range, repairs and personal milestones are authoritative',()=>{
  const {game,cleanup}=fixture();
  try{
    const p=game.join('Builder').player, marker=tileCenter(STARTER_WALL+1);
    game.db.prepare('UPDATE players SET wood=10,stone=4 WHERE id=?').run(p.id);
    assert.throws(()=>game.build(p.id,STARTER_WALL,'wood'),/Too far/);
    position(game,p.id,marker.x,marker.y);
    for(const id of [-1,384,.1,NaN,Infinity]) for(const action of [()=>game.build(p.id,id,'wood'),()=>game.repair(p.id,id),()=>game.salvage(p.id,id)]) assert.throws(action,Rejection);
    assert.throws(()=>game.build(p.id,STARTER_WALL,'__proto__' as 'wood'),Rejection);
    assert.throws(()=>game.build(p.id,7*WIDTH+9,'wood'),/grove/);
    for (const standing of [tileCenter(STARTER_WALL),tileCenter(STARTER_WALL+WIDTH+1),{x:tileCenter(STARTER_WALL-2).x+15,y:marker.y}]) {
      position(game,p.id,standing.x,standing.y);
      assert.throws(()=>game.build(p.id,STARTER_WALL,'wood'),/adjacent/);
      assert.equal(game.player(p.id).inventory.wood,10);
    }
    position(game,p.id,marker.x,marker.y);
    game.build(p.id,STARTER_WALL,'wood');
    assert.equal(game.player(p.id).inventory.wood,7);assert.equal(game.player(p.id).built,1);
    assert.equal(game.player(p.id).objective.built,true);assert.equal(game.player(p.id).objective.held,false);
    assert.throws(()=>game.build(p.id,STARTER_WALL,'wood'),/already/);
    assert.throws(()=>game.repair(p.id,STARTER_WALL),/already/);
    game.db.prepare('UPDATE walls SET hp=1').run();game.repair(p.id,STARTER_WALL);
    assert.equal(game.world.walls[0].hp,3);assert.equal(game.player(p.id).inventory.wood,6);
    game.db.prepare('UPDATE walls SET hp=0').run();game.build(p.id,STARTER_WALL,'stone');
    assert.deepEqual(game.player(p.id).inventory,{wood:5,stone:1});assert.equal(game.world.walls[0].hp,5);
    game.db.prepare('UPDATE walls SET hp=1').run();game.repair(p.id,STARTER_WALL);
    assert.equal(game.player(p.id).inventory.stone,0);
    game.db.prepare('UPDATE walls SET hp=1').run();assert.throws(()=>game.repair(p.id,STARTER_WALL),/Need 1 stone/);
    assert.equal(game.world.walls[0].hp,1);
  }finally{game.close();cleanup();}
});
test('real surge matches forecast, rewards actual owner holds, wears walls and sweeps only carried packs including offline travelers',()=>{
  const f=fixture(),game=f.game;
  try{
    const owner=game.join('Owner').player,offline=game.join('Offline').player,safe=game.join('Safe').player;
    const marker=tileCenter(STARTER_WALL),field=tileCenter(7*WIDTH+9),shore=tileCenter(7*WIDTH+6);
    position(game,owner.id,field.x,field.y);
    game.gather(owner.id,'grove');game.gather(owner.id,'grove');game.gather(owner.id,'grove');
    assert.equal(game.player(owner.id).objective.gathered,3);
    game.build(owner.id,STARTER_WALL,'wood');
    assert.equal(game.world.walls[0].tile,STARTER_WALL);
    game.db.prepare('UPDATE players SET wood=5,stone=2 WHERE id=?').run(offline.id);position(game,offline.id,shore.x,shore.y);
    game.db.prepare('UPDATE players SET wood=4,stone=3 WHERE id=?').run(safe.id);
    position(game,safe.id,CAMP.x,CAMP.y);game.contribute(safe.id,'wood');
    const predicted=game.world.forecast;
    f.advance(SHIFT_MS);game.shift(true);
    assert.deepEqual(game.world.flooded,predicted);assert.equal(game.world.shifts,1);
    assert.equal(game.player(owner.id).objective.held,true);assert.equal(game.world.walls[0].hp,2);
    assert.equal(game.player(owner.id).swept,0);
    assert.equal(game.player(offline.id).swept,1);assert.deepEqual(game.player(offline.id).inventory,{wood:0,stone:0});
    assert.deepEqual({x:game.player(offline.id).x,y:game.player(offline.id).y},CAMP);assert.match(game.player(offline.id).notice,/pack was lost/);
    assert.deepEqual(game.player(safe.id).inventory,{wood:3,stone:3});assert.equal(game.world.bank.wood,1);
    assert.equal(game.nodes.find(n=>n.id==='grove')!.remaining,9);
    position(game,safe.id,marker.x,marker.y);assert.throws(()=>game.build(safe.id,7*WIDTH+7,'wood'),/flooded/);
    f.advance(8000);game.shift();assert.equal(game.world.stage,'recede');
    assert.equal(game.nodes.find(n=>n.id==='grove')!.remaining,12);
    f.advance(5000);game.shift();assert.equal(game.world.tide,2);
    f.advance(SHIFT_MS);game.shift();
    assert.equal(game.world.walls[0].hp,0);assert.equal(game.nodes.find(n=>n.id==='grove')!.remaining,0);
    assert.equal(game.player(owner.id).swept,1);assert.equal(game.player(owner.id).objective.held,true);
  }finally{game.close();f.cleanup();}
});
test('flooded groves stay empty at recession, safe recovery renews, salvage is server validated and washed on reflood',()=>{
  const f=fixture(),game=f.game;
  try{
    const p=game.join('Recovery').player;
    for(let i=0;i<8;i++)game.gather(p.id,'haven-grove');
    assert.throws(()=>game.gather(p.id,'haven-grove'),/Empty/);
    f.advance(SHIFT_MS);game.shift();
    const grove=game.nodes.find(n=>n.id==='grove')!;
    assert.equal(grove.remaining,0);assert.equal(game.world.salvage.length,0);
    f.advance(8000);game.shift();
    assert.equal(game.nodes.find(n=>n.id==='grove')!.remaining,0);
    assert.equal(game.nodes.find(n=>n.id==='haven-grove')!.remaining,8);
    position(game,p.id,grove.x,grove.y);
    const gathered=game.player(p.id).objective.gathered;game.salvage(p.id,grove.tile);game.salvage(p.id,grove.tile);
    assert.equal(game.player(p.id).objective.gathered,gathered);
    assert.throws(()=>game.salvage(p.id,grove.tile),/No driftwood/);
    assert.throws(()=>game.salvage(p.id,1),/Too far/);
    f.advance(5000);game.shift();f.advance(SHIFT_MS);game.shift();
    assert.equal(game.world.salvage.length,0);
  }finally{game.close();f.cleanup();}
});
test('zero connected players pauses every stage and no startup or reconnect catchup occurs',()=>{
  const f=fixture(),game=f.game;
  try{
    f.advance(1000);game.shift(true);const remaining=game.world.remainingMs;
    f.advance(100000);game.shift(false);assert.equal(game.world.remainingMs,remaining);
    f.advance(100000);game.shift(true);assert.equal(game.world.remainingMs,remaining);
    f.advance(remaining-15000);game.shift(true);assert.equal(game.world.stage,'warning');
    f.advance(100000);game.shift(false);assert.equal(game.world.stage,'warning');
    f.advance(100000);game.shift(true);assert.equal(game.world.stage,'warning');
    f.advance(15000);game.shift(true);assert.equal(game.world.stage,'surge');
    f.advance(100000);game.shift(false);assert.equal(game.world.stage,'surge');
    f.advance(100000);game.shift(true);assert.equal(game.world.stage,'surge');
    f.advance(8000);game.shift();assert.equal(game.world.stage,'recede');
  }finally{game.close();f.cleanup();}
});
test('a final wall hold remains dry for the entire surge, then broken walls no longer block forecasts; all milestones persist',()=>{
  const f=fixture(),game=f.game;
  let closed=false;
  try{
    const identity=game.join('Last Hold'),p=identity.player,field=tileCenter(7*WIDTH+9);
    position(game,p.id,field.x,field.y);
    for(let i=0;i<3;i++)game.gather(p.id,'grove');
    game.build(p.id,STARTER_WALL,'wood');game.db.prepare('UPDATE walls SET hp=1').run();
    const prediction=game.world.forecast;f.advance(SHIFT_MS);game.shift();
    assert.deepEqual(game.world.forecast,prediction);assert.deepEqual(game.world.flooded,prediction);
    assert.equal(game.world.walls[0].hp,0);assert.equal(game.player(p.id).objective.held,true);
    const expected=game.world,player=game.player(p.id);game.close();closed=true;
    const reopened=new Game(f.path,()=>9_000_000);
    try{
      assert.deepEqual(reopened.world,expected);assert.deepEqual(reopened.join(null,identity.token).player,player);
      reopened.shift(true);assert.deepEqual(reopened.world,expected);
      reopened.shift(false);assert.equal(reopened.world.stage,'surge');
    }finally{reopened.close();}
  }finally{if(!closed)game.close();f.cleanup();}
});
test('King Tide overtops every material and sweeps low players, while haven and bank remain safe',()=>{
  const f=fixture(),game=f.game;
  try{
    const p=game.join('Kingwatch').player,field=tileCenter(7*WIDTH+9);
    game.db.prepare('UPDATE players SET wood=2,stone=3 WHERE id=?').run(p.id);
    game.contribute(p.id,'wood');position(game,p.id,field.x,field.y);game.build(p.id,STARTER_WALL,'stone');
    statePatch(game,{tide:8});const prediction=game.world.forecast;
    assert.ok(prediction.includes(7*WIDTH+9));assert.ok(!prediction.includes(tileAt(CAMP.x,CAMP.y)!.id));
    f.advance(SHIFT_MS);game.shift();
    assert.deepEqual(game.world.flooded,prediction);assert.equal(game.world.height,6);
    assert.equal(game.player(p.id).objective.held,false);assert.equal(game.player(p.id).swept,1);
    assert.equal(game.world.walls[0].hp,0);assert.equal(game.world.bank.wood,1);
    assert.equal(game.player(p.id).x,CAMP.x);
  }finally{game.close();f.cleanup();}
});
test('invalid wall costs and high ground never consume materials; disconnected non-load-bearing walls earn no hold',()=>{
  const f=fixture(),game=f.game;
  try{
    const p=game.join('Learner').player,marker=tileCenter(STARTER_WALL+1),shore=tileCenter(WIDTH+3);
    position(game,p.id,marker.x,marker.y);
    assert.throws(()=>game.build(p.id,STARTER_WALL,'wood'),/Need 3 wood/);
    game.db.prepare('UPDATE players SET wood=3,stone=2 WHERE id=?').run(p.id);
    assert.throws(()=>game.build(p.id,STARTER_WALL,'stone'),/Need 3 stone/);
    assert.deepEqual(game.player(p.id).inventory,{wood:3,stone:2});
    position(game,p.id,CAMP.x,CAMP.y);assert.throws(()=>game.build(p.id,tileAt(CAMP.x,CAMP.y)!.id,'wood'),/low ground/);
    position(game,p.id,shore.x,shore.y);game.build(p.id,WIDTH+2,'wood');
    assert.equal(game.player(p.id).objective.built,false);
    position(game,p.id,CAMP.x,CAMP.y);f.advance(SHIFT_MS);game.shift();
    assert.equal(game.player(p.id).objective.held,false);
  }finally{game.close();f.cleanup();}
});
test('only building and holding the marked starter wall completes the guided objectives',()=>{
  const f=fixture(),game=f.game;
  try{
    const p=game.join('Alternate Builder').player,standing=tileCenter(STARTER_WALL);
    position(game,p.id,standing.x,standing.y);
    game.db.prepare('UPDATE players SET wood=3 WHERE id=?').run(p.id);
    game.build(p.id,STARTER_WALL-1,'wood');
    assert.equal(game.player(p.id).objective.built,false);
    assert.ok(!game.world.forecast.includes(STARTER_WALL+1));
    f.advance(SHIFT_MS);game.shift();
    assert.equal(game.world.walls[0].hp,2);
    assert.equal(game.player(p.id).objective.held,false);
    assert.equal(game.player(p.id).built,1);
  }finally{game.close();f.cleanup();}
});
test('starter construction is shared with current and late players; a real hold credits everyone who gathered three',()=>{
  const f=fixture(),game=f.game;
  try{
    const owner=game.join('Builder').player,helper=game.join('Helper').player,passive=game.join('Newcomer').player,field=tileCenter(STARTER_WALL+1);
    for(const p of [owner,helper]) {
      position(game,p.id,field.x,field.y);
      for(let i=0;i<3;i++)game.gather(p.id,'grove');
    }
    game.build(owner.id,STARTER_WALL,'wood');
    for(const p of [owner,helper,passive]) assert.equal(game.player(p.id).objective.built,true);
    assert.equal(game.player(owner.id).built,1);assert.equal(game.player(helper.id).built,0);
    const late=game.join('Late Join').player;
    assert.equal(late.objective.built,true);assert.equal(late.objective.held,false);
    position(game,late.id,field.x,field.y);
    for(let i=0;i<3;i++)game.gather(late.id,'grove');
    assert.throws(()=>game.build(late.id,STARTER_WALL,'wood'),/already built together/);
    assert.equal(game.player(late.id).inventory.wood,3);
    f.advance(SHIFT_MS);game.shift();
    for(const p of [owner,helper,late]) assert.equal(game.player(p.id).objective.held,true);
    assert.equal(game.player(passive.id).objective.held,false);
    const after=game.join('After Surge').player;
    assert.equal(after.objective.built,true);assert.equal(after.objective.held,false);
    position(game,after.id,field.x,field.y);
    for(let i=0;i<3;i++)game.gather(after.id,'grove');
    assert.equal(game.player(after.id).objective.held,false);
    game.db.prepare('UPDATE walls SET hp=0 WHERE tile=?').run(STARTER_WALL);
    assert.equal(game.join('After Break').player.objective.built,true);
  }finally{game.close();f.cleanup();}
});
test('every surge replaces stale hold notices even when the owner remains safe at the haven',()=>{
  const f=fixture(),game=f.game;
  try{
    const p=game.join('Safe Builder').player,field=tileCenter(STARTER_WALL+1);
    position(game,p.id,field.x,field.y);
    for(let i=0;i<3;i++)game.gather(p.id,'grove');
    game.build(p.id,STARTER_WALL,'wood');
    position(game,p.id,CAMP.x,CAMP.y);
    f.advance(SHIFT_MS);game.shift();
    assert.match(game.player(p.id).notice,/held back tide 1/);
    assert.equal(game.player(p.id).objective.held,true);
    f.advance(8000);game.shift();f.advance(5000);game.shift();
    f.advance(SHIFT_MS);game.shift();
    assert.match(game.player(p.id).notice,/Tide 2 surged at height 4/);
    assert.doesNotMatch(game.player(p.id).notice,/held back tide 1/);
    assert.equal(game.player(p.id).objective.held,true);
    assert.equal(game.player(p.id).swept,0);
    assert.equal(game.world.walls[0].hp,0);
  }finally{game.close();f.cleanup();}
});
test('stone walls wear once on each held surge and their last hit protects land until recession',()=>{
  const f=fixture(),game=f.game;
  try{
    const p=game.join('Mason').player,field=tileCenter(STARTER_WALL+1);
    position(game,p.id,field.x,field.y);
    for(let i=0;i<3;i++)game.gather(p.id,'grove');
    game.db.prepare('UPDATE players SET wood=1,stone=3 WHERE id=?').run(p.id);
    game.build(p.id,STARTER_WALL,'stone');
    for(let tide=1;tide<=5;tide++){
      assert.equal(game.world.tide,tide);
      assert.ok(!game.world.forecast.includes(STARTER_WALL+1));
      f.advance(SHIFT_MS);game.shift();
      assert.equal(game.world.walls[0].hp,5-tide);
      assert.ok(!game.world.flooded.includes(STARTER_WALL+1));
      assert.equal(game.player(p.id).swept,0);
      f.advance(8000);game.shift();f.advance(5000);game.shift();
    }
    assert.ok(game.world.forecast.includes(STARTER_WALL+1));
    f.advance(SHIFT_MS);game.shift();
    assert.equal(game.player(p.id).swept,1);assert.equal(game.player(p.id).objective.held,true);
  }finally{game.close();f.cleanup();}
});
test('a redundant sea-exposed front wall wears while its sheltered backup does not; objective still needs marginal pocket protection',()=>{
  const f=fixture(),game=f.game;
  try{
    const p=game.join('Layered Defenses').player,field=tileCenter(STARTER_WALL+1),marker=tileCenter(STARTER_WALL);
    position(game,p.id,field.x,field.y);
    for(let i=0;i<6;i++)game.gather(p.id,'grove');
    game.build(p.id,STARTER_WALL,'wood');
    position(game,p.id,marker.x,marker.y);game.build(p.id,STARTER_WALL-1,'wood');
    const prediction=game.world.forecast;
    assert.ok(!prediction.includes(STARTER_WALL+1));
    f.advance(SHIFT_MS);game.shift();
    assert.deepEqual(game.world.flooded,prediction);
    assert.equal(game.world.walls.find(w=>w.tile===STARTER_WALL-1)!.hp,2);
    assert.equal(game.world.walls.find(w=>w.tile===STARTER_WALL)!.hp,3);
    assert.equal(game.player(p.id).objective.held,false);
    assert.equal(game.player(p.id).swept,0);
  }finally{game.close();f.cleanup();}
});
test('legacy migration preserves hashed identity and materials without retaining old quests',()=>{
  const directory=mkdtempSync(join('.work/tests','legacy-')),path=join(directory,'world.sqlite');
  const legacy=new DatabaseSync(path);
  legacy.exec("CREATE TABLE players(id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,name TEXT NOT NULL,x REAL NOT NULL,y REAL NOT NULL,wood INTEGER NOT NULL DEFAULT 0,crystal INTEGER NOT NULL DEFAULT 0,amber INTEGER NOT NULL DEFAULT 0); CREATE TABLE world(id INTEGER PRIMARY KEY,phase INTEGER,nextShift INTEGER,tier INTEGER,wood INTEGER,crystal INTEGER,amber INTEGER,shifts INTEGER); INSERT INTO players VALUES('identity','hashed-secret','Legacy',180,300,9,7,3); INSERT INTO world VALUES(1,1,1,2,4,2,3,999);");legacy.close();
  const game=new Game(path,()=>1_000_000);
  try{
    const p=game.player('identity');assert.deepEqual(p.inventory,{wood:9,stone:10});assert.deepEqual(p.objective,{gathered:0,built:false,held:false});assert.equal(p.x,CAMP.x);
    assert.equal((game.db.prepare("SELECT token FROM players WHERE id='identity'").get() as {token:string}).token,'hashed-secret');
    assert.deepEqual(game.world.bank,{wood:4,stone:2});assert.equal(game.world.shifts,0);assert.equal(game.world.lookout,false);
  }finally{game.close();rmSync(directory,{recursive:true,force:true});}
});
test('private bearer identity cannot be reclaimed with nickname, player ID, malformed or fake token', () => {
  const {game,cleanup} = fixture();
  try {
    const a=game.join('Fern'), b=game.join('Fern');
    assert.notEqual(a.token,b.token); assert.notEqual(a.player.id,b.player.id);
    assert.equal(game.join('ignored',a.token).player.id,a.player.id);
    for(const token of [a.player.id,'Fern','x'.repeat(43),null,{},[],42]) assert.throws(()=>game.authenticate(token),Rejection);
    for(const name of ['<img onerror=x>','a'.repeat(19),'',null]) assert.throws(()=>game.join(name),Rejection);
    const rows=game.db.prepare('SELECT token FROM players').all() as {token:string}[];
    assert.ok(rows.every(row=>row.token!==a.token && row.token!==b.token));
  } finally {game.close();cleanup();}
});
test('movement is normalized, bounded, connected, finite and limited to authoritative speed', () => {
  const {game,cleanup} = fixture();
  try {
    const {player}=game.join('Runner');
    const start=game.player(player.id);game.move(player.id,1,1,.1);
    const end=game.player(player.id);assert.ok(Math.hypot(end.x-start.x,end.y-start.y)<=SPEED*.1+.0001);
    for(const args of [[Infinity,0,.1],[2,0,.1],[0,NaN,.1],[1,0,1],[0,0,-1]]) assert.throws(()=>game.move(player.id,args[0],args[1],args[2]),Rejection);
    position(game,player.id,16,16); for(let i=0;i<40;i++) game.move(player.id,-1,0,.1);
    assert.ok(game.player(player.id).x>=0);
    assert.equal(onLand(-1,300,game.world),false);
    assert.equal(onLand(400,511,game.world),false);
    assert.equal(connectedStep(16,16,400,105,{flooded:[]}),false);
  } finally {game.close();cleanup();}
});
test('range, unknown nodes, empty inventory and resource schema reject without minting', () => {
  const {game,cleanup}=fixture();
  try {
    const {player}=game.join('Keeper');
    assert.throws(()=>game.gather(player.id,'grove'),/Too far/);
    assert.throws(()=>game.gather(player.id,'sunstone'),/Unknown/);
    assert.throws(()=>game.gather(player.id,'__proto__'),Rejection);
    assert.throws(()=>game.contribute(player.id,'wood'),/No wood/);
    assert.throws(()=>game.contribute(player.id,'wood=99' as 'wood'),/Unknown resource/);
    assert.deepEqual(game.player(player.id).inventory,{wood:0,stone:0});
    assert.deepEqual(game.world.bank,{wood:0,stone:0});
  } finally {game.close();cleanup();}
});
test('concurrent claims of the final node cannot mint twice; failed and double contributions conserve resources', async () => {
  const {game,cleanup}=fixture();
  try {
    const a=game.join('A').player,b=game.join('B').player;
    const grove=tileCenter(7*WIDTH+9);
    position(game,a.id,grove.x,grove.y);position(game,b.id,grove.x,grove.y);
    game.db.prepare("UPDATE nodes SET remaining=1 WHERE id='grove'").run();
    const claims=await Promise.allSettled([Promise.resolve().then(()=>game.gather(a.id,'grove')),Promise.resolve().then(()=>game.gather(b.id,'grove'))]);
    assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(game.player(a.id).inventory.wood+game.player(b.id).inventory.wood,1);
    assert.equal(game.nodes[0].remaining,0);
    const winner=game.player(a.id).inventory.wood ? a : b;
    assert.throws(()=>game.contribute(winner.id,'wood'),/Too far/);
    assert.equal(game.player(winner.id).inventory.wood,1);
    position(game,winner.id,CAMP.x,CAMP.y);
    const contributions=await Promise.allSettled([Promise.resolve().then(()=>game.contribute(winner.id,'wood')),Promise.resolve().then(()=>game.contribute(winner.id,'wood'))]);
    assert.equal(contributions.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(game.world.bank.wood,1);assert.equal(game.player(winner.id).inventory.wood,0);
  } finally {game.close();cleanup();}
});
test('transaction rollback, Lookout, objectives, materials and paused clock survive DB reopen without catchup', () => {
  const f=fixture();const game=f.game;
  let closed=false;
  try {
  const p=game.join('Persistent').player;
  game.db.prepare('UPDATE players SET wood=15,stone=8 WHERE id=?').run(p.id);
  assert.throws(()=>game.transaction(()=>{game.db.prepare('UPDATE players SET wood=0 WHERE id=?').run(p.id);throw Error('abort');}),/abort/);
  assert.equal(game.player(p.id).inventory.wood,15);
  for(let i=0;i<12;i++)game.contribute(p.id,'wood');
  for(let i=0;i<8;i++)game.contribute(p.id,'stone');
  assert.equal(game.world.lookout,true);assert.equal(game.world.warningMs,30_000);
  assert.deepEqual(game.world.nextHeights,[4,3]);
  assert.deepEqual(game.world.nextForecasts.map(f=>f.tiles),[flood(4),flood(3)]);
  f.advance(1234);game.shift(true);
  const pack=game.player(p.id).inventory;
  const expected=game.world;game.close();closed=true;
  const reopen=new Game(f.path,()=>1_000_000+SHIFT_MS);
  try {assert.deepEqual(reopen.world,expected);assert.deepEqual(reopen.player(p.id).inventory,pack);reopen.shift(true);assert.deepEqual(reopen.world,expected);}finally{reopen.close();}
  const offline=new Game(f.path,()=>1_000_000+SHIFT_MS*4);
  try {assert.deepEqual(offline.world,expected);assert.deepEqual(offline.player(p.id).inventory,pack);}finally{offline.close();}
  } finally {try {if(!closed)game.close();} finally {f.cleanup();}}
});
test('completed requirements reject surplus contributions without consuming the pack', () => {
  const {game,cleanup}=fixture();
  try {
    const p=game.join('Surplus').player;
    game.db.prepare('UPDATE players SET wood=14 WHERE id=?').run(p.id);
    for(let i=0;i<12;i++)game.contribute(p.id,'wood');
    assert.throws(()=>game.contribute(p.id,'wood'),/Enough wood/);
    assert.equal(game.world.bank.wood,12);assert.equal(game.player(p.id).inventory.wood,2);
  } finally {game.close();cleanup();}
});
function awaitMessage(ws:WebSocket,predicate:(data:Record<string,unknown>)=>boolean,timeout=3000):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.off('message',handle);reject(Error('WS message timeout'));},timeout);
    const handle=(raw:Buffer)=>{const data=JSON.parse(raw.toString()) as Record<string,unknown>;if(predicate(data)){clearTimeout(timer);ws.off('message',handle);resolve(data);}};
    ws.on('message',handle);
  });
}
function awaitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('WS close timeout')),3000);
    ws.once('close',code=>{clearTimeout(timer);resolve(code);});
  });
}
async function availablePort(): Promise<number> {
  const listener=createServer();
  await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const address=listener.address();
  assert.ok(address && typeof address!=='string');
  await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
  return address.port;
}
async function socket(token: string, url: string, autoPong=true) {
  const ws=new WebSocket(url,{autoPong});
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const welcome=awaitMessage(ws,d=>d.type==='welcome'||d.type==='error');
  ws.send(JSON.stringify({type:'auth',token}));return {ws,result:await welcome};
}
test('real protocol rejects stolen IDs, duplicate sessions/sequences, teleport/schema/payload/rate abuse', async () => {
  const directory=mkdtempSync(join('.work/tests','network-')),path=join(directory,'world.sqlite');
  const port=await availablePort(),base=`http://127.0.0.1:${port}`,url=`ws://127.0.0.1:${port}/socket`;
  const processServer:ChildProcess=spawn(process.execPath,['dist/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DB_PATH:path},stdio:'pipe'});
  const connections:WebSocket[]=[];
  let serverLog='';processServer.stderr?.on('data',d=>{serverLog+=d.toString();});
  try {
    for(let i=0;i<80;i++){try{if((await fetch(`${base}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
    const join=async(name:string)=>await (await fetch(`${base}/api/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})).json() as {token:string;id:string};
    const a=await join('Protocol'),b=await join('Protocol');
    assert.notEqual(a.id,b.id);
    const primary=await socket(a.token,url);connections.push(primary.ws);assert.equal(primary.result.type,'welcome');
    const duplicate=await socket(a.token,url);connections.push(duplicate.ws);assert.match(String(duplicate.result.message),/another tab/);
    const stolen=await socket(a.id,url);connections.push(stolen.ws);assert.match(String(stolen.result.message),/Invalid private/);
    const second=await socket(b.token,url);connections.push(second.ws);assert.equal(second.result.type,'welcome');
    let ws=primary.ws;
    const rejects=async(command:unknown,pattern:RegExp)=>{
      const received=awaitMessage(ws,d=>d.type==='error');ws.send(typeof command==='string'?command:JSON.stringify(command));assert.match(String((await received).message),pattern);
    };
    await rejects({type:'input',seq:0,dx:999,dy:0},/Invalid movement/);
    await rejects({type:'input',seq:0,dx:0,dy:0,x:180,y:300},/Invalid movement/);
    await rejects({type:'build',seq:0,tile:STARTER_WALL,kind:'wood',wood:999},/Invalid action/);
    await rejects({type:'build',seq:0,tile:STARTER_WALL,kind:'__proto__'},/Invalid action/);
    await rejects({type:'repair',seq:0,tile:-1},/Invalid action/);
    await rejects({type:'salvage',seq:0,tile:NaN},/Invalid action/);
    await rejects({type:'salvage',seq:0,tile:STARTER_WALL,x:0},/Invalid action/);
    await rejects({type:'gather',seq:0,node:'grove'},/Too far/);
    await rejects({type:'gather',seq:0,node:'grove'},/Duplicate/);
    await rejects({type:'contribute',seq:1,resource:'wood'},/breath/);
    await rejects('{"type":',/Invalid command/);
    await rejects({type:'input',seq:1.2,dx:0,dy:0},/sequence/);
    const snap=await awaitMessage(ws,d=>d.type==='snapshot');
    assert.ok(!JSON.stringify(snap).includes(a.token));assert.ok(!JSON.stringify(snap).includes(b.token));
    const player=(snap.players as {id:string;x:number;y:number;inventory:{wood:number}}[]).find(p=>p.id===a.id)!;
    assert.equal(player.x,CAMP.x);assert.equal(player.y,CAMP.y);assert.equal(player.inventory.wood,0);
    // SQL only sets adversarial fixtures; gameplay E2E never mutates world state.
    const fixtureDb=new Game(path);
    try {
      const grove=tileCenter(7*WIDTH+9);
      position(fixtureDb,a.id,grove.x,grove.y);position(fixtureDb,b.id,grove.x,grove.y);
      fixtureDb.db.prepare("UPDATE nodes SET remaining=1 WHERE id='grove'").run();
      await new Promise(r=>setTimeout(r,400));
      const claims=[awaitMessage(ws,d=>d.type==='notice'||d.type==='error'),awaitMessage(second.ws,d=>d.type==='notice'||d.type==='error')];
      ws.send(JSON.stringify({type:'gather',seq:100,node:'grove'}));
      second.ws.send(JSON.stringify({type:'gather',seq:100,node:'grove'}));
      const results=await Promise.all(claims);
      assert.equal(results.filter(d=>d.type==='notice').length,1);
      assert.equal(fixtureDb.player(a.id).inventory.wood+fixtureDb.player(b.id).inventory.wood,1);
      assert.equal(fixtureDb.nodes[0].remaining,0);
      const winner=fixtureDb.player(a.id).inventory.wood?a.id:b.id;
      const winnerWs=winner===a.id?ws:second.ws;
      position(fixtureDb,winner,CAMP.x,CAMP.y);await new Promise(r=>setTimeout(r,400));
      const notices=awaitMessage(winnerWs,d=>d.type==='notice');
      const rejection=awaitMessage(winnerWs,d=>d.type==='error');
      winnerWs.send(JSON.stringify({type:'contribute',seq:101,resource:'wood'}));
      winnerWs.send(JSON.stringify({type:'contribute',seq:101,resource:'wood'}));
      await notices;assert.match(String((await rejection).message),/Duplicate/);
      assert.equal(fixtureDb.world.bank.wood,1);assert.equal(fixtureDb.player(winner).inventory.wood,0);
      const closed=new Promise<void>(r=>winnerWs.once('close',()=>r()));winnerWs.close();await closed;
      const resumed=await socket(winner===a.id?a.token:b.token,url);connections.push(resumed.ws);
      const cooldown=awaitMessage(resumed.ws,d=>d.type==='error');
      resumed.ws.send(JSON.stringify({type:'gather',seq:0,node:'grove'}));
      assert.match(String((await cooldown).message),/breath/);
      if(winner===a.id)ws=resumed.ws;else second.ws=resumed.ws;
      position(fixtureDb,a.id,CAMP.x,CAMP.y);position(fixtureDb,b.id,CAMP.x,CAMP.y);
      fixtureDb.db.prepare('UPDATE players SET wood=0,stone=1').run();
      statePatch(fixtureDb,{bank:{wood:12,stone:7},lookout:false});
      await new Promise(r=>setTimeout(r,400));
      const lookoutRace=[awaitMessage(ws,d=>d.type==='notice'||d.type==='error'),awaitMessage(second.ws,d=>d.type==='notice'||d.type==='error')];
      ws.send(JSON.stringify({type:'contribute',seq:200,resource:'stone'}));
      second.ws.send(JSON.stringify({type:'contribute',seq:200,resource:'stone'}));
      const lookoutResults=await Promise.all(lookoutRace);
      assert.equal(lookoutResults.filter(d=>d.type==='notice').length,1);
      assert.match(String(lookoutResults.find(d=>d.type==='notice')!.message),/Lookout built/);
      assert.match(String(lookoutResults.find(d=>d.type==='error')!.message),/Enough stone/);
      assert.equal(fixtureDb.world.lookout,true);assert.equal(fixtureDb.world.bank.stone,8);
      assert.equal(fixtureDb.player(a.id).inventory.stone+fixtureDb.player(b.id).inventory.stone,1);
      const marker=tileCenter(STARTER_WALL+1);
      position(fixtureDb,a.id,marker.x,marker.y);position(fixtureDb,b.id,marker.x,marker.y);
      fixtureDb.db.prepare('UPDATE players SET wood=3').run();
      await new Promise(r=>setTimeout(r,400));
      const wallRace=[awaitMessage(ws,d=>d.type==='notice'||d.type==='error'),awaitMessage(second.ws,d=>d.type==='notice'||d.type==='error')];
      ws.send(JSON.stringify({type:'build',seq:201,tile:STARTER_WALL,kind:'wood'}));
      second.ws.send(JSON.stringify({type:'build',seq:201,tile:STARTER_WALL,kind:'wood'}));
      const wallResults=await Promise.all(wallRace);
      assert.equal(wallResults.filter(d=>d.type==='notice').length,1);
      assert.match(String(wallResults.find(d=>d.type==='notice')!.message),/wall built/);
      assert.match(String(wallResults.find(d=>d.type==='error')!.message),/already built together/);
      assert.equal(fixtureDb.world.walls.length,1);
      assert.equal(fixtureDb.player(a.id).inventory.wood+fixtureDb.player(b.id).inventory.wood,3);
      for(const client of [ws,second.ws]){
        const remote=await awaitMessage(client,d=>d.type==='snapshot');
        assert.equal((remote.world as {lookout:boolean}).lookout,true);
      }
    } finally {fixtureDb.close();}
    const close=awaitClose(ws);
    for(let i=0;i<80;i++)ws.send(JSON.stringify({type:'input',seq:1000+i,dx:0,dy:0}));
    assert.equal(await close,1008);
    const huge=await socket(b.token+'x',url);connections.push(huge.ws);
    const payloadClose=awaitClose(huge.ws);
    huge.ws.send('x'.repeat(2048));assert.equal(await payloadClose,1009);
    assert.equal((await fetch(`${base}/health`)).status,200);
    assert.equal((await fetch(`${base}/favicon.ico`)).status,204);
    assert.equal((await fetch(`${base}/.work/world.sqlite`)).status,404);
    assert.equal((await fetch(`${base}/api/join`,{method:'POST',body:JSON.stringify({name:'<script>x</script>'})})).status,400);
  } finally {
    for(const ws of connections)ws.terminate();
    processServer.kill('SIGTERM');
    await new Promise<void>(r=>{if(processServer.exitCode!==null)r();else processServer.once('exit',()=>r());});
    rmSync(directory,{recursive:true,force:true});
    assert.ok(!serverLog.includes('TypeError'),serverLog);
  }
});
test('heartbeat expires a non-pong half-open identity; same bearer recovers and responsive duplicate tab remains protected',async()=>{
  const directory=mkdtempSync(join('.work/tests','heartbeat-')),path=join(directory,'world.sqlite');
  const port=await availablePort(),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['dist/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DB_PATH:path,NODE_ENV:'test',TEST_HEARTBEAT_MS:'150'},stdio:'pipe'});
  const connections:WebSocket[]=[];
  const url=`ws://127.0.0.1:${port}/socket`;
  try{
    for(let i=0;i<80;i++){try{if((await fetch(`${base}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
    const identity=await(await fetch(`${base}/api/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Heartbeat'})})).json() as {id:string;token:string};
    const began=Date.now(),stalled=await socket(identity.token,url,false);connections.push(stalled.ws);assert.equal(stalled.result.type,'welcome');
    const expired=new Promise<number>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Non-pong session did not expire')),1500);
      stalled.ws.once('close',code=>{clearTimeout(timeout);resolve(code);});
    });
    const denied=await socket(identity.token,url);connections.push(denied.ws);
    assert.match(String(denied.result.message),/another tab/);assert.equal(denied.result.retryAfterMs,800);
    assert.equal(stalled.ws.readyState,WebSocket.OPEN);
    assert.equal(await expired,1006);assert.ok(Date.now()-began<1500);
    assert.equal((await(await fetch(`${base}/health`)).json() as {players:number}).players,0);
    const recovered=await socket(identity.token,url);connections.push(recovered.ws);assert.equal(recovered.result.type,'welcome');
    const state=await awaitMessage(recovered.ws,d=>d.type==='snapshot');assert.equal(state.you,identity.id);
    let pings=0;recovered.ws.on('ping',()=>pings++);
    await new Promise(r=>setTimeout(r,650));
    assert.ok(pings>=3);assert.equal(recovered.ws.readyState,WebSocket.OPEN);
    const duplicate=await socket(identity.token,url);connections.push(duplicate.ws);assert.match(String(duplicate.result.message),/another tab/);
    assert.equal(recovered.ws.readyState,WebSocket.OPEN);
    assert.equal((await(await fetch(`${base}/health`)).json() as {players:number}).players,1);
  }finally{
    for(const ws of connections)ws.terminate();child.kill('SIGTERM');
    await new Promise<void>(r=>{if(child.exitCode!==null)r();else child.once('exit',()=>r());});
    rmSync(directory,{recursive:true,force:true});
  }
});
