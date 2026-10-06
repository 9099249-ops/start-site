import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {ACTIONS,EVENTS} from './ux-audit.mjs';

const source=await readFile(new URL('../dist/admin/ux-audit.js',import.meta.url),'utf8');
const EVENT_KEYS=['id','employee_session_id','scenario_id','event','screen','action','result','error_code','seq','elapsed_ms'].sort();
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i;
let uuidSequence=0;

function fixture({enabled=true,endsAt=Date.now()+60000,storage=new Map(),post=async()=>({ok:true}),pathname='/admin/cafe/'}={}){
 const documentListeners={},windowListeners={},posts=[],configCalls=[],timeouts=new Map();let interval,now=Date.now(),timerId=0;
 const config={enabled,endsAt};
 const sessionStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
 const ui={pathname,selectedTab:'compose',orderDialogOpen:false,paymentDialogOpen:false,paymentOptions:false,issueDialogOpen:false,issueSaving:false};
 const window={crypto:{randomUUID:()=>`00000000-0000-4000-8000-${(++uuidSequence).toString(16).padStart(12,'0')}`},sessionStorage,location:{pathname,search:'?phone=do-not-record'},
  addEventListener:(name,fn)=>windowListeners[name]=fn,setInterval:fn=>(interval=fn,1),clearInterval:()=>{interval=null;},setTimeout:(fn,ms)=>(timeouts.set(++timerId,{fn,ms}),timerId),clearTimeout:id=>timeouts.delete(id),
  fetch:async(url,options={})=>{if(url==='/api/admin/ux-audit/config'){configCalls.push(1);return {ok:true,json:async()=>({...config})};}if(url==='/api/admin/ux-audit/events'){posts.push({body:options.body,options});return post(options,posts.length);}throw Error('unexpected URL');}};
 const document={addEventListener:(name,fn)=>documentListeners[name]=fn,querySelector(selector){if(selector==='#order-dialog')return {open:ui.orderDialogOpen};if(selector==='[data-tab="orders"].selected')return ui.selectedTab==='orders'?{}:null;if(selector==='dialog.guest-dialog[open] .guest-bill-payment-actions,dialog.guest-dialog[open] .guest-manual-payment,.guest-panel .guest-bill-payment-actions,.guest-panel .guest-manual-payment')return ui.paymentDialogOpen&&ui.paymentOptions?{}:null;if(selector==='#issue-dialog')return {open:ui.issueDialogOpen};if(selector==='#issue-form')return {dataset:{saving:ui.issueSaving?'1':'',pendingRequest:''}};return null;}};
 class TestDate extends Date{static now(){return now;}}
 vm.runInNewContext(source,{window,document,Date:TestDate,TextEncoder,AbortController,Promise,WeakMap,Map,JSON,Object,Number,Array,Error});
 return {window,document,ui,documentListeners,windowListeners,posts,configCalls,timeouts,config,storage,get interval(){return interval;},set now(value){now=value;},get now(){return now;}};
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
async function drain(f,count=30){for(let i=0;i<count&&f.interval;i++){f.interval();await settle();}}

test('Disabled configuration never records or posts scenario events',async()=>{
 const f=fixture({enabled:false});assert.equal(await f.window.STARTUx.start('cafe'),false);assert.equal(f.window.STARTUx.event('click','click'),false);f.interval?.();await settle();
 assert.equal(f.posts.length,0);assert.equal(f.configCalls.length,1);
});

test('Empty queue does not poll config; enabled config is cached for at most 60 seconds',async()=>{
 const f=fixture({endsAt:Date.now()+600000});await f.window.STARTUx.start('cafe');
 f.interval();await settle();
 for(let i=0;i<15;i++){f.now+=3000;f.interval();await settle();}
 assert.equal(f.posts.length,1);assert.equal(f.configCalls.length,1);
 f.now+=15000;f.interval();await settle();assert.equal(f.configCalls.length,2);
});

test('Enabled start is synchronous for the bubbling click that follows it',async()=>{
 const f=fixture();await f.window.STARTUx.start('cafe');f.window.STARTUx.complete('cafe');await drain(f,8);
 const startPromise=f.window.STARTUx.start('cafe');const button={},target={closest:selector=>selector.includes('button')?button:null};
 f.documentListeners.click({target});assert.equal(typeof startPromise.then,'function');await startPromise;await drain(f,8);
 const events=f.posts.flatMap(post=>JSON.parse(post.body).events);
 const started=events.findLast(event=>event.event==='cafe_started'),click=events.findLast(event=>event.event==='click');
 assert.ok(started);assert.ok(click);assert.equal(click.scenario_id,started.scenario_id);
});

test('Projects anonymous event screens from active cafe and rental UI state',async()=>{
 const f=fixture();await f.window.STARTUx.start('cafe');
 const record=async()=>{f.window.STARTUx.event('click','click');f.interval();await settle();return JSON.parse(f.posts.at(-1).body).events.at(-1).screen;};
 assert.equal(await record(),'cafe_pos');
 f.ui.selectedTab='orders';assert.equal(await record(),'cafe_order');
 f.ui.selectedTab='guests';f.ui.paymentDialogOpen=true;f.ui.paymentOptions=true;assert.equal(await record(),'cafe_payment');
 f.window.location.pathname='/admin/';f.ui.issueDialogOpen=true;assert.equal(await record(),'rental_order');
 f.ui.issueSaving=true;assert.equal(await record(),'rental_payment');
 f.ui.issueDialogOpen=false;assert.equal(await record(),'rental_pos');
 for(const item of f.posts.flatMap(post=>JSON.parse(post.body).events))assert.ok(['cafe_pos','cafe_order','cafe_payment','rental_pos','rental_order','rental_payment'].includes(item.screen));
});

test('Rental extension and return are standalone whitelist events without starting a rental scenario',async()=>{
 assert.ok(EVENTS.includes('rental_extended')&&EVENTS.includes('rental_returned'));
 assert.ok(ACTIONS.includes('extend')&&ACTIONS.includes('return'));
 const f=fixture();
 assert.equal(await f.window.STARTUx.start('cafe'),true);
 assert.equal(f.window.STARTUx.event('rental_returned','return'),true);
 assert.equal(f.window.STARTUx.event('rental_extended','extend'),true);
 assert.equal(f.window.STARTUx.event('rental_item_added','add'),false);
 f.window.STARTUx.complete('cafe');await drain(f,10);
 const events=f.posts.flatMap(post=>JSON.parse(post.body).events);
 const standalone=events.filter(event=>event.event==='rental_returned'||event.event==='rental_extended');
 assert.deepEqual(standalone.map(event=>[event.event,event.action]),[['rental_returned','return'],['rental_extended','extend']]);
 assert.notEqual(standalone[0].scenario_id,standalone[1].scenario_id);
 assert.ok(standalone.every(event=>uuidPattern.test(event.scenario_id)));
 assert.equal(events.some(event=>event.event==='rental_started'),false);
});

test('Only fixed-schema anonymous values are serialized by observed interaction listeners',async()=>{
 const f=fixture();await f.window.STARTUx.start('cafe');
 const button={};const target={closest:selector=>selector.includes('button')?button:null};f.documentListeners.click({target});f.documentListeners.click({target});
 const input={matches:selector=>selector.includes('#menu-search'),get value(){throw Error('query read');}};f.documentListeners.input({target:input});[...f.timeouts.values()].find(timer=>timer.ms===500).fn();
 f.windowListeners.popstate();f.documentListeners.invalid({},true);await drain(f,8);
 assert.ok(f.posts.length>0);
 const serialized=f.posts.map(item=>item.body).join('\n');
 for(const post of f.posts){const payload=JSON.parse(post.body);assert.deepEqual(Object.keys(payload),['events']);assert.ok(payload.events.length<=4);for(const event of payload.events){assert.deepEqual(Object.keys(event).sort(),EVENT_KEYS);assert.match(event.id,uuidPattern);assert.match(event.employee_session_id,uuidPattern);assert.match(event.scenario_id,uuidPattern);assert.equal(event.screen,'cafe_pos');}}
 for(const forbidden of ['do-not-record','phone=','value','value','textContent','target','href','selector'])assert.equal(serialized.includes(forbidden),false,forbidden);
 assert.ok(serialized.includes('repeated_click'));assert.ok(serialized.includes('navigation_back'));assert.ok(serialized.includes('validation'));
});

test('Queue stays bounded and every request has at most four events and 4096 bytes',async()=>{
 const f=fixture();await f.window.STARTUx.start('rental');
 for(let i=0;i<90;i++)f.window.STARTUx.event('click','click');
 await drain(f,50);assert.ok(f.posts.length>0);
 let sent=0;for(const post of f.posts){const body=JSON.parse(post.body);assert.ok(body.events.length<=4);assert.ok(new TextEncoder().encode(post.body).length<=4096);sent+=body.events.length;}
 assert.ok(sent<=64);
});

test('A failed batch retries the same event IDs and stops when config is disabled',async()=>{
 let attempts=0;const f=fixture({endsAt:Date.now()+600000,post:async()=>{if(++attempts===1)throw Error('offline');return {ok:true};}});await f.window.STARTUx.start('cafe');
 f.window.STARTUx.event('click','click');f.interval();await settle();assert.equal(f.posts.length,1);
 f.now+=3000;f.interval();await settle();assert.equal(f.posts.length,2);
 assert.deepEqual(JSON.parse(f.posts[0].body).events.map(e=>e.id),JSON.parse(f.posts[1].body).events.map(e=>e.id));
 f.config.enabled=false;f.now+=60000;f.config.endsAt=f.now+60000;f.interval();await settle();assert.equal(await f.window.STARTUx.start('rental'),false);
 const sent=f.posts.length,checks=f.configCalls.length;assert.equal(f.window.STARTUx.event('click','click'),false);await settle();assert.equal(f.posts.length,sent);assert.equal(f.configCalls.length,checks);
});

test('A permanently failed batch is retried only three times',async()=>{
 const f=fixture({post:async()=>{throw Error('offline');}});await f.window.STARTUx.start('rental');
 f.window.STARTUx.event('click','click');
 for(let attempt=0;attempt<3;attempt++){f.interval();await settle();f.now+=3000;}
 assert.equal(f.posts.length,3);
 assert.deepEqual(JSON.parse(f.posts[0].body).events.map(e=>e.id),JSON.parse(f.posts[1].body).events.map(e=>e.id));
 assert.deepEqual(JSON.parse(f.posts[1].body).events.map(e=>e.id),JSON.parse(f.posts[2].body).events.map(e=>e.id));
 f.interval();await settle();assert.equal(f.posts.length,3);
});

test('Config and batch requests carry a five-second abort timeout',async()=>{
 let signal;
 const f=fixture({endsAt:Date.now()+600000,post:options=>{signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));}});
 await f.window.STARTUx.start('rental');f.window.STARTUx.event('click','click');f.interval();await settle();
 assert.ok(signal);assert.equal(signal.aborted,false);
 [...f.timeouts.values()].find(timer=>timer.ms===5000).fn();await settle();
 assert.equal(signal.aborted,true);assert.equal(f.posts.length,1);
});

