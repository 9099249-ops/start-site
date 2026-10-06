import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/cafe-favorites.js',import.meta.url),'utf8');
let reportMutation=()=>{};
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.hidden=false;this._textContent='';this.parentElement=null;this.listeners={};this.captureListeners={};}
 get textContent(){return this._textContent;}
 set textContent(value){this._textContent=String(value);reportMutation(this);}
 append(...nodes){for(const node of nodes){this.children.push(node);node.parentElement=this;}reportMutation(this);}
 insertBefore(node,before){const index=this.children.indexOf(before);this.children.splice(index<0?this.children.length:index,0,node);node.parentElement=this;}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 addEventListener(name,fn,capture=false){(capture?this.captureListeners:this.listeners)[name]=fn;}
 fire(name,event={}){const dispatched={target:this,preventDefault(){},...event};this.captureListeners[name]?.(dispatched);this.listeners[name]?.(dispatched);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 querySelectorAll(selector){const found=[];const matches=node=>selector.split(',').some(part=>{
  part=part.trim();if(part==='*')return true;
  const item=part.match(/^\.([\w-]+)(?:\[data-item-id\])?$/);if(item)return node.className?.split(/\s+/).includes(item[1])&&(!part.includes('[data-item-id]')||node.dataset.itemId!==undefined);
  if(part==='.menu-cat')return node.className==='menu-cat';
  if(part==='.menu-item[data-item-id]')return node.className==='menu-item'&&node.dataset.itemId!==undefined;
  if(part==='h3')return node.tagName==='H3';return false;
 });
  const visit=node=>{for(const child of node.children){if(matches(child))found.push(child);visit(child);}};visit(this);return found;
 }
 closest(selector){for(let node=this;node;node=node.parentElement){if(selector==='.menu-item[data-item-id]'&&node.className==='menu-item'&&node.dataset.itemId!==undefined)return node;if(selector==='.cafe-favorite-toggle'&&node.className==='cafe-favorite-toggle')return node;if(selector==='a'&&node.tagName==='A')return node;}return null;}
}
function fixture(initial,{integrated=true,beforeMount}={}){
 const data=new Map(initial?[["start:cafe-favorites:v1",initial]]:[]),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,String(value))};
 const host=new Element(),wrapper=new Element(),categories=new Element(),list=new Element(),search=new Element('input');search.value='';host.querySelector=selector=>selector==='#menu-list'?list:selector==='#menu-categories'?categories:selector==='#menu-search'?search:null;wrapper.append(categories,list);host.append(wrapper);
 let observerCallback,observing=false,pending=false,calls=0;class Observer{constructor(fn){observerCallback=fn;}observe(){observing=true;}disconnect(){observing=false;}}
 reportMutation=node=>{if(!observing)return;for(let parent=node;parent;parent=parent.parentElement)if(parent===list){pending=true;return;}};
 const body=new Element('body');body.classList={contains:value=>integrated&&value==='cafe-integrated'};const context={window:{},document:{body,createElement:tag=>new Element(tag)},localStorage:storage,MutationObserver:Observer};runInNewContext(source,context);
 const add=(section,id,name)=>{const card=new Element('article');card.className='menu-item';card.dataset.itemId=id;const heading=new Element('h3');heading.textContent=name;card.append(heading);section.append(card);return card;};
 const section=(id='drinks')=>{const node=new Element('section');node.className='menu-cat';node.id=id;list.append(node);return node;};
 beforeMount?.(categories);const mount=context.window.STARTCafeFavorites.mount(host);
 const flushObserver=()=>{calls=0;while(pending&&calls<10){pending=false;calls++;observerCallback();}return {calls,pending};};
 return {host,wrapper,categories,list,search,storage,data,add,section,mount,observer:()=>observerCallback,flushObserver};
}

