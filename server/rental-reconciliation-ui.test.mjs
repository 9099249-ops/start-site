import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/app.js',import.meta.url),'utf8');
const lines=source.split(/\r?\n/);
const start=lines.findIndex(line=>line.startsWith('function openRentalReconciliation('));
assert.ok(start>=0,'openRentalReconciliation exists');
const end=lines.findIndex((line,index)=>index>start&&line==='}');
assert.ok(end>start,'openRentalReconciliation ends');
const declaration=lines.slice(start,end+1).join('\n');

class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.disabled=false;this.open=false;this.text='';}
 set textContent(value){this.text=String(value??'');this.children=[];}
 get textContent(){return this.text+this.children.map(child=>child.textContent).join(' ');}
 append(...children){this.children.push(...children);}
 setAttribute(name,value){this.attributes[name]=value;}
 addEventListener(name,fn){this.listeners[name]=fn;}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='button'&&child.tag==='button'?[child]:[]),...child.querySelectorAll(selector)]);}
 showModal(){this.open=true;}
 remove(){this.removed=true;}
 close(){this.open=false;this.listeners.close?.();}
}

function fixture({payment=null,confirmResult=true,apiImpl=async()=>({})}={}){
 const dialogs=[],posts=[],events=[],notices=[];let refreshed=0;
 const context={
  text:(tag,value)=>{const element=new Element(tag);element.textContent=value;return element;},
  money:cents=>`${cents} ₽`,
  confirm:message=>{context.confirmations.push(message);return confirmResult;},confirmations:[],
  document:{createElement:tag=>new Element(tag),body:{append:element=>dialogs.push(element)},dispatchEvent:event=>events.push(event.type)},
  api:async(path,body)=>{posts.push({path,body});return apiImpl(path,body);},
  refresh:async()=>{refreshed++;},notice:message=>notices.push(message),
  Event:class{constructor(type){this.type=type;}}
 };
 runInNewContext(declaration,context);
 context.openRentalReconciliation({id:41,revision:9,initial_due:12500},payment);
 const dialog=dialogs[0],form=dialog.children[0];
 return {context,dialog,form,buttons:form.querySelectorAll('button'),posts,events,notices,get refreshed(){return refreshed;}};
}
const buttonFor=(f,result)=>f.buttons.find(button=>button.dataset.result===result);

test('Uncertain rental results submit one confirmed outcome with audit note and no number entry',async()=>{
 for(const result of ['card','cash','unpaid']){
  const f=fixture({payment:{id:'payment-1',phase:'extension',state:'payment_unknown'}}),button=buttonFor(f,result);
  assert.ok(button,result);assert.equal(button.textContent.includes('номер'),false);
  await button.onclick();
  assert.equal(f.context.confirmations.length,1);assert.equal(f.posts.length,1);
  const {path,body}=f.posts[0];assert.equal(path,'rental-reconcile');
  assert.deepEqual({...body},{id:41,revision:9,phase:'extension',paymentId:'payment-1',result,confirmed:true,terminalIdle:true,note:body.note,...(['cash','card'].includes(result)?{receiptExists:true}:{})});
  assert.ok(body.note.length>0);assert.equal(Object.hasOwn(body,'receiptExists'),['cash','card'].includes(result));
  if(['cash','card'].includes(result))assert.equal(body.receiptExists,true);
  assert.equal(f.dialog.open,false);
  assert.equal(f.refreshed,1);
  assert.deepEqual(f.notices,['Результат сверки сохранён.']);
  assert.deepEqual(f.events,['station-updated']);
 }
});

test('Paid rental offers receipt and terminal release, with receipt confirmation only for receipt result',async()=>{
 for(const [result,hasReceipt] of [['receipt_exists',true],['terminal_free',false]]){
  const f=fixture({payment:{id:'paid-1',phase:'issue',state:'receipt_unknown',paid:true,amountCents:8000}}),button=buttonFor(f,result);
  assert.ok(button);await button.onclick();const body=f.posts[0].body;
  assert.equal(body.result,result);assert.equal(body.revision,9);assert.equal(body.paymentId,'paid-1');
  assert.equal(body.confirmed,true);assert.equal(body.terminalIdle,true);assert.equal(Object.hasOwn(body,'receiptExists'),hasReceipt);
  if(hasReceipt)assert.equal(body.receiptExists,true);
  assert.match(f.context.confirmations[0],/CS50|касса/);assert.equal(f.dialog.open,false);
 }
});

test('Declining native confirmation leaves dialog open and sends nothing',async()=>{
 const f=fixture({payment:{id:'payment-1',phase:'issue',state:'payment_unknown'},confirmResult:false});
 await buttonFor(f,'cash').onclick();
 assert.equal(f.posts.length,0);assert.equal(f.refreshed,0);assert.equal(f.dialog.open,true);assert.ok(f.buttons.every(button=>!button.disabled));
});

test('Duplicate action while request is pending is ignored and all buttons are disabled',async()=>{
 let resolveRequest;const f=fixture({payment:{id:'payment-1',phase:'issue',state:'payment_unknown'},apiImpl:()=>new Promise(resolve=>{resolveRequest=resolve;})});
 const button=buttonFor(f,'card'),pending=button.onclick();
 assert.ok(f.buttons.every(item=>item.disabled));await button.onclick();assert.equal(f.posts.length,1);
 resolveRequest({});await pending;assert.ok(f.buttons.every(item=>!item.disabled));assert.equal(f.dialog.open,false);
});

test('API failure stays visible in the dialog and restores every button',async()=>{
 const f=fixture({payment:{id:'payment-1',phase:'issue',state:'payment_unknown'},apiImpl:async()=>{throw Error('Оплата изменилась. Обновите аренду.');}});
 await buttonFor(f,'unpaid').onclick();
 assert.equal(f.dialog.open,true);assert.equal(f.form.children.find(element=>element.attributes.role==='alert').textContent,'Оплата изменилась. Обновите аренду.');assert.ok(f.buttons.every(button=>!button.disabled));assert.equal(f.refreshed,0);
});

test('No payment record omits the unpaid option; canceled payment keeps existing variants',()=>{
 const noPayment=fixture();assert.deepEqual(noPayment.buttons.filter(button=>button.dataset.result).map(button=>button.dataset.result),['card','cash']);
 const canceled=fixture({payment:{id:'payment-2',phase:'issue',state:'cancelled'}});assert.deepEqual(canceled.buttons.filter(button=>button.dataset.result).map(button=>button.dataset.result),['card','cash']);
});
