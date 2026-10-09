import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsAnalytics,operationsAnalyticsHandler} from './operations-analytics.mjs';
import {cafeCostKey,cafeLineCost} from './operations-analytics-costs.mjs';
import {CafeProductCard,cafeProductCardHandler} from './cafe-product-card.mjs';
import {quantityText} from './inventory.mjs';

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused'),(4,'schedule','staff','unused')");
 const users={admin:{id:1,role:'admin'},staff:{id:2,role:'staff'},waiter:{id:3,role:'waiter'},schedule:{id:4,role:'staff',scheduleOnly:true}};
 admin.user=token=>users[token]||null;
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),analytics=new OperationsAnalytics(admin,cafe),card=new CafeProductCard(cafe,analytics.costs),inventory=cafe.stock.inventory;
 t.after(()=>admin.close());
 const rows=()=>inventory.catalog(users.staff).items.filter(item=>item.active);
 const price=(item,extra={})=>({requestId:randomUUID(),pricingRevision:card.pricingRevision(),inventoryId:item.id,unitId:item.unit_id,quantity:'1',totalCents:0,...extra});
 const tables=['inventory_transactions','cafe_orders','payments'].map(name=>({name,exists:!!admin.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)}));
 const counts=()=>Object.fromEntries(tables.filter(table=>table.exists).map(table=>[table.name,admin.db.prepare('SELECT count(*) n FROM '+table.name).get().n]));
 return {admin,cafe,analytics,card,inventory,users,rows,price,counts};
}

test('global price API accepts an actual zero and rejects blank, mismatched, archived, and estimated-without-source inputs',t=>{
 const f=fixture(t),item=f.rows()[0],balance=item.current_milli,history=f.counts();
 const saved=f.card.saveInventoryPrice(f.price(item,{quantity:'2',totalCents:0}),f.users.staff,1000);
 assert.equal(saved.price.totalCents,0);
 assert.equal(saved.price.quantity,'2');
 assert.deepEqual(f.counts(),history);
 assert.equal(f.inventory.row(item.id).current_milli,balance);

 const blank=f.price(item,{quantity:'',totalCents:10});
 assert.throws(()=>f.card.saveInventoryPrice(blank,f.users.staff,1100),{status:400});
 const otherUnit=f.inventory.catalog(f.users.staff).units.find(unit=>unit.id!==item.unit_id);
 assert.ok(otherUnit);
 assert.throws(()=>f.card.saveInventoryPrice(f.price(item,{unitId:otherUnit.id}),f.users.staff,1100),{status:409});
 assert.throws(()=>f.card.saveInventoryPrice(f.price(item,{estimated:true}),f.users.staff,1100),{status:400});
 assert.throws(()=>f.card.saveInventoryPrice(f.price(item,{estimated:true,sourceUrl:'javascript:alert(1)',sourceLabel:'Bad'}),f.users.staff,1100),{status:400});
 const archived=f.inventory.archive({id:item.id,revision:item.revision,active:false,requestId:randomUUID()},f.users.admin).item;
 assert.throws(()=>f.card.saveInventoryPrice(f.price(archived),f.users.staff,1200),{status:409});
 assert.equal(f.inventory.row(item.id).current_milli,balance);
});

test('global price POST enforces authorization and origin, then binds retries to payload and actor',async t=>{
 const f=fixture(t);let origin;
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,origin);if(await cafeProductCardHandler(f.card,f.admin,origin)(req,res,url))return;await operationsAnalyticsHandler(f.analytics,f.admin,origin)(req,res,url);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 origin='http://127.0.0.1:'+server.address().port;
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const item=f.rows()[0],body=f.price(item,{quantity:'3',totalCents:0});
 const post=(token,payload=body,requestOrigin=origin)=>fetch(origin+'/api/admin/inventory/prices',{
  method:'POST',headers:{...(token?{Cookie:'__Host-start_session='+token}:{}),Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify(payload),
 });
 assert.equal((await post(null)).status,401);
 assert.equal((await post('schedule')).status,403);
 assert.equal((await post('staff',body,'https://wrong.invalid')).status,403);
 const finance=token=>fetch(origin+'/api/admin/financial-analytics/costs',{headers:{Cookie:'__Host-start_session='+token}});
 assert.equal((await finance('staff')).status,403);
 assert.equal((await finance('admin')).status,200);
 const first=await post('staff');assert.equal(first.status,200);
 const response=await first.json();assert.equal(response.price.totalCents,0);
 const retry=await post('staff');assert.equal((await retry.json()).duplicate,true);
 assert.equal((await post('waiter')).status,409);
 const stale={...f.price(item),pricingRevision:0};
 assert.equal((await post('staff',stale)).status,409);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions').get().n,1);
});

