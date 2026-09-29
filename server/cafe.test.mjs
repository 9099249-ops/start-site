import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {SmsStore} from './sms.mjs';
import {CafeStore,cafeHandler} from './cafe.mjs';
import http from 'node:http';
const now=Date.parse('2026-09-22T14:00:00+03:00');
function fixture(){const a=new AdminStore(':memory:');a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");const u={id:1,role:'admin'},w={id:3,role:'waiter'},s=new SmsStore(a,null,{}),messages=[];const c=new CafeStore(a,s,{env:{TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'1',SITE_ORIGIN:'https://spotsup.ru'},request:async(url,o)=>{messages.push(JSON.parse(o.body));return {ok:true,json:async()=>({ok:true})};}});fillTestCafeStock(c);const item=c.catalog().items.find(i=>i.name==='Сырники');const body=()=>({requestId:randomUUID(),name:'Тест',phone:'8 (903) 000-00-00',consent:true,fulfillment:'pickup',payment:'cash',items:[{itemId:item.id,quantity:1,optionIds:[]}],expectedTotalCents:item.priceCents});return {a,u,w,s,c,item,body,messages,close:()=>a.close()};}
function check(name,fn){test(name,async()=>{const f=fixture();try{await fn(f);}finally{f.close();}});}
check('Cafe: authenticated staff can quote and create orders around the clock; public hours remain enforced',f=>{
 for(const hour of ['00:00','02:00','23:59']){
  const at=Date.parse(`2026-09-22T${hour}:00+03:00`);
  for(const user of [f.u,f.w,{id:2,role:'staff'}]){
   const b={...f.body(),payment:'unspecified'};
   assert.equal(f.c.quote(b,user,at).totalCents,b.expectedTotalCents);
   assert.equal(f.c.create(b,user,'test',at).status,'NEW');
   assert.equal(f.c.create({...b,requestId:randomUUID(),quickSale:true},user,'test',at).status,'DELIVERED');
  }
  assert.throws(()=>f.c.quote(f.body(),null,at),/Заказы принимаем/);
  assert.throws(()=>f.c.create({...f.body(),staffMode:true,source:'admin'},null,'test',at),/Заказы принимаем/);
 }
 assert.throws(()=>f.c.quote(f.body(),{id:99,role:'customer'},now),/./);
});
check('Cafe: staff scheduled orders can cross midnight; guest schedule and preparation validation stay intact',f=>{
 const at=Date.parse('2026-09-22T23:30:00+03:00'),b={...f.body(),requestedAt:'2026-09-23T01:00'};
 assert.equal(f.c.create(b,f.w,'test',at).details.requestedAt,b.requestedAt);
 assert.throws(()=>f.c.quote({...f.body(),requestedAt:'2026-09-22T23:29'},f.w,at),/будущее время/);
 assert.throws(()=>f.c.quote({...f.body(),requestedAt:'bad'},f.w,at),/будущее время/);
 assert.throws(()=>f.c.quote(b,null,now),/часы работы/);
 const d=f.c.catalog();d.settings.enabled=false;f.c.saveCatalog(d,f.u);
 assert.throws(()=>f.c.quote(f.body(),f.w,at),/приостановлен/);
});
check('Cafe: quick counter sale is staff-only, atomic, idempotent and counted as delivered',f=>{
 const b={...f.body(),payment:'unspecified',quickSale:true};const r=f.c.create(b,f.w,'test',now);
 assert.equal(r.status,'DELIVERED');assert.equal(r.details.payment,'unspecified');assert.equal(f.c.create(b,f.w,'test',now).id,r.id);
 assert.equal(f.c.order(r.id,f.u).events.filter(e=>e.kind==='DELIVERED').length,1);
 assert.equal(f.a.workforce.revenue('2026-09-22',now).cafe_cents,r.totalCents);
 assert.throws(()=>f.c.create({...b,requestId:randomUUID()},null,'test',now));
 assert.throws(()=>f.c.create({...b,requestId:randomUUID(),fulfillment:'house',house:'У пирса'},f.w,'test',now));
});
check('Cafe: long order stays in work until completed and house accepts a name',f=>{
 const b={...f.body(),payment:'unspecified',fulfillment:'house',house:'Домик у пирса',expectedTotalCents:f.item.priceCents+30000};const r=f.c.create(b,f.w,'test',now);
 assert.equal(r.status,'NEW');assert.equal(r.details.house,'Домик у пирса');assert.equal(f.a.workforce.revenue('2026-09-22',now).cafe_cents,0);
 f.c.status({id:r.id,revision:r.revision,status:'DELIVERED'},f.w,now+1000);
 assert.equal(f.a.workforce.revenue('2026-09-22',now+1000).cafe_cents,r.totalCents);
});
check('Cafe: house delivery boundaries, validation, idempotency and notification',async f=>{
 for(const [price,fee] of [[99900,30000],[100000,0],[100100,0]]){
  const d=f.c.catalog();d.items.find(i=>i.id===f.item.id).priceCents=price;f.c.saveCatalog(d,f.u);
  const b={...f.body(),fulfillment:'house',house:50,expectedTotalCents:price+fee};
  assert.equal(f.c.quote(b,f.w,now).totalCents,price+fee);
  const r=f.c.create(b,f.w,'test',now);assert.equal(r.details.deliveryCents,fee);assert.equal(r.details.location,'Домик: 50');assert.equal(f.c.create(b,f.w,'test',now).id,r.id);
 }
 for(const house of ['',null,'x'.repeat(121)])assert.throws(()=>f.c.quote({...f.body(),fulfillment:'house',house},f.w,now));
 await f.c.tick(now);assert.match(f.messages[0].text,/Домик в яхт клубе: 50/);assert.match(f.messages[0].text,/Доставка официантом: 300/);
});
check('Cafe: house append recalculates delivery once and preserves accounting',f=>{
 const d=f.c.catalog();d.items.find(i=>i.id===f.item.id).priceCents=60000;f.c.saveCatalog(d,f.u);
 const b={...f.body(),fulfillment:'house',house:1,expectedTotalCents:90000};
 const r=f.c.create(b,f.w,'test',now),q=f.c.quote({...b,appendId:r.id,appendRevision:0},f.w,now);
 assert.equal(q.totalCents,30000);assert.equal(q.deliveryCents,0);
 const append={id:r.id,revision:0,requestId:randomUUID(),items:b.items,expectedTotalCents:q.totalCents};
 const added=f.c.append(append,f.w,now);assert.equal(added.total_cents,120000);assert.equal(added.details.deliveryCents,0);assert.equal(f.c.append(append,f.w,now).total_cents,120000);
 assert.throws(()=>f.c.quote({...b,appendId:r.id,appendRevision:0},f.w,now),/изменён/);
});
check('Cafe: place is assigned after order, retries are idempotent and stock and total stay unchanged',async f=>{
 const created=f.c.create({...f.body(),fulfillment:'lounge'},f.w,'test',now),before=f.c.stock.inventory.catalog(f.u).items.map(i=>[i.id,i.current_milli]),body={id:created.id,revision:created.revision,requestId:randomUUID(),location:'Стол 12'};
 const order=f.c.location(body,f.w,now+1000);assert.equal(order.details.location,'Стол 12');assert.equal(order.total_cents,created.totalCents);assert.equal(order.status,'NEW');assert.equal(f.c.location(body,f.w,now+2000).revision,1);assert.equal(order.events.filter(e=>e.kind==='LOCATION').length,1);assert.deepEqual(f.c.stock.inventory.catalog(f.u).items.map(i=>[i.id,i.current_milli]),before);assert.throws(()=>f.c.location({...body,requestId:randomUUID()},f.w,now),/изменён/);assert.throws(()=>f.c.location({...body,revision:1,requestId:randomUUID()},null,now));await f.c.tick(now+2000);assert.equal(f.messages.length,2);assert.match(f.messages[1].text,/Стол 12/);assert.match(f.messages[1].text,/не новый заказ/);
 for(const status of ['ACCEPTED','COOKING','READY','DELIVERED']){const r=f.c.order(created.id,f.u);f.c.status({id:r.id,revision:r.revision,status},f.w,now+3000);}const r=f.c.order(created.id,f.u);assert.throws(()=>f.c.location({...body,revision:r.revision,requestId:randomUUID()},f.w,now),/закрыт/);
});
check('Cafe: source catalog, tea prices and tobacco-free service',f=>{const d=f.c.catalog();assert.equal(d.items.find(i=>i.name==='Классический чай').priceCents,50000);assert.equal(d.items.find(i=>i.name==='Травяной и ягодный чай').variants.length,12);const x=d.items.find(i=>i.station==='tea_hookah');assert.match(x.description,/без табака и никотина/);assert.equal(f.c.calculate([{itemId:x.id,quantity:1}],'lounge').totalCents,300000);assert.throws(()=>f.c.calculate([{itemId:x.id,quantity:1}],'yacht'));assert.equal(d.items.filter(i=>i.station==='hookah').length,0);});
check('Cafe: server pricing and option snapshots in integer kopecks',f=>{const b=f.body();b.items[0].optionIds=['syrniki_toppings-0'];b.items[0].quantity=2;b.expectedTotalCents=90000;const r=f.c.create(b,null,'ip',now);assert.equal(r.totalCents,90000);assert.equal(r.details.items[0].modifiers[0].priceCents,5000);assert.equal(f.a.db.prepare('SELECT count(*) n FROM cafe_notifications').get().n,1);});
check('Cafe: idempotent request, unchanged clients, changed request rejected',f=>{const b=f.body(),r=f.c.create(b,null,'ip',now);assert.equal(f.c.create(b,null,'ip',now).id,r.id);assert.equal(f.c.create(b,null,'ip',now).duplicate,true);assert.throws(()=>f.c.create({...b,name:'Другое'},null,'ip',now),/использован/);assert.equal(f.a.db.prepare('SELECT count(*) n FROM clients').get().n,1);assert.equal(f.a.db.prepare('SELECT count(*) n FROM cafe_orders').get().n,1);assert.equal(f.s.clients()[0].marketing_consent,0);});
check('Cafe: totals and snapshots survive catalog edits',f=>{const r=f.c.create(f.body(),null,'ip',now),d=f.c.catalog();d.items.find(x=>x.id===f.item.id).priceCents=12300;f.c.saveCatalog(d,f.u);assert.equal(f.c.order(r.id,f.u).details.items[0].unitCents,40000);assert.throws(()=>f.c.create(f.body(),null,'ip',now),/Цена изменилась/);});
check('Cafe: required choice, unknown and repeated modifiers, safe quantities',f=>{const x=f.c.catalog().items.find(x=>x.name==='Классический чай');assert.throws(()=>f.c.calculate([{itemId:x.id,quantity:1}],'pickup'));assert.equal(f.c.calculate([{itemId:x.id,variantId:x.variants[0].id,quantity:1}],'pickup').totalCents,50000);for(const l of [{quantity:0},{quantity:1.5},{quantity:21},{quantity:1,optionIds:['bad']},{quantity:1,optionIds:['syrniki_toppings-0','syrniki_toppings-0']}])assert.throws(()=>f.c.calculate([{itemId:f.item.id,...l}],'pickup'));});
check('Cafe: stop list and inactive categories/options enforced server-side',f=>{let d=f.c.catalog();d.items.find(x=>x.id===f.item.id).soldOut=true;f.c.saveCatalog(d,f.u);assert.throws(()=>f.c.create(f.body(),null,'ip',now),/недоступна/);d=f.c.catalog();d.items.find(x=>x.id===f.item.id).soldOut=false;d.groups[3].options[0].soldOut=true;f.c.saveCatalog(d,f.u);assert.throws(()=>f.c.calculate([{itemId:f.item.id,quantity:1,optionIds:['syrniki_toppings-0']}],'pickup'),/недоступна/);d=f.c.catalog();d.categories[0].active=false;f.c.saveCatalog(d,f.u);assert.throws(()=>f.c.create(f.body(),null,'ip',now));});
check('Cafe: consent, opening hours, pause, scheduled delivery',f=>{assert.throws(()=>f.c.create({...f.body(),consent:false},null,'ip',now));assert.throws(()=>f.c.create(f.body(),null,'ip',now-12*3600000));assert.throws(()=>f.c.create({...f.body(),requestedAt:'2026-09-22T14:05'},null,'ip',now));assert.equal(f.c.create({...f.body(),requestedAt:'2026-09-22T16:00'},null,'ip',now).details.requestedAt,'2026-09-22T16:00');let d=f.c.catalog();d.settings.enabled=false;f.c.saveCatalog(d,f.u);assert.throws(()=>f.c.create(f.body(),null,'ip',now),/приостановлен/);});
check('Cafe: yacht requires location and name',f=>{assert.throws(()=>f.c.create({...f.body(),fulfillment:'yacht'},null,'ip',now));const r=f.c.create({...f.body(),fulfillment:'yacht',yacht:'ТЕСТ',location:'Причал 1'},null,'ip',now);assert.equal(r.details.yacht,'ТЕСТ');});
check('Cafe: long place tokens, rotation, disabled places, forged place IDs',f=>{let [p]=f.c.savePlace({name:'Стол 7',type:'table',active:true},f.u);assert.equal(p.token.length,48);assert.throws(()=>f.c.create({...f.body(),fulfillment:'place',placeId:p.id},null,'ip',now));const r=f.c.create({...f.body(),fulfillment:'place',placeToken:p.token},null,'ip',now);assert.equal(r.details.place.name,'Стол 7');const old=p.token;[p]=f.c.savePlace({...p,active:true,rotate:true},f.u);assert.throws(()=>f.c.placeForToken(old));f.c.savePlace({...p,active:false},f.u);assert.throws(()=>f.c.placeForToken(p.token));assert.equal(f.c.order(r.id,f.u).details.place.name,'Стол 7');});
check('Cafe: staff orders, role separation and optimistic settings revisions',f=>{const b={...f.body(),phone:'',name:'',consent:false};const r=f.c.create(b,f.w,'ip',now);assert.equal(f.c.order(r.id,f.u).source,'waiter');assert.equal(r.details.name,'Гость');assert.equal(r.details.phone,'');assert.equal(f.a.db.prepare('SELECT count(*) n FROM clients').get().n,0);assert.throws(()=>f.c.create({...b,requestId:randomUUID(),consent:true},null,'ip',now));assert.throws(()=>f.c.saveCatalog(f.c.catalog(),f.w));assert.throws(()=>f.c.savePlace({name:'Стол',type:'table',active:true},f.w));const d=f.c.catalog();f.c.saveCatalog(d,f.u);assert.throws(()=>f.c.saveCatalog(d,f.u),/изменено/);});
check('Cafe: status lifecycle, duplicate status, stale changes and immutable closed orders',f=>{let r=f.c.order(f.c.create(f.body(),null,'ip',now).id,f.u);for(const status of ['ACCEPTED','COOKING','READY','DELIVERED']){const b={id:r.id,revision:r.revision,status};r=f.c.status(b,f.w,now);assert.equal(f.c.status(b,f.w,now).revision,r.revision);}assert.equal(r.revision,4);assert.throws(()=>f.c.status({id:r.id,revision:4,status:'NEW'},f.u));assert.throws(()=>f.c.append({...f.body(),id:r.id,revision:4},f.w,now));});
check('Cafe: add-on idempotency and separate notification payload',async f=>{const r=f.c.create(f.body(),null,'ip',now),b={...f.body(),id:r.id,revision:0};const added=f.c.append(b,f.w,now);assert.equal(added.total_cents,80000);assert.equal(f.c.append(b,f.w,now).total_cents,80000);assert.throws(()=>f.c.append({...f.body(),id:r.id,revision:0},f.w,now),/изменён/);await f.c.tick(now);assert.equal(f.messages.length,2);assert.match(f.messages[1].text,/дозаказ/);assert.match(f.messages[1].text,/400/);});
check('Cafe: Telegram sent after commit, inline link and no repeated send',async f=>{const r=f.c.create(f.body(),null,'ip',now);assert.equal(f.messages.length,0);await Promise.all([f.c.tick(now),f.c.tick(now)]);assert.equal(f.messages.length,1);assert.equal(f.messages[0].reply_markup.inline_keyboard[0][0].url,'https://spotsup.ru/admin/cafe/#order-'+r.id);await f.c.tick(now+60000);assert.equal(f.messages.length,1);});
check('Cafe: uncertain Telegram failure retains order and requires explicit retry',async f=>{const r=f.c.create(f.body(),null,'ip',now);f.c.request=async()=>{throw Error('secret-token network error');};await f.c.tick(now);let n=f.c.order(r.id,f.u).notifications[0];assert.equal(n.status,'unknown');assert.doesNotMatch(n.last_error,/secret/);f.c.retryNotification(n.id,f.u);assert.equal(f.c.order(r.id,f.u).notifications[0].status,'queued');});
check('Cafe: explicit provider rejection retries with backoff',async f=>{const r=f.c.create(f.body(),null,'ip',now);f.c.request=async()=>({ok:false,json:async()=>({ok:false})});await f.c.tick(now);const n=f.c.order(r.id,f.u).notifications[0];assert.equal(n.status,'queued');assert.equal(n.attempts,1);await f.c.tick(now+1000);assert.equal(f.c.order(r.id,f.u).notifications[0].attempts,1);});
check('Cafe: rate limit and random order receipt access',f=>{for(let i=0;i<5;i++)f.c.create(f.body(),null,'ip',now);assert.throws(()=>f.c.create(f.body(),null,'ip',now),/Слишком много/);assert.throws(()=>f.c.publicOrder('1'));const r=f.c.create(f.body(),f.u,'ip',now);assert.equal(f.c.publicOrder(r.token).details.phone,undefined);assert.equal(f.c.publicOrder(r.token).details.name,undefined);});
check('Cafe: menu validation rejects bad prices and duplicate modifier IDs',f=>{const d=f.c.catalog();d.items[0].priceCents=1.1;assert.throws(()=>f.c.saveCatalog(d,f.u));d.items[0].priceCents=40000;d.groups[1].options[0].id=d.groups[0].options[0].id;assert.throws(()=>f.c.saveCatalog(d,f.u),/уникальны/);});
check('Cafe: waiter uses existing password auth and cannot overwrite admin',f=>{f.c.saveStaff({login:'test_waiter',password:'test-only-password'},f.u);const token=f.a.login({login:'test_waiter',password:'test-only-password'},'ip');assert.equal(f.a.user(token).role,'waiter');f.c.saveStaff({login:'test_waiter',password:'test-only-password2'},f.u);assert.equal(f.a.user(token),null);assert.throws(()=>f.c.saveStaff({login:'admin',password:'test-only-password'},f.u));});
check('Cafe HTTP: authentication, CSRF, body limits and no secrets in public menu',async f=>{let origin;const server=http.createServer(async(req,res)=>{await cafeHandler(f.c,f.a,origin)(req,res,new URL(req.url,origin));});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;try{let r=await fetch(origin+'/api/admin/cafe/orders');assert.equal(r.status,401);r=await fetch(origin+'/api/cafe/orders',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://wrong.test'},body:JSON.stringify(f.body())});assert.equal(r.status,403);r=await fetch(origin+'/api/cafe/menu');assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/fake|TELEGRAM_BOT_TOKEN/);r=await fetch(origin+'/api/cafe/orders',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:' '.repeat(33000)});assert.equal(r.status,413);}finally{await new Promise(r=>server.close(r));}});
check('Cafe: all staff share all orders newest first, independent of author and status',f=>{
 const staff={id:2,role:'staff'};
 const old=f.c.create(f.body(),f.w,'test',now-86400000);
 const first=f.c.create(f.body(),staff,'test',now);
 const sold=f.c.create({...f.body(),quickSale:true},f.u,'test',now+1000);
 const last=f.c.create(f.body(),f.w,'test',now+1000);
 const expected=[last.id,sold.id,first.id,old.id];
 for(const user of [f.u,staff,f.w]){
  const result=f.c.orders(new URLSearchParams({date:'2026-09-22'}),user);
  assert.deepEqual(result.rows.map(r=>r.id),expected);
  assert.equal(result.totalCents,3*f.item.priceCents);
  assert.deepEqual(f.c.orders(new URLSearchParams({date:'2026-09-22',status:'DELIVERED'}),user).rows.map(r=>r.id),[sold.id]);
 }
 assert.throws(()=>f.c.orders(new URLSearchParams({date:'2026-09-22'}),null));
 assert.throws(()=>f.c.orders(new URLSearchParams({date:'2026-09-22'}),{id:99,role:'customer'}));
});
check('Cafe: complimentary permissions, immutable menu value and zero revenue',f=>{
 const b={...f.body(),complimentary:{reason:'owner'},expectedTotalCents:0,fulfillment:'lounge',location:'Стол 5'};
 assert.throws(()=>f.c.quote(b,null,now));
 assert.throws(()=>f.c.create(b,f.w,'test',now),e=>e.status===403);
 assert.throws(()=>f.c.create({...b,complimentary:{reason:'employee',recipientId:2}},f.w,'test',now),e=>e.status===403);
 assert.throws(()=>f.c.create({...b,complimentary:{reason:'guest',comment:''}},f.u,'test',now));
 const r=f.c.create(b,f.u,'test',now);assert.equal(r.status,'NEW');assert.equal(r.totalCents,0);
 assert.equal(r.details.complimentary.menuValueCents,f.item.priceCents);assert.equal(r.details.complimentary.authorizedBy,1);
 assert.equal(f.c.create(b,f.u,'test',now).id,r.id);
 f.c.status({id:r.id,revision:r.revision,status:'DELIVERED'},f.w,now+1);
 assert.equal(f.a.workforce.revenue('2026-09-22',now+2).cafe_cents,0);
 assert.equal(f.a.workforce.complimentaryTotal('2026-09-22',now+2),f.item.priceCents);
 const self=f.c.create({...f.body(),complimentary:{reason:'employee',recipientId:3,menuValueCents:1},expectedTotalCents:0},f.w,'test',now);
 assert.equal(self.details.complimentary.menuValueCents,f.item.priceCents);
 const add={id:self.id,revision:self.revision,requestId:randomUUID(),items:f.body().items,expectedTotalCents:0};
 assert.throws(()=>f.c.append(add,{id:2,role:'staff'},now),e=>e.status===403);
 const appended=f.c.append(add,f.w,now);assert.equal(appended.total_cents,0);assert.equal(appended.details.complimentary.menuValueCents,2*f.item.priceCents);
 assert.equal(f.c.append(add,f.w,now).details.complimentary.menuValueCents,2*f.item.priceCents);
 const paid=f.c.create(f.body(),f.u,'test',now);
 assert.throws(()=>f.c.append({...add,id:paid.id,requestId:randomUUID(),complimentary:{reason:'owner'}},f.u,now));
 assert.equal(f.c.order(paid.id,f.u).total_cents,f.item.priceCents);
});
