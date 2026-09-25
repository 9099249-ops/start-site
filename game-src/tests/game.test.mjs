import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Simulation, onWater, angleDelta, distance } from '../src/game/Simulation.ts';
import { readRecords, saveResult, today } from '../src/game/Score.ts';
import { advanceTraffic } from '../src/game/Traffic.ts';
const map = JSON.parse(readFileSync(new URL('../src/data/map.json', import.meta.url)));
const route = JSON.parse(readFileSync(new URL('../src/data/routes.json', import.meta.url)));
const idle = { thrust: false, boost: false, turn: 0, heading: null };

test('real map provenance and all game targets are navigable', () => {
  const s = new Simulation(map, route);
  assert.match(map.source.url, /1926721/);
  assert.equal(route.checkpoints.length, 5); assert.equal(route.stars.length, 5);
  for (const p of [map.start, ...route.checkpoints, ...route.stars]) assert.ok(s.navigable(p), JSON.stringify(p));
});
test('complete the real route without traffic using steering and propulsion, collect five stars, no teleports', () => {
  const s = new Simulation({ ...map, traffic: [] }, route); const checkpoints = [];
  for (let i = 0; i < 60 * 180 && !s.finished; i++) {
    const goal = s.stars.has(s.next) ? s.target : route.stars[s.next];
    const heading = Math.atan2(goal.y - s.player.y, goal.x - s.player.x);
    s.step(1 / 60, { ...idle, heading, thrust: Math.abs(angleDelta(heading, s.player.angle)) < .9 });
    s.events.filter(e => e.type === 'checkpoint').forEach(e => checkpoints.push(e.index));
    assert.ok(onWater(s.player, map.water));
  }
  assert.ok(s.finished); assert.equal(s.stars.size, 5); assert.equal(s.collisions, 0);
  assert.deepEqual(checkpoints, [0, 1, 2, 3, 4]); assert.ok(s.time >= 60 && s.time < 180);
  console.log(`Route: ${s.time.toFixed(2)} seconds, five stars, zero collisions`);
  const time = s.time, p = { ...s.player }; s.step(1, { ...idle, thrust: true });
  assert.equal(s.time, time); assert.deepEqual(s.player, p); assert.deepEqual(s.events, []);
});
test('a later checkpoint cannot skip the route, stars only collected once', () => {
  const s = new Simulation(map, route); Object.assign(s.player, route.checkpoints[3]); s.step(1 / 60, idle);
  assert.equal(s.next, 0);
  Object.assign(s.player, route.stars[2]); s.step(1 / 60, idle); assert.equal(s.stars.size, 1);
  s.step(1 / 60, idle); assert.equal(s.stars.size, 1); assert.equal(s.events.filter(e => e.type === 'star_collected').length, 0);
});
test('board coasts and slows smoothly after releasing the paddle', () => {
  const s = new Simulation(map, route); Object.assign(s.player, route.checkpoints[2]); s.player.angle = -Math.PI / 2;
  for (let i = 0; i < 60; i++) s.step(1 / 60, { ...idle, thrust: true });
  const speed = Math.hypot(s.player.vx, s.player.vy), p = { ...s.player };
  s.step(1 / 60, idle); assert.ok(distance(p, s.player) > 0); assert.ok(Math.hypot(s.player.vx, s.player.vy) < speed);
  for (let i = 0; i < 240; i++) s.step(1 / 60, idle);
  assert.ok(Math.hypot(s.player.vx, s.player.vy) < 2);
});
test('collisions give two seconds with a cooldown, do not pass through obstacle', () => {
  const s = new Simulation(map, route), o = map.obstacles[0];
  Object.assign(s.player, { x: o.x - o.radius - 10, y: o.y, angle: 0, vx: 100 });
  s.step(1 / 60, { ...idle, thrust: true });
  assert.equal(s.collisions, 1); assert.equal(s.penalty, 2); assert.ok(distance(s.player, o) >= o.radius + 9);
  for (let i = 0; i < 60; i++) s.step(1 / 60, { ...idle, thrust: true });
  assert.equal(s.collisions, 1);
});
test('islands, piers, shore and map edges block movement', () => {
  assert.equal(onWater({ x: 5, y: 5 }, [{ outer: [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}], holes: [[{x:4,y:4},{x:6,y:4},{x:6,y:6},{x:4,y:6}]] }]), false);
  const s = new Simulation(map, route); assert.equal(s.navigable({ x: -1, y: 100 }), false);
  assert.equal(s.navigable(map.piers[0][0]), false);
});
test('shallow and restricted water reduce speed', () => {
  const m = structuredClone(map), p = route.checkpoints[2];
  m.shallows = [{ ...p, radius: 10000 }]; m.restricted = [];
  const shallow = new Simulation(m, route), normal = new Simulation({ ...m, shallows: [] }, route);
  for (const s of [shallow, normal]) { Object.assign(s.player, p); for (let i=0;i<60;i++) s.step(1/60, {...idle,thrust:true}); }
  assert.ok(Math.hypot(shallow.player.vx,shallow.player.vy) < Math.hypot(normal.player.vx,normal.player.vy));
  assert.match(shallow.zone, /Мелководье/);
  m.restricted = [{ ...p, radius: 10000 }]; const restricted = new Simulation(m,route); restricted.step(1/60,idle); assert.match(restricted.zone,/Запретная/);
});
test('boost drains energy and resting replenishes it', () => {
  const s = new Simulation(map,route); Object.assign(s.player,route.checkpoints[2]);
  for(let i=0;i<120;i++) s.step(1/60,{...idle,thrust:true,boost:true});
  assert.ok(s.energy < .5); const energy=s.energy;
  for(let i=0;i<120;i++) s.step(1/60,idle);
  assert.ok(s.energy>energy && s.energy<=1);
});
test('records survive reload, daily rollover, corrupt and unavailable storage', () => {
  const memory = new Map(); globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k,v)=>memory.set(k,v) };
  assert.equal(readRecords().best,null);
  assert.equal(saveResult(92,4).newBest,true); assert.equal(saveResult(95,5).newBest,false);
  assert.equal(readRecords().best,92); assert.equal(readRecords().maxStars,5); assert.equal(readRecords().races,2);
  memory.set('start_sup_records_v1',JSON.stringify({...readRecords(), day:'yesterday'})); assert.equal(readRecords().daily,null);
  saveResult(99,2); assert.equal(readRecords().daily,99); assert.equal(readRecords().day,today());
  memory.set('start_sup_records_v1','broken'); assert.equal(readRecords().best,null);
  globalThis.localStorage = {getItem(){throw new Error('blocked')},setItem(){throw new Error('blocked')}};
  assert.equal(saveResult(90,5).saved,false); delete globalThis.localStorage;
});

