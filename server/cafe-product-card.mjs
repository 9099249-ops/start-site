import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {quantity,quantityText} from './inventory.mjs';
import {cafeCostKey} from './operations-analytics-costs.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const editor=u=>{if(!['admin','staff','waiter'].includes(u?.role)||u.scheduleOnly)fail('Войдите в рабочую админку.',403);};
const stable=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(stable(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]))])):value);
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('Неизвестные поля карточки товара.');};
const revision=value=>{if(!Number.isSafeInteger(value)||value<0)fail('Проверьте версию карточки.');};

export class CafeProductCard{
 constructor(cafe,costs){this.cafe=cafe;this.costs=costs;this.db=cafe.db;this.db.exec(readFileSync(new URL('./migrations/cafe-product-card.sql',import.meta.url),'utf8'));}
 pricingRevision(){return this.db.prepare('SELECT coalesce(max(id),0) n FROM cafe_purchase_price_versions').get().n;}
 purchasePrice(inventoryId){const row=this.db.prepare('SELECT * FROM cafe_purchase_price_versions WHERE inventory_id=? ORDER BY id DESC LIMIT 1').get(inventoryId);return row?this.priceInfo(row):null;}
 priceInfo(row){const audit=this.db.prepare("SELECT body FROM cafe_audit WHERE action='purchase_price' AND json_extract(body,'$.priceVersionId')=? ORDER BY id DESC LIMIT 1").get(row.id),source=audit?JSON.parse(audit.body):{};return {inventoryId:row.inventory_id,unitId:row.unit_id,quantity:quantityText(row.quantity_milli),totalCents:row.total_cents,...(source.estimated?{estimated:true}:{}),...(source.sourceUrl?{sourceUrl:source.sourceUrl}:{}),...(source.sourceLabel?{sourceLabel:source.sourceLabel}:{})};}
 snapshot(u){
  editor(u);
  const evaluated=this.costs.definitions(true).filter(r=>r.kind==='cafe').map(r=>({...r,cost:this.costs.currentCafeCost(r.itemId,r.component)}));
  return {catalog:this.cafe.catalog(),stock:this.cafe.stock.config(u),costRevision:this.costs.revision(),
   costs:evaluated.map(r=>({itemId:r.itemId,component:r.component,portionCents:r.cost.portionCents})),
   costSources:evaluated.map(r=>{const cost=r.cost;return {itemId:r.itemId,component:r.component,source:cost.source,...(cost.source==='recipe'?{estimated:cost.estimated,missingPrices:cost.missingPrices,missingNorms:cost.missingNorms}:{})};}),
   pricingRevision:this.pricingRevision(),purchasePrices:this.db.prepare('SELECT p.* FROM cafe_purchase_price_versions p JOIN (SELECT inventory_id,max(id) id FROM cafe_purchase_price_versions GROUP BY inventory_id) last ON p.id=last.id').all().map(p=>this.priceInfo(p))};
 }
 save(body,u,now=Date.now()){
  editor(u);exact(body,['requestId','menuRevision','costRevision','pricingRevision','item','recipes','costs','purchasePrices']);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId||''))fail('Обновите карточку товара.');
  for(const key of ['menuRevision','costRevision','pricingRevision'])revision(body[key]);
  if(!body.item||typeof body.item.id!=='string')fail('Укажите товар.');
  const costRows=body.costs??(body.item.costMode==='recipe'?[]:undefined);
  for(const rows of [body.recipes,costRows,body.purchasePrices])if(!Array.isArray(rows)||rows.length>500)fail('Слишком много изменений в карточке.');
  const fingerprint=createHash('sha256').update(stable(body)).digest('hex');
  return this.cafe.transaction(()=>{
   const previous=this.db.prepare('SELECT * FROM cafe_product_card_requests WHERE request_id=?').get(body.requestId);
   if(previous){if(previous.actor!==u.id||previous.fingerprint!==fingerprint)fail('Ключ сохранения уже использован.',409);return {...this.snapshot(u),duplicate:true};}
   const menu=this.cafe.catalog();
   if(menu.revision!==body.menuRevision||this.costs.revision()!==body.costRevision||this.pricingRevision()!==body.pricingRevision)fail('Настройки уже изменены. Ваш ввод сохранён в окне; загрузите актуальную карточку перед новым сохранением.',409);
   const index=menu.items.findIndex(i=>i.id===body.item.id);
   if(index<0)menu.items.push(body.item);else menu.items[index]=body.item;
   // One outer transaction owns all domain writes; their normal validation and audit remain intact.
   this.cafe.saveCatalog(menu,u,fn=>fn(),false);
   const savedItem=this.cafe.catalog().items.find(i=>i.id===body.item.id),components=new Set(['base',...savedItem.variants.map(v=>'variant:'+v.id),...this.cafe.catalog().groups.filter(g=>savedItem.groupIds.includes(g.id)).flatMap(g=>g.options.map(o=>'option:'+o.id))]);
   const seenRecipes=new Set();
   for(const recipe of body.recipes){
    exact(recipe,['component','revision','ingredients']);
    if(!components.has(recipe.component)||seenRecipes.has(recipe.component))fail('Проверьте варианты расхода.');seenRecipes.add(recipe.component);
    this.cafe.stock.save({...recipe,itemId:savedItem.id},u,null,fn=>fn(),false);
   }
   const seenCosts=new Set(),changes=costRows.map(row=>{
    if(savedItem.costMode==='recipe')fail('Включён расчёт по составу. Ручная себестоимость не применяется.');
    exact(row,['component','portionCents']);
    if(!components.has(row.component)||seenCosts.has(row.component)||!Object.hasOwn(row,'portionCents'))fail('Проверьте себестоимость вариантов.');seenCosts.add(row.component);
    return {kind:'cafe',key:cafeCostKey(savedItem.id,row.component),values:{portionCents:row.portionCents}};
   });
   if(changes.length)this.costs.save({requestId:body.requestId,revision:body.costRevision,changes},u,now,{cafeOnly:true,transaction:fn=>fn()});
   const seenPrices=new Set();
   for(const price of body.purchasePrices){
    if(seenPrices.has(price.inventoryId))fail('Проверьте закупочную цену.');seenPrices.add(price.inventoryId);
    this.writePurchasePrice(price,u,body.requestId,now,savedItem.id);
   }
   this.costs.syncRecipeCosts(u,now,body.requestId);
   this.db.prepare('INSERT INTO cafe_product_card_requests VALUES(?,?,?,?,?)').run(body.requestId,u.id,fingerprint,savedItem.id,now);
   return this.snapshot(u);
  });
 }
 writePurchasePrice(price,u,requestId,now,itemId=null){
  exact(price,['inventoryId','unitId','quantity','totalCents','estimated','sourceUrl','sourceLabel']);
  if(price.estimated!==undefined&&typeof price.estimated!=='boolean')fail('Проверьте источник закупочной цены.');
  if(price.sourceLabel!==undefined&&(typeof price.sourceLabel!=='string'||price.sourceLabel.length>200||/[\x00-\x1f]/.test(price.sourceLabel)))fail('Проверьте название источника цены.');
  if(price.sourceUrl!==undefined){try{const url=new URL(price.sourceUrl);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||price.sourceUrl.length>1000)fail('Проверьте ссылку источника цены.');}catch{fail('Проверьте ссылку источника цены.');}}
  if(price.estimated===true&&(!price.sourceUrl||!price.sourceLabel))fail('Для ориентировочной цены укажите источник.');
  if(!Number.isSafeInteger(price.inventoryId)||!Number.isSafeInteger(price.totalCents)||price.totalCents<0||price.totalCents>100000000)fail('Проверьте закупочную цену.');
  const inventory=this.cafe.stock.inventory.row(price.inventoryId),amount=quantity(price.quantity);
  if(!inventory.active||price.unitId!==inventory.unit_id||!amount)fail('Изменилась единица или позиция склада. Проверьте закупочную цену.',409);
  if(itemId!==null&&!this.db.prepare('SELECT body FROM cafe_recipes WHERE item_id=?').all(itemId).some(r=>JSON.parse(r.body).some(i=>i.id===price.inventoryId)))fail('Закупочная цена должна относиться к составу этого товара.');
  const inserted=this.db.prepare('INSERT INTO cafe_purchase_price_versions(inventory_id,unit_id,quantity_milli,total_cents,actor,request_id,created_at) VALUES(?,?,?,?,?,?,?)').run(price.inventoryId,price.unitId,amount,price.totalCents,u.id,requestId,now);
  this.cafe.audit(u,'purchase_price',{itemId,inventoryId:price.inventoryId,quantityMilli:amount,totalCents:price.totalCents,unitId:price.unitId,priceVersionId:Number(inserted.lastInsertRowid),estimated:price.estimated===true,...(price.sourceUrl?{sourceUrl:price.sourceUrl}:{}),...(price.sourceLabel?{sourceLabel:price.sourceLabel}:{})});
 }
 saveInventoryPrice(body,u,now=Date.now()){
  editor(u);exact(body,['requestId','pricingRevision','inventoryId','unitId','quantity','totalCents','estimated','sourceUrl','sourceLabel']);revision(body.pricingRevision);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId||''))fail('Обновите окно закупочной цены.');
  const fingerprint=createHash('sha256').update(stable({scope:'inventory-price',body})).digest('hex');
  return this.cafe.transaction(()=>{
   const previous=this.db.prepare('SELECT * FROM cafe_product_card_requests WHERE request_id=?').get(body.requestId);
   if(previous){if(previous.actor!==u.id||previous.fingerprint!==fingerprint)fail('Ключ сохранения уже использован.',409);return {pricingRevision:this.pricingRevision(),price:this.purchasePrice(body.inventoryId),duplicate:true};}
   if(body.pricingRevision!==this.pricingRevision())fail('Цены уже изменены. Обновите данные, сохранив введённые значения.',409);
   const {requestId,pricingRevision,...price}=body;this.writePurchasePrice(price,u,requestId,now);
   this.costs.syncRecipeCosts(u,now,requestId);
   this.db.prepare('INSERT INTO cafe_product_card_requests VALUES(?,?,?,?,?)').run(requestId,u.id,fingerprint,'inventory:'+body.inventoryId,now);
   return {pricingRevision:this.pricingRevision(),price:this.purchasePrice(body.inventoryId)};
  });
 }
}

export function cafeProductCardHandler(store,admin,origin){return async(req,res,url)=>{
 const inventoryPrice=url.pathname==='/api/admin/inventory/prices';
 if(url.pathname!=='/api/admin/cafe/product-card'&&!inventoryPrice)return false;
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));return true;};
 try{
  if(!store)fail('Кафе временно недоступно.',503);
  const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-start_session='))?.slice(21),user=admin.user(token);
  if(!user)fail('Войдите в админку.',401);editor(user);
  if(req.method==='GET'&&!inventoryPrice)return reply(200,store.snapshot(user));
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});
  if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))fail('Недопустимый источник запроса.',403);
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>262144)fail('Слишком большой запрос.',413);chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Неверный запрос.');}
  return reply(200,inventoryPrice?store.saveInventoryPrice(body,user):store.save(body,user));
 }catch(error){return reply(error.status||500,{error:error.status?error.message:'Не удалось сохранить карточку товара.'});}
};}
