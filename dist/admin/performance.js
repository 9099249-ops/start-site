(()=>{'use strict';
 const native=window.fetch.bind(window),pending=new Map();let epoch=0,writes=0;
 const banner=document.createElement('div');banner.className='save-feedback';banner.hidden=true;banner.setAttribute('role','status');let timer;
 const show=(text,state)=>{const dialogs=document.querySelectorAll('dialog[open]'),host=dialogs[dialogs.length-1]||document.body;if(banner.parentNode!==host)host.append(banner);clearTimeout(timer);banner.textContent=text;banner.dataset.state=state;banner.hidden=false;if(state!=='busy')timer=setTimeout(()=>{banner.hidden=true;},state==='error'?12000:2400);};
 window.fetch=async(input,options={})=>{
  const url=typeof input==='string'?input:null,method=(options.method||'GET').toUpperCase();
  const api=url?.startsWith('/api/admin/'),readOnlyPost=api&&method==='POST'&&/\/(?:quote|stock-check|preview)(?:\?|$)/.test(url),write=api&&method!=='GET'&&method!=='HEAD'&&!readOnlyPost;
  const feedback=write&&!/\/(quote|login|logout)(?:\?|$)/.test(url);
  if(write){epoch++;pending.clear();}if(feedback){writes++;show(/\/(pay|rental-pay)/.test(url)?'Отправляем запрос на кассу…':'Сохраняем…','busy');}
  const key=api&&method==='GET'&&!options.signal?epoch+':'+url:null;
  try{
   let task=key&&pending.get(key);if(!task){task=native(input,options);if(key){pending.set(key,task);task.finally(()=>{if(pending.get(key)===task)pending.delete(key);}).catch(()=>{});}}
   const response=(await task).clone();
   if(feedback)show(response.ok?(/\/(pay|rental-pay)/.test(url)?'Запрос принят. Проверяем результат оплаты.':url.includes('/print/')?'Задание печати сохранено.':'Готово'):response.status>=500?'Сохранение не подтверждено. Проверьте данные перед повтором.':'Не сохранено. Проверьте сообщение в форме.',response.ok?'ok':'error');
   return response;
  }catch(e){if(feedback)show('Нет подтверждения сохранения. Проверьте связь и данные перед повтором.','error');throw e;}
  finally{if(write){epoch++;pending.clear();}if(feedback)writes--;}
 };
})();
