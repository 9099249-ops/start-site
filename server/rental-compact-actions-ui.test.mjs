import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../dist/admin/app.js',import.meta.url),'utf8');
const lines=app.split(/\r?\n/);

function fn(name){
 const start=lines.findIndex(line=>new RegExp('^(async )?function '+name+'\\(').test(line));
 assert.ok(start>=0,`missing ${name}`);
 const end=lines.findIndex((line,index)=>index>start&&line==='}');
 assert.ok(end>start,`unterminated ${name}`);
 return lines.slice(start,end+1).join('\n');
}

class Node{
 constructor(tag='div',textContent=''){this.tag=tag;this.textContent=textContent;this.children=[];this.dataset={};this.disabled=false;this.hidden=false;this.title='';this.attributes={};this.classList={add(){},toggle(){}};}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
 setAttribute(name,value){this.attributes[name]=value;}
 addEventListener(){}
 close(){this.open=false;this.onclose?.();}
 showModal(){this.open=true;}
 remove(){this.removed=true;}
}

function paymentContext({row,api,refresh=async()=>{},notice=()=>{},voice={prompt(){}},confirm=()=>{throw Error('Unexpected confirmation');}}){
 const calls=[];
 const context={
  data:{pendingRentals:[row],waitingDepartures:[],active:[],dayRentals:[],rentalPayments:[]},rowBusy:new Set(),
  api:async(...args)=>{calls.push(args);return api?api(...args):{label:'Наличные приняты',state:'cash_done'};},
  refresh,notice,window:{STARTTerminalVoice:voice},money:value=>`${value} ₽`,
  text:(tag,value)=>new Node(tag,value),document:{createElement:tag=>new Node(tag)},
  confirm,canStartRentalPayment:()=>true,paymentDiagnostic:()=>null,
  $:()=>new Node(),openRentalReconciliation(){},renderList(){},renderWaitingDepartures(){},
 };
 const phase=lines.find(line=>line.startsWith('const rentalPaymentPhase='));assert.ok(phase);
 vm.runInNewContext([phase,fn('startRentalPayment'),fn('renderRentalPayments')].join('\n'),context);
 return {context,calls};
}

test('cash payment button starts directly with exact phase, revision and amount; duplicate clicks share one request',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),row={id:51,name:'Guest',initial_due:7350,revision:8};
 const voice=[],notices=[],f=paymentContext({row,api:async(path,body)=>{await gate;return {label:'Приняты наличные',state:'cash_done',amountCents:body.amount};},voice:{prompt:(...args)=>voice.push(args)},notice:value=>notices.push(value)});
 f.context.data.rentalPayments=[{rentalId:51,phase:'extension',id:91,state:'cancelled'}];
 f.context.data.pendingRentals[0].extension_due=7350;
 const panel=new Node();f.context.$=selector=>selector==='#rental-payments'?panel:new Node();
 f.context.renderRentalPayments();
 const rowNode=panel.children.find(node=>node.dataset.paymentRental==='51');
 const cash=rowNode.children.find(node=>node.tag==='button'&&node.textContent.startsWith('Наличные'));
 assert.ok(cash);assert.match(cash.textContent,/7\s?350/);
 const first=cash.onclick(),second=cash.onclick();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'rental-pay');assert.deepEqual({...f.calls[0][1]},{id:51,phase:'extension',revision:8,cash:true,retryPaymentId:91});
 release();await Promise.all([first,second]);
 assert.equal(voice.length,1);assert.equal(voice[0][1].cash,true);assert.match(notices[0],/Приняты наличные/);
});

test('cash payment failure is shown and does not invoke terminal voice',async()=>{
 const row={id:52,initial_due:1200,revision:3},notices=[],voice=[];
 const f=paymentContext({row,api:async()=>{throw Error('Касса недоступна');},notice:value=>notices.push(value),voice:{prompt:(...args)=>voice.push(args)}});
 await f.context.startRentalPayment(52,'issue',true);
 assert.deepEqual(notices,['Касса недоступна']);assert.deepEqual(voice,[]);
 assert.equal(f.calls[0][0],'rental-pay');assert.equal(f.calls[0][1].id,52);assert.equal(f.calls[0][1].phase,'issue');assert.equal(f.calls[0][1].revision,3);assert.equal(f.calls[0][1].cash,true);assert.equal(f.calls[0][1].retryPaymentId,undefined);
});

