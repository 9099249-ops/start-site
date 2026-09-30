import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AdminStore,adminHandler} from './admin.mjs';
import {taskDay} from './tasks.mjs';
const admin={id:1,role:'admin'},staff={id:2,role:'staff'},waiter={id:3,role:'waiter'};
test('Checklists: daily marks reset without losing previous completion; stale day is rejected',t=>{const a=fixture(t),id=a.tasks.create({requestId:randomUUID(),text:'Проверить оборудование',kind:'opening'},admin);a.tasks.complete({id,revision:0,done:true,day:taskDay()},staff);assert.ok(a.tasks.list(admin).find(t=>t.id===id).completed_at);const tomorrow=new Date(Date.now()+10800000+86400000).toISOString().slice(0,10);assert.equal(a.tasks.list(admin,tomorrow).find(t=>t.id===id).completed_at,null);assert.throws(()=>a.tasks.complete({id,revision:0,done:true,day:tomorrow},staff),e=>e.status===409);assert.equal(a.db.prepare('SELECT count(*) n FROM station_task_checks').get().n,1);});
function fixture(t,file=':memory:'){const a=new AdminStore(file);if(!a.configured())a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");t.after(()=>a.close());return a;}
test('Tasks: owner creates once; employees cannot create; content validates',t=>{const a=fixture(t),b={requestId:randomUUID(),text:'Помыть катамараны'};assert.throws(()=>a.tasks.create(b,staff),e=>e.status===403);assert.throws(()=>a.tasks.create(b,waiter),e=>e.status===403);const id=a.tasks.create(b,admin);assert.equal(a.tasks.create(b,admin),id);assert.equal(a.tasks.list(waiter).length,1);assert.throws(()=>a.tasks.create({...b,text:'Другое'},admin),e=>e.status===409);for(const text of ['', ' ', 'а'.repeat(501)])assert.throws(()=>a.tasks.create({requestId:randomUUID(),text},admin));});
test('Tasks: completion identity, concurrent conflict, reopening and audit retained',t=>{const a=fixture(t),id=a.tasks.create({requestId:randomUUID(),text:'Помыть сапы'},admin,100);a.tasks.complete({id,revision:0,done:true},staff,200);const row=a.tasks.list(admin)[0];assert.equal(row.completed_by,2);assert.equal(row.completed_at,200);assert.equal(row.completed_name,'station');assert.throws(()=>a.tasks.complete({id,revision:0,done:true},waiter,201),e=>e.status===409);a.tasks.complete({id,revision:1,done:false},waiter,300);assert.equal(a.tasks.list(admin)[0].completed_at,null);assert.equal(a.db.prepare('SELECT count(*) n FROM station_task_events').get().n,3);});
test('Tasks: migration and completed tasks survive database reopen without changing payments',t=>{const dir=mkdtempSync(join(tmpdir(),'start-tasks-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'db');let a=new AdminStore(file);a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");const id=a.tasks.create({requestId:randomUUID(),text:'Поменять масло в фритюрнице'},admin);a.tasks.complete({id,revision:0,done:true},staff);const before=a.tasks.list(admin);a.close();a=new AdminStore(file);assert.deepEqual(a.tasks.list(admin),before);assert.equal(a.db.prepare('SELECT count(*) n FROM payments').get().n,0);a.close();});
test('Tasks HTTP: auth, CSRF, admin-only creation and waiter completion',async t=>{const a=fixture(t),origin='http://localhost';for(const u of [admin,staff,waiter])a.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update('test-'+u.id).digest('hex'),u.id,Date.now()+60000);const handler=adminHandler(a,origin),server=http.createServer((req,res)=>handler(req,res,new URL(req.url,origin)));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port+'/api/admin/tasks',h=id=>({Cookie:'__Host-start_session=test-'+id,Origin:origin,'Content-Type':'application/json'}),post=(path,body,headers)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)}),body={requestId:randomUUID(),text:'Общее дело'};assert.equal((await fetch(base)).status,401);assert.equal((await post('/create',body,h(2))).status,403);assert.equal((await post('/create',body,{...h(1),Origin:'http://wrong'})).status,403);const created=await post('/create',body,h(1));assert.equal(created.status,200);const {id}=await created.json();assert.equal((await fetch(base,{headers:h(3)})).status,200);assert.equal((await post('/complete',{id,revision:0,done:true},h(3))).status,200);assert.equal(a.tasks.list(admin)[0].completed_by,3);});

test('During checklist: Moscow two-hour boundaries, stale requests and other lists',t=>{
 const a=fixture(t),at=Date.parse('2026-09-30T06:59:59.999Z'),boundary=at+1;
 const ids=Object.fromEntries(['during','opening','closing','task'].map(kind=>[kind,a.tasks.create({requestId:randomUUID(),text:kind,kind},admin,at)]));
 const list=now=>a.tasks.list(staff,taskDay(now),now);
 for(const row of list(at))a.tasks.complete({id:row.id,revision:row.revision,done:true,day:row.day,period:row.period},staff,at);
 const old=list(at).find(x=>x.id===ids.during);
 assert.equal(old.period,'2026-09-30@08');assert.equal(old.nextResetAt,boundary);assert.equal(old.completed_by,staff.id);
 const fresh=list(boundary).find(x=>x.id===ids.during);
 assert.equal(fresh.completed_at,null);assert.equal(fresh.revision,0);assert.equal(fresh.period,'2026-09-30@10');
 for(const kind of ['opening','closing','task'])assert.equal(list(boundary).find(x=>x.id===ids[kind]).completed_by,staff.id);
 assert.throws(()=>a.tasks.complete({...old,done:false},waiter,boundary),e=>e.status===409);
 assert.throws(()=>a.tasks.complete({id:fresh.id,revision:0,done:true,day:fresh.day},waiter,boundary),e=>e.status===409);
 a.tasks.complete({...fresh,done:true},waiter,boundary);
 assert.throws(()=>a.tasks.complete({...fresh,done:true},staff,boundary+1),e=>e.status===409);
 assert.equal(list(boundary+7199999).find(x=>x.id===ids.during).completed_by,waiter.id);
 assert.equal(list(boundary+7200000).find(x=>x.id===ids.during).completed_at,null);
 assert.equal(list(at).find(x=>x.id===ids.during).completed_by,staff.id);
 const midnight=Date.parse('2026-09-30T21:00:00Z');
 assert.equal(list(midnight).find(x=>x.id===ids.during).period,'2026-10-01@00');
 assert.equal(list(midnight).find(x=>x.id===ids.during).nextResetAt,midnight+7200000);
});
