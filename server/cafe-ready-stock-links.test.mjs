import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {linkReadyMadeProducts} from './cafe-ready-stock-links.mjs';

const owner={id:1,login:'owner',role:'admin'};
function fixture(){
  const admin=new AdminStore(':memory:');
  admin.db.exec("INSERT INTO admin_users VALUES(1,'owner','admin','unused')");
  const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),stock=cafe.stock;
  const dish=name=>cafe.catalog().items.find(i=>i.name===name);
  const item=name=>stock.inventory.catalog(owner).items.find(i=>i.name===name);
  const amount=(name,value)=>{const i=stock.inventory.row(item(name).id);stock.inventory.move({id:i.id,revision:i.revision,kind:'SET',reason:'Проверочный пересчёт',amount:value,requestId:randomUUID()},owner);};
  const menuChange=change=>{const catalog=cafe.catalog();change(catalog);cafe.saveCatalog(catalog,owner);};
  return {admin,cafe,stock,dish,item,amount,menuChange};
}
function check(name,run){test(name,()=>{const f=fixture();try{run(f);}finally{f.admin.close();}});}
const recipeIngredient=(f,dish,component='base')=>f.stock.recipe(f.dish(dish).id,component)?.ingredients[0];

check('Ready stock links cover explicit soups and bottled drinks, including exact aliases and variants',f=>{
  const results=linkReadyMadeProducts(f.cafe,owner);
  assert.equal(results.filter(r=>r.status==='linked').length,18);
  assert.deepEqual(results.filter(r=>r.status==='needs_review').map(r=>[r.name,r.variant,r.reason]),[['Липтон','Чёрный','variant_missing']]);
  for(const [menu,inventory] of [['Борщ оригинальный с говядиной','Борщ с говядиной'],['Фанта','Fanta'],['Кока-Кола','Coca-Cola'],['Безалкогольное пиво','Пиво безалкогольное'],['Квас в банке','Квас баночный'],['Сок RICH','Сок Rich']])assert.deepEqual(recipeIngredient(f,menu),{id:f.item(inventory).id,unitId:f.item(inventory).unit_id,amount:1000});
  for(const [menu,variantName,inventory] of [['Вода JEVEA','С газом','Вода с газом'],['Вода JEVEA','Без газа','Вода без газа'],['Липтон','С лимоном','Lipton лимон'],['Липтон','Зелёный','Lipton зелёный']]){
    const variant=f.dish(menu).variants.find(v=>v.name===variantName);
    assert.equal(recipeIngredient(f,menu,'variant:'+variant.id).id,f.item(inventory).id);
  }
  assert.equal(f.stock.recipe(f.dish('Вода JEVEA').id,'base'),null);
  assert.equal(f.stock.recipe(f.dish('Липтон').id,'base'),null);
});

check('Ready stock linking preserves recipes, inventory, history and menu flags, and is idempotent',f=>{
  const dish=f.dish('Фанта'),good=f.item('Fanta');
  f.stock.save({itemId:dish.id,component:'base',revision:-1,ingredients:[{id:good.id,amount:'2'}]},owner);
  f.menuChange(c=>{c.items.find(i=>i.name==='Кока-Кола').soldOut=true;});
  const inventory=f.admin.db.prepare('SELECT * FROM inventory_items').all(),history=f.admin.db.prepare('SELECT * FROM inventory_transactions').all(),catalog=f.cafe.catalog();
  const first=linkReadyMadeProducts(f.cafe,owner);
  assert.equal(first.find(r=>r.name==='Фанта').status,'kept_existing');
  assert.equal(recipeIngredient(f,'Фанта').amount,2000);
  assert.deepEqual(f.admin.db.prepare('SELECT * FROM inventory_items').all(),inventory);
  assert.deepEqual(f.admin.db.prepare('SELECT * FROM inventory_transactions').all(),history);
  assert.deepEqual(f.cafe.catalog(),catalog);
  assert.equal(f.admin.db.prepare("SELECT count(*) n FROM cafe_audit WHERE action='recipe'").get().n,18);
  const changes=f.admin.db.prepare('SELECT total_changes() n').get().n;
  assert.equal(linkReadyMadeProducts(f.cafe,owner).filter(r=>r.status==='linked').length,0);
  assert.equal(f.admin.db.prepare('SELECT total_changes() n').get().n,changes);
});

