import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';

const source=readFileSync(new URL('../dist/admin/operations.js',import.meta.url),'utf8');
const start=source.indexOf(' let stockData,'),end=source.lastIndexOf(' run(async()=>');
assert.ok(start>=0&&end>start);
const stockCode=source.slice(start,end);
const owner={id:1,login:'admin',role:'admin'};
const copy=value=>JSON.parse(JSON.stringify(value));
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>copy(data)});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.attributes={};this.dataset={};this.disabled=false;this.hidden=false;this.textContent='';this.value='';}
 get value(){return this._value||'';}set value(value){this._value=String(value);}
 set innerHTML(html){
  this.html=html;
  if(this.tag==='select'){
   this.options=[...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m=>({value:m[1],textContent:m[2]}));
   this.value=this.options[0]?.value||'';
  }else if(this.className==='ingredient'){
   this.children=[];
   for(const m of html.matchAll(/<(select|input|button)\b([^>]*)(?:>([\s\S]*?)<\/\1>|>)/g)){
    const node=new Element(m[1]);
    for(const name of ['data-stock-id','data-replaces-id'])if(m[2].includes(name))node.attributes[name]='';
    if(node.tag==='select')node.innerHTML=m[3]||'';
    this.append(node);
   }
  }
 }
 append(...children){for(const child of children){this.children.push(child);child.parent=this;}}
 replaceChildren(...children){this.children=[];this.append(...children);}
 remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}
 setAttribute(name,value){this.attributes[name]=String(value);}
 querySelectorAll(selector){
  const matches=node=>selector.split(',').some(part=>part.trim().startsWith('[')?Object.hasOwn(node.attributes,part.trim().slice(1,-1)):node.tag===part.trim());
  return this.children.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(selector)]);
 }
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}

async function fixture(t){
 const admin=new AdminStore(':memory:');t.after(()=>admin.close());
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
 const cafe=new CafeStore(admin,null,{env:{}}),stock=cafe.stock;
 const goods=stock.inventory.catalog(owner).items,milk=goods.find(i=>i.name==='Молоко обычное'),oat=goods.find(i=>i.name==='Молоко овсяное');
 const item=cafe.catalog().items.find(i=>i.name==='Капучино'),option=cafe.catalog().groups.flatMap(g=>g.options).find(o=>o.name==='Овсяное'),component='option:'+option.id;
 stock.save({itemId:item.id,component:'base',revision:-1,ingredients:[{id:milk.id,amount:'0.25'}]},owner);
 stock.save({itemId:item.id,component,revision:-1,ingredients:[{id:oat.id,amount:'0.25',replacesId:milk.id}]},owner);
 const nodes=new Map(),node=(id,tag='div')=>{const value=new Element(tag);nodes.set('#'+id,value);return value;};
 const root=node('ops-content'),msg=node('ops-message'),form=node('recipe-form','form'),ingredients=node('ingredients');
 root.append(node('dish-search','input'),node('dish-select','select'),node('component-select','select'),form);
 form.append(ingredients,node('add-ingredient','button'),node('recipe-note'),node('save-recipe','button'),node('recipe-save-status'),node('reload-recipe','button'));
 const requests=[],handlers=[],timers=new Map();let timerId=0;
 const service=request=>{try{return response(200,request.method==='POST'?stock.save(request.body,owner):stock.config(owner));}catch(error){return response(error.status||500,{error:error.message});}};
 const context={root,msg,document:{createElement:tag=>new Element(tag)},$:selector=>nodes.get(selector),esc:value=>String(value??''),
  api:async()=>stock.config(owner),AbortController,
  setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
  fetch:async(url,options)=>{const request={url,method:options.method,body:options.body?JSON.parse(options.body):undefined,signal:options.signal};requests.push(request);return handlers.length?handlers.shift()(request,service):service(request);},
 };
 runInNewContext(stockCode+'\nglobalThis.actions={stock,saveRecipe,reloadRecipe,recipeEdited,setTarget:(id,key)=>{stockItem=id;component=key;},state:()=>({stockData,stockItem,component,recipeSaving,recipeLatest})};',context);
 context.actions.setTarget(item.id,component);await context.actions.stock();
 const row=()=>ingredients.children[0],input=()=>row().querySelector('input');
 const edit=value=>{input().value=value;form.oninput();};
 const submit=submitter=>form.onsubmit({preventDefault(){},submitter});
 const current=()=>stock.recipe(item.id,component);
 const auditCount=()=>admin.db.prepare("SELECT count(*) n FROM cafe_audit WHERE action='recipe'").get().n;
 const conflict=amount=>stock.save({itemId:item.id,component,revision:current().revision,ingredients:[{id:oat.id,amount,replacesId:milk.id}]},owner);
 return {admin,cafe,stock,item,component,milk,oat,root,msg,form,ingredients,nodes,requests,handlers,timers,row,input,edit,submit,current,auditCount,conflict,
  state:()=>copy(context.actions.state()),reload:()=>nodes.get('#reload-recipe').onclick(),status:()=>nodes.get('#recipe-save-status'),button:()=>nodes.get('#save-recipe')};
}

