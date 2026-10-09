import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import Desk from '../dist/admin/desk-utils.js';

const source=readFileSync(new URL('../dist/admin/app.js',import.meta.url),'utf8');
const lines=source.split(/\r?\n/);
function declaration(name){
 const start=lines.findIndex(line=>new RegExp('^(?:async )?function '+name+'\\(').test(line));
 assert.ok(start>=0,name);
 if(lines[start].endsWith('}'))return lines[start];
 const end=lines.findIndex((line,i)=>i>start&&line==='}');
 assert.ok(end>start,name);return lines.slice(start,end+1).join('\n');
}
function functions(names){return names.map(declaration).join('\n');}
class Element{
 constructor(tag='div',value=''){this.tag=tag;this._value=value;this.children=[];this.dataset={};this.listeners={};this.attributes={};this.classes=new Set();this.classList={add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),toggle:(n,v)=>v?this.classes.add(n):this.classes.delete(n)};}
 get value(){if(this.tag==='select'){const selected=this.children.find(child=>child.selected);if(selected)return selected.value;}return this._value;}
 set value(value){this._value=String(value??'');if(this.tag==='select'){let matched=false;for(const child of this.children){child.selected=!matched&&child.value===this._value;matched=matched||child.selected;}}}
 get options(){return this.tag==='select'?this.children:undefined;}
 get selectedOptions(){if(this.tag!=='select')return undefined;const selected=this.children.find(child=>child.selected)||this.children.find(child=>child.value===this._value);return selected?[selected]:[];}
 get selected(){return !!this._selected;}
 set selected(value){this._selected=!!value;if(this._selected&&this.parentElement?.tag==='select')for(const sibling of this.parentElement.children)if(sibling!==this)sibling._selected=false;}
 set textContent(value){this.valueText=String(value??'');this.children=[];}
 get textContent(){return (this.valueText||'')+this.children.map(c=>c.textContent).join(' ');}
 append(...children){for(const child of children)child.parentElement=this;this.children.push(...children);}
 replaceChildren(...children){this.valueText='';this.children=children;for(const child of children)child.parentElement=this;if(this.tag==='select')this.value=children.find(c=>!c.disabled)?.value||'';}
 setAttribute(key,value){this.attributes[key]=value;}
 addEventListener(event,listener){this.listeners[event]=listener;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 querySelectorAll(selector){return this.children.flatMap(c=>[...((selector==='details[open]'&&c.tag==='details'&&c.open)?[c]:[]),...c.querySelectorAll(selector)]);}
 showModal(){this.open=true;}
 close(){this.open=false;}
}
const elementText=(tag,value,className)=>{const el=new Element(tag);el.textContent=value;el.className=className;return el;};
const money=n=>(n/100).toLocaleString('ru-RU',{style:'currency',currency:'RUB'});