test('favorites persist by stable ID and filter only the rendered catalog',()=>{
 const f=fixture();const drinks=f.section();const coffee=f.add(drinks,'coffee','Кофе'),tea=f.add(drinks,'tea','Чай');tea.hidden=true;const hiddenCategory=f.section('hidden-category'),hiddenCard=f.add(hiddenCategory,'hidden','Скрытая позиция');hiddenCard.hidden=true;f.observer()();
 const star=coffee.querySelector('.cafe-favorite-toggle');assert.equal(star.getAttribute('aria-label'),'В избранное: Кофе');
 f.list.listeners.click({target:star});assert.equal(star.getAttribute('aria-label'),'Убрать из избранного: Кофе');
 assert.equal(f.storage.getItem('start:cafe-favorites:v1'),'["coffee"]');
 const button=f.wrapper.querySelector('.cafe-favorites-filter');button.fire('click');
 assert.equal(coffee.hidden,false);assert.equal(tea.hidden,true);
 const sectionLink=new Element('a');f.categories.append(sectionLink);f.categories.fire('click',{target:sectionLink});assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(tea.hidden,true);assert.equal(hiddenCard.hidden,true);assert.equal(hiddenCategory.hidden,true);
 const next=fixture(f.storage.getItem('start:cafe-favorites:v1'));const rerendered=next.section();const saved=next.add(rerendered,'coffee','Кофе');next.observer()();assert.equal(saved.querySelector('.cafe-favorite-toggle').getAttribute('aria-pressed'),'true');
});

test('favorites mutation observer settles instead of rewriting controls forever',()=>{
 const f=fixture();const section=f.section(),card=f.add(section,'coffee','Кофе');
 const settled=f.flushObserver();assert.equal(settled.pending,false);assert.ok(settled.calls<=2);
 const favorite=card.querySelector('.cafe-favorite-toggle');assert.ok(favorite);assert.equal(favorite.textContent,'☆');
});

test('leaving favorites reveals a category before the composer bubble handler scrolls to it',()=>{
 let categoryHiddenAtScroll;
 const f=fixture(undefined,{beforeMount:categories=>categories.addEventListener('click',event=>{
  if(event.target.closest('a'))categoryHiddenAtScroll=event.target.section.hidden;
 })});
 const favoriteSection=f.section('favorites'),favorite=f.add(favoriteSection,'favorite','Кофе');
 const otherSection=f.section('other'),other=f.add(otherSection,'other','Чай');
 f.list.listeners.click({target:favorite});
 const filter=f.wrapper.querySelector('.cafe-favorites-filter');filter.fire('click');assert.equal(otherSection.hidden,true);
 const link=new Element('a');link.section=otherSection;f.categories.append(link);f.categories.fire('click',{target:link});
 assert.equal(categoryHiddenAtScroll,false);assert.equal(filter.getAttribute('aria-pressed'),'false');assert.equal(otherSection.hidden,false);
});

test('favorites retain unavailable IDs, cap additions at 40, and tolerate malformed or unavailable storage',()=>{
 const existing=JSON.stringify(['out-of-stock',...Array.from({length:39},(_,i)=>'old-'+i)]);const f=fixture(existing);const section=f.section();const candidate=f.add(section,'new','Новый');f.observer()();
 f.list.listeners.click({target:candidate.querySelector('.cafe-favorite-toggle')});assert.equal(JSON.parse(f.storage.getItem('start:cafe-favorites:v1')).length,40);assert.ok(JSON.parse(f.storage.getItem('start:cafe-favorites:v1')).includes('out-of-stock'));
 const full=f.add(section,'another','Ещё один');f.observer()();f.list.listeners.click({target:full.querySelector('.cafe-favorite-toggle')});assert.equal(JSON.parse(f.storage.getItem('start:cafe-favorites:v1')).length,40);
 const malformed=fixture('{bad json');const badSection=malformed.section();const valid=malformed.add(badSection,'valid','Товар');malformed.observer()();assert.equal(valid.querySelector('.cafe-favorite-toggle').getAttribute('aria-pressed'),'false');
 const broken=fixture();broken.storage.setItem=()=>{throw Error('quota');};const brokenSection=broken.section();const usable=broken.add(brokenSection,'usable','Доступный');broken.observer()();broken.list.listeners.click({target:usable.querySelector('.cafe-favorite-toggle')});assert.equal(usable.querySelector('.cafe-favorite-toggle').getAttribute('aria-pressed'),'true');
});

test('favorites do not mount outside the integrated staff surface',()=>{
 const f=fixture(undefined,{integrated:false});assert.equal(f.mount,null);assert.equal(f.wrapper.querySelector('.cafe-favorites-tools'),null);
});
