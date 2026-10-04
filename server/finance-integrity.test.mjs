import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {PrintStore} from './print.mjs';

const day='2026-09-27',at=(d,h)=>Date.parse(d+'T'+h+':00+03:00');
function fixture(t,{third=false}={}){
 const a=new AdminStore(':memory:');t.after(()=>a.close());
 a.db.exec(`INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused')${third?",(3,'anna','staff','unused')":""}`);
 const u={id:1,role:'admin'},ivan={id:2,role:'staff'},w=a.workforce;
 const c=new CafeStore(a,new SmsStore(a,null,{}),{env:{}});
 return {a,c,u,ivan,w};
}
function settings(w,u,now){w.saveSettings({revision:0,payMode:'fixed',fixedCents:50000,hourlyCents:0,fullShiftMinutes:720,bonusPercent:5,distribution:'sales'},u,now);}
function session(w,user,d,start,end){const s=w.action({requestId:randomUUID()},user,'start',at(d,start));w.action({requestId:randomUUID(),sessionId:s.id},user,'end',at(d,end));return s;}
function cafeSale(a,id,d,time,cents,bonusActor){
 const now=at(d,time),details={name:'Тест',fulfillment:'pickup',items:[],terminalPaidAt:now,...(bonusActor?{bonusActor}:{})};
 a.db.prepare('INSERT INTO cafe_orders(id,request_id,fingerprint,public_token,source,details,total_cents,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run(id,randomUUID(),'test-'+id,'token-'+id,'admin',JSON.stringify(details),cents,'DELIVERED',now,now);
}
function closeWithDeclaration(a,w,u,d,now,declared){
 const shiftId=a.openShift({day:d,cashStartCents:0,employeeIds:[2]},u,now-1);
 const body={shiftId,totalRevenueCents:declared,requestId:randomUUID()};body.previewHash=w.preview(body,u,now).previewHash;
 return a.closeShift(body,u,now);
}

test('Settlement uses current-day registered revenue and carries late work without adding its sales to revenue',t=>{
 const {a,u,ivan,w}=fixture(t);settings(w,u,at(day,'08:00'));
 session(w,ivan,day,'09:00','20:00');cafeSale(a,1,day,'10:00',10000);
 const first=closeWithDeclaration(a,w,u,day,at(day,'20:02'),10000);
 const late=w.action({requestId:randomUUID()},ivan,'start',at(day,'21:00'));
 cafeSale(a,2,day,'21:15',30000);w.action({requestId:randomUUID(),sessionId:late.id},ivan,'end',at(day,'21:30'));
 const next='2026-09-28';session(w,ivan,next,'09:00','10:00');cafeSale(a,3,next,'09:30',20000);
 const calc=w.settlement(next,at(next,'10:01'),90000);
 assert.equal(calc.revenue.registered_cents,20000);assert.equal(calc.revenue.cents,20000);
 assert.equal(calc.carried_work.length,1);assert.equal(calc.carried_work[0].day,day);
 assert.equal(calc.revenue.variance_cents,70000);
 const negative=w.settlement(next,at(next,'10:01'),-10000);
 assert.equal(negative.revenue.registered_cents,20000);assert.equal(negative.revenue.cents,20000);assert.equal(negative.revenue.variance_cents,-30000);
 closeWithDeclaration(a,w,u,next,at(next,'10:02'),90000);
 const closed=w.calculate(next,at(next,'10:03'));
 assert.equal(closed.revenue.cents,20000);assert.equal(closed.revenue.variance_cents,70000);
 assert.equal(closed.employees.find(e=>e.user_id===2).salary_cents,54583);
 const settledShiftId=a.db.prepare('SELECT id FROM shifts WHERE day=?').get(next).id;
 const old=w.calculate(day,at(next,'10:03'));
 assert.equal(old.after_close,undefined);assert.equal(old.final,true);
 assert.equal(a.db.prepare('SELECT settled_shift_id FROM late_work_settlements WHERE source_shift_id=?').get(first.id).settled_shift_id,settledShiftId);
 const payroll=w.payroll.list(u,at(next,'10:03')).find(e=>e.shift_id===settledShiftId&&e.user_id===2);
 assert.deepEqual(payroll.origins.map(x=>x.day),[day,next]);
 assert.equal(a.db.prepare('SELECT count(*) n FROM late_work_settlements WHERE source_shift_id=?').get(first.id).n,1);
 w.pay({shiftId:settledShiftId,userId:2,amountCents:payroll.salary_cents,method:'external',requestId:randomUUID()},u,at(next,'10:04'));
 const printed=new PrintStore(a).reportSnapshot(settledShiftId,at(next,'10:05')).employees.find(e=>e.userId===2);
 assert.equal(printed.remainingCents,0);assert.equal(printed.salaryCents,payroll.salary_cents);assert.deepEqual(printed.origins.map(x=>x.day),[day,next]);
 assert.equal(first.total_revenue_cents,10000);
});

test('Admin collector bonus is shared across on-duty non-admin staff',t=>{
 const {a,u,w}=fixture(t,{third:true});settings(w,u,at(day,'08:00'));
 const ivan=w.action({requestId:randomUUID()},{id:2,role:'staff'},'start',at(day,'09:00'));
 const anna=w.action({requestId:randomUUID()},{id:3,role:'staff'},'start',at(day,'09:00'));
 cafeSale(a,10,day,'10:00',10000,1);
 const calc=w.calculate(day,at(day,'10:01'));
 assert.deepEqual(calc.employees.map(e=>e.bonus_cents),[250,250]);
 assert.equal(w.sales(day,at(day,'10:01'))[0].bonusActor,null);
 assert.ok(ivan.id&&anna.id);
});

test('Closed rental amount and payment method edits are rejected with conflict',t=>{
 const {a,u}=fixture(t),now=at(day,'12:00');
 const createClosed=method=>{const id=a.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Гость',phone:'79001234567',departed:day+'T11:00',amount:'100.00',method},u,now);a.returned(id,u,now+1000);return id;};
 const amountId=createClosed('cash'),methodId=createClosed('card');
 session(a.workforce,{id:2,role:'staff'},day,'09:00','20:00');
 closeWithDeclaration(a,a.workforce,u,day,at(day,'20:02'),20000);
 const editBody=(id,method)=>({id,revision:a.db.prepare('SELECT revision FROM rentals WHERE id=?').get(id).revision,reason:'Проверка',equipment:'sup',quantity:1,name:'Гость',phone:'79001234567',departed:day+'T11:00',amount:'120.00',method});
 assert.throws(()=>a.edit(editBody(amountId,'cash'),u,at(day,'20:03')),e=>e.status===409);
 assert.throws(()=>a.edit(editBody(methodId,'cash'),u,at(day,'20:03')),e=>e.status===409);
 assert.equal(a.db.prepare('SELECT amount FROM payments WHERE rental_id=?').get(amountId).amount,10000);
 assert.equal(a.db.prepare('SELECT method FROM payments WHERE rental_id=?').get(methodId).method,'card');
});

test('Cash close removes deposits and count corrections, adds cash payroll back, and pays salary from registered sales',t=>{
 const {a,u,ivan,w}=fixture(t);settings(w,u,at(day,'08:00'));
 session(w,ivan,day,'09:00','20:00');const oldShift=closeWithDeclaration(a,w,u,day,at(day,'20:02'),0);
 const next='2026-09-28',cashOpen=at(next,'09:01');
 w.action({requestId:randomUUID()},{id:2,role:'staff'},'start',at(next,'09:00'));
 const shiftId=a.openShift({day:next,cashStartCents:10000,employeeIds:[2]},u,cashOpen);
 a.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Гость',phone:'79001234567',departed:next+'T10:00',amount:'50.00',method:'cash'},u,at(next,'10:00'));
 w.pay({shiftId:oldShift.id,userId:2,amountCents:2000,method:'cash',requestId:randomUUID()},u,at(next,'11:00'));
 const depositBase=a.cashLedger.summary(u,at(next,'11:01'));
 a.cashLedger.change({requestId:randomUUID(),kind:'deposit',amountCents:7000,reason:'Внесение',version:depositBase.version},u,at(next,'11:02'));
 const countBase=a.cashLedger.summary(u,at(next,'11:03'));
 a.cashLedger.change({requestId:randomUUID(),kind:'count',amountCents:countBase.balanceCents+3000,reason:'Пересчёт',version:countBase.version},u,at(next,'11:04'));
 const counted=a.cashLedger.summary(u,at(next,'11:05'));
 w.action({requestId:randomUUID(),sessionId:a.db.prepare('SELECT id FROM employee_work_sessions WHERE user_id=2 AND started_at>=?').get(at(next,'00:00')).id},{id:2,role:'staff'},'end',at(next,'20:00'));
 const closed=a.closeShift({shiftId,cashEndCents:counted.balanceCents,cashlessCents:0},u,at(next,'20:02'));
 assert.equal(closed.cash_revenue_cents,5000);
 const employee=closed.employees.find(e=>e.user_id===2);
 assert.equal(JSON.parse(employee.calculation_json).revenue_cents,5000);
 assert.equal(employee.salary_cents,50250);
});

test('Payroll accepts cash, card, and external with idempotent request IDs',t=>{
 const {a,u,ivan,w}=fixture(t);settings(w,u,at(day,'08:00'));
 session(w,ivan,day,'09:00','20:00');const closed=closeWithDeclaration(a,w,u,day,at(day,'20:02'),0),userId=2;
 a.openShift({day:'2026-09-28',cashStartCents:0,employeeIds:[]},u,at('2026-09-28','09:00'));
 for(const method of ['cash','card','external']){
  const requestId=randomUUID(),body={shiftId:closed.id,userId,amountCents:1000,method,requestId};
  w.pay(body,u,at('2026-09-28','09:05'));w.pay(body,u,at('2026-09-28','09:06'));
 }
 assert.equal(a.db.prepare('SELECT count(*) n FROM payroll_payments WHERE shift_id=? AND user_id=?').get(closed.id,userId).n,3);
 assert.deepEqual(a.db.prepare('SELECT method FROM payroll_payments WHERE shift_id=? AND user_id=? ORDER BY id').all(closed.id,userId).map(x=>x.method),['cash','card','external']);
});

test('Reporting a previously paid salary creates review state only, with no cash movement',t=>{
 const {a,u,ivan,w}=fixture(t);settings(w,u,at(day,'08:00'));
 session(w,ivan,day,'09:00','20:00');const closed=closeWithDeclaration(a,w,u,day,at(day,'20:02'),0);
 const paymentsBefore=a.db.prepare('SELECT count(*) n FROM payroll_payments').get().n;
 const movementsBefore=a.db.prepare('SELECT count(*) n FROM cash_movements').get().n;
 const result=w.payroll.reportPaid({shiftId:closed.id,userId:2},u,at(day,'20:03'));
 const row=result.find(x=>x.shift_id===closed.id&&x.user_id===2);
 assert.equal(row.remaining_cents,0);assert.equal(row.review_required,true);
 assert.equal(a.db.prepare('SELECT count(*) n FROM payroll_payments').get().n,paymentsBefore);
 assert.equal(a.db.prepare('SELECT count(*) n FROM cash_movements').get().n,movementsBefore);
});

test('Closing with a physical cash count sets the baseline without changing revenue or bonus',t=>{
 const {a,u,ivan,w}=fixture(t);settings(w,u,at(day,'08:00'));const shift=a.openShift({day,cashStartCents:100000},u,at(day,'08:30'));session(w,ivan,day,'09:00','20:00');
 const body={shiftId:shift,cashEndCents:110000,cashlessCents:0,requestId:randomUUID()},time=at(day,'20:02');body.previewHash=w.preview(body,u,time).previewHash;a.closeShift(body,u,time);
 assert.equal(a.cashLedger.summary(u,time).balanceCents,110000);assert.equal(a.shiftDetails(shift).total_revenue_cents,0);assert.equal(w.calculate(day,time).employees[0].bonus_cents,0);
 assert.equal(w.calculate(day,time).revenue.variance_cents,10000);assert.equal(a.shiftDetails(shift).declared_revenue_cents,10000);
 a.closeShift(body,u,time+1);assert.equal(a.db.prepare("SELECT count(*) n FROM cash_ledger WHERE request_id=?").get('shift-close:'+shift).n,1);
 a.addWithdrawal({shiftId:shift,amountCents:5000,comment:'После пересчёта'},u,time+2,{allowClosed:true});assert.equal(a.cashLedger.summary(u,time+3).balanceCents,105000);
 assert.equal(w.desk.state(at('2026-09-28','09:00')).suggestedCashCents,105000);
});
