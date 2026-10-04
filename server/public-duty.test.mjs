import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {AdminStore} from './admin.mjs';
import {CafeStore,cafeHandler} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
test('Public orders: no staff rejects without mutation; attendance and hours required; last departure warns; retry remains idempotent',async t=>{
 const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'other','staff','unused'),(3,'second','staff','unused')");const u={id:1,role:'admin'},other={id:2,role:'staff'},second={id:3,role:'staff'},w=a.workforce,c=new CafeStore(a,new SmsStore(a,null,{}),{env:{}});fillTestCafeStock(c);
 const d=c.catalog();d.settings.open='00:00';d.settings.close='23:59';c.saveCatalog(d,u);
 const origin='http://localhost',server=http.createServer(async(req,res)=>cafeHandler(c,a,origin)(req,res,new URL(req.url,origin)));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url='http://127.0.0.1:'+server.address().port,post=(p,b)=>fetch(url+'/api/cafe/'+p,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(b)}),item=c.catalog().items.find(i=>i.name==='Сырники'),body={requestId:randomUUID(),name:'Гость',phone:'79001234567',consent:true,fulfillment:'pickup',payment:'cash',items:[{itemId:item.id,quantity:1}],expectedTotalCents:item.priceCents};
 assert.equal(c.publicMenu().ordering.accepting,false);let res=await post('orders',body);assert.equal(res.status,409);assert.equal((await res.json()).error,'Сейчас кафе не принимает заказы. Попробуйте позже. Уточнить можно по телефону 8(903) 963-31-35');assert.equal(a.db.prepare('SELECT count(*) n FROM cafe_orders').get().n,0);
 const session=w.action({requestId:randomUUID()},other,'start');assert.equal(c.publicMenu().ordering.accepting,true);assert.equal((await post('quote',body)).status,200);res=await post('orders',body);assert.equal(res.status,200);const order=await res.json();
 const end={requestId:randomUUID(),sessionId:session.id};assert.throws(()=>w.action(end,other,'end'),e=>e.pendingOrders===1);assert.ok(w.snapshot(other).own);
 const secondSession=w.action({requestId:randomUUID()},second,'start');w.action(end,other,'end');assert.equal(c.publicMenu().ordering.accepting,true);
 assert.throws(()=>w.action({requestId:randomUUID(),sessionId:secondSession.id},second,'end'),e=>e.pendingOrders===1);
 w.action({requestId:randomUUID(),sessionId:secondSession.id,confirmPendingOrders:1},second,'end');assert.equal(c.publicMenu().ordering.accepting,false);assert.equal(c.order(order.id,u).status,'NEW');
 assert.equal((await post('orders',{...body,requestId:randomUUID()})).status,409);res=await post('orders',body);assert.equal(res.status,200);assert.equal((await res.json()).id,order.id);
 w.action({requestId:randomUUID()},other,'start');const cfg=c.catalog();cfg.settings.open='10:00';cfg.settings.close='20:00';c.saveCatalog(cfg,u);assert.equal(c.publicAvailability(Date.parse('2026-09-28T21:00:00+03:00')).accepting,false);cfg.revision=c.catalog().revision;cfg.settings.enabled=false;c.saveCatalog(cfg,u);assert.equal(c.publicAvailability().accepting,false);
 }finally{await new Promise(r=>server.close(r));}
});
