import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
const user={id:1,role:'admin'},staff={id:2,role:'staff'},at=s=>Date.parse(s+':00+03:00');
function fixture(t){const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','x'),(2,'ivan','staff','x'); INSERT INTO admin_config(key,value) VALUES('auto_shift_from','2026-09-28')");a.workforce.env={START_SIMPLE_SHIFT:'1'};a.workforce.saveSettings({revision:0,payMode:'prorated',fixedCents:250000,hourlyCents:0,fullShiftMinutes:720,bonusPercent:5,distribution:'sales'},user);return a;}
const arrive=(w,time)=>w.action({requestId:randomUUID(),cashStartCents:10000},staff,'start',at(time));
test('Pay stops at 02:00, attendance and cash close at 07:30; new day starts at 08:00',t=>{
 const a=fixture(t),w=a.workforce,row=arrive(w,'2026-09-28T20:00');
 assert.equal(w.calculate('2026-09-28',at('2026-09-29T01:00')).employees[0].worked_ms,5*3600000);
 assert.equal(w.calculate('2026-09-28',at('2026-09-29T06:00')).employees[0].worked_ms,6*3600000);
 w.auto.run(at('2026-09-29T07:29'));assert.equal(a.currentShift('2026-09-28').closed_at,null);assert.equal(a.db.prepare('SELECT ended_at FROM employee_work_sessions WHERE id=?').get(row.id).ended_at,null);
 w.auto.run(at('2026-09-29T07:30'));assert.equal(a.db.prepare('SELECT ended_at FROM employee_work_sessions WHERE id=?').get(row.id).ended_at,at('2026-09-29T02:00'));
 const shift=a.currentShift('2026-09-28');assert.equal(shift.closed_at,at('2026-09-29T07:30'));assert.equal(a.shiftDetails(shift.id).employees[0].salary_cents,125000);
 assert.equal(w.snapshot(staff,undefined,at('2026-09-29T07:31')).active.length,0);
 assert.throws(()=>arrive(w,'2026-09-29T07:59'),/08:00/);
 arrive(w,'2026-09-29T08:00');assert.equal(a.currentShift('2026-09-29').closed_at,null);assert.equal(w.calculate('2026-09-29',at('2026-09-29T08:00')).employees[0].salary_cents,0);
});
test('Delayed scheduler closes at intended times and never closes new morning staff',t=>{
 const a=fixture(t),w=a.workforce;arrive(w,'2026-09-28T20:00');
 w.auto.run(at('2026-09-29T10:00'));const before=JSON.stringify(a.shiftDetails(a.currentShift('2026-09-28').id));
 const next=arrive(w,'2026-09-29T10:01');w.auto.run(at('2026-09-29T10:02'));w.auto.run(at('2026-09-29T10:03'));
 assert.equal(JSON.stringify(a.shiftDetails(a.currentShift('2026-09-28').id)),before);assert.equal(a.db.prepare('SELECT ended_at FROM employee_work_sessions WHERE id=?').get(next.id).ended_at,null);
 assert.equal(a.db.prepare('SELECT count(*) n FROM automatic_shift_closures').get().n,1);
 assert.equal(a.db.prepare("SELECT count(*) n FROM financial_audit_log WHERE action='work_auto_end'").get().n,1);
});
test('Manual departure and manually closed revenue remain intact; late hours remain payable once',t=>{
 const a=fixture(t),w=a.workforce;const row=arrive(w,'2026-09-28T20:00');w.action({requestId:randomUUID(),sessionId:row.id},staff,'end',at('2026-09-28T21:00'));
 const shiftId=a.currentShift('2026-09-28').id,b={shiftId,totalRevenueCents:0,requestId:randomUUID()};b.previewHash=w.preview(b,user,at('2026-09-28T21:01')).previewHash;w.closeCashShift(b,user,at('2026-09-28T21:01'));
 const before=JSON.stringify(a.shiftDetails(shiftId));arrive(w,'2026-09-28T23:00');w.auto.run(at('2026-09-29T07:30'));
 assert.equal(JSON.stringify(a.shiftDetails(shiftId)),before);assert.equal(a.db.prepare('SELECT ended_at FROM employee_work_sessions WHERE id=?').get(row.id).ended_at,at('2026-09-28T21:00'));
 assert.equal(w.calculate('2026-09-28',at('2026-09-29T08:00')).after_close.employees[0].worked_ms,3*3600000);
 arrive(w,'2026-09-29T08:00');assert.equal(w.settlement('2026-09-29',at('2026-09-29T09:00'),0).carried_work.length,1);
});
test('Overnight paid sales belong to previous shift and are not counted again at 08:00',t=>{
 const a=fixture(t),w=a.workforce;arrive(w,'2026-09-28T20:00');
 a.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Тест',phone:'79001234567',departed:'2026-09-29T01:00',amount:'1000',method:'unspecified'},user,at('2026-09-29T01:00'));
 assert.equal(w.sales('2026-09-28',at('2026-09-29T01:01')).length,1);assert.equal(w.sales('2026-09-29',at('2026-09-29T09:00')).length,0);
 w.auto.run(at('2026-09-29T07:30'));assert.equal(a.currentShift('2026-09-28').total_revenue_cents,100000);assert.equal(a.shiftDetails(a.currentShift('2026-09-28').id).employees[0].salary_cents,130000);
 assert.equal(w.calculate('2026-09-29',at('2026-09-29T08:00')).revenue.cents,0);
});

test('Overnight refund adjusts the original closed shift bonus and is not lost between days',t=>{
 const a=fixture(t),w=a.workforce;arrive(w,'2026-09-28T20:00');
 const rental=a.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Тест',phone:'79001234567',departed:'2026-09-29T01:00',amount:'1000',method:'unspecified'},user,at('2026-09-29T01:00'));
 w.auto.run(at('2026-09-29T07:30'));const id=a.currentShift('2026-09-28').id;
 a.refunds.create({requestId:randomUUID(),kind:'rental',id:rental,amountCents:100000,reason:'Возврат'},staff,at('2026-09-29T09:00'));
 assert.equal(a.refunds.closedAdjustment(id,staff.id,at('2026-09-29T09:01')),5000);
 assert.equal(a.refunds.total('2026-09-29',at('2026-09-29T09:01')),100000);assert.equal(a.refunds.total('2026-09-28',at('2026-09-29T09:01')),0);
});
test('Duty guard blocks stale attendance after morning cutoff even before worker runs',t=>{
 const a=fixture(t),w=a.workforce;arrive(w,'2026-09-28T20:00');w.requireOnDuty(at('2026-09-29T07:29'));
 assert.throws(()=>w.requireOnDuty(at('2026-09-29T07:30')),/На смене никого/);
});