test('manual card confirmation reconciles once with exact rental and payment revisions, never the provider payment route',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),calls=[],notices=[],events=[];
 const row={id:55,revision:14,initial_due:6400,extension_due:0},payment={id:208,rentalId:55,phase:'issue',state:'cancelled'};
 const context={rowBusy:new Set(),canStartRentalPayment:undefined,notice:value=>notices.push(value),api:async(...args)=>{calls.push(args);await gate;},document:{dispatchEvent:event=>events.push(event)},Event:function(name){this.type=name;},refresh:async()=>{}};
 const eligible=lines.find(line=>line.startsWith('const canStartRentalPayment=')),phase=lines.find(line=>line.startsWith('const rentalPaymentPhase='));assert.ok(eligible&&phase);
 vm.runInNewContext(eligible+'\n'+phase+'\n'+fn('confirmManualRentalCard'),context);
 const first=context.confirmManualRentalCard(row,payment),second=context.confirmManualRentalCard(row,payment);
 assert.equal(calls.length,1);assert.equal(calls[0][0],'rental-reconcile');
 assert.deepEqual({...calls[0][1]},{id:55,revision:14,phase:'issue',paymentId:208,result:'card',confirmed:true,terminalIdle:true,receiptExists:true,note:'Сотрудник подтвердил кнопкой: оплата и фискальный чек уже пробиты вручную, операция на CS50 завершена.'});
 release();await Promise.all([first,second]);
 assert.deepEqual(calls.map(call=>call[0]),['rental-reconcile']);assert.deepEqual(notices,['Оплата учтена · №55']);assert.equal(events[0].type,'station-updated');
});

test('manual card confirmation allows a cancelled payment and blocks unknown, guest-bill, and busy rows',async()=>{
 const calls=[],context={rowBusy:new Set(),notice(){},api:async(...args)=>calls.push(args),document:{dispatchEvent(){}},Event:function(){},refresh:async()=>{}};
 const eligible=lines.find(line=>line.startsWith('const canStartRentalPayment=')),phase=lines.find(line=>line.startsWith('const rentalPaymentPhase='));vm.runInNewContext(eligible+'\n'+phase+'\n'+fn('confirmManualRentalCard'),context);
 const row={id:56,revision:5,initial_due:2000};
 await context.confirmManualRentalCard(row,{id:301,phase:'issue',state:'cancelled'});
 assert.equal(calls.length,1);assert.equal(calls[0][0],'rental-reconcile');assert.equal(calls[0][1].paymentId,301);
 await context.confirmManualRentalCard(row,{id:302,phase:'issue',state:'payment_waiting'});
 await context.confirmManualRentalCard({...row,guestBillId:90},null);
 context.rowBusy.add(row.id);await context.confirmManualRentalCard(row,null);context.rowBusy.clear();
 assert.equal(calls.length,1);
});

test('manual card reconciliation failure is shown and releases the row guard',async()=>{
 const notices=[],calls=[],row={id:57,revision:9,initial_due:3000};
 const context={rowBusy:new Set(),notice:value=>notices.push(value),api:async(...args)=>{calls.push(args);throw Error('Сверка отклонена');},document:{dispatchEvent(){}},Event:function(){},refresh:async()=>{}};
 const eligible=lines.find(line=>line.startsWith('const canStartRentalPayment=')),phase=lines.find(line=>line.startsWith('const rentalPaymentPhase='));vm.runInNewContext(eligible+'\n'+phase+'\n'+fn('confirmManualRentalCard'),context);
 await context.confirmManualRentalCard(row,null);
 assert.equal(calls.length,1);assert.equal(calls[0][0],'rental-reconcile');assert.equal(calls[0][1].paymentId,null);assert.deepEqual(notices,['Сверка отклонена']);assert.equal(context.rowBusy.has(row.id),false);
});

