import type { TrafficConfig, TrafficVessel } from './types.ts';

function sample(vessel: TrafficVessel, travel: number) {
  let remaining = ((travel % vessel.length) + vessel.length) % vessel.length;
  const path = vessel.config.path;
  for (let i = 0; i < path.length; i++) {
    const length = vessel.segments[i];
    if (remaining <= length || i === path.length - 1) {
      const a = path[i], b = path[(i + 1) % path.length];
      const t = Math.min(1, remaining / (length || 1));
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    remaining -= length;
  }
  return { ...path[0], angle: 0 };
}

export function createTraffic(configs: TrafficConfig[]): TrafficVessel[] {
  return configs.map(config => {
    if (config.path.length < 2 || config.speed <= 0 || config.radius <= 0) throw new Error(`Invalid traffic lane: ${config.id}`);
    const segments = config.path.map((p, i) => { const next = config.path[(i + 1) % config.path.length]; return Math.hypot(next.x - p.x, next.y - p.y); });
    const length = segments.reduce((a, b) => a + b, 0);
    if (!length) throw new Error(`Empty traffic lane: ${config.id}`);
    const vessel: TrafficVessel = { config, segments, length, travel: config.offset * length, x: 0, y: 0, angle: 0, previous: { x: 0, y: 0 } };
    Object.assign(vessel, sample(vessel, vessel.travel));
    vessel.previous = { x: vessel.x, y: vessel.y };
    return vessel;
  });
}

export function advanceTraffic(vessels: TrafficVessel[], dt: number) {
  for (const vessel of vessels) {
    vessel.previous = { x: vessel.x, y: vessel.y };
    vessel.travel = (vessel.travel + vessel.config.speed * dt) % vessel.length;
    const next = sample(vessel, vessel.travel);
    // Smooth heading across lane vertices, including the closing segment.
    const delta = Math.atan2(Math.sin(next.angle - vessel.angle), Math.cos(next.angle - vessel.angle));
    vessel.angle += delta * (1 - Math.exp(-dt * 5));
    vessel.x = next.x; vessel.y = next.y;
  }
}
export const trafficTrail = (vessel: TrafficVessel, secondsAgo: number) => sample(vessel, vessel.travel - secondsAgo * vessel.config.speed);
