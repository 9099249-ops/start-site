import test from 'node:test';
import assert from 'node:assert/strict';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
const owner={id:1,role:'admin',login:'admin'};
function fixture(t){const admin=new AdminStore(':memory:');admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});t.after(()=>admin.close());const catalog=cafe.catalog(),item=catalog.items.find(i=>i.name==='Классический чай');item.variants.forEach(v=>v.active=false);item.variants.push({id:'new-tea',name:'Новый вид чая',priceCents:0,active:true});cafe.saveCatalog(catalog,owner);return {admin,cafe,item};}
test('new tea variants remain visible and selectable without inventing a portion recipe',t=>{
 const {admin,cafe,item}=fixture(t),before=admin.db.prepare('SELECT count(*) n FROM cafe_recipes WHERE item_id=?').get(item.id).n;
 const row=cafe.publicMenu().items.find(i=>i.id===item.id);
 assert.equal(row.active,true);assert.equal(row.stock.configured,true);assert.ok(row.stock.available>0);assert.equal(row.stock.recipeMissing,true);assert.equal(row.stock.accountingIncomplete,true);
 assert.ok(row.stock.variants.find(v=>v.variantId==='new-tea').available>0);
 const quote=cafe.calculate([{itemId:item.id,variantId:'new-tea',quantity:1}],'pickup');
 assert.equal(quote.totalCents,50000);assert.equal(quote.items[0].variant.name,'Новый вид чая');
 assert.equal(cafe.stock.check(quote.items).size,0);
 assert.equal(admin.db.prepare('SELECT count(*) n FROM cafe_recipes WHERE item_id=?').get(item.id).n,before);
 assert.throws(()=>cafe.calculate([{itemId:item.id,variantId:item.variants[0].id,quantity:1}],'pickup'));
});
test('shared base consumption and configured variant shortages still protect actual inventory',t=>{
 const {admin,cafe,item}=fixture(t),stock=cafe.stock,goods=stock.inventory.catalog(owner).items,good=goods.find(i=>i.active);
 admin.db.prepare('UPDATE inventory_items SET current_milli=0 WHERE id=?').run(good.id);
 stock.save({itemId:item.id,component:'base',revision:-1,ingredients:[{id:good.id,amount:'1'}]},owner);
 const line={itemId:item.id,name:item.name,variant:{id:'new-tea'},quantity:1,modifiers:[]};
 assert.equal(stock.requirements(line)[0].id,good.id);assert.throws(()=>stock.check([line]));
 assert.equal(cafe.publicMenu().items.find(i=>i.id===item.id).stock.available,0);
 stock.save({itemId:item.id,component:'variant:new-tea',revision:-1,ingredients:[{id:good.id,amount:'2'}]},owner);
 assert.equal(stock.requirements(line)[0].amount,2000);assert.throws(()=>stock.check([line]));
 assert.equal(cafe.publicMenu().items.find(i=>i.id===item.id).stock.recipeMissing,false);
 assert.equal(admin.db.prepare('SELECT count(*) n FROM cafe_stock_usage').get().n,0);
});
test('missing ordinary base and missing modifier remain blocked; stop lists are preserved',t=>{
 const {cafe,item}=fixture(t);
 assert.throws(()=>cafe.stock.requirements({itemId:'not-configured',name:'Без рецепта',modifiers:[]}));
 const packaged=cafe.catalog().items.find(i=>i.name==='Липтон');
 assert.throws(()=>cafe.stock.requirements({itemId:packaged.id,name:packaged.name,variant:{id:'unknown-flavour'},modifiers:[]}));
 assert.throws(()=>cafe.stock.requirements({itemId:item.id,name:item.name,variant:{id:'new-tea'},modifiers:[{optionId:'unknown'}]}));
 const catalog=cafe.catalog();catalog.items.find(i=>i.id===item.id).soldOut=true;cafe.saveCatalog(catalog,owner);
 assert.throws(()=>cafe.calculate([{itemId:item.id,variantId:'new-tea',quantity:1}],'pickup'));
});
