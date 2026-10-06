(()=>{
 'use strict';
 if(window.top!==window)return;
 const KEY='start-voice-alert-cursor-v1',POLL=5000,TIMEOUT=8000;
 const kinds=['cafe_order','task','booking'];
 let session=null,cursor=null,generation=0,controller=null,timer=null,working=false;
 function validId(n){return Number.isSafeInteger(n)&&n>=0;}
 function validCursor(c){return !!c&&typeof c.scope==='string'&&/^[a-f\d]{24}$/.test(c.scope)&&validId(c.cafe)&&validId(c.task)&&validId(c.booking);}
 function read(key){try{const v=JSON.parse(key.getItem(KEY)||'null');return validCursor(v)?v:null;}catch{return null;}}
 function stores(){const out=[];try{out.push(localStorage);}catch{}try{out.push(sessionStorage);}catch{}return out;}
 function write(value){cursor=value;const text=JSON.stringify(value);for(const key of stores())try{key.setItem(KEY,text);}catch{}}
 function stored(){for(const key of stores()){const value=read(key);if(value)return value;}return cursor;}
 function clear(){for(const key of stores())try{key.removeItem(KEY);}catch{}cursor=null;}
 function usable(){return session?.authenticated===true&&!session.scheduleOnly&&document.visibilityState!=='hidden'&&!document.hidden&&document.hasFocus()&&window.top===window;}
 function stop(logout=false){generation++;if(controller){controller.abort();controller=null;}if(timer!==null){clearTimeout(timer);timer=null;}working=false;if(logout)clear();}
 function schedule(delay=POLL){if(timer!==null)clearTimeout(timer);timer=setTimeout(()=>{timer=null;poll();},delay);}
 function merge(a,b){return {scope:b.scope,cafe:Math.max(a.cafe,b.cafe),task:Math.max(a.task,b.task),booking:Math.max(a.booking,b.booking)};}
 function accepted(body){
  if(!body||typeof body!=='object'||!validCursor(body.cursor)||typeof body.baseline!=='boolean'||!Array.isArray(body.events)||body.events.length>3)return null;
  const c=body.cursor,events=[];
  const seen=new Set();
  for(const e of body.events){if(!e||!kinds.includes(e.kind)||seen.has(e.kind)||!validId(e.id)||e.id<1||e.id>c[e.kind==='cafe_order'?'cafe':e.kind==='task'?'task':'booking'])return null;seen.add(e.kind);events.push(e);}
  if(body.baseline&&events.length)return null;
  return {cursor:c,baseline:body.baseline,events};
 }
 async function request(gen,signal){
  const previous=stored(),baseline=!validCursor(previous);
  const params=baseline?'':('?'+new URLSearchParams({scope:previous.scope,cafe:String(previous.cafe),task:String(previous.task),booking:String(previous.booking)}));
  const response=await fetch('/api/admin/voice-events'+params,{cache:'no-store',signal});
  if(gen!==generation)return;
  if(response.status===401||response.status===403){session={authenticated:false};stop(true);return;}
  if(!response.ok)return;
  const parsed=accepted(await response.json());if(!parsed||gen!==generation||!usable())return;
  const scope=parsed.cursor.scope;if(!baseline&&!parsed.baseline&&previous.scope!==scope)return;
  const latest=stored(),isBaseline=baseline||parsed.baseline||!validCursor(latest)||latest.scope!==scope;
  let next=parsed.cursor,events=[];
  if(!isBaseline){const start=latest;next=merge(start,parsed.cursor);events=parsed.events.filter(e=>e.id>start[e.kind==='cafe_order'?'cafe':e.kind]);}
  write(next);
  for(const event of events){if(gen!==generation||!usable())break;window.STARTTerminalVoice?.notify(event,scope);}
 }
 async function poll(){
  if(working||!usable())return;
  const gen=generation;working=true;
  const run=async()=>{if(!usable()||gen!==generation)return;controller=new AbortController();const active=controller;const timeout=setTimeout(()=>active.abort(),TIMEOUT);try{await request(gen,active.signal);}catch{}finally{clearTimeout(timeout);if(controller===active)controller=null;if(gen===generation){working=false;if(usable())schedule();}}};
  try{if(navigator.locks?.request){let acquired=false;await navigator.locks.request('start-voice-alerts',{ifAvailable:true},async lock=>{if(!lock)return;acquired=true;await run();});if(!acquired&&gen===generation){working=false;if(usable())schedule();}}else await run();}catch{if(gen===generation&&usable())await run();else if(gen===generation)working=false;}
 }
 function refresh(){if(!usable()){stop();return;}stop();poll();}
 function onSession(detail){const base=window.STARTStationSession&&typeof window.STARTStationSession==='object'?window.STARTStationSession:{};session={...base,...(detail&&typeof detail==='object'?detail:{})};if(session.authenticated!==true||session.scheduleOnly)stop(session.authenticated===false);else refresh();}
 document.addEventListener('station-session',e=>onSession(e.detail));
 document.addEventListener('station-updated',refresh);
 document.addEventListener('visibilitychange',refresh);
 window.addEventListener('focus',refresh);window.addEventListener('blur',()=>stop());
 if(window.STARTStationSession)onSession(window.STARTStationSession);
})();
