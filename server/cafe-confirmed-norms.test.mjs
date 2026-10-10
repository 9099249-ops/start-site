import test from 'node:test';
import assert from 'node:assert/strict';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsCosts} from './operations-analytics-costs.mjs';
import {CafeProductCard} from './cafe-product-card.mjs';
import {normalizeInventoryName} from './inventory.mjs';
import {applyConfirmedCafeNorms} from './cafe-confirmed-norms.mjs';

const smoothieId='c921e4b0-238e-4ed5-a54b-9851b8f8a217';
const cappVariantId='23a658e0-5b4b-4186-be3a-222abd15babb';
const teaVariantIds=['tea-oolong','tea-forest'];
const skuSpecs=[
 ['cup_250_each','Стаканы 250 мл поштучно','шт',115],['lid_small_each','Крышки маленькие поштучно','шт',118],
 ['stirrer_each','Мешалки поштучно','шт',120],['matte_cup_each','Стаканы матовые поштучно','шт',114],
 ['sugar_stick_each','Сахар в стиках поштучно','шт',31],['napkin_each','Салфетки поштучно','шт',136],
 ['spoon_each','Ложки поштучно','шт',123],['soup_bowl_1l_each','Супница крафт 1 л поштучно','шт',null],
 ['soup_bowl_lid_each','Крышка для супницы 1 л поштучно','шт',null],['pelmeni_wok_tray_each','WOK-контейнеры поштучно','шт',131],
 ['fries_envelope_each','Конверты для картофеля фри поштучно','шт',130]
];
const photoRows=[
 {itemId:'6ad952b5-e214-43ab-98b3-8381ef18a1c0',name:'хот дог',image:'/assets/cafe-ai-hot-dog-v1.png'},
 {itemId:'8461e2b2-2a29-494d-9b2b-7adb83c316a2',name:'Пиво разливное Krone Blanche',image:'/assets/cafe-ai-krone-blanche-v1.png'},
 {itemId:'7a7dd658-9aac-4b8a-a34c-d4db5e5ee2a0',name:'Пиво разливное Helles',image:'/assets/cafe-ai-helles-v1.png'}
];

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'other-admin','admin','unused')");
 const user={id:1,login:'admin',role:'admin'},otherAdmin={id:2,login:'other-admin',role:'admin'};
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),costs=new OperationsCosts(admin,cafe);
 new CafeProductCard(cafe,costs);
 const db=admin.db,template=cafe.catalog(),inventory=makeInventory();let sourceData;
 db.exec('DELETE FROM inventory_transactions; DELETE FROM inventory_items; DELETE FROM inventory_categories; DELETE FROM inventory_units; DELETE FROM cafe_recipes;');
 const units=new Map(inventory.map(i=>[i.unit_id,i.unit]));
 for(const [id,name] of units)db.prepare('INSERT INTO inventory_units(id,name,normalized_name) VALUES(?,?,?)').run(id,name,normalizeInventoryName(name));
 const categories=new Map();
 for(const item of inventory)if(!categories.has(item.category)){const id=categories.size+1;categories.set(item.category,id);db.prepare('INSERT INTO inventory_categories(id,name,normalized_name) VALUES(?,?,?)').run(id,item.category,normalizeInventoryName(item.category));}
 for(const item of inventory)db.prepare('INSERT INTO inventory_items(id,name,normalized_name,category_id,unit_id,current_milli,minimum_milli,target_milli,manual_buy,comment,active,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,\'fixture\',?,?,?)').run(item.id,item.name,normalizeInventoryName(item.name),categories.get(item.category),item.unit_id,item.current_milli,item.minimum_milli,item.target_milli,item.manual_buy,item.active,1000,item.revision);
 const catalog=makeCatalog(template);
 db.prepare('UPDATE cafe_catalog SET body=?,revision=revision+1 WHERE id=1').run(JSON.stringify(catalog));
 const currentCatalog=cafe.catalog();
 const recipes=makeRecipes();
 for(const row of recipes)db.prepare('INSERT INTO cafe_recipes(item_id,component,body,revision) VALUES(?,?,?,?)').run(row.item_id,row.component,JSON.stringify(row.ingredients),row.revision);
 const purchasePrices=[{inventory_id:18,unit_id:6,quantity_milli:1000,total_cents:99999,created_at:1000},{inventory_id:116,unit_id:15,quantity_milli:1000,total_cents:10000,created_at:1001},{inventory_id:159,unit_id:18,quantity_milli:500000,total_cents:35000,created_at:1002}];
 for(const p of purchasePrices)db.prepare('INSERT INTO cafe_purchase_price_versions(inventory_id,unit_id,quantity_milli,total_cents,actor,request_id,created_at) VALUES(?,?,?,?,?,?,?)').run(p.inventory_id,p.unit_id,p.quantity_milli,p.total_cents,user.id,'fixture-'+p.inventory_id,p.created_at);
 sourceData={catalog:currentCatalog,recipes,inventory,purchasePrices};
 const plan={sourceData,existingInventorySkuRefs:[
  {key:'cup_350_each',stockItemId:116,name:'Стаканы 350 мл',unit:'штуки'},
  {key:'lid_large_each',stockItemId:161,name:'Крышки большие',unit:'шт.'},
  {key:'straw_each',stockItemId:158,name:'Трубочки',unit:'шт.'},
  {key:'fork_each',stockItemId:122,name:'Вилки',unit:'штуки'},
  {key:'pizza_box_each',stockItemId:157,name:'Коробки для пиццы',unit:'шт.'},
  {key:'parchment_cm',stockItemId:132,name:'Пергамент',unit:'см'}
 ],newInventorySkus:skuSpecs.map(([key,name,unit,preserveExistingPackSkuId])=>({key,name,unit,currentQuantity:null,minimumQuantity:null,targetQuantity:null,preserveExistingPackSkuId})),recipePlan:{classicTea:{itemId:'item-22',activeVariants:teaVariantIds.map((variantId,i)=>({variantId,name:['Женьшень улун','Таежный'][i]}))},pizzas:{itemIds:['item-11','item-12','item-13','item-14','item-15','item-16','cf0ee9f8-d4dc-4606-883e-cfdc7861e8f1']}},photos:photoRows};
 const quotes={items:[
  {key:'wokTray',unit:'piece',quantity:1,totalCents:637,estimated:true,requiresConfirmation:true,sourceLabel:'600 ml WOK example',sourceUrl:'https://example.test/wok',quotedProductSpecifications:'600 ml kraft WOK container'},
  {key:'pizzaBox',unit:'piece',quantity:1,totalCents:2474,estimated:true,requiresConfirmation:true,sourceLabel:'400 mm pizza box',sourceUrl:'https://example.test/pizza',quotedProductSpecifications:'400x400x40 mm box'}
 ]};
 t.after(()=>admin.close());
 return {admin,cafe,costs,user,otherAdmin,plan,quotes};
}

