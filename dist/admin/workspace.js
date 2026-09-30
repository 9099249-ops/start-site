(()=>{'use strict';
 const paths=new Set(['/admin/','/admin/cafe/','/admin/purchase/','/admin/tasks/','/admin/settings/','/admin/workforce/','/admin/schedule/','/admin/accounts/','/admin/aqsi/','/admin/cafe-stock/']);
 const frames=new Map(),host=document.querySelector('#workspace-frames'),loading=document.querySelector('#workspace-loading'),failure=document.querySelector('#workspace-failure');let current=null,timer=null,sessionKnown=false,userId=null,checking=false;
 function normalize(value){const u=new URL(value,location.origin);if(u.origin!==location.origin||!paths.has(u.pathname))return null;u.searchParams.delete('embedded');u.searchParams.delete('standalone');return u;}
 function signal(frame,type,extra={}){frame.contentWindow.postMessage({startWorkspace:type,...extra},location.origin);}
 function activate(frame,active,hash){signal(frame,'activate',{active:active&&!document.hidden,pos:document.body.classList.contains('pos-mode'),...(hash!==undefined?{hash}:{})});}
 function chrome(u){const section=u.searchParams.has('settings')?'/admin/settings/':u.pathname;document.body.classList.toggle('theme-cafe',section==='/admin/cafe/');document.body.classList.toggle('theme-rental',section!=='/admin/cafe/');for(const a of document.querySelectorAll('.ops-nav a:not(.pos-brand)')){if(new URL(a.href).pathname===section)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}}
 function open(value,{push=true}={}){const u=normalize(value);if(!u){location.href=value;return;}const key=u.pathname+u.search;let frame=frames.get(key);if(current&&current!==frame){current.hidden=true;activate(current,false);}if(!frame){frame=document.createElement('iframe');frame.title='СТАРТ · '+(u.pathname.split('/')[2]||'прокат');frame.dataset.route=key;frame.dataset.hash=u.hash;frame.src=u.href;frame.addEventListener('load',()=>{if(frame===current)activate(frame,true,frame.dataset.hash);});frames.set(key,frame);host.append(frame);}else if(u.hash)frame.dataset.hash=u.hash;
 current=frame;frame.hidden=false;activate(frame,true,frame.dataset.hash);chrome(u);clearTimeout(timer);failure.hidden=true;loading.hidden=frame.dataset.ready==='1';if(!loading.hidden)timer=setTimeout(()=>{if(current!==frame||frame.dataset.ready==='1')return;loading.hidden=true;failure.hidden=false;const fallback=new URL(location.href);fallback.searchParams.set('standalone','1');document.querySelector('#workspace-fallback').href=fallback.href;},15000);
 const displayed=u.pathname+u.search+(u.hash||frame.dataset.hash||'');if(push&&location.pathname+location.search+location.hash!==displayed)history.pushState(null,'',displayed);
 }
 document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a||e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||a.target||a.hasAttribute('download')||a.id==='workspace-fallback')return;const u=normalize(a.href);if(!u)return;e.preventDefault();document.querySelector('.work-account')?.removeAttribute('open');open(u.href);});
 addEventListener('popstate',()=>open(location.href,{push:false}));
 addEventListener('message',e=>{if(e.origin!==location.origin)return;const frame=[...frames.values()].find(f=>f.contentWindow===e.source);if(!frame)return;const d=e.data;
 if(d?.startWorkspace==='navigate')open(d.url);
 if(d?.startWorkspace==='ready'){const u=normalize(d.url);if(u&&u.pathname+u.search!==frame.dataset.route){frames.delete(frame.dataset.route);frame.dataset.route=u.pathname+u.search;frames.get(frame.dataset.route)?.remove();frames.set(frame.dataset.route,frame);frame.dataset.hash=u.hash;if(frame===current){history.replaceState(null,'',u.pathname+u.search+u.hash);chrome(u);}}frame.dataset.ready='1';if(frame===current){loading.hidden=true;failure.hidden=true;clearTimeout(timer);activate(frame,true,frame.dataset.hash);}else activate(frame,false);}
 if(d?.startWorkspace==='route'&&frame===current){const u=normalize(d.url);if(u){frame.dataset.hash=u.hash;history.replaceState(null,'',u.pathname+u.search+u.hash);}}
 if(d?.startWorkspace==='session')location.reload();
 if(d?.startWorkspace==='expired')checkSession();
 if(d?.startWorkspace==='changed')document.dispatchEvent(new Event('station-updated'));
 });
 document.querySelector('#workspace-retry').onclick=()=>{if(!current)return;const old=current,url=location.href;frames.delete(old.dataset.route);old.remove();current=null;open(url,{push:false});};
 document.addEventListener('visibilitychange',()=>{if(current)activate(current,true);checkSession();});
 document.addEventListener('station-updated',()=>{if(current)signal(current,'refresh');});
 let lastPos=document.body.classList.contains('pos-mode');
 new MutationObserver(()=>{const pos=document.body.classList.contains('pos-mode');if(pos===lastPos)return;lastPos=pos;if(current)activate(current,true);}).observe(document.body,{attributes:true,attributeFilter:['class']});
 async function checkSession(){if(checking||document.hidden)return;checking=true;try{const r=await fetch('/api/admin/session',{cache:'no-store'});if(!r.ok)return;const d=await r.json(),id=d.user?String(d.user.id??d.user.login)+':'+d.user.role:null;if(sessionKnown&&id!==userId){location.reload();return;}sessionKnown=true;userId=id;}catch{}finally{checking=false;}}
 checkSession();setInterval(checkSession,30000);open(location.href,{push:false});
})();
