import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {AqsiPilot} from './aqsi-pilot.mjs';

const user={id:1,role:'admin'},deviceId=709740;
const request=()=>({requestId:randomUUID(),confirmAmountCents:100});
const response=(body,status=200)=>({
  ok:status>=200&&status<300,status,
  headers:new Headers({'content-type':'application/json'}),
  json:async()=>body,text:async()=>JSON.stringify(body)
});
function fixture(){
  const admin=new AdminStore(':memory:');
  admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
  const calls=[],answers=[];
  const connection={read:()=>({apiKey:'never-expose-api-key',deviceId}),request:async(url,options)=>{if(url.includes('/v4/Shifts'))return {ok:true,json:async()=>url.includes('/v4/Shifts?')?{rows:[{id:'test-shift',device:{id:709740}}]}:{id:'test-shift',device:{id:709740},shiftOpenedReport:{dateTime:new Date().toISOString()},shiftClosedReport:null}};
    calls.push({url,options});
    assert.ok(answers.length,'Unexpected aQsi request; no fallback network access is allowed');
    const next=answers.shift();if(next instanceof Error)throw next;return next;
  }};
  return {admin,calls,answers,connection,pilot:new AqsiPilot(admin,connection)};
}
function diagnostic(view,phase='payment'){
  assert.ok(view.diagnostic,'Payment view should expose a safe explanation');
  assert.equal(view.diagnostic.phase,phase);
  assert.ok(typeof view.diagnostic.message==='string'&&view.diagnostic.message.length>0);
  assert.ok(view.diagnostic.checkedAt,'A diagnostic must show when it was checked');
  return view.diagnostic;
}
const posts=f=>f.calls.filter(c=>c.options.method==='POST');

test('aQsi HTTP rejection remains identifiable and cannot cause a repeated purchase after a tick or restart',async()=>{
  const f=fixture();try{
    f.answers.push(response({message:'The provider refused the operation'},400));
    const payload=request(),view=await f.pilot.begin(payload,user),d=diagnostic(view);
    assert.equal(d.httpStatus,400);assert.equal(view.state,'payment_unknown');
    await f.pilot.tick();
    const restarted=new AqsiPilot(f.admin,f.connection);await restarted.tick();
    const same=await restarted.begin(payload,user);
    assert.equal(same.id,view.id);assert.equal(diagnostic(same).httpStatus,400);
    assert.equal(posts(f).length,1);assert.equal(f.calls.length,1);
  }finally{f.admin.close();}
});

test('aQsi local request timeout is distinguished from a connection error without automatic retry',async()=>{
  const messages=[];
  for(const error of [Object.assign(Error('never-expose-api-key'),{name:'TimeoutError'}),Error('never-expose-api-key')]){
    const f=fixture();try{
      f.answers.push(error);const view=await f.pilot.begin(request(),user),d=diagnostic(view);
      messages.push(d.message);assert.equal(view.state,'payment_unknown');
      assert.equal(d.httpStatus,undefined);assert.doesNotMatch(JSON.stringify(view),/never-expose-api-key/);
      await f.pilot.tick();assert.equal(posts(f).length,1);
    }finally{f.admin.close();}
  }
  assert.notEqual(messages[0],messages[1],'Local timeout and network failure need different explanations');
});

test('aQsi remote Timeout remains a queryable unknown payment; polling never sends another financial request',async()=>{
  const f=fixture();try{
    const operationId=randomUUID();f.answers.push(response({operationId}));
    const view=await f.pilot.begin(request(),user);
    const timeout={operationId,deviceId,type:'acquiring.purchase',status:'Timeout',result:null};
    f.answers.push(response(timeout));await f.pilot.tick();
    let latest=f.pilot.view(f.pilot.row(view.id));
    assert.equal(latest.state,'review');assert.equal(diagnostic(latest).operationStatus,'Timeout');
    for(let i=0;i<3;i++){f.answers.push(response(timeout));await f.pilot.tick();}
    latest=f.pilot.view(f.pilot.row(view.id));
    assert.equal(diagnostic(latest).operationStatus,'Timeout');
    assert.equal(latest.paymentOperationId,operationId);assert.equal(posts(f).length,1);
    assert.equal(f.calls.slice(1).every(c=>c.options.method==='GET'&&c.url.endsWith('/'+operationId)),true);
  }finally{f.admin.close();}
});

