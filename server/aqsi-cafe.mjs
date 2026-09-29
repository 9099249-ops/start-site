import {randomUUID} from 'node:crypto';
import {AqsiPilot} from './aqsi-pilot.mjs';
import {purchaseRequest} from './aqsi-protocol.mjs';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const staff=u=>{if(!['admin','staff','waiter'].includes(u?.role))fail('Войдите в админку.',401);};

// Uses the same verified payment/fiscalization engine as the live pilot.
// A unique order mapping survives browser retries, concurrent staff and restarts.
export class AqsiCafe extends AqsiPilot {
 constructor(admin,connection,cafe,{enabled=false}={}){
  super(admin,connection,'aqsi_cafe');this.admin=admin;this.cafe=cafe;this.enabled=enabled;
  this.db.exec('CREATE TABLE IF NOT EXISTS aqsi_cafe_orders(order_id INTEGER PRIMARY KEY REFERENCES cafe_orders(id),payment_id TEXT NOT NULL UNIQUE REFERENCES aqsi_cafe(id))');
  this.db.exec('CREATE TABLE IF NOT EXISTS aqsi_cafe_attempts(payment_id TEXT PRIMARY KEY REFERENCES aqsi_cafe(id),order_id INTEGER NOT NULL REFERENCES cafe_orders(id)); INSERT OR IGNORE INTO aqsi_cafe_attempts SELECT payment_id,order_id FROM aqsi_cafe_orders');
  // Public orders are paid manually on CS50. Remove only unused terminal flags
  // from the brief earlier rollout; never modify an attempted/paid operation.
  this.db.prepare(`UPDATE cafe_orders SET details=json_remove(details,'$.terminalPaymentRequired','$.terminalQuickSale','$.pendingKitchen'),revision=revision+1 WHERE source IN ('customer_web','customer_nfc') AND json_extract(details,'$.terminalPaymentRequired')=1 AND json_extract(details,'$.terminalPaidAt') IS NULL AND NOT EXISTS(SELECT 1 FROM aqsi_cafe_orders p WHERE p.order_id=cafe_orders.id)`).run();
 }
 forOrder(id){const row=this.db.prepare('SELECT p.* FROM aqsi_cafe p JOIN aqsi_cafe_orders o ON o.payment_id=p.id WHERE o.order_id=?').get(id);return row||null;}
 payment(id){const r=this.forOrder(id);return r?{...this.view(r),paid:!!r.slip||r.state==='cash_done'}:null;}
 locked(id){const r=this.forOrder(id);return !!r&&r.state!=='cancelled';}
 async begin(b,u){
  staff(u);if(!Number.isSafeInteger(b.id))fail('Обновите заказ.',400);
  const previous=this.forOrder(b.id);if(previous&&previous.state!=='cancelled')return this.view(previous);
  this.admin.workforce.requireOnDuty();
  let created=false;const row=this.cafe.transaction(()=>{
   const existing=this.forOrder(b.id);if(existing&&existing.state!=='cancelled')return existing;
   if(existing&&b.retryPaymentId!==existing.id)fail('Обновите отменённую оплату перед повтором.');
   if(b.cash===true&&!existing)fail('Сначала дождитесь подтверждения отмены на кассе.');
   const r=this.cafe.order(b.id,u),c=this.connection.read();
   if(!['admin','waiter'].includes(r.source)||!r.details.terminalPaymentRequired||r.details.complimentary||r.total_cents<=0||['DELIVERED','CANCELLED'].includes(r.status))fail('Этот заказ не ожидает оплаты на кассе.');
   if(r.revision!==b.revision)fail('Заказ изменился. Обновите карточку.');
   if(!c.apiKey||!c.deviceId)fail('Касса не подключена. Обратитесь к администратору.');
   if(b.cash!==true&&this.terminalBusy())fail('Касса занята или предыдущая операция требует сверки. Проверьте заказы с отметкой оплаты.');
   const id=randomUUID(),now=Date.now();
   this.db.prepare("INSERT INTO aqsi_cafe(id,request_id,device_id,amount,state,created,updated,actor) VALUES(?,?,?,?, ?,?,?,?)").run(id,randomUUID(),c.deviceId,r.total_cents,b.cash===true?'cash_done':'payment_sending',now,now,u.id);
   this.db.prepare('INSERT INTO aqsi_cafe_orders VALUES(?,?) ON CONFLICT(order_id) DO UPDATE SET payment_id=excluded.payment_id').run(r.id,id);
   this.db.prepare('INSERT INTO aqsi_cafe_attempts VALUES(?,?)').run(id,r.id);
   if(b.cash===true)this.account(this.row(id));
   created=true;return this.row(id);
  });
  if(!created||row.state==='cash_done')return this.view(row);
  // There is no await between committing the lock and initiating the single POST.
  await this.send(row.id,'payment',purchaseRequest(row.device_id,row.amount));return this.view(this.row(row.id));
 }
 account(row){
  // Payment recognition and accounting are atomic; a failed fiscal receipt must
  // not hide money already received or allow another acquiring transaction.
   const current=this.row(row.id);if(current.state!=='cash_done'&&(current.state!=='paid'||!current.slip))return;
   const map=this.db.prepare('SELECT order_id FROM aqsi_cafe_orders WHERE payment_id=?').get(row.id);
   const order=this.db.prepare('SELECT * FROM cafe_orders WHERE id=?').get(map.order_id);
   if(order.total_cents!==row.amount||order.status==='CANCELLED')fail('Нужна сверка оплаченного заказа.');
   const details=JSON.parse(order.details);if(details.terminalPaidAt)return;
   const at=current.slip?Date.parse(JSON.parse(current.slip).content.dateTime):Date.now();
   const paidAt=Number.isFinite(at)&&at>=row.created-300000&&at<=Date.now()+300000?at:Date.now();
   const pendingKitchen=details.pendingKitchen;details.pendingKitchen=false;details.terminalPaidAt=paidAt;if(current.state==='cash_done')details.manualCashReceipt=true;
   const status=details.terminalQuickSale?'DELIVERED':'ACCEPTED';
   this.db.prepare('UPDATE cafe_orders SET status=?,details=?,updated=?,revision=revision+1 WHERE id=?').run(status,JSON.stringify(details),paidAt,order.id);
   this.cafe.event(order.id,'PAID',{id:row.actor},{terminalPaymentId:row.id},paidAt);
   if(pendingKitchen){const e=this.cafe.event(order.id,'NEW',{id:row.actor},{items:details.items,totalCents:row.amount,...(details.deliveryCents!==undefined?{deliveryCents:details.deliveryCents}:{})},paidAt);this.db.prepare('INSERT INTO cafe_notifications(event_id,due) VALUES(?,?)').run(e,paidAt);}
   if(status==='DELIVERED')this.cafe.event(order.id,'DELIVERED',{id:row.actor},{terminalPaymentId:row.id},paidAt);
 }
 async fiscalize(row){
  this.cafe.transaction(()=>this.account(row));
  return super.fiscalize(this.row(row.id));
 }
}