function priceFixture(draft){
 const form=new Element('form');form.elements=Object.fromEntries(['equipment','quantity','catamaranLabel','people','amount','name','phone','departed','expectedReturn','method'].map(n=>[n,new Element(['equipment','catamaranLabel'].includes(n)?'select':'input')]));
 form.reset=()=>{for(const [name,el] of Object.entries(form.elements))el.value=['quantity','people'].includes(name)?'1':name==='method'?'unspecified':'';};form.reset();
 form.elements.catamaranLabel.disabled=true;
 const nodes={'#issue-form':form,'#issue-equipment':form.elements.equipment,'#issue-catamaran-label':form.elements.catamaranLabel,'#issue-catamaran-wrap':new Element('label'),'#issue-people-label':new Element(),'#issue-status':new Element(),'#issue-time-summary':new Element(),'#issue-dates':new Element('details'),'#issue-source':new Element(),'#issue-dialog':new Element('dialog')};
 nodes['#issue-catamaran-wrap'].hidden=true;
 const storage=new Map(draft?[['rental-draft-1',JSON.stringify(draft)]]:[]);
 const duration=new Element('button');duration.dataset.duration='30';
 const context={URLSearchParams,location:{search:''},$:s=>nodes[s]||null,data:{fleet:[{id:'sup',label:'SUP',available:5,price:1000},{id:'big',label:'Big SUP',available:1,price:1000},{id:'catamaran',label:'Катамаран',available:2,price:5000}]},user:{id:1},requestId:null,issueInquiry:null,pendingRentalMemory:null,batteryCatamarans:[{label:'Aurora',trip:null},{label:'Borealis',trip:{state:'active'}}],batteryTripsByRental:new Map(),batteryLabelsByRental:new Map(),renderList(){},rentalPriceManual:false,rentalPricePlan:'hour',window:{},localTime:()=> '2026-09-27T10:00',time:n=>new Date(n).toISOString(),compactDuration:Desk.duration,money,text:elementText,crypto:{randomUUID:()=> 'same-request'},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},FormData:class{constructor(f){this.fields=f.elements;}*[Symbol.iterator](){for(const [name,el] of Object.entries(this.fields))if(!el.disabled)yield [name,el.value];}},document:{querySelectorAll:s=>s==='[data-duration]'?[duration]:[]}};
 runInNewContext(functions(['pendingRental','updateBatteryOverview','populateCatamaranOptions','syncCatamaranField','updateRentalPrice','saveRentalDraft','openIssue','issueBooking'])+'\n'+lines.filter(l=>l.startsWith("for(const name of ['equipment'")||l.startsWith("$('#issue-form').elements.amount.addEventListener")||l.startsWith("for(const b of document.querySelectorAll('[data-duration]')")).join('\n'),context);
 return {context,form,nodes,storage,duration};
}

test('Fresh rental prices its default hour; manual time and duration buttons recalculate',()=>{
 const f=priceFixture();f.context.openIssue(false);
 assert.equal(f.form.elements.amount.value,'1000.00');assert.equal(f.form.elements.expectedReturn.value,'2026-09-27T11:00');
 f.form.elements.expectedReturn.value='2026-09-27T12:00';f.form.elements.expectedReturn.listeners.change();assert.equal(f.form.elements.amount.value,'2000.00');
 f.form.elements.departed.value='2026-09-27T11:00';f.form.elements.departed.listeners.change();assert.equal(f.form.elements.amount.value,'1000.00');
 f.duration.onclick();assert.equal(f.form.elements.amount.value,'500.00');assert.equal(f.form.elements.expectedReturn.value,'2026-09-27T11:30');
 f.form.elements.equipment.value='big';f.form.elements.people.value='4';f.form.elements.equipment.listeners.change();assert.equal(f.form.elements.amount.value,'2000.00');
});

test('Explicit manual price, including zero, survives time, equipment, duration and draft restoration',()=>{
 const f=priceFixture();f.context.openIssue(false);f.form.elements.amount.value='0';f.form.elements.amount.listeners.input();
 f.form.elements.expectedReturn.value='2026-09-27T12:00';f.form.elements.expectedReturn.listeners.change();f.duration.onclick();
 f.form.elements.equipment.value='big';f.form.elements.people.value='5';f.form.elements.equipment.listeners.change();assert.equal(f.form.elements.amount.value,'0');
 assert.match(f.nodes['#issue-status'].textContent,/Сумма задана вручную/);
 const draft=JSON.parse(f.storage.get('rental-draft-1'));assert.equal(draft.manualPrice,true);assert.equal(draft.requestId,'same-request');
 const restored=priceFixture(draft);restored.context.openIssue();assert.equal(restored.form.elements.amount.value,'0');assert.equal(restored.context.requestId,'same-request');
 restored.form.elements.amount.value='';restored.form.elements.amount.listeners.input();restored.form.elements.amount.listeners.change();assert.equal(restored.form.elements.amount.value,'2500.00');
});

