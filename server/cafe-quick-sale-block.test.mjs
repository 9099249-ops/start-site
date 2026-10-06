import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';
import {cafeListRow} from './cafe-list.mjs';

const owner={id:1,role:'admin'},staff={id:2,role:'staff'};
const now=Date.parse('2026-10-05T12:00:00+03:00');
function fixture(){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'employee','staff','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});
 fillTestCafeStock(cafe);
 const item=cafe.catalog().items.find(i=>i.name==='Сырники');
 const toggle=value=>{const menu=cafe.catalog();menu.items.find(i=>i.id===item.id).blockQuickSale=value;return cafe.saveCatalog(menu,owner);};
 const body=()=>({requestId:randomUUID(),name:'Тест',fulfillment:'pickup',payment:'unspecified',quickSale:true,items:[{itemId:item.id,quantity:1,optionIds:[]}],expectedTotalCents:item.priceCents});
 return {admin,cafe,item,toggle,body};
}
function check(name,fn){test('Immediate handoff: '+name,()=>{const f=fixture();try{fn(f);}finally{f.admin.close();}});}

check('catalog defaults remain compatible, validate booleans and preserve omitted saved protection',f=>{
 const first=f.cafe.saveCatalog(f.cafe.catalog(),owner);
 assert.equal(first.items.find(i=>i.id===f.item.id).blockQuickSale,false);
 f.toggle(true);
 const olderClient=f.cafe.catalog();delete olderClient.items.find(i=>i.id===f.item.id).blockQuickSale;
 assert.equal(f.cafe.saveCatalog(olderClient,owner).items.find(i=>i.id===f.item.id).blockQuickSale,true);
 for(const value of ['true',1,null])assert.throws(()=>f.toggle(value),/переключатели/);
 assert.equal(f.cafe.publicMenu().items.find(i=>i.id===f.item.id).blockQuickSale,true);
 assert.throws(()=>f.cafe.saveCatalog(f.cafe.catalog(),staff),e=>e.status===403);
 assert.equal(f.toggle(false).items.find(i=>i.id===f.item.id).blockQuickSale,false);
});

check('blocked card, cash and manual handoff fail before creating orders, stock usage, notifications or payments',f=>{
 f.toggle(true);f.cafe.terminal={enabled:true};
 const stock=f.cafe.stock.inventory.catalog(owner).items.map(i=>[i.id,i.current_milli]);
 for(const flags of [{},{cashRequested:true},{manualPaidRequested:true}]){
  const body={...f.body(),...flags};
  assert.throws(()=>f.cafe.quote(body,staff,now),e=>e.status===409&&/Сырники.*В работу/.test(e.message));
  assert.throws(()=>f.cafe.create(body,staff,'test',now),e=>e.status===409);
 }
 for(const table of ['cafe_orders','cafe_order_events','cafe_stock_usage','cafe_notifications','payments'])assert.equal(f.admin.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 assert.deepEqual(f.cafe.stock.inventory.catalog(owner).items.map(i=>[i.id,i.current_milli]),stock);
});

check('mixed orders, variants and forged client flags cannot bypass the catalog rule',f=>{
 const menu=f.cafe.catalog(),item=menu.items.find(i=>i.id===f.item.id);
 item.blockQuickSale=true;item.variants=[{id:'test-variant',name:'Порция',priceCents:0,active:true}];f.cafe.saveCatalog(menu,owner);
 fillTestCafeStock(f.cafe);
 const other=menu.items.find(i=>i.id!==item.id&&!i.variants.length&&!i.restricted);
 const body=f.body();body.items=[{itemId:other.id,quantity:1},{itemId:item.id,quantity:2,variantId:'test-variant',blockQuickSale:false}];body.expectedTotalCents=other.priceCents+2*item.priceCents;
 assert.throws(()=>f.cafe.create(body,staff,'test',now),/Нельзя сразу выдать/);
 assert.equal(f.cafe.quote({...body,quickSale:false},staff,now).totalCents,body.expectedTotalCents);
 const order=f.cafe.create({...body,quickSale:false},staff,'test',now);
 assert.equal(order.status,'NEW');assert.equal(order.totalCents,body.expectedTotalCents);
});

check('all preparation modes remain accepted without automatic delivery',f=>{
 f.toggle(true);f.cafe.terminal={enabled:true};
 for(const flags of [{},{cashRequested:true},{manualPaidRequested:true}]){
  const body={...f.body(),quickSale:false,...flags};
  const order=f.cafe.create(body,staff,'test',now);
  assert.equal(order.status,'NEW');assert.equal(order.details.terminalQuickSale,false);
  assert.equal(order.details.pendingKitchen,true);assert.equal(order.totalCents,f.item.priceCents);
 }
});

check('a changed setting is enforced after quoting, while retries still recover an already saved sale',f=>{
 const body=f.body();f.cafe.quote(body,staff,now);f.toggle(true);
 assert.throws(()=>f.cafe.create(body,staff,'test',now),/Нельзя сразу выдать/);
 f.toggle(false);const saved=f.cafe.create(body,staff,'test',now);assert.equal(saved.status,'DELIVERED');
 f.toggle(true);const retry=f.cafe.create(body,staff,'test',now+1000);
 assert.equal(retry.id,saved.id);assert.equal(retry.duplicate,true);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_orders').get().n,1);
});

check('complimentary meals obey handoff restriction but can still enter preparation',f=>{
 f.toggle(true);const body={...f.body(),complimentary:{reason:'owner',comment:''},expectedTotalCents:0};
 assert.throws(()=>f.cafe.create(body,owner,'test',now),/Нельзя сразу выдать/);
 assert.equal(f.cafe.create({...body,quickSale:false},owner,'test',now).status,'NEW');
});

check('list and direct status requests cannot skip readiness; the saved restriction survives menu edits',f=>{
 f.toggle(true);const saved=f.cafe.create({...f.body(),quickSale:false},staff,'test',now);
 f.toggle(false);
 let order=f.cafe.order(saved.id,staff);
 assert.equal(order.details.items[0].blockQuickSale,true);
 assert.equal(cafeListRow(order,null).action,null);
 assert.equal(cafeListRow(order,null).ready,true);
 assert.throws(()=>f.cafe.status({id:order.id,revision:order.revision,status:'DELIVERED'},staff,now+1000),/Готов к выдаче/);
 order=f.cafe.status({id:order.id,revision:order.revision,status:'COOKING'},staff,now+2000);
 assert.throws(()=>f.cafe.status({id:order.id,revision:order.revision,status:'DELIVERED'},staff,now+3000),/Готов к выдаче/);
 order=f.cafe.status({id:order.id,revision:order.revision,status:'READY'},staff,now+4000);
 assert.equal(cafeListRow(order,null).action,'complete');
 assert.equal(f.cafe.status({id:order.id,revision:order.revision,status:'DELIVERED'},staff,now+5000).status,'DELIVERED');
});
