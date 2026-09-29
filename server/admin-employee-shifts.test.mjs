import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
const admin={id:1,role:'admin'},staff={id:2,role:'staff'},waiter={id:3,role:'waiter'},at=h=>Date.parse('2026-09-28T'+h+':00:00+03:00');
test('Admin manages employee shifts; actor, retries, permissions and actual time preserved',()=>{
 const a=new AdminStore(':memory:');try{
 a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','x'),(2,'ivan','staff','x'),(3,'anna','waiter','x')");const w=a.workforce;
 const b={userId:2,requestId:randomUUID()},row=w.action(b,admin,'start',at('09'));
 assert.equal(row.user_id,2);assert.equal(row.started_at,at('09'));assert.equal(w.action(b,admin,'start',at('10')).id,row.id);assert.equal(w.action({...b,requestId:randomUUID()},admin,'start',at('10')).id,row.id);
 assert.throws(()=>w.action({...b,userId:3},admin,'start',at('10')),e=>e.status===409);
 assert.throws(()=>w.action({userId:3,requestId:randomUUID()},staff,'start',at('10')),e=>e.status===403);
 assert.throws(()=>w.action({userId:2,sessionId:row.id,requestId:randomUUID()},waiter,'end',at('10')),e=>e.status===403);
 const end={userId:2,sessionId:row.id,requestId:randomUUID()};assert.equal(w.action(end,admin,'end',at('12')).ended_at,at('12'));assert.equal(w.action(end,admin,'end',at('13')).ended_at,at('12'));
 const calc=w.calculate('2026-09-28',at('13'));assert.equal(calc.employees.find(e=>e.user_id===2).worked_ms,3*3600000);assert.equal(calc.employees.some(e=>e.user_id===1),false);
 assert.deepEqual(a.db.prepare("SELECT actor,action FROM financial_audit_log WHERE action IN ('work_start','work_end')").all().map(x=>({...x})),[{actor:1,action:'work_start'},{actor:1,action:'work_end'}]);
 assert.throws(()=>w.action({userId:999,requestId:randomUUID()},admin,'start',at('13')),e=>e.status===404);
 }finally{a.close();}
});
