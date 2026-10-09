import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {serveWorkspace,workspacePages} from './admin-workspace.mjs';

const root=fileURLToPath(new URL('../dist/',import.meta.url));
class Element{
 constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.parentElement=null;this.listeners={};this.dataset={};this.style={};this.attributes={};this.value='';this.checked=false;this.hidden=false;this.disabled=false;this.readOnly=false;this.open=false;this._text='';}
 set textContent(value){this.children.forEach(child=>{child.parentElement=null;});this.children=[];this._text=String(value??'');}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 append(...nodes){for(const node of nodes){if(node&&typeof node==='object'){if(node.parentElement)node.remove();node.parentElement=this;this.children.push(node);}else this._text+=String(node??'');}}
 replaceChildren(...nodes){this.children.forEach(child=>{child.parentElement=null;});this.children=[];this._text='';this.append(...nodes);}
 remove(){if(!this.parentElement)return;const parent=this.parentElement;parent.children=parent.children.filter(child=>child!==this);this.parentElement=null;}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 setAttribute(name,value){this.attributes[name]=String(value);}
 get options(){return this.children;}
 querySelector(selector){const match=selector.match(/^\[data-action=(.+)\]$/);if(match){const wanted=match[1].replaceAll(/["']/g,'');return walk(this).find(node=>node.dataset.action===wanted)||null;}return null;}
 scrollIntoView(){} focus(){} select(){} showModal(){this.open=true;}
 reset(){for(const element of Object.values(this.elements||{})){element.value=element.defaultValue||'';element.checked=element.defaultChecked||false;}this.elements.staleAfterSeconds.value='90';this.elements.enabled.checked=true;}
}
function walk(node){return [node,...node.children.flatMap(walk)];}
function makeDom(){
 const ids=['battery-status','battery-list','battery-empty','battery-device-form','battery-token-dialog','battery-add','battery-login','battery-form-error','battery-form-title','battery-form-note','battery-enabled-row','battery-form-save','battery-token','battery-token-status','battery-token-copy','battery-token-close','battery-form-close','battery-form-cancel'];
 const doc={hidden:false,listeners:{},addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);},createElement(tag){return new Element(tag,this);},querySelector(selector){return selector.startsWith('#')?nodes.get(selector.slice(1))||null:null;}};
 const nodes=new Map(ids.map(id=>[id,new Element('div',doc)]));
 const form=nodes.get('battery-device-form');form.elements={};for(const [name,tag] of [['name','input'],['catamaranLabel','select'],['bmsId','input'],['serialNumber','input'],['capacityAh','input'],['staleAfterSeconds','input'],['enabled','input']]){const control=new Element(tag,doc);control.name=name;form.elements[name]=control;}form.elements.staleAfterSeconds.defaultValue='90';form.elements.enabled.defaultChecked=true;
 return {doc,nodes};
}
class TestFormData{constructor(form){this.form=form;}get(name){return this.form.elements[name]?.value??null;}}
function response(body,status=200){return {ok:status>=200&&status<300,status,json:async()=>body};}
function fixtureDevice(overrides={}){return {deviceId:'bms-one',name:'Аккумулятор 1',catamaranLabel:'Сашин',bmsId:'41:18:12:01:37:50',serialNumber:'25-0277Q1N6622',capacityAh:100,enabled:true,revision:3,staleAfterSeconds:90,bindingLocked:true,lastSeenAt:100000,lastMeasuredAt:100000,online:true,stale:false,bmsConnected:true,firmwareVersion:'1.0',wifiRssi:-45,bleRssi:-50,uptimeSeconds:3600,localIp:'192.168.1.4',telemetry:{socPercent:75.4,voltageV:51.2,currentA:-3.4,powerW:174.08,state:'discharging',chargingEnabled:false,dischargingEnabled:true,remainingCapacityAh:75.4,cellCount:4,temperatureSensorCount:2,cellVoltagesV:[3.18,null,3.22,3.2],temperaturesC:[22,null],alarmMaskHex:'0000000000000000',bmsName:'JK',fieldAgesMs:{summary:0,status:91000,cells:0,temperatures:91000,alarms:0,name:0},rawFrames:{}},estimate:null,...overrides};}
async function mount({user={id:1,role:'admin'},listing,requests=[],postResponses=[],laterRevision}={}){
 const {doc,nodes}=makeDom(),intervals=[];let index=0;
 const fetch=async(url,options={})=>{requests.push({url,options});if(url==='/api/admin/session')return response({user});if(url==='/api/admin/battery-state'){index++;const data=typeof listing==='function'?listing(index):listing;return response(data||{now:100000,catamarans:['Сашин','Наташин','С серой крышей'],devices:[fixtureDevice(),fixtureDevice({deviceId:'bms-two',name:'Другой',catamaranLabel:'Наташин',revision:1,online:false,stale:true,telemetry:null}),...(laterRevision&&index>1?[fixtureDevice({revision:laterRevision})]:[])]});}if(url.startsWith('/api/admin/battery-state/history'))return response({history:[]});if(url==='/api/admin/battery-state/devices'){const next=postResponses.shift();if(next instanceof Error)throw next;return response(next||{device:{deviceId:'bms-one',revision:4},token:null});}return response({error:'not found'},404);};
 const delays=[];const context={document:doc,fetch,setInterval(fn,ms){intervals.push(fn);delays.push(ms);return intervals.length;},clearInterval(){},FormData:TestFormData,Date,Math,crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`},navigator:{clipboard:{writeText:async()=>{}}},confirm:()=>true,encodeURIComponent,console};
 const source=await readFile(new URL('../dist/admin/battery-state.js',import.meta.url),'utf8');vm.runInNewContext(source,context,{filename:'battery-state.js'});await new Promise(resolve=>setTimeout(resolve,5));
 return {doc,nodes,requests,intervals,delays,flush:async()=>new Promise(resolve=>setTimeout(resolve,5))};
}
function text(node){return node.textContent;}

test('battery state route serves the dedicated standalone page and the workspace shell knows the path',async()=>{
 assert.equal(workspacePages.get('/admin/battery-state/'),'battery-state');
 const out={writeHead(code,headers){this.code=code;this.headers=headers;},end(body){this.body=body;}};
 assert.equal(await serveWorkspace({method:'GET',headers:{}},out,new URL('https://station.test/admin/battery-state/?standalone=1'),root),true);
 assert.equal(out.code,200);assert.match(out.body,/Состояние аккумуляторов/);assert.match(out.body,/\/admin\/battery-state\.js\?v=/);assert.match(out.body,/\/admin\/battery-state\.css\?v=/);
});

test('admin page groups actual batteries separately, keeps null sensor slots and refreshes only while visible',async()=>{
 const page=await mount();await page.flush();const list=page.nodes.get('battery-list'),groups=list.children;
 assert.deepEqual(groups.slice(0,3).map(group=>group.dataset.catamaran),['Сашин','Наташин','С серой крышей']);
 assert.match(text(groups[0]),/1 аккумулятор · 0 с актуальными показаниями/);assert.match(text(groups[1]),/1 аккумулятор · 0 с актуальными показаниями/);assert.match(text(groups[2]),/Аккумуляторы не назначены/);
 const card=groups[0].children.find(node=>node.className==='battery-group-grid').children[0];assert.match(text(card),/75,4%/);assert.match(text(card),/Ячейка 2: —/);assert.match(text(card),/Датчик 2—/);assert.match(text(card),/Разряд/);assert.match(text(card),/Устарело/);assert.match(text(card),/174 Вт/);assert.equal(card.dataset.freshness,'stale');
 assert.equal(page.delays[0],15000);const count=page.requests.filter(request=>request.url==='/api/admin/battery-state').length;page.doc.hidden=true;page.intervals[0]();await page.flush();assert.equal(page.requests.filter(request=>request.url==='/api/admin/battery-state').length,count);
});

test('staff session never loads telemetry; editor revision and mutation request id survive a lost response and polling',async()=>{
 const denied=await mount({user:{id:2,role:'staff'}});await denied.flush();assert.equal(denied.requests.some(request=>request.url==='/api/admin/battery-state'),false);
 const page=await mount({postResponses:[Error('connection lost'),{device:{deviceId:'bms-one',revision:4},token:null}],laterRevision:4});await page.flush();const card=page.nodes.get('battery-list').children[0].children.find(node=>node.className==='battery-group-grid').children[0];card.querySelector('[data-action=edit]').onclick();const form=page.nodes.get('battery-device-form');assert.equal(form.elements.bmsId.readOnly,true);form.elements.name.value='Аккумулятор 1';form.elements.catamaranLabel.value='Наташин';
 const submit=form.listeners.submit[0],event={preventDefault(){}};await submit(event);await page.flush();await submit(event);await page.flush();const writes=page.requests.filter(request=>request.url==='/api/admin/battery-state/devices').map(request=>JSON.parse(request.options.body));assert.equal(writes.length,2);assert.equal(writes[0].requestId,writes[1].requestId);assert.equal(writes[0].revision,3);assert.equal(writes[1].revision,3);assert.equal(writes[0].action,'update');
});