test('boat and three SUPs move with their whole footprint on navigable water', () => {
  const s = new Simulation(map, route);
  assert.equal(s.traffic.filter(v=>v.config.kind==='boat').length,1);
  assert.equal(s.traffic.filter(v=>v.config.kind==='sup').length,3);
  const initial=s.traffic.map(v=>({x:v.x,y:v.y}));
  for(let i=0;i<2400;i++) {
    advanceTraffic(s.traffic,.1);
    for(const v of s.traffic) for(let j=0;j<8;j++) {
      const p={x:v.x+Math.cos(j*Math.PI/4)*v.config.radius,y:v.y+Math.sin(j*Math.PI/4)*v.config.radius};
      assert.ok(s.navigable(p),`${v.config.id} at ${i/10}s`);
    }
    if(i===10) s.traffic.forEach((v,k)=>assert.ok(distance(v,initial[k])>10));
  }
});
test('a moving boat hits a stationary player once, separates them and applies a penalty', () => {
  const s = new Simulation(map,route), boat=s.traffic.find(v=>v.config.kind==='boat');
  Object.assign(s.player,{x:boat.x+Math.cos(boat.angle)*(boat.config.radius+17),y:boat.y+Math.sin(boat.angle)*(boat.config.radius+17),vx:0,vy:0});
  let hit=false;
  for(let i=0;i<12;i++){s.step(1/60,idle);if(s.events.some(e=>e.type==='collision'&&e.obstacle==='boat'))hit=true;}
  assert.ok(hit);assert.equal(s.collisions,1);assert.equal(s.penalty,2);assert.ok(s.navigable(s.player));
  assert.ok(distance(s.player,boat)>=boat.config.radius+14);
});
test('route remains finishable with moving obstacles and five stars', () => {
  const s=new Simulation(map,route);
  for(let i=0;i<60*180&&!s.finished;i++) {
    const goal=s.stars.has(s.next)?s.target:route.stars[s.next];
    const heading=Math.atan2(goal.y-s.player.y,goal.x-s.player.x);
    s.step(1/60,{...idle,heading,thrust:Math.abs(angleDelta(heading,s.player.angle))<.9});
    assert.ok(onWater(s.player,map.water));
  }
  assert.ok(s.finished);assert.equal(s.stars.size,5);assert.ok(s.time<180);assert.ok(s.collisions<=3);
  console.log(`With traffic: ${s.time.toFixed(2)}s, ${s.collisions} collisions`);
  const traffic=s.traffic.map(v=>({x:v.x,y:v.y}));s.step(1,idle);
  assert.deepEqual(s.traffic.map(v=>({x:v.x,y:v.y})),traffic);
  const reset=new Simulation(map,route), resetAgain=new Simulation(map,route);
  assert.deepEqual(reset.traffic,resetAgain.traffic);
});