test('Deadline ends collection; anonymous session identity rotates after 30 minutes idle',async()=>{
 const f=fixture();await f.window.STARTUx.start('cafe');f.window.STARTUx.event('click','click');f.interval();await settle();
 const first=JSON.parse(f.posts[0].body).events[0].employee_session_id;
 const later=fixture({storage:f.storage});await later.window.STARTUx.start('rental');later.window.STARTUx.event('click','click');later.interval();await settle();
 const retained=JSON.parse(later.posts[0].body).events[0].employee_session_id;assert.equal(retained,first);
 const idle=fixture({storage:f.storage});idle.now+=30*60*1000;idle.config.endsAt=idle.now+60000;await idle.window.STARTUx.start('rental');idle.window.STARTUx.event('click','click');idle.interval();await settle();
 const rotated=JSON.parse(idle.posts[0].body).events[0].employee_session_id;assert.notEqual(rotated,first);
 f.now=f.config.endsAt;f.interval();await settle();assert.equal(await f.window.STARTUx.start('rental'),false);
});

test('Idle rotation clears active scenarios so events cannot pair across sessions',async()=>{
 const f=fixture({endsAt:Date.now()+2*60*60*1000});await f.window.STARTUx.start('cafe');f.interval();await settle();
 const first=JSON.parse(f.posts[0].body).events[0].employee_session_id;
 f.now+=30*60*1000;assert.equal(f.window.STARTUx.event('click','click'),false);assert.equal(f.window.STARTUx.complete('cafe'),false);
 assert.equal(await f.window.STARTUx.start('cafe'),true);f.window.STARTUx.event('click','click');await drain(f,10);
 const events=f.posts.flatMap(post=>JSON.parse(post.body).events),fresh=events.filter(event=>event.employee_session_id!==first);
 assert.ok(fresh.some(event=>event.event==='cafe_started'));assert.ok(fresh.some(event=>event.event==='click'));
 assert.equal(new Set(fresh.map(event=>event.scenario_id)).size,1);
});
