import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

class Element{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.dataset={};this.style={setProperty(name,value){this[name]=value;}};this.attributes={};this.listeners={};this.hidden=false;this.className='';this._text='';}
 set textContent(value){for(const child of this.children)child.parentElement=null;this.children=[];this._text=String(value??'');}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 append(...nodes){for(const node of nodes){if(node.parentElement)node.remove();node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const child of this.children)child.parentElement=null;this.children=[];this._text='';this.append(...nodes);}
 setAttribute(name,value){this.attributes[name]=String(value);}
 remove(){if(!this.parentElement)return;this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
}
function walk(node){return [node,...node.children.flatMap(walk)];}
const fresh=(overrides={})=>({name:'Тяговый',socPercent:72,online:true,stale:false,bmsConnected:true,state:'discharging',estimatedMinutes:95,estimatedChargeMinutes:80,...overrides});
const overview=(devices,label='Сашин',trip=null)=>({now:100000,catamarans:[{label,devices,trip}]});
async function mount({data,errorStatus}={}){
 const nodes=new Map(['rental-battery-panel','rental-battery-list','rental-battery-status','rental-battery-admin-link'].map(id=>[id,new Element('div')])),events=[],requests=[],intervals=[];
 const document={hidden:false,querySelector(selector){return nodes.get(selector.slice(1))||null;},createElement(tag){return new Element(tag);},addEventListener(){},dispatchEvent(event){events.push(event);}};
 let now=100000;
 class FakeDate extends Date{static now(){return now;}}
 const fetch=async(url,options={})=>{requests.push({url,options});if(url==='/api/admin/session')return {ok:true,status:200,json:async()=>({user:{role:'admin'}})};if(url==='/api/admin/battery-overview'){if(errorStatus)return {ok:false,status:errorStatus,json:async()=>({error:'unavailable'})};return {ok:true,status:200,json:async()=>data};}throw new Error(`Unexpected request ${url}`);};
 const context={document,window:{},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},fetch,setInterval(fn,ms){intervals.push({fn,ms});return intervals.length;},clearInterval(){},Date:FakeDate};
 const source=await readFile(new URL('../dist/admin/rental-batteries.js',import.meta.url),'utf8');vm.runInNewContext(source,context,{filename:'rental-batteries.js'});await new Promise(resolve=>setTimeout(resolve,0));
 return {nodes,events,requests,intervals,advance:ms=>{now+=ms;},flush:async()=>new Promise(resolve=>setTimeout(resolve,0)),context};
}
function summary(page){return page.nodes.get('rental-battery-list').children[0].children[0];}
function text(node){return node.textContent;}

test('fresh summary is colored and shows runtime; offline and stale summaries retain SOC in gray without runtime',async()=>{
 const boat=overview([fresh()], 'Сашин',{id:9,departurePending:true,rentalId:5});const page=await mount({data:boat}),card=summary(page),ring=walk(card).find(node=>node.className==='rental-battery-ring');
 assert.equal(card.dataset.fresh,'true');assert.equal(card.dataset.charge,'high');assert.equal(text(ring),'72%');assert.match(text(card),/≈ 1 ч 35 мин/);assert.equal(page.events.at(-1).type,'start:battery-overview');assert.equal(page.events.at(-1).detail.catamarans[0].trip.id,9);assert.equal(page.intervals[0].ms,5000);

 const offlinePage=await mount({data:overview([fresh({socPercent:0,online:false,estimatedMinutes:12})])}),offlineCard=summary(offlinePage),offlineRing=walk(offlineCard).find(node=>node.className==='rental-battery-ring');
 assert.equal(offlineCard.dataset.fresh,'false');assert.equal(offlineCard.dataset.charge,'low');assert.equal(text(offlineRing),'0%');assert.match(text(offlineCard),/Нет связи/);assert.equal(walk(offlineCard).find(node=>node.className==='rental-battery-runtime').textContent,'—');

 const stalePage=await mount({data:overview([fresh({socPercent:49,stale:true})])}),staleCard=summary(stalePage);
 assert.equal(staleCard.dataset.fresh,'false');assert.equal(text(staleCard).includes('49%'),true);assert.match(text(staleCard),/Нет связи/);
});

