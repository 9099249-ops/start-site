import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {BatteryStateStore} from './battery-state.mjs';
import {BatteryTripStore,batteryTripHandler} from './battery-trips.mjs';
import {rentalPrice} from './rental-pricing.mjs';

const BMS='41:18:12:01:37:50';
const isoLocal=ms=>new Date(ms+10800000).toISOString().slice(0,16);
function fixture(t){
 const admin=new AdminStore(':memory:');admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'schedule','staff','unused')");
 if(!admin.db.prepare('PRAGMA table_info(rentals)').all().some(column=>column.name==='departure_pending'))admin.db.exec('ALTER TABLE rentals ADD COLUMN departure_pending INTEGER NOT NULL DEFAULT 0');
 admin.db.exec("CREATE TABLE guest_bills(id INTEGER PRIMARY KEY,paid_at INTEGER,cancelled_at INTEGER);CREATE TABLE guest_bill_lines(id INTEGER PRIMARY KEY,bill_id INTEGER,kind TEXT,source_id INTEGER,amount INTEGER)");
 const users={admin:{id:1,role:'admin'},staff:{id:2,role:'staff'},schedule:{id:3,role:'staff',scheduleOnly:true}};admin.user=token=>users[token]||null;
 const battery=new BatteryStateStore(admin),trips=new BatteryTripStore(battery);t.after(()=>admin.close());
 const device=(label='Сашин',mac=BMS,extra={})=>{const x=battery.manage({action:'create',requestId:randomUUID(),name:'Gateway '+label,catamaranLabel:label,bmsId:mac,...extra},users.admin);return x;};
 const rental=(now,{paid=true,quantity=1,initialDue=0,extensionDue=0,returned=null,guestBill=null,departurePending=false}={})=>{
  const id=Number(admin.db.prepare('INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by,returned,returned_by,expected_return,initial_due,extension_due,people,custom_json,departure_pending) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'catamaran',quantity,'Guest','',isoLocal(now-3600000),now-3600000,1,returned,returned?1:null,now-60000,initialDue,extensionDue,null,null,departurePending?1:0).lastInsertRowid);
  if(paid)admin.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(id,10000,'cash',new Date(now).toISOString().slice(0,10),now,1,'fixture');
  if(guestBill){admin.db.prepare('INSERT INTO guest_bills(id,paid_at,cancelled_at) VALUES(?,?,?)').run(guestBill.id,guestBill.paidAt,guestBill.cancelledAt);admin.db.prepare("INSERT INTO guest_bill_lines(bill_id,kind,source_id,amount) VALUES(?,'rental',?,10000)").run(guestBill.id,id);}
  return id;
 };
 const packetState=new Map();
 const heartbeat=(dev,at,{connected=true,disconnectAgeMs=0,bootId='deadbeef'}={})=>{
  const previous=packetState.get(dev.device.deviceId)||{sequence:0,bootId};
  const sequence=previous.bootId===bootId?previous.sequence+1:0;
  packetState.set(dev.device.deviceId,{sequence,bootId});
  return battery.ingest({deviceId:dev.device.deviceId,bootId,sequence,uptimeSeconds:Math.floor(at/1000),measurementAgeMs:0,bmsId:dev.device.bmsId,bmsConnected:connected,telemetry:null,bmsLastSeenAgeMs:connected?0:disconnectAgeMs,bmsDisconnectedAgeMs:connected?undefined:disconnectAgeMs,controlCapabilityVersion:1},dev.token,at);
 };
 return {admin,battery,trips,users,device,rental,heartbeat};
}
function body(action,extra={}){return {action,requestId:randomUUID(),...extra};}
function httpFor(t,f){const origin='http://station.test',handler=batteryTripHandler(f.trips,f.admin,origin),server=http.createServer(async(req,res)=>{if(await handler(req,res,new URL(req.url,'http://127.0.0.1')))return;res.writeHead(404);res.end();});return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{t.after(()=>new Promise(r=>server.close(r)));resolve({origin,request:(path,options={})=>fetch('http://127.0.0.1:'+server.address().port+path,options)});}));}

test('admin and staff can read trip overview, schedule-only and anonymous callers cannot; only same-origin JSON changes',async t=>{
 const f=fixture(t),net=await httpFor(t,f),get=cookie=>net.request('/api/admin/battery-overview',{headers:cookie?{Cookie:`__Host-start_session=${cookie}`}:{}});
 assert.equal((await get()).status,401);assert.equal((await get('schedule')).status,403);assert.equal((await get('staff')).status,200);assert.equal((await get('admin')).status,200);
 const post=(payload,cookie='admin',origin=net.origin,type='application/json')=>net.request('/api/admin/battery-trips',{method:'POST',headers:{Cookie:`__Host-start_session=${cookie}`,Origin:origin,'Content-Type':type},body:JSON.stringify(payload)});
 assert.equal((await post(body('arm',{label:'Сашин',rentalId:99}),'staff')).status,409); // Staff may operate only against a real paid rental.
 assert.equal((await post(body('arm',{label:'Сашин',rentalId:99}),'admin','https://evil.invalid')).status,403);
 assert.equal((await post(body('arm',{label:'Сашин',rentalId:99}),'admin',net.origin,'text/plain')).status,403);
});

