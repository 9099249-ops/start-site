import type { MapData, Point, RouteData, TrafficVessel } from './types.ts';
import { clamp, onWater } from './Simulation.ts';
import type { Simulation } from './Simulation.ts';
import config from '../data/config.json';
import { trafficTrail } from './Traffic.ts';

function ringPath(ctx: CanvasRenderingContext2D, points: Point[]) {
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
}
function waterPath(ctx: CanvasRenderingContext2D, map: MapData) {
  ctx.beginPath(); map.water.forEach(poly => { ringPath(ctx, poly.outer); poly.holes.forEach(r => ringPath(ctx, r)); });
}
function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number) {
  ctx.fillStyle = color; ctx.font = `600 ${size}px 'Segoe UI', sans-serif`; ctx.textAlign = 'center'; ctx.fillText(text, x, y);
}
export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  mini: HTMLCanvasElement;
  mctx: CanvasRenderingContext2D;
  map: MapData;
  route: RouteData;
  terrain: HTMLCanvasElement;
  w = 1000; h = 650; dpr = 1;
  camera = { x: 2600, y: 3800, zoom: .4 };
  wake: (Point & { age: number; angle: number })[] = [];
  particles: (Point & { life: number; dx: number; dy: number; color: string })[] = [];
  private trailTick = 0;
  constructor(canvas: HTMLCanvasElement, mini: HTMLCanvasElement, map: MapData, route: RouteData) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.mini = mini; this.mctx = mini.getContext('2d')!; this.map = map; this.route = route;
    this.terrain = this.makeTerrain();
    new ResizeObserver(() => this.resize()).observe(canvas); this.resize();
  }
  resize() {
    const r = this.canvas.getBoundingClientRect(); this.w = r.width; this.h = r.height;
    this.dpr = Math.min(devicePixelRatio || 1, 2); this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
  }
  makeTerrain() {
    const map = this.map, canvas = document.createElement('canvas');
    const scale = 2048 / Math.max(map.width, map.height);
    canvas.width = Math.ceil(map.width * scale); canvas.height = Math.ceil(map.height * scale);
    const c = canvas.getContext('2d')!; c.scale(scale, scale);
    c.fillStyle = '#536c4b'; c.fillRect(0, 0, map.width, map.height);
    // Stable procedural vegetation: only on land, never changing the source shoreline.
    let seed = 1974;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
    for (let i = 0; i < 14000; i++) {
      const x = rand() * map.width, y = rand() * map.height, r = 9 + rand() * 33;
      if (onWater({ x, y }, map.water)) continue;
      circle(c, x + 8, y + 10, r, 'rgba(16,39,31,.18)');
      circle(c, x, y, r, ['#536e45', '#61784b', '#74845a', '#425e43', '#4a6947'][Math.floor(rand() * 5)]);
      circle(c, x - r * .25, y - r * .3, r * .55, 'rgba(170,186,113,.1)');
    }
    waterPath(c, map); c.strokeStyle = '#b2b696'; c.lineWidth = 30; c.lineJoin = 'round'; c.stroke();
    const water = c.createLinearGradient(0, map.height, map.width, 0); water.addColorStop(0, '#73b8af'); water.addColorStop(.5, '#328b98'); water.addColorStop(1, '#216277');
    c.fillStyle = water; c.fill('evenodd');
    c.save(); waterPath(c, map); c.clip('evenodd');
    waterPath(c, map); c.strokeStyle = 'rgba(168,226,191,.4)'; c.lineWidth = 105; c.stroke();
    waterPath(c, map); c.strokeStyle = 'rgba(213,235,203,.45)'; c.lineWidth = 21; c.stroke();
    for (let i = 0; i < 15000; i++) {
      const x = rand() * map.width, y = rand() * map.height;
      c.strokeStyle = `rgba(214,255,245,${rand() * .11})`; c.lineWidth = 1 + rand() * 2;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 8 + rand() * 32, y - 2); c.stroke();
    }
    for (const z of map.shallows) {
      const g = c.createRadialGradient(z.x, z.y, 5, z.x, z.y, z.radius);
      g.addColorStop(0, 'rgba(219,221,165,.48)'); g.addColorStop(1, 'rgba(219,221,165,0)'); circle(c, z.x, z.y, z.radius, '#ffffff00');
      c.fillStyle = g; c.fillRect(z.x-z.radius, z.y-z.radius, z.radius*2, z.radius*2);
    }
    c.restore();
    map.piers.forEach(points => {
      c.beginPath(); points.forEach((p, i) => i ? c.lineTo(p.x + 4, p.y + 6) : c.moveTo(p.x + 4, p.y + 6));
      c.strokeStyle = 'rgba(7,37,44,.3)'; c.lineWidth = 16; c.stroke();
      c.beginPath(); points.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
      c.strokeStyle = '#b6a58c'; c.lineWidth = 10; c.stroke(); c.strokeStyle = '#dfcfac'; c.lineWidth = 4; c.stroke();
    });
    return canvas;
  }
  burst(p: Point, color: string) {
    for (let i = 0; i < 22; i++) { const a = Math.random() * Math.PI * 2, v = 35 + Math.random() * 100; this.particles.push({ ...p, dx: Math.cos(a) * v, dy: Math.sin(a) * v, life: 1, color }); }
  }
  reset() { this.wake = []; this.particles = []; this.camera.x = this.map.start.x; this.camera.y = this.map.start.y; }
  draw(sim: Simulation, time: number, dt: number, menu: boolean, paddling: boolean) {
    const c = this.ctx, map = this.map, p = sim.player;
    const zoom = menu ? Math.min(this.w / 3900, this.h / 3000) : clamp(Math.min(this.w / 1200, this.h / 1000), .36, .85);
    const cx = menu ? 2500 - (this.w > 760 ? 600 : 0) : p.x + Math.cos(p.angle) * 125;
    const cy = menu ? 3450 : p.y + Math.sin(p.angle) * 125;
    const smooth = 1 - Math.exp(-dt * 3);
    this.camera.x += (cx - this.camera.x) * smooth; this.camera.y += (cy - this.camera.y) * smooth; this.camera.zoom += (zoom - this.camera.zoom) * smooth;
    const z = this.camera.zoom;
    const worldW = this.w / z, worldH = this.h / z;
    const ox = clamp(this.camera.x - worldW / 2, Math.min(0, (map.width-worldW)/2), Math.max(0, map.width-worldW));
    const oy = clamp(this.camera.y - worldH / 2, Math.min(0, (map.height-worldH)/2), Math.max(0, map.height-worldH));
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.fillStyle = '#377f88'; c.fillRect(0, 0, this.w, this.h);
    c.scale(z, z); c.translate(-ox, -oy); c.drawImage(this.terrain, 0, 0, map.width, map.height);
    // Draw only visible shimmer samples. DPR is capped; terrain is cached once.
    c.save(); waterPath(c, map); c.clip('evenodd');
    for (let gy = Math.floor(oy/95); gy < (oy+worldH)/95; gy++) for (let gx = Math.floor(ox/130); gx < (ox+worldW)/130; gx++) {
      const phase = gx * 2.61 + gy * 4.37, x = gx * 130 + Math.sin(phase) * 45, y = gy * 95 + Math.cos(phase) * 30 + Math.sin(time * .7 + phase) * 5;
      const alpha = .035 + .065 * Math.max(0, Math.sin(time * .65 + phase));
      c.strokeStyle = `rgba(225,255,248,${alpha})`; c.lineWidth = 1.4 / z; c.beginPath(); c.ellipse(x, y, 20 + Math.sin(phase) * 9, 3, -.15, 0, Math.PI); c.stroke();
    }
    c.restore();
    map.labels.forEach(l => label(c, l.text, l.x, l.y, l.kind === 'water' ? 'rgba(231,255,246,.38)' : '#dbe4c5', 24));
    map.restricted.forEach(r => {
      circle(c, r.x, r.y, r.radius, 'rgba(227,108,85,.11)'); c.strokeStyle = '#f2a18a'; c.lineWidth = 2 / z; c.setLineDash([9 / z, 8 / z]); c.stroke(); c.setLineDash([]);
    });
    c.beginPath(); c.moveTo(map.start.x, map.start.y);
    this.route.checkpoints.forEach(q => c.lineTo(q.x, q.y));
    c.strokeStyle = 'rgba(231,255,242,.45)'; c.lineWidth = 1.5 / z; c.setLineDash([5 / z, 10 / z]); c.lineDashOffset = -time * 6 / z; c.stroke(); c.setLineDash([]);
    this.route.checkpoints.forEach((q, i) => {
      const active = i === sim.next, done = i < sim.next, color = done ? '#b8e0c2' : active ? '#d6f69c' : '#e0eee6';
      circle(c, q.x, q.y, q.radius, active ? 'rgba(212,247,160,.16)' : 'rgba(224,247,237,.05)');
      c.strokeStyle = active ? 'rgba(220,255,180,.8)' : 'rgba(220,250,240,.25)'; c.lineWidth = (active ? 2 : 1) / z; c.stroke();
      if (active) { c.beginPath(); c.arc(q.x, q.y, q.radius + (Math.sin(time * 2) + 1) * 8, 0, Math.PI * 2); c.strokeStyle = 'rgba(225,255,185,.2)'; c.stroke(); }
      const radius = 13 / z;
      circle(c, q.x, q.y - 7 / z, radius, color); label(c, done ? '✓' : `${i + 1}`, q.x, q.y - 3 / z, '#214c47', 12 / z);
      if (active && !menu) label(c, i === 4 ? 'ФИНИШ' : 'СЛЕДУЮЩИЙ БУЙ', q.x, q.y - q.radius - 18 / z, '#edffdc', 10 / z);
    });
    this.route.stars.forEach((s, i) => {
      if (sim.stars.has(i)) return;
      c.save(); c.translate(s.x, s.y + Math.sin(time * 2 + i) * 7);
      const r = 10 / z; circle(c, 0, 0, r * 1.8, 'rgba(255,221,103,.12)');
      c.beginPath(); for (let j = 0; j < 10; j++) { const a = -Math.PI / 2 + j * Math.PI / 5, rr = j % 2 ? r * .45 : r; j ? c.lineTo(Math.cos(a)*rr, Math.sin(a)*rr) : c.moveTo(Math.cos(a)*rr, Math.sin(a)*rr); }
      c.closePath(); c.fillStyle = '#ffe18b'; c.fill(); c.restore();
    });
    map.obstacles.forEach(o => {
      if (o.kind === 'buoy') { circle(c, o.x+4, o.y+8, 16, 'rgba(9,47,56,.22)'); circle(c, o.x,o.y,13,'#fda17e'); circle(c,o.x-2,o.y-3,6,'#ffe3be'); }
      else { c.save(); c.translate(o.x,o.y); c.rotate(o.angle ?? 0); c.fillStyle='#ecede2'; c.beginPath(); c.ellipse(0,0,43,17,0,0,Math.PI*2); c.fill(); c.fillStyle='#33596a'; c.fillRect(-18,-9,23,18); c.restore(); }
    });
    for (const vessel of sim.traffic) this.drawVessel(vessel, menu ? time : sim.elapsed, z);
    const st = map.station;
    c.save(); c.translate(st.x, st.y); c.fillStyle = '#123e43'; c.beginPath(); c.roundRect(-44, -65, 88, 30, 6); c.fill(); label(c, st.label, 0, -44, '#d4f5ab', 16); c.strokeStyle = '#eaf4cf'; c.lineWidth = 3; c.beginPath(); c.moveTo(0,-35); c.lineTo(0,8); c.stroke(); c.restore();
    if (paddling && Math.hypot(p.vx,p.vy)>10) { this.trailTick += dt; if (this.trailTick>.055) { this.wake.push({ x:p.x,y:p.y,age:0,angle:p.angle }); this.trailTick=0; } }
    this.wake = this.wake.filter(w => w.age < 2.3);
    this.wake.forEach(w => { w.age += dt; c.save(); c.translate(w.x,w.y); c.rotate(w.angle); c.strokeStyle = `rgba(225,255,241,${.22 * (1-w.age/2.3)})`; c.lineWidth=1.5; c.beginPath(); c.moveTo(-8-w.age*19,-5-w.age*12); c.quadraticCurveTo(-18,0,-8-w.age*19,5+w.age*12); c.stroke(); c.restore(); });
    this.board(p, time, paddling, z);
    this.particles = this.particles.filter(f=>f.life>0);
    this.particles.forEach(f => { f.life-=dt; f.x+=f.dx*dt; f.y+=f.dy*dt; c.globalAlpha=Math.max(0,f.life); circle(c,f.x,f.y,3/z,f.color); }); c.globalAlpha=1;
    if (!menu && !sim.finished) {
      const target = sim.target, tx=(target.x-ox)*z, ty=(target.y-oy)*z;
      if (tx<65 || tx>this.w-65 || ty<100 || ty>this.h-75) {
        const px=(p.x-ox)*z, py=(p.y-oy)*z, a=Math.atan2(target.y-p.y,target.x-p.x);
        const ax=clamp(px+Math.cos(a)*130,50,this.w-50), ay=clamp(py+Math.sin(a)*130,105,this.h-75);
        c.setTransform(this.dpr,0,0,this.dpr,0,0); c.save(); c.translate(ax,ay); c.rotate(a); c.fillStyle='#e2fabb'; c.beginPath(); c.moveTo(12,0); c.lineTo(-7,-7); c.lineTo(-3,0); c.lineTo(-7,7); c.fill(); c.restore();
      }
    }
    this.drawMini(sim);
  }
  drawVessel(vessel: TrafficVessel, time: number, z: number) {
    const c = this.ctx, boat = vessel.config.kind === 'boat';
    c.save(); waterPath(c, this.map); c.clip('evenodd');
    // Wake samples follow the lane, so the wake also bends after the hull turns.
    for (const side of [-1, 1]) {
      c.beginPath();
      for (let i = 0; i < 18; i++) {
        const age = i / 10, trail = trafficTrail(vessel, age);
        const width = (boat ? 12 : 4) + age * (boat ? 17 : 6);
        const x = trail.x - Math.sin(trail.angle) * width * side;
        const y = trail.y + Math.cos(trail.angle) * width * side;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.strokeStyle = boat ? 'rgba(235,255,247,.36)' : 'rgba(229,251,236,.2)';
      c.lineWidth = (boat ? 2 : 1) / z; c.stroke();
    }
    c.restore();
    if (!boat) { this.board(vessel, time + vessel.config.offset * 20, true, z, { board: vessel.config.color, vest: vessel.config.vestColor }); return; }
    c.save(); c.translate(vessel.x, vessel.y); c.rotate(vessel.angle);
    const hullScale = Math.max(1, .57 / z); c.scale(hullScale, hullScale);
    c.fillStyle = 'rgba(6,40,52,.3)'; c.beginPath(); c.ellipse(5,8,59,24,0,0,Math.PI*2); c.fill();
    c.fillStyle = '#294d5b'; c.beginPath(); c.roundRect(-59,-10,15,20,4); c.fill();
    c.fillStyle = vessel.config.color; c.beginPath(); c.moveTo(60,0); c.bezierCurveTo(43,-26,-30,-23,-48,-18); c.lineTo(-48,18); c.bezierCurveTo(-30,23,43,26,60,0); c.fill();
    c.strokeStyle = '#9dc5c5'; c.lineWidth=2; c.stroke();
    c.fillStyle = '#beac90'; c.beginPath(); c.roundRect(-35,-14,43,28,6); c.fill();
    c.fillStyle = '#2d5d70'; c.beginPath(); c.roundRect(5,-16,16,32,5); c.fill();
    c.strokeStyle = '#ebf2e8'; c.lineWidth=2; c.beginPath(); c.moveTo(12,-15); c.lineTo(12,15); c.stroke();
    c.fillStyle='#eee8d8'; c.fillRect(-32,-13,8,26); c.fillStyle='#678da1'; c.fillRect(-17,-12,12,9);
    circle(c,-9,8,5,'#d8a582'); circle(c,-7,8,3,'#51443b');
    c.restore();
  }
  board(p: Point & { angle: number }, time: number, paddling: boolean, z: number, colors = { board: config.boardColor, vest: config.vestColor }) {
    const c=this.ctx; c.save(); c.translate(p.x,p.y); c.rotate(p.angle + Math.sin(time*1.5)*.012);
    const size = Math.max(1, .57/z); c.scale(size,size);
    c.fillStyle='rgba(8,49,55,.22)'; c.beginPath(); c.ellipse(5,7,34,12,0,0,Math.PI*2); c.fill();
    c.fillStyle=colors.board; c.beginPath(); c.moveTo(37,0); c.bezierCurveTo(22,-14,-18,-13,-30,-6); c.quadraticCurveTo(-37,0,-30,6); c.bezierCurveTo(-18,13,22,14,37,0); c.fill();
    c.fillStyle='#479b96'; c.fillRect(-21,-7,28,14); c.fillStyle='#d4eea4'; c.fillRect(16,-6,5,12);
    c.strokeStyle='#38514e'; c.lineWidth=3; c.beginPath(); c.moveTo(-5,-4); c.lineTo(-13,-5); c.moveTo(-5,4); c.lineTo(-13,5); c.stroke();
    c.save(); c.translate(2,0); c.rotate(paddling ? Math.sin(time*8)*.55 : -.25);
    c.strokeStyle='#233b42'; c.lineWidth=2.4; c.beginPath(); c.moveTo(-12,-17); c.lineTo(14,17); c.stroke(); c.fillStyle='#263d42'; c.beginPath(); c.ellipse(16,21,3,8,-.65,0,Math.PI*2); c.fill();
    c.strokeStyle=config.skinColor; c.lineWidth=4; c.beginPath(); c.moveTo(0,-5); c.lineTo(-5,-10); c.moveTo(0,5); c.lineTo(8,10); c.stroke(); c.restore();
    c.fillStyle=colors.vest; c.beginPath(); c.roundRect(-8,-7,14,14,4); c.fill();
    circle(c,4,0,6,config.skinColor); circle(c,6,-.5,4.5,'#493c31'); c.restore();
  }
  drawMini(sim: Simulation) {
    const c=this.mctx, w=this.mini.width, h=this.mini.height, map=this.map;
    c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,w,h); c.fillStyle='#153f46'; c.fillRect(0,0,w,h);
    const scale=Math.min(w/map.width,h/map.height); c.scale(scale,scale);
    waterPath(c,map); c.fillStyle='#5b9399'; c.fill('evenodd');
    c.beginPath(); c.moveTo(map.start.x,map.start.y); this.route.checkpoints.forEach(q=>c.lineTo(q.x,q.y)); c.strokeStyle='#e2efcb'; c.lineWidth=1.7/scale; c.stroke();
    this.route.checkpoints.forEach((q,i)=>circle(c,q.x,q.y,(i===sim.next?3.5:2)/scale,i<sim.next?'#98c398':'#e6f6ce'));
    sim.traffic.forEach(v => circle(c,v.x,v.y,(v.config.kind==='boat'?3:2)/scale,v.config.kind==='boat'?'#f6a989':'#b3d8e4'));
    circle(c,sim.player.x,sim.player.y,5/scale,'#fff'); circle(c,sim.player.x,sim.player.y,2.6/scale,'#f3a362');
  }
}
