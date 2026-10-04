import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {AqsiPilot} from './aqsi-pilot.mjs';
const deviceId=709740;
function fixture(t){
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
 const calls=[],answers=[],shift={id:'shift-current',device:{id:deviceId},shiftOpenedReport:{dateTime:new Date().toISOString()},shiftClosedReport:null};
 const conn={read:()=>({apiKey:'test',deviceId}),request:async(url,options)=>{calls.push({url,...options});if(url.includes('/Shifts?'))return {ok:true,json:async()=>({rows:[{id:shift.id,device:shift.device}]})};if(url.includes('/Shifts/'))return {ok:true,json:async()=>shift};const answer=answers.shift();assert.ok(answer,'Unexpected request');if(answer instanceof Error)throw answer;return {ok:true,json:async()=>answer};}};
 const p=new AqsiPilot(a,conn),id=randomUUID(),op=randomUUID();a.db.prepare("INSERT INTO aqsi_pilot VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,randomUUID(),deviceId,100,'payment_sending',null,null,null,null,Date.now(),Date.now(),1);
 return {a,p,id,op,shift,calls,answers,conn};
}
const posts=f=>f.calls.filter(c=>c.method==='POST');
for(const reason of ['closed','expired','wrong-device','missing-date'])test('Preflight prevents debit and releases terminal: '+reason,async t=>{
 const f=fixture(t);if(reason==='closed')f.shift.shiftClosedReport={};if(reason==='expired')f.shift.shiftOpenedReport.dateTime=new Date(Date.now()-86400001).toISOString();if(reason==='wrong-device')f.shift.device.id++;if(reason==='missing-date')delete f.shift.shiftOpenedReport.dateTime;
 await f.p.send(f.id,'payment',{deviceId,amount:100});assert.equal(posts(f).length,0);assert.equal(f.p.row(f.id).state,'cancelled');assert.equal(f.p.terminalBusy(),false);assert.match(f.p.view(f.p.row(f.id)).diagnostic.message,/не списывались/);
});
test('Closed-shift receipt recovers once on an open shift, never repeats acquiring',async t=>{
 const f=fixture(t),next=randomUUID();f.a.db.prepare("UPDATE aqsi_pilot SET state='review',slip=?,receipt_op=? WHERE id=?").run(JSON.stringify({id:'paid-slip',content:{amount:100}}),f.op,f.id);
 const rejection=op=>({operationId:op,deviceId,type:'receipt.process',status:'Error',problems:'ShiftMustBeOpened',result:null});
 f.shift.shiftClosedReport={};f.answers.push(rejection(f.op));await f.p.tick();assert.equal(posts(f).length,0);
 f.shift.shiftClosedReport=null;f.answers.push(rejection(f.op),{operationId:next});await f.p.tick();assert.equal(posts(f).length,1);assert.ok(posts(f)[0].url.endsWith('/Receipts/process'));assert.equal(f.p.row(f.id).state,'receipt_waiting');
 f.answers.push(rejection(next));await f.p.tick();assert.equal(posts(f).length,1);assert.equal(f.p.row(f.id).state,'review');
 const restarted=new AqsiPilot(f.a,f.conn);f.answers.push(rejection(next));await restarted.tick();assert.equal(posts(f).length,1);
 assert.equal(f.a.db.prepare('SELECT count(*) n FROM aqsi_receipt_shift_retries').get().n,1);
});
for(const changed of ['timeout','generic-error','nonempty-result','wrong-operation'])test('Ambiguous fiscal result cannot retry: '+changed,async t=>{
 const f=fixture(t);f.a.db.prepare("UPDATE aqsi_pilot SET state='review',slip=?,receipt_op=? WHERE id=?").run('{"id":"paid-slip"}',f.op,f.id);
 const op={operationId:f.op,deviceId,type:'receipt.process',status:'Error',problems:'ShiftMustBeOpened',result:null};if(changed==='timeout')op.status='Timeout';if(changed==='generic-error')op.problems='Other';if(changed==='nonempty-result')op.result='{}';if(changed==='wrong-operation')op.operationId=randomUUID();f.answers.push(op);await f.p.tick();assert.equal(posts(f).length,0);assert.equal(f.p.row(f.id).state,'review');
});
