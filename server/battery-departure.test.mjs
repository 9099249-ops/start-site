import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore,fleet} from './admin.mjs';
import {BatteryStateStore} from './battery-state.mjs';
import {BatteryTripStore} from './battery-trips.mjs';
import {departRental,initializeDepartures} from './rental-departure.mjs';

const BMS='41:18:12:01:37:50';
const local=ms=>new Date(ms+10800000).toISOString().slice(0,16);
function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");
 initializeDepartures(admin.db);
 const users={admin:{id:1,role:'admin'},staff:{id:2,role:'staff'}};admin.user=token=>users[token]||null;
 const battery=new BatteryStateStore(admin),trips=new BatteryTripStore(battery);t.after(()=>admin.close());
 const device=battery.manage({action:'create',requestId:randomUUID(),name:'Gateway',catamaranLabel:'Сашин',bmsId:BMS},users.admin);
 const epoch=Date.now(),packetStates=new Map();
 const makeDevice=(label='Сашин',mac='41:18:12:01:37:51')=>battery.manage({action:'create',requestId:randomUUID(),name:'Gateway '+mac,catamaranLabel:label,bmsId:mac},users.admin);
 const heartbeatDevice=(target,at,connected,disconnectAgeMs=0,options={})=>{
  const id=target.device.deviceId,previous=packetStates.get(id)||{boot:'deadbeef',sequence:-1},boot=options.boot||previous.boot;
  const sequence=boot===previous.boot?previous.sequence+1:0,uptimeMs=options.uptimeMs??Math.max(0,at-epoch),uptimeSeconds=options.uptimeSeconds??options.uptime;
  const result=battery.ingest({deviceId:id,bootId:boot,sequence,...(options.uptimeMs!==undefined?{uptimeMs:options.uptimeMs}:uptimeSeconds!==undefined?{uptimeSeconds}:{uptimeMs}),bmsId:target.device.bmsId,bmsConnected:connected,telemetry:null,bmsLastSeenAgeMs:connected?0:disconnectAgeMs,bmsDisconnectedAgeMs:connected?undefined:disconnectAgeMs,measurementAgeMs:0},target.token,at);
  packetStates.set(id,{boot,sequence});return result;
 };
 const heartbeat=(at,connected,disconnectAgeMs=0,options={})=>heartbeatDevice(device,at,connected,disconnectAgeMs,options);
 const rental=(now,{durationMs=3600000,quantity=1,departurePending=true}={})=>{
  const id=Number(admin.db.prepare('INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by,returned,expected_return,initial_due,extension_due,departure_pending) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'catamaran',quantity,'Guest','',local(now),now,1,null,now+durationMs,0,0,departurePending?1:0).lastInsertRowid);
  admin.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(id,10000,'cash',new Date(now).toISOString().slice(0,10),now,1,'fixture');return id;
 };
 const arm=(rentalId,now)=>trips.manage({action:'arm',requestId:randomUUID(),label:'Сашин',rentalId},users.admin,now).trip;
 const candidate=(rentalId,now)=>{const trip=arm(rentalId,now);heartbeat(now+1000,true);heartbeat(now+16000,false,15000);trips.tick(now+31000);return trips.overview(users.admin,now+31000).catamarans[0].trip;};
 const depart=(rentalId,trip,now,extra={})=>departRental(admin,fleet,{id:rentalId,revision:admin.db.prepare('SELECT revision FROM rentals WHERE id=?').get(rentalId).revision,batteryTripId:trip.id,batteryTripRevision:trip.revision,...extra},users.admin,now);
 return {admin,battery,trips,users,device,makeDevice,heartbeat,heartbeatDevice,rental,arm,candidate,depart};
}

test('delayed confirmation uses trusted disconnect time rather than click time',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),trip=f.candidate(id,now),confirmAt=now+180000,row=f.admin.db.prepare('SELECT expected_return,departed FROM rentals WHERE id=?').get(id),duration=row.expected_return-Date.parse(row.departed+':00+03:00');
 for(let at=now+40000;at<=confirmAt;at+=5000)f.heartbeat(at,false,15000);
 const result=f.depart(id,trip,confirmAt);
 assert.equal(result.departedAt,trip.detectedDepartureAt);assert.equal(result.expectedReturn,trip.detectedDepartureAt+duration);
 assert.equal(f.admin.db.prepare('SELECT departure_pending FROM rentals WHERE id=?').get(id).departure_pending,0);
});

