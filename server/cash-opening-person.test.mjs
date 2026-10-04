import test from 'node:test';
import assert from 'node:assert/strict';
import {AdminStore} from './admin.mjs';
test('Cash opening shows actual employee and time, following a correction without confusing later recounts',t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());
 a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'ivan','staff','unused');INSERT INTO employee_profiles VALUES(2,'Иван')");
 const at=Date.parse('2026-09-30T06:15:00Z'),now=at+3600000,admin={id:1,role:'admin'},staff={id:2,role:'staff'};
 const id=Number(a.db.prepare('INSERT INTO shifts(day,opened_at,opened_by,cash_start_cents) VALUES(?,?,?,?)').run(a.workforce.accountingDay(now),at,2,955000).lastInsertRowid);
 let s=a.cashLedger.summary(staff,now);assert.deepEqual(s.openingCount,{name:'Иван',at,corrected:false});assert.equal(s.balanceCents,955000);
 a.workforce.desk.correctOpening({shiftId:id,cashStartCents:960000,expectedCashStartCents:955000},admin,at+1000);
 s=a.cashLedger.summary(staff,now);assert.deepEqual(s.openingCount,{name:'admin',at:at+1000,corrected:true});assert.equal(s.openingCents,960000);
 a.cashLedger.change({requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',kind:'count',amountCents:970000,reason:'Пересчёт',version:s.version},staff,now);
 s=a.cashLedger.summary(staff,now);assert.equal(s.balanceCents,970000);assert.equal(s.openingCount.at,at+1000);assert.equal(s.openingCents,960000);
});
