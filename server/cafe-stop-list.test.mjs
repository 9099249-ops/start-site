import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {CafeStopList,cafeStopListHandler} from './cafe-stop-list.mjs';
import {OperationsCosts} from './operations-analytics-costs.mjs';
import {CafeProductCard} from './cafe-product-card.mjs';

const adminUser={id:1,role:'admin',login:'admin'},staff={id:2,role:'staff',login:'staff'};

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'staff','staff','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),stop=new CafeStopList(cafe),inventory=cafe.stock.inventory,costs=new OperationsCosts(admin,cafe);
 new CafeProductCard(cafe,costs);
 t.after(()=>admin.close());
 const row=name=>inventory.catalog(adminUser).items.find(item=>item.name===name);
 const setStock=(item,current)=>inventory.move({id:item.id,revision:inventory.row(item.id).revision,kind:'SET',amount:String(current),reason:'Тестовый пересчёт',requestId:randomUUID()},adminUser).item;
 const saveRecipe=(itemId,component,ingredients)=>cafe.stock.save({itemId,component,revision:cafe.stock.recipe(itemId,component)?.revision??-1,ingredients},adminUser);
 return {admin,cafe,stop,inventory,row,setStock,saveRecipe};
}

test('Stop list includes an item when one active variant is blocked and another remains available',t=>{
 const f=fixture(t),catalog=f.cafe.catalog(),item=catalog.items.find(i=>i.name==='Классический чай'),available=f.row('Кофе'),empty=f.row('Крышки маленькие');
 item.variants=item.variants.slice(0,2);f.cafe.saveCatalog(catalog,adminUser);
 f.setStock(available,2);f.setStock(empty,0);
 f.saveRecipe(item.id,'variant:'+item.variants[0].id,[{id:available.id,amount:'1'}]);
 f.saveRecipe(item.id,'variant:'+item.variants[1].id,[{id:empty.id,amount:'1'}]);
 const stopped=f.stop.read(staff).items.find(row=>row.id===item.id);
 assert.ok(stopped,'partially unavailable item remains visible in the stop list');
 assert.equal(stopped.variants.find(v=>v.id===item.variants[0].id).available,2);
 assert.equal(stopped.variants.find(v=>v.id===item.variants[1].id).available,0);
 assert.ok(stopped.variants.find(v=>v.id===item.variants[1].id).reasons.some(r=>r.code==='STOCK_SHORT'));
});

test('Stop list resume uses catalog revision, writes one audit event, and retries idempotently',t=>{
 const f=fixture(t),catalog=f.cafe.catalog(),item=catalog.items.find(i=>i.name==='Сырники');
 item.soldOut=true;f.cafe.saveCatalog(catalog,adminUser);
 const revision=f.cafe.catalog().revision,body={requestId:randomUUID(),revision,itemId:item.id,action:'resume'};
 const resumed=f.stop.resume(body,staff);
 assert.equal(resumed.items.find(row=>row.id===item.id).canResume,false);
 assert.equal(f.cafe.catalog().items.find(row=>row.id===item.id).soldOut,false);
 assert.equal(f.admin.db.prepare("SELECT count(*) n FROM cafe_audit WHERE action='stop_resume'").get().n,1);
 assert.equal(f.stop.resume(body,staff).duplicate,true);
 assert.equal(f.admin.db.prepare("SELECT count(*) n FROM cafe_audit WHERE action='stop_resume'").get().n,1);
 assert.throws(()=>f.stop.resume({...body,itemId:'different'},staff),e=>e.status===409);
 const stale={...body,requestId:randomUUID(),revision};
 const changed=f.cafe.catalog();changed.items.find(row=>row.id===item.id).name='Сырники обновлённые';f.cafe.saveCatalog(changed,adminUser);
 assert.throws(()=>f.stop.resume(stale,staff),e=>e.status===409);
});

test('Piece normalization creates a separate SKU, preserves archived history, confirms norms, and is idempotent',t=>{
 const f=fixture(t),source=f.row('Стаканы 250 мл'),item=f.cafe.catalog().items.find(i=>i.name==='Сырники');
 f.setStock(source,7000);
 f.admin.db.prepare('INSERT INTO cafe_purchase_price_versions(inventory_id,unit_id,quantity_milli,total_cents,actor,request_id,created_at) VALUES(?,?,?,?,?,?,?)').run(source.id,source.unit_id,1000,5000,adminUser.id,randomUUID(),1);
 f.saveRecipe(item.id,'base',[{id:source.id,amount:'2'}]);
 const body={requestId:randomUUID(),inventoryId:source.id,revision:f.inventory.row(source.id).revision,actualCount:'200',confirmPieceNorms:true};
 const result=f.stop.normalizeUnits(body,adminUser),targetId=result.item.id,archived=f.inventory.row(source.id);
 assert.notEqual(targetId,source.id);
 assert.equal(result.item.unit,'шт.');assert.equal(result.item.current_milli,200000);
 assert.equal(f.inventory.serialize(archived).name,'Стаканы 250 мл (архив: упаковки)');assert.equal(archived.active,0);
 assert.equal(f.inventory.row(targetId).current_milli,200000);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=?').get(targetId).n,0);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=?').get(source.id).n,1);
 assert.deepEqual(f.cafe.stock.recipe(item.id,'base').ingredients,[{id:targetId,unitId:f.inventory.row(targetId).unit_id,amount:2000}]);
 assert.ok(f.inventory.history(new URLSearchParams('item='+source.id),adminUser).items.length>0);
 const audit=JSON.parse(f.admin.db.prepare("SELECT body FROM cafe_audit WHERE action='stock_unit_normalize'").get().body);
 assert.equal(audit.requestId,body.requestId);assert.equal(audit.sourceId,source.id);assert.equal(audit.targetId,targetId);assert.equal(audit.actualCount,'200');assert.equal(audit.confirmedPieceNorms,true);
 assert.equal(f.stop.normalizeUnits(body,adminUser).duplicate,true);
 assert.throws(()=>f.stop.normalizeUnits({...body,actualCount:'201'},adminUser),e=>e.status===409);
 assert.throws(()=>f.stop.normalizeUnits({...body,requestId:randomUUID(),revision:source.revision,confirmPieceNorms:false},adminUser));
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM inventory_items WHERE name=?').get('Стаканы 250 мл').n,1);
});

