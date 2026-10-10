import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {localStamp} from './calendar.mjs';
import {rentalPrice} from './rental-pricing.mjs';

const labels=['Сашин','Наташин','С серой крышей'];
const active=['armed','departure-candidate','away','return-candidate'];
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const staff=u=>{if(!['admin','staff'].includes(u?.role)||u.scheduleOnly)fail('Недоступно для этой роли.',403);};
const requestKey=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{16,80}$/.test(x);

// Radio evidence is deliberately kept separate from rental/payment records.
export class BatteryTripStore {
 constructor(battery){this.battery=battery;this.admin=battery.admin;this.db=battery.db;this.db.exec(readFileSync(new URL('./migrations/battery-control.sql',import.meta.url),'utf8'));this.admin.batteryTrips=this;}
 rental(id){return this.db.prepare("SELECT r.*,(SELECT coalesce(sum(amount),0) FROM payments WHERE rental_id=r.id) paid FROM rentals r WHERE r.id=?").get(id);}
 eligible(r){
  if(!r||r.equipment!=='catamaran'||r.returned!==null||r.initial_due!==0||r.paid<=0)return false;
  // Deferred/unpaid guest bills are not paid rentals, even if initial_due=0.
  if(this.db.prepare("SELECT name FROM sqlite_master WHERE name='guest_bill_lines'").get()){
   const bill=this.db.prepare("SELECT b.paid_at,b.cancelled_at FROM guest_bill_lines l JOIN guest_bills b ON b.id=l.bill_id WHERE l.kind='rental' AND l.source_id=?").get(r.id);
   if(bill&&(!bill.paid_at||bill.cancelled_at))return false;
  }
  return true;
 }
 devices(now){return this.db.prepare('SELECT * FROM battery_devices WHERE enabled=1 ORDER BY name,device_id').all().map(r=>({...this.battery.projection(r,now),presence:JSON.parse(r.health_json)}));}
 evidence(label,devices,now){
  const group=devices.filter(d=>d.catamaranLabel===label);
  // A failed/offline gateway is not evidence that a boat left the dock.
  const healthy=group.length>0&&group.every(d=>d.online);
  const seen=group.map(d=>d.bmsLastSeenAt).filter(x=>Number.isFinite(x)&&x<=now);
  const present=group.map(d=>d.presence.bmsPresentAt).filter(Number.isFinite);
  const lost=group.map(d=>d.presence.bmsDisconnectedAt);
  const observed=group.map(d=>d.presence.packetObservedAt);
  return {healthy,lastSeenAt:seen.length?Math.max(...seen):null,presentAt:present.length?Math.max(...present):null,
   connected:group.some(d=>d.bmsConnected),absent:healthy&&group.every(d=>d.bmsConnected===false)&&lost.every(Number.isFinite)&&observed.every(Number.isFinite),
   lostAt:lost.every(Number.isFinite)&&lost.length?Math.max(...lost):null,observedAt:observed.every(Number.isFinite)&&observed.length?Math.min(...observed):null};
 }
 assignPending(rentalId,label,user,now){
  const rental=this.rental(rentalId);
  if(!rental||rental.equipment!=='catamaran'||rental.quantity!==1||!rental.departure_pending||!labels.includes(label))fail('Выберите конкретный катамаран для этой аренды.');
  this.db.prepare("UPDATE battery_trips SET state='returned',updated_at=?,revision=revision+1 WHERE label=? AND state IN ('armed','departure-candidate','away','return-candidate') AND rental_id IN (SELECT id FROM rentals WHERE returned IS NOT NULL)").run(now,label);
  if(this.db.prepare("SELECT id FROM battery_trips WHERE label=? AND state IN ('armed','departure-candidate','away','return-candidate')").get(label))fail('Этот катамаран уже занят другой арендой.',409);
  const id=randomUUID();this.db.prepare('INSERT INTO battery_trips(id,label,rental_id,created_at,updated_at,actor_id) VALUES(?,?,?,?,?,?)').run(id,label,rentalId,now,now,user.id);
  this.db.prepare('INSERT INTO battery_trip_events(trip_id,kind,actor_id,created_at) VALUES(?,?,?,?)').run(id,'assigned',user.id,now);
 }
 departureEvidence(rental,body,now){
  const trip=this.db.prepare('SELECT * FROM battery_trips WHERE id=? AND rental_id=?').get(body.batteryTripId,rental.id);
  if(!trip||trip.state!=='departure-candidate'||trip.revision!==body.batteryTripRevision||rental.quantity!==1||!this.eligible(rental))fail('Сигнал отплытия изменился. Обновите аренду.',409);
  const e=this.evidence(trip.label,this.devices(now),now);
  if(!e.absent||e.connected||e.presentAt<trip.created_at||e.lostAt<trip.created_at||e.observedAt-e.lostAt<15000||e.lostAt>now||trip.detected_departure_at!==e.lostAt)fail('Сигнал отплытия больше не подтверждается.',409);
  return trip.detected_departure_at;
 }
 confirmedRental(rentalId,start,now,user){
  for(const trip of this.db.prepare("SELECT * FROM battery_trips WHERE rental_id=? AND state IN ('armed','departure-candidate')").all(rentalId)){
   this.db.prepare("UPDATE battery_trips SET state='away',confirmed_departure_at=?,detected_departure_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(now,start,now,trip.id);
   this.db.prepare('INSERT INTO battery_trip_events(trip_id,kind,actor_id,created_at) VALUES(?,?,?,?)').run(trip.id,'rental-departure-confirmed',user.id,now);
   if(trip.state==='departure-candidate')this.db.prepare('INSERT INTO battery_trip_events(trip_id,kind,created_at) VALUES(?,?,?)').run(trip.id,'absence-after-departure',now);
  }
 }
 tick(now=Date.now()){
  const devices=this.devices(now);
  return this.battery.tx(()=>{
   for(const trip of this.db.prepare("SELECT * FROM battery_trips WHERE state IN ('armed','departure-candidate','away','return-candidate')").all()){
    const rental=this.rental(trip.rental_id);
    if(!rental||rental.returned!==null){this.db.prepare("UPDATE battery_trips SET state='returned',updated_at=?,revision=revision+1 WHERE id=?").run(now,trip.id);continue;}
    const e=this.evidence(trip.label,devices,now);if(!e.healthy)continue;
    let departureAbsence=this.db.prepare("SELECT id FROM battery_trip_events WHERE trip_id=? AND kind IN ('absence-after-departure','confirm-departure') AND created_at>=? LIMIT 1").get(trip.id,trip.confirmed_departure_at??now);
    if(trip.state==='away'&&!departureAbsence&&e.absent&&!e.connected&&e.lostAt>=(trip.detected_departure_at??trip.confirmed_departure_at??now)){
     this.db.prepare('INSERT INTO battery_trip_events(trip_id,kind,created_at) VALUES(?,?,?)').run(trip.id,'absence-after-departure',now);departureAbsence=true;
    }
    if(trip.state==='departure-candidate'&&(e.connected||e.lostAt!==trip.detected_departure_at)){this.db.prepare("UPDATE battery_trips SET state='armed',detected_departure_at=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(now,trip.id);this.db.prepare('INSERT INTO battery_trip_events(trip_id,kind,created_at) VALUES(?,?,?)').run(trip.id,'presence-restored',now);continue;}
    const lastSeen=Math.max(trip.last_seen_at??0,e.lastSeenAt??0)||null;
    if(lastSeen!==trip.last_seen_at)this.db.prepare('UPDATE battery_trips SET last_seen_at=? WHERE id=?').run(lastSeen,trip.id);
    let kind=null;
    if(trip.state==='armed'&&this.eligible(rental)&&e.absent&&!e.connected&&e.presentAt!==null&&e.presentAt>=trip.created_at&&e.lostAt>=trip.created_at&&e.observedAt-e.lostAt>=15000){
     kind='departure-candidate';this.db.prepare("UPDATE battery_trips SET state=?,detected_departure_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(kind,e.lostAt,now,trip.id);
    }else if(trip.state==='away'&&departureAbsence&&e.connected&&lastSeen!==null&&lastSeen>(trip.confirmed_departure_at??trip.detected_departure_at??now)&&now-lastSeen<=45000){
     kind='return-candidate';this.db.prepare('UPDATE battery_trips SET state=?,detected_return_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(kind,lastSeen,now,trip.id);
    }
    if(kind)this.db.prepare('INSERT INTO battery_trip_events(trip_id,kind,created_at) VALUES(?,?,?)').run(trip.id,kind,now);
   }
  });
 }
 projection(trip,now){
  const r=this.rental(trip.rental_id);if(!r)return null;
  const start=r.departed_at??localStamp(r.departed),arrival=trip.detected_return_at??now;
  const overdueMinutes=r.departure_pending||!Number.isFinite(r.expected_return)?0:Math.max(0,Math.ceil((arrival-r.expected_return)/60000));
  const extraMinutes=overdueMinutes?Math.ceil(overdueMinutes/30)*30:0;
  const overtimeCents=extraMinutes?rentalPrice(this.admin,r.equipment,r.quantity,extraMinutes,r.people):0;
  const e=this.evidence(trip.label,this.devices(now),now),departureSuggested=trip.state==='departure-candidate'&&!!r.departure_pending&&r.quantity===1&&this.eligible(r)&&e.absent&&!e.connected&&e.lostAt===trip.detected_departure_at&&e.observedAt-e.lostAt>=15000;
  return {id:trip.id,label:trip.label,rentalId:trip.rental_id,state:trip.state,revision:trip.revision,rentalRevision:r.revision,departurePending:!!r.departure_pending,departureSuggested,detectedDepartureAt:trip.detected_departure_at,detectedReturnAt:trip.detected_return_at,confirmedDepartureAt:trip.confirmed_departure_at,confirmedReturnAt:trip.confirmed_return_at,lastSeenAt:trip.last_seen_at,dueRub:(r.extension_due+overtimeCents)/100,existingDueRub:r.extension_due/100,overtimeQuoteRub:overtimeCents/100,quoteMinutes:extraMinutes,estimated:true,clientLabel:r.name,start,expectedReturn:r.expected_return,rentalQuantity:r.quantity};
 }
 overview(user,now=Date.now()){
  staff(user);this.tick(now);const devices=this.devices(now);
  const rentals=this.db.prepare("SELECT r.*,(SELECT coalesce(sum(amount),0) FROM payments WHERE rental_id=r.id) paid FROM rentals r WHERE r.equipment='catamaran' AND r.returned IS NULL ORDER BY r.departed,r.id").all().filter(r=>this.eligible(r)).map(r=>({id:r.id,clientLabel:r.name,start:localStamp(r.departed),expectedReturn:r.expected_return,quantity:r.quantity}));
  return {now,colorSettings:this.battery.colorSettings(),catamarans:labels.map(label=>{
   const trip=this.db.prepare('SELECT * FROM battery_trips WHERE label=? ORDER BY created_at DESC LIMIT 1').get(label);
   return {label,devices:devices.filter(d=>d.catamaranLabel===label).map(d=>{const temperatures=d.telemetry?.temperaturesC?.filter(Number.isFinite)??[],statusAge=d.telemetry?.fieldAgesMs?.status;return {deviceId:d.deviceId,name:d.name,socPercent:d.telemetry?.socPercent??null,voltageV:d.telemetry?.voltageV??null,currentA:d.telemetry?.currentA??null,state:d.telemetry?.state??'unknown',stateFresh:Number.isFinite(statusAge)&&statusAge<=d.staleAfterSeconds*1000,temperatureC:temperatures.length?Math.max(...temperatures):null,estimatedMinutes:d.estimate?.kind==='discharge'?d.estimate.minutes:null,estimatedChargeMinutes:d.estimate?.kind==='charge'?d.estimate.minutes:null,online:d.online,stale:d.stale,bmsConnected:d.bmsConnected,lastMeasuredAt:d.lastMeasuredAt};}),trip:trip?this.projection(trip,now):null};
  }),rentals};
 }
 manage(body,user,now=Date.now()){
  staff(user);if(!body||typeof body!=='object'||!requestKey(body.requestId))fail('Неверный ключ операции.');
  if(!['arm','confirm-departure','confirm-return','dismiss'].includes(body.action))fail('Неизвестное действие.');
  const fingerprint=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(k=>[k,body[k]])))).digest('hex');
  return this.battery.tx(()=>{
   const old=this.db.prepare('SELECT * FROM battery_trip_requests WHERE request_id=?').get(body.requestId);
   if(old){if(old.fingerprint!==fingerprint||old.actor_id!==user.id)fail('Ключ операции уже использован.',409);return {trip:this.projection(this.db.prepare('SELECT * FROM battery_trips WHERE id=?').get(old.trip_id),now),duplicate:true};}
   let tripId;
   if(body.action==='arm'){
    if(!labels.includes(body.label)||!Number.isSafeInteger(body.rentalId))fail('Выберите катамаран и оплаченную аренду.');
    const rental=this.rental(body.rentalId);if(!this.eligible(rental))fail('Эта аренда не оплачена или уже завершена.',409);
    if(this.db.prepare("SELECT id FROM battery_trips WHERE label=? AND state IN ('armed','departure-candidate','away','return-candidate')").get(body.label))fail('Катамаран уже связан с другой арендой.',409);
    const count=this.db.prepare("SELECT count(*) n FROM battery_trips WHERE rental_id=? AND state IN ('armed','departure-candidate','away','return-candidate')").get(body.rentalId).n;
    if(count>=rental.quantity)fail('Все катамараны этой аренды уже назначены.',409);
    const evidence=this.evidence(body.label,this.devices(now),now);tripId=randomUUID();
    this.db.prepare('INSERT INTO battery_trips(id,label,rental_id,created_at,updated_at,actor_id,last_seen_at) VALUES(?,?,?,?,?,?,?)').run(tripId,body.label,body.rentalId,now,now,user.id,evidence.lastSeenAt);
   }else{
    const trip=this.db.prepare('SELECT * FROM battery_trips WHERE id=?').get(body.tripId);
    if(!trip)fail('Связь с арендой не найдена.',404);
    if(!Number.isSafeInteger(body.revision)||body.revision!==trip.revision)fail('Событие изменилось. Обновите карточку.',409);
    if(!active.includes(trip.state))fail('Событие уже завершено.',409);
    tripId=trip.id;
    if(body.action==='confirm-departure'){
     if(trip.state!=='departure-candidate')fail('Предполагаемый выезд ещё не обнаружен.',409);
     const rental=this.rental(trip.rental_id);
     if(!this.eligible(rental))fail('Оплата или состояние аренды изменились.',409);
     if(rental.departure_pending)fail('Сначала подтвердите отплытие аренды через «Отплыли».',409);
     this.db.prepare("UPDATE battery_trips SET state='away',confirmed_departure_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(now,now,tripId);
     this.db.prepare('INSERT INTO battery_trip_events(trip_id,kind,created_at) VALUES(?,?,?)').run(tripId,'absence-after-departure',now);
    }else if(body.action==='confirm-return'){
     if(trip.state!=='return-candidate')fail('Предполагаемый возврат ещё не обнаружен.',409);
     this.db.prepare("UPDATE battery_trips SET state='returned',confirmed_return_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(now,now,tripId);
    }else if(trip.state==='departure-candidate'){
     // Reject a sleep/range false positive, then require new presence evidence.
     this.db.prepare("UPDATE battery_trips SET state='armed',created_at=?,last_seen_at=NULL,detected_departure_at=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(now,now,tripId);
    }else if(trip.state==='return-candidate'){
     this.db.prepare("UPDATE battery_trips SET state='away',confirmed_departure_at=?,detected_return_at=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(now,now,tripId);
    }else this.db.prepare("UPDATE battery_trips SET state='dismissed',updated_at=?,revision=revision+1 WHERE id=?").run(now,tripId);
   }
   this.db.prepare('INSERT INTO battery_trip_requests(request_id,fingerprint,trip_id,actor_id,created_at) VALUES(?,?,?,?,?)').run(body.requestId,fingerprint,tripId,user.id,now);
   this.db.prepare('INSERT INTO battery_trip_events(trip_id,kind,actor_id,created_at) VALUES(?,?,?,?)').run(tripId,body.action,user.id,now);
   return {trip:this.projection(this.db.prepare('SELECT * FROM battery_trips WHERE id=?').get(tripId),now)};
  });
 }
}

export function batteryTripHandler(store,admin,origin){return async(req,res,url)=>{
 const read=url.pathname==='/api/admin/battery-overview',manage=url.pathname==='/api/admin/battery-trips';if(!read&&!manage)return false;
 const reply=(status,body)=>{const encoded=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(encoded),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:encoded);return true;};
 try{
  if(!store||!admin)return reply(503,{error:'Аккумуляторы не настроены.'});
  const sid=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.slice(21),user=admin.user(sid);if(!user)return reply(401,{error:'Войдите в админку.'});staff(user);
  if(read){if(!['GET','HEAD'].includes(req.method))return reply(405,{error:'Метод не поддерживается.'});return reply(200,store.overview(user));}
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});
  if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return reply(403,{error:'Недопустимый источник запроса.'});
  let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>8192){req.resume();return reply(413,{error:'Запрос слишком большой.'});}chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'Неверный JSON.'});}return reply(200,store.manage(body,user));
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось обработать событие катамарана.'});}
};}