function makeCatalog(original){
 const ids=['item-1','item-2','item-3','item-4','item-5','item-6','item-7','item-8','item-9','item-10','item-11','item-12','item-13','item-14','item-15','item-16','item-17','item-18','item-19','item-20','item-21','item-22','item-23','item-24','item-26','item-27','item-28','item-29','item-30','item-32','item-33','item-37','80167a50-5b5e-4afc-bbf8-945e4fd4ae52','cf0ee9f8-d4dc-4606-883e-cfdc7861e8f1',...photoRows.map(p=>p.itemId)];
 const names=new Map([['item-1','Сырники'],['item-17','Пельмени говяжьи'],['item-18','Картошка фри'],['item-19','Стрипсы'],['item-20','Сырные палочки'],['item-21','Креветки фри'],['item-22','Классический чай'],['item-23','Травяной и ягодный чай'],['item-24','Чайный набор «У самовара»'],['item-26','Американо'],['item-27','Капучино'],['item-28','Латте'],['item-29','Флэт уайт'],['item-30','Мокачино'],['item-32','Какао'],['item-33','Смузи'],['item-37','Квас разливной'],['80167a50-5b5e-4afc-bbf8-945e4fd4ae52','фреш апельсиновый']]);
 const itemTemplate=original.items[0];
 const items=ids.map((id,index)=>{const photo=photoRows.find(p=>p.itemId===id),item=structuredClone(itemTemplate);item.id=id;item.categoryId=original.categories[index%original.categories.length].id;item.name=photo?.name||names.get(id)||`Fixture ${id}`;item.image=photo?'':item.image;item.active=true;item.soldOut=false;item.priceCents=40000;item.sort=index+1;item.groupIds=[];item.variants=[];item.missingRecipeNorms=undefined;return item;});
 items.find(i=>i.id==='item-1').groupIds=['syrniki_toppings'];
 items.find(i=>i.id==='item-17').groupIds=['coffee_sugar'];
 for(const id of ['item-18','item-19','item-20','item-21'])items.find(i=>i.id===id).groupIds=['sauces'];
 items.find(i=>i.id==='item-22').groupIds=['coffee_sugar'];
 items.find(i=>i.id==='item-22').variants=[...teaVariantIds.map((id,index)=>({id,name:['Женьшень улун','Таежный'][index],priceCents:1000+index,active:true,useBaseRecipe:true})),{id:'tea-inactive',name:'Inactive tea',priceCents:500,active:false,useBaseRecipe:true}];
 items.find(i=>i.id==='item-27').variants=[{id:cappVariantId,name:'Большой',priceCents:2500,active:true,useBaseRecipe:false}];
 items.find(i=>i.id==='item-33').variants=[{id:'v-0',name:'Клубника-Банан',priceCents:0,active:true},{id:'v-1',name:'Облепиха-Банан',priceCents:0,active:true}];
 const groups=structuredClone(original.groups),sauceGroup=groups.find(g=>g.id==='sauces');sauceGroup.options[3]={...sauceGroup.options[3],name:'Сметана'};sauceGroup.options.push({id:'sauces-mustard-fixture',name:'Горчица',priceCents:6000,active:true,soldOut:false},{id:'mayoUUID',name:'Майонез',priceCents:8000,active:true,soldOut:false});sauceGroup.options.find(o=>o.name==='BBQ').active=false;sauceGroup.options.find(o=>o.name==='BBQ').soldOut=true;sauceGroup.options.find(o=>o.name==='BBQ').priceCents=1234;
 return {...original,categories:original.categories.map(c=>({...c,active:true})),groups,items};
}

