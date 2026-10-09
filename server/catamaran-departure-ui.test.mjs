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
 assert.match(app,/api\('rental-depart',\{id:r\.id,revision:r\.revision\}\)/);
 assert.match(app,/rowBusy\.has\(r\.id\)/);
 assert.match(app,/Отплыли/);
 assert.match(app,/STARTRefunds\?\.mount\(details,'rental',r\.id,user\.id,refresh\)/);
});

test('departure completion redraws the active list after clearing rowBusy',async()=>{
 const id=71,button={disabled:false},calls=[],context={rowBusy:new Set(),renderWaitingDepartures(){},api:async(...args)=>calls.push(['api',...args]),refresh:async()=>calls.push(['refresh']),notice(){},renderList:(...args)=>calls.push(['render',...args,context.rowBusy.has(id)])};
 vm.runInNewContext(functionSource('startRentalDeparture'),context);await context.startRentalDeparture({id,revision:4},button);
 assert.equal(calls[0][0],'api');assert.equal(calls[0][1],'rental-depart');assert.equal(calls[0][2].id,id);assert.equal(calls[0][2].revision,4);
 assert.deepEqual(calls[1],['refresh']);assert.equal(calls[2][0],'render');assert.equal(calls[2][1],'#active-list');assert.equal(calls[2][2].length,0);assert.equal(calls[2][3],true);assert.equal(calls[2][4],false);assert.equal(button.disabled,false);assert.equal(context.rowBusy.has(id),false);
});

test('physical rental return action says Вернулись and keeps its surcharge amount and confirmation wording',()=>{
 const lines=app.split(/\r?\n/),start=lines.findIndex(line=>line.startsWith('function returnAmount(')),end=lines.findIndex((line,index)=>index>start&&line.startsWith('function setReturnButton('));
 assert.ok(start>=0&&end>start);const source=lines.slice(start,end+1).join('\n'),button=new FixtureNode('button');button.classList={toggle(){}};button.setAttribute=(key,value)=>{button[key]=value;};
 const context={text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className}),button};vm.runInNewContext(source+'\nsetReturnButton(button,{extension_due:1200});',context);
 assert.equal(button.children[0].textContent,'Вернулись');assert.match(button.children[1].textContent,/доплата/);assert.match(button.getAttribute?button.getAttribute('aria-label'):button['aria-label'],/^Вернулись · доплата/);
 assert.match(app,/text\('button','Вернулись','quick-return'\)/);
 assert.match(app,/text\('button','Принять и вернуть','primary'\)/);assert.match(app,/terminal\?'Оплатить и вернуть':'Принять и вернуть'/);
});

function functionSource(name){
 const lines=app.split(/\r?\n/),start=lines.findIndex(line=>new RegExp('^(async )?function '+name+'\\(').test(line));
 assert.ok(start>=0,`missing ${name}`);const end=lines.findIndex((line,index)=>index>start&&line==='}');assert.ok(end>start,`unterminated ${name}`);return lines.slice(start,end+1).join('\n');
}
function calendarFunctionSource(name){
 const lines=calendar.split(/\r?\n/),line=lines.find(value=>value.trimStart().startsWith('function '+name+'('));assert.ok(line,`missing calendar ${name}`);return line.trim();
}
class FixtureNode{
 constructor(tag='div',value=''){this.tag=tag;this.textContent=value;this.children=[];this.dataset={};this.hidden=false;this.disabled=false;this.className='';this.parentElement=null;}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children=[...nodes];}
 querySelector(){return null;}
 contains(){return false;}
}
function paymentFixture(rows,payments=[]){
 const panel=new FixtureNode(),context={data:{pendingRentals:rows.filter(r=>r.initial_due>0),waitingDepartures:rows.filter(r=>r.departure_pending&&!r.initial_due),active:[],dayRentals:[],rentalPayments:payments},
  document:{createElement:tag=>new FixtureNode(tag)},$:selector=>selector==='#rental-payments'?panel:new FixtureNode(),text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className}),money:value=>String(value),paymentDiagnostic:()=>null,
  canStartRentalPayment:(r,p)=>!!r&&(!p||p.state==='cancelled')&&(Number(r.initial_due)>0||Number(r.extension_due)>0),startRentalPayment(){},refresh(){},openRentalReconciliation(){},window:{}};
 vm.runInNewContext(functionSource('renderRentalPayments'),context);context.renderRentalPayments();return {panel,context};
}

