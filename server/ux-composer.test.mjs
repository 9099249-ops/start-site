import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/cafe.js',import.meta.url),'utf8');
class Node{
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.classList={toggle(){},add(){}};this.hidden=false;this.value='';this.textContent='';}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 setAttribute(key,value){this.attrs[key]=String(value);}
 querySelectorAll(){return [];}
}
function renderFixture({integrated=true,staffMode=true}={}){
 const nodes=new Map(['#cafe-image-note','#menu-search','#menu-categories','#menu-list','#cart-button','#mobile-sale','#checkout-button','#prepare-order','#cart-lines'].map(id=>[id,new Node()]));
 const item=(id,name,groupIds=[])=>({id,name,description:'',priceCents:100,variants:[],groupIds,tags:[],active:true,categoryId:'drinks'});
 const menu={items:[item('plain','Кофе',['sugar']),item('tea','Чай',['size'])],categories:[{id:'drinks',name:'Напитки',active:true,sort:1}],groups:[{id:'sugar',active:true,min:0,options:[{active:true}]},{id:'size',active:true,min:1,options:[{active:true}]}],settings:{enabled:true}};
 const calls=[];
 const ctx={menu,staffMode,integrated,cart:[],appendOrder:null,busy:false,form:{dataset:{},elements:{fulfillment:{value:'pickup'},timing:{value:'asap'}}},pendingKey:'pending',sessionStorage:{getItem(){return null}},document:{body:{classList:{contains(){return false}}}},
  $:selector=>nodes.get(selector),read:()=>null,el:(tag,text,cls)=>{const n=new Node(tag);n.textContent=text||'';n.className=cls||'';return n;},money:n=>String(n),stockText:()=>'',quickItem:i=>!i.variants.length&&!i.groupIds.includes('size'),quickAdd:i=>calls.push(['quick',i.id]),openDish:i=>calls.push(['options',i.id]),
  cart:[],freeChoice:()=>null,canQuickSell:()=>true,blockedQuickSaleItems:()=>[],quickSaleAvailable:()=>true,quickSaleCheckoutBlocked:()=>false,estimatedTotal:()=>0,cartButton(){},documentElement:{}};
 const renderSource=source.split(/\r?\n/).find(line=>line.trim().startsWith('function renderMenu()'));
 const render=runInNewContext('('+renderSource.trim()+')',ctx);return {nodes,render,calls,ctx,menu};
}

test('Staff catalog keeps one-tap coffee and exposes optional modifiers separately',()=>{
 const f=renderFixture();f.render();
 const cards=f.nodes.get('#menu-list').children[0].children[1].children;
 const coffeeButtons=cards[0].children.at(-1).children.filter(node=>node.tagName==='button');
 assert.deepEqual(coffeeButtons.map(node=>node.textContent),['+','Варианты']);
 coffeeButtons[0].onclick();coffeeButtons[1].onclick();
 assert.deepEqual(f.calls,[['quick','plain'],['options','plain']]);
 const teaButtons=cards[1].children.at(-1).children.filter(node=>node.tagName==='button');
 assert.deepEqual(teaButtons.map(node=>node.textContent),['+']);
});

test('A completed integrated staff sale leaves an empty basket entry available',()=>{
 const f=renderFixture();
 const cartButton=source.split(/\r?\n/).find(line=>line.trim().startsWith('function cartButton()'));
 const fn=runInNewContext('('+cartButton.trim()+')',f.ctx);
 fn();assert.equal(f.nodes.get('#cart-button').hidden,false);
 f.ctx.staffMode=false;fn();assert.equal(f.nodes.get('#cart-button').hidden,true);
});

test('Composer keeps manual payment visible in both fulfillment rows',()=>{
 const composer=readFileSync(new URL('../dist/admin/cafe-compose.js',import.meta.url),'utf8');
 assert.match(composer,/manualRegister\.textContent='Эквайринг вручную'/);
 assert.match(composer,/manualDeliver\.textContent='Эквайринг вручную'/);
 assert.match(composer,/workRow\.append\(manualRegister\);deliverRow\.append\(manualDeliver\)/);
 assert.match(composer,/manualRegister\.hidden=unavailable/);
 assert.match(composer,/manualDeliver\.hidden=unavailable\|\|prepareButton\.hidden/);
 assert.match(composer,/freeOptions\.replaceWith\(source\)/);
 assert.match(composer,/compact\.append\(employee,pending\)/);
 assert.match(composer,/if\(employeeOptions&&footer\.lastElementChild!==employeeOptions\)footer\.append\(employeeOptions\)/);
 assert.match(composer,/source\.append\(reason\.closest\('label'\),recipient\.closest\('label'\),freeComment\.closest\('label'\)\)/);
 assert.doesNotMatch(composer,/checkout-secondary|Другие действия|checkout-manual-actions/);
 assert.match(composer,/pending\.hidden=!reason\.value/);
});
