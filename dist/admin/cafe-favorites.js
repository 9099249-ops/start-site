(()=>{'use strict';
 const KEY='start:cafe-favorites:v1',LIMIT=40,mounted=new WeakMap();
 function read(){try{const value=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(value)?[...new Set(value.filter(id=>typeof id==='string'&&id.length>0))].slice(0,LIMIT):[];}catch{return[];}}
 window.STARTCafeFavorites={mount(host){
  if(!host||!document.body.classList.contains('cafe-integrated'))return null;
  if(mounted.has(host))return mounted.get(host);
  const list=host.querySelector('#menu-list'),categories=host.querySelector('#menu-categories');if(!list||!categories)return null;
  const saved=new Set(read()),cardWasHidden=new WeakMap(),sectionWasHidden=new WeakMap();let active=false,applying=false;
  const toolbar=document.createElement('div');toolbar.className='cafe-favorites-tools';
  const filter=document.createElement('button');filter.type='button';filter.className='cafe-favorites-filter';filter.textContent='Избранное';filter.setAttribute('aria-pressed','false');filter.setAttribute('aria-label','Показать избранные товары');toolbar.append(filter);
  list.parentElement.insertBefore(toolbar,list);
  function text(node,value){if(node.textContent!==value)node.textContent=value;}
  function attr(node,name,value){if(node.getAttribute(name)!==value)node.setAttribute(name,value);}
  function persist(){try{localStorage.setItem(KEY,JSON.stringify([...saved].slice(0,LIMIT)));}catch{}}
  function apply(){if(applying)return;applying=true;try{
   for(const section of list.querySelectorAll('.menu-cat')){
    const cards=[...section.querySelectorAll('.menu-item[data-item-id]')];let shown=0,searchEligible=0;
    if(!sectionWasHidden.has(section))sectionWasHidden.set(section,section.hidden);
    for(const card of cards){const id=card.dataset.itemId;const favorite=saved.has(id);let button=card.querySelector('.cafe-favorite-toggle');
     if(!button){button=document.createElement('button');button.type='button';button.className='cafe-favorite-toggle';card.append(button);}
     const title=(favorite?'Убрать из избранного: ':'В избранное: ')+card.querySelector('h3')?.textContent?.trim();
     text(button,favorite?'★':'☆');if(button.title!==title)button.title=title;attr(button,'aria-label',title);attr(button,'aria-pressed',String(favorite));
     if(!cardWasHidden.has(card))cardWasHidden.set(card,card.hidden);
     const eligible=!cardWasHidden.get(card);if(eligible)searchEligible++;
     const visible=eligible&&(!active||favorite);if(card.hidden!==!visible)card.hidden=!visible;if(visible)shown++;
    }
    const emptyPlaceholder=section.dataset.menuGroup&&section.querySelector('.menu-group-empty');const visible=!sectionWasHidden.get(section)&&(searchEligible>0||!!emptyPlaceholder&&!active)&&(!active||shown>0);if(section.hidden!==!visible)section.hidden=!visible;
   }
   for(const sub of list.querySelectorAll('.menu-subcategory')){const cards=[...sub.querySelectorAll('.menu-item[data-item-id]')],eligible=cards.some(card=>!cardWasHidden.get(card));const visible=eligible&&(!active||cards.some(card=>!card.hidden));if(sub.hidden===visible)sub.hidden=!visible;}
   for(const empty of list.querySelectorAll('.menu-group-empty')){const group=empty.closest('.menu-cat[data-menu-group]');const visible=!!group&&!group.hidden&&!active;if(empty.hidden===visible)empty.hidden=!visible;}
   attr(filter,'aria-pressed',String(active));attr(filter,'aria-label',active?'Показать все товары':'Показать избранные товары');text(filter,active?'Все товары':'Избранное');
  }finally{applying=false;}}
  filter.addEventListener('click',()=>{active=!active;apply();});
  categories.addEventListener('click',event=>{if(event.target.closest('a')&&active){active=false;apply();}},true);
  list.addEventListener('click',event=>{const button=event.target.closest('.cafe-favorite-toggle');if(!button)return;const card=button.closest('.menu-item[data-item-id]');if(!card)return;const id=card.dataset.itemId;
   if(saved.has(id))saved.delete(id);else{if(saved.size>=LIMIT){filter.setAttribute('aria-label','Избранное заполнено: можно сохранить не более 40 товаров');return;}saved.add(id);}persist();apply();
  });
  const observer=new MutationObserver(()=>apply());observer.observe(list,{childList:true,subtree:true});apply();
  const api={disconnect(){observer.disconnect();toolbar.remove();mounted.delete(host);}};mounted.set(host,api);return api;
 }};
})();