test('Automatic draft remains automatic and older manual drafts retain their entered amount',()=>{
 const f=priceFixture();f.context.openIssue(false);const draft=JSON.parse(f.storage.get('rental-draft-1'));
 const auto=priceFixture(draft);auto.context.openIssue();auto.form.elements.quantity.value='2';auto.form.elements.quantity.listeners.change();assert.equal(auto.form.elements.amount.value,'2000.00');
 delete draft.manualPrice;draft.fields.amount='750';const legacy=priceFixture(draft);legacy.context.openIssue();legacy.form.elements.quantity.value='2';legacy.form.elements.quantity.listeners.change();assert.equal(legacy.form.elements.amount.value,'750');
});

for(const plan of ['day','takeaway'])test(plan+' booking requires its agreed price and never changes to an hourly tariff, including after draft restoration',()=>{
 const f=priceFixture();f.context.issueBooking({id:25,details:{equipment:'sup',quantity:1,name:'Иван',phone:'79001112233',plan,date:'2026-09-27',returnDate:'2026-09-29'}});
 assert.equal(f.form.elements.amount.value,'');assert.match(f.nodes['#issue-status'].textContent,plan==='day'?/дневному тарифу/:/согласованный срок, без возвратного залога/);
 f.form.elements.expectedReturn.value='2026-09-30T22:00';f.form.elements.expectedReturn.listeners.change();f.duration.onclick();f.form.elements.quantity.value='2';f.form.elements.quantity.listeners.change();assert.equal(f.form.elements.amount.value,'');
 const emptyDraft=JSON.parse(f.storage.get('rental-draft-1'));assert.equal(emptyDraft.pricePlan,plan);assert.equal(emptyDraft.inquiryId,25);
 const emptyRestored=priceFixture(emptyDraft);emptyRestored.context.openIssue();emptyRestored.duration.onclick();assert.equal(emptyRestored.form.elements.amount.value,'');
 f.form.elements.amount.value='5000';f.form.elements.amount.listeners.input();f.form.elements.departed.value='2026-09-27T12:00';f.form.elements.departed.listeners.change();assert.equal(f.form.elements.amount.value,'5000');
 const restored=priceFixture(JSON.parse(f.storage.get('rental-draft-1')));restored.context.openIssue();restored.duration.onclick();assert.equal(restored.form.elements.amount.value,'5000');assert.equal(restored.context.rentalPricePlan,plan);
 restored.form.elements.amount.value='';restored.form.elements.amount.listeners.input();restored.form.elements.amount.listeners.change();assert.equal(restored.form.elements.amount.value,'');
 restored.context.openIssue(false);assert.equal(restored.form.elements.amount.value,'1000.00');assert.equal(restored.context.rentalPricePlan,'hour');
});

test('Older linked booking drafts with no plan do not guess a tariff',()=>{
 const f=priceFixture();f.context.openIssue(false);const draft=JSON.parse(f.storage.get('rental-draft-1'));delete draft.pricePlan;delete draft.manualPrice;draft.inquiryId=25;draft.fields.amount='';
 const restored=priceFixture(draft);restored.context.openIssue();restored.duration.onclick();assert.equal(restored.form.elements.amount.value,'');assert.equal(restored.context.rentalPricePlan,'manual');assert.match(restored.nodes['#issue-status'].textContent,/согласованному тарифу/);
 draft.fields.amount='5000';const entered=priceFixture(draft);entered.context.openIssue();entered.form.elements.quantity.value='2';entered.form.elements.quantity.listeners.change();assert.equal(entered.form.elements.amount.value,'5000');
});

