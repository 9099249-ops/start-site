import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';

const source=readFileSync(new URL('../dist/cafe.js',import.meta.url),'utf8');
const item={id:'coffee',name:'Американо',description:'',priceCents:35000,variants:[],groupIds:['sugar'],tags:[],active:true,categoryId:'drinks'};
const catalog={items:[item],categories:[{id:'drinks',name:'Напитки',active:true,sort:1}],groups:[{id:'sugar',name:'Сахар',active:true,min:0,max:1,options:[{id:'none',name:'Без сахара',priceCents:0,active:true},{id:'one',name:'1 пакетик',priceCents:0,active:true}]}],settings:{enabled:true,fulfillments:['pickup','lounge','house'],payments:['cash']}};
const line=(quantity=1)=>({itemId:'coffee',quantity,variantId:null,optionIds:[],comment:''});
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};};

function fixture({search='',staffMode=true,integrated=staffMode,local=storage(),session=storage(),fetcher,onConfirm=()=>true}={}){
 const elements=new Map(),listeners={},requests=[],confirmations=[];
 class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.open=false;this.textContent='';this.className='';const classes=new Set();this.classList={contains:x=>classes.has(x),add:x=>classes.add(x),remove:x=>classes.delete(x),toggle:(x,on)=>on===false?classes.delete(x):classes.add(x)};}
  set id(value){this._id=value;elements.set('#'+value,this);}get id(){return this._id;}
  set name(value){this._name=value;if(value.startsWith('free'))elements.get('#checkout').elements[value]=this;}get name(){return this._name;}
  append(...children){for(const child of children){this.children.push(child);if(typeof child==='object')child.parentElement=this;}}
  replaceChildren(...children){this.children=[];this.append(...children);}after(child){if(this.parentElement)this.parentElement.append(child);}before(child){if(this.parentElement)this.parentElement.append(child);}
  setAttribute(k,v){this.attributes[k]=String(v);if(k==='id')this.id=v;}hasAttribute(k){return k==='data-pending-disabled'?this.dataset.pendingDisabled!==undefined:k in this.attributes;}
  addEventListener(name,fn){this[name]=fn;}showModal(){this.open=true;}show(){this.open=true;}close(){this.open=false;}scrollIntoView(){}remove(){if(this.id)elements.delete('#'+this.id);}
  closest(){return this.parentElement||new Element('label');}click(){return this.onclick?.({preventDefault(){}});}
  querySelectorAll(selector){const all=[];const visit=e=>{for(const c of e.children)if(typeof c==='object'){all.push(c);visit(c);}};visit(this);return all.filter(e=>selector.split(',').some(part=>{part=part.trim();if(part==='input:checked')return e.tagName==='INPUT'&&e.checked;if(part==='input')return e.tagName==='INPUT';if(part==='button')return e.tagName==='BUTTON';return false;}));}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 }
 const get=s=>{if(!elements.has(s))elements.set(s,new Element());return elements.get(s);};
 for(const name of ['checkout','dish-form','dish-options','cart-lines','mobile-sale','cart-dialog','dish-dialog','menu-search','checkout-contact','checkout-extra','compose','cafe-message','checkout-error','checkout-button','prepare-order','cart-button','dish-add','dish-name','dish-description','checkout-summary','clear-cart','reset-order','undo-clear-cart'])get('#'+name).id=name;
 const form=get('#checkout'),fields={};for(const name of ['name','phone','fulfillment','placeId','house','yacht','location','timing','requestedAt','payment','comment','consent']){const e=new Element('input');e.name=name;e.options=[];fields[name]=e;form.append(e);}fields.fulfillment.value='pickup';fields.timing.value='asap';fields.payment.value='cash';fields.consent.checked=true;fields.placeId.options=[{}];form.elements=fields;
 form.reset=()=>{for(const e of Object.values(fields))e.value='';fields.fulfillment.value='pickup';fields.timing.value='asap';fields.payment.value='cash';};
 get('#dish-form').elements={comment:new Element('input')};get('#dish-form').reset=()=>{get('#dish-form').elements.comment.value='';};get('#dish-form').append(get('#dish-options'));
 form.append(get('#checkout-summary'));
 const body=new Element('body');if(integrated)body.classList.add('cafe-integrated');
 const document={body,documentElement:new Element('html'),hidden:false,querySelector:s=>['#dish-stock-error','#legacy-pending','#legacy-pending-error','#free-order-options'].includes(s)?elements.get(s)||null:get(s),querySelectorAll:selector=>{if(selector.includes('#checkout input'))return [...Object.values(fields),...get('#cart-lines').querySelectorAll('button,input'),get('#clear-cart'),get('#reset-order'),get('#undo-clear-cart')];return [];},createElement:tag=>new Element(tag),createTextNode:text=>text,addEventListener:(name,fn)=>listeners[name]=fn,dispatchEvent(){}};
 const context={document,window:{addEventListener(){},startAnalytics:null},navigator:{onLine:true},location:{search,pathname:staffMode?'/admin/cafe/':'/cafe/',href:''},localStorage:local,sessionStorage:session,URLSearchParams,AbortController,crypto:webcrypto,matchMedia:()=>({matches:false,addEventListener(){}}),setInterval(){},setTimeout,clearTimeout,scrollY:0,requestAnimationFrame:fn=>fn(),scrollTo(){},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},FormData:class{constructor(form){this.entries=Object.entries(form.elements).filter(([,e])=>!e.disabled).map(([name,e])=>[name,e.value]);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}},fetch:async(url,options)=>{const body=options.body?JSON.parse(options.body):null;requests.push({url,body});return fetcher?fetcher(url,body):{ok:true,status:200,json:async()=>({ok:true})};}};
 context.Event=Event;
 context.Option=class extends Element{constructor(text,value){super('option');this.textContent=text;this.value=String(value);}};
 context.confirm=message=>{confirmations.push(message);return onConfirm(message);};
 const exposed=`globalThis.api={loadStaffCart,showLegacyPending,recoverLegacyPending,cartKey,quickItem,quickAdd,openDish,refreshDishStock,changeQuantity,cartLines,request,cartButton,setupFreeOrder,form,seed(s){if(s.staff!==undefined)staff=s.staff;if(s.menu!==undefined)menu=s.menu;if(s.cart!==undefined)cart=s.cart;if(s.appendOrder!==undefined)appendOrder=s.appendOrder;},state(){return {cart,pendingKey,busy};}};return;window.cafeComposerReady=init();`;
 runInNewContext(source.replace('window.cafeComposerReady=init();',exposed),context);
 const api=context.api;api.seed({staff:{id:1},menu:structuredClone(catalog)});if(staffMode)api.loadStaffCart();
 return {api,get,elements,document,context,local,session,requests,confirmations,item:api.quickItem?item:null,submit:(button='checkout-button')=>form.onsubmit({preventDefault(){},submitter:get('#'+button)}),submitDish:()=>get('#dish-form').onsubmit({preventDefault(){}})};
}

