import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import http from 'node:http';
import {AdminStore} from './admin.mjs';
import {SmsStore} from './sms.mjs';
import {CafeStore,cafeHandler} from './cafe.mjs';
import {CafeList} from './cafe-list.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';

const date='2026-10-04',now=Date.parse(date+'T12:00:00+03:00'),owner={id:1,role:'admin'},staff={id:2,role:'staff'},waiter={id:3,role:'waiter'};
function fixture(t){
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'worker','staff','unused'),(3,'waiter','waiter','unused')");
 const c=new CafeStore(a,new SmsStore(a,null,{}),{env:{}});fillTestCafeStock(c);const item=c.catalog().items.find(i=>i.name==='Сырники');
 const body=extra=>({requestId:randomUUID(),name:'Гость',phone:'',fulfillment:'pickup',payment:'unspecified',items:[{itemId:item.id,quantity:1,optionIds:[]}],expectedTotalCents:item.priceCents,...extra});
 return {a,c,item,body};
}
const snapshot=a=>JSON.stringify(['cafe_orders','cafe_order_events','cafe_notifications','cafe_stock_usage','inventory_items','inventory_transactions','cafe_limits','clients'].map(table=>a.db.prepare('SELECT * FROM '+table+' ORDER BY '+(table==='cafe_limits'?'key':'id')).all()));
const stocks=a=>a.db.prepare('SELECT id,current_milli FROM inventory_items ORDER BY id').all();