test('Hourly booking still calculates its selected quantity and duration automatically',()=>{
 const f=priceFixture();f.context.issueBooking({id:26,details:{equipment:'sup',quantity:2,name:'Иван',phone:'79001112233',plan:'hour',duration:2,date:'2026-09-27'}});
 assert.equal(f.form.elements.amount.value,'4000.00');assert.equal(f.form.elements.expectedReturn.value,'2026-09-27T12:00');assert.equal(f.context.rentalPricePlan,'hour');
 f.form.elements.expectedReturn.value='2026-09-27T11:00';f.form.elements.expectedReturn.listeners.change();assert.equal(f.form.elements.amount.value,'2000.00');
});

test('Named catamaran selection carries its label while occupied named boats stay disabled',()=>{
 const f=priceFixture();f.context.openIssue(false);
 const equipment=f.form.elements.equipment,options=equipment.options.filter(option=>option.value==='catamaran');
 assert.equal(options.length,3);assert.equal(options[0].dataset.catamaranLabel,undefined);assert.equal(options[1].dataset.catamaranLabel,'Aurora');assert.equal(options[2].dataset.catamaranLabel,'Borealis');
 assert.equal(options[0].disabled,false);assert.equal(options[1].disabled,false);assert.equal(options[2].disabled,true);
 options[0].selected=false;options[1].selected=true;equipment.listeners.change();
 assert.equal(equipment.value,'catamaran');assert.equal(f.form.elements.quantity.value,'1');assert.equal(f.form.elements.catamaranLabel.value,'Aurora');assert.equal(f.nodes['#issue-catamaran-wrap'].hidden,true);
 const payload=Object.fromEntries(new f.context.FormData(f.form));assert.equal(payload.equipment,'catamaran');assert.equal(payload.catamaranLabel,'Aurora');
});

test('Submitting a selected named catamaran sends generic equipment id and the chosen boat label',async()=>{
 const f=priceFixture();f.context.openIssue(false);
 const named=f.form.elements.equipment.options.find(option=>option.dataset.catamaranLabel==='Aurora');named.selected=true;f.form.elements.equipment.listeners.change();
 const requests=[];f.context.api=async(...args)=>{requests.push(args);return {id:81};};f.context.finishRental=async()=>{};f.context.pendingRental=()=>null;f.context.rememberRental=()=>{};f.context.lockRentalForm=()=>{};f.context.Event=Event;f.context.window.STARTUx={event(){}};f.nodes['#close-issue']=new Element('button');
 const start=lines.findIndex(line=>line.startsWith("$('#issue-form').onsubmit=")),end=lines.findIndex((line,index)=>index>start&&line==='};');assert.ok(start>=0&&end>start);
 runInNewContext(lines.slice(start,end+1).join('\n'),f.context);
 await f.form.onsubmit({preventDefault(){},target:f.form});
 assert.equal(requests.length,1);assert.equal(requests[0][0],'rentals');assert.equal(requests[0][1].equipment,'catamaran');assert.equal(requests[0][1].catamaranLabel,'Aurora');assert.equal(requests[0][1].quantity,1);
});

test('Changing a named catamaran to multiple units selects the generic equipment option',()=>{
 const f=priceFixture();f.context.openIssue(false);
 const equipment=f.form.elements.equipment,named=equipment.options.find(option=>option.dataset.catamaranLabel==='Aurora');
 equipment.options.filter(option=>option.value==='catamaran').forEach(option=>{option.selected=option===named;});equipment.listeners.change();
 assert.equal(f.form.elements.catamaranLabel.value,'Aurora');
 f.form.elements.quantity.value='2';f.form.elements.quantity.listeners.change();
 assert.equal(equipment.value,'catamaran');assert.equal(equipment.selectedOptions[0].dataset.catamaranLabel,undefined);
 assert.equal(f.form.elements.catamaranLabel.value,'');assert.equal(f.form.elements.catamaranLabel.disabled,true);assert.equal(f.nodes['#issue-catamaran-wrap'].hidden,true);
 const payload=Object.fromEntries(new f.context.FormData(f.form));assert.equal(payload.equipment,'catamaran');assert.equal(payload.quantity,'2');assert.equal('catamaranLabel' in payload,false);
});

