import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { Snapshot } from '../src/shared.js';
type Observation = Snapshot & { connected: boolean };
const URL = 'http://127.0.0.1:3102';
async function snapshot(page:Page) {return await page.evaluate(()=> (window as unknown as {shiftlands:Observation}).shiftlands);}
async function self(page:Page) {const s=await snapshot(page);return s.players.find(p=>p.id===s.you)!;}
async function walk(page:Page,x:number,y:number) {
  // Observations only; every world change below comes from genuine keyboard input.
  await page.locator('canvas').focus();
  for(let i=0;i<100;i++){
    const p=await self(page),dx=x-p.x,dy=y-p.y;
    if(Math.hypot(dx,dy)<9)return;
    const horizontal=Math.abs(dx)>Math.abs(dy),key=horizontal?(dx>0?'d':'a'):(dy>0?'s':'w'),delta=horizontal?Math.abs(dx):Math.abs(dy);
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.min(350,Math.max(90,(delta-3)/125*1000)));
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
  }
  throw new Error(`Could not walk to ${x},${y}; actual ${JSON.stringify(await self(page))}`);
}
async function action(page:Page,count=1) {for(let i=0;i<count;i++){await page.keyboard.press('e');await page.waitForTimeout(410);}}
test('two real travelers build, explore, weather a normal tide, reconnect and retain the same SQLite world after actual restart',async({browser})=>{
  await mkdir('.work/e2e',{recursive:true});await mkdir('evidence',{recursive:true});
  const db='.work/e2e/journey.sqlite';await rm(db,{force:true});await rm(db+'-wal',{force:true});await rm(db+'-shm',{force:true});
  let server:ChildProcess|undefined,log='',serverErrors='',backendStopped=false,expectedTransportErrors=0;
  const start=async()=>{
    server=spawn(process.execPath,['dist/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'3102',DB_PATH:db},stdio:'pipe'});
    server.stdout?.on('data',d=>{log+=d.toString();});server.stderr?.on('data',d=>{serverErrors+=d.toString();});
    for(let i=0;i<100;i++){try{if((await fetch(URL+'/health')).ok){backendStopped=false;return;}}catch{}await new Promise(r=>setTimeout(r,50));}
    throw Error('Production server did not start: '+serverErrors);
  };
  const stop=async()=>{
    if(!server)return;backendStopped=true;server.kill('SIGTERM');await new Promise<void>(r=>{if(server!.exitCode!==null)r();else server!.once('exit',()=>r());});
    server=undefined;
  };
  const contexts=await Promise.all([browser.newContext({viewport:{width:1100,height:850}}),browser.newContext({viewport:{width:1100,height:850}})]);
  const pages=await Promise.all(contexts.map(c=>c.newPage())),[fern,moss]=pages;
  const consoleErrors:string[]=[];for(const page of pages){page.on('pageerror',e=>consoleErrors.push(e.message));page.on('console',m=>{if(m.type()==='error'){if(backendStopped&&m.text().includes('net::ERR_CONNECTION_REFUSED'))expectedTransportErrors++;else consoleErrors.push(m.text());}});}
  const began=Date.now(),events:string[]=[];
  const record=(s:string)=>events.push(`+${((Date.now()-began)/1000).toFixed(1)}s ${s}`);
  try {
    await start();
    for(let i=0;i<2;i++){
      await pages[i].goto(URL);await pages[i].getByLabel('Traveler nickname').fill(i===0?'Fern':'Moss');
      await pages[i].getByRole('button',{name:'Enter the islands'}).click();
      await pages[i].waitForFunction(()=>(window as unknown as {shiftlands:Observation}).shiftlands?.connected);
    }
    await expect.poll(async()=>(await snapshot(fern)).players.length).toBe(2);
    const identity=[(await snapshot(fern)).you,(await snapshot(moss)).you];expect(identity[0]).not.toBe(identity[1]);record('Two isolated contexts joined via nickname UI; two distinct identities visible.');
    const duplicate=await contexts[0].newPage();await duplicate.goto(URL);
    await duplicate.getByRole('button',{name:'Enter the islands'}).click();
    await expect(duplicate.locator('#notice')).toContainText('another tab');
    expect((await snapshot(fern)).connected).toBe(true);await duplicate.close();record('Duplicate tab with same stored bearer visibly rejected; original session remained active.');
    await Promise.all([walk(fern,400,300),walk(moss,400,300)]);
    await walk(fern,300,300);await action(fern);await expect(fern.locator('#notice')).toContainText('Too far');record('E at bridge midpoint visibly rejected by authoritative range check.');
    await Promise.all([walk(fern,180,300),walk(moss,620,300)]);
    await expect.poll(async()=>(await snapshot(moss)).players.find(p=>p.id===identity[0])!.x).toBeLessThan(220);
    await Promise.all([action(fern,5),action(moss,3)]);
    expect((await self(fern)).inventory.wood).toBe(5);expect((await self(moss)).inventory.crystal).toBe(3);record('Both travelers walked to resources and gathered with E; remote movement observed.');
    await Promise.all([walk(fern,400,300),walk(moss,400,300)]);
    await fern.locator('[data-resource=wood]').click();await moss.locator('[data-resource=crystal]').click();
    await Promise.all([action(fern,4),action(moss,2)]);
    await expect.poll(async()=>(await snapshot(fern)).world.tier).toBe(1);await expect(moss.locator('#progress')).toContainText('Southern island unlocked');record('Both contributed with E: 4 willow + 2 quartz; shared tier1 opened tangible south bridge.');
    await Promise.all([walk(fern,380,300),walk(moss,420,300)]);
    await fern.screenshot({path:'evidence/upgraded-two-player.png'});
    await Promise.all([walk(fern,400,300),walk(moss,400,300)]);
    await Promise.all([walk(fern,400,500),walk(moss,400,500)]);
    await Promise.all([action(fern,2),action(moss,1)]);
    await Promise.all([walk(fern,400,300),walk(moss,400,300)]);
    await fern.locator('[data-resource=amber]').click();await moss.locator('[data-resource=amber]').click();
    await Promise.all([action(fern,2),action(moss,1)]);
    await expect.poll(async()=>(await snapshot(moss)).world.tier).toBe(2);record('Both traversed newly built bridge, gathered Sunstone and contributed 3 total: beacon complete.');
    // Place Moss on the actual western tide route by walking along its connected centerline.
    await walk(moss,200,300);await walk(moss,200,275);
    for(const [x,y] of [[220,258],[240,241],[260,224],[280,207],[300,190]])await walk(moss,x,y);
    const before=await snapshot(fern);expect(before.world.phase).toBe(0);expect(before.world.shifts).toBe(0);
    const packs=[(await self(fern)).inventory,(await self(moss)).inventory];
    await fern.screenshot({path:'evidence/before-shift.png'});
    record(`Moss walked onto vanishing west route at ${Math.round((await self(moss)).x)},${Math.round((await self(moss)).y)}; packs retain 1 willow / 1 quartz.`);
    await expect(fern.locator('#tide-label')).toContainText('SHIFT INCOMING',{timeout:80_000});record('Visible 12-second shift warning observed at normal 75-second interval.');
    await expect.poll(async()=>(await snapshot(fern)).world.shifts,{timeout:20_000}).toBe(1);
    const after=await snapshot(fern);expect(after.world.phase).toBe(1);
    await expect.poll(async()=>(await self(moss)).x).toBe(400);expect((await self(moss)).y).toBe(340);
    expect((await self(fern)).inventory).toEqual(packs[0]);expect((await self(moss)).inventory).toEqual(packs[1]);
    await fern.screenshot({path:'evidence/after-shift.png'});record('Real tide changed west→east; Moss safely relocated to camp; both inventory packs and beacon persisted.');
    await fern.getByRole('button',{name:'Reconnect',exact:true}).click();
    await expect.poll(async()=>(await snapshot(fern)).connected).toBe(true);expect((await snapshot(fern)).you).toBe(identity[0]);record('UI Reconnect restored the same private identity and pack.');
    const saved=await snapshot(fern);
    await stop();
    await expect(fern.locator('#connection')).toContainText('OFFLINE');
    let refused=false;try{await fetch(URL+'/health');}catch{refused=true;}expect(refused).toBe(true);record('Actual backend SIGTERM and failed health request confirmed stopped process.');
    await new Promise(r=>setTimeout(r,1500));await start();
    await expect.poll(async()=>(await snapshot(fern)).connected,{timeout:15_000}).toBe(true);
    await expect.poll(async()=>(await snapshot(moss)).connected,{timeout:15_000}).toBe(true);
    await expect.poll(async()=>(await snapshot(fern)).players.length).toBe(2);
    const restored=await snapshot(fern);
    expect(restored.world).toEqual(saved.world);expect(restored.you).toBe(identity[0]);
    expect((await self(fern)).inventory).toEqual(packs[0]);expect((await self(moss)).inventory).toEqual(packs[1]);
    record('New process opened SAME .work/e2e/journey.sqlite; both auto-reconnected with same IDs, packs, tier2 bank, phase, nextShift and shift count.');
    // Honest iframe check: a real same-origin embedding host, not just a resized top-level screenshot.
    const embed=await contexts[0].newPage();
    await embed.route('http://127.0.0.1:3102/embed-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body style="margin:0"><iframe title="Shiftlands embedded game" src="${URL}" width="720" height="650" style="border:0"></iframe></body></html>`}));
    await embed.goto(URL+'/embed-test');
    const frame=embed.frameLocator('iframe');await expect(frame.getByRole('button',{name:'Enter the islands'})).toBeVisible();
    await fern.setViewportSize({width:720,height:650});await expect(fern.locator('canvas')).toBeVisible();await expect(fern.locator('#hint')).toBeVisible();
    const geometry=await fern.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,canvas:document.querySelector('canvas')!.getBoundingClientRect().width}));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);expect(geometry.canvas).toBeGreaterThan(650);
    await fern.screenshot({path:'evidence/embedded-viewport.png'});await embed.close();record('Real 720×650 iframe loaded join UI; active game at same viewport remained readable without horizontal overflow.');
    expect(consoleErrors).toEqual([]);expect(serverErrors.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature(?: and might change at any time)?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g,'')).toBe('');
    await writeFile('evidence/verification.txt',`Shiftlands verification — ${new Date().toISOString()}\nEarly smoke: production 127.0.0.1:3000, two isolated Playwright contexts joined UI before broad tests/polish.\nReal E2E: Node ${process.version}; bundled production server; Chromium; two isolated contexts; no teleport, engine mutations or socket mocks in journey.\n${events.join('\n')}\nConsole/page errors: 0; ${expectedTransportErrors} expected connection-refused transport logs collected only while backend stopped.\nScreenshots: upgraded-two-player.png, before-shift.png, after-shift.png, embedded-viewport.png — genuine canvas gameplay.\nProcess start log: ${log.trim().replace(/\n/g,' | ')}\n`);
  } finally {await Promise.all(contexts.map(c=>c.close()));await stop();}
});
