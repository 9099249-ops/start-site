(()=>{'use strict';const $=s=>document.querySelector(s);let lastRead=0,lastSignature='',items=[],user,filter='open',kind='task',loading=false,mutating=false,drag=null,requestId=crypto.randomUUID(),resetTimer;
const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
async function api(path='',body){const r=await fetch('/api/admin/tasks'+path,{cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'Не удалось загрузить дела.');if(body)document.dispatchEvent(new Event('station-updated'));return d;}
function notice(s){$('#tasks-notice').textContent=s;}
function stopDrag(){
 const previous=drag;if(!previous)return null;drag=null;cancelAnimationFrame(previous.frame);
 previous.row.classList.remove('task-dragging');previous.handle.setAttribute('aria-pressed','false');
 document.body.classList.remove('task-sorting');
 if(previous.pointerId!==undefined&&previous.capture.hasPointerCapture(previous.pointerId))previous.capture.releasePointerCapture(previous.pointerId);
 return previous;
}
function visibleIds(){return [...$('#task-list').querySelectorAll('[data-task-id]')].map(n=>Number(n.dataset.taskId));}
async function saveOrder(previous){
 const ids=visibleIds();if(ids.every((id,i)=>id===previous.ids[i]))return;
 const visible=new Set(ids),byId=new Map(previous.group.map(t=>[t.id,t]));let next=0;
 // Keep filtered-out completed/open tasks in their original slots.
 const order=previous.group.map(t=>visible.has(t.id)?byId.get(ids[next++]):t);
 mutating=true;render();notice('Сохраняю порядок…');
 try{await api('/edit',{action:'reorder',kind:previous.kind,items:order.map(t=>({id:t.id,edit_revision:t.edit_revision}))});notice('Порядок дел сохранён.');}
 catch(e){notice(e.message);}
 finally{mutating=false;await load(true);$('#task-list').querySelector(`[data-task-id="${previous.id}"] .task-drag-handle`)?.focus({preventScroll:true});}
}
function positionDrag(){
 if(!drag?.active||drag.keyboard)return;
 const root=$('#task-list'),others=[...root.querySelectorAll('[data-task-id]')].filter(n=>n!==drag.row);
 const before=others.find(n=>{const r=n.getBoundingClientRect();return drag.y<r.top+r.height/2;});
 if(before){if(drag.row.nextElementSibling!==before)root.insertBefore(drag.row,before);}
 else if(root.lastElementChild!==drag.row)root.append(drag.row);
}
function scrollDrag(){
 if(!drag?.active||drag.keyboard)return;
 const edge=60,viewport=window.visualViewport,bottom=viewport?viewport.height+viewport.offsetTop:innerHeight;
 const amount=drag.y<edge?-Math.ceil((edge-drag.y)/5):drag.y>bottom-edge?Math.ceil((drag.y-bottom+edge)/5):0;
 if(amount){window.scrollBy(0,Math.max(-18,Math.min(18,amount)));positionDrag();}
 drag.frame=requestAnimationFrame(scrollDrag);
}
function startDrag(task,row,handle,options={}){
 if(mutating||loading||drag)return false;
 drag={id:task.id,kind,group:items.filter(t=>t.kind===kind),ids:visibleIds(),row,handle,active:false,...options};
 handle.focus({preventScroll:true});return true;
}
function activateDrag(){drag.active=true;drag.row.classList.add('task-dragging');drag.handle.setAttribute('aria-pressed','true');document.body.classList.add('task-sorting');}
function addDragHandle(row,task){
 const handle=el('button','⠿');handle.type='button';handle.className='task-drag-handle';handle.disabled=mutating;
 handle.title='Перетащить, чтобы изменить порядок';handle.setAttribute('aria-label','Переместить: '+task.text);handle.setAttribute('aria-describedby','task-reorder-help');handle.setAttribute('aria-pressed','false');
 handle.onpointerdown=e=>{if(e.button!==0||!startDrag(task,row,handle,{pointerId:e.pointerId,capture:$('#task-list'),startY:e.clientY,y:e.clientY}))return;e.preventDefault();drag.capture.setPointerCapture(e.pointerId);};
 handle.onclick=e=>e.preventDefault();
 handle.onkeydown=e=>{
  if(e.key==='Escape'&&drag?.handle===handle){e.preventDefault();stopDrag();render();$('#task-list').querySelector(`[data-task-id="${task.id}"] .task-drag-handle`)?.focus({preventScroll:true});notice('Перемещение отменено.');return;}
  if(e.key===' '||e.key==='Enter'){
   e.preventDefault();if(drag?.handle===handle&&drag.keyboard){const previous=stopDrag();saveOrder(previous);}
   else if(startDrag(task,row,handle,{keyboard:true})){activateDrag();notice('Выберите место стрелками вверх и вниз. Enter — сохранить, Esc — отменить.');}return;
  }
  if(!drag?.keyboard||drag.handle!==handle||!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
  e.preventDefault();const root=$('#task-list');
  if(e.key==='ArrowUp'&&row.previousElementSibling)root.insertBefore(row,row.previousElementSibling);
  if(e.key==='ArrowDown'&&row.nextElementSibling)root.insertBefore(row.nextElementSibling,row);
  if(e.key==='Home')root.prepend(row);if(e.key==='End')root.append(row);
  handle.focus({preventScroll:true});row.scrollIntoView({block:'nearest'});notice('Позиция '+(visibleIds().indexOf(task.id)+1)+' из '+drag.ids.length+'. Enter — сохранить.');
 };
 row.prepend(handle);
}
// Capture on the stable list, so moving a row does not cancel the gesture.
$('#task-list').onpointermove=e=>{if(!drag||drag.pointerId!==e.pointerId)return;drag.y=e.clientY;if(!drag.active&&Math.abs(e.clientY-drag.startY)>5){activateDrag();scrollDrag();}positionDrag();};
$('#task-list').onpointerup=e=>{if(!drag||drag.pointerId!==e.pointerId)return;const previous=stopDrag();if(previous.active)saveOrder(previous);};
$('#task-list').onpointercancel=$('#task-list').onlostpointercapture=e=>{if(drag?.pointerId===e.pointerId){stopDrag();render();}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&drag&&!drag.keyboard){e.preventDefault();stopDrag();render();notice('Перемещение отменено.');}});
window.addEventListener('blur',()=>{if(drag){stopDrag();render();}});
function render(){stopDrag();const selected=items.filter(t=>t.kind===kind),open=selected.filter(t=>!t.completed_at).length;$('#task-day-note').textContent=kind==='task'?'Разовые дела остаются до выполнения.':kind==='during'?'Отметки сбрасываются каждые 2 часа по Москве.'+(selected[0]?.nextResetAt?' Следующий сброс — '+new Date(selected[0].nextResetAt).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'})+'.':''):'Чек-лист на '+new Date().toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})+' · отметки сохраняются отдельно за каждый день';document.querySelectorAll('[data-kind]').forEach(b=>{const group=items.filter(t=>t.kind===b.dataset.kind),done=group.filter(t=>t.completed_at).length;const names={task:'Разовые дела',opening:'Открытие',during:'Во время смены',closing:'Закрытие'};b.textContent=names[b.dataset.kind]+' · '+done+'/'+group.length;});$('#task-count').textContent=`Нужно сделать: ${open} · Выполнено: ${selected.length-open}`;const root=$('#task-list');root.replaceChildren();const shown=selected.filter(t=>filter==='all'||(filter==='done')===Boolean(t.completed_at));for(const task of shown){const row=el('article','');row.className='task-row'+(task.completed_at?' done':'');row.dataset.taskId=task.id;const label=el('label',''),check=document.createElement('input');check.type='checkbox';check.checked=Boolean(task.completed_at);check.disabled=mutating;check.setAttribute('aria-label',(task.completed_at?'Вернуть в работу: ':'Выполнить: ')+task.text);const copy=el('span','');copy.append(el('strong',task.text));const at=task.completed_at||task.created_at;copy.append(el('small',`${task.completed_at?'Выполнил: '+task.completed_name:'Добавил: '+task.created_name} · ${new Date(at).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`));label.append(check,copy);row.append(label);if(user?.role==='admin'){row.classList.add('task-sortable');addDragHandle(row,task);const actions=el('div','');actions.className='task-edit-actions';for(const [action,title] of [['text','Изменить'],['archive','Убрать']]){const b=el('button',title);b.type='button';b.disabled=mutating;b.setAttribute('aria-label',title+': '+task.text);b.onclick=async()=>{let text;if(action==='text'){text=prompt('Текст задания',task.text);if(text===null)return;}if(action==='archive'&&!confirm('Убрать пункт из действующего списка? Старые отметки сохранятся.'))return;mutating=true;render();try{await api('/edit',{id:task.id,revision:task.edit_revision,action,...(text!==undefined?{text}:{})});notice('Чек-лист обновлён.');}catch(e){notice(e.message);}finally{mutating=false;await load(true);}};actions.append(b);}row.append(actions);}root.append(row);check.onchange=async()=>{mutating=true;const done=check.checked;render();try{await api('/complete',{id:task.id,revision:task.revision,done,...(task.day?{day:task.day}:{}),...(task.period?{period:task.period}:{})});notice(done?'Дело выполнено.':'Дело возвращено в работу.');}catch(e){notice(e.message);}finally{mutating=false;await load(true);}};}
if(!shown.length)root.append(el('p',!selected.length?'Пунктов пока нет. Администратор может добавить их в этот раздел.':filter==='done'?'Выполненных дел пока нет.':filter==='open'?'Все дела сделаны.':'Дел пока нет.'));}
function scheduleReset(){clearTimeout(resetTimer);const at=Math.min(...items.filter(t=>t.kind==='during').map(t=>t.nextResetAt).filter(Number.isFinite));if(Number.isFinite(at))resetTimer=setTimeout(()=>{if(!document.hidden&&!mutating&&!drag)load();},Math.max(1000,at-Date.now()+50));}
async function load(forceRender=false){if(loading||drag)return;loading=true;try{const d=await api();lastRead=Date.now();const signature=JSON.stringify(d.items);if(forceRender||signature!==lastSignature){const oldPeriod=items.find(t=>t.kind==='during')?.period,newPeriod=d.items.find(t=>t.kind==='during')?.period;if(oldPeriod&&oldPeriod!==newPeriod&&kind==='during'&&filter==='done'){filter='open';document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===filter)));}lastSignature=signature;items=d.items;render();}scheduleReset();document.dispatchEvent(new CustomEvent('desk-sync',{detail:{ok:true}}));}catch(e){notice(e.message);document.dispatchEvent(new CustomEvent('desk-sync',{detail:{ok:false}}));}finally{loading=false;}}
$('#task-create').onsubmit=async e=>{e.preventDefault();const b=e.currentTarget.querySelector('button');if(b.disabled)return;b.disabled=true;const text=$('#task-text').value;try{await api('/create',{text,requestId,kind:$('#task-kind').value});requestId=crypto.randomUUID();kind=$('#task-kind').value;document.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===kind)));$('#task-text').value='';notice('Дело добавлено.');await load(true);}catch(err){notice(err.message);}finally{b.disabled=false;}};
document.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{kind=b.dataset.kind;$('#task-kind').value=kind;document.querySelectorAll('[data-kind]').forEach(n=>n.setAttribute('aria-pressed',String(n===b)));render();load();});$('#task-kind').onchange=()=>{requestId=crypto.randomUUID();};$('#task-text').oninput=()=>{requestId=crypto.randomUUID();};
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(n=>n.setAttribute('aria-pressed',String(n===b)));render();});$('#tasks-refresh').onclick=()=>load(true);document.addEventListener('station-updated',()=>{if(!document.hidden&&!mutating&&!drag)load();});
(async()=>{try{const r=await fetch('/api/admin/session',{cache:'no-store'});({user}=await r.json());if(!user){$('#tasks-login').hidden=false;notice('Войдите, чтобы увидеть дела команды.');return;}$('#tasks-workspace').hidden=false;$('#task-editor').hidden=user.role!=='admin';$('#task-reorder-help').hidden=user.role!=='admin';await load(true);setInterval(()=>{if(!document.hidden&&!mutating&&!drag)load();},30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!mutating&&!drag )load();});}catch{notice('Не удалось подключиться. Обновите страницу.');}})();})();