test('Restoring a named catamaran draft restores the named option and keeps the secondary selector hidden',()=>{
 const draft={at:Date.now(),requestId:'named-catamaran-draft',inquiryId:null,manualPrice:false,pricePlan:'hour',fields:{equipment:'catamaran',quantity:1,catamaranLabel:'Aurora',people:1,amount:'5000',name:'Иван',phone:'79001112233',departed:'2026-09-27T10:00',expectedReturn:'2026-09-27T11:00',method:'unspecified'}};
 const f=priceFixture(draft);f.context.openIssue();
 const selected=f.form.elements.equipment.selectedOptions[0];assert.equal(selected.value,'catamaran');assert.equal(selected.dataset.catamaranLabel,'Aurora');
 assert.equal(f.form.elements.catamaranLabel.value,'Aurora');assert.equal(f.nodes['#issue-catamaran-wrap'].hidden,true);assert.equal(f.context.requestId,'named-catamaran-draft');
});

test('Submit rejects a named catamaran that became occupied while the form was open without sending a request',async()=>{
 const f=priceFixture();f.context.openIssue(false);
 const equipment=f.form.elements.equipment,named=equipment.options.find(option=>option.dataset.catamaranLabel==='Aurora');
 named.selected=true;equipment.listeners.change();assert.equal(f.form.elements.catamaranLabel.value,'Aurora');
 f.context.batteryCatamarans[0].trip={state:'active'};
 const requests=[];f.context.api=async(...args)=>requests.push(args);f.context.pendingRental=()=>null;f.context.rememberRental=()=>{};f.context.lockRentalForm=()=>{};f.context.Event=Event;
 f.context.window.STARTUx={event(){}};f.nodes['#close-issue']=new Element('button');
 const submitStart=lines.findIndex(line=>line.startsWith("$('#issue-form').onsubmit=")),submitEnd=lines.findIndex((line,index)=>index>submitStart&&line==='};');assert.ok(submitStart>=0&&submitEnd>submitStart);
 runInNewContext(lines.slice(submitStart,submitEnd+1).join('\n'),f.context);
 await f.form.onsubmit({preventDefault(){},target:f.form});
 assert.deepEqual(requests,[]);assert.match(f.nodes['#issue-status'].textContent,/уже занят/);assert.equal(f.form.dataset.saving,undefined);
});

test('Submit rejects a named catamaran when the overview becomes unavailable without sending a request',async()=>{
 const f=priceFixture();f.context.openIssue(false);
 const equipment=f.form.elements.equipment,named=equipment.options.find(option=>option.dataset.catamaranLabel==='Aurora');named.selected=true;equipment.listeners.change();
 assert.equal(f.form.elements.catamaranLabel.value,'Aurora');
 f.context.updateBatteryOverview(null);
 assert.equal(f.context.batteryCatamarans.every(boat=>boat.overviewUnavailable===true),true);
 assert.equal(f.form.elements.catamaranLabel.options.find(option=>option.value==='Aurora').disabled,true);
 const requests=[];f.context.api=async(...args)=>requests.push(args);f.context.pendingRental=()=>null;f.context.rememberRental=()=>{};f.context.lockRentalForm=()=>{};f.context.Event=Event;
 f.context.window.STARTUx={event(){}};f.nodes['#close-issue']=new Element('button');
 const submitStart=lines.findIndex(line=>line.startsWith("$('#issue-form').onsubmit=")),submitEnd=lines.findIndex((line,index)=>index>submitStart&&line==='};');assert.ok(submitStart>=0&&submitEnd>submitStart);
 runInNewContext(lines.slice(submitStart,submitEnd+1).join('\n'),f.context);
 await f.form.onsubmit({preventDefault(){},target:f.form});
 assert.deepEqual(requests,[]);assert.match(f.nodes['#issue-status'].textContent,/нет свежих данных о катамаранах/i);assert.equal(f.form.dataset.saving,undefined);
});

