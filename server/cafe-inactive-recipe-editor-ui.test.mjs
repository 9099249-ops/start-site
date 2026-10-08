import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';

const source=readFileSync(new URL('../dist/admin/operations.js',import.meta.url),'utf8');
const owner={id:1,role:'admin'};

function choose(item,initialComponent='',recipes=[]){
 const nodes={'#dish-select':{value:item.id},'#recipe-form':{hidden:true},'#component-select':{value:'',set innerHTML(html){this.options=[...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m=>({value:m[1],textContent:m[2]}));this.value=this.options[0]?.value||'';}}};
 const line=source.split(/\r?\n/).find(line=>line.startsWith(' function choose('));
 let loadedRecipe;
 const context={stockData:{items:[item],groups:[],recipes},stockItem:item.id,component:initialComponent,recipe(){loadedRecipe=context.stockData.recipes.find(r=>r.item_id===context.stockItem&&r.component===context.component);},$:selector=>nodes[selector],esc:String};
 runInNewContext(line+';choose();',context);
 return {component:context.component,options:nodes['#component-select'].options,loadedRecipe};
}

function normEdit(item,component){
 const listeners={},search={value:'',dispatchEvent(){this.dispatched=true;}},form={scrollIntoView(){this.scrolled=true;}};
 const norms={addEventListener:(name,callback)=>listeners[name]=callback};
 const context={recipeSaving:false,stockData:{items:[item]},stockItem:'',component:'',msg:{textContent:''},
  $:selector=>selector==='#cafe-norms'?norms:selector==='#dish-search'?search:form,Event:class{} };
 const line=source.split(/\r?\n/).find(line=>line.includes("addEventListener('cafe-norm-edit'"));
 runInNewContext(line,context);
 listeners['cafe-norm-edit']({detail:{itemId:item.id,component}});
 return {context,search,form};
}

test('Inactive variants default to the base recipe, which norm edits can load and save',t=>{
 const admin=new AdminStore(':memory:');t.after(()=>admin.close());admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
 const cafe=new CafeStore(admin,null,{env:{}}),item=cafe.catalog().items.find(i=>i.name==='Капучино');
 const menu=cafe.catalog();menu.items.find(i=>i.id===item.id).variants=[{id:'old',name:'Старый вариант',priceCents:0,active:false}];cafe.saveCatalog(menu,owner);
 const config=cafe.stock.config(owner),dish=config.items.find(i=>i.id===item.id);
 cafe.stock.save({itemId:item.id,component:'base',revision:-1,ingredients:[{id:config.inventory[0].id,amount:'0.25'}]},owner);
 const saved=cafe.stock.recipe(item.id,'base');
 assert.equal(choose(dish).component,'base');
 assert.equal(normEdit(dish,'base').context.component,'base');
 assert.deepEqual(cafe.stock.recipe(item.id,'base').ingredients,saved.ingredients);
 cafe.stock.save({itemId:item.id,component:'base',revision:saved.revision,ingredients:[{id:config.inventory[1].id,amount:'0.3'}]},owner);
 assert.equal(cafe.stock.recipe(item.id,'base').ingredients[0].id,config.inventory[1].id);
 assert.equal(cafe.catalog().items.find(i=>i.id===item.id).variants[0].id,'old');
});

test('Active variants retain variant-specific selection and never fall back to base',()=>{
 const item={id:'dish',variants:[{id:'large',name:'Large',active:true}]};
 const result=choose(item,'base');
 assert.equal(result.component,'variant:large');
 assert.deepEqual(result.options.map(option=>option.value),['variant:large']);
 const rejected=normEdit(item,'base');
 assert.equal(rejected.context.component,'');
 assert.match(rejected.context.msg.textContent,/изменён/);
});

test('An empty variant list uses the ordinary base component',()=>{
 assert.equal(choose({id:'plain',variants:[]}).component,'base');
});

test('Inactive variant recipe values remain available in stored stock data',()=>{
 const item={id:'dish',variants:[{id:'old',name:'Old',active:false}]};
 const recipe={item_id:'dish',component:'variant:old',ingredients:[{id:17,amount:225}]};
 const stockData={items:[item],recipes:[recipe]};
 const editor=choose(item,'variant:old',stockData.recipes);
 assert.deepEqual(editor.options.map(option=>option.value),['base','variant:old']);
 assert.equal(editor.component,'variant:old');
 assert.equal(editor.loadedRecipe.component,'variant:old');
 assert.deepEqual(editor.loadedRecipe.ingredients,[{id:17,amount:225}]);
 assert.deepEqual(stockData.recipes,[recipe]);
 assert.deepEqual(stockData.recipes[0].ingredients,[{id:17,amount:225}]);
});
