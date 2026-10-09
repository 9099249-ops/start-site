import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../dist/admin/app.js',import.meta.url),'utf8');
const calendar=readFileSync(new URL('../dist/admin/calendar.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../dist/admin/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/admin/rental-departure.css',import.meta.url),'utf8');

test('waiting departures render on work view and use the idempotent departure action',()=>{
 assert.match(app,/id='waiting-departures'/);
 assert.match(app,/const body=\{id:r\.id,revision:r\.revision\};if\(batteryTrip\)\{body\.batteryTripId=batteryTrip\.id;body\.batteryTripRevision=batteryTrip\.revision;\}await api\('rental-depart',body\)/);
 assert.match(app,/rowBusy\.has\(r\.id\)/);
 assert.match(app,/Отплыли/);
 assert.match(app,/window\.STARTRefunds\?\.mount\(details,'rental',r\.id,user\.id,refresh\)/);
 const waiting=app.slice(app.indexOf('function renderWaitingDepartures(){'),app.indexOf('\nfunction renderList(',app.indexOf('function renderWaitingDepartures(){')));
 assert.doesNotMatch(waiting,/STARTRefunds|\.rental-details/);
});

test('departure completion redraws the active list after clearing rowBusy',async()=>{
 const id=71,button={disabled:false},calls=[],context={rowBusy:new Set(),renderWaitingDepartures(){},api:async(...args)=>calls.push(['api',...args]),refresh:async()=>calls.push(['refresh']),notice(){},renderList:(...args)=>calls.push(['render',...args,context.rowBusy.has(id)])};
 vm.runInNewContext(functionSource('startRentalDeparture'),context);await context.startRentalDeparture({id,revision:4},button);
 assert.equal(calls[0][0],'api');assert.equal(calls[0][1],'rental-depart');assert.equal(calls[0][2].id,id);assert.equal(calls[0][2].revision,4);
 assert.deepEqual(calls[1],['refresh']);assert.equal(calls[2][0],'render');assert.equal(calls[2][1],'#active-list');assert.equal(calls[2][2].length,0);assert.equal(calls[2][3],true);assert.equal(calls[2][4],false);assert.equal(button.disabled,false);assert.equal(context.rowBusy.has(id),false);
});

test('physical rental return action says Вернулись and keeps its surcharge amount and confirmation wording',()=>{
 const lines=app.split(/\r?\n/),start=lines.findIndex(line=>line.startsWith('function returnAmount(')),end=lines.findIndex((line,index)=>index>start&&line.startsWith('function setReturnButton('));
 assert.ok(start>=0&&end>start);const source=lines.slice(start,end+1).join('\n'),button=new FixtureNode('button');button.setAttribute=(key,value)=>{button[key]=value;button.attributes[key]=String(value);};
 const context={text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className}),button};vm.runInNewContext(source+'\nsetReturnButton(button,{extension_due:1200});',context);
 assert.equal(button.children[0].textContent,'Вернулись');assert.match(button.children[1].textContent,/доплата/);assert.match(button.getAttribute?button.getAttribute('aria-label'):button['aria-label'],/^Вернулись · доплата/);
 assert.match(app,/text\('button','Вернулись','quick-return primary'\)/);
 assert.match(app,/text\('span','Вернулись'\)/);
 assert.match(app,/text\('span','доплата '\+returnAmount\(r\),'return-surcharge'\)/);
 assert.match(app,/async function returnRental\(id,button,cash=false,manualCard=false\)/);
});

test('setRentalEquipment builds the image and label while preserving the existing initial marker',()=>{
 const node=new FixtureNode('span');node.dataset.initial='К';
 const context={text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className})};
 vm.runInNewContext(functionSource('setRentalEquipment'),context);context.setRentalEquipment(node,{equipment:'catamaran',quantity:2},'Катамаран');
 assert.equal(node.dataset.initial,'К');assert.equal(node.children[0].tag,'img');assert.equal(node.children[0].className,'rental-equipment-image');
 assert.match(node.children[0].src,/catamaran-w480\.webp$/);assert.equal(node.children[1].tag,'span');assert.equal(node.children[1].textContent,'Катамаран ×2');
});

