(()=>{
 'use strict';
 const staffMenu=location.pathname.startsWith('/cafe/')&&new URLSearchParams(location.search).get('staff')==='1';
 if(!location.pathname.startsWith('/admin')&&!staffMenu)return;
 const nav=document.createElement('nav');nav.className='ops-nav';nav.setAttribute('aria-label','Разделы станции');
 const settingsPage=location.pathname.includes('/settings')||new URLSearchParams(location.search).has('settings');
 document.body.classList.toggle('settings-context',settingsPage);
 const active=settingsPage?'settings':location.pathname.includes('/tasks')?'tasks':location.pathname.includes('/purchase')?'purchase':location.pathname.includes('/cafe')?'cafe':'rental';
 const taskCount=document.createElement('span');taskCount.className='ops-task-count';taskCount.hidden=true;taskCount.setAttribute('aria-hidden','true');
 for(const [id,label,url] of [['rental','Прокат','/admin/'],['cafe','Кафе','/admin/cafe/#new'],['purchase','Закупка','/admin/purchase/'],['tasks','Дела','/admin/tasks/'],['settings','Настройки','/admin/settings/']]){const a=document.createElement('a');a.textContent=label;a.href=url;if(id==='tasks'){a.classList.add('ops-tasks-link');a.append(taskCount);}if(id===active)a.setAttribute('aria-current','page');nav.append(a);}const chrome=document.createElement('div');chrome.className='desk-chrome';chrome.append(nav);document.body.prepend(chrome);new ResizeObserver(()=>document.documentElement.style.setProperty('--desk-chrome-height',chrome.offsetHeight+'px')).observe(chrome);
 if(settingsPage&&!location.pathname.includes('/settings')){const back=document.createElement('a');back.href='/admin/settings/';back.className='settings-back';back.textContent='← Все настройки';document.querySelector('main')?.prepend(back);}
 const settingSection=new URLSearchParams(location.search).get('settings');
 if(settingSection){
  const css=document.createElement('link');css.rel='stylesheet';css.href='/admin/settings-context.css?v=1';document.head.append(css);
  const contextScript=document.createElement('script');contextScript.src='/admin/settings-context.js?v=1';document.head.append(contextScript);
 }
 if(typeof parent==='undefined'||parent===window){
 const voiceAlerts=document.createElement('script');voiceAlerts.src='/admin/voice-alerts.js?v=voice-alerts-20261006-1';document.head.append(voiceAlerts);
 function voiceSession(authenticated){window.STARTStationSession={authenticated};document.dispatchEvent(new CustomEvent('station-session',{detail:window.STARTStationSession}));}
 const brand=document.createElement('a');brand.className='pos-brand';brand.href='/admin/#work';brand.textContent='СТАРТ';nav.prepend(brand);const sync=document.createElement('span');sync.className='connection-state';sync.textContent='Подключение…';nav.append(sync);let syncedAt=0;document.addEventListener('desk-sync',e=>{if(e.detail.ok)syncedAt=Date.now();sync.classList.toggle('stale',!e.detail.ok);sync.textContent=e.detail.ok?'На связи':'Нет связи';sync.title=syncedAt?'Обновлено '+new Date(syncedAt).toLocaleTimeString('ru-RU'):'';});setInterval(()=>{if(syncedAt&&Date.now()-syncedAt>120000){sync.classList.add('stale');sync.textContent='Данные устарели';}},30000);
 const adminHeader=location.pathname.startsWith('/admin');
 const status=document.createElement('div');status.className='station-status';status.hidden=true;status.setAttribute('aria-label','Связь и время станции');if(adminHeader){status.append(sync);nav.append(status);}
 const clock=document.createElement('div'),date=document.createElement('span'),time=document.createElement('time');
 clock.className='station-clock';clock.title='Московское время';clock.append(date,time);status.append(clock);
 const dateFormat=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',weekday:'short',day:'numeric',month:'short'}),timeFormat=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
 function tick(){if(document.hidden)return;const now=new Date();date.textContent=dateFormat.format(now).replace(/\./g,'');time.textContent=timeFormat.format(now);time.dateTime=now.toISOString();}
 if(adminHeader){tick();setInterval(tick,15000);document.addEventListener('visibilitychange',tick);}
 const logout=document.querySelector('#logout')||document.createElement('button');logout.id='logout';logout.type='button';logout.textContent='Выход';logout.className='ops-logout';logout.hidden=true;logout.title='Выйти из учётной записи';nav.append(logout);
 const logoutError=document.createElement('p');logoutError.className='ops-logout-error';logoutError.hidden=true;logoutError.setAttribute('role','alert');nav.append(logoutError);
 logout.onclick=async()=>{if(logout.disabled)return;logout.disabled=true;logoutError.hidden=true;try{const r=await fetch('/api/admin/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});if(!r.ok&&r.status!==401)throw Error('Не удалось выйти. Повторите попытку.');setTaskAuth(null);voiceSession(false);location.replace('/admin/');}catch{logoutError.textContent='Не удалось выйти. Проверьте соединение и повторите.';logoutError.hidden=false;logout.disabled=false;}};

 let cafeAuthenticated=false,cafeBusy=false,cafeRefreshAgain=false;
 const cafeLink=nav.querySelector('a[href="/admin/cafe/#new"]');
 async function refreshCafeBadge(){
  if(!cafeAuthenticated||document.hidden)return;
  if(cafeBusy){cafeRefreshAgain=true;return;}cafeBusy=true;
  try{const r=await fetch('/api/admin/cafe/badge',{cache:'no-store'});if(r.status===401){cafeAuthenticated=false;cafeLink.textContent='Кафе';return;}if(!r.ok)return;const d=await r.json();if(!cafeAuthenticated)return;const count=d.count;cafeLink.textContent='Кафе'+(count?' · '+count:'');cafeLink.setAttribute('aria-label',count?'Кафе: заказов в работе — '+count:'Кафе');}
  catch{}finally{cafeBusy=false;if(cafeRefreshAgain){cafeRefreshAgain=false;refreshCafeBadge();}}
 }
 setInterval(refreshCafeBadge,15000);document.addEventListener('station-updated',refreshCafeBadge);document.addEventListener('visibilitychange',refreshCafeBadge);
 let taskUserId=null,taskAuthGeneration=0,taskAuthenticated=false,taskAllowed=false,taskBusy=false,taskRefreshAgain=false;
 function hideTaskBadge(){taskCount.hidden=true;taskCount.textContent='';taskLink.removeAttribute('aria-label');}
 const taskLink=nav.querySelector('.ops-tasks-link');
 function setTaskAuth(user){const id=user?String(user.id??user.login??''):null,allowed=!!user&&!user.scheduleOnly&&['admin','staff','waiter'].includes(user.role);if(id!==taskUserId||!!user!==taskAuthenticated||allowed!==taskAllowed){taskAuthGeneration++;taskUserId=id;taskAuthenticated=!!user;}taskAllowed=allowed;if(!allowed)hideTaskBadge();else refreshTaskBadge();}
 async function refreshTaskBadge(){if(!taskAllowed||!taskAuthenticated||document.hidden)return;if(taskBusy){taskRefreshAgain=true;return;}taskBusy=true;const generation=taskAuthGeneration;try{const r=await fetch('/api/admin/tasks/badge',{cache:'no-store'});if(generation!==taskAuthGeneration||!taskAllowed||!taskAuthenticated)return;if(r.status===401||r.status===403){taskAllowed=false;taskAuthenticated=false;taskUserId=null;taskAuthGeneration++;hideTaskBadge();return;}if(!r.ok){hideTaskBadge();return;}const d=await r.json();if(generation!==taskAuthGeneration||!taskAllowed||!taskAuthenticated)return;if(!Number.isSafeInteger(d.count)||d.count<0){hideTaskBadge();return;}taskCount.textContent=String(d.count);taskCount.hidden=d.count===0;if(d.count)taskLink.setAttribute('aria-label','Дела: невыполненных дел — '+d.count);else taskLink.removeAttribute('aria-label');}catch{if(generation===taskAuthGeneration)hideTaskBadge();}finally{taskBusy=false;if(taskRefreshAgain){taskRefreshAgain=false;refreshTaskBadge();}}}
 setInterval(refreshTaskBadge,15000);document.addEventListener('station-updated',refreshTaskBadge);document.addEventListener('visibilitychange',refreshTaskBadge);
 async function logoutVisibility(){if(document.hidden)return;try{const r=await fetch('/api/admin/session',{cache:'no-store'});if(r.ok){const session=await r.json();voiceSession(!!session.user&&!session.user.scheduleOnly);document.body.classList.toggle('schedule-only',!!session.user?.scheduleOnly);if(session.user?.scheduleOnly&&!location.pathname.startsWith('/admin/schedule')){setTaskAuth(null);window.top.location.replace('/admin/schedule/?standalone=1');return;}logout.hidden=!session.user;status.hidden=!session.user;cafeAuthenticated=!!session.user;if(cafeAuthenticated)refreshCafeBadge();else cafeLink.textContent="Кафе";setTaskAuth(session.user);document.dispatchEvent(new CustomEvent('desk-sync',{detail:{ok:true}}));}else{setTaskAuth(null);if(r.status===401||r.status===403){voiceSession(false);status.hidden=true;logout.hidden=true;cafeAuthenticated=false;}document.dispatchEvent(new CustomEvent('desk-sync',{detail:{ok:false}}));}}catch{setTaskAuth(null);document.dispatchEvent(new CustomEvent('desk-sync',{detail:{ok:false}}));}}
 logoutVisibility();setInterval(logoutVisibility,60000);document.addEventListener('visibilitychange',logoutVisibility);
 const loginPanel=document.querySelector('#login')||document.querySelector('#login-panel');if(loginPanel)new MutationObserver(logoutVisibility).observe(loginPanel,{attributes:true,attributeFilter:['hidden']});
 }
 const workspace=document.querySelector('#workspace');if(!workspace)return;
 const block=document.createElement('a');block.href='/admin/purchase/';block.className='purchase-summary';block.hidden=true;block.setAttribute('aria-label','Нужно купить — открыть закупку');(document.querySelector('#purchase-home')||workspace).append(block);
 let running=false,last=0;
 async function summary(){if(workspace.hidden||document.hidden||running||Date.now()-last<20000)return;running=true;try{const r=await fetch('/api/admin/inventory/summary?compact=1',{cache:'no-store'});if(!r.ok){block.hidden=true;return;}const d=await r.json();block.replaceChildren();const title=document.createElement('strong');title.textContent=d.items.length?'🛒 Нужно купить — '+(d.count??d.items.length)+' поз.':'Сейчас закупка не требуется';block.append(title);if(d.items.length){const list=document.createElement('ul');for(const i of d.items.slice(0,4)){const li=document.createElement('li');li.classList.toggle('urgent',i.urgent);li.textContent=i.name+' — '+(i.buyQuantity?'купить '+i.buyQuantity.replace('.',',')+' '+i.unit:'количество уточнить');list.append(li);}block.append(list);if((d.count??d.items.length)>4){const more=document.createElement('small');more.textContent='Все позиции →';block.append(more);}}block.hidden=false;last=Date.now();}catch{block.hidden=true;}finally{running=false;}}
 new MutationObserver(()=>{if(workspace.hidden)block.hidden=true;else summary();}).observe(workspace,{attributes:true,attributeFilter:['hidden']});summary();setInterval(summary,60000);document.addEventListener('visibilitychange',summary);
})();
