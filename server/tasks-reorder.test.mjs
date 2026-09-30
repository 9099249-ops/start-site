import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import http from 'node:http';
import {AdminStore,adminHandler} from './admin.mjs';
import {taskDay} from './tasks.mjs';

const admin={id:1,role:'admin'},staff={id:2,role:'staff'},waiter={id:3,role:'waiter'};
function fixture(t){
 const store=new AdminStore(':memory:');
 store.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");
 t.after(()=>store.close());return store;
}
const create=(store,kind='task',text='Дело')=>store.tasks.create({kind,text,requestId:randomUUID()},admin);
const rows=(store,kind)=>store.tasks.list(admin).filter(x=>x.kind===kind);
const order=(store,kind='task')=>({action:'reorder',kind,items:rows(store,kind).map(({id,edit_revision})=>({id,edit_revision}))});
const rawRows=store=>store.db.prepare('SELECT * FROM station_tasks ORDER BY id').all().map(row=>({...row}));
const editCount=store=>store.db.prepare('SELECT count(*) n FROM station_task_edits').get().n;

for(const kind of ['task','opening','during','closing'])test(`Task reorder: ${kind} saves the whole order and preserves completion, other sections and audit`,t=>{
 const store=fixture(t);
 const ids=[create(store,kind,'Первое'),create(store,kind,'Второе'),create(store,kind,'Третье')];
 create(store,kind==='task'?'opening':'task','Другой раздел');
 const archived=create(store,kind,'Архив');
 store.tasks.edit({id:archived,revision:0,action:'archive'},admin,100);
 const request=order(store,kind);request.items.reverse();
 // Completion has its own revision and must not invalidate a pending drag.
 store.tasks.complete({id:ids[0],revision:0,done:true,...(kind==='task'?{}:{day:taskDay(),...(kind==='during'?{period:rows(store,kind)[0].period}:{})})},waiter);
 const before=rawRows(store),checks=store.db.prepare('SELECT * FROM station_task_checks').all(),events=store.db.prepare('SELECT * FROM station_task_events').all(),auditsBefore=editCount(store);
 assert.deepEqual(store.tasks.edit(request,admin,300),{ok:true});
 assert.deepEqual(rows(store,kind).map(x=>x.id),request.items.map(x=>x.id));
 const after=rawRows(store);
 for(const prior of before){
  const next=after.find(x=>x.id===prior.id),position=request.items.findIndex(x=>x.id===prior.id);
  assert.deepEqual(next,position<0?prior:{...prior,sort_order:position,edit_revision:prior.edit_revision+1});
 }
 assert.deepEqual(store.db.prepare('SELECT * FROM station_task_checks').all(),checks);
 assert.deepEqual(store.db.prepare('SELECT * FROM station_task_events').all(),events);
 assert.equal(rows(store,kind).find(x=>x.id===ids[0]).completed_by,waiter.id);
 const audits=store.db.prepare('SELECT * FROM station_task_edits WHERE created=300 ORDER BY id').all();
 assert.equal(editCount(store),auditsBefore+3);
 for(const entry of audits){
  assert.equal(entry.actor,admin.id);
  assert.deepEqual(JSON.parse(entry.before_json),{...before.find(x=>x.id===entry.task_id)});
  assert.deepEqual(JSON.parse(entry.after_json),{...after.find(x=>x.id===entry.task_id)});
 }
 assert.throws(()=>store.tasks.edit(request,admin),e=>e.status===409);
 // A completion sent before the drag still has a valid completion revision.
 store.tasks.complete({id:ids[1],revision:0,done:true,...(kind==='task'?{}:{day:taskDay(),...(kind==='during'?{period:rows(store,kind)[0].period}:{})})},staff);
 assert.equal(rows(store,kind).find(x=>x.id===ids[1]).completed_by,staff.id);
});

test('Task reorder: changed membership, text or prior order rejects the entire stale snapshot',t=>{
 for(const concurrentChange of ['create','archive','text','reorder','up']){
  const store=fixture(t);create(store);create(store);create(store);
  const request=order(store);request.items.reverse();
  const item=request.items[1];
  if(concurrentChange==='create')create(store);
  else if(concurrentChange==='reorder')store.tasks.edit({...request,items:[request.items[1],request.items[0],request.items[2]]},admin);
  else if(concurrentChange==='up')store.tasks.edit({action:'up',id:item.id,revision:item.edit_revision},admin);
  else store.tasks.edit({action:concurrentChange,id:item.id,revision:item.edit_revision,text:'Новое название'},admin);
  const before=rawRows(store),count=editCount(store);
  assert.throws(()=>store.tasks.edit(request,admin),e=>e.status===409,concurrentChange);
  assert.deepEqual(rawRows(store),before,concurrentChange);
  assert.equal(editCount(store),count,concurrentChange);
 }
});

