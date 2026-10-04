import {randomUUID} from 'node:crypto';
import {AqsiDiagnostics,providerDiagnostic,transportDiagnostic} from './aqsi-diagnostics.mjs';
import {purchaseRequest,operationReference,purchaseOutcome} from './aqsi-protocol.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const owner=u=>{if(u?.role!=='admin')fail('Только администратор.',403);};
const labels={cash_done:'Наличные приняты — чек пробейте вручную на кассе',cancelled:'Оплата отменена — списания не было',payment_sending:'Передача суммы на кассу',payment_waiting:'Ожидаем результат оплаты',payment_unknown:'Результат оплаты неизвестен — повтор заблокирован',paid:'Оплата подтверждена, готовим чек',receipt_sending:'Передача чека на кассу',receipt_waiting:'Ожидаем фискальный чек',receipt_unknown:'Результат печати неизвестен — повтор заблокирован',review:'Нужна сверка с кассой — повтор заблокирован',done:'Оплата и фискальный чек подтверждены'};

// First live verification is deliberately separate from station sales and payroll.
// Never repeat a debit or an ambiguous fiscal POST, including after restart.
// A definitively rejected closed-shift receipt has a separate guarded recovery.
export class AqsiPilot {
 constructor(admin,connection,table='aqsi_pilot'){if(!['aqsi_pilot','aqsi_cafe','aqsi_rental','aqsi_guest'].includes(table))throw Error('Invalid payment table');this.table=table;this.db=admin.db;this.connection=connection;this.busy=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table}(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,device_id INTEGER NOT NULL,amount INTEGER NOT NULL,state TEXT NOT NULL,payment_op TEXT,receipt_op TEXT,slip TEXT,receipt_id TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,actor INTEGER NOT NULL REFERENCES admin_users(id));`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS aqsi_receipt_shift_retries(scope TEXT NOT NULL,payment_id TEXT NOT NULL,shift_id TEXT NOT NULL,operation_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(scope,payment_id,shift_id));`);
  this.diagnostics=new AqsiDiagnostics(this.db,this.table);
  this.db.exec('CREATE TABLE IF NOT EXISTS aqsi_terminal_releases(scope TEXT NOT NULL,payment_id TEXT NOT NULL,receipt_op TEXT NOT NULL,source TEXT NOT NULL,actor INTEGER,created INTEGER NOT NULL,PRIMARY KEY(scope,payment_id))');
  for(const r of this.db.prepare(`SELECT id,state FROM ${this.table} WHERE state IN ('payment_sending','receipt_sending')`).all())this.note(r.id,r.state==='payment_sending'?'payment':'receipt',{kind:'restart'});
  this.db.exec(`UPDATE ${this.table} SET state='payment_unknown' WHERE state='payment_sending'; UPDATE ${this.table} SET state='receipt_unknown' WHERE state='receipt_sending'`);
 }
 view(row,diagnostic=row?this.diagnostics.latest(row.id):null){return row?{id:row.id,amountCents:row.amount,state:row.state,label:diagnostic?.paymentNotStarted?diagnostic.message:labels[row.state],created:row.created,receiptId:row.receipt_id,paymentOperationId:row.payment_op,receiptOperationId:row.receipt_op,terminalReleased:this.receiptReleased(row),diagnostic}:null;}
 receiptReleased(row,scope=this.table){if(!row?.slip||!['review','receipt_unknown'].includes(row.state))return false;const r=this.db.prepare('SELECT receipt_op FROM aqsi_terminal_releases WHERE scope=? AND payment_id=?').get(scope,row.id);return !!r&&r.receipt_op===(row.receipt_op||'');}
 releaseReceipt(row,source,actor=null){this.db.prepare('INSERT INTO aqsi_terminal_releases VALUES(?,?,?,?,?,?) ON CONFLICT(scope,payment_id) DO UPDATE SET receipt_op=excluded.receipt_op,source=excluded.source,actor=excluded.actor,created=excluded.created').run(this.table,row.id,row.receipt_op||'',source,actor,Date.now());}
 terminalIssues(){const issues=[];for(const table of ['aqsi_pilot','aqsi_cafe','aqsi_rental','aqsi_guest']){if(!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;for(const row of this.db.prepare(`SELECT * FROM ${table} WHERE state NOT IN ('done','cancelled','cash_done') ORDER BY created`).all()){
  const released=this.receiptReleased(row,table);let orderId=null;if(table==='aqsi_cafe'&&this.db.prepare("SELECT name FROM sqlite_master WHERE name='aqsi_cafe_orders'").get())orderId=this.db.prepare('SELECT order_id FROM aqsi_cafe_orders WHERE payment_id=?').get(row.id)?.order_id;
  issues.push({scope:table,orderId,state:row.state,amountCents:row.amount,paid:!!row.slip,blocking:!released,reason:row.slip?'Оплата получена; требуется проверить фискальный чек.':'Результат оплаты ещё не подтверждён.',href:orderId?'/admin/cafe/#order-'+orderId:table==='aqsi_rental'?'/admin/':'/admin/aqsi/?settings=aqsi'});
 }}return issues;}
 terminalBusyMessage(){const issue=this.terminalIssues().find(i=>i.blocking);return issue?'Касса заблокирована: '+(issue.orderId?'заказ №'+issue.orderId+' · ':'')+issue.reason+' Откройте сверку заказа.':'Касса свободна.';}
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
 note(id,phase,event){try{this.diagnostics.record(id,phase,event);}catch{console.error('aQsi diagnostic journal unavailable');}}
 async call(path,body,deviceId,context){
  const c=this.connection.read(),record=e=>{if(context)this.note(context.id,context.phase,{stage:body?'submit':'poll',...e});};
  if(!c.apiKey||c.deviceId!==deviceId){record({kind:'configuration'});throw Error('Connection changed');}
  const start=Date.now();let r;
  try{r=await this.connection.request('https://api.aqsi.ru/pub'+path,{method:body?'POST':'GET',redirect:'error',headers:{'x-client-key':'Application '+c.apiKey,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});}
  catch(e){record({...transportDiagnostic(e)});throw Error('Provider connection unavailable');}
  const httpStatus=r.status||200;
  if(!r.ok){let problem;try{problem=await r.json();}catch{}record({kind:'http',httpStatus,...providerDiagnostic(problem,c.apiKey)});throw Error('Provider response');}
  let data;try{data=await r.json();}catch{record({kind:'invalid_json',httpStatus});throw Error('Invalid provider response');}
  if(context)context.responseMeta={httpStatus,elapsedMs:Date.now()-start};return data;
 }
 async fiscalShift(deviceId){
  const query=new URLSearchParams({pageSize:'1','filtered.devices':String(deviceId),'sorted[0].id':'startDate','sorted[0].desc':'true'});
  const list=await this.call('/v4/Shifts?'+query,null,deviceId);
  const latest=list?.rows?.[0];
  if(!latest?.id||latest.device?.id!==deviceId)throw Error('Fiscal shift unavailable');
  const shift=await this.call('/v4/Shifts/'+encodeURIComponent(latest.id),null,deviceId);
  if(shift?.id!==latest.id||shift.device?.id!==deviceId)throw Error('Fiscal shift mismatch');
  const openedAt=Date.parse(shift.shiftOpenedReport?.dateTime),age=Date.now()-openedAt;
  return {id:shift.id,open:!!shift.shiftOpenedReport&&!shift.shiftClosedReport&&Number.isFinite(age)&&age>=-60000&&age<86400000};
 }
 async recoverClosedShift(row,op){
  if(this.receiptReleased(row))return;
  // Only an explicit, final rejection with no receipt can be retried. Never a
  // timeout, missing reply, generic error or operation belonging to another sale.
  if(op.status!=='Error'||op.problems!=='ShiftMustBeOpened'||!(op.result==null||op.result==='')||!row.slip)return;
  let shift;try{shift=await this.fiscalShift(row.device_id);}catch{return;}
  if(!shift.open)return;
  let changed=false;this.db.exec('BEGIN IMMEDIATE');
  try{
   const fresh=this.row(row.id);
   if(fresh.state==='review'&&fresh.receipt_op===op.operationId){
    const inserted=this.db.prepare('INSERT OR IGNORE INTO aqsi_receipt_shift_retries VALUES(?,?,?,?,?)').run(this.table,row.id,shift.id,op.operationId,Date.now());
    if(inserted.changes){this.set(row.id,'paid');changed=true;}
   }
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  if(changed){this.note(row.id,'receipt',{kind:'shift_recovery'});await this.fiscalize(this.row(row.id));}
 }
 async send(id,phase,body){const row=this.row(id),context={id,phase};let op;
  if(phase==='payment'){
   let shift;try{shift=await this.fiscalShift(row.device_id);}catch{this.note(id,phase,{kind:'shift_unavailable'});this.set(id,'cancelled');return;}
   if(!shift.open){this.note(id,phase,{kind:'shift_closed'});this.set(id,'cancelled');return;}
  }
  if(phase==='payment'&&this.row(id)?.state!=='payment_sending')return;
  try{op=operationReference(await this.call(phase==='payment'?'/v4/Slips/process/purchase':'/v4/Receipts/process',body,row.device_id,context));if(!op)this.note(id,phase,{stage:'submit',kind:'missing_operation',httpStatus:context.responseMeta?.httpStatus});}catch{}
  if(!op){this.set(id,phase+'_unknown');return;}
  // Persist the financial operation reference before optional diagnostics.
  const column=phase==='payment'?'payment_op':'receipt_op';this.db.prepare(`UPDATE ${this.table} SET ${column}=?,state=?,updated=? WHERE id=?`).run(op,phase+'_waiting',Date.now(),id);
  this.note(id,phase,{stage:'submit',kind:'accepted',operationId:op,...context.responseMeta});
 }
 async tick(){if(this.busy)return;this.busy=true;try{for(const row of this.db.prepare(`SELECT * FROM ${this.table} WHERE state IN ('payment_waiting','paid','receipt_waiting') OR (state='review' AND (payment_op IS NOT NULL OR receipt_op IS NOT NULL))`).all())await this.advance(row);}finally{this.busy=false;}}
 async advance(row){
  if(row.state==='paid')return this.fiscalize(row);
  const payment=row.state==='payment_waiting'||row.state==='review'&&!row.slip&&!row.receipt_op,opId=payment?row.payment_op:row.receipt_op,phase=payment?'payment':'receipt';let op;
  try{op=await this.call('/v4/Operations/'+encodeURIComponent(opId),null,row.device_id,{id:row.id,phase});}catch{return;}
  const fresh=this.row(row.id);if(fresh.state!==row.state||fresh.payment_op!==row.payment_op||fresh.receipt_op!==row.receipt_op)return;
  const observation={stage:'poll',kind:'operation',operationId:opId,operationStatus:op?.status,...providerDiagnostic(op,this.connection.read().apiKey)};
  if(payment){const outcome=purchaseOutcome({operationId:opId,deviceId:row.device_id,amountCents:row.amount},op);
   if(outcome.state==='pending'){this.note(row.id,phase,observation);return;}if(outcome.state==='cancelled'){this.note(row.id,phase,observation);this.set(row.id,'cancelled');return;}if(outcome.state!=='paid'){this.note(row.id,phase,['Timeout','Error'].includes(op?.status)&&outcome.reason==='not_confirmed'?observation:{...observation,kind:'invalid_result',reason:outcome.reason});this.set(row.id,'review');return;}
   // Keep only fields needed to associate the receipt with the already-paid slip.
   const original=JSON.parse(op.result),c=original.content,content={};for(const k of ['type','amount','dateTime','sequenceNumber','retrievalReferenceNumber','transactionId','terminalId','merchantId','authCode','responseCode','currencyCode'])if(c[k]!==undefined&&c[k]!==null)content[k]=c[k];
   if(!content.dateTime||!content.sequenceNumber){this.note(row.id,phase,{...observation,kind:'invalid_result',reason:'slip_fields_missing'});this.set(row.id,'review');return;}
   this.note(row.id,phase,observation);
   this.db.prepare(`UPDATE ${this.table} SET state='paid',slip=?,updated=? WHERE id=?`).run(JSON.stringify({id:original.id,content}),Date.now(),row.id);return this.fiscalize(this.row(row.id));
  }
  if(op?.operationId!==opId||op?.deviceId!==row.device_id||op?.type!=='receipt.process'){this.note(row.id,phase,{stage:'poll',kind:'invalid_result',reason:'receipt_operation_mismatch'});this.set(row.id,'review');return;}
  if(['Pending','Processing','Finishing'].includes(op.status)){this.db.prepare('DELETE FROM aqsi_terminal_releases WHERE scope=? AND payment_id=?').run(this.table,row.id);this.note(row.id,phase,observation);return;}
  let receipt;try{receipt=JSON.parse(op.result);}catch{}
  if(op.status!=='Completed'||!receipt?.id||receipt.device?.id!==row.device_id||receipt.isNonFiscal!==false||receipt.info?.sum!==row.amount||receipt.info?.typeId!==1||!receipt.info?.docInfo?.docNumber){this.note(row.id,phase,['Timeout','Error'].includes(op.status)?observation:{...observation,kind:'invalid_result',reason:'receipt_not_confirmed'});this.set(row.id,'review');if(['Completed','Error','Canceled'].includes(op.status)&&op.problems!=='ShiftMustBeOpened')this.releaseReceipt(this.row(row.id),'provider_final');await this.recoverClosedShift(this.row(row.id),op);return;}
  this.note(row.id,phase,observation);
  this.db.prepare(`UPDATE ${this.table} SET state='done',receipt_id=?,updated=? WHERE id=?`).run(receipt.id,Date.now(),row.id);
 }
 terminalBusy(){return this.terminalIssues().some(i=>i.blocking);}
 async fiscalize(row){
  const changed=this.db.prepare(`UPDATE ${this.table} SET state='receipt_sending',updated=? WHERE id=? AND state='paid'`).run(Date.now(),row.id);if(!changed.changes)return;
  const body={deviceId:row.device_id,ttlMillis:120000,typeId:1,info:{taxSystemCode:2,additionalAttribute:'START '+row.id.replaceAll('-','').slice(0,10)},positions:[{info:{name:this.table==='aqsi_rental'?'Аренда спорт инвентаря':'Лимонад',calculationTypeId:4,calculationSubjectId:this.table==='aqsi_rental'?4:1,taxRateId:6,quantityUnitId:0,baseQuantity:'1',finalPrice:row.amount}}],payments:[{type:1,amount:row.amount,slip:JSON.parse(row.slip)}],ignoreItemCodeCheck:false,skipPrinting:false,roundAmountDownToExponent:0};
  if(this.receiptPositions)body.positions=this.receiptPositions(row);
  await this.send(row.id,'receipt',body);
 }
}
