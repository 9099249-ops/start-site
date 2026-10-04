import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {AqsiPilot} from './aqsi-pilot.mjs';
const u={id:1,role:'admin'},paymentId=randomUUID(),receiptId=randomUUID();
function fixture(){const admin=new AdminStore(':memory:');admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");const calls=[],answers=[];const connection={read:()=>({apiKey:'test-secret',deviceId:709740}),request:async(url,options)=>{if(url.includes('/v4/Shifts'))return {ok:true,json:async()=>url.includes('/v4/Shifts?')?{rows:[{id:'test-shift',device:{id:709740}}]}:{id:'test-shift',device:{id:709740},shiftOpenedReport:{dateTime:new Date().toISOString()},shiftClosedReport:null}};calls.push({url,options});const result=answers.shift();if(result instanceof Error)throw result;return {ok:true,json:async()=>result};}};return {admin,calls,answers,pilot:new AqsiPilot(admin,connection),connection};}
const begin=()=>({requestId:randomUUID(),confirmAmountCents:100});
test('aQsi pilot sends one payment, then one receipt; repeat click and restart never double debit',async()=>{
 const f=fixture();try{const b=begin();f.answers.push({operationId:paymentId});const [r]=await Promise.all([f.pilot.begin(b,u),f.pilot.begin(b,u)]);assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0].options.body).amount,100);
 const result={id:'slip',device:{id:709740},content:{amount:100,type:'purchase',responseCode:'00',dateTime:'2026-09-28T16:00:00+03:00',sequenceNumber:'1'}};
 f.answers.push({operationId:paymentId,deviceId:709740,type:'acquiring.purchase',status:'Completed',result:JSON.stringify(result)},{operationId:receiptId});await f.pilot.tick();
 assert.equal(f.calls.filter(c=>c.options.method==='POST').length,2);const receipt=JSON.parse(f.calls[2].options.body);assert.equal(receipt.payments[0].slip.id,'slip');assert.equal(receipt.payments[0].amount,100);assert.equal(receipt.positions[0].info.name,'Лимонад');assert.equal(receipt.info.taxSystemCode,2);assert.equal(receipt.info.additionalAttribute.length,16);assert.match(receipt.info.additionalAttribute,/^START [a-f0-9]{10}$/);assert.equal(receipt.positions[0].info.taxRateId,6);
 f.answers.push({operationId:receiptId,deviceId:709740,type:'receipt.process',status:'Completed',result:JSON.stringify({id:'fiscal',device:{id:709740},isNonFiscal:false,info:{sum:100,typeId:1,docInfo:{docNumber:123}}})});await f.pilot.tick();assert.equal(f.pilot.row(r.id).state,'done');
 const restarted=new AqsiPilot(f.admin,f.connection);await restarted.tick();assert.equal(f.calls.length,4);await assert.rejects(restarted.begin(begin(),u),e=>e.status===409);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM payments').get().n,0);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM rentals').get().n,0);
 }finally{f.admin.close();}
});
test('aQsi pilot lost POST response remains blocked across restart without any automatic retry',async()=>{
 const f=fixture();try{f.answers.push(Error('network'));const r=await f.pilot.begin(begin(),u);assert.equal(r.state,'payment_unknown');const p=new AqsiPilot(f.admin,f.connection);await p.tick();assert.equal(f.calls.length,1);await assert.rejects(p.begin(begin(),u),e=>e.status===409);assert.equal(f.calls.length,1);}finally{f.admin.close();}
});
test('aQsi pilot ambiguous payment never creates receipt; only admin can start fixed 1-ruble test',async()=>{
 const f=fixture();try{await assert.rejects(f.pilot.begin(begin(),{role:'staff'}),e=>e.status===403);await assert.rejects(f.pilot.begin({...begin(),confirmAmountCents:200},u));assert.equal(f.calls.length,0);
 f.answers.push({operationId:paymentId});const r=await f.pilot.begin(begin(),u);f.answers.push({operationId:paymentId,deviceId:709740,type:'acquiring.purchase',status:'Error'});await f.pilot.tick();assert.equal(f.pilot.row(r.id).state,'review');assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
 }finally{f.admin.close();}
});
test('aQsi pilot restart during receipt submission cannot resend fiscal document',async()=>{
 const f=fixture();try{f.answers.push({operationId:paymentId});const r=await f.pilot.begin(begin(),u);f.pilot.set(r.id,'receipt_sending');const p=new AqsiPilot(f.admin,f.connection);assert.equal(p.row(r.id).state,'receipt_unknown');await p.tick();assert.equal(f.calls.length,1);}finally{f.admin.close();}
});
