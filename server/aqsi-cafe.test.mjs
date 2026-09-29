import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {SmsStore} from './sms.mjs';
import {CafeStore} from './cafe.mjs';
import {AqsiPilot} from './aqsi-pilot.mjs';
import {AqsiCafe} from './aqsi-cafe.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
const u={id:1,role:'admin'},staff={id:2,role:'staff'},waiter={id:3,role:'waiter'};
function fixture(){
 const a=new AdminStore(':memory:');a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");
 const c=new CafeStore(a,new SmsStore(a,null,{}));fillTestCafeStock(c);
 const calls=[],answers=[],connection={read:()=>({apiKey:'test-key',deviceId:709740}),request:async(url,options)=>{calls.push({url,...options});const answer=answers.shift();if(answer instanceof Error)throw answer;return {ok:true,json:async()=>answer};}};
 new AqsiPilot(a,connection);const p=new AqsiCafe(a,connection,c,{enabled:true});c.terminal=p;
 a.workforce.requireOnDuty=()=>{};
 const item=c.catalog().items.find(i=>i.name==='Сырники');
 const body=()=>({requestId:randomUUID(),name:'Тест',phone:'',fulfillment:'pickup',payment:'unspecified',quickSale:true,items:[{itemId:item.id,quantity:1,optionIds:[]}],expectedTotalCents:item.priceCents});
 const order=()=>c.create(body(),staff);
 return {a,c,p,connection,calls,answers,body,order};
}
async function paid(f,r){const paymentId=randomUUID(),receiptOp=randomUUID();f.answers.push({operationId:paymentId});await f.p.begin({id:r.id,revision:r.revision},staff);f.answers.push({operationId:paymentId,deviceId:709740,type:'acquiring.purchase',status:'Completed',result:JSON.stringify({id:paymentId,device:{id:709740},content:{type:'purchase',amount:r.totalCents,responseCode:'000',dateTime:new Date().toISOString(),sequenceNumber:'123'}})},{operationId:receiptOp});await f.p.tick();return receiptOp;}
test('Website orders print immediately and complete without an API payment; stale unused flags are repaired',async()=>{
 const f=fixture();try{
  const printed=[];f.a.printStore={cafeEvent:id=>printed.push(id)};
  const r=f.c.create({...f.body(),quickSale:false,phone:'89030000000',consent:true,payment:'card_on_delivery'},null,'local',Date.parse('2026-09-28T12:00:00+03:00'));
  assert.equal(r.details.terminalPaymentRequired,undefined);assert.equal(printed.length,1);
  await assert.rejects(f.p.begin({id:r.id,revision:0},staff),/не ожидает/);assert.equal(f.calls.length,0);
  f.a.db.prepare("UPDATE cafe_orders SET details=json_set(details,'$.terminalPaymentRequired',1,'$.pendingKitchen',0) WHERE id=?").run(r.id);
  const repaired=new AqsiCafe(f.a,f.connection,f.c,{enabled:true});const order=f.c.order(r.id,staff);assert.equal(order.details.terminalPaymentRequired,undefined);
  assert.equal(f.c.status({id:r.id,revision:order.revision,status:'DELIVERED'},staff).status,'DELIVERED');assert.equal(f.calls.length,0);
  assert.equal(repaired.payment(r.id),null);assert.equal(f.a.db.prepare('SELECT count(*) n FROM cafe_notifications').get().n,1);
 }finally{f.a.close();}
});
test('Cafe terminal: one debit for concurrent staff and browser retries, no revenue before bank confirmation',async()=>{
 const f=fixture();try{
  const b=f.body(),r=f.c.create(b,staff);assert.equal(r.status,'NEW');assert.equal(f.c.create(b,staff).id,r.id);
  assert.equal(f.a.workforce.sales(new Date(Date.now()+10800000).toISOString().slice(0,10),Date.now()).length,0);
  assert.throws(()=>f.c.status({id:r.id,revision:0,status:'DELIVERED'},staff),/Сначала/);
  const op=randomUUID();f.answers.push({operationId:op});await Promise.all([f.p.begin({id:r.id,revision:0},staff),f.p.begin({id:r.id,revision:0},waiter)]);
  assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0].body).amount,r.totalCents);assert.equal(JSON.parse(f.calls[0].body).mode,'sbp_with_card');
  assert.throws(()=>f.c.status({id:r.id,revision:0,status:'CANCELLED'},u),/Оплата/);
  assert.throws(()=>f.c.append({id:r.id,revision:0,requestId:randomUUID(),items:b.items,expectedTotalCents:b.expectedTotalCents},staff),/Оплата/);
  const next=f.order();await assert.rejects(f.p.begin({id:next.id,revision:0},waiter),/занята/);assert.equal(f.calls.length,1);
 }finally{f.a.close();}
});
test('Cafe terminal: confirmed payment accounts once even if fiscal receipt fails, protects paid order after restart',async()=>{
 const f=fixture();try{const r=f.order(),op=await paid(f,r);assert.equal(f.c.order(r.id,staff).status,'DELIVERED');assert.equal(f.c.order(r.id,staff).terminalPayment.paid,true);
  const receipt=JSON.parse(f.calls.find(x=>x.url.endsWith('/Receipts/process')).body);assert.equal(receipt.positions[0].info.name,'Лимонад');assert.equal(receipt.positions[0].info.finalPrice,r.totalCents);assert.equal(receipt.payments[0].amount,r.totalCents);
  f.answers.push({operationId:op,deviceId:709740,type:'receipt.process',status:'Error'});await f.p.tick();
  assert.equal(f.p.payment(r.id).state,'review');const restarted=new AqsiCafe(f.a,f.connection,f.c,{enabled:true});await restarted.begin({id:r.id,revision:0},waiter);await restarted.tick();
  assert.equal(f.calls.filter(x=>x.method==='POST').length,2);assert.equal(f.a.db.prepare("SELECT count(*) n FROM cafe_order_events WHERE kind='DELIVERED'").get().n,1);
 }finally{f.a.close();}
});
test('Cafe terminal: completed receipt releases terminal and next order can pay; free orders never use terminal',async()=>{
 const f=fixture();try{const r=f.order(),op=await paid(f,r);f.answers.push({operationId:op,deviceId:709740,type:'receipt.process',status:'Completed',result:JSON.stringify({id:'receipt-1',device:{id:709740},isNonFiscal:false,info:{typeId:1,sum:r.totalCents,docInfo:{docNumber:8526}}})});await f.p.tick();assert.equal(f.p.payment(r.id).state,'done');
  const free=f.c.create({...f.body(),expectedTotalCents:0,complimentary:{reason:'guest',comment:'Подарок'}},u);assert.equal(free.status,'DELIVERED');assert.equal(free.details.terminalPaymentRequired,undefined);await assert.rejects(f.p.begin({id:free.id,revision:free.revision},u));
  const next=f.order();f.answers.push({operationId:randomUUID()});await f.p.begin({id:next.id,revision:0},waiter);assert.equal(f.calls.filter(x=>x.url.endsWith('/purchase')).length,2);
 }finally{f.a.close();}
});
test('Cafe terminal: lost response and interrupted dispatch stay locked; stale revisions, roles and no shift cannot debit',async()=>{
 const f=fixture();try{const r=f.order();await assert.rejects(f.p.begin({id:r.id,revision:0},null));await assert.rejects(f.p.begin({id:r.id,revision:4},staff),/изменился/);
  f.a.workforce.requireOnDuty=()=>{throw Error('Нет смены');};await assert.rejects(f.p.begin({id:r.id,revision:0},staff),/смены/);assert.equal(f.calls.length,0);f.a.workforce.requireOnDuty=()=>{};
  f.answers.push(Error('lost'));await f.p.begin({id:r.id,revision:0},staff);assert.equal(f.p.payment(r.id).state,'payment_unknown');const restarted=new AqsiCafe(f.a,f.connection,f.c,{enabled:true});await restarted.begin({id:r.id,revision:0},waiter);await restarted.tick();assert.equal(f.calls.length,1);
 }finally{f.a.close();}
});
test('Cafe prepayment: kitchen receives one complete ticket only after payment; completion does not add revenue again',async()=>{
 const f=fixture();try{
  const printed=[];f.a.printStore={cafeEvent:(id)=>printed.push(f.a.db.prepare('SELECT kind FROM cafe_order_events WHERE id=?').get(id).kind)};
  const r=f.c.create({...f.body(),quickSale:false},staff);assert.equal(printed.length,0);assert.equal(f.a.db.prepare('SELECT count(*) n FROM cafe_notifications').get().n,0);
  const op=await paid(f,r);const live=f.c.order(r.id,staff);assert.equal(live.status,'ACCEPTED');assert.ok(live.details.terminalPaidAt);
  assert.equal(printed.filter(x=>x==='NEW').length,1);assert.equal(f.a.db.prepare('SELECT count(*) n FROM cafe_notifications').get().n,1);
  const day=new Date(Date.now()+10800000).toISOString().slice(0,10),before=f.a.workforce.revenue(day,Date.now());assert.equal(before.cafe_cents,r.totalCents);assert.equal(f.a.refunds.info('cafe',r.id,staff).paidCents,r.totalCents);
  f.c.status({id:r.id,revision:live.revision,status:'DELIVERED'},waiter);
  assert.equal(f.a.workforce.revenue(day,Date.now()).cafe_cents,before.cafe_cents);assert.equal(f.a.workforce.sales(day,Date.now()).length,1);
  f.answers.push({operationId:op,deviceId:709740,type:'receipt.process',status:'Completed',result:JSON.stringify({id:'fiscal',device:{id:709740},isNonFiscal:false,info:{typeId:1,sum:r.totalCents,docInfo:{docNumber:1}}})});await f.p.tick();assert.equal(printed.filter(x=>x==='NEW').length,1);
 }finally{f.a.close();}
});

