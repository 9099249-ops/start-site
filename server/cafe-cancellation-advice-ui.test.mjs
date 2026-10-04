import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
test('Cancellation help hides only the form submit, never its primary resolution action',()=>{
 const section=source.slice(source.indexOf('function cancellationAdvice('),source.indexOf('function cancelOrder('));
 assert.match(section,/openRefund/);
 assert.equal(source.includes("$('#editor-form').querySelector('.primary')"),false);
 assert.equal(source.split("$('#editor-form').querySelector(':scope > button.primary')").length-1,3);
});
function fixture(fresh){
 const events=[],panel={open:false,scrollIntoView(){events.push('scroll');}},out={children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;}};
 const context={make:(tag,text)=>({tag,text}),button:(label,action)=>({label,action}),money:n=>String(n),$:s=>s==='#editor'?{close(){events.push('close');}}:{querySelector:()=>panel},openOrder:async id=>events.push(id),api:async()=>fresh,cancelOrder:r=>events.push(['cancel',r.id]),reconciliationActions:()=>events.push('reconcile'),receiptActions:()=>events.push('receipt'),window:{STARTGuests:{show:id=>events.push(['bill',id])}}};
 runInNewContext(source.slice(source.indexOf('function cancellationAdvice('),source.indexOf('function cancelOrder(')),context);
 return {context,out,events,panel};
}
const order=extra=>({id:21,status:'ACCEPTED',total_cents:35000,refundedCents:0,details:{terminalPaidAt:123,terminalPaymentRequired:true},terminalPayment:{state:'cash_done',paid:true},...extra});
test('Settled cash cancellation immediately offers refund and opens the existing panel',async()=>{
 const f=fixture();assert.equal(f.context.cancellationAdvice(f.out,order()),true);assert.match(f.out.children[0].text,/уже оплачен/);assert.equal(f.out.children[1].label,'Открыть возврат · 35000');
 await f.out.children[1].action();assert.deepEqual(f.events,['close',21,'scroll']);assert.equal(f.panel.open,true);
});
test('Partial refund offers only the remaining amount',()=>{
 const f=fixture();f.context.cancellationAdvice(f.out,order({refundedCents:10000}));assert.equal(f.out.children[1].label,'Открыть возврат · 25000');
});
test('Full refund allows cancellation of an active settled order',()=>{
 const f=fixture();assert.equal(f.context.cancellationAdvice(f.out,order({refundedCents:35000})),false);
});
test('Delivered refunded order explains why it remains completed',()=>{
 const f=fixture();assert.equal(f.context.cancellationAdvice(f.out,order({status:'DELIVERED',refundedCents:35000})),true);assert.match(f.out.children[0].text,/остаётся выполненным/);
});
for(const paid of [false,true])test('Unresolved payment offers verification before any refund, paid='+paid,()=>{
 const f=fixture();f.context.cancellationAdvice(f.out,order({terminalPayment:{state:paid?'receipt_unknown':'payment_unknown',paid}}));assert.deepEqual(f.events,['reconcile','receipt']);assert.equal(f.out.children.some(node=>node.label?.includes('возврат')),false);
});
test('Payment refresh returns to cancellation after the lock is safely gone',async()=>{
 const fresh=order({details:{terminalPaymentRequired:true},terminalPayment:{state:'cancelled',paid:false}}),f=fixture(fresh);
 f.context.cancellationAdvice(f.out,order({terminalPayment:{state:'payment_unknown',paid:false}}));await f.out.children.find(node=>node.label==='Проверить статус оплаты').action();assert.deepEqual(f.events.slice(-2),['close',['cancel',21]]);
});
test('Guest order directs staff to its bill',async()=>{
 const f=fixture();f.context.cancellationAdvice(f.out,order({details:{guestBillId:2}}));await f.out.children[1].action();assert.deepEqual(f.events,['close',['bill',2]]);
});
