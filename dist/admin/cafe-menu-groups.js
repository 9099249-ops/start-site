(()=>{'use strict';
 const mounted=new WeakMap(),groups=[['coffee','Кофе'],['tea','Чай'],['food','Еда'],['fridge','Холодильник'],['bar','Бар'],['icecream','Мороженое'],['hookah','Кальяны']];
 const norm=x=>String(x||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
 const classify=(category,item)=>{const c=norm(category),n=norm(item),both=c+' '+n;
  if(/кальян|hookah/.test(c))return 'hookah';if(/суп|пицц|закуск|пельмен|сырник|десерт|soup|pizza|snack|dumpling|dessert/.test(c))return 'food';
  if(/морожен|ice.?cream/.test(c))return 'icecream';if(/кофе|какао|cocoa|coffee/.test(c))return 'coffee';if(/чай|tea/.test(c))return 'tea';
  if(/холодильник|бутыл|баноч|bottled|canned/.test(c))return 'fridge';
  if(/смузи|квас разливн|фреш|лимонад|свежевыжат|разливн|приготовленн.*коктейл|коктейл|smoothie|fresh|lemonade|draft|prepared cocktail/.test(n))return 'bar';
  if(/бар|лимонад|смузи|фреш|квас разливн|smoothie|lemonade|fresh|draft/.test(c))return 'bar';
  if(/холодные напитки|cold drinks/.test(c))return 'mixed-cold';
  if(/холодн|напит|вода|сок|газиров|баноч|бутыл|безалкогольн.*пив|cold|drink|water|juice|soda|canned|bottled|non.?alcoholic beer/.test(both))return 'fridge';return null;};
 window.STARTCafeMenuGroups={mount(host){if(!host||!document.body.classList.contains('cafe-integrated'))return null;if(mounted.has(host))return mounted.get(host);
  const list=host.querySelector('#menu-list'),nav=host.querySelector('#menu-categories'),search=host.querySelector('#menu-search');if(!list||!nav)return null;
  function group(){const sections=[...list.querySelectorAll('.menu-cat')],originals=sections.filter(s=>!s.dataset.menuGroup);
   const emptyMenu=!sections.length&&!search?.value?.trim()&&list.firstElementChild?.tagName==='P'&&list.firstElementChild.textContent==='Ничего не найдено';
   if(!originals.length&&!emptyMenu)return;
   const map=new Map();for(const [key,title] of groups){const section=document.createElement('section');section.className='menu-cat staff-menu-group';section.id='staff-menu-'+key;section.dataset.menuGroup=key;const h=document.createElement('h2');h.textContent=title;const grid=document.createElement('div');grid.className='menu-grid';section.append(h,grid);map.set(key,{section,grid});}
   const ensureOther=()=>{if(map.has('other'))return map.get('other');const section=document.createElement('section');section.className='menu-cat staff-menu-group';section.id='staff-menu-other';section.dataset.menuGroup='other';const h=document.createElement('h2');h.textContent='Другое';const grid=document.createElement('div');grid.className='menu-grid';section.append(h,grid);const entry={section,grid};map.set('other',entry);return entry;};
   for(const original of originals){const category=original.querySelector('h2')?.textContent||'',sourceKey=classify(category,''),cards=[...original.querySelectorAll('.menu-item[data-item-id]')];
    if(sourceKey==='food'||!sourceKey){const sub=document.createElement('section');sub.className='menu-subcategory';sub.id=original.id;sub.dataset.sourceCategoryId=original.id;const h=document.createElement('h3');h.textContent=category;const grid=document.createElement('div');grid.className='menu-grid';sub.append(h,grid);if(sourceKey==='food'){for(const card of cards)grid.append(card);map.get('food').grid.append(sub);}else{for(const card of cards){const key=classify('',card.querySelector('h3')?.textContent||'');if(!key){const other=ensureOther();let fallback=[...other.grid.children].find(child=>child.dataset.sourceCategoryId===original.id);if(!fallback){fallback=document.createElement('section');fallback.className='menu-subcategory';fallback.id=original.id;fallback.dataset.sourceCategoryId=original.id;const heading=document.createElement('h3');heading.textContent=category;const fallbackGrid=document.createElement('div');fallbackGrid.className='menu-grid';fallback.append(heading,fallbackGrid);other.grid.append(fallback);}fallback.querySelector('.menu-grid').append(card);}else map.get(key).grid.append(card);}}continue;}
    for(const card of cards){const key=sourceKey==='mixed-cold'?classify('',card.querySelector('h3')?.textContent||'')||'fridge':sourceKey;map.get(key||'other')?.grid.append(card);}
   }
   const query=norm(search?.value?.trim()),links=[];for(const [key,title] of groups){const entry=map.get(key),cards=[...entry.grid.querySelectorAll('.menu-item[data-item-id]')];entry.section.hidden=!!query&&!cards.length;
    for(const sub of entry.grid.querySelectorAll('.menu-subcategory'))sub.hidden=!!query&&!sub.querySelectorAll('.menu-item[data-item-id]').length;
    if(!cards.length&&!query){const empty=document.createElement('p');empty.className='menu-group-empty';empty.textContent='Нет доступных товаров';entry.grid.append(empty);}const a=document.createElement('a');a.textContent=title;a.href='#'+entry.section.id;if(!entry.section.hidden)links.push(a);}
   if(map.has('other')){const entry=map.get('other'),cards=[...entry.grid.querySelectorAll('.menu-item[data-item-id]')];entry.section.hidden=!!query&&!cards.length;const a=document.createElement('a');a.textContent='Другое';a.href='#'+entry.section.id;if(!entry.section.hidden)links.push(a);}
   const ordered=groups.map(([key])=>map.get(key).section);if(map.has('other'))ordered.push(map.get('other').section);originals.forEach(s=>s.remove());list.replaceChildren(...ordered);nav.replaceChildren(...links);
  }
  group();const observer=new MutationObserver(group);observer.observe(list,{childList:true,subtree:true});const api={disconnect(){observer.disconnect();mounted.delete(host);}};mounted.set(host,api);return api;
 }};
})();
