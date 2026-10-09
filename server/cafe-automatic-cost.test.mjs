import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsAnalytics} from './operations-analytics.mjs';
import {cafeCostKey,cafeLineCost,cafeLineCostEstimated} from './operations-analytics-costs.mjs';
import {CafeProductCard} from './cafe-product-card.mjs';

const owner={id:1,role:'admin',login:'admin'};
const staff={id:2,role:'staff',login:'station'};

test('automatic cost estimates follow only ingredients remaining after replacements',()=>{
 const rows=new Map([
  ['item|base',{recipeCost:{ingredients:[{id:1,unitId:1,amount:1000}],prices:[{id:1,unitId:1,quantityMilli:1000,totalCents:400,estimated:true}],missingNorms:[]}}],
  ['item|option:oat',{recipeCost:{ingredients:[{id:2,unitId:1,amount:1000,replacesId:1}],prices:[{id:2,unitId:1,quantityMilli:1000,totalCents:120,estimated:false}],missingNorms:[]}}],
  ['cup|base',{recipeCost:{ingredients:[{id:3,unitId:1,amount:1000}],prices:[{id:3,unitId:1,quantityMilli:1000,totalCents:75,estimated:true}],missingNorms:[]}}],
 ]);
 const reader=(_kind,key)=>rows.get(key)||{};
 const replaced={itemId:'item',costMode:'recipe',modifiers:[{optionId:'oat'}]};
 assert.equal(cafeLineCost(reader,replaced,1000),120);
 assert.equal(cafeLineCostEstimated(reader,replaced,1000),false);
 const cup={itemId:'cup',costMode:'recipe',modifiers:[]};
 assert.equal(cafeLineCost(reader,cup,1000),75);
 assert.equal(cafeLineCostEstimated(reader,cup,1000),true);
});

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});
 const analytics=new OperationsAnalytics(admin,cafe),costs=analytics.costs,card=new CafeProductCard(cafe,costs);
 t.after(()=>admin.close());
 const item=(index=0)=>cafe.catalog().items[index];
 const ingredients=()=>cafe.stock.inventory.catalog(staff).items.filter(row=>row.active);
 const draft=(itemId,recipeRows,priceRows=[])=>{
  const snapshot=card.snapshot(staff),product=structuredClone(snapshot.catalog.items.find(row=>row.id===itemId));
  product.variants=[];product.costMode='recipe';
  return {requestId:randomUUID(),menuRevision:snapshot.catalog.revision,costRevision:snapshot.costRevision,
   pricingRevision:snapshot.pricingRevision,item:product,recipes:recipeRows,purchasePrices:priceRows};
 };
 const recipe=(itemId,component,rows)=>({component,revision:cafe.stock.recipe(itemId,component)?.revision??-1,ingredients:rows});
 const saveRecipeCard=(itemId,recipeRows,priceRows=[],now=2000)=>card.save(draft(itemId,recipeRows,priceRows),staff,now);
 const price=(stock,totalCents,extra={})=>({inventoryId:stock.id,unitId:stock.unit_id,quantity:'1000',totalCents,...extra});
 const balance=id=>cafe.stock.inventory.row(id).current_milli;
 return {admin,cafe,analytics,costs,card,item,ingredients,draft,recipe,saveRecipeCard,price,balance};
}

test('recipe mode derives a 250 cent portion when manual costs are omitted and leaves stock balances alone',t=>{
 const f=fixture(t),item=f.item(),stock=f.ingredients()[0],before=f.balance(stock.id);
 const result=f.saveRecipeCard(item.id,[f.recipe(item.id,'base',[{id:stock.id,amount:'1'}])],[f.price(stock,250000)]);
 assert.equal(result.costs.find(row=>row.itemId===item.id&&row.component==='base').portionCents,250);
 assert.deepEqual(result.costSources.find(row=>row.itemId===item.id&&row.component==='base'),{
  itemId:item.id,component:'base',source:'recipe',estimated:false,missingPrices:[],missingNorms:[],
 });
 assert.equal(f.costs.catalog(owner,2001).rows.find(row=>row.key===cafeCostKey(item.id)).fields.portionCents,250);
 assert.equal(f.cafe.stock.config(staff).recipes.find(row=>row.item_id===item.id&&row.component==='base').ingredients[0].amount,1000);
 assert.equal(f.balance(stock.id),before);
});

