import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {basePayCents} from './workforce.mjs';

const hour=3600000;
const at=s=>Date.parse(s+':00+03:00');
const owner={id:1,role:'admin'},worker={id:2,role:'staff'};

function fixture(t){
 const admin=new AdminStore(':memory:');
 t.after(()=>admin.close());
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused')");
 const workforce=admin.workforce;
 workforce.saveSettings({revision:0,payMode:'prorated',fixedCents:247500,hourlyCents:0,fullShiftMinutes:480,bonusPercent:5,distribution:'equal'},owner);
 const start=s=>workforce.action({requestId:randomUUID()},worker,'start',at(s));
 const end=(session,s)=>workforce.action({requestId:randomUUID(),sessionId:session.id},worker,'end',at(s));
 return {admin,workforce,start,end};
}

function closeDay(admin,day,time){
 const shiftId=admin.openShift({day,cashStartCents:0},owner,at(time));
 admin.closeShift({shiftId,cashEndCents:0,cashlessCents:0},owner,at(time));
 return shiftId;
}

test('Long shift base pay respects the exact threshold and leaves legacy settings uncapped',()=>{
 const flagged={pay_mode:'prorated',fixed_cents:247500,full_shift_minutes:480,long_shift_rule:{version:'over-eight-hours-20261007'}};
 assert.equal(basePayCents(flagged,0),0);
 assert.equal(basePayCents(flagged,8*hour),247500);
 assert.equal(basePayCents(flagged,8*hour+1),250000);
 assert.equal(basePayCents(flagged,13*hour),250000);
 const legacy={...flagged,long_shift_rule:undefined};
 assert.equal(basePayCents(legacy,13*hour),402188);
});

test('Long shift rule starts on 2026-10-07 and applies to the combined same-day work time',t=>{
 const {workforce,start,end}=fixture(t);
 let session=start('2026-10-06T09:00');end(session,'2026-10-06T18:00');
 let calc=workforce.calculate('2026-10-06',at('2026-10-06T21:00'));
 assert.equal(calc.settings.long_shift_rule,undefined);
 assert.equal(calc.employees[0].worked_ms,9*hour);
 assert.equal(calc.employees[0].fixed_cents,278438);

 session=start('2026-10-07T09:00');end(session,'2026-10-07T13:00');
 session=start('2026-10-07T14:00');end(session,'2026-10-07T18:00');
 calc=workforce.calculate('2026-10-07',at('2026-10-07T21:00'));
 assert.deepEqual(calc.settings.long_shift_rule,{version:'over-eight-hours-20261007',effective_from:'2026-10-07'});
 assert.equal(calc.employees[0].worked_ms,8*hour);
 assert.equal(calc.employees[0].fixed_cents,247500);

 session=start('2026-10-07T19:00');end(session,'2026-10-07T19:01');
 calc=workforce.calculate('2026-10-07',at('2026-10-07T21:00'),1000000);
 assert.equal(calc.employees[0].worked_ms,8*hour+60000);
 assert.equal(calc.employees[0].fixed_cents,250000);
 assert.equal(calc.employees[0].bonus_cents,50000);
 assert.equal(calc.employees[0].salary_cents,calc.employees[0].fixed_cents+calc.employees[0].bonus_cents);
});

test('Closed pre-rule payroll remains unchanged after later work',t=>{
 const {admin,workforce,start,end}=fixture(t);
 let session=start('2026-10-06T09:00');end(session,'2026-10-06T18:00');
 const shiftId=closeDay(admin,'2026-10-06','2026-10-06T18:01');
 const frozen=JSON.stringify(admin.shiftDetails(shiftId));
 session=start('2026-10-06T18:10');end(session,'2026-10-06T18:20');
 const calc=workforce.calculate('2026-10-06',at('2026-10-06T19:00'));
 assert.equal(calc.settings.long_shift_rule,undefined);
 assert.equal(JSON.stringify(admin.shiftDetails(shiftId)),frozen);
});

test('Historically closed 2026-10-07 payroll without a rule marker remains immutable',t=>{
 const {admin,workforce,start,end}=fixture(t);
 let session=start('2026-10-07T09:00');end(session,'2026-10-07T17:00');
 const shiftId=closeDay(admin,'2026-10-07','2026-10-07T17:01');

 const shift=admin.db.prepare('SELECT salary_settings_json FROM shifts WHERE id=?').get(shiftId);
 const settings=JSON.parse(shift.salary_settings_json);
 delete settings.long_shift_rule;
 admin.db.prepare('UPDATE shifts SET salary_settings_json=? WHERE id=?').run(JSON.stringify(settings),shiftId);
 for(const employee of admin.db.prepare('SELECT user_id,calculation_json FROM shift_employees WHERE shift_id=?').all(shiftId)){
  const calculation=JSON.parse(employee.calculation_json);
  delete calculation.settings.long_shift_rule;
  admin.db.prepare('UPDATE shift_employees SET calculation_json=? WHERE shift_id=? AND user_id=?').run(JSON.stringify(calculation),shiftId,employee.user_id);
 }
 const frozen=JSON.stringify(admin.shiftDetails(shiftId));

 session=start('2026-10-07T17:10');end(session,'2026-10-07T17:11');
 const calc=workforce.calculate('2026-10-07',at('2026-10-07T19:00'));
 assert.equal(calc.settings.long_shift_rule,undefined);
 assert.equal(JSON.stringify(admin.shiftDetails(shiftId)),frozen);
});

test('Closed new-rule payroll freezes its base and late work pays only the cumulative difference',t=>{
 for(const {frozenHours,tailMinutes,expectedTailBase} of [
  {frozenHours:8,tailMinutes:1,expectedTailBase:2500},
  {frozenHours:9,tailMinutes:10,expectedTailBase:0},
 ])test(`${frozenHours}h frozen plus ${tailMinutes}m late`,t=>{
  const {admin,workforce,start,end}=fixture(t);
  let session=start('2026-10-07T09:00');end(session,`2026-10-07T${String(9+frozenHours).padStart(2,'0')}:00`);
  const closeHour=9+frozenHours;
  const shiftId=closeDay(admin,'2026-10-07',`2026-10-07T${String(closeHour).padStart(2,'0')}:01`);
  const frozen=JSON.stringify(admin.shiftDetails(shiftId));
  session=start(`2026-10-07T${String(closeHour).padStart(2,'0')}:05`);
  end(session,`2026-10-07T${String(closeHour).padStart(2,'0')}:${String(5+tailMinutes).padStart(2,'0')}`);

  const calc=workforce.calculate('2026-10-07',at('2026-10-07T23:00'));
  assert.equal(JSON.stringify(admin.shiftDetails(shiftId)),frozen);
  assert.deepEqual(calc.settings.long_shift_rule,{version:'over-eight-hours-20261007',effective_from:'2026-10-07'});
  assert.equal(calc.employees[0].worked_ms,(frozenHours*60+tailMinutes)*60000);
  assert.equal(calc.after_close.employees[0].worked_ms,tailMinutes*60000);
  assert.equal(calc.after_close.employees[0].fixed_cents,expectedTailBase);
  assert.equal(calc.employees[0].fixed_cents,250000);
 });
});
