import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsCosts} from './operations-analytics-costs.mjs';
import {CafeProductCard,cafeProductCardHandler} from './cafe-product-card.mjs';

function fixture(t){
 const admin=new AdminStore(':memory:');admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");
 const users={admin:{id:1,role:'admin'},staff:{id:2,role:'staff'},waiter:{id:3,role:'waiter'},schedule:{id:2,role:'staff',scheduleOnly:true}};
 admin.user=token=>users[token]||null;
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),costs=new OperationsCosts(admin,cafe),card=new CafeProductCard(cafe,costs);
 t.after(()=>admin.close());
 const draft=(user=users.staff)=>{const data=card.snapshot(user),item=structuredClone(data.catalog.items[0]);item.name='Новое название';item.variants=[];item.groupIds=[];item.active=true;
  return {requestId:randomUUID(),menuRevision:data.catalog.revision,costRevision:data.costRevision,pricingRevision:data.pricingRevision,item,recipes:[],costs:[],purchasePrices:[]};};
 return {admin,cafe,costs,card,users,draft};
}

for(const role of ['admin','staff','waiter'])test(`Product card: ${role} saves product, recipe, purchase price and portion cost atomically`,t=>{
 const f=fixture(t),u=f.users[role],body=f.draft(u),stock=f.cafe.stock.inventory.catalog(u).items[0],oldStock=f.cafe.stock.inventory.row(stock.id);
 body.recipes=[{component:'base',revision:f.cafe.stock.recipe(body.item.id,'base')?.revision??-1,ingredients:[{id:stock.id,amount:'0.03'}]}];
 body.costs=[{component:'base',portionCents:4100}];body.purchasePrices=[{inventoryId:stock.id,unitId:oldStock.unit_id,quantity:'20',totalCents:25000}];
 const saved=f.card.save(body,u,1000);assert.equal(saved.catalog.items[0].name,body.item.name);assert.equal(f.cafe.stock.recipe(body.item.id,'base').ingredients[0].amount,30);
 assert.equal(saved.costs.find(r=>r.itemId===body.item.id&&r.component==='base').portionCents,4100);
 assert.equal(saved.purchasePrices[0].totalCents,25000);assert.deepEqual(f.cafe.stock.inventory.row(stock.id),oldStock);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions').get().n,1);
 assert.equal(f.card.save(body,u,2000).duplicate,true);assert.equal(f.costs.revision(),1);assert.equal(f.card.pricingRevision(),1);
 assert.equal(f.admin.db.prepare("SELECT actor FROM cafe_audit WHERE action='purchase_price'").get().actor,u.id);
 assert.ok(saved.costs.every(r=>Object.keys(r).sort().join(',')==='component,itemId,portionCents'));
 if(role!=='admin'){assert.throws(()=>f.costs.catalog(u),{status:403});assert.throws(()=>f.costs.save({requestId:randomUUID(),revision:1,changes:[]},u),{status:403});}
});

test('Product card: invalid later write rolls back catalog, recipes, costs, price and audit',t=>{
 const f=fixture(t),body=f.draft(),before=f.card.snapshot(f.users.staff),stock=before.stock.inventory[0];
 body.recipes=[{component:'base',revision:f.cafe.stock.recipe(body.item.id,'base')?.revision??-1,ingredients:[{id:stock.id,amount:'1'}]}];body.costs=[{component:'base',portionCents:500}];
 body.purchasePrices=[{inventoryId:stock.id,unitId:-1,quantity:'2',totalCents:100}];
 const audits=f.admin.db.prepare('SELECT count(*) n FROM cafe_audit').get().n;
 assert.throws(()=>f.card.save(body,f.users.staff),{status:409});assert.deepEqual(f.card.snapshot(f.users.staff),before);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_audit').get().n,audits);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_product_card_requests').get().n,0);
});

test('Product card: rejects stale revisions, duplicate components and changed idempotency body/actor',t=>{
 const f=fixture(t),b=f.draft();f.card.save(b,f.users.staff);
 assert.throws(()=>f.card.save({...b,item:{...b.item,name:'Другой'}},f.users.staff),{status:409});assert.throws(()=>f.card.save(b,f.users.waiter),{status:409});
 assert.throws(()=>f.card.save({...b,requestId:randomUUID()},f.users.staff),{status:409});
 const c=f.draft();c.costs=[{component:'base',portionCents:1},{component:'base',portionCents:2}];assert.throws(()=>f.card.save(c,f.users.staff),{status:400});
});

