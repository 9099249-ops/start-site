import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import {CafeBoard,cafeBoardHandler} from './cafe-board.mjs';
const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../dist/cafe-board-core.js',import.meta.url),'utf8'),context);const {splitOrder,pack,Rotation}=context.CafeBoardCore;
test('Cyclic numbers never merge board identities from different cycles',()=>{
 const f=fixture();try{f.insert(1);f.insert(1000);const orders=f.board.snapshot().orders;
 assert.deepEqual(orders.map(o=>o.displayNumber),['001','001']);assert.deepEqual(orders.map(o=>o.id),[1,1000]);
 assert.deepEqual(Array.from(context.CafeBoardCore.readyArrivals([{id:1,status:'ready'}],[{id:1,status:'ready'},{id:1000,status:'ready'}])),[1000]);
 }finally{f.db.close();}
});
test('ready sound only for new readiness, never initial loading or repeated polls',()=>{
 const arrivals=context.CafeBoardCore.readyArrivals,ready={id:1,status:'ready'},cooking={id:1,status:'cooking'};
 assert.equal(arrivals(null,[ready]).length,0);
 assert.deepEqual(Array.from(arrivals([cooking],[ready])),[1]);
 assert.equal(arrivals([ready],[{...ready,comment:'Изменён'}]).length,0);
 assert.equal(arrivals([ready],[]).length,0);
 assert.deepEqual(Array.from(arrivals([ready],[ready,{id:2,status:'ready'}])),[2]);
});
function fixture(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE admin_users(id INTEGER,login TEXT);CREATE TABLE employee_profiles(user_id INTEGER,display_name TEXT);CREATE TABLE employee_work_sessions(user_id INTEGER,started_at INTEGER,ended_at INTEGER);CREATE TABLE archived_accounts(user_id INTEGER);CREATE TABLE rentals(equipment TEXT,quantity INTEGER,people INTEGER,returned INTEGER,initial_due INTEGER);CREATE TABLE cafe_orders(id INTEGER PRIMARY KEY,status TEXT,source TEXT,details TEXT,created INTEGER);CREATE TABLE cafe_order_events(order_id INTEGER,kind TEXT,created INTEGER)');const board=new CafeBoard({db,catalog:()=>({settings:{prepMinutes:20}})},{CAFE_BOARD_TOKEN:'test-only-'.repeat(5)});const insert=(id,status='NEW',extra={},source='admin')=>db.prepare('INSERT INTO cafe_orders VALUES(?,?,?,?,?)').run(id,status,source,JSON.stringify({name:'PRIVATE_NAME',phone:'PRIVATE_PHONE',location:'PRIVATE_ADDRESS',payment:'cash',totalCents:50000,items:[{quantity:2,name:'Латте',variant:{name:'350 мл'},modifiers:[{name:'Карамельный сироп',priceCents:5000}],comment:'Без сахара',unitCents:20000}],comment:'Директору',fulfillment:'pickup',...extra}),1000);return {db,board,insert};}
test('TV API whitelist excludes personal, financial and payment data; source/modifier associations retained',()=>{const f=fixture();try{f.insert(1);f.insert(2,'READY',{},'customer_web');f.insert(3,'NEW',{fulfillment:'yacht',location:'PRIVATE_ADDRESS'});const data=f.board.snapshot(5000),json=JSON.stringify(data);assert.doesNotMatch(json,/PRIVATE|Cents|phone|payment|actor|token/);assert.equal(data.orders[0].items[0].modifiers[0],'Карамельный сироп');assert.equal(data.orders[1].source,'Сайт');assert.equal(data.orders[2].location,'На яхту');assert.equal(data.warningMinutes,20);}finally{f.db.close();}});
test('TV follows statuses, payment readiness, issued/cancelled exclusion and persisted wait start',()=>{const f=fixture();try{f.insert(1);f.insert(2,'NEW',{pendingKitchen:true});f.insert(3,'NEW',{terminalPaymentRequired:true});f.insert(4,'NEW',{guestDeferred:true,terminalPaymentRequired:true});f.insert(5,'DELIVERED');f.insert(6,'CANCELLED');f.db.prepare('INSERT INTO cafe_order_events VALUES(?,?,?)').run(1,'NEW',2000);let data=f.board.snapshot();assert.deepEqual(data.orders.map(o=>o.id),[4,1]);assert.equal(data.orders[1].waitingSince,2000);f.db.prepare('UPDATE cafe_orders SET status=? WHERE id=1').run('READY');assert.equal(f.board.snapshot().orders.find(o=>o.id===1).status,'ready');f.db.prepare('UPDATE cafe_orders SET details=? WHERE id=1').run(JSON.stringify({items:[{name:'Новый состав',quantity:1}],comment:'Изменён',fulfillment:'lounge',location:'1 стол'}));const o=f.board.snapshot().orders.find(o=>o.id===1);assert.equal(o.waitingSince,2000);assert.equal(o.location,'1 стол');assert.equal(o.comment,'Изменён');f.db.prepare('UPDATE cafe_orders SET status=? WHERE id=1').run('DELIVERED');assert.equal(f.board.snapshot().orders.length,1);}finally{f.db.close();}});
test('TV is publicly readable without credentials, contains no secrets and rejects mutations',async()=>{const f=fixture();f.insert(1);const handler=cafeBoardHandler(f.board),server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;try{const r=await fetch(origin+'/api/cafe/board');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('set-cookie'),null);const body=await r.text();assert.doesNotMatch(body,/PRIVATE|Cents|phone|token|payment/);assert.equal(JSON.parse(body).orders.length,1);for(const method of ['POST','PUT','DELETE'])assert.equal((await fetch(origin+'/api/cafe/board',{method})).status,405);const page=await fetch(origin+'/cafe/board');assert.equal(page.status,200);assert.doesNotMatch(await page.text(),/pair-form/);assert.equal((await fetch(origin+'/admin/cafe/board',{redirect:'manual'})).headers.get('location'),'/cafe/board');f.board.env.CAFE_BOARD_TOKEN='';assert.equal((await fetch(origin+'/api/cafe/board')).status,200);}finally{await new Promise(r=>server.close(r));f.db.close();}});
test('20 positions and long comments show in full; differing syrups retain their own dish',()=>{const order={items:Array.from({length:20},(_,i)=>({name:'Латте '+i,quantity:1,variant:'',modifiers:[i%2?'Ванильный':'Карамельный'],comment:''})),comment:'Комментарий '.repeat(100)};const measure=p=>100+p.items.reduce((n,i)=>n+40+i.modifiers.join('').length,0)+p.comment.length;const parts=splitOrder(order,300,measure);assert.ok(parts.length>5);for(let i=0;i<20;i++){const item=parts.flatMap(p=>p.items).find(x=>x.index===i);assert.equal(item.modifiers[0],i%2?'Ванильный':'Карамельный');}assert.equal(parts.map(p=>p.comment).join(''),order.comment);assert.ok(parts.every(p=>measure(p)<=300));});
test('nested rotation shows every part before page change and polls preserve progress',()=>{const r=new Rotation(),entries=Array.from({length:20},(_,i)=>({order:{id:i},height:100,parts:Array.from({length:i===0?3:1},()=>({items:[],comment:''}))}));const pages=pack(entries,250,10);r.replace(pages,0);assert.equal(r.visible().length,2);r.advance(10000,10);assert.equal(r.phase,1);r.replace(pack(entries,250,10),11000);assert.equal(r.phase,1);r.advance(20000,10);assert.equal(r.phase,2);assert.equal(r.page,0);r.advance(30000,10);assert.equal(r.page,1);const seen=new Set();for(let t=30000;t<180000;t+=10000){r.advance(t,10);r.visible().forEach(e=>seen.add(e.order.id));}assert.equal(seen.size,20);});