test('return payment dialog exposes the current choices and exact cash confirmation payload',async()=>{
 const source=app.slice(app.indexOf('function cashReturnConfirmation('),app.indexOf('async function returnRental('));
 const makeContext=terminal=>{const body=new FixtureNode('body'),context={data:{rentalTerminalEnabled:terminal},money:value=>String(value),text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className}),document:{body,createElement:tag=>new FixtureNode(tag)}};vm.runInNewContext(source,context);return context;};
 const rental={id:9,name:'Guest',extension_due:1250};
 const terminal=makeContext(true),terminalDialogPromise=terminal.confirmReturnPayment(rental),terminalDialog=terminal.document.body.children[0],terminalActions=terminalDialog.children[2];
 assert.deepEqual(terminalActions.children.map(button=>button.textContent),['Карта на CS50','Получено наличными','Эквайринг вручную']);
 assert.equal(terminal.cashReturnConfirmation(rental).cash,true);
 terminalActions.children[1].onclick();
 assert.deepEqual(JSON.parse(JSON.stringify(await terminalDialogPromise)),{cash:true});
 const manual=makeContext(true),manualPromise=manual.confirmReturnPayment(rental);manual.document.body.children[0].children[2].children[2].onclick();
 assert.deepEqual(JSON.parse(JSON.stringify(await manualPromise)),{manualCard:true});
 const noTerminal=makeContext(false),cash=noTerminal.cashReturnConfirmation(rental);
 assert.deepEqual(JSON.parse(JSON.stringify(cash)),{payment:{confirmed:true,method:'cash',amountCents:1250}});
 const noTerminalDialogPromise=noTerminal.confirmReturnPayment(rental),noTerminalDialog=noTerminal.document.body.children[0];
 assert.deepEqual(noTerminalDialog.children[2].children.map(button=>button.textContent),['Получено картой','Получено наличными']);
 noTerminalDialog.children[3].onclick();assert.equal(await noTerminalDialogPromise,null);
});

function functionSource(name){
 const lines=app.split(/\r?\n/),start=lines.findIndex(line=>new RegExp('^(async )?function '+name+'\\(').test(line));
 assert.ok(start>=0,`missing ${name}`);const end=lines.findIndex((line,index)=>index>start&&line==='}');assert.ok(end>start,`unterminated ${name}`);return lines.slice(start,end+1).join('\n');
}
function calendarFunctionSource(name){
 const lines=calendar.split(/\r?\n/),line=lines.find(value=>value.trimStart().startsWith('function '+name+'('));assert.ok(line,`missing calendar ${name}`);return line.trim();
}
class FixtureNode{
 constructor(tag='div',value=''){this.tag=tag;this._text=String(value);this.children=[];this.dataset={};this.hidden=false;this.disabled=false;this.className='';this.parentElement=null;this.listeners={};this.attributes={};this.classList={add:name=>{if(!this.classList.contains(name))this.className=[this.className,name].filter(Boolean).join(' ');},remove:name=>{this.className=this.className.split(/\s+/).filter(value=>value!==name).join(' ');},contains:name=>this.className.split(/\s+/).includes(name),toggle:(name,force)=>{const on=force??!this.classList.contains(name);this.classList[on?'add':'remove'](name);return on;}};}
 get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
 set textContent(value){this.replaceChildren();this._text=String(value??'');}
 append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const child of this.children)child.parentElement=null;this.children=[];this._text='';this.append(...nodes);}
 insertBefore(node,before){node.remove();node.parentElement=this;const index=this.children.indexOf(before);this.children.splice(index<0?this.children.length:index,0,node);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
 matches(selector){return selector.split(',').some(part=>{const value=part.trim();return value.startsWith('.')?this.classList.contains(value.slice(1)):value.toLowerCase()===this.tag.toLowerCase();});}
 addEventListener(type,listener){(this.listeners[type]||=new Set()).add(listener);}
 dispatchEvent(event){event.target=this;for(const listener of this.listeners[event.type]||[])listener.call(this,event);return true;}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 contains(node){return this===node||this.children.some(child=>child.contains(node));}
 close(){this.onclose?.();}
 remove(){this.removed=true;}
 showModal(){this.open=true;}
}
function paymentFixture(rows,payments=[]){
 const panel=new FixtureNode(),context={data:{pendingRentals:rows.filter(r=>r.initial_due>0),waitingDepartures:rows.filter(r=>r.departure_pending&&!r.initial_due),active:[],dayRentals:[],rentalPayments:payments},
  document:{createElement:tag=>new FixtureNode(tag)},$:selector=>selector==='#rental-payments'?panel:new FixtureNode(),text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className}),money:value=>String(value),paymentDiagnostic:()=>null,
  canStartRentalPayment:(r,p)=>!!r&&(!p||p.state==='cancelled')&&(Number(r.initial_due)>0||Number(r.extension_due)>0),rentalPaymentPhase:(r,p)=>p?.phase||(Number(r.initial_due)>0?'issue':'extension'),startRentalPayment(){},refresh(){},openRentalReconciliation(){},window:{}};
 vm.runInNewContext(functionSource('renderRentalPayments'),context);context.renderRentalPayments();return {panel,context};
}