function makeInventory(){
 const rows=[],unitIds={'кеги':2,'шт.':1,'кг':6,'л':8,'упаковки':4,'упаковка':4,'штуки':15,'см':17,'г':18};
 const add=(id,name,unit,category='Test stock',minimum_milli=null,target_milli=null,manual_buy=0)=>rows.push({id,name,unit,unit_id:unitIds[unit],category,current_milli:40000+id,minimum_milli,target_milli,manual_buy,active:1,revision:1});
 for(const [id,name,unit,category,minimum,target,manual] of [[1,'Разливное пиво / кега','кеги','Напитки',50000,100000,0],[14,'Квас разливной','л','Холодные напитки'],[18,'Кофе','кг','Кофе',10000,60000,1],[19,'Какао','кг','Кофе'],[20,'Молоко обычное','л','Кофе'],[27,'Чай в стиках','упаковки','Кофе'],[29,'Чай травяной','упаковки','Кофе'],[31,'Сахар в стиках','упаковки','Кофе'],[41,'Бананы','кг','Фрукты'],[42,'Апельсины','кг','Фрукты'],[45,'Клубника свежая','кг','Фрукты'],[46,'Клубника замороженная','кг','Фрукты'],[48,'Облепиха','кг','Фрукты'],[49,'Soup ingredient 49','шт.','Супы'],[50,'Soup ingredient 50','шт.','Супы'],[51,'Soup ingredient 51','шт.','Супы'],[52,'Soup ingredient 52','шт.','Супы'],[53,'Soup ingredient 53','шт.','Супы'],[54,'Soup ingredient 54','шт.','Супы'],[55,'Soup ingredient 55','шт.','Супы'],[56,'Soup ingredient 56','шт.','Супы'],[57,'Soup ingredient 57','шт.','Супы'],[58,'Pizza ingredient 58','шт.','Пицца'],[59,'Pizza ingredient 59','шт.','Пицца'],[60,'Pizza ingredient 60','шт.','Пицца'],[61,'Pizza ingredient 61','шт.','Пицца'],[62,'Pizza ingredient 62','шт.','Пицца'],[63,'Pizza ingredient 63','шт.','Пицца'],[64,'Пельмени','кг','Горячая кухня'],[65,'Картофель фри','кг','Горячая кухня'],[66,'Сырные палочки','кг','Горячая кухня'],[67,'Стрипсы','кг','Горячая кухня'],[68,'Креветки','кг','Горячая кухня'],[69,'Сырники','кг','Горячая кухня'],[70,'Булка для французского хот-дога','упаковка','Горячая кухня'],[71,'Сосиски для хот-дога','упаковка','Горячая кухня'],[73,'Кетчуп','упаковки','Соусы'],[74,'Сырный соус','упаковки','Соусы'],[75,'Горчица','упаковки','Соусы'],[114,'Стаканы матовые 500 мл','шт.','Стаканы и крышки'],[116,'Стаканы 350 мл','штуки','Стаканы и крышки'],[117,'Стаканы для пива 500 мл','штуки','Стаканы и крышки'],[121,'Соусники','упаковки','Одноразовая посуда'],[122,'Вилки','штуки','Одноразовая посуда'],[129,'Конверты для хот-дога','упаковки','Упаковка'],[132,'Пергамент','см','Упаковка'],[136,'Салфетки','упаковки','Одноразовая посуда'],[151,'Груша горгонзола','шт.','Пицца'],[157,'Коробки для пиццы','шт.','Упаковка'],[158,'Трубочки','шт.','Стаканы и крышки'],[159,'Чай листовой — Женьшень улун','г','Кофе, чай и молоко'],[160,'Коробка для сырников','шт.','Упаковка'],[161,'Крышки большие','шт.','Стаканы и крышки']])add(id,name,unit,category,minimum,target,manual);
 rows.find(item=>item.id===114).active=0;
 return rows;
}

function makeRecipes(){
 const rows=[],add=(item,component,ingredients,revision=0)=>rows.push({item_id:item,component,ingredients,revision});
 const i=(id,amount)=>({id,unitId:{14:8,18:6,19:6,20:8,41:6,46:6,48:6,49:1,50:1,51:1,52:1,53:1,54:1,55:1,56:1,57:1,58:1,59:1,60:1,61:1,62:1,63:1,64:6,65:6,66:6,67:6,68:6,69:6,70:4,71:4,73:4,74:4,75:4,121:4,129:4,132:17,136:4,151:1}[id]||15,amount});
 add('item-1','base',[i(69,250),i(122,1000),i(160,1000),i(136,1000)]);
 for(const [id,food] of [['item-2',54],['item-3',53],['item-4',55],['item-5',56],['item-6',49],['item-7',50],['item-8',51],['item-9',52],['item-10',57]])add(id,'base',[i(food,1000),i(122,1000)]);
 for(const [id,food] of [['item-11',59],['item-12',60],['item-13',61],['item-14',58],['item-15',62],['item-16',63]])add(id,'base',[i(food,1000),i(132,30000)]);
 add('cf0ee9f8-d4dc-4606-883e-cfdc7861e8f1','base',[i(151,1000),i(132,30000)]);
 add('item-17','base',[i(64,300),i(122,1000)]);add('item-18','base',[i(65,230),i(122,1000)]);
 add('item-19','base',[i(67,380),i(65,10),i(74,1000),i(122,1000)]);add('item-20','base',[i(66,250),i(74,1000),i(122,1000)]);add('item-21','base',[i(68,400),i(74,1000),i(122,1000)]);
 for(const item of ['item-19','item-20','item-21']){add(item,'option:sauces-0',[i(73,1000)]);add(item,'option:sauces-1',[i(74,1000)]);}
 add('6ad952b5-e214-43ab-98b3-8381ef18a1c0','base',[i(70,1000),i(71,1000),i(74,1000),i(73,1000),i(75,1000),i(129,1000),i(136,1000),i(121,1000)]);
 add('8461e2b2-2a29-494d-9b2b-7adb83c316a2','base',[i(1,50000),i(117,1000)]);add('7a7dd658-9aac-4b8a-a34c-d4db5e5ee2a0','base',[i(1,50000),i(117,1000)]);
 add('item-22','variant:'+teaVariantIds[0],[i(27,1000)]);add('item-22','variant:'+teaVariantIds[1],[i(29,1000)]);add('item-22','variant:tea-inactive',[i(27,1000)]);
 add('item-26','base',[i(18,70),i(116,1000)]);
 for(const id of ['item-27','item-28','item-29','item-30'])add(id,'base',[i(18,70),i(20,250),i(116,1000),i(161,1000)]);
 add('item-32','base',[i(20,250),i(19,20),i(116,1000)]);
 add('item-33','variant:v-0',[i(41,150),i(46,150),i(20,200),i(116,1000),i(161,1000)]);
 add('item-33','variant:v-1',[i(41,150),i(48,150),i(20,200),i(116,1000),i(161,1000)]);
 add('80167a50-5b5e-4afc-bbf8-945e4fd4ae52','base',[i(42,500),i(116,1000)]);
 add('item-37','base',[i(14,500),i(117,1000)]);
 return rows;
}

