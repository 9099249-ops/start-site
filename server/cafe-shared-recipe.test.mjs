import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsCosts,cafeCostKey,cafeLineCost} from './operations-analytics-costs.mjs';

const owner={id:1,role:'admin',login:'admin'};

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),costs=new OperationsCosts(admin,cafe),inventory=cafe.stock.inventory;
 t.after(()=>admin.close());
 const row=name=>inventory.catalog(owner).items.find(item=>item.name===name);
 const save=(itemId,component,ingredients)=>cafe.stock.save({itemId,component,revision:cafe.stock.recipe(itemId,component)?.revision??-1,ingredients},owner);
 const cost=(key,portionCents,now=100)=>costs.save({requestId:randomUUID(),revision:costs.revision(),changes:[{kind:'cafe',key,values:{portionCents}}]},owner,now);
 return {admin,cafe,costs,row,save,cost};
}

test('Only an explicit useBaseRecipe snapshot ignores a variant own recipe with a bad 100 L norm',t=>{
 const f=fixture(t),catalog=f.cafe.catalog(),item=catalog.items.find(i=>i.name==='Классический чай'),variant=item.variants[0],base=f.row('Кофе'),bad=f.row('Молоко обычное');
 f.cafe.saveCatalog(catalog,owner);
 f.save(item.id,'base',[{id:base.id,amount:'0.01'}]);
 f.save(item.id,'variant:'+variant.id,[{id:bad.id,amount:'100'}]);
 const current=f.cafe.catalog().items.find(i=>i.id===item.id).variants[0];
 assert.equal(current.useBaseRecipe,undefined);
 assert.deepEqual(f.cafe.stock.requirements({itemId:item.id,name:item.name,variant:{...current,useBaseRecipe:true},modifiers:[]}).map(x=>[x.id,x.amount]),[[base.id,10]]);
 assert.deepEqual(f.cafe.stock.requirements({itemId:item.id,name:item.name,variant:current,modifiers:[]}).map(x=>[x.id,x.amount]),[[bad.id,100000]]);
 assert.deepEqual(f.cafe.stock.requirements({itemId:item.id,name:item.name,custom:true,variant:{...current,useBaseRecipe:true},modifiers:[]}),[]);
});

test('Explicit false forbids brewed-tea base fallback while legacy undefined retains it',t=>{
 const f=fixture(t),item=f.cafe.catalog().items.find(i=>i.name==='Классический чай'),variant=item.variants[0],base=f.row('Кофе');
 f.save(item.id,'base',[{id:base.id,amount:'0.01'}]);
 f.admin.db.prepare('DELETE FROM cafe_recipes WHERE item_id=? AND component=?').run(item.id,'variant:'+variant.id);
 assert.deepEqual(f.cafe.stock.requirements({itemId:item.id,name:item.name,variant:{...variant,useBaseRecipe:false},modifiers:[]}),[]);
 assert.deepEqual(f.cafe.stock.requirements({itemId:item.id,name:item.name,variant,modifiers:[]}).map(x=>[x.id,x.amount]),[[base.id,10]]);
});

test('Explicit shared recipe with replacing options consumes the base ingredient once',t=>{
 const f=fixture(t),catalog=f.cafe.catalog(),item=catalog.items.find(i=>i.name==='Капучино'),base=f.row('Молоко обычное'),replacement=f.row('Молоко овсяное');
 const group={id:'test-shared-swap',name:'Замена молока',active:true,min:0,max:1,options:[{id:'test-oat',name:'Овсяное',priceCents:0,active:true,soldOut:false}]};
 catalog.groups.push(group);catalog.items.find(i=>i.id===item.id).groupIds.push(group.id);catalog.items.find(i=>i.id===item.id).variants=[{id:'test-variant',name:'Большой',priceCents:0,active:true,useBaseRecipe:true}];
 f.cafe.saveCatalog(catalog,owner);
 f.save(item.id,'base',[{id:base.id,amount:'0.25'}]);
 f.save(item.id,'option:'+group.options[0].id,[{id:replacement.id,amount:'0.25',replacesId:base.id}]);
 const line={itemId:item.id,name:item.name,variant:{id:'test-variant',useBaseRecipe:true},modifiers:[{optionId:'test-oat'}]};
 assert.deepEqual(f.cafe.stock.requirements(line).map(x=>x.id),[replacement.id]);
});

test('Finance inherits base cost only for explicit shared-recipe snapshots with no own field',t=>{
 const f=fixture(t),catalog=f.cafe.catalog(),item=catalog.items.find(i=>i.name==='Классический чай');item.variants[0].useBaseRecipe=true;f.cafe.saveCatalog(catalog,owner);
 const variant=item.variants[0],baseKey=cafeCostKey(item.id,'base'),variantKey=cafeCostKey(item.id,'variant:'+variant.id);
 f.cost(baseKey,1800,100);
 const read=f.costs.reader(),line=flag=>({itemId:item.id,variant:{id:variant.id,...(flag===undefined?{}:{useBaseRecipe:flag})}});
 assert.equal(cafeLineCost(read,line(true),101),1800);
 assert.equal(cafeLineCost(read,line(false),101),undefined);
 assert.equal(cafeLineCost(read,line(undefined),101),undefined);
 f.cost(variantKey,null,200);
 assert.equal(cafeLineCost(f.costs.reader(),line(true),201),null);
 f.cost(variantKey,0,300);
 assert.equal(cafeLineCost(f.costs.reader(),line(true),301),0);
});
