import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../dist/admin/ops-nav.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture({path='/admin/',frame=false,user={id:1,role:'admin'},session=()=>({ok:true,user}),badge=()=>({ok:true,count:0})}={}){
 const elements=[],handlers={},timers=[],calls=[];
 const node=()=>{const n={children:[],attributes:{},className:'',textContent:'',hidden:false,href:'',append(...items){this.children.push(...items)},prepend(...items){this.children.unshift(...items)},setAttribute(k,v){this.attributes[k]=String(v)},removeAttribute(k){delete this.attributes[k]},getAttribute(k){return this.attributes[k]},classList:{toggle(){},add(name){n.className+=(n.className?' ':'')+name},remove(name){n.className=n.className.split(' ').filter(x=>x!==name).join(' ')}},querySelector(selector){return this.children.find(x=>selector==='.ops-tasks-link'?x.className?.includes('ops-tasks-link'):selector==='a[href="/admin/cafe/#new"]'?x.href==='/admin/cafe/#new':false)}};elements.push(n);return n;};
 const document={hidden:false,createElement:node,querySelector:()=>null,head:node(),body:node(),documentElement:{style:{setProperty(){}}},addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),dispatchEvent(e){for(const fn of handlers[e.type]||[])fn(e)}};
 const window={location:{replace(){}}};const context={document,window,parent:frame?{}:window,location:{pathname:path,search:'',replace(){}},URLSearchParams,ResizeObserver:class{observe(){}},CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail}},setInterval:(fn,ms)=>timers.push({fn,ms}),fetch:async(url,opts)=>{calls.push({url,opts});if(url.endsWith('/session')){const result=await session();return {ok:result.ok!==false,status:result.status||200,json:async()=>({user:result.user})};}if(url.endsWith('/tasks/badge')){const result=await badge();return {ok:result.ok!==false,status:result.status||200,json:async()=>({count:result.count})};}return {ok:true,status:200,json:async()=>({count:0})}}};
 vm.runInNewContext(source,context);
 return {document,window,elements,handlers,timers,calls,get taskLink(){return elements.find(e=>e.href==='/admin/tasks/')},get count(){return elements.find(e=>e.className==='ops-task-count')},get cafeLink(){return elements.find(e=>e.href==='/admin/cafe/#new')}};
}

test('task badge renders exact positive counts and hides zero without replacing its DOM node',async()=>{
 let value=0;const f=fixture({badge:async()=>({count:value})});await flush();const badge=f.count,link=f.taskLink;
 assert.equal(link.textContent,'Дела');assert.equal(badge.hidden,true);
 for(const count of [3,100,0]){value=count;f.document.dispatchEvent({type:'station-updated'});await flush();assert.equal(f.count,badge);assert.equal(badge.textContent,String(count));assert.equal(badge.hidden,count===0);assert.equal(link.getAttribute('aria-label'),count?'Дела: невыполненных дел — '+count:undefined);}
});

test('task badge only fetches for eligible authenticated top windows and hides on errors',async()=>{
 const f=fixture({user:{id:1,role:'admin'},badge:async()=>({count:3})});await flush();assert.equal(f.count.hidden,false);assert.equal(f.calls.filter(c=>c.url.endsWith('/tasks/badge')).length,1);
 f.document.hidden=true;const before=f.calls.length;f.timers.filter(t=>t.ms===15000).forEach(t=>t.fn());await flush();assert.equal(f.calls.length,before);
 f.document.hidden=false;f.document.dispatchEvent({type:'visibilitychange'});await flush();
 const initial=f.calls.filter(c=>c.url.endsWith('/tasks/badge')).length;
 const framed=fixture({frame:true});await flush();assert.equal(framed.calls.some(c=>c.url.endsWith('/tasks/badge')),false);
 const schedule=fixture({user:{id:2,role:'staff',scheduleOnly:true}});await flush();assert.equal(schedule.calls.some(c=>c.url.endsWith('/tasks/badge')),false);
 const denied=fixture({badge:async()=>({ok:false,status:403})});await flush();assert.equal(denied.count.hidden,true);
 const failed=fixture({badge:async()=>{throw Error('offline');}});await flush();assert.equal(failed.count.hidden,true);assert.ok(initial>=1);
});

test('late badge responses cannot restore another user session or an unauthorized session',async()=>{
 const pending=deferred();let currentUser={id:1,role:'admin'},sessionOk=true,badges=0;const f=fixture({session:()=>({ok:sessionOk,user:currentUser}),badge:()=>++badges===1?pending.promise:Promise.resolve({count:3})});await flush();const sessionTimer=f.timers.find(t=>t.ms===60000);
 currentUser={id:2,role:'staff'};sessionTimer.fn();await flush();
 pending.resolve({count:100});await flush();assert.equal(f.count.textContent,'3');
 sessionOk=false;sessionTimer.fn();await flush();assert.equal(f.count.hidden,true);assert.equal(f.count.textContent,'');
});

test('same-user schedule-only transitions revoke and restore task badge polling',async()=>{
 let user={id:4,role:'staff',scheduleOnly:false},calls=0;const f=fixture({path:'/admin/schedule/',session:()=>({ok:true,user}),badge:async()=>({count:++calls})});await flush();assert.equal(f.count.hidden,false);
 user={...user,scheduleOnly:true};f.timers.find(t=>t.ms===60000).fn();await flush();assert.equal(f.count.hidden,true);const deniedAt=calls;
 user={...user,scheduleOnly:false};f.timers.find(t=>t.ms===60000).fn();await flush();assert.equal(calls,deniedAt+1);assert.equal(f.count.hidden,false);
 const missingRole=fixture({user:{id:5}});await flush();assert.equal(missingRole.calls.some(c=>c.url.endsWith('/tasks/badge')),false);
});

test('successful logout invalidates an in-flight badge response immediately',async()=>{
 const pending=deferred(),f=fixture({badge:()=>pending.promise});await flush();
 const logout=f.elements.find(e=>e.id==='logout');await logout.onclick();pending.resolve({count:99});await flush();assert.equal(f.count.hidden,true);assert.equal(f.count.textContent,'');
});

test('task API wrapper emits station-updated only after successful writes',async()=>{
 const taskSource=readFileSync(new URL('../dist/admin/tasks.js',import.meta.url),'utf8'),apiSource=taskSource.match(/async function api\([^\n]+/)[0],events=[];let ok=true;
 const context={fetch:async(_url,options)=>({ok,json:async()=>({}),...options}),document:{dispatchEvent:event=>events.push(event.type)},Event:class{constructor(type){this.type=type}}};
 await vm.runInNewContext(`${apiSource};api('',null)`,context);assert.deepEqual(events,[]);
 await vm.runInNewContext(`${apiSource};api('/complete',{})`,context);assert.deepEqual(events,['station-updated']);events.length=0;context.fetch=async()=>({ok:false,json:async()=>({error:'failed'})});
 await assert.rejects(vm.runInNewContext(`${apiSource};api('/complete',{})`,context));assert.deepEqual(events,[]);
});

test('task navigation keeps voice and cafe badge loading intact',async()=>{
 const f=fixture({badge:async()=>({count:0})});await flush();assert.equal(f.window.STARTStationSession.authenticated,true);assert.ok(f.elements.some(e=>e.src==='/admin/voice-alerts.js?v=voice-alerts-20261006-1'));assert.ok(f.calls.some(c=>c.url.endsWith('/api/admin/cafe/badge')));
});
