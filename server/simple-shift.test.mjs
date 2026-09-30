import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
const u={id:1,role:'admin'},s={id:2,role:'staff'},at=h=>Date.parse('2026-09-28T'+h+':00+03:00');
test('Opening cash is available to every employee without attendance or salary and retries safely',t=>{
 const a=fixture(t),w=a.workforce;a.db.exec("INSERT INTO admin_users VALUES(3,'waiter','waiter','x')");
 const b={requestId:randomUUID(),day:'2026-09-28',cashStartCents:50000};
 assert.throws(()=>w.desk.openCash(b,s,at('07:59')),/08:00/);
 const result=w.desk.openCash(b,s,at('08:00'));assert.deepEqual(w.desk.openCash(b,s,at('08:01')),result);
 for(const actor of [u,{id:3,role:'waiter'}])assert.equal(w.desk.openCash({...b,requestId:randomUUID(),cashStartCents:99900},actor,at('08:02')).shiftId,result.shiftId);
 assert.equal(a.currentShift(b.day).cash_start_cents,50000);assert.equal(a.db.prepare('SELECT count(*) n FROM shifts').get().n,1);
 assert.equal(a.db.prepare('SELECT count(*) n FROM employee_work_sessions').get().n,0);assert.equal(w.calculate(b.day,at('08:05')).employees.length,0);
 assert.throws(()=>w.desk.openCash({...b,cashStartCents:60000},s,at('08:03')),e=>e.status===409);
 assert.throws(()=>w.desk.openCash(b,u,at('08:03')),e=>e.status===409);
 w.action({requestId:randomUUID()},s,'start',at('09:00'));assert.equal(a.currentShift(b.day).cash_start_cents,50000);
 assert.equal(w.calculate(b.day,at('10:00')).employees[0].worked_ms,3600000);
});
test('Cash opening rejects closed days, stale forms, invalid amounts and unauthorized roles',t=>{
 const a=fixture(t),w=a.workforce,b={requestId:randomUUID(),day:'2026-09-28',cashStartCents:50000};
 for(const actor of [null,{id:9,role:'customer'}])assert.throws(()=>w.desk.openCash(b,actor,at('09:00')),e=>e.status===403);
 for(const cashStartCents of [-1,1.5,100000001])assert.throws(()=>w.desk.openCash({...b,cashStartCents},s,at('09:00')));
 assert.throws(()=>w.desk.openCash({...b,day:'2026-09-27'},s,at('09:00')),e=>e.status===409);
 const result=w.desk.openCash(b,s,at('09:00'));a.db.prepare('UPDATE shifts SET closed_at=? WHERE id=?').run(at('10:00'),result.shiftId);
 const saved=a.currentShift(b.day);assert.throws(()=>w.desk.openCash({...b,requestId:randomUUID()},s,at('10:01')),e=>e.status===409);assert.deepEqual(a.currentShift(b.day),saved);
 const tomorrow=Date.parse('2026-09-29T08:00:00+03:00');assert.deepEqual(w.desk.openCash(b,s,tomorrow),result);assert.equal(a.currentShift('2026-09-29'),null);
 const next=w.desk.openCash({...b,requestId:randomUUID(),day:'2026-09-29'},s,tomorrow);assert.notEqual(next.shiftId,result.shiftId);assert.deepEqual(a.currentShift(b.day),saved);
});
function fixture(t){const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','x'),(2,'ivan','staff','x')");a.workforce.env={START_SIMPLE_SHIFT:'1'};a.workforce.saveSettings({revision:0,payMode:'prorated',fixedCents:250000,hourlyCents:0,fullShiftMinutes:720,bonusPercent:5,distribution:'sales'},u);return a;}
test('First attendance requires cash and 08:00, atomic opening, subsequent arrivals preserve balance',t=>{const a=fixture(t),w=a.workforce,b={requestId:randomUUID(),cashStartCents:50000};assert.throws(()=>w.action(b,s,'start',at('07:59')),/08:00/);assert.equal(a.currentShift('2026-09-28'),null);assert.throws(()=>w.action({requestId:randomUUID()},s,'start',at('08:00')),e=>e.needsCashStart);assert.equal(w.snapshot(s,'2026-09-28',at('08:00')).active.length,0);const r=w.action(b,s,'start',at('08:00'));assert.equal(w.action(b,s,'start',at('09:00')).id,r.id);w.action({requestId:randomUUID(),cashStartCents:90000},u,'start',at('09:00'));assert.equal(a.currentShift('2026-09-28').cash_start_cents,50000);assert.equal(a.db.prepare('SELECT count(*) n FROM shifts').get().n,1);});
test('Withdrawals retry safely and cannot change revenue; only admin corrects opening',t=>{const a=fixture(t),w=a.workforce;w.action({requestId:randomUUID(),cashStartCents:50000},s,'start',at('09:00'));const shiftId=a.currentShift('2026-09-28').id,b={shiftId,amountCents:10000,requestId:randomUUID()};w.desk.withdrawal(b,s,at('10:00'));w.desk.withdrawal(b,s,at('10:01'));assert.equal(a.shiftMovements(shiftId)[0].login,'ivan');assert.throws(()=>w.desk.withdrawal(b,u,at('10:01')),e=>e.status===409);assert.equal(a.shiftMovements(shiftId).length,1);assert.equal(w.desk.summary(u,at('10:01')).registeredCents,0);assert.throws(()=>w.desk.withdrawal({...b,amountCents:20000},u,at('10:02')),e=>e.status===409);assert.throws(()=>w.desk.correctOpening({shiftId,expectedCashStartCents:50000,cashStartCents:60000},s,at('10:03')),e=>e.status===403);w.desk.correctOpening({shiftId,expectedCashStartCents:50000,cashStartCents:60000},u,at('10:03'));assert.throws(()=>w.desk.correctOpening({shiftId,expectedCashStartCents:50000,cashStartCents:70000},u,at('10:04')),e=>e.status===409);});
test('One total freezes prorated salary and adjustment, close retries once, late work does not reopen cash',t=>{const a=fixture(t),w=a.workforce;const r=w.action({requestId:randomUUID(),cashStartCents:900000},s,'start',at('09:00'));w.action({sessionId:r.id,requestId:randomUUID()},s,'end',at('10:00'));const shiftId=a.currentShift('2026-09-28').id,b={shiftId,totalRevenueCents:100000,requestId:randomUUID()};const p=w.preview(b,u,at('10:01'));assert.equal(p.calculation.employees[0].salary_cents,20833+5000);b.previewHash=p.previewHash;const closed=w.closeCashShift(b,u,at('10:01'));assert.equal(closed.total_revenue_cents,100000);assert.equal(closed.cashless_cents,null);assert.equal(w.closeCashShift(b,u,at('10:02')).id,shiftId);assert.throws(()=>w.closeCashShift({...b,totalRevenueCents:200000},u,at('10:02')),e=>e.status===409);const late=w.action({requestId:randomUUID()},s,'start',at('10:10'));assert.equal(a.currentShift('2026-09-28').id,shiftId);assert.equal(w.calculate('2026-09-28',at('10:10')).employees[0].salary_cents,25833);assert.ok(late.id!==r.id);});

test('Staff and waiters can withdraw after close without changing frozen salary or revenue',t=>{
 const a=fixture(t),w=a.workforce;a.db.exec("INSERT INTO admin_users VALUES(3,'waiter','waiter','x')");
 const session=w.action({requestId:randomUUID(),cashStartCents:50000},s,'start',at('09:00'));
 w.action({requestId:randomUUID(),sessionId:session.id},s,'end',at('10:00'));
 const shiftId=a.currentShift('2026-09-28').id,b={shiftId,totalRevenueCents:100000,requestId:randomUUID()};b.previewHash=w.preview(b,u,at('10:01')).previewHash;w.closeCashShift(b,u,at('10:01'));
 const before=a.currentShift('2026-09-28'),employees=a.db.prepare('SELECT * FROM shift_employees WHERE shift_id=?').all(shiftId),calc=w.calculate('2026-09-28',at('10:02'));
 for(const actor of [s,{id:3,role:'waiter'}]){const request={shiftId,amountCents:10000,comment:'После закрытия',requestId:randomUUID()};w.desk.withdrawal(request,actor,at('10:02'));w.desk.withdrawal(request,actor,at('10:03'));}
 assert.equal(a.shiftMovements(shiftId).length,2);assert.deepEqual(a.shiftMovements(shiftId).map(x=>x.created_by),[2,3]);
 assert.deepEqual(a.currentShift('2026-09-28'),before);assert.deepEqual(a.db.prepare('SELECT * FROM shift_employees WHERE shift_id=?').all(shiftId),employees);assert.deepEqual(w.calculate('2026-09-28',at('10:02')),calc);
});
test('After midnight withdrawal uses the latest day, and stale forms cannot target an older day',t=>{
 const a=fixture(t),w=a.workforce;w.action({requestId:randomUUID(),cashStartCents:50000},s,'start',at('09:00'));const shiftId=a.currentShift('2026-09-28').id;
 a.db.prepare('UPDATE shifts SET closed_at=? WHERE id=?').run(at('22:00'),shiftId);
 const midnight=Date.parse('2026-09-29T00:30:00+03:00');assert.equal(w.desk.withdrawalContext(s,midnight).shift.id,shiftId);
 const b={shiftId,amountCents:1000,requestId:randomUUID()};w.desk.withdrawal(b,s,midnight);
 const morning=Date.parse('2026-09-29T09:00:00+03:00');w.action({requestId:randomUUID(),cashStartCents:10000},u,'start',morning);
 assert.notEqual(w.desk.withdrawalContext(s,morning).shift.id,shiftId);
 w.desk.withdrawal(b,s,morning);assert.equal(a.shiftMovements(shiftId).length,1);
 assert.throws(()=>w.desk.withdrawal({...b,requestId:randomUUID()},s,morning),e=>e.status===409);
});
test('Withdrawals reject unauthenticated and unrelated roles, missing day and invalid amounts',t=>{
 const a=fixture(t),w=a.workforce;const b={shiftId:1,amountCents:1000,requestId:randomUUID()};
 for(const actor of [null,{id:9,role:'customer'}])assert.throws(()=>w.desk.withdrawal(b,actor,at('10:00')),e=>e.status===403);
 assert.equal(w.desk.withdrawalContext(s,at('10:00')).shift,null);assert.throws(()=>w.desk.withdrawal(b,s,at('10:00')),e=>e.status===409);
 w.action({requestId:randomUUID(),cashStartCents:0},s,'start',at('10:00'));
 for(const amountCents of [0,-1,1.5,100000001])assert.throws(()=>w.desk.withdrawal({...b,amountCents,requestId:randomUUID()},s,at('10:01')));
 assert.equal(a.shiftMovements(1).length,0);
});