test('aQsi diagnostics do not expose raw provider messages, secrets, customer fields or authorization headers',async()=>{
  const f=fixture();try{
    f.answers.push(response({
      message:'API key never-expose-api-key; guest-private@example.test; 79031234567',
      error:'<script>alert("provider-html")</script>',
      customer:{name:'UNIQUE_PRIVATE_GUEST',email:'guest-private@example.test'},
      headers:{'x-client-key':'Application never-expose-api-key'},
      cardNumber:'1234567890123456'
    },503));
    const view=await f.pilot.begin(request(),user);assert.equal(diagnostic(view).httpStatus,503);
    const serialized=JSON.stringify(view);
    for(const forbidden of ['never-expose-api-key','guest-private@example.test','79031234567','UNIQUE_PRIVATE_GUEST','1234567890123456','provider-html','x-client-key'])assert.equal(serialized.includes(forbidden),false);
  }finally{f.admin.close();}
});

test('aQsi lost fiscal response reports the receipt phase and never repeats a fiscal POST',async()=>{
  const f=fixture();try{
    const operationId=randomUUID();f.answers.push(response({operationId}));
    const view=await f.pilot.begin(request(),user);
    const slip={id:'test-slip',device:{id:deviceId},content:{type:'purchase',amount:100,responseCode:'00',dateTime:'2026-09-29T12:00:00+03:00',sequenceNumber:'2'}};
    f.answers.push(response({operationId,deviceId,type:'acquiring.purchase',status:'Completed',result:JSON.stringify(slip)}),Object.assign(Error('response disappeared'),{name:'TimeoutError'}));
    await f.pilot.tick();const latest=f.pilot.view(f.pilot.row(view.id));
    assert.equal(latest.state,'receipt_unknown');diagnostic(latest,'receipt');
    const restarted=new AqsiPilot(f.admin,f.connection);await restarted.tick();
    assert.equal(posts(f).length,2);assert.equal(f.calls.length,3);
  }finally{f.admin.close();}
});

test('aQsi receipt review can recover by reading the original operation without charging or fiscalizing twice',async()=>{
  const f=fixture();try{
    const paymentId=randomUUID(),receiptId=randomUUID();f.answers.push(response({operationId:paymentId}));
    const view=await f.pilot.begin(request(),user);
    const slip={id:'test-slip',device:{id:deviceId},content:{type:'purchase',amount:100,responseCode:'00',dateTime:'2026-09-29T12:00:00+03:00',sequenceNumber:'3'}};
    f.answers.push(response({operationId:paymentId,deviceId,type:'acquiring.purchase',status:'Completed',result:JSON.stringify(slip)}),response({operationId:receiptId}));
    await f.pilot.tick();
    f.answers.push(response({operationId:receiptId,deviceId,type:'receipt.process',status:'Timeout',result:null}));
    await f.pilot.tick();assert.equal(f.pilot.row(view.id).state,'review');
    assert.equal(diagnostic(f.pilot.view(f.pilot.row(view.id)),'receipt').operationStatus,'Timeout');
    const receipt={id:'fiscal-test',device:{id:deviceId},isNonFiscal:false,info:{sum:100,typeId:1,docInfo:{docNumber:123}}};
    f.answers.push(response({operationId:receiptId,deviceId,type:'receipt.process',status:'Completed',result:JSON.stringify(receipt)}));
    await f.pilot.tick();
    assert.equal(f.pilot.row(view.id).state,'done');assert.equal(posts(f).length,2);
    assert.equal(f.calls.at(-1).options.method,'GET');assert.ok(f.calls.at(-1).url.endsWith('/'+receiptId));
  }finally{f.admin.close();}
});

test('aQsi diagnostic storage failure cannot lose a successful purchase operation reference',async t=>{
  const f=fixture();try{
    const errors=t.mock.method(console,'error',()=>{});
    f.pilot.diagnostics.record=()=>{throw Error('journal storage failed');};
    const operationId=randomUUID();f.answers.push(response({operationId}));
    const view=await f.pilot.begin(request(),user);
    assert.equal(view.state,'payment_waiting');assert.equal(view.paymentOperationId,operationId);
    assert.equal(f.pilot.row(view.id).payment_op,operationId);assert.equal(posts(f).length,1);
    assert.equal(errors.mock.callCount(),1);
    assert.doesNotMatch(JSON.stringify(errors.mock.calls[0].arguments),/never-expose-api-key/);
  }finally{f.admin.close();}
});

test('aQsi in-flight payment polling cannot overwrite a manual reconciliation or start fiscalization',async()=>{
  for(const manualState of ['cancelled','cash_done']){
    const f=fixture();try{
      const operationId=randomUUID();f.answers.push(response({operationId}));
      const view=await f.pilot.begin(request(),user);
      let finish;
      f.connection.request=async(url,options)=>{
        f.calls.push({url,options});assert.equal(options.method,'GET');
        return new Promise(resolve=>{finish=resolve;});
      };
      const running=f.pilot.tick();assert.equal(typeof finish,'function');
      f.pilot.set(view.id,manualState);
      const slip={id:'test-slip',device:{id:deviceId},content:{type:'purchase',amount:100,responseCode:'00',dateTime:'2026-09-29T12:00:00+03:00',sequenceNumber:'4'}};
      finish(response({operationId,deviceId,type:'acquiring.purchase',status:'Completed',result:JSON.stringify(slip)}));
      await running;
      assert.equal(f.pilot.row(view.id).state,manualState);assert.equal(f.pilot.row(view.id).slip,null);
      assert.equal(posts(f).length,1);assert.equal(f.calls.length,2);
    }finally{f.admin.close();}
  }
});

