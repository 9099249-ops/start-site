import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore,adminHandler} from './admin.mjs';
import {CafeStore,cafeHandler} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
import http from 'node:http';
const at=s=>Date.parse(s+':00+03:00');
test('Late coffee work: no cash reopening, no second fixed rate, immutable report, settlement exactly once',t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused')");const w=a.workforce,u={id:1,role:'admin'},ivan={id:2,role:'staff'};
 w.saveSettings({revision:0,payMode:'prorated',fixedCents:250000,hourlyCents:0,fullShiftMinutes:720,bonusPercent:5,distribution:'sales'},u);
 const start=s=>w.action({requestId:randomUUID()},ivan,'start',at(s));
 const end=(session,s)=>w.action({requestId:randomUUID(),sessionId:session.id},ivan,'end',at(s));
 const sale=(s,amount)=>a.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Гость',phone:'79001234567',departed:s,amount,method:'unspecified'},u,at(s));
 let session=start('2026-09-27T09:00');sale('2026-09-27T10:00','1000');end(session,'2026-09-27T21:00');
 const id=a.openShift({day:'2026-09-27',cashStartCents:0},u,at('2026-09-27T21:01'));
 a.closeShift({shiftId:id,cashEndCents:100000,cashlessCents:0},u,at('2026-09-27T21:02'));
 const frozen=JSON.stringify(a.shiftDetails(id));
 assert.throws(()=>w.requireOnDuty(at('2026-09-27T21:03')),/На смене никого/);
 session=start('2026-09-27T21:10');w.requireOnDuty(at('2026-09-27T21:10'));
 assert.equal(w.calculate('2026-09-27',at('2026-09-27T21:10')).employees[0].salary_cents,255000);
 sale('2026-09-27T21:15','300');end(session,'2026-09-27T21:20');
 let c=w.calculate('2026-09-27',at('2026-09-27T21:21'));
 assert.equal(c.after_close.employees[0].fixed_cents,3472);assert.equal(c.after_close.employees[0].bonus_cents,1500);assert.equal(c.employees[0].salary_cents,259972);
 assert.equal(JSON.stringify(a.shiftDetails(id)),frozen);
 session=start('2026-09-28T09:00');sale('2026-09-28T09:30','1000');end(session,'2026-09-28T10:00');
 const second=a.openShift({day:'2026-09-28',cashStartCents:130000},u,at('2026-09-28T09:00'));
 const body={shiftId:second,cashEndCents:230000,cashlessCents:0};c=w.preview(body,u,at('2026-09-28T10:01')).calculation;
 assert.equal(c.revenue.after_close_cents,0);assert.equal(c.revenue.carried_revenue_cents,30000);assert.equal(c.revenue.cents,100000);assert.equal(c.revenue.cash_adjustment_cents,0);assert.equal(c.employees[0].salary_cents,20833+5000+4972);
 a.closeShift(body,u,at('2026-09-28T10:01'));
 assert.equal(JSON.stringify(a.shiftDetails(id)),frozen);
 assert.equal(w.settlement('2026-09-29',at('2026-09-29T10:00'),0).revenue.after_close_cents,0);
 assert.equal(a.db.prepare('SELECT count(*) n FROM late_work_settlements').get().n,1);
 assert.throws(()=>a.closeShift(body,u,at('2026-09-28T10:02')),/уже закрыта/);
});
test('Guard uses actual active interval, not cash state, future or finished sessions',t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused')");const w=a.workforce,ivan={id:2,role:'staff'},time=at('2026-09-27T09:00');
 assert.throws(()=>w.requireOnDuty(time),/Я на смене/);const s=w.action({requestId:randomUUID()},ivan,'start',time);
 assert.throws(()=>w.requireOnDuty(time-1));w.requireOnDuty(time);
 w.action({requestId:randomUUID(),sessionId:s.id},ivan,'end',time+1000);assert.throws(()=>w.requireOnDuty(time+1000));
});
test('Late session crossing midnight is clipped and does not permanently block the next cash close',t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused')");const w=a.workforce,u={id:1,role:'admin'},ivan={id:2,role:'staff'};
 w.saveSettings({revision:0,payMode:'prorated',fixedCents:250000,hourlyCents:0,fullShiftMinutes:720,bonusPercent:5,distribution:'sales'},u);
 let s=w.action({requestId:randomUUID()},ivan,'start',at('2026-09-27T20:00'));w.action({requestId:randomUUID(),sessionId:s.id},ivan,'end',at('2026-09-27T21:00'));
 const first=a.openShift({day:'2026-09-27',cashStartCents:0},u,at('2026-09-27T21:01'));a.closeShift({shiftId:first,cashEndCents:0,cashlessCents:0},u,at('2026-09-27T21:02'));
 s=w.action({requestId:randomUUID()},ivan,'start',at('2026-09-27T23:50'));w.action({requestId:randomUUID(),sessionId:s.id},ivan,'end',at('2026-09-28T00:10'));
 const calc=w.settlement('2026-09-28',at('2026-09-28T00:11'),0);assert.equal(calc.employees[0].active,false);assert.equal(calc.employees[0].worked_ms,20*60000);
 const second=a.openShift({day:'2026-09-28',cashStartCents:0},u,at('2026-09-28T00:11'));a.closeShift({shiftId:second,cashEndCents:0,cashlessCents:0},u,at('2026-09-28T00:12'));
 assert.equal(a.shiftDetails(first).employees[0].worked_ms,3600000);
});
test('HTTP: cafe and rental creation require attendance; stock and money stay unchanged when blocked',async t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused')");const u={id:1,role:'admin'},ivan={id:2,role:'staff'},w=a.workforce,sms=new SmsStore(a,null,{}),c=new CafeStore(a,sms,{env:{}});fillTestCafeStock(c);let actor=u;a.user=()=>actor;
 const origin='http://localhost',handlers=[cafeHandler(c,a,origin),adminHandler(a,origin)],server=http.createServer(async(req,res)=>{for(const h of handlers)if(await h(req,res,new URL(req.url,origin)))return;});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  const url='http://127.0.0.1:'+server.address().port,post=(p,b)=>fetch(url+p,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(b)});
  const item=c.catalog().items.find(i=>i.name==='Сырники'),body={requestId:randomUUID(),fulfillment:'pickup',payment:'unspecified',items:[{itemId:item.id,quantity:1}],expectedTotalCents:item.priceCents,quickSale:true};
   actor=ivan;for(const path of ['/api/admin/cafe/orders','/api/admin/cafe/quote','/api/admin/cafe/append','/api/admin/rentals']){const res=await post(path,body);assert.equal(res.status,409);assert.match((await res.json()).error,/Я на смене/);}
  assert.equal(a.db.prepare('SELECT count(*) n FROM cafe_orders').get().n,0);assert.equal(a.db.prepare('SELECT count(*) n FROM payments').get().n,0);
  const session=w.action({requestId:randomUUID()},ivan,'start');assert.equal((await post('/api/admin/cafe/orders',body)).status,200);
  w.action({requestId:randomUUID(),sessionId:session.id},ivan,'end');assert.equal((await post('/api/admin/cafe/orders',{...body,requestId:randomUUID()})).status,409);
  const publicResponse=await post('/api/cafe/quote',{});assert.doesNotMatch((await publicResponse.json()).error,/Я на смене/);
 }finally{await new Promise(r=>server.close(r));}
});
