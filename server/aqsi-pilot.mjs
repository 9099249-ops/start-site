import {randomUUID} from 'node:crypto';
import {purchaseRequest,operationReference,purchaseOutcome} from './aqsi-protocol.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const owner=u=>{if(u?.role!=='admin')fail('Только администратор.',403);};
const labels={cash_done:'Наличные приняты — чек пробейте вручную на кассе',cancelled:'Оплата отменена — списания не было',payment_sending:'Передача суммы на кассу',payment_waiting:'Ожидаем результат оплаты',payment_unknown:'Результат оплаты неизвестен — повтор заблокирован',paid:'Оплата подтверждена, готовим чек',receipt_sending:'Передача чека на кассу',receipt_waiting:'Ожидаем фискальный чек',receipt_unknown:'Результат печати неизвестен — повтор заблокирован',review:'Нужна сверка с кассой — повтор заблокирован',done:'Оплата и фискальный чек подтверждены'};

// First live verification is deliberately separate from station sales and payroll.
// No automatic retry of any money-moving or fiscal POST, even after a restart.
export class AqsiPilot {
 constructor(admin,connection,table='aqsi_pilot'){if(!['aqsi_pilot','aqsi_cafe','aqsi_rental'].includes(table))throw Error('Invalid payment table');this.table=table;this.db=admin.db;this.connection=connection;this.busy=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table}(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,device_id INTEGER NOT NULL,amount INTEGER NOT NULL,state TEXT NOT NULL,payment_op TEXT,receipt_op TEXT,slip TEXT,receipt_id TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,actor INTEGER NOT NULL REFERENCES admin_users(id));`);
  this.db.exec(`UPDATE ${this.table} SET state='payment_unknown' WHERE state='payment_sending'; UPDATE ${this.table} SET state='receipt_unknown' WHERE state='receipt_sending'`);
 }
 view(row){return row?{id:row.id,amountCents:row.amount,state:row.state,label:labels[row.state],created:row.created,receiptId:row.receipt_id,paymentOperationId:row.payment_op,receiptOperationId:row.receipt_op}:null;}
 info(u){owner(u);return {latest:this.view(this.db.prepare(`SELECT * FROM ${this.table} ORDER BY created DESC,rowid DESC LIMIT 1`).get()),amountCents:100,itemName:'Лимонад',taxSystem:'УСН доходы',vat:'Без НДС'};}
 async begin(b,u){owner(u);if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))fail('Обновите страницу.');if(b.confirmAmountCents!==100)fail('Подтвердите оплату 1 ₽.');
  const old=this.db.prepare(`SELECT * FROM ${this.table} WHERE request_id=?`).get(b.requestId);if(old)return this.view(old);
  // One pilot per deployment: another payment requires deliberate follow-up.
  if(this.db.prepare(`SELECT id FROM ${this.table} LIMIT 1`).get())fail('Проверка уже запускалась. Сначала сверим её результат.',409);
  const c=this.connection.read();if(!c.apiKey||!c.deviceId)fail('Сначала подключите кассу.');
  const id=randomUUID(),now=Date.now();this.db.prepare(`INSERT INTO ${this.table}(id,request_id,device_id,amount,state,created,updated,actor) VALUES(?,?,?,?, 'payment_sending',?,?,?)`).run(id,b.requestId,c.deviceId,100,now,now,u.id);
  await this.send(id,'payment',purchaseRequest(c.deviceId,100));return this.view(this.row(id));
 }
 row(id){return this.db.prepare(`SELECT * FROM ${this.table} WHERE id=?`).get(id);}
 set(id,state){this.db.prepare(`UPDATE ${this.table} SET state=?,updated=? WHERE id=?`).run(state,Date.now(),id);}
 async call(path,body,deviceId){const c=this.connection.read();if(!c.apiKey||c.deviceId!==deviceId)throw Error('Connection changed');const r=await this.connection.request('https://api.aqsi.ru/pub'+path,{method:body?'POST':'GET',redirect:'error',headers:{'x-client-key':'Application '+c.apiKey,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Provider response');return await r.json();}
 async send(id,phase,body){const row=this.row(id);let op;try{op=operationReference(await this.call(phase==='payment'?'/v4/Slips/process/purchase':'/v4/Receipts/process',body,row.device_id));}catch{}
  if(!op){this.set(id,phase+'_unknown');return;}
  const column=phase==='payment'?'payment_op':'receipt_op';this.db.prepare(`UPDATE ${this.table} SET ${column}=?,state=?,updated=? WHERE id=?`).run(op,phase+'_waiting',Date.now(),id);
 }
 async tick(){if(this.busy)return;this.busy=true;try{for(const row of this.db.prepare(`SELECT * FROM ${this.table} WHERE state IN ('payment_waiting','paid','receipt_waiting') OR (state='review' AND payment_op IS NOT NULL AND slip IS NULL AND receipt_op IS NULL)`).all())await this.advance(row);}finally{this.busy=false;}}
 async advance(row){
  if(row.state==='paid')return this.fiscalize(row);
  const payment=row.state==='payment_waiting'||row.state==='review',opId=payment?row.payment_op:row.receipt_op;let op;
  try{op=await this.call('/v4/Operations/'+encodeURIComponent(opId),null,row.device_id);}catch{return;}
  if(payment){const outcome=purchaseOutcome({operationId:opId,deviceId:row.device_id,amountCents:row.amount},op);
   if(outcome.state==='pending')return;if(outcome.state==='cancelled'){this.set(row.id,'cancelled');return;}if(outcome.state!=='paid'){this.set(row.id,'review');return;}
   // Keep only fields needed to associate the receipt with the already-paid slip.
   const original=JSON.parse(op.result),c=original.content,content={};for(const k of ['type','amount','dateTime','sequenceNumber','retrievalReferenceNumber','transactionId','terminalId','merchantId','authCode','responseCode','currencyCode'])if(c[k]!==undefined&&c[k]!==null)content[k]=c[k];
   if(!content.dateTime||!content.sequenceNumber){this.set(row.id,'review');return;}
   this.db.prepare(`UPDATE ${this.table} SET state='paid',slip=?,updated=? WHERE id=?`).run(JSON.stringify({id:original.id,content}),Date.now(),row.id);return this.fiscalize(this.row(row.id));
  }
  if(op.operationId!==opId||op.deviceId!==row.device_id||op.type!=='receipt.process'){this.set(row.id,'review');return;}
  if(['Pending','Processing','Finishing'].includes(op.status))return;
  let receipt;try{receipt=JSON.parse(op.result);}catch{}
  if(op.status!=='Completed'||!receipt?.id||receipt.device?.id!==row.device_id||receipt.isNonFiscal!==false||receipt.info?.sum!==row.amount||receipt.info?.typeId!==1||!receipt.info?.docInfo?.docNumber){this.set(row.id,'review');return;}
  this.db.prepare(`UPDATE ${this.table} SET state='done',receipt_id=?,updated=? WHERE id=?`).run(receipt.id,Date.now(),row.id);
 }
 terminalBusy(){return ['aqsi_pilot','aqsi_cafe','aqsi_rental'].some(table=>this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)&&this.db.prepare(`SELECT id FROM ${table} WHERE state NOT IN ('done','cancelled','cash_done') LIMIT 1`).get());}
 async fiscalize(row){
  const changed=this.db.prepare(`UPDATE ${this.table} SET state='receipt_sending',updated=? WHERE id=? AND state='paid'`).run(Date.now(),row.id);if(!changed.changes)return;
  const body={deviceId:row.device_id,ttlMillis:120000,typeId:1,info:{taxSystemCode:2,additionalAttribute:'START '+row.id.replaceAll('-','').slice(0,10)},positions:[{info:{name:this.table==='aqsi_rental'?'Аренда спорт инвентаря':'Лимонад',calculationTypeId:4,calculationSubjectId:this.table==='aqsi_rental'?4:1,taxRateId:6,quantityUnitId:0,baseQuantity:'1',finalPrice:row.amount}}],payments:[{type:1,amount:row.amount,slip:JSON.parse(row.slip)}],ignoreItemCodeCheck:false,skipPrinting:false,roundAmountDownToExponent:0};
  await this.send(row.id,'receipt',body);
 }
}
