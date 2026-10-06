import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/cafe-menu-groups.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.className='';this.hidden=false;this.parentElement=null;this.textContent='';this.id='';this.href='';}
 append(...nodes){for(const n of nodes){if(n.parentElement)n.remove();this.children.push(n);n.parentElement=this;}}
 replaceChildren(...nodes){for(const n of this.children)n.parentElement=null;this.children=[];this.append(...nodes);}
 remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}}
 get firstElementChild(){return this.children[0]||null;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 querySelectorAll(selector){const found=[];const matches=n=>selector.split(',').some(s=>{s=s.trim();if(s==='.menu-cat')return n.className.split(/\s+/).includes('menu-cat');if(s==='.menu-item[data-item-id]')return n.className.split(/\s+/).includes('menu-item')&&n.dataset.itemId!==undefined;if(s==='.menu-subcategory')return n.className.split(/\s+/).includes('menu-subcategory');if(s==='.menu-grid')return n.className.split(/\s+/).includes('menu-grid');if(s==='.menu-group-empty')return n.className.split(/\s+/).includes('menu-group-empty');if(s==='h2')return n.tagName==='H2';if(s==='h3')return n.tagName==='H3';if(s==='a')return n.tagName==='A';return false;});const walk=n=>{for(const c of n.children){if(matches(c))found.push(c);walk(c);}};walk(this);return found;}
}
function fixture(){
 let observer,observing=false,pending=false;const list=new Element(),nav=new Element(),search=new Element('input'),host=new Element();search.value='';host.querySelector=s=>s==='#menu-list'?list:s==='#menu-categories'?nav:s==='#menu-search'?search:null;
 const body={classList:{contains:x=>x==='cafe-integrated'}},context={window:{},document:{body,createElement:tag=>new Element(tag)},MutationObserver:class{constructor(fn){observer=fn;}observe(){observing=true;}disconnect(){observing=false;}}};runInNewContext(source,context);
 const original=(id,title,names)=>{const section=new Element('section');section.className='menu-cat';section.id=id;const h=new Element('h2');h.textContent=title;const grid=new Element('div');grid.className='menu-grid';section.append(h,grid);for(const [itemId,name] of names){const card=new Element('article');card.className='menu-item';card.dataset.itemId=itemId;card.priceCents=1234;card.onclick=()=>itemId;const heading=new Element('h3');heading.textContent=name;card.append(heading);grid.append(card);}list.append(section);return section;};
 const runObserver=()=>{let n=0;while(pending&&n++<10){pending=false;observer();}return n;};
 const api=context.window.STARTCafeMenuGroups.mount(host);return {list,nav,search,original,api,runObserver,setPending(){pending=true;},get observing(){return observing;}};
}
const groups=f=>f.list.children.filter(s=>s.dataset.menuGroup);
const cards=node=>node.children.flatMap(child=>child.querySelectorAll('.menu-item[data-item-id]'));
const find=(node,id)=>node.children.flatMap(child=>[child,...child.querySelectorAll('.menu-cat')]).find(x=>x.id===id)||null;

