import type { GameEvent, Input, MapData, Point, RouteData, TrafficVessel, WaterPolygon } from './types.ts';
import { advanceTraffic, createTraffic } from './Traffic.ts';

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export function inRing(p: Point, ring: Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function onWater(p: Point, water: WaterPolygon[]) {
  return water.some(poly => inRing(p, poly.outer) && !poly.holes.some(h => inRing(p, h)));
}
export function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Pure simulation: no DOM, rendering, clocks, or storage. Uses fixed 1/60s steps. */
export class Simulation {
  map: MapData;
  route: RouteData;
  player: Point & { angle: number; vx: number; vy: number };
  elapsed = 0;
  penalty = 0;
  collisions = 0;
  next = 0;
  stars = new Set<number>();
  finished = false;
  cooldown = 0;
  energy = 1;
  zone = '';
  events: GameEvent[] = [];
  traffic: TrafficVessel[];
  constructor(map: MapData, route: RouteData) {
    this.map = map; this.route = route;
    this.player = { ...map.start, vx: 0, vy: 0 };
    this.traffic = createTraffic(map.traffic);
  }
  get time() { return this.elapsed + this.penalty; }
  get target() { return this.route.checkpoints[Math.min(this.next, this.route.checkpoints.length - 1)]; }
  hit(obstacle: 'boat' | 'sup' | 'shore') {
    if (this.cooldown > 0) return;
    this.collisions++; this.penalty += 2; this.cooldown = 1.8;
    this.events.push({ type: 'collision', obstacle });
  }
  navigable(p: Point) {
    if (p.x < 12 || p.y < 12 || p.x > this.map.width - 12 || p.y > this.map.height - 12) return false;
    // A small footprint prevents the board clipping through shorelines and islands.
    if (![p, { x: p.x + 8, y: p.y }, { x: p.x - 8, y: p.y }, { x: p.x, y: p.y + 8 }, { x: p.x, y: p.y - 8 }].every(q => onWater(q, this.map.water))) return false;
    if (this.map.obstacles.some(o => distance(p, o) < o.radius + 9)) return false;
    return !this.map.piers.some(line => line.slice(1).some((b, i) => segmentDistance(p, line[i], b) < 13));
  }
  step(dt: number, input: Input) {
    this.events = [];
    if (this.finished) return;
    const p = this.player;
    this.elapsed += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    advanceTraffic(this.traffic, dt);
    const shallow = this.map.shallows.some(z => distance(p, z) < z.radius);
    const restricted = this.map.restricted.some(z => distance(p, z) < z.radius);
    this.zone = restricted ? 'Запретная зона · вернитесь на маршрут' : shallow ? 'Мелководье · скорость снижена' : '';
    const turn = input.heading === null ? input.turn : clamp(angleDelta(input.heading, p.angle) * 1.6, -1, 1);
    p.angle += turn * 1.9 * dt;
    const boosting = input.boost && input.thrust && this.energy > .08;
    this.energy = clamp(this.energy + dt * (boosting ? -.27 : .16), 0, 1);
    const force = input.thrust ? (boosting ? 145 : 85) : 0;
    p.vx += Math.cos(p.angle) * force * dt;
    p.vy += Math.sin(p.angle) * force * dt;
    const damping = Math.exp(-(restricted ? 4.2 : shallow ? 2.2 : 1.08) * dt);
    p.vx *= damping; p.vy *= damping;
    // Mild drift while paddling; the board remains still when left at the dock.
    if (input.thrust) p.vx += Math.sin(this.elapsed * .8) * dt * 1.5;
    const next = { x: p.x + p.vx * dt, y: p.y + p.vy * dt };
    const previous = { x: p.x, y: p.y };
    if (this.navigable(next)) { p.x = next.x; p.y = next.y; }
    else {
      if (Math.hypot(p.vx, p.vy) > 14) this.hit('shore');
      p.vx *= -.2; p.vy *= -.2;
    }
    for (const vessel of this.traffic) {
      // Relative swept collision also catches a boat hitting a stationary SUP.
      const a = { x: previous.x - vessel.previous.x, y: previous.y - vessel.previous.y };
      const b = { x: p.x - vessel.x, y: p.y - vessel.y };
      const radius = vessel.config.radius + 14;
      if (segmentDistance({ x: 0, y: 0 }, a, b) >= radius) continue;
      this.hit(vessel.config.kind);
      const len = Math.hypot(b.x, b.y);
      const nx = len > .1 ? b.x / len : -Math.sin(vessel.angle);
      const ny = len > .1 ? b.y / len : Math.cos(vessel.angle);
      const separated = { x: vessel.x + nx * (radius + 2), y: vessel.y + ny * (radius + 2) };
      if (this.navigable(separated)) { p.x = separated.x; p.y = separated.y; }
      else { p.x = previous.x; p.y = previous.y; }
      p.vx = p.vx * .15 + nx * 12; p.vy = p.vy * .15 + ny * 12;
    }
    this.route.stars.forEach((s, i) => {
      if (!this.stars.has(i) && distance(p, s) < s.radius) {
        this.stars.add(i); this.events.push({ type: 'star_collected', index: i });
      }
    });
    if (distance(p, this.target) < this.target.radius) {
      this.events.push({ type: 'checkpoint', index: this.next }); this.next++;
      if (this.next === this.route.checkpoints.length) {
        this.finished = true; this.events.push({ type: 'game_finish' });
      }
    }
  }
}