test('Task reorder: full membership and valid unique revision snapshots are required',t=>{
 const store=fixture(t);create(store);create(store);const other=create(store,'opening');
 const valid=order(store),before=rawRows(store);
 const invalid=[
  [{...valid,kind:'missing'},400],
  [{...valid,items:null},400],
  [{...valid,items:[null]},400],
  [{...valid,items:[valid.items[0],valid.items[0]]},400],
  [{...valid,items:[{...valid.items[0],id:String(valid.items[0].id)},valid.items[1]]},400],
  [{...valid,items:[{...valid.items[0],edit_revision:-1},valid.items[1]]},400],
  [{...valid,items:[{id:valid.items[0].id},valid.items[1]]},400],
  [{...valid,items:valid.items.slice(1)},409],
  [{...valid,items:[{id:999999,edit_revision:0},valid.items[1]]},409],
  [{...valid,items:[{id:other,edit_revision:0},valid.items[1]]},409],
  [{...valid,items:[{...valid.items[0],edit_revision:1},valid.items[1]]},409]
 ];
 for(const [request,status] of invalid){
  assert.throws(()=>store.tasks.edit(request,admin),e=>e.status===status);
  assert.deepEqual(rawRows(store),before);assert.equal(editCount(store),0);
 }
});

test('Task reorder: no-op orders do not write revisions or audit and require admin',t=>{
 const store=fixture(t);create(store);create(store);
 const request=order(store),before=rawRows(store);
 for(const user of [null,staff,waiter])assert.throws(()=>store.tasks.edit(request,user),e=>e.status===403);
 assert.deepEqual(store.tasks.edit(request,admin),{ok:true});
 assert.deepEqual(store.tasks.edit(order(store,'closing'),admin),{ok:true});
 assert.deepEqual(rawRows(store),before);assert.equal(editCount(store),0);
});

test('Task reorder: an audit failure rolls back all positions, revisions and earlier audit entries',t=>{
 const store=fixture(t);create(store);create(store);create(store);
 const request=order(store);request.items.reverse();
 const before=rawRows(store);
 store.db.exec(`CREATE TRIGGER fail_reorder_audit BEFORE INSERT ON station_task_edits WHEN NEW.task_id=${request.items[1].id} BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
 assert.throws(()=>store.tasks.edit(request,admin),/audit unavailable/);
 assert.deepEqual(rawRows(store),before);assert.equal(editCount(store),0);
 store.db.exec('DROP TRIGGER fail_reorder_audit');
 assert.deepEqual(store.tasks.edit(request,admin),{ok:true});
 assert.deepEqual(rows(store,'task').map(x=>x.id),request.items.map(x=>x.id));
});

test('Task reorder HTTP: existing edit route enforces authentication, CSRF, role and conflicts',async t=>{
 const store=fixture(t),origin='http://localhost';create(store);create(store);
 for(const user of [admin,staff,waiter])store.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update('reorder-'+user.id).digest('hex'),user.id,Date.now()+60000);
 const handler=adminHandler(store,origin),server=http.createServer((req,res)=>handler(req,res,new URL(req.url,origin)));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port+'/api/admin/tasks/edit',headers=id=>({Cookie:'__Host-start_session=reorder-'+id,Origin:origin,'Content-Type':'application/json'});
 const request=order(store);request.items.reverse();
 const post=h=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(request)});
 assert.equal((await post({'Content-Type':'application/json',Origin:origin})).status,401);
 assert.equal((await post(headers(staff.id))).status,403);
 assert.equal((await post(headers(waiter.id))).status,403);
 assert.equal((await post({...headers(admin.id),Origin:'http://wrong'})).status,403);
 assert.equal((await post(headers(admin.id))).status,200);
 assert.deepEqual(rows(store,'task').map(x=>x.id),request.items.map(x=>x.id));
 assert.equal((await post(headers(admin.id))).status,409);
});