test('Groups preserve actual item nodes, ids, prices, and handlers without duplicates',()=>{
 const f=fixture(),food=f.original('cat-food','Пицца',[['pizza','Маргарита']]),cold=f.original('cat-cold','Холодные напитки',[['shake','Смузи'],['water','Вода JEVEA'],['draft','Квас разливной'],['can','Квас в банке']]),bottled=f.original('cat-bottled','Холодильник',[['bottle','Лимонад бутылочный']]);
 const originals=[...cards(food),...cards(cold),...cards(bottled)],handlers=originals.map(x=>x.onclick);f.setPending();f.runObserver();
 assert.deepEqual(groups(f).slice(0,7).map(x=>x.dataset.menuGroup),['coffee','tea','food','fridge','bar','icecream','hookah']);
 const rendered=groups(f).slice(0,7).flatMap(cards);assert.equal(rendered.length,6);assert.equal(new Set(rendered).size,6);
 for(let i=0;i<originals.length;i++){assert.ok(rendered.includes(originals[i]));assert.equal(originals[i].priceCents,1234);assert.equal(originals[i].onclick,handlers[i]);}
 assert.equal(find(f.list,'staff-menu-bar').querySelectorAll('.menu-item[data-item-id]')[0].dataset.itemId,'shake');assert.equal(find(f.list,'staff-menu-bar').querySelectorAll('.menu-item[data-item-id]')[1].dataset.itemId,'draft');
 assert.equal(find(f.list,'staff-menu-fridge').querySelectorAll('.menu-item[data-item-id]')[0].dataset.itemId,'water');assert.equal(find(f.list,'staff-menu-fridge').querySelectorAll('.menu-item[data-item-id]')[1].dataset.itemId,'can');assert.equal(find(f.list,'staff-menu-fridge').querySelectorAll('.menu-item[data-item-id]')[2].dataset.itemId,'bottle');
});
test('Food keeps source subgroup order and original category ids',()=>{
 const f=fixture();f.original('cat-soup','Супы',[['s','Борщ']]);f.original('cat-pizza','Пицца',[['p','Маргарита']]);f.original('cat-syrniki','Сырники',[['sy','Сырники']]);f.setPending();f.runObserver();
 const subs=find(f.list,'staff-menu-food').querySelectorAll('.menu-subcategory');assert.deepEqual(subs.map(s=>s.dataset.sourceCategoryId),['cat-soup','cat-pizza','cat-syrniki']);assert.equal(subs[0].querySelector('h3').textContent,'Супы');
});
test('Hookah and Food category precedence beats words in product labels',()=>{
 const f=fixture();f.original('hookah-cat','Кальяны на чайной смеси',[['h','Чайный кальян']]);f.original('food-cat','Закуски',[['d','Кофейный десерт']]);f.setPending();f.runObserver();assert.equal(find(f.list,'staff-menu-hookah').querySelectorAll('.menu-item[data-item-id]')[0].dataset.itemId,'h');assert.equal(find(f.list,'staff-menu-food').querySelectorAll('.menu-item[data-item-id]')[0].dataset.itemId,'d');
});
test('Search hides nonmatching groups, empty icecream remains, and rerender regroups fresh cards',()=>{
 const f=fixture();f.original('coffee','Кофе и какао',[['c','Капучино']]);f.original('ice','Мороженое',[['ice1','Ванильное']]);f.setPending();f.runObserver();
 const first=find(f.list,'staff-menu-coffee').querySelectorAll('.menu-item[data-item-id]')[0];f.search.value='капучино';f.original('coffee','Кофе и какао',[['c2','Капучино без кофеина']]);f.setPending();f.runObserver();
 assert.equal(find(f.list,'staff-menu-coffee').hidden,false);assert.equal(find(f.list,'staff-menu-tea').hidden,true);assert.equal(find(f.list,'staff-menu-icecream').hidden,true);
 assert.equal(f.list.querySelectorAll('.menu-group-empty').length,0);assert.notEqual(find(f.list,'staff-menu-coffee').querySelectorAll('.menu-item[data-item-id]')[0],first);
});
test('Unknown category stays visible under explicit Другое and blank search shows all seven groups',()=>{
 const f=fixture();f.original('misc','Неизвестная группа',[['u','Особая позиция']]);f.setPending();f.runObserver();assert.equal(find(f.list,'staff-menu-other').querySelector('h3').textContent,'Неизвестная группа');assert.equal(f.nav.children.map(x=>x.textContent).join(','),'Кофе,Чай,Еда,Холодильник,Бар,Мороженое,Кальяны,Другое');assert.equal(groups(f).filter(x=>x.hidden).length,0);
});
test('Mixed Cold routes prepared products to Bar while explicit Fridge remains Fridge',()=>{
 const f=fixture();f.original('mixed','Холодные напитки',[['lemon','Фреш апельсиновый'],['soda','Фанта']]);f.original('fridge','Холодильник',[['bottle-lemon','Лимонад бутылочный']]);f.setPending();f.runObserver();assert.equal(find(f.list,'staff-menu-bar').querySelectorAll('.menu-item[data-item-id]')[0].dataset.itemId,'lemon');assert.deepEqual(find(f.list,'staff-menu-fridge').querySelectorAll('.menu-item[data-item-id]').map(card=>card.dataset.itemId),['soda','bottle-lemon']);
});

test('All-empty available menu retains seven sections while an empty search result stays untouched',()=>{
 const f=fixture(),empty=new Element('p');empty.textContent='Ничего не найдено';f.list.replaceChildren(empty);f.setPending();f.runObserver();
 assert.equal(groups(f).length,7);assert.equal(f.nav.children.length,7);assert.equal(f.list.querySelectorAll('.menu-group-empty').length,7);
 f.search.value='кофе';f.list.replaceChildren(empty);f.nav.replaceChildren();f.setPending();f.runObserver();assert.equal(groups(f).length,0);assert.equal(f.list.firstElementChild,empty);assert.equal(f.nav.children.length,0);
});
