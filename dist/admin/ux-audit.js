(()=>{'use strict';
 const EVENTS=['cafe_started','cafe_item_added','cafe_item_removed','cafe_modifier_selected','cafe_payment_started','cafe_completed','rental_started','rental_item_added','rental_item_removed','rental_modifier_selected','rental_payment_started','rental_completed','rental_extended','rental_returned','search','click','repeated_click','navigation_back','scenario_cancelled','action_failed'];
 const SCREENS=['cafe_pos','cafe_order','cafe_payment','rental_pos','rental_order','rental_payment','booking_search','dashboard'];
 const ACTIONS=['start','add','remove','select_modifier','pay','complete','extend','return','search','click','repeated_click','back','cancel','fail'];
 const RESULTS=['success','failure','cancelled','blocked'];
 const ERROR_CODES=['validation','unavailable','timeout','conflict','permission','unknown'];
 const MAX_QUEUE=64,MAX_BATCH=4,MAX_BYTES=4096,SESSION_IDLE=30*60*1000,RETRY_LIMIT=3,RETRY_DELAY=3000,CONFIG_CACHE=60000,REQUEST_TIMEOUT=5000;
 const queue=[],active=new Map(),lastClicks=new WeakMap(),searchTimers=new WeakMap();
 let enabled=false,stopped=false,flushing=false,retryCount=0,retryAt=0,sequence=0,employeeSessionId='',lastActivity=0,deadline=0,configCheckedAt=0,configCheck=null,timer=null,latestDomain=null;
 const allowed=(list,value)=>list.includes(value),validDomain=domain=>domain==='cafe'||domain==='rental';
 try{const saved=JSON.parse(window.sessionStorage.getItem('start-ux-audit-session')||'null');if(saved&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.id)&&Number.isFinite(saved.lastActivity)&&Date.now()-saved.lastActivity<SESSION_IDLE){employeeSessionId=saved.id;lastActivity=saved.lastActivity;}}catch{}
 function uuid(){try{return window.crypto.randomUUID();}catch{return null;}}
 function screen(){const path=window.location.pathname;if(path==='/admin/cafe/'||path==='/admin/cafe'){if(document.querySelector('#order-dialog')?.open||document.querySelector('[data-tab="orders"].selected'))return 'cafe_order';if(document.querySelector('dialog.guest-dialog[open] .guest-bill-payment-actions,dialog.guest-dialog[open] .guest-manual-payment,.guest-panel .guest-bill-payment-actions,.guest-panel .guest-manual-payment'))return 'cafe_payment';return 'cafe_pos';}if(path==='/admin/'||path==='/admin'){const issue=document.querySelector('#issue-dialog');if(issue?.open){const form=document.querySelector('#issue-form');return form?.dataset?.saving==='1'||form?.dataset?.pendingRequest==='1'?'rental_payment':'rental_order';}return 'rental_pos';}return 'dashboard';}
 function sessionId(){const now=Date.now();if(!employeeSessionId||now-lastActivity>=SESSION_IDLE){if(employeeSessionId){active.clear();latestDomain=null;}employeeSessionId=uuid();if(!employeeSessionId){stop();return null;}}lastActivity=now;try{window.sessionStorage.setItem('start-ux-audit-session',JSON.stringify({id:employeeSessionId,lastActivity}));}catch{}return employeeSessionId;}
 function activeScenario(){return latestDomain&&active.get(latestDomain)||null;}
 function enqueue(name,action,result='success',errorCode=null,scenario){
  if(scenario===undefined)scenario=activeScenario();
  if(!enabled||stopped||!scenario||!allowed(EVENTS,name)||!allowed(ACTIONS,action)||!allowed(RESULTS,result)||!(errorCode===null||allowed(ERROR_CODES,errorCode))||sequence>=100000)return false;
  if(queue.length>=MAX_QUEUE){void flush();return false;}
  const sid=sessionId();if(!sid||scenario.sessionId!==sid)return false;
  const id=uuid();if(!id){stop();return false;}
  queue.push({id,employee_session_id:sid,scenario_id:scenario.id,event:name,screen:screen(),action,result,error_code:errorCode,seq:sequence++,elapsed_ms:Math.min(4*60*60*1000,Math.max(0,Date.now()-scenario.startedAt))});
  if(queue.length>=MAX_QUEUE)void flush();
  return true;
 }
 function begin(domain){if(!enabled||stopped||!validDomain(domain))return false;if(active.has(domain))return true;const sid=sessionId(),id=uuid();if(!sid||!id)return false;const scenario={id,sessionId:sid,startedAt:Date.now()};active.set(domain,scenario);latestDomain=domain;return enqueue(domain+'_started','start','success',null,scenario);}
 function finish(domain,event,action,result='success',errorCode=null){if(!enabled||stopped||!validDomain(domain))return false;const scenario=active.get(domain);if(!scenario)return false;const recorded=enqueue(event,action,result,errorCode,scenario);active.delete(domain);if(latestDomain===domain)latestDomain=[...active.keys()].at(-1)||null;return recorded;}
 function stop(){enabled=false;stopped=true;queue.length=0;active.clear();latestDomain=null;if(timer!==null){window.clearInterval(timer);timer=null;}}
 async function request(url,options={},parseJson=false){const controller=new AbortController(),timeout=window.setTimeout(()=>controller.abort(),REQUEST_TIMEOUT);try{const response=await window.fetch(url,{...options,signal:controller.signal});if(parseJson){if(!response.ok)throw Error('config');return await response.json();}return response;}finally{window.clearTimeout(timeout);}}
 async function getConfig(){return request('/api/admin/ux-audit/config',{cache:'no-store',credentials:'same-origin'},true);}
 async function checkConfig(force=false){if(stopped)return false;if(!force&&enabled&&Date.now()-configCheckedAt<CONFIG_CACHE&&Date.now()<deadline)return true;if(configCheck)return configCheck;configCheck=(async()=>{try{const config=await getConfig();if(config.enabled!==true||!Number.isFinite(Number(config.endsAt))||Date.now()>=Number(config.endsAt)){stop();return false;}deadline=Number(config.endsAt);configCheckedAt=Date.now();return true;}catch{stop();return false;}})();try{return await configCheck;}finally{configCheck=null;}}
 function bind(){
  document.addEventListener('click',event=>{if(!activeScenario())return;const target=event.target?.closest?.('button,a,[role="button"],input[type="submit"],summary');if(!target)return;enqueue('click','click');const now=Date.now(),previous=lastClicks.get(target);if(previous!==undefined&&now-previous<600)enqueue('repeated_click','repeated_click');lastClicks.set(target,now);});
  document.addEventListener('input',event=>{const input=event.target;if(!input?.matches?.('#active-search,#order-search,#catalog-search,#menu-search'))return;const scenario=activeScenario();if(!scenario)return;const previous=searchTimers.get(input);if(previous)window.clearTimeout(previous);searchTimers.set(input,window.setTimeout(()=>{if(activeScenario())enqueue('search','search');},500));});
  document.addEventListener('invalid',()=>{if(activeScenario())enqueue('action_failed','fail','blocked','validation');},true);
  window.addEventListener('popstate',()=>{if(activeScenario())enqueue('navigation_back','back');});
 }
 async function flush(){
  if(!enabled||stopped||flushing||!queue.length||Date.now()<retryAt)return;
  if(Date.now()>=deadline){stop();return;}
  flushing=true;
  try{
   if(!await checkConfig())return;
   if(!queue.length)return;
   const batch=queue.slice(0,MAX_BATCH),body=JSON.stringify({events:batch});
   if(new TextEncoder().encode(body).length>MAX_BYTES){stop();return;}
   try{
    const response=await request('/api/admin/ux-audit/events',{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json'},body});
    if(!response.ok)throw Error('batch');
    queue.splice(0,batch.length);retryCount=0;retryAt=0;
   }catch{
    retryCount++;
    if(retryCount>=RETRY_LIMIT){queue.splice(0,batch.length);retryCount=0;}
    else retryAt=Date.now()+RETRY_DELAY;
   }
  }finally{flushing=false;}
 }
 async function boot(){if(!await checkConfig(true))return;enabled=true;bind();timer=window.setInterval(()=>{if(Date.now()>=deadline){stop();return;}if(Date.now()-configCheckedAt>=CONFIG_CACHE){void checkConfig(true).then(ok=>{if(ok)void flush();});return;}if(queue.length)void flush();},3000);}
 const ready=boot();
 window.STARTUx=Object.freeze({
  start(domain){if(!validDomain(domain))return Promise.resolve(false);if(enabled)return Promise.resolve(begin(domain));return ready.then(()=>begin(domain));},
  event(name,action,result='success',errorCode=null){if(!allowed(EVENTS,name)||!allowed(ACTIONS,action)||!allowed(RESULTS,result)||!(errorCode===null||allowed(ERROR_CODES,errorCode))||(name==='rental_extended'&&action!=='extend')||(name==='rental_returned'&&action!=='return'))return false;const domain=name.startsWith('cafe_')?'cafe':name.startsWith('rental_')?'rental':null;let scenario=domain?active.get(domain):activeScenario();if(!scenario&&['rental_extended','rental_returned'].includes(name)){const sid=sessionId();scenario={id:uuid(),sessionId:sid,startedAt:Date.now()};}if(domain&&!scenario)return false;return enqueue(name,action,result,errorCode,scenario);},
  complete(domain){return finish(domain,domain+'_completed','complete');},
  fail(domain,errorCode){return finish(domain,'action_failed','fail','failure',allowed(ERROR_CODES,errorCode)?errorCode:'unknown');},
  cancel(domain){return finish(domain,'scenario_cancelled','cancel','cancelled');}
 });
})();