test('Staff draft baskets never borrow a new order, another append, or another user',async()=>{
 const local=storage();local.setItem('cafe-staff-cart',JSON.stringify([line(9)]));
 const first=fixture({local});assert.equal(first.api.state().cart.length,0);await first.api.quickAdd(item,first.get('#add'));assert.equal(first.api.state().cart.length,1);
 const append=fixture({local,search:'?append=12'});assert.equal(append.api.state().cart.length,0);await append.api.quickAdd(item,append.get('#add'));
 const otherAppend=fixture({local,search:'?append=13'});assert.equal(otherAppend.api.state().cart.length,0);
 const otherUser=fixture({local});otherUser.api.seed({staff:{id:2}});otherUser.api.loadStaffCart();assert.equal(otherUser.api.state().cart.length,0);
 const restored=fixture({local});assert.equal(restored.api.state().cart[0].quantity,1);assert.notEqual(first.api.state().pendingKey,append.api.state().pendingKey);assert.notEqual(first.api.state().pendingKey,otherUser.api.state().pendingKey);
});

test('Optional coffee is quick, required choices and the public menu keep the dish dialog',()=>{
 const f=fixture();assert.equal(f.api.quickItem(item),true);const required=structuredClone(catalog);required.groups[0].min=1;f.api.seed({menu:required});assert.equal(f.api.quickItem(item),false);assert.equal(f.api.quickItem({...item,variants:[{id:'large'}]}),false);
 assert.equal(fixture({staffMode:false}).api.quickItem(item),false);
});

