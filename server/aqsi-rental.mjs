import {randomUUID} from 'node:crypto';
import {AqsiPilot} from './aqsi-pilot.mjs';
import {purchaseRequest} from './aqsi-protocol.mjs';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const staff=u=>{if(!['admin','staff'].includes(u?.role))fail('Недоступно для этой роли.',403);};
export class AqsiRental extends AqsiPilot {
 constructor(admin,connection,{enabled=false}={}){
  super(admin,connection,'aqsi_rental');this.admin=admin;this.enabled=enabled;
  this.db.exec("CREATE TABLE IF NOT EXISTS aqsi_rental_links(rental_id INTEGER NOT NULL REFERENCES rentals(id),phase TEXT NOT NULL CHECK(phase IN ('issue','extension')),payment_id TEXT NOT NULL UNIQUE REFERENCES aqsi_rental(id),accounted_at INTEGER,PRIMARY KEY(rental_id,phase))");
  this.db.exec('CREATE TABLE IF NOT EXISTS aqsi_rental_attempts(payment_id TEXT PRIMARY KEY REFERENCES aqsi_rental(id),rental_id INTEGER NOT NULL REFERENCES rentals(id),phase TEXT NOT NULL); INSERT OR IGNORE INTO aqsi_rental_attempts SELECT payment_id,rental_id,phase FROM aqsi_rental_links');
 }
 payment(id,phase){return this.db.prepare('SELECT p.*,l.rental_id,l.phase,l.accounted_at FROM aqsi_rental p JOIN aqsi_rental_links l ON l.payment_id=p.id WHERE l.rental_id=? AND l.phase=?').get(id,phase);}
 hasPayment(id){return !!this.db.prepare('SELECT payment_id FROM aqsi_rental_links WHERE rental_id=?').get(id);}
 locked(id){return !!this.db.prepare("SELECT p.id FROM aqsi_rental p JOIN aqsi_rental_links l ON l.payment_id=p.id WHERE l.rental_id=? AND p.state NOT IN ('done','cash_done','cancelled')").get(id||0);}
 list(){return this.db.prepare("SELECT p.*,l.rental_id,l.phase FROM aqsi_rental p JOIN aqsi_rental_links l ON l.payment_id=p.id JOIN rentals r ON r.id=l.rental_id WHERE p.state NOT IN ('done','cash_done') AND (p.state<>'cancelled' OR (l.phase='issue' AND r.initial_due>0) OR (l.phase='extension' AND r.extension_due>0 AND r.returned IS NULL)) ORDER BY p.created").all().map(r=>({...this.view(r),rentalId:r.rental_id,phase:r.phase,paid:!!r.slip}));}
 async begin(b,u){
  staff(u);if(!Number.isSafeInteger(b.id)||!['issue','extension'].includes(b.phase))fail('Обновите аренду.',400);
  if(this.admin.guestBills?.link('rental',b.id)&&!this.admin.guestBills.link('rental',b.id).paid_at)fail('Оплатите общий счёт гостя.');
  const previous=this.payment(b.id,b.phase);if(previous&&previous.state!=='cancelled')return this.view(previous);
  this.admin.workforce.requireOnDuty();let created=false;
  const payment=this.admin.workforce.tx(()=>{
   const old=this.payment(b.id,b.phase);if(old&&old.state!=='cancelled')return old;
   if(old&&b.retryPaymentId!==old.id)fail('Обновите отменённую оплату перед повтором.');
   
   const r=this.db.prepare('SELECT * FROM rentals WHERE id=?').get(b.id),c=this.connection.read();
   if(!r||r.revision!==b.revision)fail('Аренда изменилась. Обновите список.');
   if(!this.enabled||!c.apiKey||!c.deviceId)fail('Касса не подключена.');
   const amount=b.phase==='issue'?r.initial_due:r.extension_due;
   if(amount<=0||b.phase==='extension'&&(r.initial_due!==0||r.returned!==null)||b.phase==='issue'&&r.returned!==null&&!r.custom_json)fail('У этой аренды нет ожидаемой оплаты.');
   if(b.cash!==true&&this.terminalBusy())fail('Касса занята или предыдущая операция требует сверки. Проверьте ожидающие оплаты.');
   const id=randomUUID(),now=Date.now();
   this.db.prepare("INSERT INTO aqsi_rental(id,request_id,device_id,amount,state,created,updated,actor) VALUES(?,?,?,?, ?,?,?,?)").run(id,randomUUID(),c.deviceId,amount,b.cash===true?'cash_done':'payment_sending',now,now,u.id);
   this.db.prepare('INSERT INTO aqsi_rental_links(rental_id,phase,payment_id) VALUES(?,?,?) ON CONFLICT(rental_id,phase) DO UPDATE SET payment_id=excluded.payment_id,accounted_at=NULL').run(r.id,b.phase,id);
   this.db.prepare('INSERT INTO aqsi_rental_attempts VALUES(?,?,?)').run(id,r.id,b.phase);
   if(b.cash===true)this.account(this.row(id));
   created=true;return this.row(id);
  });
  if(created&&payment.state!=='cash_done')await this.send(payment.id,'payment',purchaseRequest(payment.device_id,payment.amount));
  if(created&&payment.state==='cash_done')this.admin.sms?.sync();
  return this.view(this.row(payment.id));
 }
 cancel(b,u){staff(u);return this.admin.workforce.tx(()=>{
  const r=this.db.prepare('SELECT * FROM rentals WHERE id=?').get(b.id);if(this.admin.guestBills?.link('rental',b.id))fail('Отмените общий счёт гостя.');
  if(!r||r.initial_due<=0||r.revision!==b.revision||this.payment(r.id,'issue')&&this.payment(r.id,'issue').state!=='cancelled')fail('Отмена возможна до оплаты или после подтверждённой отмены на кассе.');
  this.db.prepare('UPDATE rentals SET initial_due=-1,returned=?,returned_by=?,revision=revision+1 WHERE id=?').run(Date.now(),u.id,r.id);
  this.db.prepare("UPDATE inquiries SET status='confirmed',rental_id=NULL,updated=?,revision=revision+1 WHERE rental_id=?").run(Date.now(),r.id);
  this.admin.audit(u,'cancel_unpaid_rental',r.id);return {ok:true};
 });}
 account(row){
   const current=this.row(row.id),link=this.db.prepare('SELECT * FROM aqsi_rental_links WHERE payment_id=?').get(row.id);
   if(link.accounted_at||current.state!=='cash_done'&&(current.state!=='paid'||!current.slip))return;
   const r=this.db.prepare('SELECT * FROM rentals WHERE id=?').get(link.rental_id),due=link.phase==='issue'?r.initial_due:r.extension_due;
   if(due!==row.amount)fail('Нужна сверка суммы аренды.');
   const at=current.slip?Date.parse(JSON.parse(current.slip).content.dateTime):Date.now(),now=Date.now(),paidAt=Number.isFinite(at)&&at>=row.created-300000&&at<=now+300000?at:now;
   const note=link.phase==='extension'?'Доплата за продление при возврате':'Оплата при выдаче';
   this.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(r.id,row.amount,current.state==='cash_done'?'cash':'card',new Date(paidAt+10800000).toISOString().slice(0,10),paidAt,row.actor,note);
   if(link.phase==='issue')this.db.prepare('UPDATE rentals SET initial_due=0,revision=revision+1 WHERE id=?').run(r.id);
   else this.db.prepare('UPDATE rentals SET extension_due=0,returned=?,returned_by=?,revision=revision+1 WHERE id=?').run(paidAt,row.actor,r.id);
   this.db.prepare('UPDATE aqsi_rental_links SET accounted_at=? WHERE payment_id=?').run(paidAt,row.id);
   if(link.phase==='issue'){const inquiry=this.db.prepare("SELECT id FROM inquiries WHERE rental_id=? AND status='payment_pending'").get(r.id);if(inquiry){this.db.prepare("UPDATE inquiries SET status='issued',updated=?,revision=revision+1 WHERE id=?").run(paidAt,inquiry.id);this.db.prepare('INSERT INTO inquiry_events(inquiry_id,actor,status,created) VALUES(?,?,?,?)').run(inquiry.id,row.actor,'issued',paidAt);}}
   this.admin.audit({id:row.actor},link.phase==='issue'?'terminal_issue_paid':'terminal_extension_paid',r.id);
 }
 async fiscalize(row){
  this.admin.workforce.tx(()=>this.account(row));
  this.admin.sms?.sync();return super.fiscalize(this.row(row.id));
 }
}
