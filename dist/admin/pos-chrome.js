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
 const cash=action('Касса · —','cash',()=>{const account=document.querySelector('.work-bar .work-account');const day=[...(account?.querySelectorAll('button')||[])].find(b=>b.textContent==='Подвести и сохранить итог дня');if(day)day.hidden=false;if(account){let report=account.querySelector('.work-account-print');if(!report){report=document.createElement('div');report.className='work-account-print';account.append(report);}if(window.STARTPrint?.mountReport&&!report.dataset.mounted){window.STARTPrint.mountReport(report);report.dataset.mounted='true';}account.setAttribute('open','');account.querySelector('button:not([hidden])')?.focus();}});
 const guests=action('Счета гостей','guests',()=>window.STARTGuests.show());const guestCount=document.createElement('span');guestCount.className='station-guest-count';guestCount.hidden=true;guestCount.setAttribute('aria-hidden','true');guests.button.append(guestCount);
 const print=document.createElement('div');print.className='station-utility-print';footer.append(print,error);document.body.append(footer);window.STARTPrint?.mountReport(print);
 const activePage=()=>['/admin/','/admin/cafe/'].includes(location.pathname)&&!new URLSearchParams(location.search).has('settings');
 let busy=false,again=false,last=0,eligible=false,generation=0,authenticated=true;
 function fit(){document.documentElement.style.setProperty('--pos-footer-height',(footer.hidden?0:footer.offsetHeight)+'px');}
 function visible(){const enabled=!bar.hidden&&activePage()&&authenticated,changed=enabled!==eligible;if(changed){eligible=enabled;generation++;if(!enabled)hideGuestCount();}footer.hidden=!enabled;document.body.classList.toggle('pos-has-utility',enabled);fit();if(enabled)refresh(changed);return changed;}
 function hideGuestCount(){guestCount.textContent='';guestCount.hidden=true;guests.button.removeAttribute('aria-label');}
 async function read(path){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const r=await fetch('/api/admin/'+path,{cache:'no-store',signal:controller.signal});if(!r.ok)throw Error('Данные временно недоступны');return await r.json();}finally{clearTimeout(timer);}}
 async function refresh(force=false){if(document.hidden||footer.hidden||!eligible)return;if(busy){if(force)again=true;return;}if(!force&&Date.now()-last<30000)return;busy=true;last=Date.now();const requestGeneration=generation;try{
  const [balance,guestBills]=await Promise.allSettled([read('cash-ledger'),read('guest-bills/badge')]);
  if(balance.status==='fulfilled'){const d=balance.value;cash.text.textContent=(!d.shift?'Касса · день не открыт':'Касса · '+(d.balanceCents/100).toLocaleString('ru-RU')+' ₽')+(d.unknownPayments?' · нужна сверка':'');cash.button.title=d.unknownPayments?'Есть оплаты без указанного способа. Откройте кассу для сверки.':d.shift?.closed?'Итог дня сохранён. Остаток наличных продолжает учитывать движения денег.':'Расчётный остаток наличных';cash.button.classList.toggle('is-stale',!!d.unknownPayments);}
  else{cash.text.textContent='Касса · нет свежих данных';cash.button.title='Нет связи. Проверьте данные кассы';cash.button.classList.add('is-stale');}
  if(requestGeneration===generation&&eligible&&guestBills.status==='fulfilled'&&Number.isSafeInteger(guestBills.value?.count)&&guestBills.value.count>=0){const count=guestBills.value.count;guestCount.textContent=String(count);guestCount.hidden=count===0;if(count)guests.button.setAttribute('aria-label','Счета гостей: '+count);else guests.button.removeAttribute('aria-label');}else if(requestGeneration===generation&&eligible)hideGuestCount();
 }finally{busy=false;if(again){again=false;refresh(true);}}}
 new ResizeObserver(fit).observe(footer);
 new MutationObserver(visible).observe(bar,{attributes:true,attributeFilter:['hidden']});
 const frames=document.querySelector('#workspace-frames');if(frames)new MutationObserver(visible).observe(frames,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
 addEventListener('popstate',visible);addEventListener('resize',fit);document.addEventListener('visibilitychange',()=>{if(!visible())refresh(true);});document.addEventListener('station-updated',()=>refresh(true));document.addEventListener('station-session',e=>{if(e.detail?.authenticated===false){authenticated=false;visible();}else if(e.detail?.authenticated===true){authenticated=true;if(!visible())refresh(true);}});setInterval(refresh,30000);visible();
})();
