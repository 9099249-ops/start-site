import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore,adminHandler} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
import http from 'node:http';

const date='2026-09-27',at=t=>Date.parse(date+'T'+t+':00+03:00'),owner={id:1,role:'admin'},staff={id:2,role:'staff'},waiter={id:3,role:'waiter'};
function fixture(){const a=new AdminStore(':memory:');a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused'),(3,'anna','waiter','unused')");const w=a.workforce;w.saveSettings({revision:0,payMode:'prorated',hourlyCents:0,fixedCents:250000,bonusPercent:5,distribution:'sales'},owner,at('08:00'));const session=w.action({requestId:randomUUID()},staff,'start',at('09:00'));const c=new CafeStore(a,new SmsStore(a,null,{}),{env:{}});fillTestCafeStock(c);return {a,w,c,session,close:()=>a.close()};}
function check(name,fn){test(name,async()=>{const f=fixture();try{await fn(f);}finally{f.close();}});}
function rental(f,amount='1000',time=at('10:00')){return f.a.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Тест',phone:'+79000000000',departed:'2026-09-27T10:00',expectedReturn:'2026-09-27T11:00',amount,method:'unspecified'},staff,time);}
const refund=(kind,id,amountCents,more={})=>({requestId:randomUUID(),kind,id,amountCents,reason:'Дождь / качество',...more});
check('Refund: partial and full rental refunds preserve rental and original payments; retries are safe',f=>{
 const id=rental(f),before=JSON.stringify(f.a.db.prepare('SELECT * FROM rentals WHERE id=?').get(id)),payment=JSON.stringify(f.a.db.prepare('SELECT * FROM payments').all());
 const b=refund('rental',id,30000),r=f.a.refunds.create(b,waiter,at('11:00'));
 assert.equal(r.remainingCents,70000);assert.equal(f.a.refunds.create(b,waiter,at('11:01')).refundId,r.refundId);
 assert.throws(()=>f.a.refunds.create({...b,amountCents:20000},staff,at('11:02')),e=>e.status===409);
 assert.throws(()=>f.a.refunds.create(refund('rental',id,70001),staff,at('11:02')),e=>e.status===409);
 f.a.refunds.create(refund('rental',id,70000),staff,at('11:03'));
 assert.equal(f.a.refunds.info('rental',id,staff).remainingCents,0);
 assert.equal(JSON.stringify(f.a.db.prepare('SELECT * FROM rentals WHERE id=?').get(id)),before);
 assert.equal(JSON.stringify(f.a.db.prepare('SELECT * FROM payments').all()),payment);
 assert.equal(f.a.refunds.total(date,at('12:00')),100000);
 assert.equal(f.w.calculate(date,at('12:00')).revenue.cents,0);
 assert.equal(f.w.calculate(date,at('12:00')).employees[0].bonus_cents,0);
 assert.equal(f.a.db.prepare("SELECT count(*) n FROM financial_audit_log WHERE action='customer_refund'").get().n,2);
});
check('Refund: bonus is removed from people at original sale, not later arrivals',f=>{
 const id=rental(f);f.w.action({requestId:randomUUID()},waiter,'start',at('12:00'));
 f.a.refunds.create(refund('rental',id,20000),waiter,at('13:00'));
 const c=f.w.calculate(date,at('14:00'));assert.deepEqual(c.employees.map(e=>e.bonus_cents),[4000,0]);assert.equal(c.revenue.cents,80000);
 const reconciled=f.w.calculate(date,at('14:00'),80000);assert.deepEqual(reconciled.employees.map(e=>e.bonus_cents),[4000,0]);assert.equal(reconciled.revenue.cash_adjustment_cents,0);
});
check('Refund: cafe item quantities, delivery, free and unpaid orders; prepared stock stays consumed',f=>{
 const item=f.c.catalog().items.find(i=>i.name==='Сырники'),body={requestId:randomUUID(),items:[{itemId:item.id,quantity:2,optionIds:[]}],fulfillment:'pickup',payment:'unspecified',expectedTotalCents:2*item.priceCents,quickSale:true};
 const r=f.c.create(body,staff,'test',at('10:00')),stock=JSON.stringify(f.a.db.prepare('SELECT * FROM cafe_stock_usage').all());
 const b=refund('cafe',r.id,item.priceCents,{lines:[{index:0,quantity:1}]});f.a.refunds.create(b,waiter,at('11:00'));
 assert.equal(f.a.refunds.info('cafe',r.id,waiter).lines[0].remainingQuantity,1);
 assert.throws(()=>f.a.refunds.create(refund('cafe',r.id,item.priceCents*2,{lines:[{index:0,quantity:2}]}),waiter,at('11:01')));
 assert.throws(()=>f.a.refunds.create(refund('cafe',r.id,1,{lines:[{index:0,quantity:1}]}),waiter,at('11:01')));
 assert.equal(JSON.stringify(f.a.db.prepare('SELECT * FROM cafe_stock_usage').all()),stock);
 assert.equal(f.c.order(r.id,owner).status,'DELIVERED');assert.equal(f.c.order(r.id,owner).total_cents,2*item.priceCents);
 assert.equal(f.w.revenue(date,at('12:00')).cafe_cents,item.priceCents);
 const free=f.c.create({...body,requestId:randomUUID(),complimentary:{reason:'owner'},expectedTotalCents:0},owner,'test',at('11:00'));
 assert.throws(()=>f.a.refunds.create(refund('cafe',free.id,item.priceCents,{lines:[{index:0,quantity:1}]}),waiter,at('11:01')));
 const unpaid=f.c.create({...body,requestId:randomUUID(),quickSale:false},staff,'test',at('11:00'));
 assert.throws(()=>f.a.refunds.create(refund('cafe',unpaid.id,item.priceCents,{lines:[{index:0,quantity:1}]}),waiter,at('11:01')));
});
check('Refund: closed payroll and payments stay immutable; separate adjustment limits next payout',f=>{
 const sid=f.a.openShift({day:date,cashStartCents:0},owner,at('09:01')),id=rental(f);
 f.w.action({requestId:randomUUID(),sessionId:f.session.id},staff,'end',at('21:00'));
 f.a.closeShift({shiftId:sid,cashEndCents:100000,cashlessCents:0},owner,at('21:01'));
 const frozen=JSON.stringify(f.a.db.prepare('SELECT * FROM shift_employees').all());
 f.a.refunds.create(refund('rental',id,10000),waiter,at('22:00'));
 assert.equal(JSON.stringify(f.a.db.prepare('SELECT * FROM shift_employees').all()),frozen);
 assert.equal(f.a.refunds.closedAdjustment(sid,staff.id,at('22:01')),500);
 const salary=f.a.db.prepare('SELECT salary_cents FROM shift_employees').get().salary_cents;
 assert.throws(()=>f.w.pay({shiftId:sid,userId:staff.id,amountCents:salary},owner,at('22:02')));
 f.w.pay({shiftId:sid,userId:staff.id,amountCents:salary-500},owner,at('22:02'));
 const paid=JSON.stringify(f.a.db.prepare('SELECT * FROM payroll_payments').all());
 f.a.refunds.create(refund('rental',id,10000),staff,at('22:03'));
 assert.equal(JSON.stringify(f.a.db.prepare('SELECT * FROM payroll_payments').all()),paid);
 assert.equal(f.a.refunds.closedAdjustment(sid,staff.id,at('22:04')),1000);
});
check('Refund: repeated small partial refunds remove exactly the original rounded bonus',f=>{
 const id=rental(f,'1.03');for(let i=0;i<103;i++)f.a.refunds.create(refund('rental',id,1),staff,at('11:00')+i);
 assert.equal(f.a.db.prepare('SELECT sum(amount_cents) n FROM refund_bonus_adjustments').get().n,5);
 assert.equal(f.w.calculate(date,at('12:00')).employees[0].bonus_cents,0);
});
check('Refund HTTP: all staff roles can refund; no login and cross-origin requests cannot',async f=>{
 let user=waiter;f.a.user=()=>user;const h=adminHandler(f.a,'http://test'),server=http.createServer((req,res)=>h(req,res,new URL(req.url,'http://test')));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url='http://127.0.0.1:'+server.address().port+'/api/admin/refunds',id=rental(f),send=(origin='http://test')=>fetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({...refund('rental',id,10000),method:'cash'})});
  for(const role of [waiter,staff,owner]){user=role;assert.equal((await send()).status,200);}
  assert.equal((await send('http://evil')).status,403);user=null;assert.equal((await send()).status,401);
 }finally{await new Promise(r=>server.close(r));}
});
check('Refund: later-day cash return does not reduce current crew bonus; negative net day can close',f=>{
 const original=f.a.openShift({day:date,cashStartCents:0},owner,at('09:01')),id=rental(f);
 f.w.action({requestId:randomUUID(),sessionId:f.session.id},staff,'end',at('21:00'));f.a.closeShift({shiftId:original,cashEndCents:100000,cashlessCents:0},owner,at('21:01'));
 const next=t=>at(t)+86400000,session=f.w.action({requestId:randomUUID()},waiter,'start',next('09:00'));
 const shift=f.a.openShift({day:'2026-09-28',cashStartCents:100000},owner,next('09:01'));
 f.a.refunds.create(refund('rental',id,100000),waiter,next('10:00'));
 const calc=f.w.calculate('2026-09-28',next('11:00'));assert.equal(calc.revenue.cents,-100000);assert.equal(calc.employees[0].bonus_cents,0);
 f.w.action({requestId:randomUUID(),sessionId:session.id},waiter,'end',next('21:00'));
 const closed=f.a.closeShift({shiftId:shift,cashEndCents:0,cashlessCents:0},owner,next('21:01'));assert.equal(closed.total_revenue_cents,-100000);assert.equal(closed.employees[0].bonus_cents,0);
});