test('Product card: two editors with the same revisions cannot overwrite each other',t=>{
 const f=fixture(t),first=f.draft(),second=f.draft(f.users.waiter);second.item.name='Другой сотрудник';
 f.card.save(first,f.users.staff);assert.throws(()=>f.card.save(second,f.users.waiter),{status:409});assert.equal(f.cafe.catalog().items[0].name,first.item.name);
 const third=f.draft();f.costs.save({requestId:randomUUID(),revision:f.costs.revision(),changes:[{kind:'settings',key:'global',values:{cafeCardBps:100}}]},f.users.admin);
 assert.throws(()=>f.card.save(third,f.users.staff),{status:409});
});

test('Product card: new variant has stable ID, no invented norms or cost, old historical costs retained',t=>{
 const f=fixture(t),b=f.draft(),id=randomUUID();b.item.variants=[{id,name:'Новый чай',priceCents:0,active:true}];
 const result=f.card.save(b,f.users.staff);assert.equal(result.catalog.items[0].variants[0].id,id);
 assert.equal(f.cafe.stock.recipe(b.item.id,'variant:'+id),null);assert.equal(result.costs.find(r=>r.component==='variant:'+id).portionCents,null);
 const next=f.draft();next.item=result.catalog.items[0];next.costs=[{component:'variant:'+id,portionCents:1234}];f.card.save(next,f.users.staff,2000);
 assert.equal(f.costs.reader()('cafe',b.item.id+'|variant:'+id,2000).portionCents,undefined);assert.equal(f.costs.reader()('cafe',b.item.id+'|variant:'+id,2001).portionCents,1234);
});

test('Product card: hidden variants and inactive linked options can be configured before activation',t=>{
 const f=fixture(t),menu=f.cafe.catalog(),group=menu.groups[0],variantId=randomUUID();group.active=false;group.options[0].active=false;f.cafe.saveCatalog(menu,f.users.admin);const body=f.draft();
 body.item.active=false;body.item.variants=[{id:variantId,name:'Будущий вид',priceCents:0,active:false}];body.item.groupIds=[group.id];
 body.costs=[{component:'variant:'+variantId,portionCents:2500},{component:'option:'+group.options[0].id,portionCents:100}];
 const saved=f.card.save(body,f.users.waiter);assert.equal(saved.costs.find(r=>r.component==='variant:'+variantId).portionCents,2500);
 assert.equal(f.cafe.publicMenu().items.some(i=>i.id===body.item.id),false);
});

test('Product card: cannot write global settings, other product costs, arbitrary procurement, or finance fields',t=>{
 const f=fixture(t);for(const change of [b=>{b.costs=[{component:'base',portionCents:10,kind:'settings'}];},b=>{b.settings={};},b=>{b.costs=[{component:'option:not-linked',portionCents:10}];},b=>{const row=f.cafe.stock.inventory.catalog(f.users.staff).items[0];b.purchasePrices=[{inventoryId:row.id,unitId:row.unitId,quantity:'1',totalCents:10}];}]){
  const b=f.draft(),before=f.cafe.catalog().revision;change(b);assert.throws(()=>f.card.save(b,f.users.staff));assert.equal(f.cafe.catalog().revision,before);
 }
 assert.throws(()=>f.card.snapshot(f.users.schedule),{status:403});
});

test('Product card HTTP: working staff access only, Origin, method and malformed body enforced',async t=>{
 const f=fixture(t);let origin;const server=http.createServer(async(req,res)=>{await cafeProductCardHandler(f.card,f.admin,origin)(req,res,new URL(req.url,origin));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=(user='staff',body,extra={})=>fetch(origin+'/api/admin/cafe/product-card',{method:body===undefined?'GET':'POST',headers:{Cookie:'__Host-start_session='+user,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request()).status,200);assert.equal((await request('missing')).status,401);assert.equal((await request('schedule')).status,403);
 assert.equal((await request('staff',f.draft(),{Origin:'https://wrong.invalid'})).status,403);assert.equal((await request('staff',[])).status,400);
 assert.equal((await request('waiter',f.draft(f.users.waiter))).status,200);
});
