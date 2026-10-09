import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../dist/admin/ops-nav.js',import.meta.url),'utf8');
for(const path of ['/admin/','/admin/cafe/','/admin/purchase/','/admin/tasks/','/admin/workforce/'])test('Cafe badge on '+path,async()=>{
 const elements=[],handlers={},timers=[];let rows=[{status:'NEW'},{status:'READY'},{status:'DELIVERED'},{status:'CANCELLED'}],calls=0;
 const node=()=>{const n={children:[],textContent:'',setAttribute(){},append(...x){this.children.push(...x)},prepend(...x){this.children.unshift(...x)},classList:{toggle(){},add(){}},querySelector(){return this.children.find(x=>x.href==='/admin/cafe/')}};elements.push(n);return n;};
 const document={hidden:false,createElement:node,querySelector:()=>null,body:node(),documentElement:{style:{setProperty(){}}},addEventListener:(n,f)=>(handlers[n]??=[]).push(f),dispatchEvent(e){for(const f of handlers[e.type]||[])f(e)}};
 vm.runInNewContext(source,{document,location:{pathname:path,search:''},URLSearchParams,ResizeObserver:class{observe(){}},CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail}},setInterval:(f,ms)=>timers.push({f,ms}),fetch:async url=>{if(url.endsWith('/session'))return {ok:true,json:async()=>({user:{id:1}})};calls++;return {ok:true,json:async()=>({count:rows.filter(x=>['NEW','ACCEPTED','COOKING','READY'].includes(x.status)).length})}}});
 const flush=()=>new Promise(r=>setImmediate(r));await flush();const link=elements.find(e=>e.href==='/admin/cafe/');assert.equal(link.textContent,'Кафе · 2');rows=[];document.dispatchEvent({type:'station-updated'});await flush();assert.equal(link.textContent,'Кафе');document.hidden=true;const before=calls;timers.find(t=>t.ms===15000).f();await flush();assert.equal(calls,before);document.hidden=false;rows=[{status:'COOKING'}];document.dispatchEvent({type:'visibilitychange'});await flush();assert.equal(link.textContent,'Кафе · 1');
});