test('Global search includes an active rental from another tab despite the overdue filter and opens it',async()=>{
 const row={id:17,name:'Иван',phone:'+79001112233',equipment:'sup',expected_return:2000,returned:null};
 const results=new Element(),focus={};const selected={scrollIntoView:options=>{focus.scroll=options;},querySelector:()=>({focus:()=>{focus.focused=true;}})};
 const context={URLSearchParams,location:{search:''},Desk,data:{active:[row],dayRentals:[row],fleet:[{id:'sup',label:'SUP'}]},activeQuery:'Иван',activeFilter:'overdue',deskView:'bookings',expandedRental:null,searchResults:{rentals:[row],bookings:[],clients:[{name:'Иван',phone:'79001112233'}],cafe:[]},serverNow:()=>1000,shortTime:()=> '12:00',text:elementText,money,$:s=>s==='#desk-results'?results:selected,renderList:()=>{focus.rendered=true;},switchDesk:view=>{context.deskView=view;},requestAnimationFrame:fn=>fn(),document:{createElement:tag=>new Element(tag)}};
 context.rentalStage='all';
 runInNewContext(lines.find(l=>l.startsWith('const isPaidWaitingDeparture='))+'\n'+functions(['waitingRows','searchActiveRentals','openSearchRental','renderSearch']),context);context.renderSearch();
 assert.equal(results.children.filter(el=>el.textContent.startsWith('На воде')).length,1);
 assert.ok(results.children.some(el=>el.textContent.includes('новая аренда')));
 await results.children[0].onclick();assert.equal(context.deskView,'work');assert.equal(context.activeFilter,'all');assert.equal(context.expandedRental,17);assert.equal(context.activeQuery,'Иван');assert.equal(focus.focused,true);assert.equal(focus.rendered,true);
});

test('Both return controls disclose the surcharge and history shows the amount before return',()=>{
 const history=new Element(),r={id:17,name:'Иван',equipment:'sup',quantity:1,extension_due:125050,expected_return:2000,departed:'2026-09-27T10:00',phone:'79001112233',paid:100000};
 const nodes={'#rental-history-list':history,'#rental-history-day':new Element(),'#report-day':{value:'2026-09-27'},'#rental-history-count':new Element()};
 const context={URLSearchParams,location:{search:''},window:{},text:elementText,money,$:s=>nodes[s],Desk,data:{dayRentals:[r],fleet:[{id:'sup',label:'SUP'}]},activeQuery:'',historyFilter:'all',user:{role:'staff'},time:()=> '10:00',shortTime:()=> '12:00',returnRental:()=>{}};
 runInNewContext(lines.find(l=>l.startsWith('const isPaidWaitingDeparture='))+'\n'+functions(['rentalHistoryStatus','returnAmount','returnLabel','setReturnButton','renderDayRentals']),context);
 const waterButton=new Element('button');context.setReturnButton(waterButton,r);context.renderDayRentals();
 const details=history.children[0].children[1],historyButton=details.children.find(el=>el.tag==='button');
 assert.equal(historyButton.attributes['aria-label'],waterButton.attributes['aria-label']);assert.match(historyButton.attributes['aria-label'],/Вернулись · доплата/);assert.match(historyButton.textContent,/1\s?250,5/);assert.match(details.textContent,/К доплате при возврате/);
 assert.ok(waterButton.classes.has('has-surcharge'));context.setReturnButton(waterButton,{extension_due:0});assert.equal(waterButton.textContent,'Вернулись');assert.ok(!waterButton.classes.has('has-surcharge'));
});