test('confirmed norms preserve stock/prices and write exact coffee, tea, packaging, visibility, and photo norms',t=>{
 const f=fixture(t),beforeStock=new Map(f.admin.db.prepare('SELECT id,current_milli,unit_id,active,manual_buy,minimum_milli,target_milli,comment FROM inventory_items').all().map(row=>[row.id,row]));
 const beforePrices=new Map(f.cafe.catalog().items.map(i=>[i.id,{price:i.priceCents,soldOut:i.soldOut,variants:i.variants.map(v=>[v.id,v.priceCents])}]));
 f.quotes.items.push({inventoryId:151,unit:'шт.',quantity:1,totalCents:321,estimated:true,sourceLabel:'Food supplier quote',sourceUrl:'https://example.test/food'});
 f.quotes.items.push({key:'ownerOranges',inventoryId:42,unitId:6,quantity:1,totalCents:20000,estimated:false,sourceLabel:'Данные владельца: апельсины 200 ₽/кг'});
 f.quotes.items.push({key:'leafTeaCommon',unit:'г',quantity:500,totalCents:30000,estimated:false,sourceLabel:'Цена владельца: 300 ₽ за 500 г'});
 f.quotes.items.push(...[
  {key:'frenchHotdogBaguette',unit:'piece',quantity:40,totalCents:55600,estimated:true,sourceLabel:'Baguette 40 pieces',sourceUrl:'https://example.test/baguette'},
  {key:'hotdogSausageExample',unit:'piece',quantity:20,totalCents:10000,estimated:true,sourceLabel:'Confirmed supplier sausage test fixture',sourceUrl:'https://food-market.pro/catalog/hot_dogs/00002019/'},
  {key:'hotdogCheeseSauce',unit:'ml',quantity:4500,totalCents:216160,estimated:true,sourceLabel:'Cheese sauce case',sourceUrl:'https://example.test/cheese-sauce'},
  {key:'hotdogKetchup',unit:'ml',quantity:5280,totalCents:174240,estimated:true,sourceLabel:'Ketchup case',sourceUrl:'https://example.test/ketchup'},
  {key:'hotdogMustard',unit:'ml',quantity:5400,totalCents:188940,estimated:true,sourceLabel:'Mustard case',sourceUrl:'https://example.test/mustard'},
  {key:'hotdogKraftEnvelope',unit:'piece',quantity:2500,totalCents:272130,estimated:true,sourceLabel:'Envelope case',sourceUrl:'https://example.test/envelope'},
  {key:'hotdogNapkin',unit:'piece',quantity:1800,totalCents:241510,estimated:true,sourceLabel:'Do not duplicate shared napkin quote',sourceUrl:'https://example.test/napkin'},
  {key:'syrnikiThreePiece',unit:'piece',quantity:82,totalCents:293720,estimated:true,sourceLabel:'Syrniki case',sourceUrl:'https://example.test/syrniki'},
  {key:'chickenStrips300g',unit:'g',quantity:5000,totalCents:250340,estimated:true,sourceLabel:'Strips 5 kg',sourceUrl:'https://example.test/strips'},
  {key:'mozzarellaSticks300g',unit:'g',quantity:5000,totalCents:364180,estimated:true,sourceLabel:'Sticks 5 kg',sourceUrl:'https://example.test/sticks'},
  {key:'breadedShrimp300g',unit:'g',quantity:4000,totalCents:509830,estimated:true,sourceLabel:'Shrimp 4 kg',sourceUrl:'https://example.test/shrimp'},
  {key:'syrnikiKraftTrayExample',unit:'piece',quantity:800,totalCents:492980,estimated:true,sourceLabel:'Confirmed fit test fixture',sourceUrl:'https://example.test/tray'}
 ]);
 const result=applyConfirmedCafeNorms(f.cafe,f.costs,f.plan,f.quotes,f.user,{now:2000,requestId:'confirmed-norms-test-20261007',clarifications:{inventoryTargets:{beerKegs:4,coffeeKg:10,beerLitresPerKeg:30}}});
 assert.ok(result.savedRecipes>=37);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=157').get().n,0);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=151').get().n,1);
 const orangeRecipe=f.cafe.stock.recipe('80167a50-5b5e-4afc-bbf8-945e4fd4ae52','base').ingredients,orangeCup=f.admin.db.prepare('SELECT id FROM inventory_items WHERE name=?').get('Стаканы матовые поштучно').id;assert.ok(orangeRecipe.some(x=>x.id===42&&x.amount===250));assert.equal(orangeRecipe.filter(x=>x.id===orangeCup).length,1);assert.ok(orangeRecipe.some(x=>x.id===161));assert.ok(orangeRecipe.some(x=>x.id===158));const orangePrice=f.admin.db.prepare('SELECT quantity_milli,total_cents FROM cafe_purchase_price_versions WHERE inventory_id=42 ORDER BY id DESC LIMIT 1').get();assert.equal(orangePrice.quantity_milli,1000);assert.equal(orangePrice.total_cents,20000);assert.equal(20000*250/1000,5000);
 for(const [id,old] of beforeStock){const after=f.admin.db.prepare('SELECT * FROM inventory_items WHERE id=?').get(id);for(const key of ['current_milli','unit_id','active','manual_buy','comment'])assert.equal(after[key],old[key],`${id}:${key}`);}
 const beer=f.admin.db.prepare('SELECT current_milli,minimum_milli,target_milli,manual_buy FROM inventory_items WHERE id=1').get(),coffee=f.admin.db.prepare('SELECT current_milli,minimum_milli,target_milli,manual_buy FROM inventory_items WHERE id=18').get();assert.equal(beer.current_milli,40001);assert.equal(beer.minimum_milli,2000);assert.equal(beer.target_milli,4000);assert.equal(beer.manual_buy,0);assert.equal(coffee.current_milli,40018);assert.equal(coffee.minimum_milli,1667);assert.equal(coffee.target_milli,10000);assert.equal(coffee.manual_buy,1);
 const stockEdits=f.admin.db.prepare('SELECT kind,before_json,after_json FROM inventory_transactions WHERE item_id IN(1,18) ORDER BY id').all();assert.equal(stockEdits.length,2);for(const edit of stockEdits){assert.equal(edit.kind,'EDIT');assert.equal(JSON.parse(edit.before_json).current_milli,JSON.parse(edit.after_json).current_milli);}
 const rows=(item,component='base')=>f.cafe.stock.recipe(item,component).ingredients;
 const sku=name=>f.admin.db.prepare('SELECT id,current_milli,minimum_milli,target_milli FROM inventory_items WHERE name=?').get(name);
 const recipeById=item=>rows(item).map(x=>[x.id,x.amount]);
 const syrniki=recipeById('item-1');assert.deepEqual(syrniki.filter(([id])=>id===sku('Сырники поштучно').id).map(([,amount])=>amount),[3000]);assert.ok(syrniki.some(([id,amount])=>id===160&&amount===1000));assert.equal(syrniki.some(([id])=>[69,122,136].includes(id)),false);
 const hotdog=recipeById('6ad952b5-e214-43ab-98b3-8381ef18a1c0');for(const [name,amount] of [['Булка для хот-дога поштучно',1000],['Сосиска поштучно',1000],['Сырный соус, мл',20000],['Кетчуп, мл',20000],['Горчица, мл',20000],['Конверт для хот-дога поштучно',1000],['Салфетки поштучно',3000]])assert.ok(hotdog.some(([id,q])=>id===sku(name).id&&q===amount),name);assert.equal(hotdog.some(([id])=>[70,71,73,74,75,121,129,136].includes(id)),false);
 for(const [item,foodId,oldAmount] of [['item-19',67,380],['item-20',66,250],['item-21',68,400]]){const recipe=recipeById(item);assert.ok(recipe.some(([id,amount])=>id===foodId&&amount===300));assert.ok(recipe.some(([id,amount])=>id===sku('Сырный соус, мл').id&&amount===20000));assert.ok(recipe.some(([id,amount])=>id===160&&amount===1000));assert.equal(recipe.some(([id])=>[74,122].includes(id)),false);}
 for(const item of ['item-19','item-20','item-21']){assert.deepEqual(f.cafe.stock.recipe(item,'option:sauces-0').ingredients.map(x=>[x.id,x.amount]),[[73,1000]]);assert.deepEqual(f.cafe.stock.recipe(item,'option:sauces-1').ingredients.map(x=>[x.id,x.amount]),[[74,1000]]);}
 const savedCatalog=f.cafe.catalog(),sourceSauces=f.plan.sourceData.catalog.groups.find(g=>g.id==='sauces'),snackSauces=savedCatalog.groups.find(g=>g.id==='snack-sauce-choice');assert.ok(snackSauces);assert.equal(snackSauces.options.length,3);assert.equal(snackSauces.min,0);assert.equal(snackSauces.max,1);assert.equal(snackSauces.name,sourceSauces.name);assert.equal(snackSauces.active,sourceSauces.active);assert.deepEqual(savedCatalog.groups.find(g=>g.id==='sauces'),sourceSauces);
 for(const after of snackSauces.options){const before=sourceSauces.options.find(o=>o.id===after.id.replace('snack-sauce-choice-',''));assert.ok(before);for(const key of ['name','priceCents','active','soldOut'])assert.equal(after[key],before[key]);}
 for(const itemId of ['item-19','item-20','item-21'])assert.deepEqual(savedCatalog.items.find(i=>i.id===itemId).groupIds,['snack-sauce-choice']);assert.deepEqual(savedCatalog.items.find(i=>i.id==='item-18').groupIds,['sauces']);assert.deepEqual(savedCatalog.items.find(i=>i.id==='item-1').groupIds,['syrniki_toppings']);assert.deepEqual(savedCatalog.items.find(i=>i.id==='item-22').groupIds,['coffee_sugar']);assert.deepEqual(savedCatalog.items.find(i=>i.id==='item-17').groupIds,['coffee_sugar','sauces']);
 const snackOption=(name)=>snackSauces.options.find(o=>o.name===name),optionRows=(itemId,option)=>f.cafe.stock.recipe(itemId,'option:'+option.id)?.ingredients;
 const cheeseStockId=sku('Сырный соус, мл').id,ketchupStockId=sku('Кетчуп, мл').id,mustardStockId=sku('Горчица, мл').id;
 for(const itemId of ['item-19','item-20','item-21']){
  const base=f.cafe.stock.requirements({itemId,name:itemId,modifiers:[]}),cheese=f.cafe.stock.requirements({itemId,name:itemId,modifiers:[{optionId:snackOption('Сырный соус').id}]}),ketchup=f.cafe.stock.requirements({itemId,name:itemId,modifiers:[{optionId:snackOption('Кетчуп').id}]}),mustard=f.cafe.stock.requirements({itemId,name:itemId,modifiers:[{optionId:snackOption('Горчица').id}]});
  for(const requirements of [base,cheese])assert.ok(requirements.some(x=>x.id===cheeseStockId&&x.amount===20000));
  assert.deepEqual(optionRows(itemId,snackOption('Сырный соус')),[]);
  for(const [requirements,replacementId] of [[ketchup,ketchupStockId],[mustard,mustardStockId]]){assert.equal(requirements.some(x=>x.id===cheeseStockId),false);assert.ok(requirements.some(x=>x.id===replacementId&&x.amount===20000));}
  assert.equal(snackSauces.options.some(o=>/сметан|майонез/i.test(o.name)),false);
 }
 assert.deepEqual(result.pending.snackSauceOptionsWithoutNorms,[]);
 const pelmeniSauceOptions=sourceSauces.options.filter(o=>/сметан|майонез/i.test(o.name));assert.deepEqual(pelmeniSauceOptions.map(o=>o.id),['sauces-3','mayoUUID']);assert.deepEqual(result.pending.pelmeniSaucePricesUnknown.map(x=>x.unit),['мл','мл']);
 for(const option of pelmeniSauceOptions){const recipe=f.cafe.stock.recipe('item-17','option:'+option.id),expectedName=/сметан/i.test(option.name)?'Сметана, мл':'Майонез, мл',id=sku(expectedName).id;assert.equal(recipe.ingredients.length,1);assert.equal(recipe.ingredients[0].id,id);assert.equal(recipe.ingredients[0].amount,20000);assert.equal(recipe.ingredients[0].replacesId,undefined);assert.equal(sku(expectedName).current_milli,null);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=?').get(id).n,0);}
 for(const option of pelmeniSauceOptions){const addition=f.cafe.stock.requirements({itemId:'item-17',name:'Пельмени',modifiers:[{optionId:option.id}]}).at(-1);assert.equal(addition.amount,20000);assert.equal(addition.replacesId,undefined);}
 assert.ok(recipeById('item-19').some(([id,amount])=>id===65&&amount===10));
 assert.equal(sku('Сырный соус, мл').current_milli,null);assert.deepEqual(result.pending.quoteConfirmations.sort(),['pizzaBox','wokTray'].sort());
 for(const [key,name,unit,total] of [['frenchHotdogBaguette','Булка для хот-дога поштучно',40000,55600],['hotdogSausageExample','Сосиска поштучно',20000,10000],['hotdogCheeseSauce','Сырный соус, мл',4500000,216160],['hotdogKetchup','Кетчуп, мл',5280000,174240],['hotdogMustard','Горчица, мл',5400000,188940],['hotdogKraftEnvelope','Конверт для хот-дога поштучно',2500000,272130],['syrnikiThreePiece','Сырники поштучно',82000,293720],['syrnikiKraftTrayExample','Коробка для сырников',800000,492980],['chickenStrips300g','Стрипсы',5000,250340],['mozzarellaSticks300g','Сырные палочки',5000,364180],['breadedShrimp300g','Креветки',4000,509830]]){const id=sku(name).id,price=f.admin.db.prepare('SELECT quantity_milli,total_cents FROM cafe_purchase_price_versions WHERE inventory_id=? ORDER BY id DESC LIMIT 1').get(id);assert.equal(price.quantity_milli,unit,`${key}: native-unit conversion`);assert.equal(price.total_cents,total,key);}
 const traySku=160,napkinSku=136;assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=?').get(napkinSku).n,0);assert.equal(f.admin.db.prepare("SELECT count(*) n FROM inventory_items WHERE normalized_name='коробка для сырников'").get().n,1);
 for(const [beerId,key] of [['8461e2b2-2a29-494d-9b2b-7adb83c316a2','Пиво разливное Krone Blanche, л'],['7a7dd658-9aac-4b8a-a34c-d4db5e5ee2a0','Пиво разливное Helles, л']]){const stock=sku(key),recipe=recipeById(beerId);assert.equal(stock.current_milli,null);assert.ok(recipe.some(([id,amount])=>id===stock.id&&amount===500));assert.ok(recipe.some(([id])=>id===117));assert.equal(recipe.some(([id])=>id===1),false);const price=f.admin.db.prepare('SELECT quantity_milli,total_cents FROM cafe_purchase_price_versions WHERE inventory_id=? ORDER BY id DESC LIMIT 1').get(stock.id);assert.equal(price.quantity_milli,30000);assert.equal(price.total_cents,500000);}
 for(const item of f.cafe.catalog().items){if(!item.restricted&&!['hookah','tea_hookah'].includes(item.station))assert.equal(item.costMode,'recipe',item.id);}
 for(const id of ['item-27','item-28','item-29','item-30']){const ingredients=rows(id),lookup=name=>f.admin.db.prepare('SELECT id FROM inventory_items WHERE name=?').get(name)?.id;const cup=id==='item-27'||id==='item-28'?116:lookup('Стаканы 250 мл поштучно'),lid=id==='item-27'||id==='item-28'?161:lookup('Крышки маленькие поштучно');assert.equal(ingredients.filter(x=>x.id===cup).length,1);assert.equal(ingredients.filter(x=>x.id===lid).length,1);assert.equal(ingredients.filter(x=>x.id===lookup('Мешалки поштучно')).length,1);assert.ok(ingredients.some(x=>x.id===18&&x.amount===70));assert.ok(ingredients.some(x=>x.id===20&&x.amount===250));}
 assert.ok(rows('item-17').some(x=>x.id===122&&x.amount===1000));
 assert.equal(rows('item-18').some(x=>x.id===122),false);
 for(const item of ['item-11','item-12','item-13','item-14','item-15','item-16'])assert.ok(rows(item).some(x=>x.id===132&&x.amount===30000));
 const tea=rows('item-22','variant:'+teaVariantIds[0]);assert.ok(tea.some(x=>x.amount===20000&&f.admin.db.prepare('SELECT name FROM inventory_items WHERE id=?').get(x.id).name==='Чай листовой — Женьшень улун'));assert.ok(tea.some(x=>x.amount===2000&&f.admin.db.prepare('SELECT name FROM inventory_items WHERE id=?').get(x.id).name==='Сахар в стиках поштучно'));
 for(const id of teaVariantIds)assert.equal(f.cafe.catalog().items.find(i=>i.id==='item-22').variants.find(v=>v.id===id).useBaseRecipe,false);
 for(const name of ['Женьшень улун','Таежный']){const leafId=f.admin.db.prepare('SELECT id FROM inventory_items WHERE name=?').get(`Чай листовой — ${name}`).id,price=f.admin.db.prepare('SELECT id,quantity_milli,total_cents FROM cafe_purchase_price_versions WHERE inventory_id=? ORDER BY id DESC LIMIT 1').get(leafId),audit=JSON.parse(f.admin.db.prepare("SELECT body FROM cafe_audit WHERE action='purchase_price' AND json_extract(body,'$.priceVersionId')=?").get(price.id).body);assert.equal(price.quantity_milli,500000);assert.equal(price.total_cents,30000);assert.equal(30000*20000/500000,1200);assert.equal(audit.estimated,false);assert.equal(audit.sourceLabel,'Цена владельца: 300 ₽ за 500 г');assert.equal(audit.sourceUrl,undefined);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=?').get(leafId).n,name==='Женьшень улун'?2:1);}
 assert.deepEqual(rows('item-22','variant:tea-inactive'),[{id:27,unitId:15,amount:1000}]);
 const smoothie=f.cafe.catalog().items.find(i=>i.id==='item-33');assert.deepEqual(smoothie.variants.map(v=>v.id),['v-0','v-1',smoothieId]);assert.equal(smoothie.variants[2].active,false);assert.equal(f.cafe.stock.recipe('item-33','variant:'+smoothieId),null);
 const matteCupId=f.admin.db.prepare('SELECT id FROM inventory_items WHERE name=?').get('Стаканы матовые поштучно').id;
 for(const id of ['v-0','v-1']){const ingredients=rows('item-33','variant:'+id),stockName=x=>f.admin.db.prepare('SELECT name FROM inventory_items WHERE id=?').get(x.id).name;assert.equal(ingredients.some(x=>x.id===20),false);assert.equal(ingredients.some(x=>x.id===114||x.id===117),false);assert.equal(ingredients.filter(x=>x.id===matteCupId).length,1);for(const name of ['Крышки большие','Трубочки'])assert.equal(ingredients.filter(x=>stockName(x)===name).length,1);}
 assert.equal(f.cafe.catalog().items.find(i=>i.id==='item-23').active,false);assert.equal(f.cafe.catalog().items.find(i=>i.id==='item-24').active,false);
 for(const photo of photoRows)assert.equal(f.cafe.catalog().items.find(i=>i.id===photo.itemId).image,photo.image);
 for(const item of f.cafe.catalog().items){const old=beforePrices.get(item.id);if(old){assert.equal(item.priceCents,old.price);assert.equal(item.soldOut,old.soldOut);for(const [id,price] of old.variants)assert.equal(item.variants.find(v=>v.id===id)?.priceCents,price);}}
});