test('manual card confirmation with extension due and no payment record reconciles the extension phase',async()=>{
 const calls=[],row={id:58,revision:11,initial_due:0,extension_due:1850};
 const context={rowBusy:new Set(),notice(){},api:async(...args)=>calls.push(args),document:{dispatchEvent(){}},Event:function(){},refresh:async()=>{}};
 const eligible=lines.find(line=>line.startsWith('const canStartRentalPayment=')),phase=lines.find(line=>line.startsWith('const rentalPaymentPhase='));vm.runInNewContext(eligible+'\n'+phase+'\n'+fn('confirmManualRentalCard'),context);
 await context.confirmManualRentalCard(row,null);
 assert.equal(calls.length,1);assert.equal(calls[0][0],'rental-reconcile');
 assert.deepEqual({...calls[0][1]},{id:58,revision:11,phase:'extension',paymentId:null,result:'card',confirmed:true,terminalIdle:true,receiptExists:true,note:'Сотрудник подтвердил кнопкой: оплата и фискальный чек уже пробиты вручную, операция на CS50 завершена.'});
});

test('cash return bypasses card prompt and sends exact extension amount and revision without terminal',async()=>{
 const row={id:61,extension_due:4200,revision:12},calls=[],notices=[],voice=[];
 const context={data:{active:[row],dayRentals:[],rentalTerminalEnabled:false,rentalPayments:[]},rowBusy:new Set(),window:{STARTTerminalVoice:{prompt:(...args)=>voice.push(args)},STARTUx:{event(){}}},
  api:async(...args)=>{calls.push(args);return {};},
  confirm:()=>{throw Error('Cash return must not ask for card confirmation');},notice:value=>notices.push(value),refresh:async()=>{},renderList(){},
  text:(tag,value)=>new Node(tag,value),money:value=>`${value} ₽`,document:{createElement:tag=>new Node(tag)},setTimeout(){}};
 vm.runInNewContext([fn('cashReturnConfirmation'),fn('confirmReturnPayment'),fn('returnRental')].join('\n'),context);
 const button=new Node('button');await context.returnRental(61,button,true);
 assert.equal(calls[0][0],'return');assert.deepEqual({...calls[0][1],payment:{...calls[0][1].payment}},{id:61,revision:12,payment:{confirmed:true,method:'cash',amountCents:4200}});
 assert.deepEqual(voice,[]);assert.ok(notices.some(message=>message.includes('Аренда закрыта')));
});

test('cash return uses terminal cash marker when enabled and exposes request errors',async()=>{
 const row={id:62,extension_due:9900,revision:2},calls=[],notices=[];
 const context={data:{active:[row],dayRentals:[],rentalTerminalEnabled:true,rentalPayments:[]},rowBusy:new Set(),window:{},
  api:async(...args)=>{calls.push(args);throw Error('Возврат не сохранён');},confirm:()=>{throw Error('Unexpected cash confirmation');},notice:value=>notices.push(value),refresh:async()=>{},renderList(){},
  text:(tag,value)=>new Node(tag,value),money:value=>`${value} ₽`,document:{createElement:tag=>new Node(tag)},setTimeout(){}};
 vm.runInNewContext([fn('cashReturnConfirmation'),fn('confirmReturnPayment'),fn('returnRental')].join('\n'),context);
 const button=new Node('button');await context.returnRental(62,button,true);
 assert.equal(calls[0][0],'return');assert.deepEqual({...calls[0][1]},{id:62,revision:2,cash:true});assert.deepEqual(notices,['Возврат не сохранён']);
 assert.equal(context.rowBusy.has(62),false);assert.equal(button.disabled,false);
});

test('manual surcharge return reconciles directly once with the extension payment and never calls return or provider payment',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),calls=[],notices=[];
 const row={id:63,extension_due:5600,revision:17},payment={id:410,rentalId:63,phase:'extension',state:'cancelled'},button=new Node('button');
 const context={data:{active:[row],dayRentals:[],rentalPayments:[payment],rentalTerminalEnabled:true},rowBusy:new Set(),
  api:async(...args)=>{calls.push(args);await gate;},canStartRentalPayment:undefined,
  notice:value=>notices.push(value),refresh:async()=>{},renderList(){},text:(tag,value)=>new Node(tag,value),money:value=>`${value} ₽`,
  document:{dispatchEvent(){}},Event:function(){},window:{}};
 const canStart=lines.find(line=>line.startsWith('const canStartRentalPayment='));vm.runInNewContext(canStart+'\n'+fn('returnRental'),context);
 context.canStartRentalPayment=context.canStartRentalPayment;
 const first=context.returnRental(63,button,false,true),second=context.returnRental(63,button,false,true);
 assert.equal(calls.length,1);assert.equal(calls[0][0],'rental-reconcile');
 assert.deepEqual({...calls[0][1]},{id:63,revision:17,phase:'extension',paymentId:410,result:'card',confirmed:true,terminalIdle:true,receiptExists:true,note:'Сотрудник подтвердил: доплата и фискальный чек пробиты вручную, операция на CS50 завершена.'});
 release();await Promise.all([first,second]);
 assert.deepEqual(calls.map(call=>call[0]),['rental-reconcile']);assert.deepEqual(notices,['Доплата учтена · аренда закрыта.']);
});

