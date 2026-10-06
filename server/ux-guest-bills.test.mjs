import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/guest-bills.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.listeners={};this.hidden=false;this.disabled=false;this.value='';this._text='';this.open=false;this.isConnected=true;this.className='';const classes=new Set();this.classList={add:x=>classes.add(x),contains:x=>classes.has(x)};}
 get textContent(){return this._text+this.children.map(child=>child&&typeof child==='object'?child.textContent:'').join('');}
 set textContent(value){this._text=String(value??'');}
 append(...nodes){for(const node of nodes){this.children.push(node);if(node&&typeof node==='object'){node.parentElement=this;node.parentNode=this;}}}
 replaceChildren(...nodes){for(const node of this.children)if(node&&typeof node==='object')node.parentElement=node.parentNode=null;this.children=[];this.append(...nodes);}
 setAttribute(key,value){this.attributes[key]=String(value);}
 getAttribute(key){return this.attributes[key]??null;}
 hasAttribute(key){return key in this.attributes;}
 removeAttribute(key){delete this.attributes[key];}
 toggleAttribute(key,force){if(force)this.setAttribute(key,'');else this.removeAttribute(key);}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 dispatchEvent(event){event.target=this;for(const fn of this.listeners[event.type]||[])fn(event);this['on'+event.type]?.(event);return true;}
 closest(selector){for(let node=this;node;node=node.parentElement){if(selector.split(',').some(part=>part.trim()==='dialog'&&node.tagName==='DIALOG'||part.trim()==='.guest-panel'&&node.classList.contains('guest-panel')))return node;}return null;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 querySelectorAll(selector){const selectors=selector.split(',').map(x=>x.trim()),out=[];const visit=node=>{for(const child of node.children||[]){if(!child||typeof child!=='object')continue;const match=selectors.some(s=>s.startsWith('.')?(child.classList.contains(s.slice(1))||child.className.split(/\s+/).includes(s.slice(1))):s.startsWith('[role=')?child.getAttribute('role')===s.slice(6,-1):s==='button'&&child.tagName==='BUTTON'||s==='textarea'&&child.tagName==='TEXTAREA'||s==='input'&&child.tagName==='INPUT');if(match)out.push(child);visit(child);}};visit(this);return out;}
 showModal(){this.open=true;}
 close(){if(!this.open)return;this.open=false;this.dispatchEvent({type:'close'});}
 remove(){this.isConnected=false;this.parentElement?.replaceChildren(...this.parentElement.children.filter(child=>child!==this));}
 focus(){this.focused=true;}
}
class TestEvent{constructor(type){this.type=type;}preventDefault(){this.defaultPrevented=true;}}

function fixture({bill,search='',fetcher}={}){
 const body=new Element('body'),issueDialog=new Element('dialog'),issueForm=new Element('form'),elements={amount:new Element('input'),method:new Element('select')},requests=[],intervals=[],observers=[];
 elements.amount.value='1250.00';elements.method.value='card';issueForm.elements=elements;issueForm.reportValidity=()=>{issueForm.validityCalls=(issueForm.validityCalls||0)+1;return issueForm.valid!==false;};issueForm.requestSubmit=()=>{issueForm.submissions=(issueForm.submissions||[])+1;issueForm.submitted={cash:issueForm.dataset.cash,method:elements.method.value};};issueForm.reset=()=>{};issueDialog.append(issueForm);body.append(issueDialog);
 const document={body,hidden:false,createElement:tag=>new Element(tag),querySelector:s=>s==='#issue-form'?issueForm:s==='#checkout'||s==='.cafe-integrated'||s==='#prepare-order'||s==='#checkout-button'?null:null,querySelectorAll:s=>s==='iframe'?[]:[],dispatchEvent(){}};
  const context={document,window:null,parent:null,location:{search,href:'http://local/admin/'},URLSearchParams,Event:TestEvent,crypto:{randomUUID:()=> 'test-request'},MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(target,options){this.target=target;this.options=options;}trigger(){this.callback();}},setInterval:fn=>(intervals.push(fn),intervals.length),clearInterval(){},fetch:async(url,options={})=>{const b=options.body?JSON.parse(options.body):null;requests.push({url,body:b});const answer=fetcher?await fetcher(url,b):url.endsWith('/guest-bills?id=7')?bill:{ok:true};return {ok:true,status:200,json:async()=>answer};},STARTPhone:null};context.window=context;context.parent=context;
 runInNewContext(source,context);
  return {context,document,body,issueForm,issueDialog,elements,requests,intervals,observers};
}
const line=(status='NEW')=>({id:31,kind:'cafe',amount:24500,status,orderRevision:8,items:[{quantity:1,name:'Сырники',totalCents:24500}]});
const billData=(status='NEW')=>({id:7,revision:4,name:'Гость',location:'Стол 5',totalCents:24500,paid_at:null,cancelled_at:null,deferred:true,lines:[line(status)]});
const buttons=root=>root.querySelectorAll('button');

