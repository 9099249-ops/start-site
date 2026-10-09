import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {BatteryStateStore,batteryStateHandler} from './battery-state.mjs';

const BMS='41:18:12:01:37:50';
function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'schedule','staff','unused')");
 const users={admin:{id:1,role:'admin'},staff:{id:2,role:'staff'},schedule:{id:3,role:'staff',scheduleOnly:true}};
 admin.user=token=>users[token]||null;
 const store=new BatteryStateStore(admin);t.after(()=>admin.close());
 const create=(overrides={},user=users.admin)=>store.manage({action:'create',requestId:randomUUID(),name:'Port BMS',catamaranLabel:'Сашин',bmsId:BMS,...overrides},user);
 return {admin,store,users,create};
}
function telemetry(deviceId,overrides={}){return {deviceId,bootId:'deadbeef',sequence:1,measurementAgeMs:0,bmsId:BMS,bmsConnected:true,telemetry:{socPercent:72.5,voltageV:51.2,currentA:-3.4,powerW:174.08,state:'discharging',chargingEnabled:true,dischargingEnabled:true,remainingCapacityAh:72,cellCount:16,temperatureSensorCount:2,cellVoltagesV:Array(16).fill(3.2),temperaturesC:[22,23],alarmMaskHex:'0000000000000000',bmsName:'JK-BMS',fieldAgesMs:{summary:0},rawFrames:{}},...overrides};}
function serverFor(t,f){const origin='http://station.test';const handler=batteryStateHandler(f.store,f.admin,origin);const server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://127.0.0.1'))){res.writeHead(404);res.end();}});return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{t.after(()=>new Promise(r=>server.close(r)));resolve({origin,request:(path,options={})=>fetch('http://127.0.0.1:'+server.address().port+path,options)});}));}

test('create, ingest and list preserve a useful snapshot without exposing the bearer token',t=>{
 const f=fixture(t),made=f.create(),id=made.device.deviceId;assert.ok(made.token);assert.equal(f.store.ingest(telemetry(id),made.token,10_000).accepted,true);
 const listing=f.store.list(f.users.admin,10_000),row=listing.devices.find(x=>x.deviceId===id);assert.equal(row.telemetry.socPercent,72.5);assert.equal(row.lastMeasuredAt,10_000);assert.equal(row.online,true);assert.equal(row.bmsConnected,true);
 assert.equal(JSON.stringify(row).includes(made.token),false);assert.equal(JSON.stringify(listing).includes(made.token),false);
});

test('admin-only management and reads, schedule-only sessions are denied',t=>{
 const f=fixture(t);assert.throws(()=>f.create({},f.users.staff),{status:403});
 assert.throws(()=>f.store.list(f.users.staff),{status:403});assert.throws(()=>f.store.history('x',f.users.schedule),{status:403});
});

test('revision checks, updates and token rotation invalidate the previous credential',t=>{
 const f=fixture(t),made=f.create(),device=made.device;
 assert.throws(()=>f.store.manage({action:'update',requestId:randomUUID(),deviceId:device.deviceId,revision:device.revision+1,name:'Stale'},f.users.admin),{status:409});
 const changed=f.store.manage({action:'update',requestId:randomUUID(),deviceId:device.deviceId,revision:device.revision,name:'Port BMS 2'},f.users.admin);
 assert.equal(changed.device.name,'Port BMS 2');
 const rotated=f.store.manage({action:'rotate-token',requestId:randomUUID(),deviceId:device.deviceId,revision:changed.device.revision},f.users.admin);assert.ok(rotated.token);assert.throws(()=>f.store.ingest(telemetry(device.deviceId),made.token),{status:401});
});

test('creation and token rotation retries return the same identity and one-time key',t=>{
 const f=fixture(t),requestId=randomUUID(),body={action:'create',requestId,name:'Port BMS',catamaranLabel:'Касатка',bmsId:BMS};
 const first=f.store.manage(body,f.users.admin,1000),again=f.store.manage(body,f.users.admin,2000);
 assert.equal(again.duplicate,true);assert.equal(again.device.deviceId,first.device.deviceId);assert.equal(again.token,first.token);
 const rotate={action:'rotate-token',requestId:randomUUID(),deviceId:first.device.deviceId,revision:first.device.revision};
 const issued=f.store.manage(rotate,f.users.admin,3000),retried=f.store.manage(rotate,f.users.admin,4000);
 assert.equal(retried.duplicate,true);assert.equal(retried.token,issued.token);assert.notEqual(issued.token,first.token);
});

test('invalid ranges and mismatched device or BMS are rejected without recording measurements',t=>{
 const f=fixture(t),made=f.create(),id=made.device.deviceId;
 for(const patch of [{socPercent:101},{voltageV:-1},{alarmMaskHex:'not-hex'},{rawFrames:{'90':'0'.repeat(26)}}])assert.throws(()=>f.store.ingest(telemetry(id,{telemetry:{...telemetry(id).telemetry,...patch}}),made.token));
 assert.throws(()=>f.store.ingest(telemetry(id,{measurementAgeMs:null}),made.token));
 const partial=telemetry(id,{sequence:4,telemetry:{...telemetry(id).telemetry,cellVoltagesV:[3.18,null],cellCount:4,temperaturesC:[null,24],temperatureSensorCount:3}});
 f.store.ingest(partial,made.token,10_000);const projected=f.store.list(f.users.admin,10_000).devices.find(x=>x.deviceId===id).telemetry;
 assert.deepEqual(projected.cellVoltagesV,[3.18,null,null,null]);assert.deepEqual(projected.temperaturesC,[null,24,null]);
 assert.throws(()=>f.store.ingest(telemetry(id,{deviceId:'bms-does-not-exist'}),made.token),{status:401});assert.throws(()=>f.store.ingest(telemetry(id,{bmsId:'00:00:00:00:00:00'}),made.token),{status:403});
 assert.equal(f.store.list(f.users.admin,20_000).devices.find(x=>x.deviceId===id).lastMeasuredAt,10_000);
});

test('duplicate and out-of-order packets never advance measurement freshness; heartbeat does',t=>{
 const f=fixture(t),made=f.create(),id=made.device.deviceId;
 f.store.ingest(telemetry(id,{sequence:2}),made.token,10_000);
 f.store.ingest(telemetry(id,{sequence:1,firmwareVersion:'2.0'}),made.token,30_000);
 f.store.ingest(telemetry(id,{sequence:3,measurementAgeMs:0,telemetry:null}),made.token,40_000);
 let row=f.store.list(f.users.admin,40_000).devices.find(x=>x.deviceId===id);assert.equal(row.lastMeasuredAt,10_000);assert.equal(row.lastSeenAt,40_000);assert.equal(row.telemetry.socPercent,72.5);
});

test('measurement staleness is separate from device heartbeat and history is bounded and cleaned',t=>{
 const f=fixture(t),made=f.create({staleAfterSeconds:60}),id=made.device.deviceId;
 f.store.ingest(telemetry(id),made.token,1_000);
 let row=f.store.list(f.users.admin,62_000).devices.find(x=>x.deviceId===id);assert.equal(row.stale,true);
 assert.equal(f.store.history(id,f.users.admin,62_000,1).history.length<=1,true);
 f.store.ingest(telemetry(id,{sequence:2,telemetry:null}),made.token,62_500);
 row=f.store.list(f.users.admin,62_500).devices.find(x=>x.deviceId===id);assert.equal(row.online,true);assert.equal(row.stale,true);
 f.store.ingest(telemetry(id,{sequence:2,measurementAgeMs:0}),made.token,63_000);
 row=f.store.list(f.users.admin,63_000).devices.find(x=>x.deviceId===id);assert.equal(row.stale,false);
 assert.throws(()=>f.store.history(id,f.users.admin,63_000,501));
});

test('measured device binding is locked; moving the battery preserves history, a new battery gets a separate profile',t=>{
 const f=fixture(t),made=f.create(),id=made.device.deviceId;
 f.store.ingest(telemetry(id),made.token,10_000);assert.equal(f.store.history(id,f.users.admin,10_000).history.length,1);
 assert.throws(()=>f.store.manage({action:'update',requestId:randomUUID(),deviceId:id,revision:made.device.revision,bmsId:'41:18:12:01:37:51'},f.users.admin,20_000),{status:409});
 const moved=f.store.manage({action:'update',requestId:randomUUID(),deviceId:id,revision:made.device.revision,catamaranLabel:'Наташин'},f.users.admin,20_000);
 assert.equal(moved.device.deviceId,id);assert.equal(moved.device.bmsId,BMS);assert.equal(moved.device.bindingLocked,true);assert.equal(moved.device.lastMeasuredAt,10_000);
 assert.equal(f.store.history(id,f.users.admin,20_000).history.length,1);
 const second=f.create({name:'Second BMS',catamaranLabel:'С серой крышей',bmsId:'41:18:12:01:37:51'});
 assert.notEqual(second.device.deviceId,id);assert.equal(f.store.list(f.users.admin,30_000).devices.length,2);
});

test('duplicate physical BMS is rejected and an unconfigured profile may correct its binding',t=>{
 const f=fixture(t),first=f.create(),other=f.create({name:'Other',bmsId:'41:18:12:01:37:54'});
 assert.throws(()=>f.create({bmsId:BMS}),{status:409});
 const unconfigured=f.create({name:'Unconfigured',bmsId:'41:18:12:01:37:52'});
 assert.throws(()=>f.store.manage({action:'update',requestId:randomUUID(),deviceId:unconfigured.device.deviceId,revision:unconfigured.device.revision,bmsId:other.device.bmsId},f.users.admin),{status:409});
 const corrected=f.store.manage({action:'update',requestId:randomUUID(),deviceId:unconfigured.device.deviceId,revision:unconfigured.device.revision,bmsId:'41:18:12:01:37:53'},f.users.admin);
 assert.equal(corrected.device.bmsId,'41:18:12:01:37:53');assert.equal(corrected.device.bindingLocked,false);
 assert.notEqual(first.device.deviceId,corrected.device.deviceId);
});

test('history stores one latest sample per minute; disabled devices cannot ingest',t=>{
 const f=fixture(t),made=f.create(),id=made.device.deviceId;
 f.store.ingest(telemetry(id,{sequence:1}),made.token,3_600_000);
 f.store.ingest(telemetry(id,{sequence:2,telemetry:{...telemetry(id).telemetry,socPercent:73}}),made.token,3_620_000);
 const history=f.store.history(id,f.users.admin,3_620_000,60).history;assert.equal(history.length,1);assert.equal(history[0].telemetry.socPercent,73);
 const updated=f.store.manage({action:'update',requestId:randomUUID(),deviceId:id,revision:made.device.revision,enabled:false},f.users.admin,3_630_000);
 assert.equal(updated.device.enabled,false);assert.throws(()=>f.store.ingest(telemetry(id,{sequence:3}),made.token,3_640_000),{status:401});
});

test('HTTP admin routes enforce session, role, origin, JSON and request-size limits; machine ingest is token-only',async t=>{
 const f=fixture(t),net=await serverFor(t,f),made=f.create();
 const get=(path,user)=>net.request(path,{headers:user?{Cookie:'__Host-start_session='+user}:{}});
 assert.equal((await get('/api/admin/battery-state')).status,401);
 assert.equal((await get('/api/admin/battery-state','staff')).status,403);
 assert.equal((await get('/api/admin/battery-state','admin')).status,200);
 const write=body=>net.request('/api/admin/battery-state/devices',{method:'POST',headers:{Cookie:'__Host-start_session=admin',Origin:net.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await write({action:'create',requestId:randomUUID(),name:'No BMS'})).status,400);
 const wrongType=await net.request('/api/admin/battery-state/devices',{method:'POST',headers:{Cookie:'__Host-start_session=admin',Origin:net.origin,'Content-Type':'application/json'},body:'[]'});assert.equal(wrongType.status,400);
 assert.equal((await net.request('/api/devices/battery-telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(telemetry(made.device.deviceId))})).status,401);
 const ok=await net.request('/api/devices/battery-telemetry',{method:'POST',headers:{Authorization:'Bearer '+made.token,'Content-Type':'application/json'},body:JSON.stringify(telemetry(made.device.deviceId))});assert.equal(ok.status,200);
 const history=await get('/api/admin/battery-state/history?deviceId='+made.device.deviceId+'&limit=60','admin');assert.equal(history.status,200);
 const wrongOrigin=await net.request('/api/admin/battery-state/devices',{method:'POST',headers:{Cookie:'__Host-start_session=admin',Origin:'https://attacker.test','Content-Type':'application/json'},body:JSON.stringify({})});assert.equal(wrongOrigin.status,403);
 const badJson=await net.request('/api/admin/battery-state/devices',{method:'POST',headers:{Cookie:'__Host-start_session=admin',Origin:net.origin,'Content-Type':'application/json'},body:'{' });assert.equal(badJson.status,400);
 const tooLarge=await net.request('/api/admin/battery-state/devices',{method:'POST',headers:{Cookie:'__Host-start_session=admin',Origin:net.origin,'Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(9000)})});assert.equal(tooLarge.status,413);
});
