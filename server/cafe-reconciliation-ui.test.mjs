import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
function fixture(confirmed=true){
 const calls=[],prompts=[];
 const make=(tag,text)=>({tag,text,children:[],append(...nodes){this.children.push(...nodes);}});
 const context={make,money:n=>String(n),window:{STARTCafeNumber:id=>String(id)},confirm:message=>{prompts.push(message);return confirmed;},button:(label,action)=>({label,action}),needsTerminal:()=>true,api:async(path,body)=>calls.push({path,body}),loadOrders:async()=>{},openOrder:async()=>{},document:{dispatchEvent(){}},Event};
 runInNewContext(source.slice(source.indexOf('function manualPaidActions('),source.indexOf('function receiptActions(')),context);
 return {context,calls,prompts,root:make('div')};
}
const order=payment=>({id:4,revision:2,total_cents:35000,terminalPayment:payment});
for(const result of ['unpaid','card','cash'])test('Cafe reconciliation '+result+' uses one confirmation and automatic audit note',async()=>{
 const f=fixture();f.context.reconciliationActions(f.root,order({id:'payment-1',state:'payment_unknown',paid:false}));
 const actions=f.root.children.filter(node=>node.action);assert.equal(actions.length,3);assert.equal(f.root.children.some(node=>node.tag==='input'||node.tag==='select'),false);
 await actions[['unpaid','card','cash'].indexOf(result)].action();
 assert.equal(f.prompts.length,1);assert.match(f.prompts[0],/35000/);assert.match(f.prompts[0],/завершён/);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'reconcile-payment');
 const b=f.calls[0].body;assert.equal(b.id,4);assert.equal(b.paymentId,'payment-1');assert.equal(b.result,result);assert.equal(b.confirmed,true);assert.ok(b.note.length>0&&b.note.length<=300);
});
test('Cancelling reconciliation confirmation makes no request',async()=>{
 const f=fixture(false);f.context.reconciliationActions(f.root,order({id:'p',state:'review'}));
 await f.root.children.find(node=>node.action).action();assert.equal(f.calls.length,0);
});
test('Confirmed payments cannot be declared unpaid using reconciliation actions',()=>{
 for(const payment of [{id:'p',state:'review',paid:true},{id:'p',state:'done',paid:true},null]){
  const f=fixture();f.context.reconciliationActions(f.root,order(payment));assert.equal(f.root.children.length,0);
 }
});
for(const method of ['card','cash'])test('Manual '+method+' accounting needs no number or intermediate form',async()=>{
 const f=fixture();f.context.manualPaidActions(f.root,order(null));assert.equal(f.root.children.length,2);
 await f.root.children[method==='card'?0:1].action();assert.equal(f.prompts.length,1);
 const b=f.calls[0].body;assert.equal(f.calls[0].path,'manual-paid');assert.equal(b.method,method);assert.equal(b.revision,2);assert.equal(b.receiptExists,true);assert.equal(b.terminalIdle,true);assert.equal(b.confirmed,true);assert.ok(b.note.length>0);
});
test('Unknown payment only offers guarded reconciliation, not generic manual payment',()=>{
 const f=fixture();f.context.manualPaidActions(f.root,order({id:'p',state:'payment_unknown'}));assert.equal(f.root.children.length,0);
});