test('unknown fleet SOC uses per-device values and a dash; fully known fleets use their conservative minimum',async()=>{
 const unknown=await mount({data:overview([fresh({name:'Левый',socPercent:66}),fresh({name:'Правый',socPercent:null,online:false})])});
 const unknownCard=summary(unknown),unknownRing=walk(unknownCard).find(node=>node.className==='rental-battery-ring'),socList=walk(unknownCard).find(node=>node.className==='rental-battery-summary-soc');
 assert.equal(text(unknownRing),'—');assert.match(text(socList),/Левый: 66%/);assert.match(text(socList),/Правый: —/);assert.match(text(unknownCard),/Нет связи/);

 const known=await mount({data:overview([fresh({name:'Левый',socPercent:66}),fresh({name:'Правый',socPercent:41,online:false})])});
 const knownCard=summary(known),knownRing=walk(knownCard).find(node=>node.className==='rental-battery-ring');
 assert.equal(text(knownRing),'41%');assert.equal(knownCard.dataset.fresh,'false');assert.match(text(knownCard),/Левый: 66% · Правый: 41%/);
});

test('idle fresh charge color is preserved and stale readings survive request errors without ETA',async()=>{
 const page=await mount({data:overview([fresh({socPercent:24,state:'idle',estimatedMinutes:2})])}),card=summary(page);
 assert.equal(card.dataset.fresh,'true');assert.equal(card.dataset.mode,'idle');assert.equal(card.dataset.charge,'medium');assert.match(text(card),/Ожидание/);

 const failed=await mount({data:overview([fresh({socPercent:81,estimatedMinutes:120})])}),failedCard=summary(failed);failed.advance(15000);failed.errorStatus=503;
 failed.context.fetch=async(url,options={})=>{failed.requests.push({url,options});if(url==='/api/admin/battery-overview')return {ok:false,status:503,json:async()=>({error:'offline'})};return {ok:true,status:200,json:async()=>({user:{role:'admin'}})};};
 failed.intervals[0].fn();await failed.flush();
 assert.equal(text(walk(failedCard).find(node=>node.className==='rental-battery-ring')),'81%');assert.equal(failedCard.dataset.fresh,'false');assert.equal(text(walk(failedCard).find(node=>node.className==='rental-battery-runtime')),'—');assert.match(text(failedCard),/Нет связи/);
});

test('no SOC displays a dash; access denial hides and clears prior readings; overview polling is read-only',async()=>{
 const unknown=await mount({data:overview([fresh({socPercent:null})])}),unknownCard=summary(unknown);
 assert.equal(text(walk(unknownCard).find(node=>node.className==='rental-battery-ring')),'—');assert.match(text(unknownCard),/Нет данных/);
 assert.equal(walk(unknownCard).some(node=>['BUTTON','SELECT'].includes(node.tagName)),false);
 assert.deepEqual(unknown.requests.map(request=>request.url),['/api/admin/session','/api/admin/battery-overview']);

 for(const status of [401,403]){const denied=await mount({data:overview([fresh({socPercent:58})])});denied.advance(15000);denied.context.fetch=async url=>url==='/api/admin/battery-overview'?{ok:false,status,json:async()=>({error:'denied'})}:{ok:true,status:200,json:async()=>({user:{role:'admin'}})};denied.intervals[0].fn();await denied.flush();
  assert.equal(denied.nodes.get('rental-battery-panel').hidden,true);assert.equal(denied.nodes.get('rental-battery-list').children.length,0);assert.equal(denied.context.window.STARTBatteryOverview,null);assert.equal(denied.events.at(-1).detail.catamarans.length,0);}
 assert.doesNotMatch(await readFile(new URL('../dist/admin/rental-batteries.js',import.meta.url),'utf8'),/battery-trips|rental-depart/);
});