check('No ingredient, tea package, keg, restricted product or unlisted menu item gets inferred',f=>{
  f.menuChange(c=>{c.items.find(i=>i.name==='Фанта').restricted=true;c.items.find(i=>i.name==='Кока-Кола').groupIds=[c.groups[0].id];});
  const results=linkReadyMadeProducts(f.cafe,owner);
  assert.equal(results.find(r=>r.name==='Фанта').reason,'restricted_menu_item');
  assert.equal(results.find(r=>r.name==='Кока-Кола').reason,'modifiers_require_review');
  for(const name of ['Фанта','Кока-Кола','Капучино','Американо','Какао','Классический чай','Квас разливной','Сырники','4 сыра','Кальян на чайной смеси'])assert.equal(f.stock.recipe(f.dish(name).id,'base'),null,name);
  const used=new Set(f.admin.db.prepare('SELECT body FROM cafe_recipes').all().flatMap(r=>JSON.parse(r.body).map(i=>i.id)));
  for(const good of f.stock.inventory.catalog(owner).items.filter(i=>['упаковки','кг','г','л','кеги'].includes(i.unit)||i.name.startsWith('Сироп')))assert.equal(used.has(good.id),false,good.name);
  assert.throws(()=>linkReadyMadeProducts(f.cafe,{id:2,login:'station',role:'staff'}),e=>e.status===403);
});

check('Incorrect units, ambiguous dishes, inactive stock or variants are explicit skips',f=>{
  const kg=f.stock.inventory.dictionary('inventory_units','кг'),bottles=f.stock.inventory.dictionary('inventory_units','бутылки');
  f.admin.db.prepare('UPDATE inventory_items SET unit_id=? WHERE id=?').run(kg,f.item('Fanta').id);
  f.admin.db.prepare('UPDATE inventory_items SET unit_id=? WHERE id=?').run(bottles,f.item('Уха янтарная').id);
  f.admin.db.prepare('UPDATE inventory_items SET active=0 WHERE id=?').run(f.item('Квас баночный').id);
  f.menuChange(c=>{const cola=c.items.find(i=>i.name==='Кока-Кола');c.items.push({...cola,id:'cola-duplicate'});c.items.find(i=>i.name==='Вода JEVEA').variants[0].active=false;});
  const results=linkReadyMadeProducts(f.cafe,owner),reason=(name,variant)=>results.find(r=>r.name===name&&(!variant||r.variant===variant)).reason;
  assert.equal(reason('Фанта'),'incompatible_stock_unit');assert.equal(reason('Уха янтарная'),'incompatible_stock_unit');assert.equal(reason('Квас в банке'),'stock_item_inactive');assert.equal(reason('Кока-Кола'),'ambiguous_menu_item');assert.equal(reason('Вода JEVEA','С газом'),'variant_inactive');
  assert.equal(f.stock.recipe(f.dish('Фанта').id,'base'),null);
});

check('Black Lipton links only when its exact variant exists; extra unknown variants remain unconfigured',f=>{
  f.menuChange(c=>{const lipton=c.items.find(i=>i.name==='Липтон');lipton.variants.push({id:'black',name:'Черный',priceCents:0,active:true},{id:'peach',name:'Персик',priceCents:0,active:true});});
  const results=linkReadyMadeProducts(f.cafe,owner),id=f.dish('Липтон').id;
  assert.equal(results.find(r=>r.variant==='Чёрный').status,'linked');
  assert.equal(f.stock.recipe(id,'variant:black').ingredients[0].id,f.item('Lipton чёрный').id);
  assert.equal(f.stock.recipe(id,'variant:peach'),null);
  assert.equal(f.cafe.publicMenu().items.find(i=>i.id===id).stock.variants.find(v=>v.variantId==='peach').configured,false);
});

check('Unknown and zero balances remain unavailable; known bottles consume exactly once on retry',f=>{
  linkReadyMadeProducts(f.cafe,owner);
  const soup=f.dish('Уха янтарная');
  assert.equal(f.stock.availability(soup).configured,false);assert.equal(f.stock.availability(soup).available,0);
  f.amount('Уха янтарная','0');assert.equal(f.stock.availability(soup).configured,true);assert.equal(f.stock.availability(soup).available,0);
  f.amount('Уха янтарная','3');assert.equal(f.stock.availability(soup).available,3);
  f.amount('Fanta','2');const dish=f.dish('Фанта');
  const body={requestId:randomUUID(),name:'Гость',phone:'',fulfillment:'pickup',payment:'unspecified',items:[{itemId:dish.id,quantity:1}],expectedTotalCents:dish.priceCents};
  const order=f.cafe.create(body,owner);assert.equal(f.stock.inventory.row(f.item('Fanta').id).current_milli,1000);
  assert.equal(f.cafe.create(body,owner).id,order.id);assert.equal(f.stock.inventory.row(f.item('Fanta').id).current_milli,1000);
  assert.throws(()=>f.cafe.create({...body,requestId:randomUUID(),items:[{itemId:dish.id,quantity:2}],expectedTotalCents:2*dish.priceCents},owner),e=>e.stockCode==='INSUFFICIENT');
  assert.equal(f.stock.inventory.row(f.item('Fanta').id).current_milli,1000);
});
