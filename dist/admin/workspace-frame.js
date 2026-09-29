(()=>{'use strict';if(parent===window)return;
 const send=(type,extra={})=>parent.postMessage({startWorkspace:type,...extra},location.origin);
 let active=false;const nativeHidden=Object.getOwnPropertyDescriptor(Document.prototype,'hidden')?.get;
 // CSS-hidden frames otherwise keep polling as if visible. Payments remain server-owned.
 if(nativeHidden)Object.defineProperty(document,'hidden',{get:()=>!active||nativeHidden.call(document)});
 const setActive=value=>{if(active===value)return;active=value;document.dispatchEvent(new Event('visibilitychange'));};
 addEventListener('message',e=>{if(e.source!==parent||e.origin!==location.origin)return;const d=e.data;if(d?.startWorkspace==='activate'){setActive(d.active);document.body?.classList.toggle('pos-mode',d.pos);if(d.active&&d.hash!==undefined&&location.hash!==d.hash)location.hash=d.hash;}if(d?.startWorkspace==='refresh')document.dispatchEvent(new Event('station-updated'));});
 document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a||e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||a.target||a.hasAttribute('download'))return;const u=new URL(a.href);if(u.origin!==location.origin||!/^\/admin\/(?:[a-z-]+\/)?$/.test(u.pathname))return;e.preventDefault();send('navigate',{url:u.pathname+u.search+u.hash});});
 const nativeFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await nativeFetch(...args);const request=args[0],url=new URL(typeof request==='string'?request:request.url,location.href),method=(args[1]?.method||request?.method||'GET').toUpperCase();if(url.origin===location.origin&&url.pathname.startsWith('/api/admin/')){if(response.ok&&method!=='GET'&&method!=='HEAD'){if(['/api/admin/login','/api/admin/logout','/api/admin/setup'].includes(url.pathname))send('session');else send('changed');}if(response.status===401)send('expired');}return response;};
 addEventListener('hashchange',()=>send('route',{url:location.pathname+location.search+location.hash}));
 for(const method of ['pushState','replaceState']){const original=history[method].bind(history);history[method]=(...args)=>{original(...args);send('route',{url:location.pathname+location.search+location.hash});};}
 addEventListener('DOMContentLoaded',()=>send('ready',{url:location.pathname+location.search+location.hash}));
})();