test('Piece normalization atomically rolls back when a retained recipe cannot be rewritten',t=>{
 const f=fixture(t),source=f.row('Крышки маленькие'),item=f.cafe.catalog().items.find(i=>i.name==='Сырники');
 f.setStock(source,5000);
 f.admin.db.prepare('INSERT INTO cafe_recipes(item_id,component,body,revision) VALUES(?,?,?,0)').run(item.id,'variant:removed',JSON.stringify([{id:source.id,unitId:source.unit_id,amount:1000}]));
 const before={items:f.admin.db.prepare('SELECT * FROM inventory_items').all(),transactions:f.admin.db.prepare('SELECT * FROM inventory_transactions').all(),audit:f.admin.db.prepare('SELECT * FROM cafe_audit').all(),recipe:f.cafe.stock.recipe(item.id,'variant:removed')};
 assert.throws(()=>f.stop.normalizeUnits({requestId:randomUUID(),inventoryId:source.id,revision:f.inventory.row(source.id).revision,actualCount:'80',confirmPieceNorms:true},adminUser));
 assert.deepEqual(f.admin.db.prepare('SELECT * FROM inventory_items').all(),before.items);
 assert.deepEqual(f.admin.db.prepare('SELECT * FROM inventory_transactions').all(),before.transactions);
 assert.deepEqual(f.admin.db.prepare('SELECT * FROM cafe_audit').all(),before.audit);
 assert.deepEqual(f.cafe.stock.recipe(item.id,'variant:removed'),before.recipe);
});

test('Piece normalization blocks active unprepared usage of the old unit',t=>{
 const f=fixture(t),source=f.row('Мешалки');f.setStock(source,9000);
 const now=1000;
 const orderId=Number(f.admin.db.prepare("INSERT INTO cafe_orders(request_id,fingerprint,public_token,source,details,total_cents,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(),'fingerprint','token-unprepared','pos','{}',0,'ACCEPTED',now,now).lastInsertRowid);
 f.admin.db.prepare('INSERT INTO cafe_stock_usage(order_id,item_id,unit_id,amount_milli,created_at) VALUES(?,?,?,?,?)').run(orderId,source.id,source.unit_id,1000,now);
 const body={requestId:randomUUID(),inventoryId:source.id,revision:f.inventory.row(source.id).revision,actualCount:'120',confirmPieceNorms:true};
 const before=f.admin.db.prepare('SELECT * FROM inventory_items WHERE id=?').get(source.id);
 assert.throws(()=>f.stop.normalizeUnits(body,adminUser),e=>e.status===409&&/незавершённые заказы/.test(e.message));
 assert.deepEqual(f.admin.db.prepare('SELECT * FROM inventory_items WHERE id=?').get(source.id),before);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM inventory_items WHERE name=?').get('Мешалки').n,1);
});

test('Stop-list HTTP enforces session, piece-normalization role, Origin, and method',async t=>{
 const f=fixture(t),users={admin:adminUser,staff};f.admin.user=token=>users[token]||null;
 let origin;
 const server=http.createServer(async(req,res)=>{await cafeStopListHandler(f.stop,f.admin,origin)(req,res,new URL(req.url,origin));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 origin='http://127.0.0.1:'+server.address().port;
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=(token,path,method='GET',requestOrigin=origin)=>fetch(origin+path,{method,headers:{Cookie:'__Host-start_session='+token,...(method==='POST'?{Origin:requestOrigin,'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});
 assert.equal((await request('staff','/api/admin/cafe/stop-list')).status,200);
 assert.equal((await request('missing','/api/admin/cafe/stop-list')).status,401);
 assert.equal((await request('staff','/api/admin/cafe/stock-units','POST')).status,403);
 assert.equal((await request('admin','/api/admin/cafe/stop-list','POST','https://wrong.invalid')).status,403);
 assert.equal((await request('staff','/api/admin/cafe/stop-list','PUT')).status,405);
});
