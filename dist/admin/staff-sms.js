(()=>{
 const el=(tag,value='')=>{const e=document.createElement(tag);e.textContent=value;return e;};
 const labels={scheduled:'Запланировано',needs_phone:'Нужен телефон',retry:'Ожидает повторной попытки',sending:'Передаётся провайдеру',accepted:'Принято провайдером',delivered:'Доставлено',unknown:'Результат неизвестен',failed:'Ошибка',cancelled:'Отменено'};
 const actions={contact_changed:'Телефон сотрудника изменён',settings_changed:'Настройки СМС изменены',cancelled:'Напоминание отменено',scheduled:'Напоминание запланировано',resumed:'Напоминание восстановлено',phone_available:'Телефон добавлен, напоминание запланировано',needs_phone:'Ожидает номер телефона',daily_limit:'Достигнут дневной лимит СМС',attempt:'Попытка отправки',accepted:'Принято SMS Aero',retry:'Ожидает повторной попытки',failed:'Ошибка отправки',unknown:'Результат отправки неизвестен, нужна сверка SMS Aero',delivered:'Доставлено',expired:'Срок отправки истёк',schedule_changed_after_dispatch:'График изменён после начала отправки'};
 const cancelReasons={expired:'Срок отправки истёк',schedule_changed:'График сменился'};
 const date=value=>value?new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'—';
 const jobStatus=j=>j.status==='unknown'?'Результат неизвестен. Проверьте SMS Aero вручную; автоматического повтора нет.':labels[j.status]||'Статус не распознан';
 window.staffSmsLoad=async(root,user)=>{
  if(user?.role!=='admin'||root.dataset.staffSmsLoaded)return;
  root.dataset.staffSmsLoaded='loading';
  const panel=el('section');panel.className='staff-sms';panel.setAttribute('aria-label','СМС сотрудникам');
  const notice=el('p');notice.className='staff-sms-notice';notice.setAttribute('role','status');
  const content=el('div');panel.append(el('h3','СМС сотрудникам'),notice,content);root.append(panel);
  const request=async body=>{const r=await fetch('/api/admin/staff-sms',{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data={};try{data=await r.json();}catch{}if(!r.ok){const error=new Error(r.status===401||r.status===403?'Нет доступа к настройкам СМС сотрудников.':data.error||'Не удалось загрузить настройки СМС сотрудников.');error.status=r.status;throw error;}return data;};
  const announceError=error=>{notice.textContent=error.message;};
  function render(data){
   content.replaceChildren();
   const settings=el('form');settings.className='staff-sms-settings';
   const enabledLabel=el('label','Включить СМС сотрудникам');const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=!!data.enabled;enabledLabel.prepend(enabled);
   const saveSettings=el('button','Сохранить');saveSettings.type='submit';settings.append(enabledLabel,saveSettings);
   const transport=data.transport||{};
   const warning=el('p',!data.enabled?'СМС сотрудникам глобально выключены.':!transport.enabled?'Отправка СМС выключена на сервере.':!transport.sign?'Не настроено имя отправителя SMS Aero.':`Лимит: ${transport.dailyLimit??'не указан'} СМС в день; отправитель: ${transport.sign}.`);warning.className='staff-sms-warning';
   settings.onsubmit=async event=>{event.preventDefault();if(saveSettings.disabled)return;saveSettings.disabled=true;enabled.disabled=true;try{render(await request({action:'settings',enabled:enabled.checked,revision:data.revision}));notice.textContent='Настройки сохранены.';}catch(error){announceError(error);}finally{saveSettings.disabled=false;enabled.disabled=false;}};
   content.append(settings,warning);
   const missing=(data.people||[]).filter(person=>person.login!=='admin'&&!String(person.phone||'').trim()).length;
   if(missing){const link=el('a',`Без телефона: ${missing}. Добавить в учётных записях →`);link.href='/admin/accounts/?settings=accounts';const missingNote=el('p');missingNote.className='staff-sms-missing';missingNote.append(link);content.append(missingNote);}
   const journal=el('details');journal.className='staff-sms-journal';journal.append(el('summary','Журнал отправок'));
   const entries=el('div');
   for(const job of data.jobs||[]){const item=el('article');item.className='staff-sms-job';const reason=cancelReasons[job.cancelReason]||'Причина отмены не указана';item.append(el('strong',`${job.name||job.login||'Сотрудник'} · ${job.day||'Дата не указана'} ${job.startTime||''}`),el('span',`${job.kind==='hour'?'За час до смены':'Вечером'} · ${jobStatus(job)}`),el('small',`Срок: ${date(job.due)} · Отправка: ${date(job.sentAt)} · Попыток: ${job.attempts??0}${job.providerId?` · ID провайдера: ${job.providerId}`:''}${job.lastError?` · ${job.lastError}`:''}${job.cancelReason?` · ${reason}`:''}`));entries.append(item);}
   for(const event of data.events||[]){const item=el('article');item.className='staff-sms-event';const when=event.at||event.createdAt||event.time;const action=actions[event.action]||'Событие';const attempt=Number.isSafeInteger(event.body?.attempt)?` · Попытка ${event.body.attempt}`:'';const reason=event.body?.reason?` · ${cancelReasons[event.body.reason]||'Причина не указана'}`:'';item.append(el('span',date(when)),el('span',action+attempt+reason),...(event.name?[el('small',String(event.name))]:[]));entries.append(item);}
   if(!(data.jobs||[]).length&&!(data.events||[]).length)entries.append(el('p','Записей пока нет.'));
   journal.append(entries);content.append(journal);
  }
  try{render(await request());root.dataset.staffSmsLoaded='yes';}
  catch(error){content.replaceChildren();announceError(error);if(error.status===401||error.status===403)root.dataset.staffSmsLoaded='denied';else delete root.dataset.staffSmsLoaded;}
 };
})();
