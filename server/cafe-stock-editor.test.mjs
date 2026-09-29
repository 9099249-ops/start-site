import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';

const source=readFileSync(new URL('../dist/admin/operations.js',import.meta.url),'utf8');
const owner={id:1,login:'admin',role:'admin'};
function editor(stockData,stockItem,component){
 const container={children:[],append(row){this.children.push(row);}};
 const field=()=>({get value(){return this.text||'';},set value(value){this.text=String(value);}});
 class Row{
  set innerHTML(html){this.html=html;this.fields=new Map([['input',field()],['button',{}]]);for(const name of ['data-stock-id','data-replaces-id'])if(html.includes('<select '+name))this.fields.set('['+name+']',field());}
  querySelector(selector){return this.fields.get(selector)||null;}
  remove(){container.children=container.children.filter(row=>row!==this);}
 }
 const definitions=['ingredient','recipeIngredients'].map(name=>source.split(/\r?\n/).find(line=>line.startsWith(' function '+name+'('))).join('\n');
 assert.match(source,/ingredients=recipeIngredients\(\)/,'the save form must use the tested serializer');
 const context={stockData,stockItem,component,document:{createElement:()=>new Row()},$:()=>container,esc:String};
 runInNewContext(definitions,context);
 return {...context,container,payload:()=>JSON.parse(JSON.stringify(context.recipeIngredients()))};
}

test('Stock editor: changing a replacement dose preserves its target through save and reload without changing stock',()=>{
 const admin=new AdminStore(':memory:');
 try{
  admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
  const cafe=new CafeStore(admin,null,{env:{}}),config=cafe.stock.config(owner),dish=config.items.find(i=>i.name==='Капучино');
  const ordinary=config.inventory.find(i=>i.name==='Молоко обычное'),oat=config.inventory.find(i=>i.name==='Молоко овсяное');
  const option=config.groups.flatMap(g=>g.options).find(o=>o.name==='Овсяное'),component='option:'+option.id;
  cafe.stock.save({itemId:dish.id,component:'base',revision:-1,ingredients:[{id:ordinary.id,amount:'0.25'}]},owner);
  cafe.stock.save({itemId:dish.id,component,revision:-1,ingredients:[{id:oat.id,amount:'0.25',replacesId:ordinary.id}]},owner);
  const before=admin.db.prepare('SELECT * FROM inventory_items').all(),saved=cafe.stock.recipe(dish.id,component);
  const form=editor(cafe.stock.config(owner),dish.id,component);form.ingredient(saved.ingredients[0]);
  const row=form.container.children[0];assert.equal(row.querySelector('[data-replaces-id]').value,String(ordinary.id));
  row.querySelector('input').value='0.275';
  cafe.stock.save({itemId:dish.id,component,revision:saved.revision,ingredients:form.payload()},owner);
  assert.deepEqual(cafe.stock.recipe(dish.id,component).ingredients,[{id:oat.id,unitId:oat.unit_id,amount:275,replacesId:ordinary.id}]);
  assert.deepEqual(admin.db.prepare('SELECT * FROM inventory_items').all(),before);
 }finally{admin.close();}
});

test('Stock editor: plain recipes omit replacement metadata; choosing additional consumption clears it explicitly',()=>{
 const config={recipes:[{item_id:'drink',component:'base',ingredients:[{id:20,amount:250}]}],inventory:[{id:20,name:'Молоко обычное',unit:'л',active:1},{id:21,name:'Молоко овсяное',unit:'л',active:1}]};
 const plain=editor(config,'drink','base');plain.ingredient({id:20,amount:250});
 assert.equal(plain.container.children[0].querySelector('[data-replaces-id]'),null);
 assert.deepEqual(plain.payload(),[{id:20,amount:'0.25'}]);
 const replacement=editor(config,'drink','option:oat');replacement.ingredient({id:21,amount:250,replacesId:20});
 replacement.container.children[0].querySelector('[data-replaces-id]').value='';
 assert.deepEqual(replacement.payload(),[{id:21,amount:'0.25'}]);
});