test('Rental cash opens an inline amount confirmation and submits only after an explicit cash action',async()=>{
 const f=fixture();const cash=buttons(f.issueForm).find(b=>b.textContent==='Получено наличными');await cash.onclick();
 const confirmation=f.issueForm.children.find(e=>e.className==='rental-cash-confirmation');assert.ok(confirmation);assert.equal(confirmation.hidden,false);assert.match(confirmation.children[0].textContent,/1.*250 ₽/);assert.equal(f.issueForm.submissions,undefined);assert.equal(f.issueForm.validityCalls,1);
 await confirmation.children[1].onclick();assert.equal(Number(f.issueForm.submissions),1);assert.deepEqual(f.issueForm.submitted,{cash:'1',method:'cash'});assert.equal(Number(f.issueForm.validityCalls),2);
});

test('Rental cash confirmation cancels on input, close, or invalid form without submitting',async()=>{
 const f=fixture(),cash=buttons(f.issueForm).find(b=>b.textContent==='Получено наличными');const area=()=>f.issueForm.children.find(e=>e.className==='rental-cash-confirmation');
 f.elements.method.defaultValue='card';await cash.onclick();f.issueForm.dataset.cash='1';f.elements.method.value='cash';f.issueForm.dispatchEvent(new TestEvent('input'));assert.equal(area().hidden,true);assert.equal(f.issueForm.dataset.cash,undefined);assert.equal(f.elements.method.value,'card');
 f.issueDialog.open=true;f.issueForm.valid=true;await cash.onclick();assert.equal(area().hidden,false);f.issueDialog.close();assert.equal(area().hidden,true);assert.equal(f.issueForm.submissions,undefined);
 f.issueDialog.open=true;f.issueForm.valid=false;await cash.onclick();assert.equal(area().hidden,true);assert.equal(f.issueForm.submissions,undefined);
});

test('Rental cash reset restores default method on cancel but preserves a locked request',async()=>{
 const f=fixture(),cash=buttons(f.issueForm).find(b=>b.textContent==='Получено наличными');f.elements.method.defaultValue='';
 await cash.onclick();f.issueForm.dataset.cash='1';f.elements.method.value='cash';buttons(f.issueForm).find(b=>b.textContent==='Отмена').onclick();assert.equal(f.issueForm.dataset.cash,undefined);assert.equal(f.elements.method.value,'unspecified');
 await cash.onclick();f.issueForm.dataset.saving='1';f.issueForm.dataset.cash='1';f.elements.method.value='cash';f.issueForm.dispatchEvent(new TestEvent('change'));assert.equal(f.issueForm.dataset.cash,'1');assert.equal(f.elements.method.value,'cash');
});

test('Separate rental order action and empty guest tag stay hidden outside guest context',()=>{
 const f=fixture(),separate=buttons(f.issueForm).find(b=>b.textContent==='Обычный отдельный заказ'),tag=f.issueForm.children.find(e=>e.className==='guest-context'),observer=f.observers.find(item=>item.target===f.issueForm&&item.options.attributeFilter?.includes('data-guest-bill'));
 assert.ok(observer);assert.equal(observer.options.attributeFilter.join(','),'data-guest-bill');assert.equal(separate.hidden,true);assert.equal(tag.hidden,true);assert.equal(tag.textContent,'');
 f.issueForm.dataset.guestBill='7';observer.trigger();assert.equal(separate.hidden,false);assert.equal(tag.hidden,false);assert.equal(tag.textContent,'Добавляется в счёт гостя №7');
 delete f.issueForm.dataset.guestBill;observer.trigger();assert.equal(separate.hidden,true);assert.equal(tag.hidden,true);assert.equal(tag.textContent,'');
});

test('Rental cash and guest-bill actions respect saving and unresolved-request flags',async()=>{
 for(const flag of ['saving','pendingRequest']){
  const f=fixture(),cash=buttons(f.issueForm).find(b=>b.textContent==='Получено наличными'),choose=buttons(f.issueForm).find(b=>b.textContent==='В общий счёт / оплатить позже'),separate=buttons(f.issueForm).find(b=>b.textContent==='Обычный отдельный заказ');
  f.issueForm.dataset[flag]='1';await cash.onclick();await choose.onclick();await separate.onclick();assert.equal(f.issueForm.validityCalls,undefined);assert.equal(f.issueForm.dataset.guestBill,undefined);assert.equal(f.requests.length,0);assert.equal(f.issueForm.submissions,undefined);
 }
 const f=fixture(),cash=buttons(f.issueForm).find(b=>b.textContent==='Получено наличными');await cash.onclick();const area=f.issueForm.children.find(e=>e.className==='rental-cash-confirmation');f.issueForm.dataset.pendingRequest='1';f.issueForm.dataset.cash='1';f.elements.method.value='cash';f.issueForm.dispatchEvent(new TestEvent('input'));assert.equal(area.hidden,true);assert.equal(f.issueForm.dataset.cash,'1');assert.equal(f.elements.method.value,'cash');
});

