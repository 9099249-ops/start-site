import {CashLedger} from './cash-ledger.mjs';
import {clientsXlsx} from './clients-export.mjs';
import {ScheduleStore} from './schedule.mjs';
import {fleetOrder,orderedFleet,saveFleetOrder} from './fleet-order.mjs';
import {RefundStore} from './refunds.mjs';
import {rentalRates} from './rental-pricing.mjs';
import {extendRental,undoReturn,deskSearch,nearbyBookings} from './rental-actions.mjs';
import {AccountsStore} from './accounts.mjs';
import {TasksStore} from './tasks.mjs';
import {WorkforceStore} from './workforce.mjs';
import {bookingWindow,localStamp,availability,assertCapacity,calendarData} from './calendar.mjs';
import {bookingText,sendBooking} from './telegram.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';

export const fleet=[['sup','САП',45],['electric','ЭлектроСАП',2],['kayak','Каяк одноместный',1],['kayak2','Каяк двухместный',1],['kayak3','Каяк трёхместный',1],['catamaran','Электрокатамаран',3],['bike','ВелоСАП',2],['boat','Катер без капитана',1],['captain','Катер с капитаном',1],['big','Big SUP',1],['rowing','Вёсельная лодка',2],['glow','Светящийся САП',2]];
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const line=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max&&!/[\x00-\x1f]/.test(s);
export const moscowDay=(now=Date.now())=>new Date(now+10800000).toISOString().slice(0,10);
const password=p=>{if(typeof p!=='string'||p.length<4||p.length>128)fail('Пароль должен содержать от 4 до 128 символов.');const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex');};
const verify=(p,s)=>{if(typeof p!=='string'||p.length>128)return false;const [salt,key]=s.split(':');return timingSafeEqual(scryptSync(p,salt,64),Buffer.from(key,'hex'));};
const amount=value=>{if(typeof value!=='string'||!/^\d{1,7}([.,]\d{1,2})?$/.test(value))fail('Укажите сумму в рублях, до двух знаков после запятой.');const [rub,kop='']=value.replace(',','.').split('.');return Number(rub)*100+Number(kop.padEnd(2,'0'));};
export class AdminStore{
 constructor(file){this.env=process.env;this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS admin_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_users(id INTEGER PRIMARY KEY,login TEXT UNIQUE NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES admin_users(id),expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS rentals(id INTEGER PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,equipment TEXT NOT NULL,quantity INTEGER NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,departed TEXT NOT NULL,created INTEGER NOT NULL,created_by INTEGER NOT NULL REFERENCES admin_users(id),returned INTEGER,returned_by INTEGER REFERENCES admin_users(id));
 CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,rental_id INTEGER NOT NULL REFERENCES rentals(id),amount INTEGER NOT NULL,method TEXT NOT NULL,day TEXT NOT NULL,created INTEGER NOT NULL,user_id INTEGER NOT NULL REFERENCES admin_users(id),note TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY,actor INTEGER NOT NULL,action TEXT NOT NULL,rental_id INTEGER,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS inquiries(id INTEGER PRIMARY KEY,receipt TEXT UNIQUE NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',notification TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL,updated INTEGER NOT NULL,actor INTEGER REFERENCES admin_users(id),rental_id INTEGER UNIQUE REFERENCES rentals(id),revision INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS inquiry_events(id INTEGER PRIMARY KEY,inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),actor INTEGER NOT NULL REFERENCES admin_users(id),status TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS rental_changes(id INTEGER PRIMARY KEY,rental_id INTEGER NOT NULL REFERENCES rentals(id),actor INTEGER NOT NULL REFERENCES admin_users(id),created INTEGER NOT NULL,reason TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS salary_settings(id INTEGER PRIMARY KEY CHECK(id=1),fixed_cents INTEGER NOT NULL DEFAULT 250000,bonus_percent INTEGER NOT NULL DEFAULT 5);
 INSERT OR IGNORE INTO salary_settings(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY,day TEXT UNIQUE NOT NULL,opened_at INTEGER NOT NULL,opened_by INTEGER NOT NULL REFERENCES admin_users(id),cash_start_cents INTEGER NOT NULL,closed_at INTEGER,closed_by INTEGER REFERENCES admin_users(id),cash_end_cents INTEGER,cashless_cents INTEGER,cash_revenue_cents INTEGER,total_revenue_cents INTEGER,bonus_pool_cents INTEGER);
 CREATE TABLE IF NOT EXISTS shift_employees(shift_id INTEGER NOT NULL REFERENCES shifts(id),user_id INTEGER NOT NULL REFERENCES admin_users(id),fixed_cents INTEGER NOT NULL,bonus_cents INTEGER NOT NULL,salary_cents INTEGER NOT NULL,PRIMARY KEY(shift_id,user_id));
 CREATE TABLE IF NOT EXISTS cash_movements(id INTEGER PRIMARY KEY,shift_id INTEGER NOT NULL REFERENCES shifts(id),type TEXT NOT NULL,amount_cents INTEGER NOT NULL,comment TEXT NOT NULL,created_at INTEGER NOT NULL,created_by INTEGER NOT NULL REFERENCES admin_users(id),voided_at INTEGER,voided_by INTEGER);
 CREATE TABLE IF NOT EXISTS payroll_payments(id INTEGER PRIMARY KEY,shift_id INTEGER NOT NULL,user_id INTEGER NOT NULL REFERENCES admin_users(id),amount_cents INTEGER NOT NULL,paid_at INTEGER NOT NULL,paid_by INTEGER NOT NULL REFERENCES admin_users(id));
 CREATE TABLE IF NOT EXISTS telegram_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 1,owner_chat_id TEXT NOT NULL DEFAULT '');
 INSERT OR IGNORE INTO telegram_settings(id) VALUES(1);
 `);if(!this.db.prepare('PRAGMA table_info(rentals)').all().some(c=>c.name==='revision'))this.db.exec('ALTER TABLE rentals ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');if(!this.db.prepare('PRAGMA table_info(rentals)').all().some(c=>c.name==='expected_return'))this.db.exec('ALTER TABLE rentals ADD COLUMN expected_return INTEGER');this.db.exec("UPDATE rentals SET expected_return=CAST(strftime('%s',departed||':00+03:00') AS INTEGER)*1000+3600000 WHERE expected_return IS NULL");for(const [name,type] of [['initial_due','INTEGER NOT NULL DEFAULT 0'],['extension_due','INTEGER NOT NULL DEFAULT 0'],['people','INTEGER'],['custom_json','TEXT']])if(!this.db.prepare('PRAGMA table_info(rentals)').all().some(c=>c.name===name))this.db.exec('ALTER TABLE rentals ADD COLUMN '+name+' '+type);this.accounts=new AccountsStore(this);this.workforce=new WorkforceStore(this);this.refunds=new RefundStore(this);this.cashLedger=new CashLedger(this);this.tasks=new TasksStore(this);this.schedule=new ScheduleStore(this);}
 configured(){return this.db.prepare('SELECT count(*) n FROM admin_users').get().n>0;}
 setupToken(token){if(this.configured())fail('Учётные записи уже созданы.',409);this.db.prepare("INSERT INTO admin_config VALUES('setup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash(token));}
 limit(key,limit=8,now=Date.now()){
  this.db.prepare('DELETE FROM admin_attempts WHERE expires<=?').run(now);
  key=hash(key);const row=this.db.prepare('SELECT count FROM admin_attempts WHERE key=?').get(key);
  if(row?.count>=limit)fail('Слишком много попыток. Повторите через 15 минут.',429);
  this.db.prepare('INSERT INTO admin_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+900000);
 }
 setup(b,ip){this.limit('setup:'+ip,5);if(this.configured())fail('Настройка уже завершена.',409);
  const stored=this.db.prepare("SELECT value FROM admin_config WHERE key='setup'").get();
  if(typeof b.token!=='string'||!stored||hash(b.token)!==stored.value)fail('Неверный код настройки.',403);
  const admin=password(b.adminPassword),staff=password(b.staffPassword);
  if(b.adminPassword===b.staffPassword)fail('Используйте разные пароли для двух учётных записей.');
  this.db.exec('BEGIN IMMEDIATE');try{if(this.configured())fail('Настройка уже завершена.',409);this.db.prepare('INSERT INTO admin_users(login,role,password) VALUES(?,?,?)').run('admin','admin',admin);this.db.prepare('INSERT INTO admin_users(login,role,password) VALUES(?,?,?)').run('station','staff',staff);this.db.prepare("DELETE FROM admin_config WHERE key='setup'").run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 login(b,ip){this.limit('login:'+ip);if(typeof b.login!=='string'||!/^[a-z][a-z0-9_-]{2,30}$/.test(b.login))fail('Неверный логин или пароль.',401);
  const u=this.db.prepare('SELECT * FROM admin_users WHERE login=?').get(b.login);
  if(!u||this.accounts.archived(u.id)||!verify(b.password,u.password))fail('Неверный логин или пароль.',401);
  const token=randomBytes(32).toString('hex');this.db.prepare('DELETE FROM admin_sessions WHERE expires<?').run(Date.now());this.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(hash(token),u.id,Date.now()+43200000);return token;
 }
 user(token){if(!token)return null;return this.db.prepare('SELECT u.id,u.login,u.role FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND NOT EXISTS(SELECT 1 FROM archived_accounts a WHERE a.user_id=u.id)').get(hash(token),Date.now())||null;}
 logout(token){this.db.prepare('DELETE FROM admin_sessions WHERE token=?').run(hash(token||''));}
 audit(user,action,id=null){this.db.prepare('INSERT INTO admin_audit(actor,action,rental_id,created) VALUES(?,?,?,?)').run(user.id,action,id,Date.now());}
 manualSale(b,u,now=Date.now()){
  if(!['admin','staff','waiter'].includes(u?.role))fail('Войдите в админку.',401);
  if(!/^[a-f0-9-]{36}$/.test(b.requestId||'')||!line(b.title,120)||!Number.isSafeInteger(b.quantity)||b.quantity<1||b.quantity>1000||!Number.isSafeInteger(b.unitCents)||b.unitCents<1||b.unitCents*b.quantity>100000000)fail('Укажите название, количество и цену больше нуля.');
  const details=JSON.stringify({title:b.title.trim(),quantity:b.quantity,unitCents:b.unitCents});
  return this.workforce.tx(()=>{const old=this.db.prepare('SELECT id,custom_json FROM rentals WHERE request_id=?').get(b.requestId);if(old){if(old.custom_json!==details)fail('Запрос уже использован. Проверьте историю продаж.',409);return {id:old.id,duplicate:true};}
   this.workforce.requireOnDuty(now);const local=new Date(now+10800000).toISOString().slice(0,16);
   const id=Number(this.db.prepare("INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by,returned,returned_by,expected_return,custom_json) VALUES(?,'manual',?,'Без клиента','',?,?,?,?,?,?,?)").run(b.requestId,b.quantity,local,now,u.id,now,u.id,now,details).lastInsertRowid);
   if(this.rentalTerminal?.enabled&&u.role!=='waiter')this.db.prepare('UPDATE rentals SET initial_due=? WHERE id=?').run(b.quantity*b.unitCents,id);else this.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(id,b.quantity*b.unitCents,'unspecified',moscowDay(now),now,u.id,'Свободная цена: '+b.title.trim());
   this.workforce.audit(u,'manual_sale',id,null,{...JSON.parse(details),totalCents:b.quantity*b.unitCents},'Продажа со свободной ценой',now);return {id};
  });
 }
 create(b,user,now=Date.now()){
  const item=fleet.find(x=>x[0]===b.equipment);
  if(!item||!Number.isInteger(b.quantity)||b.quantity<1||b.quantity>item[2])fail('Проверьте технику и количество.');
  if(!line(b.name,80)||!line(b.phone,32)||!/^\+?[\d ()-]+$/.test(b.phone)||!/^\d{10,15}$/.test(b.phone.replace(/\D/g,'')))fail('Укажите имя и полный телефон клиента.');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.departed||''))fail('Укажите дату и время отплытия.');
  const departure=Date.parse(b.departed+':00+03:00');
  if(!Number.isFinite(departure)||new Date(departure+10800000).toISOString().slice(0,16)!==b.departed||departure>now+300000||departure<now-86400000)fail('Время отплытия должно быть в пределах последних суток, не в будущем.');
  if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))fail('Обновите форму и повторите.');
  const paid=amount(b.amount);b.method=b.method||'unspecified';if(!['cash','card','unspecified'].includes(b.method))fail('Выберите способ оплаты.');
  this.db.exec('BEGIN IMMEDIATE');try{
   const previous=this.db.prepare('SELECT id FROM rentals WHERE request_id=?').get(b.requestId);if(previous){const link=this.guestBills?.link('rental',previous.id);if((b.guestBillId||null)!==(link?.id||null))fail('Запрос уже сохранён в другом счёте.',409);this.db.exec('COMMIT');return previous.id;}
   let inquiry;
   if(b.inquiryId!==undefined){
    if(!Number.isSafeInteger(b.inquiryId))fail('Неверная заявка.');
    inquiry=this.db.prepare('SELECT * FROM inquiries WHERE id=?').get(b.inquiryId);
    if(!inquiry||inquiry.status!=='confirmed'||inquiry.rental_id)fail('Заявка уже обработана или ещё не подтверждена.',409);
    if(JSON.parse(inquiry.details).plan==='season')fail('Заявка на покупку абонемента не является выдачей техники.');
   }
   const linked=inquiry?JSON.parse(inquiry.details):null;
   if(linked&&(linked.equipment!==b.equipment||(linked.equipment==='big'?1:linked.quantity)!==b.quantity))fail('Техника и количество должны совпадать с бронью.');
   const expected=b.expectedReturn?localStamp(b.expectedReturn):linked&&linked.plan!=='hour'?bookingWindow(linked,this.sms?.content?.live().close).end:departure+(linked?.duration||1)*3600000;
   if(expected<=departure)fail('Плановый возврат должен быть позже отплытия.');
   assertCapacity(this.db,fleet,{equipment:b.equipment,quantity:b.quantity,start:departure,end:expected},{ignoreInquiry:inquiry?.id||0,now,close:this.sms?.content?.live().close});
   const active=this.db.prepare('SELECT coalesce(sum(quantity),0) n FROM rentals WHERE equipment=? AND returned IS NULL').get(b.equipment).n;
   if(active+b.quantity>item[2])fail('Недостаточно свободной техники. Обновите список или отметьте возврат.',409);
   const id=Number(this.db.prepare('INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by) VALUES(?,?,?,?,?,?,?,?)').run(b.requestId,b.equipment,b.quantity,b.name.trim(),b.phone.trim(),b.departed,now,user.id).lastInsertRowid);
   const people=b.equipment==='big'?Number(b.people??linked?.quantity):null;if(b.equipment==='big'&&(!Number.isSafeInteger(people)||people<1||people>20))fail('Укажите количество человек на Big SUP (1–20).');this.db.prepare('UPDATE rentals SET expected_return=?,people=? WHERE id=?').run(expected,people,id);
   if(b.guestBillId!==undefined){if(!this.guestBills)fail('Счета недоступны.');const bill=this.guestBills.attach(b.guestBillId,'rental',id,paid,user);this.db.prepare('UPDATE rentals SET initial_due=? WHERE id=?').run(bill.deferred?0:paid,id);}else if(this.rentalTerminal?.enabled&&paid>0)this.db.prepare('UPDATE rentals SET initial_due=? WHERE id=?').run(paid,id);else this.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(id,paid,b.method,moscowDay(now),now,user.id,'Оплата при выдаче');if(inquiry){const status=this.rentalTerminal?.enabled&&paid>0?'payment_pending':'issued';this.db.prepare('UPDATE inquiries SET status=?,rental_id=?,actor=?,updated=?,revision=revision+1 WHERE id=?').run(status,id,user.id,now,inquiry.id);this.db.prepare('INSERT INTO inquiry_events(inquiry_id,actor,status,created) VALUES(?,?,?,?)').run(inquiry.id,user.id,status,now);}this.audit(user,'issue',id);this.db.exec('COMMIT');return id;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 returned(id,user,now=Date.now(),revision){
  if(!Number.isSafeInteger(id)||id<1)fail('Неверный номер проката.');
  this.db.exec('BEGIN IMMEDIATE');try{const row=this.db.prepare('SELECT * FROM rentals WHERE id=?').get(id);if(!row)fail('Прокат не найден.',404);if(row.initial_due!==0)fail('Сначала завершите оплату выдачи.',409);if(this.rentalTerminal?.enabled&&row.extension_due>0)fail('Доплата ожидает подтверждения кассы.',409);if(!row.returned){if(revision!==undefined&&revision!==row.revision)fail('Аренда изменена. Проверьте доплату и повторите возврат.',409);if(row.extension_due>0){const method=this.db.prepare('SELECT method FROM payments WHERE rental_id=? ORDER BY id LIMIT 1').get(id)?.method;if(!['cash','card','unspecified'].includes(method))fail('Проверьте способ оплаты выдачи.',409);this.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(id,row.extension_due,method,moscowDay(now),now,user.id,'Доплата за продление при возврате');this.db.prepare('UPDATE rentals SET extension_due=0 WHERE id=?').run(id);}this.db.prepare('UPDATE rentals SET returned=?,returned_by=?,revision=revision+1 WHERE id=?').run(now,user.id,id);this.audit(user,'return',id);}this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 receive(receipt,b,now=Date.now(),schedule){
  bookingText(b,new Date(now),schedule);
  const details={};for(const k of ['equipment','plan','date','time','returnDate','quantity','duration','name','phone'])if(b[k]!==undefined)details[k]=b[k];
  this.db.prepare('INSERT INTO inquiries(receipt,details,created,updated) VALUES(?,?,?,?) ON CONFLICT(receipt) DO NOTHING').run(receipt,JSON.stringify(details),now,now);
  return this.db.prepare('SELECT id FROM inquiries WHERE receipt=?').get(receipt).id;
 }
 received(receipt){return this.db.prepare('SELECT id FROM inquiries WHERE receipt=?').get(receipt);}
 notification(id,state){this.db.prepare('UPDATE inquiries SET notification=? WHERE id=?').run(state,id);}
 inquiries(status='new',before=0){
  if(!['new','confirmed','cancelled','issued','payment_pending'].includes(status)||!Number.isSafeInteger(before)||before<0)fail('Неверный фильтр.');
  const rows=this.db.prepare('SELECT i.*,u.login handledBy FROM inquiries i LEFT JOIN admin_users u ON u.id=i.actor WHERE i.status=? AND (?=0 OR i.id<?) ORDER BY i.id DESC LIMIT 51').all(status,before,before);
  return {rows:rows.slice(0,50).map(r=>({...r,details:JSON.parse(r.details)})),next:rows.length>50?rows[49].id:null,counts:this.db.prepare('SELECT status,count(*) count FROM inquiries GROUP BY status').all()};
 }
 inquiryStatus(b,user,now=Date.now()){
  if(!Number.isSafeInteger(b.id)||!Number.isSafeInteger(b.revision)||!['confirmed','cancelled'].includes(b.status))fail('Неверный статус заявки.');
  this.db.exec('BEGIN IMMEDIATE');try{
   const row=this.db.prepare('SELECT * FROM inquiries WHERE id=?').get(b.id);
   if(!row)fail('Заявка не найдена.',404);
   if(row.revision!==b.revision||!['new','confirmed'].includes(row.status)||row.status===b.status)fail('Заявка уже изменена. Обновите список.',409);
   if(b.status==='confirmed'){const details=JSON.parse(row.details);assertCapacity(this.db,fleet,bookingWindow(details,this.sms?.content?.live().close),{ignoreInquiry:row.id,now,close:this.sms?.content?.live().close});}
   if(b.reason==='no_show'){const w=bookingWindow(JSON.parse(row.details),this.sms?.content?.live().close);if(b.status!=='cancelled'||row.status!=='confirmed'||!w||now<=w.start+(this.sms?.settings().BOOKING_LATE_CANCEL_MINUTES||15)*60000)fail('Отметить неявку можно после допустимого опоздания.');}
   this.db.prepare('UPDATE inquiries SET status=?,actor=?,updated=?,revision=revision+1 WHERE id=?').run(b.status,user.id,now,b.id);
   this.db.prepare('INSERT INTO inquiry_events(inquiry_id,actor,status,created) VALUES(?,?,?,?)').run(b.id,user.id,b.reason==='no_show'?'no_show':b.status,now);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 history(id,user){if(user.role!=='admin')fail('Только администратор может смотреть историю исправлений.',403);return this.db.prepare('SELECT c.id,c.created,c.reason,c.before_json,c.after_json,u.login actor FROM rental_changes c JOIN admin_users u ON u.id=c.actor WHERE c.rental_id=? ORDER BY c.id DESC').all(id);}
 edit(b,user,now=Date.now()){
  if(user.role!=='admin')fail('Только администратор может исправлять записи.',403);
  if(!Number.isSafeInteger(b.id)||!Number.isSafeInteger(b.revision)||!line(b.reason,300))fail('Укажите причину исправления.');
  const item=fleet.find(x=>x[0]===b.equipment);
  if(!item||!Number.isInteger(b.quantity)||b.quantity<1||b.quantity>item[2])fail('Проверьте технику и количество.');
  if(!line(b.name,80)||!line(b.phone,32)||!/^\+?[\d ()-]+$/.test(b.phone)||!/^\d{10,15}$/.test(b.phone.replace(/\D/g,'')))fail('Укажите имя и полный телефон клиента.');
  const departure=Date.parse(b.departed+':00+03:00');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.departed||'')||!Number.isFinite(departure)||new Date(departure+10800000).toISOString().slice(0,16)!==b.departed||departure>now+300000)fail('Проверьте время отплытия.');
  const paid=amount(b.amount);b.method=b.method||'unspecified';if(!['cash','card','unspecified'].includes(b.method))fail('Выберите способ оплаты.');
  this.db.exec('BEGIN IMMEDIATE');try{
   const row=this.db.prepare('SELECT * FROM rentals WHERE id=?').get(b.id);if(!row)fail('Прокат не найден.',404);
   if(row.initial_due||this.rentalTerminal?.hasPayment(row.id)||this.guestBills?.link('rental',row.id))fail('Оплата связана с CS50. Сумму нельзя переписывать; используйте возврат.',409);if(row.revision!==b.revision)fail('Запись уже изменена. Закройте форму, обновите список и повторите.',409);
   if(row.returned!==null&&departure>row.returned)fail('Отплытие не может быть позже возврата.');
   if(this.refunds.history('rental',b.id).length)fail('У аренды есть возврат денег. Оплату нельзя переписать; история сохранена.',409);
   const payments=this.db.prepare('SELECT * FROM payments WHERE rental_id=?').all(b.id);if(payments.length!==1)fail('Для этой записи требуется отдельная сверка платежей.',409);
   if(row.returned===null){const used=this.db.prepare('SELECT coalesce(sum(quantity),0) n FROM rentals WHERE equipment=? AND returned IS NULL AND id<>?').get(b.equipment,b.id).n;if(used+b.quantity>item[2])fail('Недостаточно свободной техники.',409);}
   if(row.returned===null)assertCapacity(this.db,fleet,{equipment:b.equipment,quantity:b.quantity,start:departure,end:Math.max(row.expected_return||departure+3600000,now+1)},{ignoreRental:row.id,now,close:this.sms?.content?.live().close});
   const p=payments[0],before={equipment:row.equipment,quantity:row.quantity,name:row.name,phone:row.phone,departed:row.departed,amount:p.amount,method:p.method},after={equipment:b.equipment,quantity:b.quantity,name:b.name.trim(),phone:b.phone.trim(),departed:b.departed,amount:paid,method:b.method};
   if(JSON.stringify(before)===JSON.stringify(after))fail('Изменений нет.');
   this.db.prepare('UPDATE rentals SET equipment=?,quantity=?,name=?,phone=?,departed=?,revision=revision+1 WHERE id=?').run(after.equipment,after.quantity,after.name,after.phone,after.departed,b.id);
   this.db.prepare('UPDATE payments SET amount=?,method=? WHERE id=?').run(paid,b.method,p.id);
   this.db.prepare('INSERT INTO rental_changes(rental_id,actor,created,reason,before_json,after_json) VALUES(?,?,?,?,?,?)').run(b.id,user.id,now,b.reason.trim(),JSON.stringify(before),JSON.stringify(after));this.audit(user,'edit',b.id);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 dashboard(day,user){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)fail('Неверная дата.');
  const sql=`SELECT r.*,${this.guestBills?"(SELECT bill_id FROM guest_bill_lines WHERE kind='rental' AND source_id=r.id)":'NULL'} guestBillId,u.login issuedBy,v.login returnedBy,(SELECT method FROM payments p WHERE p.rental_id=r.id ORDER BY id LIMIT 1) method,(SELECT coalesce(sum(amount),0) FROM payments p WHERE p.rental_id=r.id) paid FROM rentals r JOIN admin_users u ON u.id=r.created_by LEFT JOIN admin_users v ON v.id=r.returned_by`;
  const reserved=this.db.prepare(sql+' WHERE r.returned IS NULL ORDER BY r.departed').all();const active=reserved.filter(r=>r.initial_due===0);const pendingRentals=this.db.prepare(sql+' WHERE r.initial_due>0 ORDER BY r.id').all();
  const returned=this.db.prepare(sql+" WHERE r.returned IS NOT NULL AND date(r.returned/1000,'unixepoch','+3 hours')=? ORDER BY r.returned DESC").all(day);
  const dayRentals=this.db.prepare(sql+" WHERE substr(r.departed,1,10)<=? AND (r.returned IS NULL OR date(r.returned/1000,'unixepoch','+3 hours')>=?) ORDER BY r.departed DESC,r.id DESC").all(day,day);
  const totals=this.db.prepare('SELECT method,sum(amount) amount FROM payments WHERE day=? GROUP BY method').all(day);
  const refundsCents=this.refunds.total(day,Date.now(),'rental');return {user,day,refundsCents,now:Date.now(),nearby:nearbyBookings(this),active,pendingRentals,rentalPayments:this.rentalTerminal?.list()||[],returned,dayRentals,totals,fleet:orderedFleet(this,fleet).map(([id,label,total])=>({id,label,total,price:rentalRates(this).find(i=>i.id===id)?.price??null,available:total-reserved.filter(r=>r.equipment===id).reduce((n,r)=>n+r.quantity,0)}))};
 }
 shiftSettings(user){if(user.role!=='admin')fail('Только администратор.',403);return this.db.prepare('SELECT * FROM salary_settings WHERE id=1').get();}
 saveShiftSettings(b,user){const s=this.workforce.settings();return this.workforce.saveSettings({revision:b.revision??s.revision,fixedCents:b.fixedCents,bonusPercent:b.bonusPercent,hourlyCents:s.hourly_cents,payMode:s.pay_mode,distribution:s.distribution},user);}
 currentShift(day=moscowDay()){return this.db.prepare('SELECT * FROM shifts WHERE day=?').get(day)||null;}
 openShift(b,user,now=Date.now()){if(this.workforce.desk.enabled)fail('Для начала рабочего дня нажмите «Я на смене» в верхней панели.',409);if(!['admin','staff'].includes(user.role))fail('Нет доступа.',403);if(!/^\d{4}-\d{2}-\d{2}$/.test(b.day)||!Number.isFinite(Date.parse(b.day+'T00:00:00+03:00'))||moscowDay(Date.parse(b.day+'T00:00:00+03:00'))!==b.day||!Number.isSafeInteger(b.cashStartCents)||b.cashStartCents<0||b.cashStartCents>100000000)fail('Укажите дату и кассу.');return this.workforce.tx(()=>{if(this.currentShift(b.day))fail('Смена на эту дату уже открыта.',409);const settings=this.workforce.daySettings(b.day,now,true);const id=Number(this.db.prepare('INSERT INTO shifts(day,opened_at,opened_by,cash_start_cents,salary_settings_json) VALUES(?,?,?,?,?)').run(b.day,now,user.id,b.cashStartCents,JSON.stringify(settings)).lastInsertRowid);this.workforce.audit(user,'cash_shift_open',id,null,this.currentShift(b.day),'Открытие кассы; сотрудники отмечаются лично',now);return id;});}
 shiftMovements(id){return this.db.prepare('SELECT m.*,u.login FROM cash_movements m JOIN admin_users u ON u.id=m.created_by WHERE m.shift_id=? AND m.voided_at IS NULL ORDER BY m.id').all(id);}
 addWithdrawal(b,user,now=Date.now(),{allowClosed=false}={}){if(!Number.isSafeInteger(b.shiftId)||!Number.isInteger(b.amountCents)||b.amountCents<=0||b.amountCents>100000000)fail('Проверьте сумму изъятия.');const s=this.db.prepare('SELECT * FROM shifts WHERE id=?').get(b.shiftId);if(!s||s.closed_at&&!allowClosed)fail('Смена закрыта или не найдена.',409);this.db.prepare("INSERT INTO cash_movements(shift_id,type,amount_cents,comment,created_at,created_by) VALUES(?,?,?,?,?,?)").run(s.id,'DIRECTOR_WITHDRAWAL',b.amountCents,line(b.comment||'',300)?b.comment:'',now,user.id);this.audit(user,'director_withdrawal',s.id);return this.shiftMovements(s.id);}
 closeShift(b,user,now=Date.now()){return this.workforce.closeCashShift(b,user,now);}
 shiftDetails(id){const s=this.db.prepare('SELECT * FROM shifts WHERE id=?').get(id);return {...s,withdrawals:this.shiftMovements(id),employees:this.db.prepare('SELECT e.*,u.login FROM shift_employees e JOIN admin_users u ON u.id=e.user_id WHERE e.shift_id=?').all(id)};}
 shiftTelegram(d){return ['СТАРТ — смена закрыта',`Дата: ${d.day}`,...(d.declared_revenue_cents===null||d.declared_revenue_cents===undefined?[`Наличные: ${(d.cash_revenue_cents/100).toFixed(2)} ₽`,`Безнал: ${(d.cashless_cents/100).toFixed(2)} ₽`]:[]),`Общая выручка: ${(d.total_revenue_cents/100).toFixed(2)} ₽`,'','К выплате:',...d.employees.map(e=>`${e.login} — ${(e.salary_cents/100).toFixed(2)} ₽`)].join('\n');}
 shifts(){return this.db.prepare('SELECT * FROM shifts ORDER BY day DESC LIMIT 100').all().map(s=>this.shiftDetails(s.id));}
 payroll(user){if(user.role!=='admin')fail('Только администратор.',403);return this.db.prepare("SELECT e.shift_id,e.user_id,e.salary_cents,e.login,s.day,coalesce((SELECT sum(p.amount_cents) FROM payroll_payments p WHERE p.shift_id=e.shift_id AND p.user_id=e.user_id),0) paid FROM (SELECT se.*,u.login FROM shift_employees se JOIN admin_users u ON u.id=se.user_id) e JOIN shifts s ON s.id=e.shift_id WHERE s.closed_at IS NOT NULL ORDER BY s.day DESC,e.login").all().map(x=>({...x,refund_adjustment_cents:this.refunds.closedAdjustment(x.shift_id,x.user_id),overpaid_cents:Math.max(0,x.paid-x.salary_cents+this.refunds.closedAdjustment(x.shift_id,x.user_id)),remaining_cents:Math.max(0,x.salary_cents-x.paid-this.refunds.closedAdjustment(x.shift_id,x.user_id))}));}
 telegramSettings(user){if(user.role!=='admin')fail('Только администратор.',403);const s=this.db.prepare('SELECT enabled,owner_chat_id FROM telegram_settings WHERE id=1').get();return {enabled:Boolean(s.enabled),configured:Boolean(this.env.TELEGRAM_BOT_TOKEN&&(s.owner_chat_id||this.env.TELEGRAM_OWNER_CHAT_ID||this.env.TELEGRAM_CHAT_ID)),ownerChatId:s.owner_chat_id||this.env.TELEGRAM_OWNER_CHAT_ID||this.env.TELEGRAM_CHAT_ID||''};}
 saveTelegramSettings(b,user){if(user.role!=='admin')fail('Только администратор.',403);if(typeof b.enabled!=='boolean'||(b.ownerChatId!==undefined&&!/^[-]?\d*$/.test(String(b.ownerChatId))))fail('Проверьте настройки Telegram.');this.db.prepare('UPDATE telegram_settings SET enabled=?,owner_chat_id=? WHERE id=1').run(b.enabled?1:0,String(b.ownerChatId||''));this.audit(user,'telegram_settings');return this.telegramSettings(user);}
 pay(b,user,now=Date.now()){return this.workforce.pay(b,user,now);}
 resetStaff(b,user){if(user.role!=='admin')fail('Только администратор может менять пароль сотрудника.',403);const p=password(b.password);this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("UPDATE admin_users SET password=? WHERE login='station'").run(p);this.db.prepare("DELETE FROM admin_sessions WHERE user_id=(SELECT id FROM admin_users WHERE login='station')").run();this.audit(user,'reset_staff_password');this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
 close(){this.db.close();}
}

export function adminHandler(store,origin){return async(req,res,url)=>{
 if(!url.pathname.startsWith('/api/admin/'))return false;
 const reply=(status,body,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(body));return true;};
 const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.split('=')[1];
 const cookie=t=>`__Host-start_session=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${t?43200:0}`;
 try{
  if(!store)return reply(503,{error:'Админка не настроена.'});
  if(req.method==='GET'&&url.pathname==='/api/admin/session')return reply(200,{user:store.user(token),configured:store.configured()});
  if(!['GET','POST'].includes(req.method))return reply(405,{error:'Метод не поддерживается.'});
  let b={};
  if(req.method==='POST'){
   if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return reply(403,{error:'Недопустимый источник запроса.'});
   let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)return reply(413,{error:'Запрос слишком большой.'});chunks.push(chunk);}try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'Неверный запрос.'});}
   if(!b||typeof b!=='object'||Array.isArray(b))return reply(400,{error:'Неверный запрос.'});
  }
  const ip=req.headers['x-real-ip']||req.socket.remoteAddress;
  if(req.method==='POST'&&url.pathname==='/api/admin/setup'){store.setup(b,ip);return reply(200,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/admin/login'){const t=store.login(b,ip);return reply(200,{ok:true},{'Set-Cookie':cookie(t)});}
  const user=store.user(token);if(!user)return reply(401,{error:'Войдите в админку.'});
  if(url.pathname.startsWith('/api/admin/guest-bills')){const g=store.guestBills;if(!g)return reply(503,{error:'Счета временно недоступны.'});if(req.method==='GET')return reply(200,url.searchParams.has('id')?g.get(Number(url.searchParams.get('id'))):g.list(user));const route=url.pathname.split('/').pop();if(route==='create')return reply(200,g.create(b,user));if(route==='pay')return reply(200,await g.begin(b,user));if(route==='cancel')return reply(200,g.cancel(b,user));if(route==='website-paid')return reply(200,g.manualWebsite(b,user));return reply(404,{error:'Неизвестное действие.'});}
  if(url.pathname==='/api/admin/cash-ledger')return reply(200,req.method==='GET'?store.cashLedger.summary(user):store.cashLedger.change(b,user));
  if(url.pathname==='/api/admin/clients.xlsx'&&req.method==='GET'){if(user.role!=='admin')return reply(403,{error:'Только администратор.'});res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename=clients.xlsx','Cache-Control':'no-store'});res.end(clientsXlsx(store));return true;}
  if(url.pathname==='/api/admin/fleet-order'&&req.method==='GET'){if(user.role!=='admin')return reply(403,{error:'Только администратор.'});return reply(200,fleetOrder(store,fleet));}
  if(url.pathname==='/api/admin/fleet-order'&&req.method==='POST')return reply(200,saveFleetOrder(store,fleet,b,user));
  if(url.pathname==='/api/admin/schedule'&&req.method==='GET')return reply(200,store.schedule.list(url.searchParams.get('week'),user));
  if(url.pathname==='/api/admin/schedule'&&req.method==='POST')return reply(200,store.schedule.save(b,user));
  if(url.pathname==='/api/admin/accounts'&&req.method==='GET')return reply(200,{items:store.accounts.list(user)});
  if(url.pathname==='/api/admin/accounts/password'&&req.method==='POST')return reply(200,store.accounts.password(b,user));
  if(url.pathname==='/api/admin/accounts/archive'&&req.method==='POST')return reply(200,store.accounts.archive(b,user));
  if(url.pathname==='/api/admin/tasks'&&req.method==='GET')return reply(200,{items:store.tasks.list(user)});
  if(url.pathname==='/api/admin/tasks/create'&&req.method==='POST')return reply(200,{id:store.tasks.create(b,user)});
  if(url.pathname==='/api/admin/tasks/edit'&&req.method==='POST')return reply(200,store.tasks.edit(b,user));
  if(url.pathname==='/api/admin/tasks/complete'&&req.method==='POST')return reply(200,store.tasks.complete(b,user));
  if(url.pathname==='/api/admin/manual-sale'&&req.method==='POST')return reply(200,store.manualSale(b,user));
  if(url.pathname==='/api/admin/refunds'&&req.method==='GET')return reply(200,store.refunds.info(url.searchParams.get('kind'),Number(url.searchParams.get('id')),user));
  if(url.pathname==='/api/admin/refunds'&&req.method==='POST')return reply(200,store.refunds.create(b,user));
  if(user.role==='waiter'&&url.pathname!=='/api/admin/logout')return reply(403,{error:'Используйте кабинет кафе.'});
  if(req.method==='GET'&&url.pathname==='/api/admin/calendar')return reply(200,calendarData(store,fleet,url.searchParams.get('date')||moscowDay(),Number(url.searchParams.get('days')||1)));
  if(req.method==='GET'&&url.pathname==='/api/admin/availability'){const start=localStamp(url.searchParams.get('start')),end=localStamp(url.searchParams.get('end'));return reply(200,{items:fleet.map(([id])=>availability(store.db,fleet,id,start,end,{close:store.sms?.content?.live().close}))});}
  if(req.method==='GET'&&url.pathname==='/api/admin/search')return reply(200,deskSearch(store,fleet,url.searchParams.get('q'),user));
  if(req.method==='POST'&&(['/api/admin/rentals','/api/admin/extend'].includes(url.pathname)||url.pathname==='/api/admin/return'&&store.db.prepare('SELECT extension_due FROM rentals WHERE id=?').get(b.id)?.extension_due>0))store.workforce.requireOnDuty();
  if(req.method==='POST'&&url.pathname==='/api/admin/rental-pay'){if(!store.rentalTerminal)fail('Касса не подключена.',503);return reply(200,await store.rentalTerminal.begin(b,user));}
  if(req.method==='POST'&&url.pathname==='/api/admin/rental-cancel-pending')return reply(200,store.rentalTerminal.cancel(b,user));
  if(req.method==='POST'&&url.pathname==='/api/admin/extend')return reply(200,extendRental(store,fleet,b,user));
  if(req.method==='POST'&&url.pathname==='/api/admin/undo-return')return reply(200,undoReturn(store,fleet,b,user));
  if(req.method==='GET'&&url.pathname==='/api/admin/dashboard')return reply(200,store.dashboard(url.searchParams.get('day')||moscowDay(),user));
  if(req.method==='GET'&&url.pathname==='/api/admin/shift')return reply(200,{current:store.currentShift(url.searchParams.get('day')||moscowDay()),history:store.shifts()});
  if(req.method==='GET'&&url.pathname==='/api/admin/shift-staff')return reply(200,{items:store.db.prepare("SELECT id,login,role FROM admin_users WHERE role IN ('staff','admin') ORDER BY login").all()});
  if(req.method==='GET'&&url.pathname==='/api/admin/shift-settings')return reply(200,store.shiftSettings(user));
  if(req.method==='GET'&&url.pathname==='/api/admin/payroll')return reply(200,{items:store.payroll(user)});
  if(req.method==='GET'&&url.pathname==='/api/admin/telegram-settings')return reply(200,store.telegramSettings(user));
  if(req.method==='POST'&&url.pathname==='/api/admin/shift/open')return reply(200,{ok:true,id:store.openShift(b,user)});
  if(req.method==='POST'&&url.pathname==='/api/admin/shift/withdrawal')return reply(200,{ok:true,items:store.addWithdrawal(b,user)});
  if(req.method==='POST'&&url.pathname==='/api/admin/shift/close'){const result=store.closeShift(b,user);void store.workforce.tick().catch(()=>console.error('Workforce report worker failed'));return reply(200,result);}
  if(req.method==='POST'&&url.pathname==='/api/admin/shift-settings')return reply(200,store.saveShiftSettings(b,user));
  if(req.method==='POST'&&url.pathname==='/api/admin/payroll/pay')return reply(200,{items:store.pay(b,user)});
  if(req.method==='POST'&&url.pathname==='/api/admin/telegram-settings')return reply(200,store.saveTelegramSettings(b,user));
  if(req.method==='GET'&&url.pathname==='/api/admin/history')return reply(200,{changes:store.history(Number(url.searchParams.get('id')),user)});
  if(req.method==='POST'&&url.pathname==='/api/admin/edit'){store.edit(b,user);return reply(200,{ok:true});}
  if(req.method==='GET'&&url.pathname==='/api/admin/inquiries')return reply(200,store.inquiries(url.searchParams.get('status')||'new',Number(url.searchParams.get('before')||0)));
  if(req.method==='POST'&&url.pathname==='/api/admin/inquiry-status'){store.inquiryStatus(b,user);store.sms?.sync();void store.sms?.tick().catch(()=>{});return reply(200,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/admin/logout'){store.logout(token);return reply(200,{ok:true},{'Set-Cookie':cookie('')});}
  if(req.method==='POST'&&url.pathname==='/api/admin/rentals')return reply(200,{ok:true,id:(()=>{const id=store.create(b,user);store.sms?.sync();return id;})()});
  if(req.method==='POST'&&url.pathname==='/api/admin/return'){if(store.rentalTerminal?.enabled&&store.db.prepare('SELECT extension_due FROM rentals WHERE id=?').get(b.id)?.extension_due>0)return reply(200,{ok:true,payment:await store.rentalTerminal.begin({...b,phase:'extension'},user)});store.returned(b.id,user,Date.now(),b.revision);const row=store.db.prepare('SELECT returned,returned_by,revision FROM rentals WHERE id=?').get(b.id);return reply(200,{ok:true,returnedAt:row.returned,revision:row.revision,canUndo:!store.db.prepare("SELECT id FROM payments WHERE rental_id=? AND note='Доплата за продление при возврате'").get(b.id)&&row.returned_by===user.id&&Date.now()-row.returned<15000});}
  if(req.method==='POST'&&url.pathname==='/api/admin/staff-password'){store.resetStaff(b,user);return reply(200,{ok:true});}
  return reply(404,{error:'Не найдено.'});
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось выполнить операцию. Обновите страницу и повторите.'});}
};}