test('backdated departure after paid time expires preserves the real start and does not collect overtime automatically',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now,{durationMs:1000}),trip=f.candidate(id,now),confirmAt=now+120000,paymentsBefore=f.admin.db.prepare('SELECT count(*) n FROM payments WHERE rental_id=?').get(id).n;
 for(let at=now+40000;at<=confirmAt;at+=5000)f.heartbeat(at,false,15000);
 const result=f.depart(id,trip,confirmAt),row=f.admin.db.prepare('SELECT departure_pending,departed_at,expected_return,extension_due FROM rentals WHERE id=?').get(id);
 assert.equal(result.departedAt,trip.detectedDepartureAt);assert.ok(result.expectedReturn<confirmAt);assert.equal(row.departure_pending,0);assert.equal(row.departed_at,trip.detectedDepartureAt);assert.equal(row.expected_return,result.expectedReturn);assert.equal(row.extension_due,0);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM payments WHERE rental_id=?').get(id).n,paymentsBefore);
});

test('restored BMS presence cancels the candidate before a confirmation click',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),trip=f.candidate(id,now);
 f.heartbeat(now+32000,true);f.trips.tick(now+32000);
 assert.throws(()=>f.depart(id,trip,now+33000),/изменил|подтверждается/i);
 assert.equal(f.admin.db.prepare('SELECT departure_pending FROM rentals WHERE id=?').get(id).departure_pending,1);
});

test('restoration and a new loss between overview polls retire the old candidate',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),old=f.candidate(id,now);
 f.heartbeat(now+32000,true);f.heartbeat(now+34000,false,1000);f.trips.tick(now+34000);
 assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(old.id).state,'armed');
 assert.throws(()=>f.depart(id,old,now+35000),{status:409});
 f.heartbeat(now+50000,false,17000);const fresh=f.trips.overview(f.users.admin,now+50000).catamarans[0].trip;
 assert.equal(fresh.state,'departure-candidate');assert.equal(fresh.detectedDepartureAt,now+33000);assert.notEqual(fresh.revision,old.revision);
 const result=f.depart(id,fresh,now+51000);assert.equal(result.departedAt,now+33000);
});

test('candidate from a different rental cannot confirm this rental',t=>{
 const f=fixture(t),now=Date.now(),one=f.rental(now),two=f.rental(now+1),trip=f.candidate(one,now);
 assert.throws(()=>departRental(f.admin,fleet,{id:two,revision:0,batteryTripId:trip.id,batteryTripRevision:trip.revision},f.users.admin,now+32000),/сигнал|недоступен/i);
});

test('replayed departure is idempotent and reboot cannot replay retired packet ordering',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),trip=f.candidate(id,now),body={id,revision:0,batteryTripId:trip.id,batteryTripRevision:trip.revision};
 const first=departRental(f.admin,fleet,body,f.users.admin,now+32000),again=departRental(f.admin,fleet,{...body,revision:first.revision},f.users.admin,now+33000);
 assert.equal(again.departedAt,first.departedAt);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM rental_changes WHERE rental_id=?').get(id).n,1);
 const stale=f.heartbeat(now+34000,true,0,{boot:'deadbeef',uptime:1});assert.equal(stale.duplicate,true);
});

test('foreign trip revision and stale rental revision are rejected',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),trip=f.candidate(id,now);
 assert.throws(()=>departRental(f.admin,fleet,{id,revision:0,batteryTripId:trip.id,batteryTripRevision:trip.revision+1},f.users.admin,now+32000),/изменил|подтверждается/i);
 assert.throws(()=>departRental(f.admin,fleet,{id,revision:99,batteryTripId:trip.id,batteryTripRevision:trip.revision},f.users.admin,now+32000),/Аренда изменилась/i);
});

test('invalid disconnected age cannot establish a candidate',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),trip=f.arm(id,now);
 f.heartbeat(now+1000,true);const invalid=f.heartbeat(now+16000,false,20000,{uptime:1});assert.equal(invalid.duplicate,true);
 f.trips.tick(now+31000);assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(trip.id).state,'armed');
});

