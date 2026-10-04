import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {InventoryStore} from './inventory.mjs';

const source=readFileSync(new URL('../dist/admin/purchase.js',import.meta.url),'utf8');
for(const comment of ['', '   ', 'Пересчитали пиццы'])test(`Stock form saves exact quantity with comment ${JSON.stringify(comment)}`,async()=>{
 const admin=new AdminStore(':memory:');
 try{
  admin.db.prepare('INSERT INTO admin_users(id,login,role,password) VALUES(1,?,?,?)').run('station','staff','test-only');
  const user={id:1,login:'station',role:'staff'},store=new InventoryStore(admin,{seed:false});
  const item=store.save({name:'Маргарита',category:'Пицца',unit:'шт.',current:'2',minimum:'',target:'',manualBuy:false,comment:'',requestId:randomUUID()},user).item;
  const form={elements:{kind:{value:'SET'},reason:{value:comment,required:true},baseline:{value:''},amount:{value:'5'}}};
  const nodes={'#move-form':form,'#baseline-label':{},'#amount-label':{},'#move-error':{}};
  let result,submitted;
  const context={chosen:item,requestId:randomUUID(),$:s=>nodes[s],FormData:class{constructor(f){return Object.entries(f.elements).map(([k,v])=>[k,v.value]);}},save:async(f,fn)=>{result=await fn();},api:(route,b)=>{submitted=b;return store.move(b,user);}};
  vm.createContext(context);
  vm.runInContext(source.match(/function moveFields\(\)\{[^\n]+/)[0],context);
  context.moveFields();
  assert.equal(form.elements.reason.required,false);
  vm.runInContext(source.match(/\$\('#move-form'\)\.onsubmit=[^\n]+/)[0],context);
  form.onsubmit({preventDefault(){},target:form});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result.item.current,'5');
  assert.equal(submitted.reason,comment.trim()||'Уточнение остатка');
  const history=store.history(new URLSearchParams(),user).items;
  assert.equal(history[0].actor,1);
  assert.equal(history[0].reason,submitted.reason);
  assert.ok(store.move(submitted,user).duplicate);
 }finally{admin.close();}
});
