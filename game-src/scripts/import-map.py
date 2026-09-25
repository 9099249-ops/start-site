"""Rebuild the bundled map from the checked-in OpenStreetMap XML snapshots.
Python 3 standard library only. No network or map service needed by the game.
Source: https://api.openstreetmap.org/api/0.6/relation/1926721/full
Local piers: /api/0.6/map?bbox=37.651,55.970,37.669,55.980
"""
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
west, south, east, north = 37.650, 55.970, 37.681, 55.987
scale = 3
mx = 111320 * math.cos(math.radians((north + south) / 2)) * scale
my = 111320 * scale
def project(lon, lat):
    return {"x": round((lon - west) * mx, 2), "y": round((north - lat) * my, 2)}

def lane(lon, lat, lon_radius, lat_radius, count=32):
    return [project(lon + math.cos(i * math.tau / count) * lon_radius,
                    lat + math.sin(i * math.tau / count) * lat_radius) for i in range(count)]

osm = ET.parse(ROOT / 'scripts/osm-reservoir.xml').getroot()
nodes = {n.attrib['id']: project(float(n.attrib['lon']), float(n.attrib['lat'])) for n in osm.findall('node')}
ways = {w.attrib['id']: [n.attrib['ref'] for n in w.findall('nd')] for w in osm.findall('way')}
relation = osm.find("relation[@id='1926721']")
def rings(role):
    parts = [ways[m.attrib['ref']][:] for m in relation.findall('member') if m.attrib.get('role') == role]
    result = []
    while parts:
        ring = parts.pop(0)
        while ring[-1] != ring[0]:
            for i, part in enumerate(parts):
                if part[0] == ring[-1]: ring += part[1:]; parts.pop(i); break
                if part[-1] == ring[-1]: ring += list(reversed(part[:-1])); parts.pop(i); break
            else: raise ValueError('Unclosed OSM ring')
        result.append([nodes[n] for n in ring])
    return result

outer, holes = rings('outer'), rings('inner')
assert len(outer) == 1, 'Assign holes to their parent if the OSM relation gains multiple outer rings.'
local = ET.parse(ROOT / 'scripts/osm-local.xml').getroot()
local_nodes = {n.attrib['id']: project(float(n.attrib['lon']), float(n.attrib['lat'])) for n in local.findall('node')}
piers = []
for way in local.findall('way'):
    tags = {t.attrib['k']: t.attrib['v'] for t in way.findall('tag')}
    if tags.get('man_made') == 'pier':
        piers.append([local_nodes[n.attrib['ref']] for n in way.findall('nd')])

data = {
  'width': round((east-west)*mx), 'height': round((north-south)*my), 'metersPerUnit': 1/scale,
  'bounds': {'west':west, 'north':north, 'east':east, 'south':south},
  'source': {'name':'© OpenStreetMap contributors', 'url':'https://www.openstreetmap.org/relation/1926721', 'license':'ODbL 1.0', 'retrieved':'2026-09-21'},
  'station': {**project(37.663009,55.973457), 'label':'СТАРТ', 'approximate':False, 'angle':-.6,
              'latitude':55.973457, 'longitude':37.663009,
              'sourceUrl':'https://yandex.ru/maps/-/CXAXqRoX'},
  'start': {**project(37.6625,55.9736), 'angle':-1.1},
  'water':[{'outer':outer[0], 'holes':holes}], 'piers':piers,
  'shallows':[{**project(37.663,55.9740), 'radius':135, 'label':'Игровая мель'}],
  'restricted':[{**project(37.676,55.981), 'radius':260, 'label':'Игровая зона судового хода'}],
  'obstacles':[
    {**project(37.6625,55.9765),'radius':16,'kind':'buoy'},
    {**project(37.67,55.9768),'radius':16,'kind':'buoy'},
    {**project(37.6642,55.9763),'radius':16,'kind':'buoy'},
    {**project(37.6658,55.9784),'radius':16,'kind':'buoy'}
  ],
  'traffic':[
    {'id':'passing-boat','kind':'boat','path':lane(37.666,55.978,.005,.0011),
     'speed':125,'radius':49,'offset':.08,'color':'#f3efe3','vestColor':'#477d98'},
    {'id':'sup-near-station','kind':'sup','path':lane(37.6625,55.9740,.00018,.0003),
     'speed':28,'radius':25,'offset':.35,'color':'#f7c884','vestColor':'#c75c4c'},
    {'id':'sup-bay','kind':'sup','path':lane(37.6636,55.9754,.00055,.00038),
     'speed':37,'radius':25,'offset':.65,'color':'#a9dfe6','vestColor':'#f2cd58'},
    {'id':'sup-open-water','kind':'sup','path':lane(37.6678,55.9783,.0012,.0005),
     'speed':44,'radius':25,'offset':.18,'color':'#d4baf1','vestColor':'#647bb1'}
  ],
  'labels':[
    {**project(37.6597,55.9758),'text':'ОРЕХОВАЯ БУХТА','kind':'water'},
    {**project(37.672,55.983),'text':'ПИРОГОВСКОЕ ВОДОХРАНИЛИЩЕ','kind':'water'},
    {**project(37.657,55.9718),'text':'БОЛТИНО','kind':'land'}
  ]
}
route = {'id':'orehovaya-01', 'name':'Вокруг бухты', 'checkpoints':[
  {**project(37.665,55.9754),'radius':85,'name':'Выход из бухты'},
  {**project(37.6645,55.978),'radius':85,'name':'На открытую воду'},
  {**project(37.67,55.979),'radius':85,'name':'Дальний буй'},
  {**project(37.6665,55.9755),'radius':85,'name':'Поворот к берегу'},
  {**project(37.6625,55.9738),'radius':95,'name':'Возвращение · финиш'}
], 'stars': []}
previous = data['start']
for target in route['checkpoints']:
    route['stars'].append({'x':round(previous['x']*.4 + target['x']*.6,2),'y':round(previous['y']*.4 + target['y']*.6,2),'radius':62})
    previous = target
for name, obj in [('map.json',data),('routes.json',route)]:
    (ROOT / 'src/data' / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(',',':')), encoding='utf-8')
print(f"Map {data['width']} x {data['height']}, {len(outer[0])} shoreline nodes, {len(holes)} island rings, {len(piers)} piers")