test('one shared SKU price refreshes two recipe cards while an existing reader retains its old creation-time value',t=>{
 const f=fixture(t),first=f.item(0),second=f.item(1),stock=f.ingredients()[0];
 f.costs.save({requestId:randomUUID(),revision:f.costs.revision(),changes:[
  {kind:'cafe',key:cafeCostKey(first.id),values:{portionCents:50}},
  {kind:'cafe',key:cafeCostKey(second.id),values:{portionCents:50}},
 ]},owner,1000);
 f.saveRecipeCard(first.id,[f.recipe(first.id,'base',[{id:stock.id,amount:'1'}])],[f.price(stock,250000)],2000);
 f.saveRecipeCard(second.id,[f.recipe(second.id,'base',[{id:stock.id,amount:'1'}])],[],2000);
 const oldReader=f.costs.reader();
 assert.equal(oldReader('cafe',cafeCostKey(first.id),2001).portionCents,250);
 assert.equal(oldReader('cafe',cafeCostKey(second.id),2001).portionCents,250);

 const update=f.draft(first.id,[],[f.price(stock,300000)]);
 f.card.save(update,staff,3000);
 assert.equal(f.costs.reader()('cafe',cafeCostKey(first.id),3001).portionCents,300);
 assert.equal(f.costs.reader()('cafe',cafeCostKey(second.id),3001).portionCents,300);
 assert.equal(oldReader('cafe',cafeCostKey(first.id),3001).portionCents,250);
 assert.equal(oldReader('cafe',cafeCostKey(second.id),3001).portionCents,250);
});

test('estimated provenance is exposed then cleared by an actual price edit',t=>{
 const f=fixture(t),item=f.item(),stock=f.ingredients()[0],rows=[f.recipe(item.id,'base',[{id:stock.id,amount:'1'}])];
 let saved=f.saveRecipeCard(item.id,rows,[f.price(stock,250000,{estimated:true,sourceUrl:'https://supplier.example/item',sourceLabel:'Supplier quote'})]);
 let source=saved.costSources.find(row=>row.itemId===item.id&&row.component==='base');
 assert.equal(source.estimated,true);
 assert.equal(saved.purchasePrices.find(row=>row.inventoryId===stock.id).estimated,true);
 saved=f.card.save(f.draft(item.id,[],[f.price(stock,260000)]),staff,3000);
 source=saved.costSources.find(row=>row.itemId===item.id&&row.component==='base');
 assert.equal(source.estimated,false);
 assert.equal(saved.purchasePrices.find(row=>row.inventoryId===stock.id).estimated,undefined);
 assert.equal(f.costs.currentCafeCost(item.id,'base',3000).portionCents,260);
});

test('missing prices, unit mismatches, and declared missing norms keep the recipe cost unknown',t=>{
 const f=fixture(t),item=f.item();
 f.saveRecipeCard(item.id,[f.recipe(item.id,'base',[{id:f.ingredients()[0].id,amount:'1'}])],[],2000);
 let current=f.costs.currentCafeCost(item.id,'base',2000);
 assert.equal(current.portionCents,null);
 assert.deepEqual(current.missingPrices,[f.ingredients()[0].id]);

 const stored=f.cafe.catalog(),savedItem=stored.items.find(row=>row.id===item.id);savedItem.missingRecipeNorms=['Lid quantity not confirmed'];
 f.cafe.saveCatalog(stored,staff,fn=>fn(),false);
 const inventory=f.cafe.stock.inventory.row(f.ingredients()[0].id);
 const alternateUnit=f.cafe.stock.inventory.catalog(staff).units.find(unit=>unit.id!==inventory.unit_id);
 assert.ok(alternateUnit);
 f.admin.db.prepare('INSERT INTO cafe_purchase_price_versions(inventory_id,unit_id,quantity_milli,total_cents,actor,request_id,created_at) VALUES(?,?,?,?,?,?,?)')
  .run(inventory.id,alternateUnit.id,1000,250000,staff.id,randomUUID(),2100);
 const snapshot=f.costs.currentCafeCost(item.id,'base',2200);
 assert.equal(snapshot.portionCents,null);
 assert.deepEqual(snapshot.missingPrices,[inventory.id]);
 assert.deepEqual(snapshot.missingNorms,['Lid quantity not confirmed']);
});

test('a current inventory unit change invalidates auto cost without rewriting historical readers',t=>{
 const f=fixture(t),item=f.item(),stock=f.ingredients()[0];
 f.saveRecipeCard(item.id,[f.recipe(item.id,'base',[{id:stock.id,amount:'1'}])],[f.price(stock,250000)],2000);
 const priorReader=f.costs.reader();
 const historicalLine={itemId:item.id,costMode:'recipe',modifiers:[]};
 assert.equal(cafeLineCost(priorReader,historicalLine,2001),250);

 const alternateUnit=f.cafe.stock.inventory.catalog(staff).units.find(unit=>unit.id!==stock.unit_id);
 assert.ok(alternateUnit);
 f.admin.db.prepare('UPDATE inventory_items SET unit_id=? WHERE id=?').run(alternateUnit.id,stock.id);

 const current=f.costs.currentCafeCost(item.id,'base',3000);
 assert.equal(current.portionCents,null);
 assert.deepEqual(current.missingPrices,[stock.id]);
 assert.equal(cafeLineCost(priorReader,historicalLine,3001),250);
});