test('unpaid and canceled rentals use the current CS50 labels while paid pending rental has no payment controls',()=>{
 const unpaid={id:11,name:'Unpaid',equipment:'sup',initial_due:2400,departure_pending:1,revision:1};
 const paid={id:12,name:'Paid',equipment:'kayak',initial_due:0,paid:2400,departure_pending:1,revision:1};
 const canceled={id:13,name:'Retry',equipment:'sup',initial_due:2400,departure_pending:1,revision:1};
 const {panel}=paymentFixture([unpaid,paid,canceled],[{rentalId:12,state:'paid',phase:'issue',paid:true,label:'Оплата получена'},{rentalId:13,state:'cancelled',phase:'issue'}]);
 const controls=new Map(panel.children.slice(1).map(row=>[row.dataset.paymentRental,row.children.filter(node=>node.tag==='button').map(node=>node.textContent)]));
 assert.ok(controls.get('11').includes('Карта на CS50'));
 assert.ok(controls.get('11').some(label=>label.startsWith('Наличные · ')));
 assert.ok(controls.get('11').includes('Отменить выдачу'));
 assert.ok(!controls.get('12').some(label=>['Карта на CS50','Повторить на CS50','Отменить выдачу'].includes(label)));
 assert.ok(controls.get('13').includes('Повторить на CS50'));
});

test('search excludes pending departures from active rentals and history distinguishes unpaid, waiting, and canceled',()=>{
 const context={data:{dayRentals:[{id:1,initial_due:0,departure_pending:1},{id:2,initial_due:300,departure_pending:1},{id:3,initial_due:0,departure_pending:0}],active:[],fleet:[]},searchResults:{rentals:[]},activeQuery:'',serverNow:()=>0,Desk:{active:rows=>rows}};
 vm.runInNewContext(functionSource('searchActiveRentals'),context);assert.deepEqual(Array.from(context.searchActiveRentals(),r=>r.id),[3]);
 const statusLine=app.split(/\r?\n/).find(line=>line.startsWith('function rentalHistoryStatus('));assert.ok(statusLine);
 vm.runInNewContext(statusLine,context);context.shortTime=value=>'T'+value;
 assert.match(context.rentalHistoryStatus({departure_pending:1,initial_due:300,created:1}),/^Ожидает оплаты/);
 assert.match(context.rentalHistoryStatus({departure_pending:1,initial_due:0,created:2}),/^Ожидает отплытия/);
 assert.match(context.rentalHistoryStatus({departure_pending:1,initial_due:0,returned:9,created:3}),/^Отменено до отплытия · T3$/);
 assert.match(app,/historyFilter==='returned'\?!!r\.returned:!r\.returned/);
 assert.match(app,/depart\.onclick=\(\)=>startRentalDeparture\(r,depart\)/);
});