test('The sugar editor has one clear no-sugar choice and releases the mobile sale button',async()=>{
 const f=fixture();f.api.openDish(item);const options=f.get('#dish-options');const labels=options.children.flatMap(g=>g.children).flatMap(e=>e.children||[]).filter(x=>typeof x==='string');assert.equal(labels.filter(x=>x==='Без сахара').length,1);assert.equal(labels.includes('Без добавки'),false);
 await f.submitDish();assert.equal(f.api.state().cart.length,1);assert.equal(f.get('#mobile-sale').disabled,false);assert.equal(f.get('#checkout-button').disabled,false);
});

test('Editing preserves quantity and restores variants, modifiers and comment',async()=>{
 const f=fixture(),custom={...item,variants:[{id:'large',name:'Большой',priceCents:10000,active:true}]};const menu=structuredClone(catalog);menu.items=[custom];f.api.seed({menu,cart:[{...line(6),variantId:'large',optionIds:['one'],comment:'Горячий'}]});f.api.openDish(custom,0);
 assert.equal(f.get('#dish-form').elements.comment.value,'Горячий');assert.equal(f.get('#dish-options').querySelectorAll('input:checked').map(e=>e.value).sort().join(','),'large,one');f.get('#dish-form').elements.comment.value='Тёплый';await f.submitDish();assert.equal(f.api.state().cart.length,1);assert.equal(f.api.state().cart[0].quantity,6);assert.equal(f.api.state().cart[0].comment,'Тёплый');assert.equal(f.api.state().cart[0].variantId,'large');
});

test('Bulk quantity checks stock once, rejects overflow without data loss, and removes a whole row',async()=>{
 const f=fixture({fetcher:async(url,body)=>({ok:body.items[0].quantity<18,status:body.items[0].quantity<18?200:409,json:async()=>({error:'Доступно 17 порций.'})})});f.api.seed({cart:[line(1)]});await f.api.changeQuantity(0,15);assert.equal(f.api.state().cart[0].quantity,15);assert.equal(f.requests.length,1);
 await f.api.changeQuantity(0,20);assert.equal(f.api.state().cart[0].quantity,15);assert.match(f.get('#checkout-error').textContent,/17/);await f.api.changeQuantity(0,0);assert.equal(f.api.state().cart.length,0);assert.equal(f.requests.length,2);
});

test('A failure before quote completion says not sent and retains an editable draft',async()=>{
 const f=fixture({fetcher:async()=>{throw new TypeError('Failed to fetch');}});f.api.seed({cart:[line()]});await f.submit();assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/quote$/);assert.match(f.get('#checkout-error').textContent,/Заказ не отправлен/);assert.equal(f.session.getItem(f.api.state().pendingKey),null);assert.equal(f.api.state().cart.length,1);assert.equal(f.get('#mobile-sale').disabled,false);
});

test('An unknown create result keeps the same idempotency request and locks editing until retry',async()=>{
 let fail=true;const f=fixture({fetcher:async(url)=>{if(url.endsWith('/quote'))return {ok:true,status:200,json:async()=>({totalCents:35000,prepMinutes:20})};if(fail){fail=false;throw new TypeError('Failed to fetch');}return {ok:true,status:200,json:async()=>({id:25,status:'DELIVERED'})};}});f.api.seed({cart:[line()]});await f.submit();const pending=JSON.parse(f.session.getItem(f.api.state().pendingKey));assert.ok(pending.requestId);assert.match(f.get('#checkout-error').textContent,/Результат отправки пока не подтверждён/);assert.equal(f.get('#checkout').elements.fulfillment.disabled,true);
 await f.api.changeQuantity(0,0);assert.equal(f.api.state().cart.length,1);await f.submit();const orders=f.requests.filter(r=>r.url.endsWith('/orders'));assert.equal(orders.length,2);assert.equal(orders[0].body.requestId,orders[1].body.requestId);assert.equal(f.requests.filter(r=>r.url.endsWith('/quote')).length,1);assert.equal(JSON.parse(f.session.getItem(f.api.state().pendingKey)),null);assert.equal(f.api.state().cart.length,0);
});

