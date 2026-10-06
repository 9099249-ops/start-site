import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {AdminStore,adminHandler} from './admin.mjs';
const owner={id:1,role:'admin'},staff={id:2,role:'staff'};
async function fixture(t){
 const store=new AdminStore(':memory:');
 store.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");
 for(const [id,token] of [[1,'owner'],[2,'staff'],[3,'waiter']])store.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+60000);
 const origin='http://localhost',handler=adminHandler(store,origin);
 const server=http.createServer((req,res)=>handler(req,res,new URL(req.url,origin)));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
 const base='http://127.0.0.1:'+server.address().port+'/api/admin/tasks/badge';
 const get=(token='owner',options={})=>fetch(base,{headers:{Cookie:'__Host-start_session='+token,Origin:origin,'Content-Type':'application/json'},...options});
 const count=async()=>{const response=await get();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');return response.json();};
 const add=(kind='task')=>store.tasks.create({requestId:randomUUID(),text:'PRIVATE_TASK',kind},owner);
 return {store,get,count,add};
}

test('Task badge counts only unarchived incomplete one-off tasks across days without exposing task data',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.count(),{count:0});
 f.add();f.add();const old=f.add(),done=f.add(),archived=f.add();
 f.store.db.prepare('UPDATE station_tasks SET created_at=? WHERE id=?').run(Date.now()-10*86400000,old);
 f.store.tasks.complete({id:done,revision:0,done:true},staff);
 f.store.tasks.edit({id:archived,revision:0,action:'archive'},owner);
 for(const kind of ['opening','during','closing'])f.add(kind);
 const before=f.store.db.prepare('SELECT total_changes() n').get().n;
 const result=await f.count();assert.deepEqual(result,{count:3});assert.doesNotMatch(JSON.stringify(result),/PRIVATE|text|name|created|completed_by/);
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before);
});

test('Task completion, reopening and archive update the badge; retries never change counts twice',async t=>{
 const f=await fixture(t),body={requestId:randomUUID(),text:'PRIVATE_TASK'};
 const id=f.store.tasks.create(body,owner);assert.equal(f.store.tasks.create(body,owner),id);assert.deepEqual(await f.count(),{count:1});
 f.store.tasks.complete({id,revision:0,done:true},staff);assert.deepEqual(await f.count(),{count:0});
 f.store.tasks.complete({id,revision:1,done:true},staff);assert.deepEqual(await f.count(),{count:0});
 f.store.tasks.complete({id,revision:1,done:false},staff);assert.deepEqual(await f.count(),{count:1});
 f.store.tasks.edit({id,revision:0,action:'text',text:'PRIVATE_CHANGED'},owner);assert.deepEqual(await f.count(),{count:1});
 f.store.tasks.edit({id,revision:1,action:'archive'},owner);assert.deepEqual(await f.count(),{count:0});
});

test('Task badge keeps existing staff authorization, schedule-only restrictions and read-only behavior',async t=>{
 const f=await fixture(t);f.add();
 assert.equal((await f.get('unknown')).status,401);
 for(const token of ['owner','staff','waiter'])assert.equal((await f.get(token)).status,200);
 f.store.db.exec('UPDATE schedule_access_policy SET enabled=1');
 assert.equal((await f.get('staff')).status,401);assert.equal((await f.get('waiter')).status,401);
 f.store.db.exec('UPDATE schedule_access_policy SET enabled=0');
 for(const method of ['POST','PUT','DELETE'])assert.equal((await f.get('owner',{method,body:'{}'})).status,405);
 assert.deepEqual(await f.count(),{count:1});
});
