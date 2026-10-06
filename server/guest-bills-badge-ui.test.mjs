import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../dist/admin/pos-chrome.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture({path='/admin/',frame=false,fetcher}={}){
 const handlers={},timers=[],calls=[],all=[];
 const node=(tagName='DIV')=>{const n={tagName,children:[],attributes:{},style:{setProperty(){}},className:'',textContent:'',hidden:false,disabled:false,dataset:{},append(...items){this.children.push(...items)},setAttribute(k,v){this.attributes[k]=String(v)},removeAttribute(k){delete this.attributes[k]},getAttribute(k){return this.attributes[k]},classList:{add(name){n.className+=(n.className?' ':'')+name},contains(name){return n.className.split(' ').includes(name)},toggle(name,on){n.className=n.className.split(' ').filter(x=>x!==name).join(' ');if(on)n.className+=(n.className?' ':'')+name}},querySelector(selector){if(selector==='.work-account-print')return this.children.find(x=>x.className==='work-account-print')||null;return null},querySelectorAll(){return []}};all.push(n);return n;};
 const bar=node();bar.className='work-bar';bar.children=[node('BUTTON'),node('SPAN')];bar.querySelector=()=>null;
 const body=node();body.classList={add(){},toggle(){}};
 const document={hidden:false,body,documentElement:{style:{setProperty(){}}},createElement:node,querySelector:s=>s==='.work-bar'?bar:s==='#workspace-frames'?null:null,addEventListener:(n,f)=>(handlers[n]??=[]).push(f),dispatchEvent(e){for(const f of handlers[e.type]||[])f(e)}};
 const window={STARTGuests:{show(){}}};const response=async url=>{calls.push(url);if(fetcher)return fetcher(url);return {ok:true,status:200,json:async()=>url.endsWith('cash-ledger')?{shift:null,balanceCents:0}:{count:0}};};
 const context={document,window,parent:frame?{}:window,location:{pathname:path,search:''},URLSearchParams,ResizeObserver:class{observe(){}},MutationObserver:class{observe(){}},setInterval:(fn,ms)=>timers.push({fn,ms}),addEventListener:(n,f)=>(handlers[n]??=[]).push(f),setTimeout,clearTimeout,AbortController,fetch:(url,opts)=>{calls.push(url);return fetcher?fetcher(url,opts):Promise.resolve({ok:true,status:200,json:async()=>url.endsWith('cash-ledger')?{shift:null,balanceCents:0}:{count:0}})}};
 vm.runInNewContext(source,context);
 const footer=all.find(n=>n.tagName==='footer'),guestButton=footer?.children.find(n=>n.children.some(c=>c.textContent==='Счета гостей'));
 return {all,bar,body,document,handlers,timers,calls,guestButton,get badge(){return guestButton?.children.find(n=>n.className==='station-guest-count')},setPath(value){context.location.pathname=value;for(const f of handlers.popstate||[])f();}};
}

test('count transitions 0 to positive to 0 with stable action, badge node, label, and accessible count',async()=>{
 let count=0;const f=fixture({fetcher:async url=>({ok:true,status:200,json:async()=>url.endsWith('cash-ledger')?{shift:null,balanceCents:0}:{count}})});await flush();const button=f.guestButton,badge=f.badge;
 assert.ok(button);assert.equal(button.children.find(n=>n.textContent==='Счета гостей').textContent,'Счета гостей');assert.equal(badge.hidden,true);assert.equal(badge.getAttribute('aria-hidden'),'true');
 for(const value of [3,0]){count=value;f.document.dispatchEvent({type:'station-updated'});await flush();assert.equal(f.guestButton,button);assert.equal(f.badge,badge);assert.equal(badge.textContent,String(value));assert.equal(badge.hidden,value===0);assert.equal(button.getAttribute('aria-label'),value?'Счета гостей: '+value:undefined);}
});

test('cash and badge requests fail independently; bad, denied, and unauthenticated counts stay hidden',async()=>{
 let failCash=false,failGuest=false,unauthorized=false,guest={count:4};const f=fixture({fetcher:async url=>{if(url.endsWith('cash-ledger')){if(failCash)throw Error('cash unavailable');return {ok:true,json:async()=>({shift:null,balanceCents:100})};}if(failGuest)throw Error('guest unavailable');if(unauthorized)return {ok:false,status:401,json:async()=>({error:'unauthorized'})};return {ok:true,json:async()=>guest};}});await flush();assert.equal(f.badge.hidden,false);
 failCash=true;guest={count:2};f.document.dispatchEvent({type:'station-updated'});await flush();assert.equal(f.badge.textContent,'2');
 failCash=false;failGuest=true;f.document.dispatchEvent({type:'station-updated'});await flush();assert.equal(f.badge.hidden,true);
 failGuest=false;unauthorized=true;f.document.dispatchEvent({type:'station-updated'});await flush();assert.equal(f.badge.hidden,true);unauthorized=false;
 guest={count:-1};f.document.dispatchEvent({type:'station-updated'});await flush();assert.equal(f.badge.hidden,true);
 guest={count:2};f.document.dispatchEvent({type:'station-updated'});await flush();assert.equal(f.badge.hidden,false);f.document.dispatchEvent({type:'station-session',detail:{authenticated:false}});assert.equal(f.badge.hidden,true);assert.equal(f.badge.textContent,'');
});

test('hidden footer, hidden document, and iframe do not poll; location changes invalidate pending counts',async()=>{
 const pending=deferred();let usePending=true;const f=fixture({fetcher:url=>url.endsWith('cash-ledger')?Promise.resolve({ok:true,json:async()=>({shift:null})}):(usePending?pending.promise:Promise.resolve({ok:true,json:async()=>({count:8})}))});await flush();
 f.setPath('/admin/settings/');assert.equal(f.badge.hidden,true);usePending=false;f.setPath('/admin/');await flush();pending.resolve({ok:true,json:async()=>({count:9})});await flush();assert.equal(f.badge.textContent,'8');
 const before=f.calls.length;f.document.hidden=true;f.timers.find(t=>t.ms===30000).fn();await flush();assert.equal(f.calls.length,before);f.document.hidden=false;
 const hidden=fixture({path:'/admin/settings/'});await flush();assert.equal(hidden.calls.length,0);const framed=fixture({frame:true});await flush();assert.equal(framed.calls.length,0);
});

test('logout invalidates an in-flight count response and hides it immediately',async()=>{
 const pending=deferred(),f=fixture({fetcher:url=>url.endsWith('cash-ledger')?Promise.resolve({ok:true,json:async()=>({shift:null})}):pending.promise});await flush();f.document.dispatchEvent({type:'station-session',detail:{authenticated:false}});pending.resolve({ok:true,json:async()=>({count:99})});await flush();assert.equal(f.badge.hidden,true);assert.equal(f.badge.textContent,'');
});

test('badge fetch uses only the readonly badge path, never the guest list projection',async()=>{
 const f=fixture();await flush();const paths=f.calls.filter(url=>url.includes('guest-bills'));assert.deepEqual(paths,['/api/admin/guest-bills/badge']);assert.equal(paths.some(url=>url==='/api/admin/guest-bills'),false);
});
