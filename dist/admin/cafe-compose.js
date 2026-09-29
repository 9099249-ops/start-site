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
  layout.append(menu,cart);host.replaceChildren(layout);
  for(const id of ['cart-button','dish-dialog','receipt-dialog'])host.append(page.getElementById(id));
  host.querySelectorAll('[data-close]').forEach(e=>{e.removeAttribute('data-close');e.setAttribute('data-cafe-close','');});
  const form=host.querySelector('#checkout'),extra=document.createElement('details'),summary=document.createElement('summary');
  extra.id='checkout-extra';summary.textContent='Дополнительно';extra.append(summary);
  const contact=host.querySelector('#checkout-contact'),timing=form.elements.timing.closest('.cafe-form-grid'),comment=form.elements.comment.closest('label');
  extra.append(contact,timing,comment);form.querySelector('#checkout-summary').before(extra);
  host.querySelector('#clear-cart').textContent='Сбросить заказ';
  const script=document.createElement('script');script.src='/cafe.js?v=cafe-tiles-1';
  await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('Не удалось загрузить оформление заказа.'));document.head.append(script);});
  if(await window.cafeComposerReady===false)throw Error('Не удалось загрузить меню. Нажмите «Новый заказ», чтобы повторить.');
  const scroll=document.createElement('div'),footer=document.createElement('div');scroll.className='cart-scroll';footer.className='cart-footer';scroll.append(host.querySelector('#cart-lines'),form);for(const id of ['checkout-summary','checkout-error','checkout-button','prepare-order']){const control=scroll.querySelector('#'+id);if(control.tagName==='BUTTON')control.setAttribute('form','checkout');footer.append(control);}cart.append(scroll,footer);
 }catch(e){loading=null;const message=e instanceof TypeError?'Нет связи. Не удалось загрузить меню. Нажмите «Новый заказ» для повторной загрузки.':e.message;host.textContent=message;throw Error(message);}
})());
})();
