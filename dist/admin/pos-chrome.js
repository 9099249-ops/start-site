/* Presentation only: existing cash, guest-account and print actions are reused. */
(()=>{'use strict';
 document.body.classList.add('pos-redesign');
 if(parent!==window){document.body.classList.add('pos-has-utility');return;}
 const bar=document.querySelector('.work-bar');if(!bar)return;
 bar.querySelector('button:not(.pos-toggle)')?.classList.add('work-shift-action');
 [...bar.children].find(n=>n.tagName==='SPAN'&&!n.classList.contains('work-error'))?.classList.add('work-identity');
 const footer=document.createElement('footer');footer.className='station-utility';footer.setAttribute('aria-label','Касса и счета станции');footer.hidden=true;
 const error=document.createElement('span');error.className='station-utility-error';error.setAttribute('role','status');
 const icons={cash:'<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 7V3h10v4M3 12h18M8 16h2"/>',guests:'<path d="M7 3h10v18H7zM10 7h4M10 11h4M10 15h4"/>'};
 function action(label,icon,fn){const b=document.createElement('button'),text=document.createElement('span');b.type='button';b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7">'+icons[icon]+'</svg>';text.textContent=label;b.append(text);b.onclick=async()=>{if(b.disabled)return;b.disabled=true;error.textContent='';try{await fn();}catch(e){error.textContent=e.message||'Не удалось открыть раздел.';}finally{b.disabled=false;}};footer.append(b);return {button:b,text};}
 const cash=action('Наличные в кассе: —','cash',()=>window.STARTGuests.cash());
 const guests=action('Счета гостей','guests',()=>window.STARTGuests.show());
 guests.button.dataset.guestCountButton='1';
 const print=document.createElement('div');print.className='station-utility-print';footer.append(print,error);document.body.append(footer);
 window.STARTPrint?.mountReport(print);const printButton=print.querySelector('button');if(printButton)printButton.textContent='Печать отчёта';
 const activePage=()=>['/admin/','/admin/cafe/'].includes(location.pathname)&&!new URLSearchParams(location.search).has('settings');
 let busy=false,again=false,last=0;
 function fit(){document.documentElement.style.setProperty('--pos-footer-height',(footer.hidden?0:footer.offsetHeight)+'px');}
 function visible(){const enabled=!bar.hidden&&activePage();footer.hidden=!enabled;document.body.classList.toggle('pos-has-utility',enabled);fit();if(enabled)refresh();}
 async function read(path){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const r=await fetch('/api/admin/'+path,{cache:'no-store',signal:controller.signal});if(!r.ok)throw Error('Данные временно недоступны');return await r.json();}finally{clearTimeout(timer);}}
 async function refresh(force=false){if(document.hidden||footer.hidden)return;if(busy){if(force)again=true;return;}if(!force&&Date.now()-last<30000)return;busy=true;last=Date.now();try{
  const [balance,accounts]=await Promise.allSettled([read('cash-ledger'),read('guest-bills')]);
  if(balance.status==='fulfilled'){const d=balance.value;cash.text.textContent=!d.shift?'Рабочий день не открыт':'Наличные в кассе: '+(d.balanceCents/100).toLocaleString('ru-RU')+' ₽';cash.button.title=d.shift?.closed?'Итог дня сохранён. Остаток наличных продолжает учитывать движения денег.':d.unknownPayments?'Есть оплаты без указанного способа. Откройте кассу для сверки.':'Расчётный остаток. Открыть движения денег';cash.button.classList.toggle('is-stale',false);}
  else{cash.text.textContent='Наличные: нет свежих данных';cash.button.title='Проверьте связь. Открыть кассу';cash.button.classList.add('is-stale');}
  if(accounts.status==='fulfilled'){window.STARTGuests?.updateCount(accounts.value.items.length);guests.button.title='Открытые счета гостей';}
  else{guests.button.title='Количество счетов пока не обновлено';}
 }finally{busy=false;if(again){again=false;refresh(true);}}}
 new ResizeObserver(fit).observe(footer);
 new MutationObserver(visible).observe(bar,{attributes:true,attributeFilter:['hidden']});
 const frames=document.querySelector('#workspace-frames');if(frames)new MutationObserver(visible).observe(frames,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
 addEventListener('popstate',visible);addEventListener('resize',fit);document.addEventListener('visibilitychange',()=>{visible();refresh(true);});document.addEventListener('station-updated',()=>refresh(true));setInterval(refresh,30000);visible();
})();