test('Recipe save UI: successful POST updates its returned revision immediately, without a follow-up GET',async t=>{
 const f=await fixture(t),before=f.auditCount();
 f.edit('0,200');await f.submit(f.button());
 assert.deepEqual(f.requests.map(r=>r.method),['POST']);
 assert.equal(f.requests[0].body.revision,0);
 assert.equal(f.current().revision,1);
 assert.equal(f.current().ingredients[0].amount,200);
 assert.equal(f.current().ingredients[0].replacesId,f.milk.id);
 assert.equal(f.input().value,'0.2');
 assert.equal(f.status().dataset.kind,'success');
 assert.equal(f.button().textContent,'✓ Сохранено');
 assert.equal(f.auditCount(),before+1);
 f.edit('0.275');await f.submit();
 assert.deepEqual(f.requests.map(r=>[r.method,r.body.revision]),[['POST',0],['POST',1]]);
 assert.equal(f.current().revision,2);
 assert.equal(f.current().ingredients[0].amount,275);
 assert.equal(f.auditCount(),before+2);
 assert.equal(f.timers.size,0);
});

test('Recipe save UI: double tap and Enter during a request are ignored and all edit controls are locked',async t=>{
 const f=await fixture(t),pending=deferred(),originalControls=f.root.querySelectorAll('input,select,button');
 const preDisabled=f.nodes.get('#dish-search');preDisabled.disabled=true;
 f.handlers.push(async(request,service)=>{await pending.promise;return service(request);});
 f.edit('0.225');const save=f.submit(f.button());
 assert.equal(f.state().recipeSaving,true);
 assert.equal(f.form.attributes['aria-busy'],'true');
 assert.ok(originalControls.every(control=>control.disabled));
 assert.equal(f.button().textContent,'Сохраняю…');
 await f.submit(f.button());await f.submit();
 assert.equal(f.requests.length,1);
 assert.deepEqual([...f.timers.values()].map(timer=>timer.ms),[12000]);
 pending.resolve();await save;
 assert.equal(f.state().recipeSaving,false);
 assert.equal(f.form.attributes['aria-busy'],'false');
 assert.equal(preDisabled.disabled,true);
 assert.ok(f.root.querySelectorAll('input,select,button').filter(control=>control!==preDisabled).every(control=>!control.disabled));
 assert.equal(f.current().ingredients[0].amount,225);
});

test('Recipe save UI: a lost POST reply is confirmed by GET without a second write or audit',async t=>{
 const f=await fixture(t),before=f.auditCount();
 f.handlers.push((request,service)=>{service(request);throw Error('reply lost after commit');});
 f.edit('0,210');await f.submit();
 assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);
 assert.equal(f.auditCount(),before+1);
 assert.equal(f.current().revision,1);
 assert.equal(f.input().value,'0.21');
 assert.equal(f.status().dataset.kind,'success');
 assert.equal(f.nodes.get('#reload-recipe').hidden,true);
});

test('Recipe save UI: a lost reply followed by a different saved revision preserves the draft until explicit reload',async t=>{
 const f=await fixture(t),before=f.auditCount();
 f.handlers.push(()=>{f.conflict('0.300');throw Error('reply lost');});
 f.edit('0.200');const draftRow=f.row();await f.submit();
 assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);
 assert.equal(f.row(),draftRow);
 assert.equal(f.input().value,'0.200');
 assert.equal(f.current().ingredients[0].amount,300);
 assert.equal(f.auditCount(),before+1);
 assert.equal(f.status().dataset.kind,'error');
 assert.match(f.status().textContent,/другой вкладке/);
 assert.equal(f.nodes.get('#reload-recipe').hidden,false);
 assert.equal(f.state().stockData.recipes.find(r=>r.item_id===f.item.id&&r.component===f.component).revision,0);
 await f.reload();
 assert.equal(f.input().value,'0.3');
 assert.equal(f.state().stockData.recipes.find(r=>r.item_id===f.item.id&&r.component===f.component).revision,1);
 assert.equal(f.nodes.get('#reload-recipe').hidden,true);
 assert.equal(f.requests.length,2);
});

