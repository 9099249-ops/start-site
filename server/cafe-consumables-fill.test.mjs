import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillCafeConsumables} from './cafe-consumables-fill.mjs';
import {quantityText} from './inventory.mjs';
const owner={id:1,role:'admin',login:'admin'};
function fixture(t){const admin=new AdminStore(':memory:');admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");t.after(()=>admin.close());const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{},request:async()=>{throw Error('No integrations');}});return {admin,cafe};}
function setStock(cafe,name,unit,current){const inventory=cafe.stock.inventory,row=inventory.catalog(owner).items.find(i=>i.name===name);return inventory.save({...(row?{id:row.id,revision:row.revision}:{}),name,category:row?.category||'Расходники',unit,current,minimum:null,target:null,manualBuy:false,comment:row?.comment||'',requestId:randomUUID()},owner).item;}

test('Consumables: 20 m roll becomes 2000 cm, 66 pizzas leave 20 cm through the original stock engine',t=>{
 const {cafe}=fixture(t),pizza=cafe.catalog().items.find(i=>i.name==='Маргарита песто');
 const product=setStock(cafe,pizza.name,'шт','100'),paper=setStock(cafe,'Пергамент','рулоны','1'),box=setStock(cafe,'Коробки для пиццы','шт','100');
 cafe.stock.save({itemId:pizza.id,component:'base',revision:-1,ingredients:[{id:product.id,amount:'1'}]},owner);
 const before=cafe.catalog(),result=fillCafeConsumables(cafe,owner);
 assert.deepEqual(cafe.catalog(),before);assert.equal(cafe.stock.inventory.row(paper.id).unit,'см');assert.equal(cafe.stock.inventory.row(paper.id).current_milli,2000000);
 const recipe=cafe.stock.recipe(pizza.id,'base');assert.equal(recipe.ingredients.find(i=>i.id===paper.id).amount,30000);assert.equal(recipe.ingredients.find(i=>i.id===box.id).amount,1000);
 assert.ok(result.changes.some(c=>c.kind==='unit_converted'));
 for(let n=0;n<66;n++)cafe.create({requestId:randomUUID(),name:'',phone:'',fulfillment:'pickup',payment:'cash',items:[{itemId:pizza.id,quantity:1}],expectedTotalCents:pizza.priceCents},owner,'test',Date.parse('2026-10-06T10:00:00+03:00'));
 assert.equal(quantityText(cafe.stock.inventory.row(paper.id).current_milli),'20');
 assert.equal(cafe.stock.inventory.row(box.id).current_milli,34000);
 assert.throws(()=>cafe.create({requestId:randomUUID(),name:'',phone:'',fulfillment:'pickup',payment:'cash',items:[{itemId:pizza.id,quantity:1}],expectedTotalCents:pizza.priceCents},owner,'test',Date.parse('2026-10-06T10:00:00+03:00')),/доступно 0/);
});

test('Consumables keep manual coffee doses, do not double existing cups, preserve package quantities and repeat safely',t=>{
 const {admin,cafe}=fixture(t),drink=cafe.catalog().items.find(i=>i.name==='Капучино'),coffee=setStock(cafe,'Кофе','кг','3'),milk=setStock(cafe,'Молоко обычное','л','10'),cup=setStock(cafe,'Стаканы 350 мл','штуки','100'),lid=setStock(cafe,'Крышки большие','упаковки','1');
 cafe.stock.save({itemId:drink.id,component:'base',revision:-1,ingredients:[{id:coffee.id,amount:'0.07'},{id:milk.id,amount:'0.25'},{id:cup.id,amount:'1'},{id:lid.id,amount:'1'}]},owner);
 const before=cafe.stock.recipe(drink.id,'base'),inventory=cafe.stock.inventory.row(lid.id),result=fillCafeConsumables(cafe,owner);
 assert.deepEqual(cafe.stock.recipe(drink.id,'base'),before);assert.deepEqual(cafe.stock.inventory.row(lid.id),inventory);
 const row=result.rows.find(r=>r.itemId===drink.id&&r.stockItemId===lid.id);assert.equal(row.quantity,'1');assert.equal(row.unit,'шт');assert.equal(row.existingQuantity,'1');assert.equal(row.existingUnit,'упаковки');assert.equal(row.purchaseQuantity,null);assert.equal(row.status,'needs_package');
 const snapshot=JSON.stringify(admin.db.prepare('SELECT * FROM cafe_recipes ORDER BY item_id,component').all()),stockRows=JSON.stringify(admin.db.prepare('SELECT * FROM inventory_items ORDER BY id').all());
 const repeated=fillCafeConsumables(cafe,owner);assert.equal(repeated.changes.length,0);assert.equal(JSON.stringify(admin.db.prepare('SELECT * FROM cafe_recipes ORDER BY item_id,component').all()),snapshot);assert.equal(JSON.stringify(admin.db.prepare('SELECT * FROM inventory_items ORDER BY id').all()),stockRows);
 assert.throws(()=>fillCafeConsumables(cafe,{id:2,role:'staff'}),e=>e.status===403);
});

test('Unknown orange consumption, new box balance and shared bags remain blank; no stock or second deduction is invented',t=>{
 const {cafe}=fixture(t),catalog=cafe.catalog();
 const source=catalog.items.find(i=>i.name==='Смузи');source.name='фреш апельсиновый';source.variants=[];source.groupIds=[];cafe.saveCatalog(catalog,owner);
 const plan=fillCafeConsumables(cafe,owner),box=plan.rows.find(r=>r.stockName==='Коробки для пиццы'),fresh=plan.rows.filter(r=>r.itemId===source.id&&['Стаканы матовые','Крышки большие','Трубочки'].includes(r.stockName));
 assert.equal(fresh.length,3);assert.ok(fresh.every(r=>r.quantity==='1'&&r.source==='confirmed'));
 assert.equal(cafe.stock.recipe(source.id,'base'),null);assert.equal(cafe.stock.inventory.row(box.stockItemId).current_milli,null);
 assert.ok(plan.rows.filter(r=>r.basis==='order').every(r=>r.quantity===null));
 assert.equal(cafe.db.prepare('SELECT count(*) n FROM cafe_stock_usage').get().n,0);assert.equal(cafe.db.prepare('SELECT count(*) n FROM payments').get().n,0);
});

test('Parchment with an existing roll recipe is not reinterpreted; assumed additions retain provenance until edited',t=>{
 const {cafe}=fixture(t),catalog=cafe.catalog(),pizza=catalog.items.find(i=>i.name==='Маргарита песто'),coffee=catalog.items.find(i=>i.name==='Американо');
 const paper=setStock(cafe,'Пергамент','рулоны','1'),product=setStock(cafe,pizza.name,'шт','10'),beans=setStock(cafe,'Кофе','кг','1'),cup=setStock(cafe,'Стаканы 350 мл','шт','100');
 cafe.stock.save({itemId:pizza.id,component:'base',revision:-1,ingredients:[{id:product.id,amount:'1'},{id:paper.id,amount:'0.015'}]},owner);
 cafe.stock.save({itemId:coffee.id,component:'base',revision:-1,ingredients:[{id:beans.id,amount:'0.018'}]},owner);
 const result=fillCafeConsumables(cafe,owner);assert.equal(cafe.stock.inventory.row(paper.id).unit,'рулоны');assert.ok(result.changes.some(c=>c.kind==='unit_review'));
 let row=cafe.stock.config(owner).consumablesPlan.rows.find(r=>r.itemId===coffee.id&&r.stockItemId===cup.id);assert.equal(row.source,'assumed');
 const saved=cafe.stock.recipe(coffee.id,'base');cafe.stock.save({itemId:coffee.id,component:'base',revision:saved.revision,ingredients:saved.ingredients.map(i=>({id:i.id,amount:quantityText(i.amount)}))},owner);
 row=cafe.stock.config(owner).consumablesPlan.rows.find(r=>r.itemId===coffee.id&&r.stockItemId===cup.id);assert.equal(row.source,'existing');
});
