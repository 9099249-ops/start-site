import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const read=name=>readFileSync(new URL('../dist/admin/'+name,import.meta.url),'utf8');
const payment={id:'new-operation',state:'payment_waiting',paymentOperationId:42};
function fixture(extra={}){
 const calls=[],prompts=[],events=[];
 const context={Event,window:{STARTTerminalVoice:{prompt:(p,options)=>prompts.push({payment:p,options})}},document:{dispatchEvent:e=>events.push(e.type)},...extra};
 return {calls,prompts,events,context};
}

test('Existing cafe payment passes the accepted response and previous operation without another payment request',async()=>{
 const f=fixture({openOrder:async()=>{},loadOrders:async()=>{}});
 f.context.api=async(path,body)=>{f.calls.push({path,body});return payment;};
 runInNewContext(read('cafe.js').split('\n').find(line=>line.startsWith('async function payOrder(')),f.context);
 for(const cash of [false,true])await f.context.payOrder({id:7,revision:3,terminalPayment:{id:'old-operation',state:'cancelled'}},cash);
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(x=>x.body.cash),[false,true]);
 assert.deepEqual(f.prompts.map(x=>[x.payment.id,x.options.cash,x.options.previousId]),[['new-operation',false,'old-operation'],['new-operation',true,'old-operation']]);
 f.context.api=async()=>{throw Error('Unavailable');};
 await assert.rejects(f.context.payOrder({id:7,revision:3}),/Unavailable/);assert.equal(f.prompts.length,2);
});

test('New cafe order prompts immediately after acceptance even when the later status read fails',async()=>{
 const f=fixture({selectCafeTab:async()=>{},loadOrders:async()=>{},clearTimeout(){},noticeTimer:null,notice(){},safe:fn=>fn,$:()=>({replaceChildren(){},append(){}}),make:()=>({}),openOrder:async()=>{}});
 let reads=0;
 f.context.window.STARTCafeNumber=String;
 f.context.document.createTextNode=text=>text;
 f.context.api=async(path,body)=>{f.calls.push({path,body});if(path==='pay')return payment;if(++reads>1)throw Error('Lost status response');return {id:7,revision:3,terminalPayment:{id:'old-operation',state:'cancelled'}};};
 const source=read('cafe.js');runInNewContext(source.slice(source.indexOf('async function createdCafeOrder('),source.indexOf("document.addEventListener('cafe-order-created'")),f.context);
 await f.context.createdCafeOrder({detail:{id:7,payNow:true,cashRequested:false}});
 assert.equal(f.calls.filter(x=>x.path==='pay').length,1);assert.equal(f.prompts.length,1);
 assert.equal(f.prompts[0].payment,payment);assert.equal(f.prompts[0].options.previousId,'old-operation');
});

test('Rental payment forwards cash and the matching phase operation without changing the request',async()=>{
 const f=fixture({data:{active:[{id:7,revision:3}],pendingRentals:[],rentalPayments:[{id:'old-operation',rentalId:7,phase:'issue',state:'cancelled'}]},rowBusy:new Set(),rentalCashConfirm:true,notice(){},refresh:async()=>{}});
 f.context.api=async(path,body)=>{f.calls.push({path,body});return payment;};
 const source=read('app.js');runInNewContext(source.slice(source.indexOf('async function startRentalPayment('),source.indexOf('function openRentalReconciliation(')),f.context);
 for(const cash of [false,true])await f.context.startRentalPayment(7,'issue',cash);
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(x=>[x.body.phase,x.body.cash,x.body.retryPaymentId]),[['issue',false,'old-operation'],['issue',true,'old-operation']]);
 assert.deepEqual(f.prompts.map(x=>[x.options.cash,x.options.previousId]),[[false,'old-operation'],[true,'old-operation']]);
});

test('Rental return prompts from the accepted extension payment, before refreshing the list',async()=>{
 const f=fixture({data:{active:[{id:7,revision:3,extension_due:1000}],rentalPayments:[{id:'old-operation',rentalId:7,phase:'extension',state:'cancelled'}]},rowBusy:new Set(),confirmReturnPayment:async()=>({cash:false}),refresh:async()=>{assert.equal(f.prompts.length,1);},notice(){},renderList(){}});
 f.context.api=async(path,body)=>{f.calls.push({path,body});return {payment};};
 runInNewContext(read('app.js').split('\n').find(line=>line.startsWith('async function returnRental(')),f.context);
 await f.context.returnRental(7,{disabled:false});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'return');
 assert.equal(f.prompts[0].payment,payment);assert.equal(f.prompts[0].options.previousId,'old-operation');
});

test('Guest bill payment uses only the explicit pay response and keeps cash handling unchanged',async()=>{
 const f=fixture({b:{id:7,revision:3,payment:{id:'old-operation',state:'cancelled'}},busy:false,draw:async()=>{}});
 f.context.api=async(path,body)=>{f.calls.push({path,body});return payment;};
 runInNewContext(read('guest-bills.js').split('\n').find(line=>line.includes('async function pay(cash){busy=true;')),f.context);
 for(const cash of [false,true])await f.context.pay(cash);
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(x=>[x.path,x.body.cash,x.body.retryPaymentId]),[['guest-bills/pay',false,'old-operation'],['guest-bills/pay',true,'old-operation']]);
 assert.deepEqual(f.prompts.map(x=>[x.options.cash,x.options.previousId]),[[false,'old-operation'],[true,'old-operation']]);
 assert.equal(f.context.busy,false);
});
