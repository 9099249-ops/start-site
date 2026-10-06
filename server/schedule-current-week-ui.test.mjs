import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const script=await readFile(new URL('../dist/admin/schedule.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div'){this.tagName=tag;this.children=[];this.attributes={};this.className='';this.textContent='';this.disabled=false;this.hidden=false;this.listeners={};this.options=[];}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
 setAttribute(k,v){this.attributes[k]=v;}
 addEventListener(k,fn){this.listeners[k]=fn;}
 querySelectorAll(){return [];}
 showModal(){} close(){this.listeners.close?.();}
 get classList(){return {contains:name=>this.className.split(' ').includes(name)};}
}
function fixture(now,today){
 const nodes=new Map(),requests=[],document={hidden:false,querySelector:s=>{if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s);},createElement:t=>new Element(t),addEventListener(){}};
 const FixedDate=class extends Date{static now(){return now;}};
 const people=[{id:1,name:'Admin'},{id:2,name:'Worker'},{id:3,name:'Relief'}],rows=['approved','want','cannot'].map((preference,i)=>({user_id:people[i].id,day:today,preference,confirmed:preference==='approved'?1:0}));
 const payload={today,user:{id:1,role:'admin'},people,rows};
 const context={document,Date:FixedDate,URL,fetch:async url=>{requests.push(url);return {ok:true,json:async()=>payload};},setInterval(){},console};
 runInNewContext(script,context);
 return {nodes,requests,payload};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function descendants(node){return [node,...node.children.flatMap(descendants)];}
test('schedule opens on current Moscow Monday week and highlights today in desktop and mobile views',async()=>{
 const f=fixture(Date.parse('2026-10-04T21:30:00Z'),'2026-10-05');await settle();
 assert.match(f.requests[0],/week=2026-10-05$/);
 const all=descendants(f.nodes.get('#schedule-grid'));
 const headers=all.filter(n=>n.attributes['aria-current']==='date');assert.equal(headers.length,2);
 const cells=all.filter(n=>n.classList.contains('schedule-cell'));
 assert.equal(cells.filter(n=>n.classList.contains('today')).length,6);
 assert.ok(cells.some(n=>n.classList.contains('today')&&n.classList.contains('approved')));
 assert.ok(cells.some(n=>n.classList.contains('today')&&n.classList.contains('wanted')));
 assert.ok(cells.some(n=>n.classList.contains('today')&&n.classList.contains('unavailable')));
 assert.equal(cells.filter(n=>n.classList.contains('today')).every(n=>n.disabled===false),true);
 assert.equal(all.filter(n=>n.attributes['aria-current']==='date').every(n=>n.className==='today'),true);
});
test('week controls navigate by whole weeks and next-week follows current Moscow Monday',async()=>{
 const f=fixture(Date.parse('2026-10-04T21:30:00Z'),'2026-10-05');await settle();
 f.nodes.get('#previous').onclick();await settle();assert.match(f.requests.at(-1),/week=2026-09-28$/);
 assert.equal(descendants(f.nodes.get('#schedule-grid')).filter(n=>n.classList.contains('today')).length,0);
 f.nodes.get('#next').onclick();await settle();assert.match(f.requests.at(-1),/week=2026-10-05$/);
 f.nodes.get('#next-week').onclick();await settle();assert.match(f.requests.at(-1),/week=2026-10-12$/);
 assert.equal(descendants(f.nodes.get('#schedule-grid')).filter(n=>n.classList.contains('today')).length,0);
 f.nodes.get('#this-week').onclick();await settle();assert.match(f.requests.at(-1),/week=2026-10-05$/);
 assert.equal(descendants(f.nodes.get('#schedule-grid')).filter(n=>n.classList.contains('today')).length,8);
});
test('Sunday before Moscow midnight still opens the ending week',async()=>{
 const f=fixture(Date.parse('2026-10-04T20:59:59Z'),'2026-10-04');await settle();
 assert.match(f.requests[0],/week=2026-09-28$/);
 const headers=descendants(f.nodes.get('#schedule-grid')).filter(n=>n.attributes['aria-current']==='date');
 assert.equal(headers.length,2);assert.ok(headers.every(n=>n.textContent.includes('4')));
 assert.equal(typeof f.nodes.get('#show-replacement').onclick,'function');
 assert.equal(typeof f.nodes.get('#replace-person').onclick,'function');
});
