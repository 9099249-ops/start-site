import {rentalPrice} from './rental-pricing.mjs';
import {availability, localStamp} from './calendar.mjs';

const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const staff=user=>{if(!['admin','staff'].includes(user?.role))fail('Недоступно для этой роли.',403);};
const transaction=(db,fn)=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
const log=(db,row,user,reason,after,now)=>db.prepare('INSERT INTO rental_changes(rental_id,actor,created,reason,before_json,after_json) VALUES(?,?,?,?,?,?)').run(row.id,user.id,now,reason,JSON.stringify({expected_return:row.expected_return,returned:row.returned}),JSON.stringify(after));

// Accrue extension charges now; receive them only when equipment is returned.
export function extendRental(store,fleet,b,user,now=Date.now()){
 staff(user);if(!Number.isSafeInteger(b.id)||!Number.isSafeInteger(b.revision)||![30,60].includes(b.minutes))fail('Выберите продление на 30 или 60 минут.',400);
 return transaction(store.db,()=>{
  const r=store.db.prepare('SELECT * FROM rentals WHERE id=?').get(b.id);
  if(r?.initial_due||store.rentalTerminal?.locked(r?.id))fail('Сначала завершите оплату на кассе.');if(!r||r.returned!==null||r.revision!==b.revision)fail('Аренда уже изменена. Обновите список.');
  const end=r.expected_return+b.minutes*60000;
  // An overdue rental continues to occupy stock indefinitely until physically returned.
  const a=availability(store.db,fleet,r.equipment,Math.max(now,localStamp(r.departed)),end>now?end:Number.MAX_SAFE_INTEGER,{ignoreRental:r.id,now,close:store.sms?.content?.live().close});
  if(a.available<r.quantity)fail('Продление пересекается с другой бронью. Выберите другое время.');
  const people=r.people??b.people;if(r.equipment==='big'&&(!Number.isSafeInteger(people)||people<1||people>20))fail('Укажите количество человек на Big SUP (1–20).',400);const fee=rentalPrice(store,r.equipment,r.quantity,b.minutes,people);if(r.equipment==='big'&&r.people===null)store.db.prepare('UPDATE rentals SET people=? WHERE id=?').run(people,r.id);const due=r.extension_due+fee;if(!Number.isSafeInteger(due)||due>100000000)fail('Слишком большая сумма продления.',400);store.db.prepare('UPDATE rentals SET expected_return=?,extension_due=?,revision=revision+1 WHERE id=?').run(end,due,r.id);
  log(store.db,r,user,'Продление на '+b.minutes+' мин',{expected_return:end,returned:null,extension_due:due,added_cents:fee},now);
  return {id:r.id,expectedReturn:end,extensionDue:due,addedCents:fee,revision:r.revision+1};
 });
}

export function undoReturn(store,fleet,b,user,now=Date.now()){
 staff(user);if(!Number.isSafeInteger(b.id)||!Number.isSafeInteger(b.revision)||!Number.isSafeInteger(b.returnedAt))fail('Неверная операция.',400);
 return transaction(store.db,()=>{
  const r=store.db.prepare('SELECT * FROM rentals WHERE id=?').get(b.id);
  if(!r||r.revision!==b.revision||r.returned!==b.returnedAt||r.returned_by!==user.id||now-r.returned>15000||now<r.returned)fail('Отмена возврата уже недоступна. Проверьте аренду.');
  if(store.db.prepare("SELECT id FROM payments WHERE rental_id=? AND note='Доплата за продление при возврате'").get(r.id))fail('Доплата уже принята. Для отмены нужна сверка кассы администратором.');
  const a=availability(store.db,fleet,r.equipment,now,r.expected_return>now?r.expected_return:Number.MAX_SAFE_INTEGER,{ignoreRental:r.id,now,close:store.sms?.content?.live().close});
  const used=store.db.prepare('SELECT coalesce(sum(quantity),0) n FROM rentals WHERE equipment=? AND returned IS NULL').get(r.equipment).n;
  if(a.available<r.quantity||used+r.quantity>fleet.find(f=>f[0]===r.equipment)[2])fail('Техника уже занята другой выдачей или бронью. Отмена невозможна.');
  store.db.prepare('UPDATE rentals SET returned=NULL,returned_by=NULL,revision=revision+1 WHERE id=?').run(r.id);
  log(store.db,r,user,'Отмена ошибочного возврата',{expected_return:r.expected_return,returned:null},now);
  return {ok:true};
 });
}

const normal=s=>String(s||'').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]/gu,'');
const phone=s=>{const n=String(s||'').replace(/\D/g,'');return n.length===11&&/^[78]/.test(n)?n.slice(1):n;};
export function deskSearch(store,fleet,query,user){
 staff(user);const q=String(query||'').trim().slice(0,100);if(q.length<2)return {rentals:[],bookings:[],clients:[]};
 const db=store.db,n=normal(q),p=phone(q),isPhone=/^[+\d\s()-]+$/.test(q)&&p.length>=4;
 db.function('desk_match',(name,number,id,equipment)=>{
  const label=fleet.find(f=>f[0]===equipment)?.[1]||'';
  const words=normal([name,label,equipment].join(' '));
  return Number(words.includes(n)||String(id||'')===q.replace(/^№\s*/,'')||isPhone&&phone(number).includes(p));
 });
 const rentals=db.prepare('SELECT r.id,r.equipment,r.quantity,r.name,r.phone,r.departed,r.expected_return,r.returned,r.revision,r.initial_due,(SELECT coalesce(sum(amount),0) FROM payments WHERE rental_id=r.id) paid,(SELECT method FROM payments WHERE rental_id=r.id ORDER BY id LIMIT 1) method FROM rentals r WHERE desk_match(name,phone,id,equipment) ORDER BY returned IS NULL DESC,id DESC LIMIT 30').all();
 const bookings=db.prepare("SELECT id,details,status,revision,rental_id FROM inquiries WHERE desk_match(json_extract(details,'$.name'),json_extract(details,'$.phone'),id,json_extract(details,'$.equipment')) ORDER BY status='confirmed' DESC,id DESC LIMIT 30").all().map(r=>({...r,details:JSON.parse(r.details)}));
 const hasClients=db.prepare("SELECT name FROM sqlite_master WHERE name='clients'").get();
 const clients=hasClients?db.prepare('SELECT id,name,phone FROM clients WHERE desk_match(name,phone,NULL,NULL) ORDER BY last_seen DESC LIMIT 20').all():[];
 return {rentals,bookings,clients};
}

export function nearbyBookings(store,now=Date.now()){
 const day=new Date(now+10800000).toISOString().slice(0,10);
 return store.db.prepare("SELECT id,details,status,revision FROM inquiries WHERE status='confirmed' AND json_extract(details,'$.plan')<>'season' AND json_extract(details,'$.date')>=? ORDER BY json_extract(details,'$.date'),json_extract(details,'$.time'),id LIMIT 8").all(day).map(r=>({...r,details:JSON.parse(r.details)}));
}
