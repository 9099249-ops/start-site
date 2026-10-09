import {localStamp,assertCapacity} from './calendar.mjs';

const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
export function initializeDepartures(db){
 const columns=new Set(db.prepare('PRAGMA table_info(rentals)').all().map(row=>row.name));
 if(!columns.has('departure_pending'))db.exec('ALTER TABLE rentals ADD COLUMN departure_pending INTEGER NOT NULL DEFAULT 0 CHECK(departure_pending IN (0,1))');
 if(!columns.has('departed_at'))db.exec('ALTER TABLE rentals ADD COLUMN departed_at INTEGER');
}

export function departRental(store,fleet,body,user,now=Date.now()){
 if(!['admin','staff'].includes(user?.role))fail('Недоступно для этой роли.',403);
 if(!Number.isSafeInteger(body.id)||!Number.isSafeInteger(body.revision))fail('Обновите список аренд.',400);
 return store.workforce.tx(()=>{
  const row=store.db.prepare('SELECT * FROM rentals WHERE id=?').get(body.id);
  if(!row||!fleet.some(item=>item[0]===row.equipment)||row.returned!==null)fail('Прокат уже возвращён или аренда недоступна.');
  if(!row.departure_pending){
   if(row.departed_at!==null)return {id:row.id,departedAt:row.departed_at,expectedReturn:row.expected_return,revision:row.revision};
   fail('Аренда уже началась.');
  }
  if(row.revision!==body.revision)fail('Аренда изменилась. Обновите список.');
  if(row.initial_due!==0||store.rentalTerminal?.locked(row.id))fail('Сначала завершите оплату на кассе.');
  const sensor=body.batteryTripId!==undefined;
  if(sensor&&(!store.batteryTrips||typeof body.batteryTripId!=='string'||!Number.isSafeInteger(body.batteryTripRevision)))fail('Обновите сигнал отплытия.',400);
  const start=sensor?store.batteryTrips.departureEvidence(row,body,now):now;
  const inquiry=store.db.prepare('SELECT details FROM inquiries WHERE rental_id=?').get(row.id);
  const plan=inquiry?JSON.parse(inquiry.details).plan:null;
  const duration=row.expected_return-localStamp(row.departed),expected=['day','takeaway'].includes(plan)?row.expected_return:start+duration;
  if(!Number.isSafeInteger(duration)||duration<=0)fail('Не удалось определить оплаченный срок. Проверьте аренду.');
  if(expected<=now&&!sensor)fail('Плановый срок возврата уже прошёл. Проверьте бронь до отплытия.');
  // A delayed departure must still fit the following confirmed reservations.
  assertCapacity(store.db,fleet,{equipment:row.equipment,quantity:row.quantity,start,end:expected},{ignoreRental:row.id,now,close:store.sms?.content?.live().close});
  const departed=new Date(start+10800000).toISOString().slice(0,16);
  store.db.prepare('UPDATE rentals SET departure_pending=0,departed_at=?,departed=?,expected_return=?,revision=revision+1 WHERE id=?').run(start,departed,expected,row.id);
  const before={departure_pending:1,departed:row.departed,expected_return:row.expected_return};
  const after={departure_pending:0,departed_at:start,departed,expected_return:expected,...(sensor?{battery_trip_id:body.batteryTripId,confirmed_at:now}:{})};
  store.db.prepare('INSERT INTO rental_changes(rental_id,actor,created,reason,before_json,after_json) VALUES(?,?,?,?,?,?)').run(row.id,user.id,now,'Отплытие',JSON.stringify(before),JSON.stringify(after));
  store.audit(user,'rental_departure',row.id);
  store.batteryTrips?.confirmedRental(row.id,start,now,user);
  return {id:row.id,departedAt:start,expectedReturn:expected,revision:row.revision+1};
 });
}
