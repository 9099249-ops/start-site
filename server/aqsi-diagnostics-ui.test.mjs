import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

class Element {
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.value='';}
 set textContent(value){this.value=String(value);this.children=[];}
 get textContent(){return this.value+this.children.map(c=>c.textContent).join(' ');}
 set innerHTML(value){throw Error('Diagnostic messages must never be rendered as HTML');}
 append(...children){this.children.push(...children);}
}

for(const file of ['app.js','cafe.js','guest-bills.js','aqsi.js']){
 const source=readFileSync(new URL('../dist/admin/'+file,import.meta.url),'utf8');
 const fn=source.split(/\r?\n/).find(line=>line.startsWith('function paymentDiagnostic('));
 const context={document:{createElement:tag=>new Element(tag)}};
 runInNewContext(fn,context);
 test(file+': failed payment shows safe cause and Moscow check time without raw API payload',()=>{
  const diagnostic={message:'Ответ кассы не получен <img src=x onerror=alert(1)>',checkedAt:Date.parse('2026-09-29T12:45:56Z'),phase:'payment',responseBody:'secret payload'};
  const box=context.paymentDiagnostic({state:'payment_unknown',diagnostic});
  assert.equal(box.open,true);
  assert.match(box.textContent,/Почему оплата остановилась/);
  assert.ok(box.textContent.includes(diagnostic.message));
  assert.match(box.textContent,/15:45:56 МСК/);
  assert.doesNotMatch(box.textContent,/secret payload/);
  assert.deepEqual(box.children.map(e=>e.tag),['summary','p','small']);
 });
 test(file+': completed or cancelled payment hides stale error; receipt failure names the receipt',()=>{
  const diagnostic={message:'Не удалось подтвердить чек',checkedAt:'invalid',phase:'receipt'};
  for(const state of ['done','cash_done','cancelled'])assert.equal(context.paymentDiagnostic({state,diagnostic}),null);
  assert.equal(context.paymentDiagnostic(null),null);
  assert.equal(context.paymentDiagnostic({state:'payment_waiting'}),null);
  const box=context.paymentDiagnostic({state:'receipt_unknown',diagnostic});
  assert.match(box.textContent,/Почему чек ещё не подтверждён/);
  assert.doesNotMatch(box.textContent,/Invalid Date|Проверено/);
 });
 test(file+': accepted and pending operations have neutral headings',()=>{
  for(const [state,phase,title] of [['payment_waiting','payment','Проверка оплаты'],['receipt_waiting','receipt','Проверка чека'],['payment_sending','payment','Проверка оплаты'],['receipt_sending','receipt','Проверка чека']]){
   const box=context.paymentDiagnostic({state,diagnostic:{phase,message:'Запрос принят aQsi. Ожидаем подтверждение кассы.',checkedAt:Date.now()}});
   assert.equal(box.children[0].textContent,title);
   assert.doesNotMatch(box.textContent,/остановилась|ещё не подтверждён/);
  }
 });
}