test('replacement excludes base milk in recipe costing and finance adds modifiers only for manual mode',t=>{
 const f=fixture(t),catalog=f.cafe.catalog(),item=catalog.items[0],manualItem=catalog.items[1],group=catalog.groups[0],option=group.options[0];
 item.groupIds=[group.id];item.costMode='recipe';
 manualItem.groupIds=[group.id];manualItem.costMode='manual';
 f.cafe.saveCatalog(catalog,owner,fn=>fn(),false);
 const [base,substitute]=f.ingredients().filter(row=>row.unit_id===f.ingredients()[0].unit_id).slice(0,2);
 assert.ok(base&&substitute&&base.id!==substitute.id);
 const baseRecipe=f.recipe(item.id,'base',[{id:base.id,amount:'1'}]);
 const optionRecipe=f.recipe(item.id,'option:'+option.id,[{id:substitute.id,amount:'1',replacesId:base.id}]);
 const manualBase=f.recipe(manualItem.id,'base',[{id:base.id,amount:'1'}]);
 const manualOption=f.recipe(manualItem.id,'option:'+option.id,[{id:substitute.id,amount:'1'}]);
 f.saveRecipeCard(item.id,[baseRecipe,optionRecipe],[f.price(base,400000),f.price(substitute,120000)],2000);
 f.cafe.stock.save({itemId:manualItem.id,...manualBase,ingredients:manualBase.ingredients},staff,null,fn=>fn(),false);
 f.cafe.stock.save({itemId:manualItem.id,...manualOption,ingredients:manualOption.ingredients},staff,null,fn=>fn(),false);
 f.costs.save({requestId:randomUUID(),revision:f.costs.revision(),changes:[
  {kind:'cafe',key:cafeCostKey(manualItem.id),values:{portionCents:500}},
  {kind:'cafe',key:cafeCostKey(manualItem.id,'option:'+option.id),values:{portionCents:120}},
 ]},owner,2000);

 const reader=f.costs.reader(),modifier={optionId:option.id};
 const recipeLine={itemId:item.id,costMode:'recipe',modifiers:[modifier]};
 const manualLine={itemId:manualItem.id,modifiers:[modifier]};
 assert.equal(f.costs.currentCafeCost(item.id,'base',2001).portionCents,400);
 assert.equal(f.costs.currentCafeCost(item.id,'option:'+option.id,2001).portionCents,120);
 assert.equal(cafeLineCost(reader,recipeLine,3001),120);
 assert.equal(cafeLineCost(reader,manualLine,3001),500);
 const insertOrder=(line,index)=>f.admin.db.prepare('INSERT INTO cafe_orders(request_id,fingerprint,public_token,client_id,actor,source,place_id,details,total_cents,status,created,updated,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(randomUUID(),'fixture-'+index,'token-'+index,null,owner.id,'pos',null,JSON.stringify({items:[{...line,name:'Test item',quantity:1,unitCents:1000,totalCents:1000,variant:null}]}),1000,'NEW',3000,3000,0);
 insertOrder(recipeLine,1);insertOrder(manualLine,2);
 const report=f.analytics.cafeReport({start:0,end:5000},reader,5000);
 assert.equal(report.items.find(row=>row.itemId===item.id).costCents,120);
 assert.equal(report.items.find(row=>row.itemId===manualItem.id).costCents,620);
});

test('product-card price validation, stale revisions, and idempotency preserve atomicity',t=>{
 const f=fixture(t),item=f.item(),stock=f.ingredients()[0],before=f.card.snapshot(staff),recipeRows=[f.recipe(item.id,'base',[{id:stock.id,amount:'1'}])];
 const invalid=f.draft(item.id,recipeRows,[f.price(stock,250000,{estimated:true,sourceUrl:'javascript:alert(1)',sourceLabel:'Bad source'})]);
 assert.throws(()=>f.card.save(invalid,staff,2000),{status:400});
 assert.deepEqual(f.card.snapshot(staff),before);
 assert.equal(f.cafe.stock.recipe(item.id,'base'),null);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions').get().n,0);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_product_card_requests').get().n,0);

 const stale=f.draft(item.id,recipeRows,[f.price(stock,250000)]);
 f.costs.save({requestId:randomUUID(),revision:f.costs.revision(),changes:[
  {kind:'cafe',key:cafeCostKey(item.id),values:{portionCents:50}},
 ]},owner,1000);
 const afterStaleMutation=f.card.snapshot(staff);
 assert.throws(()=>f.card.save(stale,staff,2000),{status:409});
 assert.deepEqual(f.card.snapshot(staff),afterStaleMutation);
 assert.equal(f.cafe.stock.recipe(item.id,'base'),null);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions').get().n,0);

 const accepted=f.draft(item.id,recipeRows,[f.price(stock,250000)]),saved=f.card.save(accepted,staff,3000);
 assert.equal(saved.costs.find(row=>row.itemId===item.id&&row.component==='base').portionCents,250);
 assert.equal(f.card.save(accepted,staff,4000).duplicate,true);
 assert.throws(()=>f.card.save({...accepted,purchasePrices:[f.price(stock,260000)]},staff,4000),{status:409});
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions').get().n,1);
});
