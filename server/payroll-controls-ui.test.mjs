import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const app = await readFile(new URL('../dist/admin/app.js', import.meta.url), 'utf8');

function paymentFixture(status){
 const elements=[],storage=new Map(),calls=[];let sequence=0,fail=true;
 const element=tag=>{const e={tag,children:[],value:'',append(...nodes){this.children.push(...nodes);},setAttribute(){},addEventListener(){},showModal(){},focus(){},remove(){},close(){this.onclose?.();}};elements.push(e);return e;};
 const context={document:{createElement:element,body:element('body'),dispatchEvent(){}},user:{id:1},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},crypto:{randomUUID:()=>String(++sequence)},Event,money:n=>String(n/100),text:(tag,value)=>Object.assign(element(tag),{textContent:value}),loadPayroll:async()=>{},api:async(path,body)=>{calls.push({path,body:JSON.parse(JSON.stringify(body))});if(fail){fail=false;throw Object.assign(Error('Нет подтверждения'),status?{status}:{});}return {items:[]};}};
 runInNewContext(app.slice(app.indexOf('function openPayrollPayment('),app.indexOf("$('#payroll-refresh')")),context);
 const open=p=>{elements.length=0;context.openPayrollPayment({shift_id:8,user_id:2,login:'ivan',remaining_cents:20000,...p});return {form:elements.find(e=>e.tag==='form'),amount:elements.find(e=>e.tag==='input'),method:elements.find(e=>e.tag==='select'),dialog:elements.find(e=>e.tag==='dialog')};};
 return {open,calls,storage,elements};
}

test('Payout retries reuse the persisted command even after closing the dialog',async()=>{
 const f=paymentFixture();let view=f.open();view.amount.value='100.50';view.method.value='cash';await view.form.onsubmit({preventDefault(){}});assert.equal(f.storage.size,1);assert.equal(view.amount.disabled,true);view.dialog.close();
 view=f.open();assert.equal(view.amount.value,'100.50');assert.equal(view.method.value,'cash');await view.form.onsubmit({preventDefault(){}});assert.deepEqual(f.calls[0].body,f.calls[1].body);assert.equal(f.storage.size,0);assert.equal(f.calls[0].body.amountCents,10050);
});

test('Known validation rejection unlocks the payout form; an unknown old payment never defaults to an amount or cash',async()=>{
 const f=paymentFixture(400),view=f.open({review_required:true,review_amount_cents:20000});assert.equal(view.amount.value,'');assert.equal(view.method.children.some(e=>e.value==='cash'),false);view.amount.value='50';view.method.value='external';await view.form.onsubmit({preventDefault(){}});assert.equal(view.amount.disabled,false);assert.equal(view.method.disabled,false);assert.equal(f.storage.size,0);assert.equal(f.calls[0].body.resolveReview,true);
});

test('payroll UI keeps review, origin, payout and retry contracts visible', () => {
  assert.match(app, /for\(const origin of p\.origins\|\|\[\]\)/);
  assert.match(app, /Начислено за \$\{origin\.day\}/);
  assert.match(app, /Уже выплачено, сумма требует сверки/);
  assert.match(app, /payroll\/report-paid/);
  assert.match(app, /Уже выплачено, сумма неизвестна/);
  assert.match(app, /Отметить выплату/);
  assert.match(app, /\['cash','Наличными из кассы'\]/);
  assert.match(app, /\['card','Переводом'\]/);
  assert.match(app, /\['external','Ранее выплачено вне текущей кассы'\]/);
  assert.match(app, /requestId:crypto\.randomUUID\(\)/);
  assert.match(app, /resolveReview:true/);
  assert.match(app, /if\(p\.review_required&&value==='cash'\)continue/);
  assert.match(app, /sessionStorage\.setItem\(key,JSON\.stringify\(pendingPayment\)\)/);
  assert.match(app, /Подвести и сохранить итог дня/);
  assert.match(app, /Расхождение кассы: .*учитывается отдельно от зарплаты и бонуса/);
});

test('manual free-price sale sends its selected method with the persisted retry payload', () => {
  assert.match(app, /<select name="method" required><option value="cash">Наличные<\/option><option value="card">Карта<\/option>/);
  assert.match(app, /method:f\.elements\.method\.value/);
  assert.match(app, /pending\.method\|\|'cash'/);
  assert.match(app, /querySelectorAll\('input,select'\)\)x\.disabled=!!pending/);
});
