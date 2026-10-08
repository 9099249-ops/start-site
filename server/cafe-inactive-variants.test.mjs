import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillTestCafeStock} from './testing/cafe-stock-fixture.mjs';

const owner={id:1,role:'admin'};
function fixture(t){
 const admin=new AdminStore(':memory:');admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
 t.after(()=>admin.close());const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});
 fillTestCafeStock(cafe);
 const menu=cafe.catalog(),item=menu.items.find(i=>i.name==='Капучино');
 item.variants=[{id:'ordinary',name:'Обычное молоко',priceCents:5000,active:false}];
 cafe.saveCatalog(menu,owner);
 return {admin,cafe,item,line:{itemId:item.id,quantity:1,variantId:null,optionIds:[]}};
}
test('Inactive cafe variants use the configured base price and stock without deleting variant settings',t=>{
 const f=fixture(t),quoted=f.cafe.calculate([f.line],'pickup',owner);
 assert.equal(quoted.items[0].variant,null);assert.equal(quoted.totalCents,f.item.priceCents);
 assert.equal(f.cafe.catalog().items.find(i=>i.id===f.item.id).variants.length,1);
 const available=f.cafe.publicMenu().items.find(i=>i.id===f.item.id).stock;
 assert.ok(available.defaultAvailable>0);assert.ok(available.variants.find(v=>v.variantId===null).configured);
 assert.ok(f.cafe.stock.check(quoted.items).size>0);
 const request={requestId:randomUUID(),name:'',phone:'',fulfillment:'pickup',payment:'cash',quickSale:true,items:[f.line],expectedTotalCents:f.item.priceCents};
 const receipt=f.cafe.create(request,owner,'test');
 const after=f.admin.db.prepare('SELECT * FROM cafe_stock_usage WHERE order_id=?').all(receipt.id);
 assert.equal(receipt.totalCents,f.item.priceCents);assert.equal(receipt.status,'DELIVERED');
 assert.equal(f.cafe.create(request,owner,'test').id,receipt.id);
 assert.deepEqual(f.admin.db.prepare('SELECT * FROM cafe_stock_usage WHERE order_id=?').all(receipt.id),after);
 assert.throws(()=>f.cafe.calculate([{...f.line,variantId:'ordinary'}],'pickup',owner),/Вариант не найден/);
});
test('Active variants still require selection and preserve their price; hidden variants cannot be selected',t=>{
 const f=fixture(t),menu=f.cafe.catalog();menu.items.find(i=>i.id===f.item.id).variants.push({id:'large',name:'Большой',priceCents:10000,active:true});f.cafe.saveCatalog(menu,owner);
 assert.throws(()=>f.cafe.calculate([f.line],'pickup',owner),/Выберите доступный вариант/);
 assert.throws(()=>f.cafe.calculate([{...f.line,variantId:'ordinary'}],'pickup',owner),/Выберите доступный вариант/);
 assert.equal(f.cafe.calculate([{...f.line,variantId:'large'}],'pickup',owner).totalCents,f.item.priceCents+10000);
});
test('Inactive variant fallback cannot bypass missing base stock, shortages, modifiers or immediate-handoff protection',t=>{
 const f=fixture(t),quoted=f.cafe.calculate([f.line],'pickup',owner),ingredient=[...f.cafe.stock.check(quoted.items).keys()][0];
 f.admin.db.prepare('UPDATE inventory_items SET current_milli=0 WHERE id=?').run(ingredient);
 assert.throws(()=>f.cafe.stock.check(quoted.items),e=>e.stockCode==='INSUFFICIENT');
 f.admin.db.prepare('DELETE FROM cafe_recipes WHERE item_id=? AND component=?').run(f.item.id,'base');
 assert.throws(()=>f.cafe.stock.check(quoted.items),e=>e.stockCode==='UNCONFIGURED');
 assert.throws(()=>f.cafe.calculate([{...f.line,optionIds:['not-an-option']}],'pickup',owner),/Добавка недоступна/);
 const menu=f.cafe.catalog();menu.items.find(i=>i.id===f.item.id).blockQuickSale=true;f.cafe.saveCatalog(menu,owner);
 assert.throws(()=>f.cafe.assertQuickSale({quickSale:true},quoted.items),/сразу выдать/);
});