test('only paid, active catamaran rentals arm; individual boat capacity cannot exceed rental quantity',t=>{
 const f=fixture(t),now=Date.now(),paid=f.rental(now,{quantity:2}),unpaid=f.rental(now,{paid:false}),due=f.rental(now,{initialDue:100}),returned=f.rental(now,{returned:now-1000});
 for(const id of [unpaid,due,returned])assert.throws(()=>f.trips.manage(body('arm',{label:'Сашин',rentalId:id}),f.users.admin,now),{status:409});
 const one=f.trips.manage(body('arm',{label:'Сашин',rentalId:paid}),f.users.admin,now);assert.equal(one.trip.state,'armed');
 assert.throws(()=>f.trips.manage(body('arm',{label:'Сашин',rentalId:paid}),f.users.admin,now+1),{status:409});
 const two=f.trips.manage(body('arm',{label:'Наташин',rentalId:paid}),f.users.admin,now+2);assert.equal(two.trip.rentalQuantity,2);
 assert.throws(()=>f.trips.manage(body('arm',{label:'С серой крышей',rentalId:paid}),f.users.admin,now+3),{status:409});
});

test('deferred unpaid guest-bill rental is ineligible even with zero initial due',t=>{
 const f=fixture(t),now=Date.now(),id=f.rental(now,{paid:false,guestBill:{id:1,paidAt:null,cancelledAt:null}});
 assert.throws(()=>f.trips.manage(body('arm',{label:'Сашин',rentalId:id}),f.users.admin,now),{status:409});
});

test('paid pending-departure rental remains eligible but cannot accrue overdue quote or confirm sensor departure until the existing departure action',t=>{
 const f=fixture(t),now=Date.now(),device=f.device(),rental=f.rental(now,{departurePending:true,extensionDue:1234});
 const armed=f.trips.manage(body('arm',{label:'Сашин',rentalId:rental}),f.users.admin,now);assert.equal(armed.trip.departurePending,true);assert.ok(armed.trip.rentalRevision>=0);
 f.heartbeat(device,now+1000);f.heartbeat(device,now+16000,{connected:false,disconnectAgeMs:15000});f.trips.tick(now+31000);const pending=f.trips.overview(f.users.admin,now+31000).catamarans[0].trip;
 assert.equal(pending.state,'departure-candidate');assert.equal(pending.departurePending,true);assert.equal(pending.quoteMinutes,0);assert.equal(pending.overtimeQuoteRub,0);assert.equal(pending.existingDueRub,12.34);assert.equal(pending.dueRub,12.34);
 assert.throws(()=>f.trips.manage(body('confirm-departure',{tripId:pending.id,revision:pending.revision}),f.users.admin,now+46001),{status:409});
 assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(pending.id).state,'departure-candidate');
 f.admin.db.prepare('UPDATE rentals SET departure_pending=0,revision=revision+1 WHERE id=?').run(rental);
 const rentalBefore=JSON.stringify(f.admin.db.prepare('SELECT id,returned,extension_due,revision,departure_pending FROM rentals WHERE id=?').get(rental));const paymentsBefore=JSON.stringify(f.admin.db.prepare('SELECT * FROM payments WHERE rental_id=?').all(rental));
 const departed=f.trips.manage(body('confirm-departure',{tripId:pending.id,revision:pending.revision}),f.users.admin,now+46002);
 assert.equal(departed.trip.state,'away');assert.equal(departed.trip.departurePending,false);
 assert.equal(JSON.stringify(f.admin.db.prepare('SELECT id,returned,extension_due,revision,departure_pending FROM rentals WHERE id=?').get(rental)),rentalBefore);
 assert.equal(JSON.stringify(f.admin.db.prepare('SELECT * FROM payments WHERE rental_id=?').all(rental)),paymentsBefore);
});

