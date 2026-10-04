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
  this.db.prepare(`UPDATE cafe_orders SET details=json_remove(details,'$.terminalPaymentRequired','$.terminalQuickSale','$.pendingKitchen'),revision=revision+1 WHERE source IN ('customer_web','customer_nfc') AND json_extract(details,'$.terminalPaymentRequired')=1 AND json_extract(details,'$.terminalPaidAt') IS NULL AND json_extract(details,'$.manualPaymentRequired') IS NULL AND NOT EXISTS(SELECT 1 FROM aqsi_cafe_orders p WHERE p.order_id=cafe_orders.id)`).run();
 }
 forOrder(id){const row=this.db.prepare('SELECT p.* FROM aqsi_cafe p JOIN aqsi_cafe_orders o ON o.payment_id=p.id WHERE o.order_id=?').get(id);return row||null;}
 payment(id){const r=this.forOrder(id);const d=r?JSON.parse(this.db.prepare('SELECT details FROM cafe_orders WHERE id=?').get(id).details):{};return r?{...this.view(r),...(d.manualReconciliation&&d.paymentMethod==='card'?{label:'Оплачено вручную картой / QR — сверено сотрудником'}:{}),paid:!!r.slip||r.state==='cash_done'}:null;}
 payments(orders){
  if(!orders.length)return new Map();const details=new Map(orders.map(r=>[r.id,r.details]));
  const rows=this.db.prepare(`SELECT p.*,o.order_id FROM aqsi_cafe p JOIN aqsi_cafe_orders o ON o.payment_id=p.id WHERE o.order_id IN (${orders.map(()=>'?').join(',')})`).all(...orders.map(r=>r.id)),diagnostics=this.diagnostics.latestMany(rows.map(r=>r.id));
  return new Map(rows.map(r=>{const d=details.get(r.order_id);return [r.order_id,{...this.view(r,diagnostics.get(r.id)||null),...(d.manualReconciliation&&d.paymentMethod==='card'?{label:'Оплачено вручную картой / QR — сверено сотрудником'}:{}),paid:!!r.slip||r.state==='cash_done'}];}));
 }
 locked(id){const r=this.forOrder(id);return !!r&&r.state!=='cancelled';}
 async begin(b,u){
  staff(u);if(!Number.isSafeInteger(b.id))fail('Обновите заказ.',400);
  const previous=this.forOrder(b.id);if(previous&&previous.state!=='cancelled')return this.view(previous);
  this.admin.workforce.requireOnDuty(Date.now(),u);
  let created=false;const row=this.cafe.transaction(()=>{
   const existing=this.forOrder(b.id);if(existing&&existing.state!=='cancelled')return existing;
   if(existing&&b.retryPaymentId!==existing.id)fail('Обновите отменённую оплату перед повтором.');
   
   const r=this.cafe.order(b.id,u),c=this.connection.read();if(r.details.guestBillId)fail('Оплатите общий счёт гостя.');
   if(!['admin','waiter'].includes(r.source)||!r.details.terminalPaymentRequired||r.details.complimentary||r.total_cents<=0||['DELIVERED','CANCELLED'].includes(r.status))fail('Этот заказ не ожидает оплаты на кассе.');
   if(r.revision!==b.revision)fail('Заказ изменился. Обновите карточку.');
   if(b.cash!==true&&(!c.apiKey||!c.deviceId))fail('Касса не подключена. Обратитесь к администратору.');
   if(b.cash!==true&&this.terminalBusy())fail(this.terminalBusyMessage());
   const id=randomUUID(),now=Date.now();
   this.db.prepare("INSERT INTO aqsi_cafe(id,request_id,device_id,amount,state,created,updated,actor) VALUES(?,?,?,?, ?,?,?,?)").run(id,randomUUID(),c.deviceId||0,r.total_cents,b.cash===true?'cash_done':'payment_sending',now,now,u.id);
   this.db.prepare('INSERT INTO aqsi_cafe_orders VALUES(?,?) ON CONFLICT(order_id) DO UPDATE SET payment_id=excluded.payment_id').run(r.id,id);
   this.db.prepare('INSERT INTO aqsi_cafe_attempts VALUES(?,?)').run(id,r.id);
   if(b.cash===true)this.account(this.row(id));
   created=true;return this.row(id);
  });
  if(!created||row.state==='cash_done')return this.view(row);
  // There is no await between committing the lock and initiating the single POST.
  await this.send(row.id,'payment',purchaseRequest(row.device_id,row.amount));return this.view(this.row(row.id));
 }
 confirmReceipt(b,u){
  staff(u);if(!Number.isSafeInteger(b.id)||typeof b.paymentId!=='string'||!['receipt_exists','terminal_free'].includes(b.result)||b.confirmed!==true||b.terminalIdle!==true)fail('Проверьте историю CS50 и подтвердите, что операция на кассе завершена.',400);
  return this.cafe.transaction(()=>{const p=this.forOrder(b.id);if(!p||p.id!==b.paymentId)fail('Оплата изменилась. Обновите заказ.');if(p.state==='done'&&b.result==='receipt_exists')return this.view(p);
   if(!p.slip||!['review','receipt_unknown'].includes(p.state))fail('Нужна подтверждённая оплата и завершённая проверка операции. Обновите заказ.');
   const r=this.cafe.order(b.id,u);if(r.status==='CANCELLED'||!r.details.terminalPaidAt||r.total_cents!==p.amount)fail('Учёт оплаты требует отдельной сверки.');
   if(b.result==='terminal_free'&&this.receiptReleased(p))return this.view(p);
   if(b.result==='terminal_free')this.releaseReceipt(p,'staff_confirmed',u.id);
   else{this.set(p.id,'done');const d=r.details;d.manualFiscalConfirmation={confirmed:true,confirmedBy:u.id,confirmedAt:Date.now(),source:'staff_confirmation'};this.db.prepare('UPDATE cafe_orders SET details=?,revision=revision+1 WHERE id=?').run(JSON.stringify(d),b.id);}
   this.admin.workforce.audit(u,b.result==='receipt_exists'?'fiscal_receipt_manual_confirmation':'terminal_released_after_receipt',b.id,{paymentId:p.id,state:p.state},{result:b.result},b.result==='receipt_exists'?'Сотрудник проверил оплату и фискальный чек на CS50.':'Сотрудник подтвердил завершение операции на CS50; чек требует сверки.',Date.now());
   return this.view(this.row(p.id));
  });
 }
 manualPaid(b,u){
  staff(u);if(!Number.isSafeInteger(b.id)||!['cash','card'].includes(b.method)||b.confirmed!==true||b.terminalIdle!==true||b.receiptExists!==true||typeof b.note!=='string'||b.note.length>300)fail('Подтвердите получение денег, фискальный чек и завершение операции на кассе.',400);
  return this.cafe.transaction(()=>{
   const r=this.cafe.order(b.id,u),p=this.forOrder(b.id);
   if(r.details.terminalPaidAt&&['done','cash_done'].includes(p?.state))return this.payment(b.id);
   if((p?.id||null)!==(b.paymentId||null))fail('Оплата изменилась. Обновите заказ.');
   if(r.revision!==b.revision)fail('Заказ изменился. Обновите карточку.');
   if(r.status==='CANCELLED'||r.details.guestBillId||r.details.complimentary||!r.details.terminalPaymentRequired||r.details.manualPaymentRequired||r.total_cents<=0)fail('Этот заказ нельзя провести этим способом.');
   if(p&&p.amount!==r.total_cents)fail('Сумма операции отличается от заказа.');
   if(p&&!['done','cash_done','cancelled'].includes(p.state)&&Date.now()-(p.state.endsWith('_sending')?p.updated:p.created)<120000)fail('Дождитесь завершения запроса на кассе: до двух минут.');
   if(p?.slip&&b.method!=='card')fail('Касса подтвердила безналичную оплату. Выберите карту / QR.');
   const now=Date.now(),confirmation={confirmed:true,confirmedBy:u.id,confirmedAt:now,source:'staff_manual_payment',note:b.note.trim()};
   let id=p?.id;
   if(!p){id=randomUUID();this.db.prepare('INSERT INTO aqsi_cafe(id,request_id,device_id,amount,state,created,updated,actor) VALUES(?,?,?,?,?,?,?,?)').run(id,randomUUID(),0,r.total_cents,'cash_done',now,now,u.id);this.db.prepare('INSERT INTO aqsi_cafe_orders VALUES(?,?)').run(r.id,id);this.db.prepare('INSERT INTO aqsi_cafe_attempts VALUES(?,?)').run(id,r.id);}
   else this.set(id,p.slip?'paid':'cash_done');
   this.account(this.row(id));
   const d=this.cafe.order(b.id,u).details;d.paymentMethod=b.method;d.manualCashReceipt=b.method==='cash';if(b.method==='card')delete d.cashPaidAt;d.manualReconciliation=true;d.manualFiscalConfirmation=confirmation;
   this.db.prepare('UPDATE cafe_orders SET details=?,revision=revision+1 WHERE id=?').run(JSON.stringify(d),r.id);
   if(p?.slip)this.set(id,'done');
   this.admin.workforce.audit(u,'payment_manual_reconciliation',r.id,{paymentId:p?.id||null,state:p?.state||null},{method:b.method,amount:r.total_cents,receiptConfirmed:true},b.note.trim()||'Сотрудник подтвердил оплату и фискальный чек на кассе.',now);
   return this.payment(b.id);
  });
 }
 async reconcile(b,u){
  staff(u);if(!['unpaid','cash','card'].includes(b.result)||b.confirmed!==true||typeof b.note!=='string'||!b.note.trim()||b.note.length>300)fail('Проверьте историю кассы и укажите результат сверки.',400);
  const prior=this.forOrder(b.id);if(!prior||prior.id!==b.paymentId)fail('Оплата изменилась. Обновите заказ.');
  if(prior.payment_op&&['payment_waiting','review'].includes(prior.state))await this.advance(prior);
  return this.cafe.transaction(()=>{const p=this.forOrder(b.id);if(p.id!==b.paymentId)fail('Оплата изменилась.');
   if(p.state==='cancelled'&&b.result==='unpaid')return this.view(p);
   if(p.state==='cash_done')return this.view(p);
   if(p.slip||p.receipt_op||!['payment_unknown','payment_waiting','review','cancelled'].includes(p.state))fail('Оплата подтверждена или чек обрабатывается. Повторно принимать деньги нельзя.');
   if(Date.now()-p.created<120000)fail('Дождитесь завершения запроса на кассе: до двух минут.');
   if(b.result==='unpaid')this.set(p.id,'cancelled');else{this.set(p.id,'cash_done');this.account(this.row(p.id));const r=this.cafe.order(b.id,u),d=r.details;d.paymentMethod=b.result;d.manualCashReceipt=b.result==='cash';if(b.result==='card')delete d.cashPaidAt;d.manualReconciliation=true;this.db.prepare('UPDATE cafe_orders SET details=?,revision=revision+1 WHERE id=?').run(JSON.stringify(d),b.id);}
   this.admin.workforce.audit(u,'payment_manual_reconciliation',b.id,{paymentId:p.id,state:p.state},{result:b.result},b.note.trim(),Date.now());
   return this.view(this.row(p.id));});
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
   const pendingKitchen=details.pendingKitchen;details.pendingKitchen=false;details.terminalPaidAt=paidAt;details.paymentMethod=current.state==='cash_done'?'cash':'card';if(current.state==='cash_done'){details.manualCashReceipt=true;details.cashPaidAt=paidAt;}
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