test('Manually reconciled cancellation releases terminal, keeps original payment and never repeats charge',async()=>{
 const f=fixture();try{const r=f.order();f.answers.push({operationId:randomUUID()});await f.p.begin({id:r.id,revision:r.revision},staff);
  f.p.set(f.p.forOrder(r.id).id,'review');assert.equal(f.p.terminalBusy(),true);
  // Only after provider cancellation AND owner confirmation of no debit.
  f.p.set(f.p.forOrder(r.id).id,'cancelled');assert.equal(f.p.terminalBusy(),false);
  const current=f.c.order(r.id,u);f.c.status({id:r.id,revision:current.revision,status:'CANCELLED'},u);
  assert.equal(f.c.order(r.id,u).status,'CANCELLED');assert.equal(f.p.forOrder(r.id).state,'cancelled');
  const before=f.calls.length;await assert.rejects(f.p.begin({id:r.id,revision:r.revision},staff));await f.p.tick();assert.equal(f.calls.length,before);
 }finally{f.a.close();}
});

async function cancelled(f,r){const op=randomUUID();f.answers.push({operationId:op});await f.p.begin({id:r.id,revision:r.revision},staff);f.answers.push({operationId:op,deviceId:709740,type:'acquiring.purchase',status:'Canceled',result:null});await f.p.tick();return f.p.forOrder(r.id).id;}
test('Device cancellation unlocks automatically; explicit concurrent retries create one new attempt and keep history',async()=>{
 const f=fixture();try{const r=f.order(),first=await cancelled(f,r);assert.equal(f.p.terminalBusy(),false);assert.equal(f.c.order(r.id,u).status,'NEW');
  await assert.rejects(f.p.begin({id:r.id,revision:r.revision},staff));
  f.answers.push({operationId:randomUUID()});const b={id:r.id,revision:r.revision,retryPaymentId:first};await Promise.all([f.p.begin(b,staff),f.p.begin(b,waiter)]);
  assert.equal(f.calls.filter(x=>x.method==='POST').length,2);assert.equal(f.a.db.prepare('SELECT count(*) n FROM aqsi_cafe_attempts WHERE order_id=?').get(r.id).n,2);assert.equal(f.p.row(first).state,'cancelled');
  const second=f.p.forOrder(r.id);f.answers.push({operationId:second.payment_op,deviceId:709740,type:'acquiring.purchase',status:'Canceled',result:null});await f.p.tick();await assert.rejects(f.p.begin(b,staff));
  const other=f.order();f.answers.push({operationId:randomUUID()});await f.p.begin({id:other.id,revision:other.revision},staff);assert.equal(f.p.forOrder(other.id).state,'payment_waiting');
 }finally{f.a.close();}
});
test('Cash after cancellation accounts once, releases kitchen once, never sends payment or fiscal requests',async()=>{
 const f=fixture();try{const body=f.body();body.quickSale=false;const r=f.c.create(body,staff),previous=await cancelled(f,r),before=f.calls.length;
  const b={id:r.id,revision:r.revision,retryPaymentId:previous,cash:true};await Promise.all([f.p.begin(b,staff),f.p.begin(b,waiter)]);await f.p.tick();
  const order=f.c.order(r.id,u);assert.equal(order.status,'ACCEPTED');assert.ok(order.details.terminalPaidAt);assert.equal(order.details.manualCashReceipt,true);assert.equal(order.terminalPayment.paid,true);assert.equal(order.terminalPayment.state,'cash_done');assert.equal(f.calls.length,before);assert.equal(f.p.terminalBusy(),false);
  assert.equal(f.a.db.prepare("SELECT count(*) n FROM cafe_order_events WHERE order_id=? AND kind='PAID'").get(r.id).n,1);assert.equal(f.a.db.prepare("SELECT count(*) n FROM cafe_order_events WHERE order_id=? AND kind='NEW'").get(r.id).n,1);
  f.c.status({id:r.id,revision:order.revision,status:'DELIVERED'},staff);assert.equal(f.c.order(r.id,u).details.terminalPaidAt,order.details.terminalPaidAt);
 }finally{f.a.close();}
});
test('Unknown result cannot be replaced by cash or cancelled and stays globally locked',async()=>{
 const f=fixture();try{const r=f.order();f.answers.push(Error('lost'));await f.p.begin({id:r.id,revision:r.revision},staff);const p=f.p.forOrder(r.id);await f.p.begin({id:r.id,revision:r.revision,retryPaymentId:p.id,cash:true},staff);assert.equal(f.p.forOrder(r.id).state,'payment_unknown');assert.ok(!f.c.order(r.id,u).details.terminalPaidAt);assert.throws(()=>f.c.status({id:r.id,revision:r.revision,status:'CANCELLED'},staff));assert.equal(f.p.terminalBusy(),true);
 }finally{f.a.close();}
});

test('Earlier review-only canceled operation is reconciled by read-only polling, without retrying a payment',async()=>{
 const f=fixture();try{const r=f.order(),op=randomUUID();f.answers.push({operationId:op});await f.p.begin({id:r.id,revision:r.revision},staff);f.p.set(f.p.forOrder(r.id).id,'review');f.answers.push({operationId:op,deviceId:709740,type:'acquiring.purchase',status:'Canceled',result:null});await f.p.tick();assert.equal(f.p.forOrder(r.id).state,'cancelled');assert.equal(f.calls.filter(x=>x.method==='POST').length,1);assert.equal(f.p.terminalBusy(),false);
 }finally{f.a.close();}
});