test('unpaid rental retains payment actions while paid pending rental has no cash, retry, or cancel controls',()=>{
 const unpaid={id:11,name:'Unpaid',equipment:'sup',initial_due:2400,departure_pending:1,revision:1};
 const paid={id:12,name:'Paid',equipment:'kayak',initial_due:0,paid:2400,departure_pending:1,revision:1};
 const {panel}=paymentFixture([unpaid,paid],[{rentalId:12,state:'paid',phase:'issue',paid:true,label:'Оплата получена'}]);
 const controls=panel.children.slice(1).map(row=>row.children.filter(node=>node.tag==='button').map(node=>node.textContent));
 assert.ok(controls[0].includes('Оплатить'));
 assert.ok(controls[0].includes('Получено наличными'));
 assert.ok(controls[0].includes('Отменить выдачу'));
 assert.ok(!controls[1].some(label=>['Оплатить','Повторить на кассе','Получено наличными','Отменить выдачу'].includes(label)));
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

test('deferred guest bill shows its bill link and term label without claiming payment',()=>{
 const active=new FixtureNode(),summary=new FixtureNode('div');let panelRef;active.append(summary);
 const rental={id:24,name:'Guest',equipment:'sup',quantity:1,paid:0,initial_due:0,departure_pending:1,expected_return:Date.parse('2026-10-08T13:00:00+03:00'),departed:'2026-10-08T12:00',guestBillId:88,revision:1},freePrice={id:25,name:'Service',equipment:'service',quantity:1,paid:0,initial_due:0,departure_pending:1,custom_json:'{"title":"Free price"}',revision:1};let opened=0;
 const context={data:{waitingDepartures:[rental,freePrice],fleet:[{id:'sup',label:'SUP'},{id:'service',label:'Услуга'}]},user:{id:3},rowBusy:new Set(),document:{activeElement:new FixtureNode('body')},window:{STARTRefunds:{mount(){}} ,STARTGuests:{show:id=>{opened=id;}}},money:()=> '0 ₽',
  text:(tag,value,className)=>Object.assign(new FixtureNode(tag,value),{className}),refresh(){},
  $:selector=>selector==='#active-panel'?active:selector==='#waiting-departures'?panelRef||null:selector==='#active-summary'?summary:null};
 active.insertBefore=(node,before)=>{panelRef=node;node.parentElement=active;active.children.splice(active.children.indexOf(before),0,node);};
 vm.runInNewContext(functionSource('renderWaitingDepartures'),context);context.renderWaitingDepartures();const rendered=panelRef,row=rendered.children[1];
 assert.equal(row.children.find(node=>node.tag==='small').textContent,'Срок · 60 мин.');assert.equal(rendered.children[0].textContent,'Ожидают отплытия · 1');
 assert.ok(!row.children.find(node=>node.tag==='small').textContent.includes('Оплачено'));
 const bill=row.children.find(node=>node.tag==='button'&&node.textContent.includes('В счёте гостя'));assert.ok(bill);bill.onclick();assert.equal(opened,88);
 const preserved=[...rendered.children];rendered.querySelector=selector=>selector==='.refund-panel[open]'?{open:true}:null;context.renderWaitingDepartures();assert.deepEqual(rendered.children,preserved);
});

test('search and history distinguish waiting and canceled departures without a fake departure time',()=>{
 assert.match(app,/Ожидает отплытия · №/);
 assert.match(app,/openSearchRental\(r\.id\)/);
 assert.match(app,/Отменено до отплытия · /);
 assert.match(app,/!waiting&&Number\(r\.departure_pending\)!==1/);
 assert.match(app,/depart\.onclick=\(\)=>startRentalDeparture\(r,depart\)/);
 assert.match(app,/Ожидает оплаты · '\+shortTime\(r\.created\)/);
 assert.match(app,/\.refund-panel\[open\]/);
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
 assert.match(html,/app\.js\?v=rental-departure-20261008-1/);
 assert.match(html,/calendar\.js\?v=rental-departure-20261008-1/);
 assert.match(html,/rental-departure\.css\?v=rental-departure-20261008-1/);
 assert.match(css,/grid-template-columns:minmax\(0,1fr\)/);
 assert.match(css,/overflow-wrap:anywhere/);
 assert.match(css,/\.departure-row>button\.primary\{grid-column:2;grid-row:2\/5/);
 assert.match(css,/\.departure-row>button\.departure-bill\{grid-column:1\/-1;grid-row:5/);
 assert.doesNotMatch(css,/\.departure-row>button\{grid-column:2/);
});
