import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {AdminStore,adminHandler} from './admin.mjs';
import {GuestBills} from './guest-bills.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
const owner={id:1,role:'admin'};
function fixture(t){
 const admin=new AdminStore(':memory:');t.after(()=>admin.close());
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{},request:async()=>{throw Error('External services forbidden');}});fillTestCafeStock(cafe);
 const guest=new GuestBills(admin,{read:()=>({}),request:async()=>{throw Error('External payments forbidden');}},cafe);admin.guestBills=guest;
 const bill=()=>guest.create({requestId:randomUUID(),name:'PRIVATE_GUEST',phone:'PRIVATE_PHONE',location:'PRIVATE_LOCATION',deferred:true},owner);
 const order=b=>{const item=cafe.catalog().items.find(i=>i.name==='Американо');return cafe.create({requestId:randomUUID(),guestBillId:b.id,name:'',phone:'',fulfillment:'pickup',payment:'unspecified',items:[{itemId:item.id,quantity:1}],expectedTotalCents:item.priceCents},owner);};
 return {admin,cafe,guest,bill,order};
}

test('Guest badge matches the active list including paid food awaiting handoff, excluding cancelled and closed bills',t=>{
 const f=fixture(t);assert.deepEqual(f.guest.badge(owner),{count:0});
 f.bill();const paid=f.bill(),closed=f.bill(),cancelled=f.bill();
 const meal=f.order(paid),cancelledMeal=f.order(cancelled);
 f.admin.db.prepare('UPDATE guest_bills SET paid_at=? WHERE id IN (?,?)').run(Date.now(),paid.id,closed.id);
 f.admin.db.prepare('UPDATE guest_bills SET cancelled_at=? WHERE id=?').run(Date.now(),cancelled.id);
 assert.deepEqual(f.guest.badge(owner),{count:2});assert.equal(f.guest.list(owner).items.length,2);
 f.admin.db.prepare("UPDATE cafe_orders SET status='READY' WHERE id=?").run(meal.id);
 assert.deepEqual(f.guest.badge(owner),{count:2});
 f.admin.db.prepare("UPDATE cafe_orders SET status='DELIVERED' WHERE id=?").run(meal.id);
 assert.deepEqual(f.guest.badge(owner),{count:1});assert.equal(f.guest.list(owner).items.length,1);
 f.admin.db.prepare("UPDATE cafe_orders SET status='READY' WHERE id=?").run(cancelledMeal.id);
 assert.deepEqual(f.guest.badge(owner),{count:1});
});

test('Unresolved payment and positive active cafe lines use the same predicate as the list without hydrating bills',t=>{
 const f=fixture(t),pending=f.bill(),food=f.bill(),meal=f.order(food),payment=randomUUID();
 f.admin.db.prepare('INSERT INTO aqsi_guest(id,request_id,device_id,amount,state,created,updated,actor) VALUES(?,?,0,100,?,?,?,1)').run(payment,randomUUID(),'receipt_waiting',Date.now(),Date.now());
 f.admin.db.prepare('UPDATE guest_bills SET paid_at=?,payment_id=? WHERE id=?').run(Date.now(),payment,pending.id);
 f.admin.db.prepare('UPDATE guest_bills SET paid_at=? WHERE id=?').run(Date.now(),food.id);
 assert.equal(f.guest.badge(owner).count,f.guest.list(owner).items.length);
 const originalGet=f.guest.get;f.guest.get=()=>{throw Error('Badge must not hydrate financial details');};
 const before=f.admin.db.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(f.guest.badge(owner),{count:2});assert.equal(f.admin.db.prepare('SELECT total_changes() n').get().n,before);
 f.guest.get=originalGet;
 f.admin.db.prepare("UPDATE aqsi_guest SET state='done' WHERE id=?").run(payment);
 assert.deepEqual(f.guest.badge(owner),{count:1});
 f.admin.db.prepare('UPDATE guest_bill_lines SET amount=0 WHERE source_id=? AND kind=\'cafe\'').run(meal.id);
 assert.deepEqual(f.guest.badge(owner),{count:0});assert.equal(f.guest.list(owner).items.length,0);
});

test('Guest badge HTTP exposes only count and retains session, role, schedule and read-only guards',async t=>{
 const f=fixture(t);f.bill();
 for(const [id,token] of [[1,'owner'],[2,'staff'],[3,'waiter']])f.admin.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+60000);
 const origin='http://localhost',handler=adminHandler(f.admin,origin),server=http.createServer((req,res)=>handler(req,res,new URL(req.url,origin)));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port+'/api/admin/guest-bills/badge';
 const request=(token,method='GET')=>fetch(base,{method,headers:{Cookie:'__Host-start_session='+token,Origin:origin,'Content-Type':'application/json'},...(method==='GET'?{}:{body:'{}'})});
 assert.equal((await request('bad')).status,401);
 for(const token of ['owner','staff','waiter']){const response=await request(token);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{count:1});}
 f.admin.db.exec('UPDATE schedule_access_policy SET enabled=1');assert.equal((await request('staff')).status,401);assert.equal((await request('waiter')).status,401);
 f.admin.db.exec('UPDATE schedule_access_policy SET enabled=0');
 for(const method of ['POST','PUT','DELETE'])assert.equal((await request('owner',method)).status,405);
 assert.equal(f.guest.badge(owner).count,1);
});
