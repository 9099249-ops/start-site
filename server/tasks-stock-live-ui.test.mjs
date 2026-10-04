import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const tasks=readFileSync(new URL('../dist/admin/tasks.js',import.meta.url),'utf8');
const purchase=readFileSync(new URL('../dist/admin/purchase.js',import.meta.url),'utf8');
test('task boundary rereads server and clears completed filter even when list length stays unchanged',async()=>{
 const fields=[{dataset:{filter:'open'},setAttribute(k,v){this[k]=v;}},{dataset:{filter:'done'},setAttribute(k,v){this[k]=v;}}];
 let clock=1000,callback,delay,reads=0,renders=0;
 const context={items:[{kind:'during',period:'day@10',completed_at:1,nextResetAt:2000}],filter:'done',kind:'during',loading:false,drag:null,mutating:false,lastRead:0,lastSignature:'old',resetTimer:undefined,Date:{now:()=>clock},setTimeout:(fn,ms)=>{callback=fn;delay=ms;return 1;},clearTimeout:()=>{},api:async()=>{reads++;return {items:[{kind:'during',period:'day@12',completed_at:null,nextResetAt:7202000}]};},render:()=>renders++,notice:()=>{},CustomEvent:class{},document:{hidden:false,querySelectorAll:()=>fields,dispatchEvent:()=>{}}};
 vm.runInNewContext(tasks.split(/\r?\n/).filter(l=>l.startsWith('function scheduleReset(')||l.startsWith('async function load(')).join('\n'),context);
 context.scheduleReset();assert.equal(delay,1050);clock=2050;callback();await new Promise(r=>setImmediate(r));
 assert.equal(reads,1);assert.equal(renders,1);assert.equal(context.items[0].completed_at,null);assert.equal(context.filter,'open');assert.equal(fields[0]['aria-pressed'],'true');
 context.document.hidden=true;callback();assert.equal(reads,1);
});
test('stock reread updates the open read-only detail, preserving edit dialogs',async()=>{
 let detailItem,fetches=0;const elements=new Map([['#item-dialog',{open:true}],['#add-item',{}],['#read-only',{}],['#notice',{}]]);
 const context={busy:false,chosen:{id:20,current:'13'},api:async()=>{fetches++;return {canCreate:false,canAdjust:true,items:[{id:20,current:'12.5'}]};},dictionaries:()=>{},render:()=>{},detail:item=>{detailItem=context.catalog.items.find(i=>i.id===item.id);},$:s=>elements.get(s)};
 vm.runInNewContext(purchase.split(/\r?\n/).find(l=>l.startsWith(' async function load(')),context);
 await context.load();assert.equal(fetches,1);assert.equal(detailItem.current,'12.5');
 assert.match(purchase,/dialog\[open\]:not\(#item-dialog\)/);
 assert.match(purchase,/addEventListener\('visibilitychange',refresh\)/);
 assert.match(purchase,/addEventListener\('station-updated',refresh\)/);
});