test('marquee timing holds both ends and gives every pixel enough reading time',()=>{
 const plan=context.CafeBoardCore.scrollPlan;
 assert.equal(plan(0).duration,0);assert.equal(plan(1).duration,0);
 for(const [distance,speed] of [[300,38],[4000,38],[1200,34]]){
  const p=plan(distance,speed);
  assert.ok(Math.abs(p.duration*p.pauseFraction-2500)<0.001);
  assert.ok(Math.abs(p.duration*(1-2*p.pauseFraction)-distance/speed*1000)<0.001);
  assert.ok(p.pauseFraction>0&&p.pauseFraction<0.5);
 }
});

test('three-line layout leaves short orders static and preserves all overflow after two fixed lines',()=>{
 const layout=context.CafeBoardCore.threeLines,measure=s=>s.length;
 assert.deepEqual(Array.from(layout(['1 × Чай','2 × Кофе','1 × Сок'],20,measure)),['1 × Чай','2 × Кофе','1 × Сок']);
 const dishes=['1 × Чай','2 × Кофе','1 × Сок','1 × Пирог','3 × Латте'];
 const lines=layout(dishes,20,measure);
 assert.equal(lines.length,3);assert.equal(lines[0],dishes[0]);assert.equal(lines[1],dishes[1]);
 assert.equal(lines[2],dishes.slice(2).join(' • '));assert.ok(measure(lines[2])>20);
 const long='ОченьДлинноеНазваниеБезПробелов';assert.equal(layout([long],5,measure).join('').replaceAll(' ',''),long);
 const detail='1 × Латте — Карамельный сироп — Без сахара';
 assert.equal(layout([detail],12,measure).join(' ').replace(/\s+/g,' ').trim(),detail);
});
test('ready melody has multiple notes and ends exactly two seconds after its start',()=>{
 const notes=context.CafeBoardCore.readyMelody;assert.equal(notes.length,5);
 assert.ok(new Set(notes.map(n=>n.frequency)).size>=4);assert.equal(notes[0].at,0);
 assert.equal(Math.max(...notes.map(n=>n.at+n.duration)),2);
 assert.ok(notes.every(n=>n.duration>.3&&n.frequency>400&&n.frequency<1200));
});

