(()=>{'use strict';
let loading;
window.openCafeComposer=()=>loading||(loading=(async()=>{
 const host=document.querySelector('#compose');
 try{
  const response=await fetch('/cafe/?compose-template=1',{cache:'no-store'});
  if(!response.ok)throw Error('Не удалось загрузить форму заказа.');
  const page=new DOMParser().parseFromString(await response.text(),'text/html');
  const layout=document.createElement('div');layout.className='compose-layout';
  const original=page.querySelector('.cafe-wrap'),menu=document.createElement('div');menu.className='cafe-wrap';menu.append(...original.childNodes);const cart=page.querySelector('#cart-dialog');
  if(!menu||!cart)throw Error('Форма заказа недоступна.');
  const categories=menu.querySelector('#menu-categories'),content=document.createElement('div');content.className='compose-menu-content';
  content.append(...[...menu.childNodes].filter(node=>node!==categories));menu.replaceChildren(categories,content);
  layout.append(menu,cart);host.replaceChildren(layout);
  for(const id of ['cart-button','dish-dialog','receipt-dialog'])host.append(page.getElementById(id));
  host.querySelectorAll('[data-close]').forEach(e=>{e.removeAttribute('data-close');e.setAttribute('data-cafe-close','');});
  const form=host.querySelector('#checkout'),extra=document.createElement('details'),summary=document.createElement('summary');
  extra.id='checkout-extra';summary.textContent='Дополнительно';extra.append(summary);
  const contact=host.querySelector('#checkout-contact'),timing=form.elements.timing.closest('.cafe-form-grid'),comment=form.elements.comment.closest('label');
  extra.append(contact,timing,comment);form.querySelector('#checkout-summary').before(extra);
  host.querySelector('#clear-cart').textContent='Сбросить';host.querySelector('#clear-cart').setAttribute('aria-label','Сбросить заказ');
  const script=document.createElement('script');script.src='/cafe.js?v=checkout-groups-20261004';
  await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('Не удалось загрузить оформление заказа.'));document.head.append(script);});
  if(await window.cafeComposerReady===false)throw Error('Не удалось загрузить меню. Нажмите «Новый заказ», чтобы повторить.');

  // Reuse the existing controls and their handlers in one compact workspace row.
  const tabs=document.querySelector('#cabinet>.tabs'),search=host.querySelector('.cafe-search');
  if(tabs&&search){const toolbar=document.createElement('div');toolbar.className='cafe-pos-toolbar';tabs.before(toolbar);toolbar.append(tabs,search);for(const control of [...tabs.querySelectorAll('button'),...search.querySelectorAll('button')])for(const node of control.childNodes)if(node.nodeType===3)node.textContent=node.textContent.replace(/^\+\s*/, '');}
  const heading=document.createElement('div');heading.className='cart-heading';
  cart.querySelector('h2').remove();cart.setAttribute('aria-label','Заказ кафе');
  heading.append(cart.querySelector('.cart-reset-actions'));cart.querySelector('.cafe-close').after(heading);
  const scroll=document.createElement('div'),footer=document.createElement('div');scroll.className='cart-scroll';footer.className='cart-footer';
  const lines=host.querySelector('#cart-lines');scroll.append(lines,form);
  const deliverGroup=document.createElement('section'),workGroup=document.createElement('section'),deliverRow=document.createElement('div'),workRow=document.createElement('div');
  deliverGroup.className='checkout-group checkout-deliver';deliverGroup.setAttribute('role','group');deliverGroup.setAttribute('aria-label','Сразу выдать');
  workGroup.className='checkout-group checkout-work';workGroup.setAttribute('role','group');workGroup.setAttribute('aria-label','В работу');
  deliverRow.className=workRow.className='checkout-actions';
  const deliverHeading=document.createElement('h3'),workHeading=document.createElement('h3');deliverHeading.textContent='Сразу выдать';workHeading.textContent='В работу';
  deliverGroup.append(deliverHeading,deliverRow);workGroup.append(workHeading,workRow);
  for(const id of ['checkout-summary','checkout-error'])footer.append(scroll.querySelector('#'+id));
  footer.append(deliverGroup,workGroup);
  const primaryAction=document.createElement('div');primaryAction.className='checkout-primary';footer.append(primaryAction);
  const checkoutButton=scroll.querySelector('#checkout-button'),prepareButton=scroll.querySelector('#prepare-order');
  for(const [button,row,label] of [[checkoutButton,deliverRow,'Картой, сразу выдать'],[prepareButton,workRow,'Картой, в работу']]){button.setAttribute('form','checkout');button.setAttribute('aria-label',label);row.append(button);}
  cart.append(scroll,footer);

  // The select remains the source of truth. Buttons only present its current options
  // and dispatch the same change event, including all original field visibility rules.
  const fulfillment=form.elements.fulfillment,fulfillmentLabel=fulfillment.closest('label'),choices=document.createElement('div');
  choices.className='cafe-fulfillment-choices';choices.setAttribute('role','group');choices.setAttribute('aria-label','Как получить');
  fulfillmentLabel.classList.add('cafe-fulfillment-source');scroll.prepend(choices);
  const table=form.elements.placeId;for(const option of table.options)if(!option.value){option.textContent='Номер стола';option.hidden=true;}
  const tableLabel=host.querySelector('#staff-place-label');if(tableLabel?.firstChild?.nodeType===3)tableLabel.firstChild.textContent='';table.setAttribute('aria-label','Номер стола');
  host.querySelector('#location-title').hidden=true;form.elements.location.setAttribute('aria-label','Место или ориентир');
  const shortLabels={pickup:'В кафе',lounge:'Стол / лаунж',house:'Домик',yacht:'Яхта / катер'};
  const newOrder=!new URLSearchParams(location.search).has('append'),omittedFulfillments=new Set(newOrder?['house','yacht']:[]);
  const notice=document.createElement('p');notice.className='cafe-muted';notice.setAttribute('role','status');notice.hidden=true;choices.after(notice);
  let normalizing=false,removedExtra=false,removedComplimentary=false,updateEmployee=()=>{};
  if(newOrder){
   extra.hidden=true;
   cart.classList.add('cafe-compact-order');scroll.before(choices,notice);scroll.after(form);
   // Keep an explicit empty choice in saved drafts until the operator chooses
   // a supported destination. A form reset still returns to the usual pickup.
   const empty=new Option('Выберите способ получения','');empty.hidden=true;fulfillment.append(empty);
   // The shared refresh also locks restored pending requests on small screens.
   // Those requests must retain their original destination and retry payload.
   form.onchange();
  }
  function syncFulfillment(){
   if(normalizing)return;
   for(const option of fulfillment.options)if(omittedFulfillments.has(option.value)){if(!option.hidden)option.hidden=true;if(!option.disabled)option.disabled=true;}
   if(newOrder&&!fulfillment.disabled){
    let changed=false;
    if(form.elements.freeReason?.value==='employee'&&(fulfillment.value!=='pickup'||table.value)){
     fulfillment.value='pickup';table.value='';changed=true;
    }
    if(omittedFulfillments.has(fulfillment.value)){
     fulfillment.value='';for(const name of ['house','yacht','location','placeId'])form.elements[name].value='';changed=true;
    }
    // Additional fields are absent from new staff orders. Do not let an old
    // invisible schedule, contact or comment affect the next order.
    for(const [name,value] of Object.entries({name:'',phone:'',comment:'',location:'',timing:'asap',requestedAt:''})){
     if(form.elements[name].value!==value){form.elements[name].value=value;removedExtra=true;changed=true;}
    }
    if(form.elements.freeReason&&['owner','guest'].includes(form.elements.freeReason.value)){
     form.elements.freeReason.value='';form.elements.freeComment.value='';removedComplimentary=true;changed=true;
    }
    if(changed){normalizing=true;try{fulfillment.dispatchEvent(new Event('change',{bubbles:true}));}finally{normalizing=false;}}
   }
   const needsChoice=newOrder&&!fulfillment.disabled&&!fulfillment.value,pendingDelivery=newOrder&&fulfillment.disabled&&omittedFulfillments.has(fulfillment.value);
   notice.hidden=!needsChoice&&!pendingDelivery&&!removedExtra&&!removedComplimentary;
   notice.textContent=[needsChoice?'Доставка в домик или на яхту недоступна в новом заказе администратора. Выберите способ получения.':'',pendingDelivery?'Предыдущая отправка: '+(fulfillment.selectedOptions[0]?.textContent||'доставка')+'. Повторная проверка сохранит прежние условия заказа.':'',removedExtra?'Дополнительные поля черновика сброшены. Заказ оформляется на ближайшее время.':'',removedComplimentary?'Прежний вариант «За счёт заведения» сброшен. Проверьте сумму или выберите сотрудника.':''].filter(Boolean).join(' ');
   const options=[...fulfillment.options].filter(option=>!option.hidden),current=[...choices.children];
   if(options.length!==current.length||options.some((option,index)=>current[index]?.dataset.value!==option.value)){
    choices.replaceChildren(...options.map(option=>{const button=document.createElement('button');button.type='button';button.dataset.value=option.value;button.textContent=shortLabels[option.value]||option.textContent;button.setAttribute('aria-label',option.textContent);button.onclick=()=>{if(fulfillment.disabled||option.disabled)return;if(newOrder&&form.elements.freeReason?.value){if(form.elements.freeReason.disabled)return;form.elements.freeReason.value='';form.elements.freeComment.value='';}fulfillment.value=option.value;fulfillment.dispatchEvent(new Event('change',{bubbles:true}));};return button;}));
   }
   for(const button of choices.children){const option=options.find(option=>option.value===button.dataset.value);button.disabled=fulfillment.disabled||option.disabled;button.setAttribute('aria-pressed',String(!(newOrder&&form.elements.freeReason?.value)&&button.dataset.value===fulfillment.value));}
   if(newOrder&&fulfillment.value==='lounge')host.querySelector('#location-title').textContent='Место / ориентир';
   updateEmployee();
  }
  form.addEventListener('submit',event=>{
   syncFulfillment();
   if(newOrder&&!fulfillment.disabled&&(!fulfillment.value||omittedFulfillments.has(fulfillment.value))){event.preventDefault();event.stopImmediatePropagation();choices.scrollIntoView({block:'nearest'});choices.querySelector('button:not(:disabled)')?.focus();}
  },true);
  form.addEventListener('change',syncFulfillment);form.addEventListener('reset',()=>requestAnimationFrame(()=>{removedExtra=false;removedComplimentary=false;syncFulfillment();}));
  new MutationObserver(syncFulfillment).observe(fulfillment,{attributes:true,childList:true,subtree:true});
  new MutationObserver(syncFulfillment).observe(lines,{childList:true});syncFulfillment();

  // Use the original accounting fields and pending locks for a one-tap
  // employee order. The recipient is the signed-in employee.
  const freeOptions=form.querySelector('#free-order-options');
  if(newOrder&&freeOptions){
   const reason=form.elements.freeReason,recipient=form.elements.freeRecipient,freeComment=form.elements.freeComment;
   const compact=document.createElement('div'),employee=document.createElement('button'),source=document.createElement('div'),pending=document.createElement('p');
   form.dataset.quickEmployee='1';
   compact.id='free-order-options';compact.className='cafe-employee-order';employee.type='button';employee.textContent='Сотруднику';
   source.hidden=true;source.append(reason.closest('label'),recipient.closest('label'),freeComment.closest('label'));
   pending.className='cafe-muted';pending.setAttribute('role','status');pending.hidden=true;compact.append(employee,pending,source);freeOptions.replaceWith(compact);
   const orderOptions=document.createElement('div');orderOptions.className='cafe-order-options';form.prepend(orderOptions);orderOptions.append(choices,compact);scroll.before(form);
   const changed=()=>reason.dispatchEvent(new Event('change',{bubbles:true}));
   updateEmployee=()=>{
    const selected=reason.value==='employee';
    employee.textContent=reason.value==='owner'?'Владельцу':reason.value==='guest'?'Угощение гостю':'Сотруднику';
    employee.setAttribute('aria-pressed',String(!!reason.value));employee.disabled=reason.disabled||fulfillment.disabled;
    employee.title=selected?'Бесплатно сотруднику. Нажмите, чтобы вернуть обычную цену.':'Выдать бесплатно сотруднику';
    cart.classList.toggle('cafe-employee-selected',selected);
    pending.hidden=!employee.disabled||!reason.value;pending.textContent=pending.hidden?'':'Предыдущая отправка за счёт заведения. Условия сохранены.';
   };
   employee.onclick=()=>{
    if(employee.disabled)return;
    if(reason.value==='employee'){reason.value='';}else{recipient.value=recipient.dataset.staffId;if(!recipient.value){host.querySelector('#checkout-error').textContent='Не удалось определить сотрудника. Обновите страницу.';return;}reason.value='employee';delete form.dataset.cash;delete form.dataset.guestBill;const context=footer.querySelector('.guest-context');if(context)context.textContent='';}
    freeComment.value='';changed();
   };
   if(reason.value==='employee'&&!reason.disabled&&recipient.dataset.staffId){recipient.value=recipient.dataset.staffId;freeComment.value='';changed();}
   new MutationObserver(updateEmployee).observe(reason,{attributes:true});updateEmployee();
  }

  if(newOrder){
   const manualRegister=document.createElement('button'),manualDeliver=document.createElement('button');
   for(const button of [manualRegister,manualDeliver]){button.type='submit';button.classList.add('cafe-manual-action');button.setAttribute('form','checkout');}
   manualRegister.id='manual-register-order';manualRegister.textContent='Эквайринг вручную';manualRegister.setAttribute('aria-label','Эквайринг вручную, в работу');
   manualDeliver.id='manual-deliver-order';manualDeliver.textContent='Эквайринг вручную';manualDeliver.setAttribute('aria-label','Эквайринг вручную, сразу выдать');
   workRow.append(manualRegister);deliverRow.append(manualDeliver);
   const syncManual=()=>{
    const unavailable=!!form.elements.freeReason?.value||!!form.dataset.guestBill;
    manualRegister.disabled=checkoutButton.disabled;manualRegister.hidden=unavailable;
    manualDeliver.disabled=checkoutButton.disabled||prepareButton.disabled;manualDeliver.hidden=unavailable||prepareButton.hidden;
   };
   const manualObserver=new MutationObserver(syncManual);manualObserver.observe(checkoutButton,{attributes:true});manualObserver.observe(prepareButton,{attributes:true});form.addEventListener('change',syncManual);syncManual();
  }
  // Guest account actions can arrive after the composer loads. Keep the original
  // controls in their fulfillment rows and retain their checkout form association.
  function placeGuestActions(){
   const setAttribute=(button,name,value)=>{if(button.getAttribute(name)!==value)button.setAttribute(name,value);};
   const context=form.querySelector('.guest-context');
   if(context&&context.parentNode!==footer)footer.append(context);
   for(const button of form.querySelectorAll(':scope>button')){
    button.classList.add('cafe-guest-action');setAttribute(button,'form','checkout');
    if(button.parentElement!==footer)footer.append(button);
   }
   const checkout=form.querySelector('#checkout-button')||footer.querySelector('#checkout-button');
   const semantic=/провер|бесплат|в сч[её]т|дозаказ|заказ №|повтор/i.test(checkout.textContent);
   if(checkout){const outcome=prepareButton.hidden?'в работу':'сразу выдать';setAttribute(checkout,'aria-label',semantic?checkout.textContent+', '+outcome:'Картой, '+outcome);if(semantic){if(checkout.parentElement!==primaryAction)primaryAction.append(checkout);}else{const row=prepareButton.hidden?workRow:deliverRow;if(checkout.parentElement!==row)row.append(checkout);}}
   for(const [selector,row,label,visible] of [['#cash-deliver-order',deliverRow,'Наличными, сразу выдать','Наличными'],['#manual-deliver-order',deliverRow,'Эквайринг вручную, сразу выдать','Эквайринг вручную'],['#prepare-order',workRow,/^В работу$/i.test(prepareButton.textContent)?'Без оплаты, в работу':'Картой, в работу',null],['#cash-prepare-order',workRow,'Наличными, в работу','Наличными'],['#manual-register-order',workRow,'Эквайринг вручную, в работу','Эквайринг вручную']]){
    const button=form.querySelector(selector)||footer.querySelector(selector);if(button){setAttribute(button,'form','checkout');setAttribute(button,'aria-label',label);if(visible&&button.textContent!==visible)button.textContent=visible;if(button.parentElement!==row)row.append(button);}
   }
   const workCard=checkout.parentElement===workRow?checkout:prepareButton.hidden?null:prepareButton;
   for(const [row,order] of [[deliverRow,[checkout,form.querySelector('#cash-deliver-order')||footer.querySelector('#cash-deliver-order'),form.querySelector('#manual-deliver-order')||footer.querySelector('#manual-deliver-order')]],[workRow,[workCard,form.querySelector('#cash-prepare-order')||footer.querySelector('#cash-prepare-order'),form.querySelector('#manual-register-order')||footer.querySelector('#manual-register-order')]]]){
    const ordered=order.filter(button=>button?.parentElement===row);ordered.forEach((button,index)=>{if(row.children[index]!==button)row.insertBefore(button,row.children[index]||null);});
   }
   const cashDeliver=form.querySelector('#cash-deliver-order')||footer.querySelector('#cash-deliver-order'),cashWork=form.querySelector('#cash-prepare-order')||footer.querySelector('#cash-prepare-order');
   if(cashDeliver)cashDeliver.disabled=checkoutButton.disabled;
   if(cashWork)cashWork.disabled=prepareButton.hidden?checkoutButton.disabled:prepareButton.disabled;
   deliverGroup.hidden=[...deliverRow.children].every(button=>button.hidden);
   workGroup.hidden=[...workRow.children].every(button=>button.hidden);
   primaryAction.hidden=!primaryAction.children.length||primaryAction.children[0].hidden;
  }
  new MutationObserver(placeGuestActions).observe(form,{childList:true,subtree:true});new MutationObserver(placeGuestActions).observe(checkoutButton,{attributes:true,attributeFilter:['hidden','disabled'],childList:true,characterData:true,subtree:true});new MutationObserver(placeGuestActions).observe(prepareButton,{attributes:true,attributeFilter:['hidden','disabled']});placeGuestActions();
  // Size panels from their actual viewport position; embedded workspaces already
  // exclude the shared footer, while standalone pages expose its measured height.
  let fitFrame=0,menuLayoutDirty=true,categoryEntries=[];
  const fitCart=()=>{cancelAnimationFrame(fitFrame);fitFrame=requestAnimationFrame(()=>{
   if(host.hidden)return;
   const banner=host.querySelector('#guest-bill-banner'),bannerHeight=banner&&!banner.hidden?Math.ceil(banner.getBoundingClientRect().height)+'px':'0px';if(host.style.getPropertyValue('--guest-banner-height')!==bannerHeight)host.style.setProperty('--guest-banner-height',bannerHeight);
   const toolbar=document.querySelector('.cafe-pos-toolbar');
   if(toolbar){const height=Math.ceil(toolbar.getBoundingClientRect().height)+'px',offset=Math.ceil(toolbar.getBoundingClientRect().height+(parseFloat(getComputedStyle(toolbar).marginBottom)||0))+'px';if(layout.style.getPropertyValue('--cafe-toolbar-offset')!==offset)layout.style.setProperty('--cafe-toolbar-offset',offset);const cabinet=toolbar.parentElement;if(cabinet.style.getPropertyValue('--cafe-toolbar-height')!==height)cabinet.style.setProperty('--cafe-toolbar-height',height);const categoryHeight=matchMedia('(max-width:759px)').matches?Math.ceil(categories.getBoundingClientRect().height)+'px':'0px';if(cabinet.style.getPropertyValue('--cafe-category-height')!==categoryHeight)cabinet.style.setProperty('--cafe-category-height',categoryHeight);}
   const viewport=window.visualViewport,footerHeight=parseFloat(getComputedStyle(document.body).getPropertyValue('--pos-footer-height'))||0,bottom=(viewport?viewport.height+viewport.offsetTop:innerHeight)-footerHeight;
   const fit=(node,property,limit=bottom-10)=>{const value=Math.floor(Math.max(120,limit-Math.max(0,node.getBoundingClientRect().top)))+'px';if(node.style.getPropertyValue(property)!==value)node.style.setProperty(property,value);};
   if(matchMedia('(min-width:1100px)').matches&&cart.open)fit(cart,'--cart-available-height');else cart.style.removeProperty('--cart-available-height');
   if(matchMedia('(min-width:760px)').matches){
    const button=host.querySelector('#cart-button').getBoundingClientRect();
    const limit=innerWidth<1100&&button.height>0?Math.min(bottom-10,button.top-10):bottom-10;
    fit(categories,'--categories-available-height',limit);
   }else categories.style.removeProperty('--categories-available-height');
   if(menuLayoutDirty){compactCategories();menuLayoutDirty=false;}updateCategory();
  });};
  addEventListener('resize',()=>{menuLayoutDirty=true;fitCart();});addEventListener('scroll',fitCart,{passive:true});
  window.visualViewport?.addEventListener('resize',fitCart);window.visualViewport?.addEventListener('scroll',fitCart);
  new MutationObserver(fitCart).observe(host,{attributes:true,attributeFilter:['hidden']});
  new MutationObserver(fitCart).observe(cart,{attributes:true,attributeFilter:['open']});
  if(typeof ResizeObserver==='function'){const size=new ResizeObserver(fitCart);for(const item of document.querySelectorAll('.page-heading,.cafe-pos-toolbar,.desk-chrome,#cart-button,.station-utility'))size.observe(item);}
  // Keep small categories side by side without changing their menu order.
  function compactCategories(){
   const columns=innerWidth>=1280?4:3;
   const links=new Map([...categories.querySelectorAll('a')].map(link=>[link.getAttribute('href'),link]));
   categoryEntries=[...content.querySelectorAll('.menu-cat')].map(section=>{
    const count=section.querySelectorAll('.menu-item').length,span=String(Math.min(columns,count)||1),link=links.get('#'+section.id);
    if(section.style.getPropertyValue('--category-columns')!==span)section.style.setProperty('--category-columns',span);
    if(link&&link.dataset.count!==String(count))link.dataset.count=String(count);
    return {section,link};
   });
  }
  let activeCategory='';
  function updateCategory(){
   if(!categoryEntries.length){activeCategory='';return;}
   // Read geometry together before changing any attributes; scrolling must not
   // recount every dish or force a layout between each category link.
   const positions=categoryEntries.map(entry=>({...entry,top:entry.section.getBoundingClientRect().top}));
   const top=(parseFloat(getComputedStyle(positions[0].section).scrollMarginTop)||0)+10;
   let current=positions[0];
   for(const entry of positions){if(entry.top>top)break;if(entry.top>current.top+1||entry.section.id===activeCategory)current=entry;}
   const selected=positions.find(entry=>entry.section.id===activeCategory);
   if(selected&&Math.abs(selected.top-current.top)<1)current=selected;
   const changed=activeCategory!==current.section.id;activeCategory=current.section.id;
   let offset=0;
   if(changed&&current.link&&matchMedia('(min-width:760px)').matches){
    const r=current.link.getBoundingClientRect(),nav=categories.getBoundingClientRect();
    if(r.top<nav.top)offset=r.top-nav.top-8;else if(r.bottom>nav.bottom)offset=r.bottom-nav.bottom+8;
   }
   for(const {section,link} of categoryEntries){
    if(!link)continue;
    if(section.id===activeCategory){if(link.getAttribute('aria-current')!=='true')link.setAttribute('aria-current','true');}
    else if(link.hasAttribute('aria-current'))link.removeAttribute('aria-current');
   }
   if(offset)categories.scrollTop+=offset;
  }
  categories.addEventListener('click',e=>{
   const link=e.target.closest('a[href]');if(!link||!categories.contains(link))return;
   const section=categoryEntries.find(entry=>'#'+entry.section.id===link.getAttribute('href'))?.section;if(!section)return;
   e.preventDefault();activeCategory=section.id;section.scrollIntoView({block:'start',behavior:'instant'});fitCart();
  });
  new MutationObserver(()=>{menuLayoutDirty=true;fitCart();}).observe(categories,{childList:true});
  window.STARTGuests?.updateCafeContext();fitCart();

 }catch(e){loading=null;const message=e instanceof TypeError?'Нет связи. Не удалось загрузить меню. Нажмите «Новый заказ» для повторной загрузки.':e.message;host.textContent=message;throw Error(message);}
})());
})();