for(const stage of ['COOKING','READY'])test('Prepared '+stage+' order rejects append and quote without any mutation',t=>{
 const f=fixture(t),r=f.c.create(f.body(),staff,'test',now),prepared=f.c.status({id:r.id,revision:r.revision,status:stage},staff,now+1),before=snapshot(f.a);
 assert.throws(()=>f.c.quote(f.body({appendId:r.id,appendRevision:prepared.revision}),staff,now+2),/отдельным заказом/);
 assert.throws(()=>f.c.append({id:r.id,revision:prepared.revision,requestId:randomUUID(),items:f.body().items,expectedTotalCents:f.item.priceCents},staff,now+2),/отдельным заказом/);
 assert.equal(snapshot(f.a),before);
});
test('Append replay remains safe after cooking starts; prior additions restore before cooking',t=>{
 const f=fixture(t),before=stocks(f.a),r=f.c.create(f.body(),staff,'test',now),b={id:r.id,revision:r.revision,requestId:randomUUID(),items:f.body().items,expectedTotalCents:f.item.priceCents};
 const added=f.c.append(b,staff,now+1),prepared=f.c.status({id:r.id,revision:added.revision,status:'COOKING'},staff,now+2),state=snapshot(f.a);
 assert.equal(f.c.append(b,staff,now+3).revision,prepared.revision);assert.equal(snapshot(f.a),state);
 const other=f.c.create(f.body(),staff,'test',now+4),extra=f.c.append({...b,id:other.id,revision:other.revision,requestId:randomUUID()},staff,now+5);
 const cancelled=f.c.status({id:other.id,revision:extra.revision,status:'CANCELLED',prepared:false},staff,now+6);
 assert.equal(cancelled.stock.state,'restored');assert.ok(cancelled.stock.items.every(i=>i.retainedMilli===0));assert.notDeepEqual(stocks(f.a),before);
});
for(const prepared of [false,true])test('Cancellation exposes exact stock outcome and reason, prepared='+prepared,t=>{
 const f=fixture(t),before=stocks(f.a),r=f.c.create(f.body(),staff,'test',now),used=stocks(f.a),b={id:r.id,revision:r.revision,status:'CANCELLED',prepared,comment:'Гость передумал'};
 const cancelled=f.c.status(b,staff,now+1);assert.equal(cancelled.stock.state,prepared?'retained':'restored');assert.deepEqual(stocks(f.a),prepared?used:before);
 const event=cancelled.events.find(e=>e.kind==='CANCELLED');assert.equal(event.comment,b.comment);assert.equal(event.stock.restored,!prepared);assert.equal(event.stock.state,cancelled.stock.state);
 assert.ok(cancelled.stock.items.length);assert.ok(cancelled.stock.items.every(i=>prepared?i.retainedMilli===i.usedMilli:i.restoredMilli===i.usedMilli));
 const saved=snapshot(f.a);f.c.status(b,staff,now+2);assert.equal(snapshot(f.a),saved);
});
test('Preparation history cannot be overridden by an unprepared cancellation',t=>{
 const f=fixture(t),r=f.c.create(f.body(),staff,'test',now),ready=f.c.status({id:r.id,revision:r.revision,status:'READY'},staff,now+1),before=stocks(f.a);
 const cancelled=f.c.status({id:r.id,revision:ready.revision,status:'CANCELLED',prepared:false},staff,now+2);
 assert.equal(cancelled.stock.state,'retained');assert.deepEqual(stocks(f.a),before);
});
test('Paid food cannot be cancelled before delivery or after a partial refund',t=>{
 const f=fixture(t),r=f.c.create(f.body({items:[{itemId:f.item.id,quantity:2}],expectedTotalCents:f.item.priceCents*2}),staff,'test',now),details={...r.details,terminalPaymentRequired:true,terminalPaidAt:now,paymentMethod:'cash'};
 f.a.db.prepare("UPDATE cafe_orders SET details=?,status='ACCEPTED' WHERE id=?").run(JSON.stringify(details),r.id);const before=stocks(f.a);
 const cancel=()=>f.c.status({id:r.id,revision:f.c.order(r.id,staff).revision,status:'CANCELLED',prepared:false},staff,now+10);
 assert.throws(cancel,/возврат/);f.a.refunds.create({requestId:randomUUID(),kind:'cafe',id:r.id,amountCents:f.item.priceCents,lines:[{index:0,quantity:1}],reason:'Возврат блюда'},staff,now+2);assert.throws(cancel,/возврат/);
 f.a.refunds.create({requestId:randomUUID(),kind:'cafe',id:r.id,amountCents:f.item.priceCents,lines:[{index:0,quantity:1}],reason:'Возврат второго блюда'},staff,now+3);
 assert.equal(cancel().status,'CANCELLED');assert.notDeepEqual(stocks(f.a),before);
});
for(const delay of [0,86400000])test('Refunded cancellation preserves gross sales and subtracts the refund once, delay='+delay,t=>{
 t.mock.method(Date,'now',()=>now+delay+10000);
 const f=fixture(t),r=f.c.create(f.body(),staff,'test',now),details={...r.details,terminalPaymentRequired:true,terminalPaidAt:now,cashPaidAt:now,paymentMethod:'cash'};
 f.a.db.prepare("UPDATE cafe_orders SET details=?,status='ACCEPTED' WHERE id=?").run(JSON.stringify(details),r.id);
 const list=new CafeList(f.c),refundAt=now+delay+1000,refundDate=new Date(refundAt+10800000).toISOString().slice(0,10);
 f.a.refunds.create({requestId:randomUUID(),kind:'cafe',id:r.id,amountCents:r.totalCents,lines:[{index:0,quantity:1}],reason:'Полный возврат',method:'cash'},staff,refundAt);
 f.c.status({id:r.id,revision:r.revision,status:'CANCELLED',prepared:true},staff,refundAt+1);
 for(const currentDate of new Set([date,refundDate])){
  const report=list.read(new URLSearchParams({date:currentDate})),full=f.c.orders(new URLSearchParams({date:currentDate}),staff);
  assert.equal(report.totalCents,currentDate===date?r.totalCents:0);assert.equal(full.totalCents,report.totalCents);
  assert.equal(report.refundsCents,currentDate===refundDate?r.totalCents:0);assert.equal(full.refundsCents,report.refundsCents);
  const revenue=f.a.workforce.revenue(currentDate,refundAt+100);assert.equal(revenue.cafe_cents,report.totalCents-report.refundsCents);
 }
 assert.equal(f.a.workforce.sales(date,refundAt+100).filter(s=>s.id==='cafe-'+r.id).length,1);assert.equal(f.c.order(r.id,staff).stock.state,'retained');
});
test('A legacy completed sale remains completed after full refund instead of losing its payment history',t=>{
 const f=fixture(t),r=f.c.create(f.body({quickSale:true}),staff,'test',now);
 f.a.refunds.create({requestId:randomUUID(),kind:'cafe',id:r.id,amountCents:r.totalCents,lines:[{index:0,quantity:1}],reason:'Полный возврат'},staff,now+1);
 const before=snapshot(f.a);assert.throws(()=>f.c.status({id:r.id,revision:r.revision,status:'CANCELLED'},staff,now+2),/остаётся выполненным/);assert.equal(snapshot(f.a),before);assert.equal(f.a.workforce.revenue(date,now+100).cafe_cents,0);
});
test('A paid delivered sale keeps delivery and customer history after its full refund',t=>{
 const f=fixture(t),r=f.c.create(f.body(),staff,'test',now),details={...r.details,terminalPaymentRequired:true,terminalPaidAt:now,paymentMethod:'cash'};
 f.a.db.prepare('UPDATE cafe_orders SET details=? WHERE id=?').run(JSON.stringify(details),r.id);const delivered=f.c.status({id:r.id,revision:r.revision,status:'DELIVERED'},staff,now+1);
 f.a.refunds.create({requestId:randomUUID(),kind:'cafe',id:r.id,amountCents:r.totalCents,lines:[{index:0,quantity:1}],reason:'Полный возврат'},staff,now+2);
 const before=snapshot(f.a);assert.throws(()=>f.c.status({id:r.id,revision:delivered.revision,status:'CANCELLED'},staff,now+3),/остаётся выполненным/);assert.equal(snapshot(f.a),before);assert.equal(f.a.workforce.revenue(date,now+100).cafe_cents,0);
});
test('Staff creation limit is per employee, transactional, expires and does not count retries',t=>{
 const f=fixture(t),key=createHash('sha256').update('staff:'+staff.id).digest('hex');f.a.db.prepare('INSERT INTO cafe_limits VALUES(?,?,?)').run(key,119,now+600000);
 const b=f.body(),r=f.c.create(b,staff,'test',now),before=snapshot(f.a);assert.equal(f.c.create(b,staff,'test',now+1).id,r.id);assert.equal(snapshot(f.a),before);
 assert.throws(()=>f.c.create(f.body(),staff,'test',now+2),e=>e.status===429);assert.equal(snapshot(f.a),before);
 assert.ok(f.c.create(f.body(),waiter,'test',now+2).id);assert.ok(f.c.create(f.body(),staff,'test',now+600000).id);assert.equal(f.a.db.prepare('SELECT count FROM cafe_limits WHERE key=?').get(key).count,1);
});
test('Failed creation rolls back stock, client, notification and staff limiter together',t=>{
 const f=fixture(t),before=snapshot(f.a),consume=f.c.stock.consume.bind(f.c.stock);f.c.stock.consume=(...args)=>{consume(...args);throw Error('Injected stock failure');};
 assert.throws(()=>f.c.create(f.body({phone:'79001234567'}),staff,'test',now),/Injected/);assert.equal(snapshot(f.a),before);
});
test('Cancellation report uses cancellation date, sums units separately and invalidates cached results',t=>{
 const f=fixture(t),list=new CafeList(f.c),r=f.c.create(f.body(),staff,'test',now-86400000),read=()=>list.read(new URLSearchParams({date}));assert.equal(read().stockCancellations.count,0);
 const cancelled=f.c.status({id:r.id,revision:r.revision,status:'CANCELLED',prepared:true},staff,now),result=read();
 assert.equal(result.stockCancellations.count,1);assert.deepEqual(result.stockCancellations.items.map(i=>[i.itemId,i.unitId,i.retainedMilli]),cancelled.stock.items.map(i=>[i.itemId,i.unitId,i.retainedMilli]));
 const item=cancelled.stock.items[0];f.a.db.prepare('UPDATE inventory_items SET name=? WHERE id=?').run('Новое название',item.itemId);assert.notEqual(read().revision,result.revision);assert.ok(read().stockCancellations.items.some(i=>i.name==='Новое название'));
 const next=f.c.create(f.body(),staff,'test',now+1);f.c.status({id:next.id,revision:next.revision,status:'CANCELLED',prepared:false},staff,now+2);assert.equal(read().stockCancellations.count,1);
});
for(const price of [30000,60000])test('House refund preserves paid delivery at price '+price+' and allows its separate return',t=>{
 const f=fixture(t),catalog=f.c.catalog();catalog.items.find(i=>i.id===f.item.id).priceCents=price;f.c.saveCatalog(catalog,owner);
 const fee=price*2>=100000?0:30000,b=f.body({fulfillment:'house',house:'5',items:[{itemId:f.item.id,quantity:2}],expectedTotalCents:price*2+fee}),r=f.c.create(b,staff,'test',now);
 f.c.status({id:r.id,revision:r.revision,status:'DELIVERED'},staff,now+1);const before=JSON.stringify(f.a.db.prepare('SELECT * FROM cafe_orders WHERE id=?').get(r.id)),stock=stocks(f.a),events=f.c.order(r.id,staff).events.length;
 const partial=f.a.refunds.create({requestId:randomUUID(),kind:'cafe',id:r.id,amountCents:price,lines:[{index:0,quantity:1}],reason:'Возврат блюда'},staff,now+2);
 assert.equal(partial.remainingCents,price+fee);assert.equal(JSON.stringify(f.a.db.prepare('SELECT * FROM cafe_orders WHERE id=?').get(r.id)),before);assert.deepEqual(stocks(f.a),stock);assert.equal(f.c.order(r.id,staff).events.length,events);
 if(fee){const delivery={requestId:randomUUID(),kind:'cafe',id:r.id,amountCents:fee,lines:[{index:-1,quantity:1}],reason:'Возврат доставки'};assert.equal(f.a.refunds.create(delivery,staff,now+3).remainingCents,price);assert.equal(f.a.refunds.create(delivery,staff,now+4).remainingCents,price);assert.throws(()=>f.a.refunds.create({...delivery,requestId:randomUUID()},staff,now+5));}else assert.ok(!partial.lines.some(l=>l.index===-1));
 assert.equal(f.a.workforce.revenue(date,now+100).cafe_cents,price);
});
test('Cafe export includes retained ingredients and cancellation reason without allowing CSV formulas',async t=>{
 const f=fixture(t),r=f.c.create(f.body(),staff,'test',now);f.c.status({id:r.id,revision:r.revision,status:'CANCELLED',prepared:true,comment:'=FORMULA'},staff,now+1);
 const session='safety-export',hash=createHash('sha256').update(session).digest('hex');f.a.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(hash,owner.id,Date.now()+60000);
 const origin='http://localhost',server=http.createServer(async(req,res)=>cafeHandler(f.c,f.a,origin)(req,res,new URL(req.url,origin)));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/admin/cafe/export?date='+date,{headers:{Cookie:'__Host-start_session='+session}});assert.equal(response.status,200);const csv=await response.text();assert.match(csv,/Склад при отмене/);assert.match(csv,/Ингредиенты не восстановлены/);assert.match(csv,/"'=FORMULA"/);assert.match(csv,new RegExp(f.c.order(r.id,staff).stock.items[0].name));}finally{await new Promise(resolve=>server.close(resolve));}
});