test('direct manual surcharge return blocks guest bills and unknown payment states',async()=>{
 const calls=[],notices=[],row={id:64,extension_due:2300,revision:3},context={data:{active:[row],dayRentals:[],rentalPayments:[],rentalTerminalEnabled:true},rowBusy:new Set(),
  api:async(...args)=>calls.push(args),canStartRentalPayment:undefined,notice:value=>notices.push(value),refresh:async()=>{},renderList(){},
  text:(tag,value)=>new Node(tag,value),money:value=>`${value} ₽`,document:{dispatchEvent(){}},Event:function(){},window:{}};
 const canStart=lines.find(line=>line.startsWith('const canStartRentalPayment='));vm.runInNewContext(canStart+'\n'+fn('returnRental'),context);
 context.data.rentalPayments=[{id:411,rentalId:64,phase:'extension',state:'payment_waiting'}];
 await context.returnRental(64,new Node('button'),false,true);
 context.data.rentalPayments=[];context.data.active[0].guestBillId=88;
 await context.returnRental(64,new Node('button'),false,true);
 assert.equal(calls.length,0);assert.equal(notices.length,2);assert.ok(notices.every(message=>message.includes('Сначала сверьте')));
});

test('departure errors remain visible',async()=>{
 const row={id:73,revision:6},calls=[],notices=[];
 const context={rowBusy:new Set(),renderWaitingDepartures(){},renderList(){},notice:value=>notices.push(value),
  api:async(...args)=>{calls.push(args);if(args[0]==='rental-depart')throw Error('Выдача не сохранена');},refresh:async()=>{}};
 vm.runInNewContext(fn('startRentalDeparture'),context);
 await context.startRentalDeparture(row,new Node('button'));
 assert.equal(calls.length,1);assert.equal(calls[0][0],'rental-depart');assert.deepEqual({...calls[0][1]},{id:73,revision:6});assert.deepEqual(notices,['Выдача не сохранена']);
});

test('successful departure has no success toast and starts no payment',async()=>{
 const calls=[],notices=[];
 const context={rowBusy:new Set(),renderWaitingDepartures(){},renderList(){},notice:value=>notices.push(value),api:async(...args)=>calls.push(args),refresh:async()=>{}};
 vm.runInNewContext(fn('startRentalDeparture'),context);
 await context.startRentalDeparture({id:74,revision:1},new Node('button'));
 assert.equal(calls.length,1);assert.equal(calls[0][0],'rental-depart');assert.deepEqual({...calls[0][1]},{id:74,revision:1});assert.deepEqual(notices,['']);
 assert.doesNotMatch(fn('startRentalDeparture'),/startRentalPayment/);
});

test('active rental quick cash return is rendered only while an extension surcharge is due',()=>{
 const source=fn('renderList');
 assert.match(source,/r\.extension_due&&!cashButton/);
 assert.match(source,/cashButton\.onclick=\(\)=>returnRental\(r\.id,cashButton,true\)/);
 assert.match(source,/directPayment=!!r\.extension_due&&!r\.guestBillId&&canStartRentalPayment\(r,extensionPayment\)/);
 assert.match(source,/cashButton\.hidden=!directPayment/);
 assert.match(source,/quick-manual-return/);
 assert.match(source,/returnRental\(r\.id,manualButton,false,true\)/);
 assert.match(source,/manualButton\.hidden=!data\.rentalTerminalEnabled\|\|!directPayment/);
});
