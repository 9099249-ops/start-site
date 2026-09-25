(()=>{
 const id=Number(document.currentScript?.dataset.counter);
 if(!id||location.hostname!=='spotsup.ru'||!(/^\/$|^\/storage\/$|^\/cafe\/(?:t\/[a-f0-9]{48})?$|^\/(?:prokat|afisha)\/[a-z0-9]+\/$/).test(location.pathname))return;
 const allowed=new Set(['booking_open','booking_sent','discount_request','phone_click','telegram_click','route_view','view_menu','add_to_cart','modifier_selected','view_cart','begin_checkout','order_success','nfc_place_opened']);
 const publicPath=location.pathname.startsWith('/cafe/')?'/cafe/':location.pathname;
 window.ym=window.ym||function(){(window.ym.a=window.ym.a||[]).push(arguments);};window.ym.l=Date.now();
 const tag=document.createElement('script');tag.async=true;tag.src='https://mc.yandex.ru/metrika/tag.js';document.head.append(tag);
 let referrer='';try{referrer=new URL(document.referrer).origin+'/';}catch{}
 window.ym(id,'init',{url:location.origin+publicPath,referrer,ecommerce:false,defer:true,webvisor:false,clickmap:false,trackLinks:false,trackHash:false,accurateTrackBounce:true,sendTitle:false,triggerEvent:true});
 // Never pass form values, arbitrary URLs or URL query/hash fields to event parameters.
 window.ym(id,'hit',location.origin+publicPath,{referer:referrer,title:document.title});
 window.startAnalytics={goal(name){if(allowed.has(name))try{window.ym(id,'reachGoal',name);}catch{}}};
 document.addEventListener('click',event=>{const a=event.target.closest?.('a');if(a){const h=a.getAttribute('href')||'';if(h.startsWith('tel:'))window.startAnalytics.goal('phone_click');else if(h.startsWith('https://t.me/'))window.startAnalytics.goal('telegram_click');else if(h==='/#routes'||h==='#routes'||h.startsWith('https://yandex.ru/navi/'))window.startAnalytics.goal('route_view');}else if(event.target.closest?.('[data-route]'))window.startAnalytics.goal('route_view');});
})();
