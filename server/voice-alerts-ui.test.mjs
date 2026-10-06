import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/voice-alerts.js',import.meta.url),'utf8');
const scope='0123456789abcdef01234567',zero={scope,cafe:0,task:0,booking:0};
const response=(cursor,events=[],baseline=false)=>({ok:true,json:async()=>({cursor,events,baseline})});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({parent=true,focus=true,visible=true,locks,initial,fetcher,blockedStorage=false,separateStorage=false}={}){
 const handlers={},timers=[],calls=[],phrases=[],data=new Map();let pending=[];
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const sessionData=separateStorage?new Map():data,sessionStore={getItem:k=>sessionData.get(k)??null,setItem:(k,v)=>sessionData.set(k,v),removeItem:k=>sessionData.delete(k)};
 const document={hidden:!visible,visibilityState:visible?'visible':'hidden',hasFocus:()=>focus,addEventListener:(n,f)=>(handlers['d:'+n]??=[]).push(f),dispatchEvent(e){for(const f of handlers['d:'+e.type]||[])f(e);}};
 const window={top:null,STARTTerminalVoice:{notify:(e,s)=>{phrases.push([e,s]);return true;}},...(initial!==false&&parent?{STARTStationSession:{authenticated:true}}:{}),addEventListener:(n,f)=>(handlers['w:'+n]??[]).push(f)};window.top=parent?window:{};
 const fetch=async(url,opts)=>{calls.push({url,opts});if(fetcher)return fetcher(url,opts,calls.length);return pending.shift()||response(zero);};
 const blocked={getItem(){throw Error('Storage blocked');},setItem(){throw Error('Storage blocked');},removeItem(){throw Error('Storage blocked');}};
 const context={window,document,localStorage:blockedStorage?blocked:storage,sessionStorage:blockedStorage?blocked:sessionStore,fetch,navigator:{...(locks?{locks}:{})},URLSearchParams,AbortController,setTimeout:(f,ms)=>{const t={f,ms,cleared:false};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cleared=true;},};
 runInNewContext(source,context);
 const event=(type,detail)=>document.dispatchEvent({type,detail});
 return {calls,phrases,data,sessionData,timers,event,handlers,storage,setFocus(v){focus=v;},setVisible(v){visible=v;document.hidden=!v;document.visibilityState=v?'visible':'hidden';},set pending(v){pending=v;},source};
}
const cursor=(c,t,b)=>({scope,cafe:c,task:t,booking:b});

test('First response establishes a silent baseline; three later event kinds reach voice helper',async()=>{
 let n=0;const f=fixture({fetcher:async()=>++n===1?response(cursor(5,8,3),[],true):response(cursor(6,9,4),[{kind:'cafe_order',id:6},{kind:'task',id:9},{kind:'booking',id:4}])});
 await flush();assert.equal(f.calls.length,1);assert.equal(new URL(f.calls[0].url,'https://local').search,'');assert.equal(f.phrases.length,0);
 f.timers.find(t=>t.ms===5000).f();await flush();
 assert.deepEqual(f.phrases.map(x=>x[0].kind),['cafe_order','task','booking']);assert.ok(f.phrases.every(x=>x[1]===scope));
 assert.match(f.calls[1].url,/[?]scope=0123456789abcdef01234567&cafe=5&task=8&booking=3$/);
 assert.deepEqual(JSON.parse(f.data.get('start-voice-alert-cursor-v1')),cursor(6,9,4));
});

test('Saved cursor survives reload and repeated status updates never replay IDs',async()=>{
 const data=new Map([['start-voice-alert-cursor-v1',JSON.stringify(cursor(2,3,4))]]);let n=0;
 const f=fixture({initial:false,fetcher:async()=>{n++;return response(cursor(2,3,4),[{kind:'cafe_order',id:2}]);}});for(const [k,v] of data)f.data.set(k,v);
 f.event('station-session',{authenticated:true,scope,scheduleOnly:false});await flush();assert.equal(f.phrases.length,0);
 f.event('station-updated');await flush();assert.equal(f.phrases.length,0);assert.equal(n,2);
});

test('Non-OK, network errors, and malformed payloads do not advance the stored cursor',async()=>{
 for(const bad of [{ok:false},{ok:true,json:async()=>({cursor:{...zero,cafe:-1},baseline:false,events:[]})},{ok:true,json:async()=>({cursor:zero,baseline:false,events:[{kind:'task',id:1}]})}]){
  const f=fixture({fetcher:async()=>bad});await flush();assert.equal(f.data.has('start-voice-alert-cursor-v1'),false);assert.equal(f.phrases.length,0);
 }
 const f=fixture({fetcher:async()=>{throw Error('offline');}});await flush();assert.equal(f.phrases.length,0);
});

test('Unauthorized and schedule-only sessions stop requests; explicit logout clears history and relogin starts fresh',async()=>{
 let count=0;const f=fixture({initial:false,fetcher:async()=>{count++;return response(cursor(1,0,0));}});
 f.event('station-session',{authenticated:true,scope,scheduleOnly:true});await flush();assert.equal(count,0);
 f.event('station-session',{authenticated:true,scope,scheduleOnly:false});await flush();assert.equal(count,1);
 f.event('station-session',{authenticated:false});assert.equal(f.data.has('start-voice-alert-cursor-v1'),false);
 f.event('station-session',{authenticated:true,scope,scheduleOnly:false});await flush();assert.equal(count,2);assert.equal(f.phrases.length,0);
});

