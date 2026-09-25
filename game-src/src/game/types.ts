export type Point = { x: number; y: number };
export type Zone = Point & { radius: number; label?: string };
export type Obstacle = Zone & { kind: 'buoy' | 'boat'; angle?: number };
export type TrafficConfig = {
  id: string; kind: 'boat' | 'sup'; path: Point[]; speed: number;
  radius: number; offset: number; color: string; vestColor: string;
};
export type TrafficVessel = Point & {
  config: TrafficConfig; previous: Point; angle: number;
  travel: number; length: number; segments: number[];
};
export type WaterPolygon = { outer: Point[]; holes: Point[][] };
export type MapData = {
  width: number; height: number; metersPerUnit: number;
  bounds: { west: number; north: number; east: number; south: number };
  source: { name: string; url: string; license: string; retrieved: string };
  station: Point & { label: string; approximate: boolean; angle: number; latitude: number; longitude: number; sourceUrl: string };
  start: Point & { angle: number };
  water: WaterPolygon[]; piers: Point[][];
  shallows: Zone[]; restricted: Zone[]; obstacles: Obstacle[];
  traffic: TrafficConfig[];
  labels: (Point & { text: string; kind: 'water' | 'land' })[];
};
export type RouteData = { id: string; name: string; checkpoints: (Zone & { name: string })[]; stars: Zone[] };
export type Input = { thrust: boolean; turn: number; boost: boolean; heading: number | null };
export type GameEvent = { type: 'checkpoint' | 'star_collected' | 'collision' | 'game_finish'; index?: number; obstacle?: 'boat' | 'sup' | 'shore' };
export type Phase = 'menu' | 'playing' | 'paused' | 'finished';