test('Recipe save UI: stale revision 409 does not overwrite another editor and reload is explicit',async t=>{
 const f=await fixture(t);f.conflict('0.325');const before=f.auditCount();
 f.edit('0.225');await f.submit();
 assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);
 assert.equal(f.requests[0].body.revision,0);
 assert.equal(f.current().ingredients[0].amount,325);
 assert.equal(f.auditCount(),before);
 assert.equal(f.input().value,'0.225');
 assert.equal(f.nodes.get('#reload-recipe').hidden,false);
 await f.reload();f.edit('0.240');await f.submit();
 assert.equal(f.requests[2].body.revision,1);
 assert.equal(f.current().ingredients[0].amount,240);
 assert.equal(f.auditCount(),before+1);
});

test('Recipe save UI: validation 400 remains a local error with the exact draft and no recovery GET',async t=>{
 const f=await fixture(t),before=f.auditCount();f.edit('0');const draftRow=f.row();
 await f.submit();
 assert.deepEqual(f.requests.map(r=>r.method),['POST']);
 assert.equal(f.row(),draftRow);
 assert.equal(f.input().value,'0');
 assert.equal(f.current().revision,0);
 assert.equal(f.auditCount(),before);
 assert.equal(f.status().dataset.kind,'error');
 assert.match(f.status().textContent,/Проверьте товар и расход/);
 assert.equal(f.nodes.get('#reload-recipe').hidden,true);
 assert.equal(f.button().disabled,false);
});

test('Recipe save UI: failed POST and GET retain the original version and an explicit retry uses that exact version',async t=>{
 const f=await fixture(t),before=f.auditCount();
 f.handlers.push(()=>{throw Error('offline');},()=>{throw Error('still offline');});
 f.edit('0.230');const draftRow=f.row();await f.submit();
 assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);
 assert.equal(f.input().value,'0.230');assert.equal(f.row(),draftRow);
 assert.equal(f.current().revision,0);assert.equal(f.auditCount(),before);
 assert.match(f.status().textContent,/Результат пока не подтверждён/);
 await f.submit();
 assert.equal(f.requests[2].method,'POST');
 assert.deepEqual(f.requests[2].body,f.requests[0].body);
 assert.equal(f.current().revision,1);assert.equal(f.auditCount(),before+1);
 assert.equal(f.status().dataset.kind,'success');
});

test('Recipe save UI: the 12-second deadline aborts an uncertain POST and reconciles through GET',async t=>{
 const f=await fixture(t),before=f.auditCount();
 f.handlers.push((request,service)=>{service(request);return new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));});
 f.edit('0.235');const save=f.submit();
 assert.equal(f.requests[0].signal.aborted,false);
 const timer=[...f.timers.values()][0];assert.equal(timer.ms,12000);timer.fn();await save;
 assert.equal(f.requests[0].signal.aborted,true);
 assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);
 assert.equal(f.status().dataset.kind,'success');
 assert.equal(f.auditCount(),before+1);
 assert.equal(f.timers.size,0);
});

test('Recipe save UI: 409 plus failed verification keeps the draft and offers an available safe retry',async t=>{
 const f=await fixture(t);f.conflict('0.310');const before=f.auditCount();
 f.handlers.push((request,service)=>service(request),()=>{throw Error('verification offline');});
 f.edit('0.240');await f.submit();
 assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);
 assert.equal(f.status().dataset.kind,'error');
 assert.doesNotMatch(f.status().textContent,/Загрузите актуальный расход/);
 assert.match(f.status().textContent,/Сохранить расход|повтор|ещё раз|снова/i);
 assert.equal(f.nodes.get('#reload-recipe').hidden,true);
 assert.equal(f.button().disabled,false);
 assert.equal(f.input().value,'0.240');
 assert.equal(f.current().ingredients[0].amount,310);
 assert.equal(f.auditCount(),before);
 await f.submit();
 assert.deepEqual(f.requests.map(r=>r.method),['POST','GET','POST','GET']);
 assert.deepEqual(f.requests[2].body,f.requests[0].body);
 assert.equal(f.current().ingredients[0].amount,310);
 assert.equal(f.auditCount(),before);
 assert.equal(f.input().value,'0.240');
 assert.equal(f.nodes.get('#reload-recipe').hidden,false);
});
