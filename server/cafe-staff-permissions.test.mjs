import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore,cafeHandler} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {contentHandler} from './content.mjs';
import {inventoryHandler} from './inventory.mjs';

async function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'waiter','waiter','unused')");
 const users={admin:{id:1,role:'admin'},staff:{id:2,role:'staff'},waiter:{id:3,role:'waiter'}};
 admin.user=token=>users[token]||null;
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});
 let origin,uploads=0;
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,origin);if(await cafeHandler(cafe,admin,origin)(req,res,url))return;if(await inventoryHandler(cafe.stock.inventory,admin,origin)(req,res,url))return;if(await contentHandler({upload(){uploads++;return '/media/test.jpg';}},admin,origin,'')(req,res,url))return;res.writeHead(404);res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));admin.close();});
 const request=(route,user='staff',body,extra={})=>fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Cookie:'__Host-start_session='+user,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {admin,cafe,users,origin,request,uploads:()=>uploads};
}

for(const role of ['staff','waiter'])test(`Dish permissions: ${role} edits menu and recipes, adjusts stock, but cannot edit global settings`,async t=>{
 const f=await fixture(t),menu=f.cafe.catalog(),item=menu.items[0];
 item.name='Исправленное блюдо';item.priceCents=32100;item.soldOut=true;item.active=false;item.blockQuickSale=true;
 item.variants=[{id:'staff-variant',name:'Большая порция',priceCents:1000,active:true}];
 menu.categories[0].name='Изменённая категория';menu.groups[0].options[0].name='Изменённая добавка';
 let response=await f.request('/api/admin/cafe/menu',role,menu);assert.equal(response.status,200);
 let saved=await response.json();assert.equal(saved.items[0].priceCents,32100);assert.equal(saved.items[0].variants[0].name,'Большая порция');
 assert.equal(f.admin.db.prepare("SELECT actor FROM cafe_audit WHERE action='catalog' ORDER BY id DESC LIMIT 1").get().actor,f.users[role].id);
 const stock=f.cafe.stock.inventory.catalog(f.users[role]).items[0];
 response=await f.request('/api/admin/inventory/move',role,{id:stock.id,revision:stock.revision,kind:'SET',amount:'10',reason:'Пересчёт',requestId:randomUUID()});assert.equal(response.status,200);
 const recipe={itemId:item.id,component:'variant:staff-variant',revision:-1,ingredients:[{id:stock.id,amount:'1'}]};
 response=await f.request('/api/admin/cafe/stock',role,recipe);assert.equal(response.status,200);
 assert.equal((await response.json()).ingredients[0].amount,1000);
 assert.equal((await f.request('/api/admin/cafe/stock',role)).status,200);
 assert.equal((await f.request('/api/admin/cafe/stock',role,recipe)).status,409);
 saved.settings.enabled=!saved.settings.enabled;
 assert.equal((await f.request('/api/admin/cafe/menu',role,saved)).status,403);
 assert.equal(f.cafe.catalog().settings.enabled,menu.settings.enabled);
 assert.equal((await f.request('/api/admin/cafe/staff',role,{login:'employee',password:'test-only'})).status,403);
 assert.equal((await f.request('/api/admin/cafe/menu',role,menu)).status,409);
 const current=f.cafe.catalog();current.items[0].priceCents=-1;
 assert.equal((await f.request('/api/admin/cafe/menu',role,current)).status,400);
});

test('Dish permissions: photo uploads are allowed for staff and waiter, not CMS content or cross-origin writes',async t=>{
 const f=await fixture(t);
 for(const role of ['staff','waiter']){
  const headers={Cookie:'__Host-start_session='+role,Origin:f.origin,'Content-Type':'image/jpeg'};
  let response=await fetch(f.origin+'/api/admin/content-upload',{method:'POST',headers,body:Buffer.from([255,216,255,217])});assert.equal(response.status,200);
  assert.equal((await response.json()).url,'/media/test.jpg');
  assert.equal((await f.request('/api/admin/content',role)).status,403);
  assert.equal((await f.request('/admin/preview',role)).status,403);
  assert.equal((await f.request('/api/admin/content/publish',role,{})).status,403);
  response=await fetch(f.origin+'/api/admin/content-upload',{method:'POST',headers:{...headers,Origin:'https://wrong.invalid'},body:Buffer.from([255,216,255,217])});assert.equal(response.status,403);
 }
 assert.equal(f.uploads(),2);
 for(const route of ['/api/admin/cafe/menu','/api/admin/cafe/stock','/api/admin/content-upload'])assert.equal((await f.request(route,'missing',{})).status,401);
 const menu=f.cafe.catalog();assert.equal((await f.request('/api/admin/cafe/menu','staff',menu,{Origin:'https://wrong.invalid'})).status,403);
});
