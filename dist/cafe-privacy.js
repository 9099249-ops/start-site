(()=>{'use strict';
 let dialog,content,controller;
 document.addEventListener('click',event=>{
  const link=event.target.closest?.('#cafe-consent a[href="/privacy.html"]');
  if(!link||event.button||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||!window.HTMLDialogElement)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(!dialog){dialog=document.createElement('dialog');dialog.className='cafe-privacy-dialog';dialog.setAttribute('aria-label','Политика конфиденциальности');const heading=document.createElement('h2');heading.textContent='Политика конфиденциальности';const close=document.createElement('button');close.type='button';close.className='cafe-secondary';close.textContent='Вернуться к заказу';close.onclick=()=>dialog.close();content=document.createElement('div');content.className='cafe-privacy-content';content.setAttribute('aria-live','polite');dialog.append(heading,content,close);document.body.append(dialog);dialog.addEventListener('close',()=>{controller?.abort();link.focus();});}
  if(!dialog.open)dialog.showModal();
  if(content.dataset.loaded)return;
  content.textContent='Загрузка политики…';controller?.abort();controller=new AbortController();
  fetch('/privacy.html',{signal:controller.signal}).then(async response=>{if(!response.ok)throw Error('load');const page=new DOMParser().parseFromString(await response.text(),'text/html'),main=page.querySelector('main');if(!main)throw Error('load');for(const node of main.querySelectorAll('script,iframe,form,h1'))node.remove();for(const a of main.querySelectorAll('a[href="/"]'))a.closest('p')?.remove();content.replaceChildren(...main.childNodes);content.dataset.loaded='1';}).catch(error=>{if(error.name==='AbortError')return;content.replaceChildren(document.createTextNode('Не удалось загрузить политику. Заказ сохранён в открытой форме. '));const fallback=document.createElement('a');fallback.href='/privacy.html';fallback.target='_blank';fallback.rel='noopener';fallback.textContent='Открыть политику в отдельной вкладке';content.append(fallback);});
 },true);
})();