test('Line cancellation uses one contextual dialog and preserves the API contract',async()=>{
 const bill=billData(),f=fixture({bill,fetcher:async(url,body)=>{if(url.endsWith('/cancel-line')){assert.equal(body.prepared,true);bill.revision++;bill.lines[0].amount=0;return bill;}return bill;}});
 await f.context.STARTGuests.show(7);const cancel=buttons(f.body).find(b=>b.textContent==='Отменить эти позиции');const pending=cancel.onclick();
 const dialogs=f.body.children.filter(e=>e.tagName==='DIALOG'&&e.open),child=dialogs.at(-1);assert.ok(child);assert.match(child.textContent,/Сырники.*245 ₽/);assert.ok(child.querySelector('textarea').required);
 child.querySelector('textarea').value='Гость отменил';const prepared=buttons(child).find(b=>b.textContent==='Уже начали готовить');await prepared.onclick();const submit=buttons(child).find(b=>b.textContent==='Подтвердить отмену');await submit.onclick();await pending;
 const request=f.requests.find(r=>r.url.endsWith('/cancel-line'));assert.deepEqual(Object.keys(request.body).sort(),['id','lineId','orderRevision','prepared','reason','revision']);assert.deepEqual(request.body,{id:7,revision:4,lineId:31,orderRevision:8,reason:'Гость отменил',prepared:true});
});

test('Known cooking state cannot be submitted as not prepared; polling waits while confirmation is open',async()=>{
 const bill=billData('COOKING'),f=fixture({bill,fetcher:async(url,body)=>{if(url.endsWith('/cancel-line')){bill.revision++;bill.lines[0].amount=0;return bill;}return bill;}});await f.context.STARTGuests.show(7);
 const cancel=buttons(f.body).find(b=>b.textContent==='Отменить эти позиции'),pending=cancel.onclick(),child=f.body.children.filter(e=>e.tagName==='DIALOG'&&e.open).at(-1);
 assert.equal(buttons(child).some(b=>b.textContent==='Не начинали готовить'),false);assert.match(child.textContent,/уже начали готовить/i);const reads=f.requests.filter(r=>r.url.endsWith('guest-bills?id=7')).length;for(const tick of f.intervals)tick();await Promise.resolve();assert.equal(f.requests.filter(r=>r.url.endsWith('guest-bills?id=7')).length,reads);
 child.querySelector('textarea').value='Заказ готовится';await buttons(child).find(b=>b.textContent.includes('Подтвердить отмену')).onclick();await pending;assert.equal(f.requests.find(r=>r.url.endsWith('/cancel-line')).body.prepared,true);
});

test('Whole bill cancellation asks for a contextual reason in a custom dialog',async()=>{
 const bill=billData(),f=fixture({bill,fetcher:async(url,body)=>{if(url.endsWith('/cancel'))return {ok:true};return bill;}});await f.context.STARTGuests.show(7);
 const cancel=buttons(f.body).find(b=>b.textContent==='Отменить счёт'),pending=cancel.onclick(),child=f.body.children.filter(e=>e.tagName==='DIALOG'&&e.open).at(-1);
 assert.match(child.textContent,/Гость.*Стол 5.*245 ₽/);child.querySelector('textarea').value='Счёт создан ошибочно';await buttons(child).find(b=>b.textContent==='Подтвердить отмену').onclick();await pending;
 assert.deepEqual(f.requests.find(r=>r.url.endsWith('/cancel')).body,{id:7,revision:4,reason:'Счёт создан ошибочно'});
});

test('Closing the cancellation dialog leaves the bill untouched',async()=>{
 const f=fixture({bill:billData()});await f.context.STARTGuests.show(7);const cancel=buttons(f.body).find(b=>b.textContent==='Отменить счёт'),pending=cancel.onclick(),child=f.body.children.filter(e=>e.tagName==='DIALOG'&&e.open).at(-1);
 buttons(child).find(b=>b.textContent==='Оставить без изменений').onclick();await pending;assert.equal(f.requests.some(r=>/\/cancel(?:-line)?$/.test(r.url)),false);assert.equal(f.body.children.some(e=>e.tagName==='DIALOG'&&e.open),true);
});

test('Cancellation failure stays in the dialog, shows the server error and re-enables controls',async()=>{
 const bill=billData(),f=fixture({bill,fetcher:async(url)=>{if(url.endsWith('/cancel-line'))throw Error('Счёт изменился. Обновите его.');return bill;}});await f.context.STARTGuests.show(7);
 const cancel=buttons(f.body).find(b=>b.textContent==='Отменить эти позиции'),pending=cancel.onclick(),child=f.body.children.filter(e=>e.tagName==='DIALOG'&&e.open).at(-1);child.querySelector('textarea').value='Изменение заказа';await buttons(child).find(b=>b.textContent==='Не начинали готовить').onclick();
 const submit=buttons(child).find(b=>b.textContent==='Подтвердить отмену');await submit.onclick();assert.equal(child.open,true);assert.match(child.querySelector('[role=status]').textContent,/Счёт изменился/);assert.equal(child.querySelector('.guest-dialog-close').disabled,false);assert.equal(submit.disabled,false);
 buttons(child).find(b=>b.textContent==='Оставить без изменений').onclick();await pending;
});
