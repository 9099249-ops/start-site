import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Script,runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const folder=new URL('../dist/admin/',import.meta.url);

test('Every shipped admin script parses before publication',()=>{
  for(const name of readdirSync(folder).filter(n=>n.endsWith('.js'))){
    assert.doesNotThrow(()=>new Script(readFileSync(new URL(name,folder),'utf8'),{filename:name}),name);
  }
});

function bootFixture(){
  const panels=Object.fromEntries(['workspace','login-panel','setup-panel','admin-load-error'].map(id=>[id,{hidden:true}]));
  const listeners={},timers=[];let reloads=0,changed;
  const button={addEventListener:(name,fn)=>{listeners['button:'+name]=fn;}};
  runInNewContext(readFileSync(new URL('boot.js',folder),'utf8'),{
    document:{querySelector:s=>s==='#admin-reload'?button:panels[s.slice(1)],getElementById:id=>panels[id]},
    window:{addEventListener:(name,fn)=>{listeners[name]=fn;}},
    location:{reload:()=>reloads++},setTimeout:fn=>timers.push(fn),
    MutationObserver:class{constructor(fn){changed=fn;}observe(){}}
  });
  return {panels,listeners,timers,changed:()=>changed(),reloads:()=>reloads};
}

test('A failed admin script reveals recovery instead of a blank station screen',()=>{
  const f=bootFixture();f.listeners.error({filename:'https://spotsup.ru/admin/app.js'});
  assert.equal(f.panels['admin-load-error'].hidden,false);
  f.listeners['button:click']();assert.equal(f.reloads(),1);
  f.panels['login-panel'].hidden=false;f.changed();
  assert.equal(f.panels['admin-load-error'].hidden,true);
});

test('Slow startup has recovery, but a loaded login or workspace never shows it',()=>{
  const f=bootFixture();f.timers[0]();assert.equal(f.panels['admin-load-error'].hidden,false);
  f.panels.workspace.hidden=false;f.changed();f.listeners.unhandledrejection({});
  assert.equal(f.panels['admin-load-error'].hidden,true);
});

async function workBarFixture(failFirst=false){
 class Element{constructor(){this.children=[];this.textContent='';this.hidden=false;this.classList={add(){},remove(){},toggle(){}};}append(...a){this.children.push(...a);}after(e){this.afterElement=e;}setAttribute(){}replaceChildren(...a){this.children=a;}}
 const nav=new Element(),posts=[],snap={own:null,user:{login:'matthew'},active:[]};let reject=failFirst;
 runInNewContext(readFileSync(new URL('work-bar.js',folder),'utf8'),{document:{hidden:false,querySelector:()=>nav,createElement:()=>new Element(),body:new Element(),addEventListener(){},dispatchEvent(){}},Event,AbortController,Uint8Array,crypto:{getRandomValues:a=>webcrypto.getRandomValues(a)},localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:false}),setInterval(){},setTimeout(){},clearTimeout(){},fetch:async(url,options={})=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));if(reject){reject=false;throw Error('Связь прервалась');}snap.own={id:123,started_at:Date.now()};return {ok:true,json:async()=>snap.own};}return {ok:true,json:async()=>structuredClone(snap)};}});
 await new Promise(r=>setImmediate(r));return {action:nav.afterElement.children[0],error:nav.afterElement.children[5],posts};
}
test('Work button preserves the error after refresh and reuses the request after a lost response',async()=>{
 const f=await workBarFixture(true);await f.action.onclick();assert.match(f.error.textContent,/Связь прервалась/);assert.equal(f.action.disabled,false);await f.action.onclick();assert.equal(f.posts.length,2);assert.equal(f.posts[0].requestId,f.posts[1].requestId);assert.match(f.posts[0].requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.equal(f.action.textContent,'Ушёл со смены');assert.match(f.error.textContent,/Время прихода сохранено/);
});
test('Work button works without randomUUID and ignores duplicate taps',async()=>{const f=await workBarFixture();await Promise.all([f.action.onclick(),f.action.onclick()]);assert.equal(f.posts.length,1);assert.equal(f.action.textContent,'Ушёл со смены');});