test('confirmed smoothie weights preserve both existing recipes and activate third flavor without milk or duplicate packaging',t=>{
 const f=fixture(t),result=applyConfirmedCafeNorms(f.cafe,f.costs,f.plan,f.quotes,f.user,{now:2000,requestId:'confirmed-norms-smoothies-20261007',clarifications:{smoothie:{seaBuckthornGrams:100,strawberryGrams:100,bananaGrams:100}}});
 assert.equal(result.pending.smoothieWeights,false);
 const items=f.cafe.catalog().items.find(item=>item.id==='item-33'),stockName=id=>f.admin.db.prepare('SELECT name FROM inventory_items WHERE id=?').get(id).name;
 for(const [variant,fruitIds,amount] of [['v-0',[41,46],150],['v-1',[41,48],150],[smoothieId,[48,46,41],100]]){
  const recipe=f.cafe.stock.recipe('item-33','variant:'+variant).ingredients;
  for(const id of fruitIds)assert.ok(recipe.some(x=>x.id===id&&x.amount===amount),`${variant}:${id}`);
  assert.equal(recipe.some(x=>/молок/i.test(stockName(x.id))),false);
  for(const name of ['Стаканы матовые поштучно','Крышки большие','Трубочки'])assert.equal(recipe.filter(x=>stockName(x.id)===name).length,1,`${variant}:${name}`);
 }
 assert.equal(items.variants.find(v=>v.id===smoothieId).active,true);
});