test('gateway offline or Wi-Fi silence cannot prove departure; explicit connected-loss evidence must persist 15 seconds',t=>{
 const f=fixture(t),now=Date.now(),device=f.device('Сашин'),rental=f.rental(now),
  armed=f.trips.manage(body('arm',{label:'Сашин',rentalId:rental}),f.users.admin,now);
 f.heartbeat(device,now+1000);f.heartbeat(device,now+15999,{connected:false,disconnectAgeMs:14998});f.trips.tick(now+15999);
 assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(armed.trip.id).state,'armed');
 f.heartbeat(device,now+16001,{connected:false,disconnectAgeMs:15000});f.heartbeat(device,now+31001,{connected:false,disconnectAgeMs:15000});f.trips.tick(now+31001);assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(armed.trip.id).state,'departure-candidate');
 const row=f.admin.db.prepare('SELECT detected_departure_at FROM battery_trips WHERE id=?').get(armed.trip.id);assert.equal(row.detected_departure_at,now+1001);
 const offline=f.device('Наташин','41:18:12:01:37:51',{staleAfterSeconds:30}),rental2=f.rental(now+50000);f.heartbeat(offline,now+50000);const armed2=f.trips.manage(body('arm',{label:'Наташин',rentalId:rental2}),f.users.admin,now+50001);
 f.trips.tick(now+95002);assert.equal(f.admin.db.prepare('SELECT state FROM battery_trips WHERE id=?').get(armed2.trip.id).state,'armed');
 assert.equal(offline.device.catamaranLabel,'Наташин');
});

test('candidate confirm/reject is revisioned and idempotent; return evidence never returns or charges the rental',t=>{
 const f=fixture(t),now=Date.now(),device=f.device(),rental=f.rental(now,{extensionDue:1234}),armed=f.trips.manage(body('arm',{label:'Сашин',rentalId:rental}),f.users.admin,now);
 f.heartbeat(device,now+1000);f.heartbeat(device,now+16000,{connected:false,disconnectAgeMs:15000});f.trips.tick(now+31000);const candidate=f.trips.overview(f.users.staff,now+31000).catamarans[0].trip;assert.equal(candidate.state,'departure-candidate');
 const rejectedBody=body('dismiss',{tripId:candidate.id,revision:candidate.revision}),rejected=f.trips.manage(rejectedBody,f.users.staff,now+46001),retry=f.trips.manage(rejectedBody,f.users.staff,now+46002);assert.equal(rejected.trip.state,'armed');assert.equal(retry.duplicate,true);
 assert.throws(()=>f.trips.manage(body('confirm-departure',{tripId:candidate.id,revision:candidate.revision}),f.users.admin,now+46003),{status:409});
 f.heartbeat(device,now+47000);f.heartbeat(device,now+62000,{connected:false,disconnectAgeMs:15000});f.trips.tick(now+77000);const c2=f.trips.overview(f.users.staff,now+77000).catamarans[0].trip;
 const departed=f.trips.manage(body('confirm-departure',{tripId:c2.id,revision:c2.revision}),f.users.admin,now+77001);assert.equal(departed.trip.state,'away');
 f.heartbeat(device,now+78000);f.trips.tick(now+78000);const back=f.trips.overview(f.users.staff,now+78000).catamarans[0].trip;assert.equal(back.state,'return-candidate');
 const rentalsBefore=JSON.stringify(f.admin.db.prepare('SELECT id,returned,extension_due,revision FROM rentals WHERE id=?').get(rental));const paymentsBefore=f.admin.db.prepare('SELECT count(*) n FROM payments WHERE rental_id=?').get(rental).n;
 const returned=f.trips.manage(body('confirm-return',{tripId:back.id,revision:back.revision}),f.users.admin,now+78001);assert.equal(returned.trip.state,'returned');
 assert.equal(JSON.stringify(f.admin.db.prepare('SELECT id,returned,extension_due,revision FROM rentals WHERE id=?').get(rental)),rentalsBefore);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM payments WHERE rental_id=?').get(rental).n,paymentsBefore);
 assert.equal(f.admin.db.prepare('SELECT returned FROM rentals WHERE id=?').get(rental).returned,null);assert.equal(armed.trip.id,returned.trip.id);
});

test('overdue quote uses existing rental tariff and 30-minute blocks without writing rent or payment rows',t=>{
 const f=fixture(t),now=Date.now(),rental=f.rental(now,{extensionDue:1234}),device=f.device(),before=JSON.stringify(f.admin.db.prepare('SELECT id,returned,extension_due,revision FROM rentals WHERE id=?').get(rental));
 const armed=f.trips.manage(body('arm',{label:'Сашин',rentalId:rental}),f.users.admin,now);f.heartbeat(device,now);
 const view=f.trips.overview(f.users.admin,now+3600001).catamarans[0].trip;
 const late=Math.max(0,Math.ceil((now+3600001-(now-60000))/60000)),minutes=Math.ceil(late/30)*30;
 assert.equal(view.quoteMinutes,minutes);assert.equal(view.overtimeQuoteRub,rentalPrice(f.admin,'catamaran',1,minutes,null)/100);assert.equal(view.existingDueRub,12.34);assert.equal(view.dueRub,12.34+view.overtimeQuoteRub);
 assert.equal(JSON.stringify(f.admin.db.prepare('SELECT id,returned,extension_due,revision FROM rentals WHERE id=?').get(rental)),before);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM payments WHERE rental_id=?').get(rental).n,1);assert.equal(armed.trip.state,'armed');
});