test('Embedded controllers, hidden documents, and blurred windows do not fetch',async()=>{
 for(const opts of [{parent:false},{visible:false},{focus:false}]){const f=fixture(opts);await flush();assert.equal(f.calls.length,0);}
 const f=fixture({focus:false});f.setFocus(true);for(const h of f.handlers['w:focus']||[])h();f.event('station-session',{authenticated:true,scope,scheduleOnly:false});await flush();assert.equal(f.calls.length,1);
 f.setVisible(false);for(const h of f.handlers['d:visibilitychange']||[])h();assert.equal(f.timers.filter(t=>t.ms===5000&&!t.cleared).length,0);
});

test('A delayed older response cannot rewind a cursor or replay an already consumed event',async()=>{
 let release;const f=fixture({initial:false,fetcher:async()=>new Promise(resolve=>{release=resolve;})});
 f.data.set('start-voice-alert-cursor-v1',JSON.stringify(cursor(7,2,1)));
 f.event('station-session',{authenticated:true,scope,scheduleOnly:false});await flush();
 f.data.set('start-voice-alert-cursor-v1',JSON.stringify(cursor(9,2,1)));
 release(response(cursor(8,2,1),[{kind:'cafe_order',id:8}]));await flush();
 assert.deepEqual(JSON.parse(f.data.get('start-voice-alert-cursor-v1')),cursor(9,2,1));assert.equal(f.phrases.length,0);
});

test('Unavailable cross-tab lock skips the fetch and schedules a retry',async()=>{
 let callback;const locks={request:async(_name,_opts,fn)=>{callback=fn;await fn(null);}};
 const f=fixture({locks});await flush();assert.equal(f.calls.length,0);assert.ok(f.timers.some(t=>t.ms===5000&&!t.cleared));assert.equal(typeof callback,'function');
});

test('A browser that exposes but rejects Web Locks still uses the focused-tab fallback',async()=>{
 const f=fixture({locks:{request:async()=>{throw Error('Lock API unavailable');}}});
 await flush();assert.equal(f.calls.length,1);assert.equal(f.phrases.length,0);
 assert.ok(f.timers.some(t=>t.ms===5000&&!t.cleared));
});

test('Authentication needs no client-provided scope; a replacement server scope resets silently',async()=>{
 const nextScope='abcdef0123456789abcdef01';let n=0;
 const f=fixture({fetcher:async()=>++n===1?response(cursor(2,0,0),[],true):response({scope:nextScope,cafe:3,task:0,booking:0},[],true)});
 await flush();assert.equal(f.calls.length,1);
 f.event('station-session',{authenticated:true});await flush();
 assert.equal(JSON.parse(f.data.get('start-voice-alert-cursor-v1')).scope,nextScope);
 assert.equal(f.phrases.length,0);
});

test('401/403 responses clear state and stop retries until a new authenticated session event',async()=>{
 for(const status of [401,403]){
  let n=0;const f=fixture({initial:false,fetcher:async()=>++n===1?{ok:false,status}:response(zero,[],true)});
  f.data.set('start-voice-alert-cursor-v1',JSON.stringify(zero));
  f.event('station-session',{authenticated:true});await flush();
  assert.equal(f.data.has('start-voice-alert-cursor-v1'),false);
  assert.equal(f.timers.filter(t=>t.ms===5000&&!t.cleared).length,0);
  f.event('station-session',{authenticated:true});await flush();assert.equal(n,2);
 }
});

test('Blocked storage uses an in-memory cursor without replay within the current page',async()=>{
 let n=0;const f=fixture({blockedStorage:true,fetcher:async()=>++n===1?response(cursor(1,0,0),[],true):response(cursor(2,0,0),[{kind:'cafe_order',id:2}])});
 await flush();f.timers.filter(t=>t.ms===5000&&!t.cleared).at(-1).f();await flush();
 assert.equal(f.phrases.length,1);assert.match(f.calls[1].url,/cafe=1/);
 f.timers.filter(t=>t.ms===5000&&!t.cleared).at(-1).f();await flush();
 assert.equal(f.phrases.length,1);assert.match(f.calls[2].url,/cafe=2/);
});

test('Shared cursor is authoritative and a server baseline replaces stale fallback storage too',async()=>{
 const f=fixture({initial:false,separateStorage:true,fetcher:async()=>response(cursor(3,0,0),[],true)});
 f.data.set('start-voice-alert-cursor-v1',JSON.stringify(cursor(2,0,0)));
 f.sessionData.set('start-voice-alert-cursor-v1',JSON.stringify(cursor(99,0,0)));
 f.event('station-session',{authenticated:true});await flush();
 assert.match(f.calls[0].url,/cafe=2/);
 assert.equal(JSON.parse(f.sessionData.get('start-voice-alert-cursor-v1')).cafe,3);
 f.event('station-updated');await flush();assert.match(f.calls[1].url,/cafe=3/);
 assert.equal(f.phrases.length,0);
});