test('root retry is actor-bound, idempotent, and conflicting reuse rolls back',t=>{
 const f=fixture(t),args=[f.cafe,f.costs,f.plan,f.quotes,f.user,{now:2000,requestId:'confirmed-norms-retry-20261007'}];
 const first=applyConfirmedCafeNorms(...args),count=f.admin.db.prepare('SELECT count(*) n FROM inventory_items').get().n;
 assert.equal(applyConfirmedCafeNorms(...args).duplicate,true);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM inventory_items').get().n,count);
 assert.throws(()=>applyConfirmedCafeNorms(f.cafe,f.costs,f.plan,{items:[{key:'other'}]},f.user,args[5]),/Root requestId already used/);
 assert.throws(()=>applyConfirmedCafeNorms(f.cafe,f.costs,f.plan,f.quotes,f.otherAdmin,args[5]),/Root requestId already used/);
 assert.equal(f.admin.db.prepare("SELECT count(*) n FROM cafe_audit WHERE action='confirmed_norms_apply'").get().n,1);
 assert.equal(f.cafe.transaction.name,'transaction');assert.ok(first.createdSkuIds.length>0);
});

test('matching quote sizes apply, roll prices accept centimeter or 20 m roll quantities',t=>{
 const f=fixture(t),before=f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=18').get().n;
 f.quotes.items.push({key:'actual-preserving-test',inventoryId:18,quantity:1,totalCents:1,estimated:true,sourceLabel:'ignored actual override',sourceUrl:'https://example.test/estimate'});
 f.quotes.items.push({key:'parchmentRoll20m',unit:'cm',quantity:2000,totalCents:2500,estimated:true,sourceLabel:'20 m roll',sourceUrl:'https://example.test/parchment',quotedProductSpecifications:'20 m roll'});
 f.quotes.items.push({key:'smallCoffeeLid',unit:'piece',quantity:100,totalCents:1200,estimated:true,requiresConfirmation:true,sourceLabel:'80 mm coffee lids',sourceUrl:'https://example.test/lid'});
 const result=applyConfirmedCafeNorms(f.cafe,f.costs,f.plan,f.quotes,f.user,{now:2000,requestId:'confirmed-norms-quotes-20261007',clarifications:{wokTrayMl:600,pizzaBoxCm:40,smallCoffeeLidFit:true}});
 assert.equal(result.pending.quoteConfirmations.includes('wokTray'),false);assert.equal(result.pending.quoteConfirmations.includes('pizzaBox'),false);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=157').get().n,1);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=18').get().n,before);
 const parchment=f.admin.db.prepare('SELECT quantity_milli,total_cents FROM cafe_purchase_price_versions WHERE inventory_id=132 ORDER BY id DESC LIMIT 1').get();assert.equal(parchment.quantity_milli,2000000);assert.equal(parchment.total_cents,2500);
 const smallLid=f.admin.db.prepare("SELECT id FROM inventory_items WHERE name='Крышки маленькие поштучно'").get(),lidPrice=f.admin.db.prepare('SELECT quantity_milli,total_cents FROM cafe_purchase_price_versions WHERE inventory_id=? ORDER BY id DESC LIMIT 1').get(smallLid.id);assert.equal(lidPrice.quantity_milli,100000);assert.equal(lidPrice.total_cents,1200);
});

