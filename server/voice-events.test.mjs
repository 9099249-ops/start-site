import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
import {voiceEventsHandler} from './voice-events.mjs';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const owner={id:1,role:'admin'},now=Date.parse('2026-10-06T10:00:00+03:00');
async function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{},request:async()=>{throw Error('External integration disabled');}});
 fillTestCafeStock(cafe);
 for(const [id,token] of [[1,'owner'],[1,'new-owner-session'],[2,'staff'],[3,'waiter']])admin.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
 const handler=voiceEventsHandler(admin),server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));admin.close();});
 const base='http://127.0.0.1:'+server.address().port+'/api/admin/voice-events';
 const response=(cursor,token='owner',options={})=>fetch(base+(cursor?'?'+new URLSearchParams(cursor):''),{headers:{Cookie:'__Host-start_session='+token},...options});
 const read=async cursor=>{const r=await response(cursor);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');return r.json();};
 const item=cafe.catalog().items.find(i=>i.name==='Американо');
 const orderBody=()=>({requestId:randomUUID(),name:'PRIVATE_NAME',phone:'+79030000000',consent:true,fulfillment:'pickup',payment:'cash',items:[{itemId:item.id,quantity:1}],expectedTotalCents:item.priceCents});
 const createOrder=(user=null)=>cafe.create(orderBody(),user,'test',now);
 const createTask=(kind='task')=>admin.tasks.create({requestId:randomUUID(),text:'PRIVATE_TASK',kind},owner,now);
 const createBooking=()=>admin.receive(randomUUID(),{equipment:'sup',plan:'hour',quantity:1,duration:1,date:'2026-10-07',time:'13:00',name:'PRIVATE_NAME',phone:'+79030000000'},now);
 return {admin,cafe,response,read,orderBody,createOrder,createTask,createBooking};
}

