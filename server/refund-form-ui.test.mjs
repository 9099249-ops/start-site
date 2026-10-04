import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/refunds.js',import.meta.url),'utf8');
function fixture(kind,pending=null){
 const nodes=[],calls=[],storage=new Map();
 if(pending)storage.set('refund-pending-1-'+kind+'-21',JSON.stringify(pending));
 const createElement=tag=>{const n={tag,children:[],value:'',append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},setAttribute(){},addEventListener(name,fn){this[name]=fn;}};nodes.push(n);return n;};
 const info={paidCents:35000,refundedCents:0,remainingCents:35000,history:[],lines:[{index:0,name:'Кофе',remainingQuantity:1,unitCents:35000}]};
 const context={window:{},document:{createElement,dispatchEvent(){}},Event,crypto:{randomUUID:()=> 'test-request'},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch:async(url,options)=>{if(options.method==='POST')calls.push(JSON.parse(options.body));return {ok:true,json:async()=>info};}};
 runInNewContext(source,context);
 const container=createElement('section');context.window.STARTRefunds.mount(container,kind,21,1);
 const box=container.children[0];box.open=true;box.toggle();
 return {nodes,calls,storage,ready:async()=>{for(let i=0;i<10;i++)await Promise.resolve();}};
}
for(const kind of ['cafe','rental'])test('Refund '+kind+' has no reason input and saves automatic audit note only after confirmation',async()=>{
 const f=fixture(kind);await f.ready();
 assert.equal(f.nodes.some(n=>n.tag==='textarea'),false);
 const form=f.nodes.find(n=>n.tag==='form'),method=f.nodes.find(n=>n.tag==='select'&&n.children.some(c=>c.value==='cash'));
 method.value='cash';
 if(kind==='cafe')f.nodes.find(n=>n.tag==='select'&&n!==method).value='1';
 await form.onsubmit({preventDefault(){}});assert.equal(f.calls.length,0);
 await form.onsubmit({preventDefault(){}});assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].reason,'Возврат гостю');assert.equal(f.calls[0].amountCents,35000);assert.equal(f.calls[0].method,'cash');
});
test('Refund retries preserve the saved payload, reason and idempotency key',async()=>{
 const pending={requestId:'existing-request',kind:'cafe',id:21,amountCents:35000,method:'card',reason:'Ранее введённая причина',lines:[{index:0,quantity:1}]};
 const f=fixture('cafe',pending);await f.ready();await f.nodes.find(n=>n.tag==='form').onsubmit({preventDefault(){}});
 assert.deepEqual(f.calls,[pending]);
});
for(const value of ['0','350.01','-1'])test('Rental refund still rejects invalid amount '+value,async()=>{
 const f=fixture('rental');await f.ready();f.nodes.find(n=>n.tag==='input').value=value;
 await f.nodes.find(n=>n.tag==='form').onsubmit({preventDefault(){}});
 assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);
});
