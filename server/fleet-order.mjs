const key='fleet_display_order';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function fleetOrder(store,fleet){
 const raw=store.db.prepare('SELECT value FROM admin_config WHERE key=?').get(key)?.value;
 const saved=raw?JSON.parse(raw):{revision:0,ids:[]};
 const ids=[...saved.ids.filter(id=>fleet.some(x=>x[0]===id)),...fleet.map(x=>x[0]).filter(id=>!saved.ids.includes(id))];
 return {revision:saved.revision,items:ids.map(id=>({id,label:fleet.find(x=>x[0]===id)[1]}))};
}
export function orderedFleet(store,fleet){const rank=new Map(fleetOrder(store,fleet).items.map((x,i)=>[x.id,i]));return [...fleet].sort((a,b)=>rank.get(a[0])-rank.get(b[0]));}
export function saveFleetOrder(store,fleet,b,user){
 if(user?.role!=='admin')fail('Только администратор может менять порядок техники.',403);
 if(!Array.isArray(b.ids)||b.ids.length!==fleet.length||new Set(b.ids).size!==fleet.length||b.ids.some(id=>!fleet.some(x=>x[0]===id)))fail('Укажите каждую категорию техники ровно один раз.');
 return store.workforce.tx(()=>{
  const before=fleetOrder(store,fleet);
  if(b.revision!==before.revision)fail('Порядок уже изменён. Обновите список перед сохранением.',409);
  const value={revision:before.revision+1,ids:b.ids};
  store.db.prepare('INSERT INTO admin_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  store.workforce.audit(user,'fleet_order',null,before,value,'Изменение порядка техники',Date.now());
  return fleetOrder(store,fleet);
 });
}