test('uptime and sequence rollback, delayed packets, and retired boot replay cannot renew departure evidence',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),trip=f.arm(id,now);
 f.heartbeat(now+1000,true);
 assert.equal(f.heartbeat(now+2000,true,0,{uptimeMs:500}).duplicate,true);
 assert.equal(f.heartbeat(now+30000,false,15000,{uptimeMs:15000}).duplicate,true);
 f.heartbeat(now+31000,true,0,{boot:'cafebabe'});
 assert.equal(f.heartbeat(now+32000,true,0,{boot:'deadbeef',uptime:Math.floor((now+32000)/1000)}).duplicate,true);
 f.trips.tick(now+46000);assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(trip.id).state,'armed');
 const restarted=new BatteryStateStore(f.admin),body={deviceId:f.device.device.deviceId,bootId:'deadbeef',sequence:99,uptimeSeconds:Math.floor((now+47000)/1000),bmsId:BMS,bmsConnected:true,telemetry:null,measurementAgeMs:0};
 assert.equal(restarted.ingest(body,f.device.token,now+47000).duplicate,true);
});

test('normal manual departure uses server confirmation time while the linked BMS remains connected',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),trip=f.arm(id,now);f.heartbeat(now+1000,true);
 const result=departRental(f.admin,fleet,{id,revision:0},f.users.admin,now+5000);
 assert.equal(result.departedAt,now+5000);assert.notEqual(result.departedAt,trip.detectedDepartureAt);
 assert.equal(f.admin.db.prepare('SELECT departure_pending FROM rentals WHERE id=?').get(id).departure_pending,0);
 assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(trip.id).state,'away');
 f.heartbeat(now+6000,true);f.trips.tick(now+6000);
 assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(trip.id).state,'away','connected telemetry immediately after manual start is not return evidence');
 f.heartbeat(now+7000,false,0);f.trips.tick(now+7000);
 assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(trip.id).state,'away','explicit post-start BMS loss records absence without confirming return');
 f.heartbeat(now+8000,true);f.trips.tick(now+8000);
 assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(trip.id).state,'return-candidate');
});

test('absence on one of two devices assigned to a catamaran does not suggest departure',t=>{
 const f=fixture(t),now=Date.now(),second=f.makeDevice(),id=f.rental(now),trip=f.arm(id,now);
 f.heartbeat(now+1000,true);f.heartbeatDevice(second,now+1000,true);
 f.heartbeat(now+16000,false,15000);f.heartbeatDevice(second,now+16000,true);f.heartbeat(now+31000,false,15000);f.heartbeatDevice(second,now+31000,true);
 f.trips.tick(now+31000);const view=f.trips.overview(f.users.admin,now+31000).catamarans[0].trip;
 assert.equal(view.state,'armed');assert.equal(view.departureSuggested,false);assert.equal(trip.state,'armed');
});

test('BMS loss that began before trip assignment cannot create a departure candidate',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now);
 f.heartbeat(now+1000,true);f.heartbeat(now+16000,false,15000);const trip=f.arm(id,now+20000);
 for(let at=now+26000;at<=now+56000;at+=5000)f.heartbeat(at,false,15000);
 f.trips.tick(now+56000);assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(trip.id).state,'armed');
});

test('candidate keeps its exact trusted loss timestamp across store reconstruction',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now),trip=f.candidate(id,now);
 assert.equal(trip.detectedDepartureAt,now+1000);
 const battery=new BatteryStateStore(f.admin),restarted=new BatteryTripStore(battery),restored=restarted.overview(f.users.admin,now+32000).catamarans[0].trip;
 assert.equal(restored.id,trip.id);assert.equal(restored.state,'departure-candidate');assert.equal(restored.detectedDepartureAt,now+1000);
 assert.equal(f.depart(id,restored,now+33000).departedAt,now+1000);
});

test('64-bit monotonic uptime continues refreshing health across the 32-bit millisecond boundary',t=>{
 const f=fixture(t),now=Date.now();
 const before=f.heartbeat(now+1000,true,0,{uptimeMs:4294967290}),after=f.heartbeat(now+5000,true,0,{uptimeMs:4294971290});
 assert.equal(before.duplicate,false);assert.equal(after.duplicate,false);
 const projection=f.battery.projection(f.battery.row(f.device.device.deviceId),now+5001);
 assert.equal(projection.online,true);assert.equal(projection.bmsConnected,true);
 assert.equal(JSON.parse(f.admin.db.prepare('SELECT health_json FROM battery_devices WHERE device_id=?').get(f.device.device.deviceId).health_json).packetUptimeSeconds,4294971.29);
});