test('aQsi identical Timeout polls are deduplicated and only refresh the last seen time once a minute',async t=>{
  const f=fixture();try{
    let at=Date.now();t.mock.method(Date,'now',()=>at);
    const operationId=randomUUID();f.answers.push(response({operationId}));
    const view=await f.pilot.begin(request(),user);
    const timeout={operationId,deviceId,type:'acquiring.purchase',status:'Timeout',result:null};
    f.answers.push(response(timeout));await f.pilot.tick();
    const count=()=>f.admin.db.prepare('SELECT count(*) n FROM aqsi_diagnostic_events WHERE scope=? AND payment_id=?').get('aqsi_pilot',view.id).n;
    const before=count(),firstSeen=diagnostic(f.pilot.view(f.pilot.row(view.id))).checkedAt;
    for(let i=0;i<10;i++){at+=5000;f.answers.push(response(timeout));await f.pilot.tick();}
    assert.equal(count(),before);assert.equal(diagnostic(f.pilot.view(f.pilot.row(view.id))).checkedAt,firstSeen);
    at+=15000;f.answers.push(response(timeout));await f.pilot.tick();
    assert.equal(count(),before);assert.equal(diagnostic(f.pilot.view(f.pilot.row(view.id))).checkedAt,at);
    assert.equal(posts(f).length,1);
  }finally{f.admin.close();}
});

test('aQsi persisted diagnostic fields redact the API key, email and phone and omit raw nested data',async()=>{
  const f=fixture();try{
    f.answers.push(response({
      reason:'Authorization Application never-expose-api-key',
      message:'guest-private@example.test called +7 (903) 123-45-67 with key never-expose-api-key',
      request:{customer:'UNIQUE_RAW_REQUEST',body:'NEVER_STORE_REQUEST_BODY'},
      result:JSON.stringify({id:'UNIQUE_RAW_SLIP',content:{cardNumber:'1234567890123456',authCode:'UNIQUE_AUTH_CODE'}})
    },400));
    const view=await f.pilot.begin(request(),user);
    const saved=JSON.stringify(f.admin.db.prepare('SELECT event_json FROM aqsi_diagnostic_events WHERE scope=? AND payment_id=?').all('aqsi_pilot',view.id));
    for(const value of ['never-expose-api-key','guest-private@example.test','903','123-45-67','UNIQUE_RAW_REQUEST','NEVER_STORE_REQUEST_BODY','UNIQUE_RAW_SLIP','1234567890123456','UNIQUE_AUTH_CODE'])assert.equal(saved.includes(value),false,value+' leaked into the diagnostic journal');
    assert.match(saved,/скрыто/);assert.match(saved,/почта/);assert.match(saved,/номер/);
    assert.equal(diagnostic(view).httpStatus,400);
  }finally{f.admin.close();}
});

test('aQsi successful payment diagnostics never persist the bank slip or receipt request body',async()=>{
  const f=fixture();try{
    const operationId=randomUUID(),receiptId=randomUUID();f.answers.push(response({operationId}));
    const view=await f.pilot.begin(request(),user);
    const slip={id:'UNIQUE_RAW_SLIP',device:{id:deviceId},content:{type:'purchase',amount:100,responseCode:'00',dateTime:'2026-09-29T12:00:00+03:00',sequenceNumber:'5',authCode:'UNIQUE_AUTH_CODE',retrievalReferenceNumber:'UNIQUE_BANK_REFERENCE',cardNumber:'1234567890123456'}};
    f.answers.push(response({operationId,deviceId,type:'acquiring.purchase',status:'Completed',result:JSON.stringify(slip)}),response({operationId:receiptId}));
    await f.pilot.tick();assert.equal(f.pilot.row(view.id).state,'receipt_waiting');
    const saved=JSON.stringify(f.admin.db.prepare('SELECT event_json FROM aqsi_diagnostic_events WHERE scope=? AND payment_id=?').all('aqsi_pilot',view.id));
    for(const value of ['UNIQUE_RAW_SLIP','UNIQUE_AUTH_CODE','UNIQUE_BANK_REFERENCE','1234567890123456','Лимонад','x-client-key','never-expose-api-key'])assert.equal(saved.includes(value),false,value+' leaked into the diagnostic journal');
    assert.equal(posts(f).length,2);
  }finally{f.admin.close();}
});