test('inventory catalog estimates exact native quantities, leaves unknowns blank, and keeps financial costs admin-only',t=>{
 const f=fixture(t),[known,unknown,unset]=f.rows();
 f.admin.db.exec('UPDATE inventory_items SET current_milli=NULL,minimum_milli=NULL,target_milli=NULL,manual_buy=0');
 f.admin.db.prepare('UPDATE inventory_items SET current_milli=1500,minimum_milli=2000,target_milli=3000,manual_buy=0 WHERE id=?').run(known.id);
 f.admin.db.prepare('UPDATE inventory_items SET current_milli=0,minimum_milli=1000,target_milli=2000,manual_buy=0 WHERE id=?').run(unknown.id);
 f.admin.db.prepare('UPDATE inventory_items SET current_milli=NULL,minimum_milli=NULL,target_milli=NULL,manual_buy=0 WHERE id=?').run(unset.id);
 f.card.saveInventoryPrice(f.price(known,{quantity:'3',totalCents:1000}),f.users.admin,1000);
 f.card.saveInventoryPrice(f.price(unset,{quantity:'1',totalCents:99}),f.users.admin,1100);

 const catalog=f.inventory.catalog(f.users.staff),knownRow=catalog.items.find(item=>item.id===known.id),unsetRow=catalog.items.find(item=>item.id===unset.id);
 assert.equal(knownRow.buyQuantity,'1.5');
 assert.equal(knownRow.purchaseEstimateCents,500);
 assert.equal(knownRow.purchasePrice.quantity,'3');
 assert.equal(unsetRow.buyQuantity,null);
 assert.equal(unsetRow.purchaseEstimateCents,null);
 assert.deepEqual(catalog.purchaseSummary,{knownEstimateCents:500,pricedCount:1,incompleteCount:1,totalCount:2});
 assert.throws(()=>f.analytics.costs.catalog(f.users.staff),{status:403});
});

test('a stored price in the old unit stays unpriced after an inventory unit edit',t=>{
 const f=fixture(t),item=f.rows()[0],before=item.current_milli;
 f.card.saveInventoryPrice(f.price(item,{quantity:'2',totalCents:200}),f.users.admin,1000);
 const nextUnit=f.inventory.catalog(f.users.admin).units.find(unit=>unit.id!==item.unit_id);
 assert.ok(nextUnit);
 f.inventory.save({id:item.id,revision:item.revision,name:item.name,category:item.category,unit:nextUnit.name,
  current:quantityText(item.current_milli),minimum:quantityText(item.minimum_milli),target:quantityText(item.target_milli),
  comment:item.comment,manualBuy:!!item.manual_buy,requestId:randomUUID()},f.users.admin);
 const updated=f.inventory.catalog(f.users.staff).items.find(row=>row.id===item.id);
 assert.equal(updated.purchasePrice.unitId,item.unit_id);
 assert.equal(updated.unitPriceCents,null);
 assert.equal(updated.purchaseEstimateCents,null);
 assert.equal(updated.current_milli,before);
});

test('a global SKU price refreshes every automatic recipe from that point forward without stock or order writes',t=>{
 const f=fixture(t),items=f.cafe.catalog().items.slice(0,2),stock=f.rows()[0],balances=new Map([[stock.id,f.inventory.row(stock.id).current_milli]]),before=f.counts();
 for(const item of items){
  const snapshot=f.card.snapshot(f.users.staff),product=structuredClone(snapshot.catalog.items.find(row=>row.id===item.id));
  product.costMode='recipe';product.variants=[];product.groupIds=[];
  f.card.save({requestId:randomUUID(),menuRevision:snapshot.catalog.revision,costRevision:snapshot.costRevision,
   pricingRevision:snapshot.pricingRevision,item:product,costs:[],recipes:[{component:'base',revision:f.cafe.stock.recipe(item.id,'base')?.revision??-1,
    ingredients:[{id:stock.id,amount:'1'}]}],purchasePrices:[]},f.users.staff,1000);
 }
 const oldReader=f.analytics.costs.reader();
 const body=f.price(stock,{quantity:'1000',totalCents:250000});
 f.card.saveInventoryPrice(body,f.users.staff,2000);
 const newReader=f.analytics.costs.reader();
 for(const item of items){
  const line={itemId:item.id,costMode:'recipe',modifiers:[]},key=cafeCostKey(item.id);
  assert.equal(cafeLineCost(oldReader,line,2001),null);
  assert.equal(cafeLineCost(newReader,line,2001),250);
  assert.equal(f.analytics.costs.currentCafeCost(item.id,'base',2000).portionCents,250);
 }
 assert.deepEqual(f.counts(),before);
 for(const [id,amount] of balances)assert.equal(f.inventory.row(id).current_milli,amount);
});
