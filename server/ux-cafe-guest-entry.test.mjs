import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('Cafe guest compatibility route remains available after the upper entry is removed',async()=>{
 const html=await read('dist/admin/cafe.html');
 const js=await read('dist/admin/cafe.js');
 assert.doesNotMatch(html,/<button[^>]*data-tab="guests"/);
 assert.match(html,/<section id="guests" class="screen" hidden>/);
 assert.match(js,/\['orders','compose','guests'/);
 assert.match(js,/querySelectorAll\('\[data-tab\]'\)\.forEach\(b=>b\.onclick=safe\(\(\)=>selectCafeTab\(b\.dataset\.tab\)\)\)/);
 assert.match(js,/STARTGuests\.show\(null,\$\('#guests'\)\)/);
});

test('Cafe guest tab hides only while a visible shared footer has its usable guest action',async()=>{
 const js=await read('dist/admin/cafe.js');
 assert.match(js,/footer\.querySelectorAll\('button'\)\]\.some\(b=>b\.textContent\.trim\(\)==='Счета гостей'/);
 assert.match(js,/!footer\.hidden&&doc\.defaultView\.getComputedStyle\(footer\)\.display!=='none'/);
 assert.match(js,/guestTab\.hidden=available/);
 assert.match(js,/if\(parent!==window\)docs\.push\(parent\.document\)/);
 assert.match(js,/observer\.observe\(footer,\{attributes:true,childList:true,subtree:true\}\)/);
 assert.match(js,/doc\.defaultView\?\.MutationObserver\|\|MutationObserver/);
});

function observerHarness(js,outerObserver){
 const start=js.indexOf('function watchSharedGuestEntry(doc){'),end=js.indexOf('\nwindow.STARTCafeDesk=',start);
 assert.ok(start>=0&&end>start,'guest-entry watcher is present');
 const context={MutationObserver:outerObserver,syncSharedGuestEntry(){}};
 vm.runInNewContext(js.slice(start,end)+';globalThis.watch=watchSharedGuestEntry;',context);
 return context.watch;
}

test('Guest-entry watcher uses the observed document realm for parent footer and root',async()=>{
 const js=await read('dist/admin/cafe.js'),outer=[],realm=[];
 class OuterObserver{constructor(callback){this.callback=callback;outer.push(this);}observe(target,options){this.target=target;this.options=options;}disconnect(){this.target=null;}}
 class RealmObserver{constructor(callback){this.callback=callback;realm.push(this);}observe(target,options){this.target=target;this.options=options;}disconnect(){this.target=null;}}
 const footer={},doc={defaultView:{MutationObserver:RealmObserver},body:{},documentElement:{},querySelector:()=>footer};
 observerHarness(js,OuterObserver)(doc);
 assert.equal(outer.length,0);assert.equal(realm.length,1);assert.equal(realm[0].target,footer);
});

test('Guest-entry watcher waits once when the document has no observable root yet',async()=>{
 const js=await read('dist/admin/cafe.js'),observed=[];let ready;
 class RealmObserver{constructor(callback){this.callback=callback;}observe(target,options){observed.push({target,options});}disconnect(){}}
 const doc={defaultView:{MutationObserver:RealmObserver},body:null,documentElement:null,querySelector:()=>null,addEventListener(type,callback,options){assert.equal(type,'DOMContentLoaded');assert.equal(options.once,true);ready=callback;}};
 observerHarness(js,RealmObserver)(doc);assert.equal(observed.length,0);assert.equal(typeof ready,'function');
 const body={};doc.body=body;ready();assert.equal(observed.length,1);assert.equal(observed[0].target,body);
});
