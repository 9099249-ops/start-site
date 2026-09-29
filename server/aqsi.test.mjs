import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {AqsiConnection,aqsiHandler} from './aqsi.mjs';
const admin={role:'admin'},staff={role:'staff'};
test('aQsi setup: credentials remain server-only, revision conflicts and exact read-only request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aqsi-')),file=join(dir,'connection.json'),calls=[];
 try{
  const c=new AqsiConnection(file,{request:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({id:709740,model:'CS50',serialNumber:'test',unexpectedSecret:'do-not-expose'})};}});
  assert.throws(()=>c.info(staff),e=>e.status===403);assert.throws(()=>c.save({},null),e=>e.status===401);
  assert.equal(c.info(admin).configured,false);
  const key='fixture-api-key';const saved=c.save({revision:0,deviceId:709740,apiKey:key},admin);
  assert.equal(saved.configured,true);assert.ok(!JSON.stringify(saved).includes(key));assert.equal(saved.paymentsEnabled,false);
  assert.throws(()=>c.save({revision:0,deviceId:709740},admin),e=>e.status===409);
  c.save({revision:1,deviceId:709740,apiKey:''},admin);assert.equal(JSON.parse(readFileSync(file)).apiKey,key);
  const [result]=await Promise.all([c.check(admin),c.check(admin)]);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.aqsi.ru/pub/v4/Devices/709740');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers['x-client-key'],'Application '+key);assert.ok(!JSON.stringify(result).includes('do-not-expose'));
  assert.throws(()=>c.save({revision:2,deviceId:709740,apiKey:'bad\r\nkey'},admin));
  c.request=async()=>{throw Error(key);};await assert.rejects(c.check(admin),e=>e.status===502&&!e.message.includes(key));
  c.request=async()=>({ok:false,status:403,json:async()=>({secret:key})});await assert.rejects(c.check(admin),/отклонил/);
  c.request=async()=>({ok:true,status:200,json:async()=>({id:1})});await assert.rejects(c.check(admin),/другую кассу/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('aQsi HTTP requires admin and same-origin JSON; does not expose payment commands',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aqsi-http-'));let calls=0;
 const store=new AqsiConnection(join(dir,'config.json'),{request:async()=>{calls++;throw Error('unexpected');}}),origin='https://spotsup.ru';
 const handler=aqsiHandler(store,{user:token=>token==='admin'?admin:token==='staff'?staff:null},origin);
 const server=http.createServer(async(req,res)=>{await handler(req,res,new URL(req.url,origin));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port+'/api/admin/aqsi/';
 try{
  assert.equal((await fetch(url+'settings')).status,401);
  assert.equal((await fetch(url+'settings',{headers:{Cookie:'__Host-start_session=staff'}})).status,403);
  const headers={Cookie:'__Host-start_session=admin','Content-Type':'application/json'};
  assert.equal((await fetch(url+'settings',{method:'POST',headers,body:'{}'})).status,403);
  headers.Origin=origin;
  assert.equal((await fetch(url+'purchase',{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(url+'settings',{method:'POST',headers,body:'x'.repeat(4097)})).status,413);
  assert.equal((await fetch(url+'settings',{method:'POST',headers,body:'[]'})).status,400);
  assert.equal(calls,0);
 }finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