test('Voice feed baselines silently, then detects all three creation kinds without personal data or writes',async t=>{
 const f=await fixture(t);f.createOrder();f.createTask();f.createBooking();
 const first=await f.read();assert.equal(first.baseline,true);assert.deepEqual(first.events,[]);
 const ids=[f.createOrder().id,f.createTask(),f.createBooking()];
 const changes=f.admin.db.prepare('SELECT total_changes() n').get().n;
 const next=await f.read(first.cursor);
 assert.equal(next.baseline,false);
 assert.deepEqual(next.events,[{kind:'cafe_order',id:ids[0]},{kind:'task',id:ids[1]},{kind:'booking',id:ids[2]}]);
 assert.equal(f.admin.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.doesNotMatch(JSON.stringify(next),/PRIVATE|phone|name|details|price|payment|created_by|receipt/);
 assert.equal(next.cursor.scope.length,24);
 assert.deepEqual((await f.read(next.cursor)).events,[]);
});

test('Staff orders, recurring task templates, edits, completion, confirmation and cancellations do not create new voice alerts',async t=>{
 const f=await fixture(t),order=f.createOrder(),task=f.createTask(),booking=f.createBooking();
 let last=await f.read();
 f.createOrder(owner);for(const kind of ['opening','during','closing'])f.createTask(kind);
 f.admin.db.prepare("UPDATE cafe_orders SET status='READY',updated=updated+1 WHERE id=?").run(order.id);
 f.admin.tasks.complete({id:task,revision:0,done:true},{id:2,role:'staff'},now+1);
 f.admin.tasks.edit({id:task,revision:0,action:'text',text:'PRIVATE_UPDATED'},owner,now+2);
 f.admin.inquiryStatus({id:booking,revision:0,status:'confirmed'},owner,now+3);
 const next=await f.read(last.cursor);assert.deepEqual(next.events,[]);
 f.admin.db.prepare("UPDATE cafe_orders SET status='CANCELLED' WHERE id=?").run(order.id);
 f.admin.inquiryStatus({id:booking,revision:1,status:'cancelled'},owner,now+4);
 assert.deepEqual((await f.read(next.cursor)).events,[]);
});

test('Idempotent repeated submissions never duplicate alerts; equal timestamps and bursts advance every stream',async t=>{
 const f=await fixture(t),first=await f.read(),body=f.orderBody();
 const order=f.cafe.create(body,null,'test',now);
 assert.equal(f.cafe.create(body,null,'test',now).id,order.id);
 const taskBody={requestId:randomUUID(),text:'PRIVATE_TASK'},task=f.admin.tasks.create(taskBody,owner,now);
 assert.equal(f.admin.tasks.create(taskBody,owner,now),task);
 const next=await f.read(first.cursor);assert.equal(next.events.length,2);
 assert.deepEqual((await f.read(next.cursor)).events,[]);
 const one=f.createOrder(),two=f.createOrder();assert.equal(one.created,two.created);
 f.admin.db.prepare("UPDATE cafe_orders SET source='customer_nfc' WHERE id=?").run(two.id);
 const last=await f.read(next.cursor);assert.deepEqual(last.events,[{kind:'cafe_order',id:two.id}]);
 assert.equal(last.cursor.cafe,two.id);
 assert.deepEqual((await f.read(last.cursor)).events,[]);
});

test('Session replacement and future/reset cursors establish a new silent baseline',async t=>{
 const f=await fixture(t),first=await f.read();f.createOrder();
 const replacement=await (await f.response(first.cursor,'new-owner-session')).json();
 assert.equal(replacement.baseline,true);assert.deepEqual(replacement.events,[]);assert.notEqual(replacement.cursor.scope,first.cursor.scope);
 const future=await f.read({...first.cursor,cafe:99999});
 assert.equal(future.baseline,true);assert.deepEqual(future.events,[]);
});

test('Voice endpoint retains staff authentication, schedule restrictions, read-only methods and strict cursor validation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.response(undefined,'bad-session')).status,401);
 for(const token of ['owner','staff','waiter'])assert.equal((await f.response(undefined,token)).status,200);
 f.admin.db.exec('UPDATE schedule_access_policy SET enabled=1');
 assert.equal((await f.response(undefined,'staff')).status,401);
 assert.equal((await f.response(undefined,'waiter')).status,401);
 f.admin.db.exec('UPDATE schedule_access_policy SET enabled=0');
 for(const method of ['POST','PUT','DELETE'])assert.equal((await f.response(undefined,'owner',{method})).status,405);
 const first=await f.read();
 for(const cursor of [{scope:first.cursor.scope},{...first.cursor,cafe:-1},{...first.cursor,task:'1.2'},{...first.cursor,booking:9007199254740992},{...first.cursor,scope:'x'},{...first.cursor,cafe:'1 OR 1=1'}])assert.equal((await f.response(cursor)).status,400);
 const head=await f.response(undefined,'owner',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
});

test('Actual controller and voice helper consume the real HTTP feed and do not replay after reload',async t=>{
 const f=await fixture(t),data=new Map(),spoken=[];
 const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
 const load=()=>{
  const timers=[],win={STARTStationSession:{authenticated:true},addEventListener(){},speechSynthesis:{getVoices:()=>[],speak:speech=>spoken.push(speech)},SpeechSynthesisUtterance:class{}};
  win.top=win;
  const document={hidden:false,visibilityState:'visible',hasFocus:()=>true,addEventListener(){}};
  const context={window:win,parent:win,document,navigator:{},localStorage:storage,sessionStorage:storage,URLSearchParams,AbortController,
   fetch:(url,options)=>{assert.ok(url.startsWith('/api/admin/voice-events'));const params=Object.fromEntries(new URL(url,'http://localhost').searchParams);return f.response(params,'owner',options);},
   setTimeout:(fn,ms)=>{const timer={fn,ms,cleared:false};timers.push(timer);return timer;},clearTimeout:timer=>{timer.cleared=true;}};
  for(const name of ['terminal-voice.js','voice-alerts.js'])runInNewContext(readFileSync(new URL('../dist/admin/'+name,import.meta.url),'utf8'),context);
  return timers;
 };
 const until=async condition=>{const end=Date.now()+3000;while(!condition()){if(Date.now()>end)throw Error('Timed out waiting for voice feed');await new Promise(r=>setImmediate(r));}};
 const timers=load();await until(()=>data.has('start-voice-alert-cursor-v1'));assert.equal(spoken.length,0);
 f.createOrder();f.createTask();f.createBooking();
 const poll=timers.find(timer=>timer.ms===5000&&!timer.cleared);assert.ok(poll);poll.fn();
 await until(()=>spoken.length===3);
 assert.deepEqual(spoken.map(speech=>speech.text),['Поступил заказ с сайта','Новое дело','Новая бронь']);
 spoken.forEach(speech=>speech.onend());
 const reloaded=load();await until(()=>reloaded.some(timer=>timer.ms===5000&&!timer.cleared));assert.equal(spoken.length,3);
});
