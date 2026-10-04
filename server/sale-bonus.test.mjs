import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {saleBonuses} from './sale-bonus.mjs';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
const employee=(id,start,end)=>({user_id:id,worked_ms:end-start,sessions:[{started_at:start,ended_at:end}]});
test('Late arrival never receives earlier sales; departure excludes later sales',()=>{
 const rows=[employee(1,9,21),employee(2,12,21)],events=[{id:1,at:10,cents:100000},{id:2,at:12,cents:200000},{id:3,at:21,cents:10000}];
 const r=saleBonuses(events,rows,5);assert.deepEqual(r.rows.map(e=>e.bonus_cents),[10000,5000]);assert.equal(r.unallocated,500);
});
test('Cash difference alone is distributed by hours, including a negative difference',()=>{
 const rows=[employee(1,9,21),employee(2,12,21)],events=[{id:1,at:10,cents:100000}];
 const positive=saleBonuses(events,rows,5,70000);assert.deepEqual(positive.rows.map(e=>e.sales_bonus_cents),[5000,0]);assert.deepEqual(positive.rows.map(e=>e.cash_bonus_cents),[2000,1500]);
 const negative=saleBonuses(events,rows,5,-70000);assert.deepEqual(negative.rows.map(e=>e.cash_bonus_cents),[-2000,-1500]);assert.equal(negative.rows.reduce((n,e)=>n+e.bonus_cents,0),1500);
});
test('Small sales conserve kopecks; breaks are excluded and allocation is deterministic',()=>{
 const rows=[{user_id:1,worked_ms:2,sessions:[{started_at:0,ended_at:1},{started_at:2,ended_at:3}]},employee(2,0,3)];
 const r=saleBonuses(Array.from({length:100},(_,i)=>({id:i,at:1,cents:1})),rows,5);assert.deepEqual(r.rows.map(e=>e.bonus_cents),[0,5]);assert.equal(r.pool,5);
});
test('Server sales mode freezes closed salary and does not use a later arrival for previous receipts',t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused'),(3,'andrey','staff','unused')");const w=a.workforce,u={id:1,role:'admin'},day='2026-09-26',at=h=>Date.parse(day+'T'+h+':00+03:00');
 w.saveSettings({revision:0,fixedCents:250000,hourlyCents:0,fullShiftMinutes:720,bonusPercent:5,payMode:'prorated',distribution:'sales'},u,at('08:00'));
 const ivan=w.action({requestId:randomUUID()},{id:2,role:'staff'},'start',at('09:00'));
 const make=(time,amount)=>a.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Гость',phone:'79001234567',departed:day+'T'+time,expectedReturn:day+'T23:00',amount,method:'cash'},u,at(time));
 make('10:00','1000');const andrey=w.action({requestId:randomUUID()},{id:3,role:'staff'},'start',at('12:00'));make('13:00','2000');
 w.action({requestId:randomUUID(),sessionId:ivan.id},{id:2,role:'staff'},'end',at('21:00'));w.action({requestId:randomUUID(),sessionId:andrey.id},{id:3,role:'staff'},'end',at('21:00'));
 let c=w.calculate(day,at('21:01'));assert.deepEqual(c.employees.map(e=>[e.fixed_cents,e.bonus_cents]),[[250000,10000],[187500,5000]]);
 const shift=a.openShift({day,cashStartCents:0,employeeIds:[2,3]},u,at('21:02'));a.closeShift({shiftId:shift,cashEndCents:370000,cashlessCents:0},u,at('21:03'));
 c=w.calculate(day,at('21:04'));assert.deepEqual(c.employees.map(e=>e.salary_cents),[260000,192500]);
 w.saveSettings({...w.settings(),revision:1,fixedCents:999999,hourlyCents:0,bonusPercent:1,payMode:'fixed',distribution:'equal'},u,at('21:05'));assert.deepEqual(w.calculate(day,at('21:06')).employees.map(e=>e.salary_cents),[260000,192500]);
});

import {enableSaleBonus} from '../deploy/enable-sale-bonus.mjs';

test('Cafe bonus belongs to staff present at delivery, not order creation or later edits',t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused'),(3,'andrey','staff','unused')");
 const c=new CafeStore(a,new SmsStore(a,null,{}),{env:{}});fillTestCafeStock(c);
 const w=a.workforce,u={id:1,role:'admin'},day='2026-09-26',at=h=>Date.parse(day+'T'+h+':00+03:00');
 w.saveSettings({revision:0,fixedCents:250000,hourlyCents:0,fullShiftMinutes:720,bonusPercent:5,payMode:'prorated',distribution:'sales'},u,at('08:00'));
 const ivan=w.action({requestId:randomUUID()},{id:2,role:'staff'},'start',at('09:00'));
 const item=c.catalog().items.find(i=>i.name==='Сырники');
 let order=c.create({requestId:randomUUID(),name:'Гость',phone:'',consent:false,fulfillment:'pickup',payment:'cash',items:[{itemId:item.id,quantity:1,optionIds:[]}],expectedTotalCents:item.priceCents},u,'test',at('11:00'));
 w.action({requestId:randomUUID(),sessionId:ivan.id,confirmPendingOrders:1},{id:2,role:'staff'},'end',at('12:00'));
 w.action({requestId:randomUUID()},{id:3,role:'staff'},'start',at('12:00'));
 for(const status of ['ACCEPTED','COOKING','READY','DELIVERED']){order=c.order(order.id,u);c.status({id:order.id,revision:order.revision,status},u,at('13:00'));}
 assert.equal(w.sales(day,at('12:30')).length,0);
 const calc=w.calculate(day,at('14:00'));assert.deepEqual(calc.employees.map(e=>e.bonus_cents),[0,item.priceCents*5/100]);
 a.db.prepare('UPDATE cafe_orders SET updated=? WHERE id=?').run(at('15:00'),order.id);
 assert.equal(w.sales(day,at('14:00'))[0].at,at('13:00'));
});
test('Activation is idempotent and preserves closed financial records',t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
 const day='2026-09-26',u={id:1,role:'admin'},now=Date.parse(day+'T20:00:00+03:00');
 const old=a.openShift({day:'2026-09-25',cashStartCents:0,employeeIds:[]},u,now-86400000);a.db.prepare('UPDATE shifts SET closed_at=?,total_revenue_cents=12300 WHERE id=?').run(now-86400000,old);
 const before=JSON.stringify(a.db.prepare('SELECT * FROM shifts WHERE id=?').get(old));enableSaleBonus(a,day,now);assert.equal(a.workforce.settings().distribution,'sales');assert.equal(a.workforce.daySettings(day).distribution,'sales');assert.equal(enableSaleBonus(a,day,now).alreadyEnabled,true);assert.equal(JSON.stringify(a.db.prepare('SELECT * FROM shifts WHERE id=?').get(old)),before);
});