test('Rental request reports lost responses in Russian, never retries, and preserves validation errors',async()=>{
 let calls=0;const context={URLSearchParams,location:{search:''},fetch:async()=>{calls++;throw new TypeError('Failed to fetch');}};runInNewContext(functions(['connectionError','api']),context);
 await assert.rejects(context.api('rentals',{requestId:'same-request'}),/Проверьте связь и список «На воде»/);assert.equal(calls,1);
 await assert.rejects(context.api('dashboard'),/Нет связи с сервером/);assert.equal(calls,2);
 context.fetch=async()=>({ok:true,json:async()=>{throw new SyntaxError('Unexpected token');}});await assert.rejects(context.api('rentals',{}),/прежде чем повторять/);
 context.fetch=async()=>({ok:false,status:409,json:async()=>({error:'Техника уже занята.'})});await assert.rejects(context.api('rentals',{}),/Техника уже занята/);
});

test('Workforce request translates network and unreadable responses without retrying writes',async()=>{
 const operations=readFileSync(new URL('../dist/admin/operations.js',import.meta.url),'utf8');
 const apiExpression=operations.slice(operations.indexOf('api=async(')+4,operations.indexOf(',run=fn'));
 let calls=0;const context={URLSearchParams,location:{search:''},fetch:async()=>{calls++;throw new TypeError('Failed to fetch');}};runInNewContext('var api='+apiExpression,context);
 await assert.rejects(context.api('workforce/current'),/Нет связи с сервером/);
 await assert.rejects(context.api('workforce/settings',{revision:1}),/чтобы узнать, сохранились ли изменения/);assert.equal(calls,2);
 context.fetch=async()=>({ok:true,json:async()=>{throw new SyntaxError('Unexpected token');}});await assert.rejects(context.api('workforce/current'),/Нет связи с сервером/);
});

test('Booking confirmation failure remains inside the open dialog',async()=>{
 const dialog=new Element('dialog'),detail=new Element(),context={URLSearchParams,location:{search:''},$:s=>s==='#booking-dialog'?dialog:detail,text:elementText,data:{fleet:[{id:'sup',label:'SUP'}]},planLabels:{hour:'Час'},window:{},api:async()=>{throw Error('Нет связи с сервером.');}};
 runInNewContext(declaration('openBooking'),context);context.openBooking({id:1,revision:0,status:'new',details:{name:'Иван',phone:'79001112233',equipment:'sup',date:'2026-09-27',time:'12:00',plan:'hour'}});
 const confirm=detail.children.find(el=>el.tag==='button');await confirm.onclick();assert.equal(dialog.open,true);assert.equal(confirm.disabled,false);assert.match(detail.children.find(el=>el.attributes.role==='status').textContent,/Нет связи/);
});

test('Station cafe block keeps all active stages and completes orders with the same action as cafe',async()=>{
 const orders=['NEW','ACCEPTED','COOKING','READY','DELIVERED','CANCELLED'].map((status,i)=>({id:i+1,revision:2,status,created:i,details:{fulfillment:'pickup',items:[],payment:'cash'},total_cents:10000}));
 const output=new Element(),posts=[];
 const context={URLSearchParams,location:{search:''},$:()=>output,text:elementText,money,user:{id:1},cafeLoading:false,cafeLast:0,cafeAttention:[],localTime:()=> '2026-09-27T12:00',serverNow:()=>1000,document:{hidden:false,querySelector:()=>null,dispatchEvent(){}},Event,notice:()=>{},api:async(path,body)=>{if(body)posts.push(body);return {rows:orders};}};
 runInNewContext(functions(['renderCafeAttention','loadCafeAttention']),context);await context.loadCafeAttention(true);
 assert.deepEqual(Array.from(context.cafeAttention,r=>r.status),['NEW','ACCEPTED','COOKING','READY']);
 for(const row of output.children){const button=row.children.find(el=>el.tag==='button');assert.equal(button.textContent,'Выполнен');assert.match(row.textContent,/В работе/);}
 await output.children[0].children.find(el=>el.tag==='button').onclick();assert.equal(posts.length,1);assert.equal(posts[0].status,'DELIVERED');assert.equal(posts[0].revision,2);
});
