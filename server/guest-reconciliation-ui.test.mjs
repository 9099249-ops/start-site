import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/guest-bills.js',import.meta.url),'utf8');
const methodsStart=source.indexOf('function billPaymentMethods');
const methods=source.slice(methodsStart,source.indexOf('\nconst el=',methodsStart));
const start=source.indexOf(' if(b.totalCents&&!b.cancelled_at&&');
const block=source.slice(start,source.indexOf('if(target&&id)',start));
function fixture(confirmed=true){
 const calls=[],actions=[],prompts=[];
 const el=(tag,text)=>({tag,text,children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;}});
 const b={id:1,revision:3,totalCents:50000,payment:{id:'payment-1',state:'review'}};
 const context={b,m:{body:el('div')},el,button:(parent,label,action)=>{const item={label,action};actions.push(item);const node=el('button',label);node.action=action;node.classList={add(){}};parent.append(node);return node;},confirm:message=>{prompts.push(message);return confirmed;},prompt:()=>null,money:n=>String(n),api:async(path,body)=>calls.push({path,body}),draw:async()=>{},document:{dispatchEvent(){}},Event,signature:'old',uncertain:true,editable:false,busy:false};
 runInNewContext(methods,context);runInNewContext(block,context);return {calls,actions,prompts,context};
}
const descendants=node=>[node,...node.children.flatMap(descendants)];
for(const method of ['card','cash'])test('Guest bill manual '+method+' records confirmed payment once',async()=>{
 const f=fixture();const nested=descendants(f.context.m.body);assert.equal(f.actions.length,2);assert.ok(nested.some(node=>node.className==='guest-manual-payment'));assert.equal(nested.some(node=>['input','select'].includes(node.tag)),false);
 await f.actions[method==='card'?0:1].action();assert.equal(f.prompts.length,1);assert.match(f.prompts[0],/фискальный чек пробит/);assert.match(f.prompts[0],/повторного списания и печати чека не будет/);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'guest-bills/manual-paid');const b=f.calls[0].body;
 assert.equal(b.id,1);assert.equal(b.revision,3);assert.equal(b.paymentId,'payment-1');assert.equal(b.method,method);assert.equal(b.confirmed,true);assert.equal(b.receiptExists,true);assert.equal(b.terminalIdle,true);
});
test('Declining guest bill manual confirmation sends no request',async()=>{
 const f=fixture(false);await f.actions[0].action();assert.equal(f.prompts.length,1);assert.equal(f.calls.length,0);
});