test('search exposes unpaid pending rental and focuses payment row without starting payment',()=>{
 const rental={id:41,name:'Paddle guest',equipment:'sup',initial_due:2400,departure_pending:1,revision:2},manual={id:42,name:'',equipment:'service',initial_due:900,custom_json:'{"title":"Услуга ожидания"}'},results=new FixtureNode(),focus={};
 const paymentRow={scrollIntoView:options=>{focus.scroll=options;},querySelector:()=>({focus:options=>{focus.options=options;}})};
 const context={data:{pendingRentals:[rental,manual],waitingDepartures:[],active:[],dayRentals:[],fleet:[{id:'sup',label:'SUP'}]},searchResults:null,activeQuery:'Paddle',serverNow:()=>0,Desk:{matches:(row,q)=>row.name.includes(q),normalize:value=>value.toLowerCase(),active:()=>[]},text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className}),
  $:selector=>selector==='#desk-results'?results:selector==='#rental-payments [data-payment-rental="41"]'?paymentRow:null,switchDesk:view=>{focus.view=view;},requestAnimationFrame:fn=>fn(),searchActiveRentals:()=>[],shortTime:()=>'',notice(){},refresh(){},renderList(){},activeFilter:'all',expandedRental:null};
 vm.runInNewContext("const isPaidWaitingDeparture="+app.split(/\r?\n/).find(line=>line.startsWith('const isPaidWaitingDeparture=')).slice('const isPaidWaitingDeparture='.length)+"\n"+
  functionSource('waitingRows')+'\n'+functionSource('openSearchRental')+'\n'+functionSource('renderSearch'),context);
 context.renderSearch();const result=results.children.find(node=>node.textContent.includes('Ожидает оплаты · №41'));assert.ok(result);assert.match(result.textContent,/Paddle guest/);
 result.onclick();assert.equal(focus.view,'work');assert.equal(focus.scroll.block,'center');assert.equal(focus.options.preventScroll,true);
 context.activeQuery='Услуга';context.renderSearch();assert.ok(results.children.some(node=>node.textContent.includes('Услуга ожидания')));
});

test('deferred guest bill shows its bill link and term label without claiming payment or mounting refunds',()=>{
 const active=new FixtureNode(),summary=new FixtureNode('div');let panelRef;active.append(summary);
 const rental={id:24,name:'Guest',equipment:'sup',quantity:1,paid:0,initial_due:0,departure_pending:1,expected_return:Date.parse('2026-10-08T13:00:00+03:00'),departed:'2026-10-08T12:00',guestBillId:88,revision:1},freePrice={id:25,name:'Service',equipment:'service',quantity:1,paid:0,initial_due:0,departure_pending:1,custom_json:'{"title":"Free price"}',revision:1};let opened=0;
 let refundsMounted=0;const context={data:{waitingDepartures:[rental,freePrice],fleet:[{id:'sup',label:'SUP'},{id:'service',label:'Услуга'}]},user:{id:3},rowBusy:new Set(),activeQuery:'',rentalStage:'all',batteryTripsByRental:new Map(),waitingRows:()=>[rental],rentalEquipmentLabel:(r,label)=>label,setRentalEquipment:(node,r,label)=>{node.replaceChildren(new FixtureNode('span',label+(r.quantity>1?' ×'+r.quantity:'')));},rentalCatamaran:()=>null,catamaranLabels:()=>[],Desk:{matches:()=>true},document:{activeElement:new FixtureNode('body')},window:{STARTRefunds:{mount(){refundsMounted++;}},STARTGuests:{show:id=>{opened=id;}}},money:()=> '0 ₽',
  text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className}),refresh(){},
  $:selector=>selector==='#active-panel'?active:selector==='#waiting-departures'?panelRef||null:selector==='#active-summary'?summary:null};
 active.insertBefore=(node,before)=>{panelRef=node;node.parentElement=active;active.children.splice(active.children.indexOf(before),0,node);};
 vm.runInNewContext(functionSource('renderWaitingDepartures'),context);context.renderWaitingDepartures();const rendered=panelRef,row=rendered.children[1];
 assert.equal(row.children[3].className,'departure-status');assert.equal(row.children[3].children[0].className,'rental-status');assert.equal(row.children[3].children[0].textContent,'Ожидает отплытия');assert.equal(row.children[3].children[1].className,'departure-duration');assert.equal(row.children[3].children[1].textContent,'1 ч 0 мин');assert.equal(rendered.children[0].textContent,'Ожидают отплытия · 1');
 assert.ok(!row.children.some(node=>node.textContent.includes('Оплачено')));
 const bill=row.children.find(node=>node.className==='departure-bill');assert.ok(bill);assert.equal(bill.textContent,'В счёт гостя');bill.onclick();assert.equal(opened,88);
 assert.equal(refundsMounted,0);assert.ok(!row.children.some(node=>node.className==='rental-details'));
 const history=app.slice(app.indexOf('function renderDayRentals(){'),app.indexOf("$('#rental-history-day').onchange",app.indexOf('function renderDayRentals(){')));
 assert.match(history,/window\.STARTRefunds\?\.mount\(details,'rental',r\.id,user\.id,refresh\)/);
});

