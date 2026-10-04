import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore,fleet} from './admin.mjs';
import {AqsiPilot} from './aqsi-pilot.mjs';
import {AqsiRental} from './aqsi-rental.mjs';
import {extendRental} from './rental-actions.mjs';
const u={id:1,role:'admin'},staff={id:2,role:'staff'};
function fixture(){
 const a=new AdminStore(':memory:');a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");a.workforce.requireOnDuty=()=>{};
 const calls=[],answers=[],connection={read:()=>({apiKey:'test',deviceId:709740}),request:async(url,options)=>{if(url.includes('/v4/Shifts'))return {ok:true,json:async()=>url.includes('/v4/Shifts?')?{rows:[{id:'test-shift',device:{id:709740}}]}:{id:'test-shift',device:{id:709740},shiftOpenedReport:{dateTime:new Date().toISOString()},shiftClosedReport:null}};calls.push({url,...options});const result=answers.shift();if(result instanceof Error)throw result;return {ok:true,json:async()=>result};}};
 new AqsiPilot(a,connection);const p=new AqsiRental(a,connection,{enabled:true});a.rentalTerminal=p;
 const now=Date.now(),local=t=>new Date(t+10800000).toISOString().slice(0,16),body=extra=>({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Тест',phone:'+79000000000',departed:local(now),expectedReturn:local(now+3600000),amount:'1000',...extra});
 return {a,p,connection,calls,answers,body,create:extra=>a.create(body(extra),u),row:id=>a.db.prepare('SELECT * FROM rentals WHERE id=?').get(id)};
}
async function confirm(f,id,phase){
 const op=randomUUID(),receiptOp=randomUUID();f.answers.push({operationId:op});const r=await f.p.begin({id,phase,revision:f.row(id).revision},staff);
 f.answers.push({operationId:op,deviceId:709740,type:'acquiring.purchase',status:'Completed',result:JSON.stringify({id:op,device:{id:709740},content:{amount:r.amountCents,type:'purchase',responseCode:'000',dateTime:new Date().toISOString(),sequenceNumber:'1'}})},{operationId:receiptOp});await f.p.tick();
 f.answers.push({operationId:receiptOp,deviceId:709740,type:'receipt.process',status:'Completed',result:JSON.stringify({id:randomUUID(),device:{id:709740},isNonFiscal:false,info:{sum:r.amountCents,typeId:1,docInfo:{docNumber:1}}})});await f.p.tick();
}
test('Rental: reserve without revenue, then one initial payment and separate accumulated extension payment',async()=>{
 const f=fixture();try{const id=f.create();assert.equal(f.row(id).initial_due,100000);assert.equal(f.a.db.prepare('SELECT count(*) n FROM payments').get().n,0);
  const dash=f.a.dashboard(new Date(Date.now()+10800000).toISOString().slice(0,10),u);assert.equal(dash.active.length,0);assert.equal(dash.pendingRentals.length,1);assert.equal(dash.fleet.find(x=>x.id==='sup').available,fleet.find(x=>x[0]==='sup')[2]-1);
  assert.throws(()=>f.a.returned(id,u),/оплату/);assert.throws(()=>extendRental(f.a,fleet,{id,revision:0,minutes:30},u),/оплату/);
  await confirm(f,id,'issue');assert.equal(f.row(id).initial_due,0);assert.equal(f.row(id).returned,null);
  await f.p.begin({id,phase:'issue',revision:0},u);assert.equal(f.calls.filter(c=>c.url.endsWith('/purchase')).length,1);
  for(const minutes of [30,60])extendRental(f.a,fleet,{id,revision:f.row(id).revision,minutes},u);
  const due=f.row(id).extension_due;assert.equal(due,150000);assert.throws(()=>f.a.returned(id,u),/Доплата/);
  await confirm(f,id,'extension');assert.ok(f.row(id).returned);assert.equal(f.row(id).extension_due,0);
  assert.deepEqual(f.a.db.prepare('SELECT amount FROM payments ORDER BY id').all().map(x=>x.amount),[100000,150000]);
  await f.p.begin({id,phase:'extension',revision:0},u);f.a.returned(id,u);assert.equal(f.calls.filter(c=>c.url.endsWith('/purchase')).length,2);
  const receipts=f.calls.filter(c=>c.url.endsWith('/Receipts/process')).map(c=>JSON.parse(c.body));assert.equal(receipts[0].positions[0].info.name,'Аренда спорт инвентаря');assert.equal(receipts[0].positions[0].info.calculationSubjectId,4);assert.equal(receipts[1].payments[0].amount,due);
 }finally{f.a.close();}
});
test('Rental: unknown debit survives restart, prevents amount edits, extension, cancellation and another charge',async()=>{
 const f=fixture();try{const id=f.create();f.answers.push(Error('lost response'));await Promise.all([f.p.begin({id,phase:'issue',revision:0},u),f.p.begin({id,phase:'issue',revision:0},staff)]);assert.equal(f.calls.length,1);assert.equal(f.p.payment(id,'issue').state,'payment_unknown');
  assert.throws(()=>f.p.cancel({id,revision:0},u),/Отмен/);const p=new AqsiRental(f.a,f.connection,{enabled:true});await p.begin({id,phase:'issue',revision:0},u);await p.tick();assert.equal(f.calls.length,1);
  const second=f.create();await assert.rejects(p.begin({id:second,phase:'issue',revision:0},u),/занята/);
 }finally{f.a.close();}
});
test('Rental: unpaid reservation can be cancelled, zero-price issue and no-surcharge return do not use terminal',async()=>{
 const f=fixture();try{const id=f.create();f.p.cancel({id,revision:0},u);assert.equal(f.row(id).initial_due,-1);assert.ok(f.row(id).returned);
  await assert.rejects(f.p.begin({id,phase:'issue',revision:1},u));const free=f.create({amount:'0'});f.a.returned(free,u);assert.ok(f.row(free).returned);assert.equal(f.calls.length,0);
 }finally{f.a.close();}
});
test('Rental: shared terminal lock across cafe and rental; manual-price sale uses saved server amount',async()=>{
 const f=fixture();try{const cafe=new AqsiPilot(f.a,f.connection,'aqsi_cafe');f.answers.push({operationId:randomUUID()});await cafe.begin({requestId:randomUUID(),confirmAmountCents:100},u);
  const id=f.create();await assert.rejects(f.p.begin({id,phase:'issue',revision:0},u),/занята/);
  f.a.db.exec("UPDATE aqsi_cafe SET state='done'");const r=f.a.manualSale({requestId:randomUUID(),title:'Услуга',quantity:2,unitCents:15000},u);assert.equal(f.row(r.id).initial_due,30000);await confirm(f,r.id,'issue');assert.equal(f.a.db.prepare('SELECT amount FROM payments WHERE rental_id=?').get(r.id).amount,30000);
 }finally{f.a.close();}
});

test('Rental booking stays pending until payment; cancellation restores booking without double reservation',async()=>{
 const f=fixture();try{
  const b=f.body(),book=()=>{const id=f.a.receive(randomUUID(),{equipment:'sup',plan:'hour',quantity:1,duration:1,date:'2026-09-28',time:'12:00',name:'Тест брони',phone:'+79000000000'},Date.parse('2026-09-28T08:00:00Z'));f.a.inquiryStatus({id,revision:0,status:'confirmed'},u);return id;};
  const inquiry=book(),id=f.a.create({...b,inquiryId:inquiry},u);
  assert.equal(f.a.db.prepare('SELECT status FROM inquiries WHERE id=?').get(inquiry).status,'payment_pending');
  await confirm(f,id,'issue');assert.equal(f.a.db.prepare('SELECT status FROM inquiries WHERE id=?').get(inquiry).status,'issued');
  const second=book(),unpaid=f.create({inquiryId:second});f.p.cancel({id:unpaid,revision:f.row(unpaid).revision},u);
  const restored=f.a.db.prepare('SELECT status,rental_id FROM inquiries WHERE id=?').get(second);assert.equal(restored.status,'confirmed');assert.equal(restored.rental_id,null);
 }finally{f.a.close();}
});

async function cancelRentalPayment(f,id,phase){const op=randomUUID();f.answers.push({operationId:op});await f.p.begin({id,phase,revision:f.row(id).revision},staff);f.answers.push({operationId:op,deviceId:709740,type:'acquiring.purchase',status:'Canceled',result:null});await f.p.tick();return f.p.payment(id,phase).id;}
test('Rental cash after cancellation: issue and extension accounted once without bank/fiscal POST',async()=>{
 const f=fixture();try{const id=f.create();let previous=await cancelRentalPayment(f,id,'issue'),before=f.calls.length;let b={id,phase:'issue',revision:f.row(id).revision,retryPaymentId:previous,cash:true};await Promise.all([f.p.begin(b,u),f.p.begin(b,staff)]);assert.equal(f.row(id).initial_due,0);assert.equal(f.calls.length,before);assert.equal(f.p.list().length,0);
  extendRental(f.a,fleet,{id,revision:f.row(id).revision,minutes:30},u);previous=await cancelRentalPayment(f,id,'extension');before=f.calls.length;b={id,phase:'extension',revision:f.row(id).revision,retryPaymentId:previous,cash:true};await Promise.all([f.p.begin(b,u),f.p.begin(b,staff)]);assert.ok(f.row(id).returned);assert.equal(f.row(id).extension_due,0);assert.equal(f.calls.length,before);assert.equal(f.a.db.prepare('SELECT count(*) n FROM payments WHERE rental_id=?').get(id).n,2);assert.equal(f.p.terminalBusy(),false);
 }finally{f.a.close();}
});
test('Rental confirmed cancellation allows abandoning unpaid issue, retaining operation history',async()=>{
 const f=fixture();try{const id=f.create(),previous=await cancelRentalPayment(f,id,'issue');f.p.cancel({id,revision:f.row(id).revision},u);assert.equal(f.row(id).initial_due,-1);assert.equal(f.p.list().length,0);assert.equal(f.p.row(previous).state,'cancelled');await assert.rejects(f.p.begin({id,phase:'issue',revision:f.row(id).revision,retryPaymentId:previous},u));
 }finally{f.a.close();}
});

const reconciliation=(f,id,result,extra={})=>({id,phase:'issue',revision:f.row(id).revision,paymentId:f.p.payment(id,'issue')?.id||null,result,confirmed:true,terminalIdle:true,receiptExists:true,note:'Проверено сотрудником',...extra});
const agePayment=(f,id,phase='issue')=>f.a.db.prepare('UPDATE aqsi_rental SET created=?,updated=? WHERE id=?').run(Date.now()-180000,Date.now()-180000,f.p.payment(id,phase).id);
test('Staff can release unknown rental payment, cancel issue or retry without a second debit from reconciliation',async()=>{
 const f=fixture();try{const id=f.create();f.answers.push(Error('lost'));await f.p.begin({id,phase:'issue',revision:0},u);const b=reconciliation(f,id,'unpaid');assert.throws(()=>f.p.reconcile(b,staff),/двух минут/);agePayment(f,id);const count=f.calls.length;f.p.reconcile(b,staff);f.p.reconcile(b,staff);assert.equal(f.calls.length,count);assert.equal(f.p.terminalBusy(),false);f.p.cancel({id,revision:f.row(id).revision},staff);assert.equal(f.row(id).initial_due,-1);}finally{f.a.close();}
});
for(const method of ['cash','card'])test('Manual rental '+method+' settles once, attributes receiver and sends no payment or receipt',async()=>{
 const f=fixture();try{const id=f.create();f.answers.push(Error('lost'));await f.p.begin({id,phase:'issue',revision:0},u);agePayment(f,id);const b=reconciliation(f,id,method),count=f.calls.length;assert.throws(()=>f.p.reconcile({...b,receiptExists:false},staff),/чек/);assert.throws(()=>f.p.reconcile({...b,revision:99},staff),/изменилась/);f.p.reconcile(b,staff);f.p.reconcile(b,staff);assert.equal(f.calls.length,count);assert.equal(f.row(id).initial_due,0);const payments=f.a.db.prepare('SELECT * FROM payments WHERE rental_id=?').all(id);assert.equal(payments.length,1);assert.equal(payments[0].method,method);assert.equal(payments[0].user_id,staff.id);assert.equal(f.p.terminalBusy(),false);assert.throws(()=>f.p.reconcile({...b,result:'unpaid'},staff),/учтена/);assert.throws(()=>f.p.cancel({id,revision:f.row(id).revision},staff));}finally{f.a.close();}
});
test('Manual payment without terminal connection and extension payment preserve rental lifecycle',()=>{
 const f=fixture();try{const id=f.create();f.p.enabled=false;f.p.reconcile(reconciliation(f,id,'card'),staff);assert.equal(f.row(id).returned,null);extendRental(f.a,fleet,{id,revision:f.row(id).revision,minutes:30},u);f.p.reconcile(reconciliation(f,id,'cash',{phase:'extension',paymentId:null}),staff);assert.ok(f.row(id).returned);assert.equal(f.row(id).extension_due,0);assert.deepEqual(f.a.db.prepare('SELECT method FROM payments ORDER BY id').all().map(x=>x.method),['card','cash']);assert.equal(f.calls.length,0);}finally{f.a.close();}
});
test('Confirmed payment cannot be cancelled; employee can confirm existing receipt or release receipt lock',async()=>{
 const f=fixture();try{const id=f.create();await confirm(f,id,'issue');const payment=f.p.payment(id,'issue');f.p.set(payment.id,'receipt_unknown');agePayment(f,id);const count=f.calls.length;assert.throws(()=>f.p.reconcile(reconciliation(f,id,'unpaid'),staff));f.p.reconcile(reconciliation(f,id,'terminal_free'),staff);assert.equal(f.p.terminalBusy(),false);assert.equal(f.p.payment(id,'issue').state,'receipt_unknown');f.p.reconcile(reconciliation(f,id,'receipt_exists'),staff);assert.equal(f.p.payment(id,'issue').state,'done');assert.equal(f.a.db.prepare('SELECT count(*) n FROM payments WHERE rental_id=?').get(id).n,1);assert.equal(f.calls.length,count);}finally{f.a.close();}
});
test('Reconciliation rejects unauthenticated roles and accepts an employee with waiter role',()=>{
 const f=fixture();try{const id=f.create(),b=reconciliation(f,id,'cash');assert.throws(()=>f.p.reconcile(b,{id:2,role:'guest'}),e=>e.status===403);f.p.reconcile(b,{...staff,role:'waiter'});assert.equal(f.row(id).initial_due,0);}finally{f.a.close();}
});