test('retained source recipe unit mismatch aborts atomically without changing stock or catalog',t=>{
 const f=fixture(t),source=f.plan.sourceData.recipes.find(r=>r.item_id==='item-19'&&r.component==='base'),changed=structuredClone(source.ingredients),extra=changed.find(i=>i.id===65);extra.unitId=8;source.ingredients=changed;f.admin.db.prepare('UPDATE cafe_recipes SET body=? WHERE item_id=? AND component=?').run(JSON.stringify(changed),'item-19','base');
 const count=f.admin.db.prepare('SELECT count(*) n FROM inventory_items').get().n,catalogRevision=f.cafe.catalog().revision,transactionCount=f.admin.db.prepare('SELECT count(*) n FROM inventory_transactions').get().n;
 assert.throws(()=>applyConfirmedCafeNorms(f.cafe,f.costs,f.plan,f.quotes,f.user,{now:2000,requestId:'confirmed-norms-unit-mismatch'}),/Recipe source unit mismatch/);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM inventory_items').get().n,count);assert.equal(f.cafe.catalog().revision,catalogRevision);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM inventory_transactions').get().n,transactionCount);assert.equal(f.cafe.transaction.name,'transaction');
});

test('orange price quote is not assigned to fresh strawberries when its supplied stock ID disagrees',t=>{
 const f=fixture(t);f.quotes.items.push({key:'ownerOranges',inventoryId:45,unitId:6,quantity:1,totalCents:20000,estimated:false,sourceLabel:'Данные владельца: апельсины 200 ₽/кг'});
 const result=applyConfirmedCafeNorms(f.cafe,f.costs,f.plan,f.quotes,f.user,{now:2000,requestId:'confirmed-norms-orange-id-check'});
 assert.deepEqual(result.pending.orangePriceInventoryMismatch,{providedInventoryId:45,matchedOrangeInventoryId:42});assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_purchase_price_versions WHERE inventory_id=45').get().n,0);assert.ok(f.cafe.stock.recipe('80167a50-5b5e-4afc-bbf8-945e4fd4ae52','base').ingredients.some(x=>x.id===42&&x.amount===250));
});