test('search and history distinguish waiting and canceled departures without a fake departure time',()=>{
 assert.match(app,/Ожидает отплытия · №/);
 assert.match(app,/openSearchRental\(r\.id\)/);
 assert.match(app,/Отменено до отплытия · /);
 assert.match(app,/!waiting&&Number\(r\.departure_pending\)!==1/);
 assert.match(app,/depart\.onclick=\(\)=>startRentalDeparture\(r,depart\)/);
 assert.match(app,/Ожидает оплаты · '\+shortTime\(r\.created\)/);
 assert.match(app,/window\.STARTRefunds\?\.mount\(details,'rental',r\.id,user\.id,refresh\)/);
 const history=app.slice(app.indexOf('function renderDayRentals(){'),app.indexOf("$('#rental-history-day').onchange",app.indexOf('function renderDayRentals(){')));
 assert.match(history,/window\.STARTRefunds\?\.mount\(details,'rental',r\.id,user\.id,refresh\)/);
});

test('calendar handles pending rentals across equipment types, later days, payment, and cancellation',()=>{
 const context={};vm.runInNewContext(calendarFunctionSource('walkVisible')+'\n'+calendarFunctionSource('walkLabel'),context);
 const start=Date.parse('2026-10-08T12:00:00+03:00'),dayStart=Date.parse('2026-10-08T00:00:00+03:00'),placeholderEnd=Date.parse('2026-10-08T13:00:00+03:00'),nextDay=Date.parse('2026-10-09T00:00:00+03:00');
 const waiting={equipment:'sup',departure_pending:1,departed:'2026-10-08T12:00',expected_return:placeholderEnd};
 assert.equal(context.walkVisible(waiting,nextDay,nextDay+86400000,''),true);
 assert.equal(context.walkVisible(waiting,start-86400000,start,''),false);
 assert.equal(context.walkLabel(waiting),'Ожидает отплытия');
 assert.equal(context.walkLabel({...waiting,initial_due:3500}),'Ожидает оплаты');
 const canceled={...waiting,returned:nextDay+120000};assert.equal(context.walkVisible(canceled,nextDay,nextDay+86400000,''),true);
 assert.equal(context.walkVisible(canceled,dayStart,nextDay,''),false);
 assert.equal(context.walkLabel(canceled),'Отменено до отплытия');
 assert.equal(context.walkVisible({...waiting,equipment:'kayak'},nextDay,nextDay+86400000,'kayak'),true);
 assert.equal(context.walkVisible({...waiting,custom_json:'{"title":"Free price"}'},nextDay,nextDay+86400000,''),false);
 assert.match(calendar,/departure_pending:'Ожидает отплытия'/);
 assert.match(calendar,/pending\?`\$\{r\.quantity\} шт\.`/);
});

test('loaded frontend assets use the requested cache version and compact rows fit',()=>{
 assert.match(html,/app\.js\?v=rental-controls-20261010-3/);
 assert.match(html,/rental-mockup\.css\?v=rental-controls-20261010-6/);
 assert.match(html,/rental-batteries\.js\?v=battery-controls-20261010-3/);
 assert.match(html,/calendar\.js\?v=rental-departure-20261008-1/);
 assert.match(html,/rental-departure\.css\?v=rental-departure-20261008-1/);
 assert.match(css,/grid-template-columns:minmax\(0,1fr\)/);
 assert.match(css,/overflow-wrap:anywhere/);
 assert.match(css,/\.departure-row>button\.primary\{grid-column:2;grid-row:2\/5/);
 assert.match(css,/\.departure-row>button\.departure-bill\{grid-column:1\/-1;grid-row:5/);
 assert.doesNotMatch(css,/\.departure-row>button\{grid-column:2/);
});
