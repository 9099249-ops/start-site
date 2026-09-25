// The static preview keeps its manual Telegram flow until a configured server is available.
window.startTelegram = {enabled:false,send:async()=>{}};
fetch('/api/booking-config',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(config=>{
  if(config?.enabled !== true)return;
  window.startTelegram.enabled=true;
  const form=document.querySelector('#booking-form');
  const button=form.querySelector('[type=submit]');
  button.textContent='Отправить заявку ↗';
  document.querySelector('.dialog-intro').textContent='Отправьте заявку сотруднику. Бронь — после его подтверждения, без предоплаты.';
  const status=document.createElement('p');status.setAttribute('role','status');form.append(status);
  let busy=false;
  form.addEventListener('input',()=>{if(!busy){button.disabled=false;button.textContent='Отправить заявку ↗';status.textContent='';}});
  window.startTelegram.send=async()=>{
    if(busy)return;busy=true;button.disabled=true;status.textContent='Отправляем заявку…';
    const value=id=>document.getElementById(id).value;
    const body={equipment:value('equipment'),plan:value('plan'),date:value('date'),time:value('time'),returnDate:value('return-date'),quantity:value('plan')==='season'?1:Number(value('quantity')),duration:Number(value('duration')),name:form.elements.name.value,phone:form.elements.phone.value};
    const controls=[...form.querySelectorAll('input,select')].map(el=>[el,el.disabled]);
    controls.forEach(([el])=>el.disabled=true);
    try {
      const r=await fetch('/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const result=await r.json().catch(()=>({}));
      if(r.ok && result.ok === true){if(!result.duplicate)window.startAnalytics?.goal('booking_sent');status.textContent='Заявка отправлена. Сотрудник свяжется с вами для подтверждения. Бронь пока не подтверждена.';button.textContent='Заявка отправлена';return;}
      if([400,403,413,429,503].includes(r.status)){status.textContent=r.status===429?'Слишком много попыток. Подождите минуту.':'Заявка не отправлена. Проверьте данные или свяжитесь с нами по телефону.';busy=false;button.disabled=false;return;}
      throw new Error();
    }catch{status.textContent='Не удалось подтвердить доставку. Чтобы не отправить заявку дважды, уточните её получение по телефону +7 (903) 963-31-35.';button.textContent='Доставка не подтверждена';}
    finally{busy=false;controls.forEach(([el,disabled])=>el.disabled=disabled);}
  };
}).catch(()=>{});