test('A malformed create response is uncertain and never discards the pending request',async()=>{
 const f=fixture({fetcher:async(url)=>url.endsWith('/quote')?{ok:true,status:200,json:async()=>({totalCents:35000,prepMinutes:20})}:{ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected token');}}});f.api.seed({cart:[line()]});await f.submit();assert.ok(JSON.parse(f.session.getItem(f.api.state().pendingKey)).requestId);assert.match(f.get('#checkout-error').textContent,/Результат отправки/);assert.doesNotMatch(f.get('#checkout-error').textContent,/Unexpected token/);
});

test('Going offline between quote and create is known not sent and preserves the retry payload',async()=>{
 let f;f=fixture({fetcher:async()=>{f.context.navigator.onLine=false;return {ok:true,status:200,json:async()=>({totalCents:35000,prepMinutes:20})};}});f.api.seed({cart:[line()]});await f.submit();assert.equal(f.requests.length,1);assert.match(f.get('#checkout-error').textContent,/Заказ не отправлен/);assert.doesNotMatch(f.get('#checkout-error').textContent,/Результат отправки/);assert.ok(JSON.parse(f.session.getItem(f.api.state().pendingKey)).requestId);
});

test('Legacy pending is never silently assigned or sent; explicit recovery reuses its exact payload',async()=>{
 const session=storage(),old={requestId:'11111111-1111-4111-8111-111111111111',items:[line(2)],expectedTotalCents:70000,name:'Гость'};session.setItem('cafe-pending-v2-staff',JSON.stringify(old));const f=fixture({session,fetcher:async()=>({ok:true,status:200,json:async()=>({id:71})})});f.api.seed({cart:[line(5)]});
 await f.submit();assert.equal(f.requests.length,0);assert.deepEqual(JSON.parse(session.getItem('cafe-pending-v2-staff')),old);assert.equal(session.getItem(f.api.state().pendingKey),null);
 await f.api.recoverLegacyPending();assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].body,old);assert.equal(JSON.parse(session.getItem('cafe-pending-v2-staff')),null);assert.equal(f.api.state().cart[0].quantity,5);
});

test('Guest checkout still quotes first and asks for confirmation before posting an order',async()=>{
 const f=fixture({staffMode:false,fetcher:async()=>({ok:true,status:200,json:async()=>({totalCents:35000,prepMinutes:20})})});f.api.seed({cart:[line()]});await f.submit();assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/api/cafe/quote');assert.match(f.get('#checkout-button').textContent,/Подтвердить заказ/);assert.equal(f.session.getItem(f.api.state().pendingKey),null);
});

async function employeeFixture({fulfillment='pickup',quickEmployee=true,fetcher,...options}={}){
 const f=fixture({...options,fetcher:async(url,body)=>{
  if(url.endsWith('/complimentary-options'))return {ok:true,status:200,json:async()=>({people:[{id:1,name:'Текущий сотрудник'},{id:2,name:'Другой сотрудник'}],canGift:true})};
  if(fetcher)return fetcher(url,body);
  return {ok:true,status:200,json:async()=>url.endsWith('/quote')?{totalCents:0,prepMinutes:20}:{id:73,status:body.quickSale?'DELIVERED':'NEW'}};
 }});
 await f.api.setupFreeOrder();const form=f.get('#checkout');form.dataset.quickEmployee=quickEmployee?'1':'0';form.elements.freeReason.value='employee';form.elements.freeComment.value='';form.elements.fulfillment.value=fulfillment;f.api.seed({cart:[line()]});f.api.cartLines();return f;
}

test('Employee setup exposes the signed-in recipient independently of a restored selection',async()=>{
 const f=await employeeFixture(),recipient=f.get('#checkout').elements.freeRecipient;assert.equal(recipient.dataset.staffId,'1');assert.equal(Number(recipient.value),1);recipient.value='2';assert.equal(recipient.dataset.staffId,'1');
});

for(const fulfillment of ['pickup','lounge'])test('Integrated employee '+fulfillment+' orders submit zero total without confirmation',async()=>{
 const f=await employeeFixture({fulfillment,onConfirm:()=>{throw Error('Employee toggle must not ask for confirmation');}}),form=f.get('#checkout');form.elements.freeRecipient.value=form.elements.freeRecipient.dataset.staffId;
 assert.equal(f.get('#checkout-button').textContent,'Выдать бесплатно');assert.equal(f.get('#checkout-summary').textContent,'Итого: 0 ₽');await f.submit();
 const quote=f.requests.find(r=>r.url.endsWith('/quote')),order=f.requests.find(r=>r.url.endsWith('/orders'));assert.ok(order);assert.deepEqual(quote.body.complimentary,{reason:'employee',recipientId:1,comment:''});assert.deepEqual(order.body.complimentary,quote.body.complimentary);assert.equal(order.body.expectedTotalCents,0);assert.equal(order.body.quickSale,fulfillment==='pickup');assert.equal(f.confirmations.length,0);assert.equal(f.api.state().cart.length,0);assert.equal(form.elements.freeReason.value,'');
});

test('Employee orders can still be sent to preparation with the secondary action',async()=>{
 const f=await employeeFixture();await f.submit('prepare-order');const order=f.requests.find(r=>r.url.endsWith('/orders'));assert.ok(order);assert.equal(order.body.quickSale,false);assert.equal(order.body.expectedTotalCents,0);assert.equal(f.confirmations.length,0);
});

test('An uncertain employee submission locks editing and retries the identical zero-price request',async()=>{
 let attempt=0;const f=await employeeFixture({fetcher:async(url)=>{
  if(url.endsWith('/quote'))return {ok:true,status:200,json:async()=>({totalCents:0,prepMinutes:20})};
  if(++attempt===1)throw new TypeError('Failed to fetch');return {ok:true,status:200,json:async()=>({id:73,status:'DELIVERED',duplicate:true})};
 }});await f.submit();const pending=JSON.parse(f.session.getItem(f.api.state().pendingKey));assert.equal(pending.expectedTotalCents,0);assert.equal(pending.complimentary.recipientId,1);assert.equal(f.get('#checkout').elements.freeReason.disabled,true);assert.equal(f.get('#checkout').elements.freeRecipient.disabled,true);assert.match(f.get('#checkout-error').textContent,/Результат отправки пока не подтверждён/);
 await f.api.changeQuantity(0,0);assert.equal(f.api.state().cart.length,1);await f.submit();const orders=f.requests.filter(r=>r.url.endsWith('/orders'));assert.equal(orders.length,2);assert.deepEqual(orders[0].body,orders[1].body);assert.equal(f.requests.filter(r=>r.url.endsWith('/quote')).length,1);assert.equal(f.confirmations.length,0);assert.equal(JSON.parse(f.session.getItem(f.api.state().pendingKey)),null);
});

for(const variant of ['legacy employee','standalone employee','owner','guest'])test(variant+' free orders retain the existing confirmation',async()=>{
 const f=await employeeFixture({quickEmployee:variant!=='legacy employee',...(variant==='standalone employee'?{integrated:false,search:'?staff=1'}:{}),onConfirm:()=>false});
 if(variant==='owner'||variant==='guest')f.get('#checkout').elements.freeReason.value=variant;await f.submit();assert.equal(f.confirmations.length,1);assert.match(f.confirmations[0],/К оплате 0 ₽/);assert.equal(f.requests.filter(r=>r.url.endsWith('/orders')).length,0);assert.equal(f.session.getItem(f.api.state().pendingKey),null);assert.equal(f.api.state().cart.length,1);
});

test('More than twenty quick portions starts another valid row instead of losing the add',async()=>{
 const f=fixture();f.api.seed({cart:[line(20)]});await f.api.quickAdd(item,f.get('#add'));assert.equal(f.api.state().cart.length,2);assert.equal(f.api.state().cart[0].quantity,20);assert.equal(f.api.state().cart[1].quantity,1);assert.equal(f.requests[0].body.items.reduce((n,l)=>n+l.quantity,0),21);
});

test('Changing the actual quantity field locks edit during stock check then edits the confirmed quantity',async()=>{
 let release;const f=fixture({fetcher:async()=>new Promise(resolve=>release=()=>resolve({ok:true,status:200,json:async()=>({ok:true})}))});f.api.seed({cart:[line()]});f.api.cartLines();const input=f.get('#cart-lines').querySelectorAll('input')[0],edit=f.get('#cart-lines').querySelectorAll('button').find(b=>b.className.split(' ').includes('cart-edit'));input.value='4';const saving=input.onchange();assert.equal(edit.disabled,true);edit.onclick();assert.equal(f.get('#dish-dialog').open,false);release();await saving;
 const confirmedEdit=f.get('#cart-lines').querySelectorAll('button').find(b=>b.className.split(' ').includes('cart-edit'));assert.equal(confirmedEdit.disabled,false);confirmedEdit.onclick();assert.equal(f.get('#dish-add').textContent,'Сохранить · 1 400 ₽');assert.equal(f.api.state().cart[0].quantity,4);
});

test('A guard rejection after a lost create response cannot replace the unresolved request ID',async()=>{
 let attempt=0;const f=fixture({fetcher:async(url)=>{if(url.endsWith('/quote'))return {ok:true,status:200,json:async()=>({totalCents:35000,prepMinutes:20})};attempt++;if(attempt===1)throw new TypeError('Failed to fetch');if(attempt===2)return {ok:false,status:409,json:async()=>({error:'Сначала отметьтесь на смене.'})};return {ok:true,status:200,json:async()=>({id:92,status:'DELIVERED',duplicate:true})};}});f.api.seed({cart:[line()]});
 await f.submit();const original=JSON.parse(f.session.getItem(f.api.state().pendingKey));await f.submit();const afterGuard=JSON.parse(f.session.getItem(f.api.state().pendingKey));assert.equal(afterGuard.requestId,original.requestId);assert.equal(f.get('#checkout').elements.fulfillment.disabled,true);assert.match(f.get('#checkout-error').textContent,/Результат отправки пока не подтверждён/);
 await f.submit();const orders=f.requests.filter(r=>r.url.endsWith('/orders'));assert.equal(orders.length,3);assert.ok(orders.every(r=>r.body.requestId===original.requestId));assert.equal(f.requests.filter(r=>r.url.endsWith('/quote')).length,1);assert.equal(JSON.parse(f.session.getItem(f.api.state().pendingKey)),null);assert.equal(f.api.state().cart.length,0);
});

const optionState=(optionId,available,extra={})=>({optionId,variantId:null,available,configured:true,replaces:false,...extra});
function milkMenu(defaultAvailable=8){
 const menu=structuredClone(catalog),coffee=menu.items[0];coffee.name='Капучино';coffee.groupIds.push('milk');coffee.stock={available:8,configured:true,defaultAvailable,variants:[{variantId:null,available:8,configured:true,defaultAvailable}],options:[optionState('none',8),optionState('one',0),optionState('ordinary',defaultAvailable),optionState('oat',8,{replaces:true}),optionState('almond',0,{replaces:true})]};
 menu.groups.push({id:'milk',name:'Молоко',active:true,min:0,max:1,options:[{id:'ordinary',name:'Обычное',priceCents:0,active:true},{id:'oat',name:'Овсяное',priceCents:10000,active:true},{id:'almond',name:'Миндальное',priceCents:10000,active:true}]});return menu;
}
function chooseDishInput(f,name,value){const inputs=f.get('#dish-options').querySelectorAll('input');for(const input of inputs.filter(x=>x.name===name))input.checked=input.value===value;const chosen=inputs.find(x=>x.name===name&&x.value===value);f.get('#dish-form').onchange({target:chosen});return chosen;}

test('Available default cappuccino stays quick while zero-stock sugar and milk options stay hidden',async()=>{
 const f=fixture(),menu=milkMenu();f.api.seed({menu});const coffee=menu.items[0];assert.equal(f.api.quickItem(coffee),true);f.api.openDish(coffee);
 const inputs=f.get('#dish-options').querySelectorAll('input');assert.equal(inputs.some(x=>x.value==='one'),false);assert.equal(inputs.some(x=>x.value==='almond'),false);assert.equal(inputs.some(x=>x.name==='milk'&&x.value===''),false);assert.equal(inputs.find(x=>x.value==='ordinary').checked,true);assert.equal(f.get('#dish-add').disabled,false);
 await f.submitDish();assert.equal(f.requests.length,1);assert.equal(f.api.state().cart[0].optionIds.sort().join(','),'none,ordinary');assert.equal(f.get('#mobile-sale').disabled,false);
});

test('When ordinary milk is empty, a replacement must be chosen explicitly before adding',async()=>{
 const f=fixture(),menu=milkMenu(0);f.api.seed({menu});const coffee=menu.items[0];assert.equal(f.api.quickItem(coffee),false);f.api.openDish(coffee);
 let inputs=f.get('#dish-options').querySelectorAll('input');assert.equal(inputs.some(x=>x.name==='milk'&&['ordinary',''].includes(x.value)),false);assert.equal(f.get('#dish-add').disabled,true);await f.submitDish();assert.equal(f.requests.length,0);
 chooseDishInput(f,'milk','oat');assert.equal(f.get('#dish-add').disabled,false);assert.equal(f.get('#dish-add').textContent,'Добавить · 450 ₽');await f.submitDish();assert.equal(f.api.state().cart[0].optionIds.includes('oat'),true);assert.equal(f.api.state().cart[0].optionIds.includes('ordinary'),false);
});

test('Unavailable variants and per-variant options are hidden without losing the dish comment',()=>{
 const f=fixture(),menu=structuredClone(catalog),coffee=menu.items[0];coffee.variants=[{id:'small',name:'Маленький',active:true,priceCents:0},{id:'large',name:'Большой',active:true,priceCents:10000},{id:'empty',name:'Закончился',active:true,priceCents:0}];coffee.stock={defaultAvailable:5,variants:[{variantId:'small',available:5,defaultAvailable:5,configured:true},{variantId:'large',available:5,defaultAvailable:5,configured:true},{variantId:'empty',available:0,defaultAvailable:0,configured:true}],options:[optionState('none',5,{variantId:'small'}),optionState('one',5,{variantId:'small'}),optionState('none',5,{variantId:'large'}),optionState('one',0,{variantId:'large'})]};f.api.seed({menu});f.api.openDish(coffee);assert.equal(f.get('#dish-options').querySelectorAll('input').some(x=>x.value==='empty'),false);
 chooseDishInput(f,'variant','small');chooseDishInput(f,'sugar','one');f.get('#dish-form').elements.comment.value='Погорячее';chooseDishInput(f,'variant','large');assert.equal(f.get('#dish-options').querySelectorAll('input').some(x=>x.value==='one'),false);assert.equal(f.get('#dish-form').elements.comment.value,'Погорячее');assert.match(f.get('#dish-stock-error').textContent,/закончились/);assert.equal(f.get('#dish-add').disabled,false);
});

test('An unavailable mandatory modifier cannot be selected or submitted',async()=>{
 const f=fixture(),menu=structuredClone(catalog);menu.groups[0].min=1;menu.items[0].stock={defaultAvailable:4,options:[optionState('none',0),optionState('one',0)]};f.api.seed({menu});f.api.openDish(menu.items[0]);assert.equal(f.get('#dish-options').querySelectorAll('input').length,0);assert.equal(f.get('#dish-add').disabled,true);await f.submitDish();assert.equal(f.requests.length,0);assert.match(f.get('#dish-stock-error').textContent,/закончились/);
});

test('Refreshing stock in an open editor removes depleted choices and preserves comment and quantity',()=>{
 const f=fixture(),menu=milkMenu();f.api.seed({menu,cart:[{...line(3),optionIds:['oat'],comment:'Без пенки'}]});f.api.openDish(menu.items[0],0);const changed=structuredClone(menu);changed.items[0].stock.options.find(o=>o.optionId==='oat').available=2;f.api.seed({menu:changed});f.api.refreshDishStock();assert.equal(f.get('#dish-options').querySelectorAll('input').some(x=>x.value==='oat'),false);assert.equal(f.get('#dish-form').elements.comment.value,'Без пенки');assert.equal(f.api.state().cart[0].quantity,3);assert.match(f.get('#dish-stock-error').textContent,/Проверьте состав/);
});

test('The editor consumes the real stock metadata for ordinary and replacement cappuccino',async()=>{
 const admin=new AdminStore(':memory:'),owner={id:1,role:'admin',login:'owner'};admin.db.exec("INSERT INTO admin_users VALUES(1,'owner','admin','unused')");
 try{
  const cafe=new CafeStore(admin,null,{env:{}}),inventory=cafe.stock.inventory,goods=inventory.catalog(owner).items,good=name=>goods.find(i=>i.name===name);
  const setStock=(name,amount)=>{const i=inventory.row(good(name).id);inventory.move({id:i.id,revision:i.revision,kind:'SET',reason:'Проверочный пересчёт',amount,requestId:webcrypto.randomUUID()},owner);};
  setStock('Кофе','1');setStock('Молоко обычное','2');setStock('Молоко овсяное','1');
  const menu=cafe.catalog(),coffee=menu.items.find(i=>i.name==='Капучино'),milk=menu.groups.find(g=>g.id==='coffee_milk'),sugar=menu.groups.find(g=>g.id==='coffee_sugar');
  const oat=milk.options.find(o=>o.name==='Овсяное'),ordinary=milk.options.find(o=>o.name==='Обычное'),none=sugar.options.find(o=>o.name==='Без сахара');oat.active=true;cafe.saveCatalog(menu,owner);
  const save=(component,ingredients)=>cafe.stock.save({itemId:coffee.id,component,revision:-1,ingredients},owner);
  save('base',[{id:good('Кофе').id,amount:'0.018'},{id:good('Молоко обычное').id,amount:'0.22'}]);save('option:'+ordinary.id,[]);save('option:'+none.id,[]);save('option:'+oat.id,[{id:good('Молоко овсяное').id,amount:'0.22',replacesId:good('Молоко обычное').id}]);
  let requirements;const fetcher=async(url,body)=>{assert.match(url,/stock-check$/);requirements=cafe.stock.check(cafe.calculate(body.items,'pickup').items);return {ok:true,status:200,json:async()=>({ok:true})};};
  const normal=fixture({fetcher}),firstMenu=cafe.publicMenu(),normalCoffee=firstMenu.items.find(i=>i.id===coffee.id);normal.api.seed({menu:firstMenu});assert.equal(normal.api.quickItem(normalCoffee),true);normal.api.openDish(normalCoffee);await normal.submitDish();assert.equal(normal.api.state().cart.length,1);assert.equal(requirements.get(good('Молоко обычное').id).amount,220);assert.equal(requirements.has(good('Молоко овсяное').id),false);
  setStock('Молоко обычное','0');const replacement=fixture({fetcher}),secondMenu=cafe.publicMenu(),oatCoffee=secondMenu.items.find(i=>i.id===coffee.id);replacement.api.seed({menu:secondMenu});assert.equal(replacement.api.quickItem(oatCoffee),false);replacement.api.openDish(oatCoffee);assert.equal(replacement.get('#dish-add').disabled,true);chooseDishInput(replacement,'coffee_milk',oat.id);await replacement.submitDish();assert.equal(replacement.api.state().cart.length,1);assert.equal(requirements.has(good('Молоко обычное').id),false);assert.equal(requirements.get(good('Молоко овсяное').id).amount,220);
 }finally{admin.close();}
});