test('water informer counts equipment, excluding returns, pending payments and manual sales',()=>{const f=fixture();try{assert.equal(f.board.snapshot().onWaterCount,0);f.db.exec("INSERT INTO rentals VALUES ('sup',10,NULL,NULL,0),('big',1,12,NULL,0),('kayak2',1,2,NULL,0),('sup',7,NULL,1234,0),('sup',4,NULL,NULL,1000),('manual',3,NULL,NULL,0)");assert.equal(f.board.snapshot().onWaterCount,12);f.db.exec('UPDATE rentals SET returned=5678 WHERE returned IS NULL');assert.equal(f.board.snapshot().onWaterCount,0);}finally{f.db.close();}});

test('public board lists only named staff currently on shift, without duplicates or account data',()=>{const f=fixture();try{assert.deepEqual(f.board.snapshot(5000).staffNames,[]);f.db.exec("INSERT INTO employee_profiles VALUES(1,'Анна'),(2,'Иван'),(3,'Ушёл'),(4,'Архив'),(5,'Будущий'),(6,' ');INSERT INTO employee_work_sessions VALUES(1,1000,NULL),(1,2000,NULL),(2,1000,NULL),(3,1000,2000),(4,1000,NULL),(5,6000,NULL),(6,1000,NULL),(7,1000,NULL);INSERT INTO archived_accounts VALUES(4)");assert.deepEqual(f.board.snapshot(5000).staffNames,['Анна','Иван']);f.db.exec('UPDATE employee_work_sessions SET ended_at=5000 WHERE user_id=1');assert.deepEqual(f.board.snapshot(5000).staffNames,['Иван']);}finally{f.db.close();}});

test('content-sized pages preserve every part and cap a page at six cards',()=>{const entries=Array.from({length:17},(_,i)=>({order:{id:i},height:i%2?80:120,content:{items:[],comment:''}}));const pages=context.CafeBoardCore.boardPages(entries,600,10);assert.deepEqual(Array.from(pages.flat().map(e=>e.order.id)),entries.map(e=>e.order.id));for(const page of pages){assert.ok(page.length<=6);assert.ok(page.reduce((sum,e)=>sum+e.height,0)+(page.length-1)*10<=600);}assert.equal(context.CafeBoardCore.boardPages(entries.map(e=>({...e,height:10})),1000,0)[0].length,6);assert.ok(context.CafeBoardCore.pageSeconds([{content:{comment:'x'.repeat(2000)}}])>12);});
test('ready receiving text preserves actual table and other fulfillment',()=>{const c=context.CafeBoardCore;assert.equal(c.receiving('Самовывоз'),'Выдача у бара');assert.match(c.readyHint('Стол 4'),/Стол 4/);for(const location of ['Стол 4','На яхту','Домик'])assert.doesNotMatch(c.readyHint(location),/у бара/);});
test('wait basis honestly distinguishes work events from creation fallback',()=>{const f=fixture();try{f.insert(1);f.insert(2);f.db.exec("INSERT INTO cafe_order_events VALUES(2,'COOKING',2000)");const rows=f.board.snapshot().orders;assert.equal(rows.find(o=>o.id===1).waitingBasis,'created');assert.equal(rows.find(o=>o.id===2).waitingBasis,'work');assert.equal(rows.find(o=>o.id===2).waitingSince,2000);}finally{f.db.close();}});

test('Website orders cook before manual payment; POS payment guard and closed exclusions remain',()=>{const f=fixture();try{const unpaid={terminalPaymentRequired:true,manualPaymentRequired:true};f.insert(151,'NEW',unpaid,'customer_web');f.insert(152,'READY',unpaid,'customer_nfc');f.insert(153,'NEW',{terminalPaymentRequired:true},'admin');f.insert(154,'CANCELLED',unpaid,'customer_web');f.insert(155,'DELIVERED',unpaid,'customer_web');f.insert(156,'NEW',{...unpaid,pendingKitchen:true},'customer_web');const orders=f.board.snapshot().orders;assert.deepEqual(orders.map(o=>o.id),[151,152]);assert.equal(orders[0].status,'cooking');assert.equal(orders[1].status,'ready');f.db.prepare('UPDATE cafe_orders SET details=? WHERE id=151').run(JSON.stringify({...unpaid,terminalPaidAt:2000,items:[]}));assert.equal(f.board.snapshot().orders.find(o=>o.id===151).status,'cooking');}finally{f.db.close();}});
