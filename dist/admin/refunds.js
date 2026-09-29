(()=>{'use strict';
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;},money=n=>(n/100).toLocaleString('ru-RU')+' ₽';
async function api(query,body){let r,d;try{r=await fetch('/api/admin/refunds'+query,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});d=await r.json();}catch{throw Error('Нет подтверждения сервера. Повторите отправку — повтор не создаст второй возврат.');}if(!r.ok)throw Object.assign(Error(d.error||'Не удалось сохранить возврат.'),{status:r.status});return d;}
const cents=value=>{const s=value.trim().replace(',','.');if(!/^\d{1,7}(\.\d{1,2})?$/.test(s))throw Error('Укажите сумму в рублях.');const [r,k='']=s.split('.');return Number(r)*100+Number(k.padEnd(2,'0'));};
window.STARTRefunds={mount(container,kind,id,userId,onSaved){
 const box=el('details');box.className='refund-panel';box.append(el('summary','Возврат денег / история'));const out=el('div');box.append(out);container.append(box);let loaded=false,busy=false,pending=null,confirmed=false;
 const key='refund-pending-'+userId+'-'+kind+'-'+id;try{pending=JSON.parse(sessionStorage.getItem(key));}catch{}
 async function load(){out.replaceChildren(el('p','Загрузка…'));try{const info=await api('?kind='+kind+'&id='+id);render(info);loaded=true;}catch(e){out.replaceChildren(el('p',e.message));loaded=false;}}
 box.addEventListener('toggle',()=>{if(box.open&&!loaded)void load();});
 function render(info){out.replaceChildren(el('p','Оплачено: '+money(info.paidCents)+' · возвращено: '+money(info.refundedCents)+' · можно вернуть: '+money(info.remainingCents)));
  for(const r of info.history)out.append(el('p',new Date(r.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' · '+money(r.amount_cents)+' · '+r.actor+' · '+r.reason));
  if(!info.remainingCents&&!pending){out.append(el('p',kind==='cafe'&&!info.paidCents?'Для бесплатного или ещё не оплаченного заказа денежный возврат недоступен. Неоплаченный заказ можно отменить.':'Вся оплаченная сумма уже возвращена.'));return;}
  const form=el('form'),inputs=[];let amount;
  const field=(title,input)=>{const label=el('label',title);label.append(input);form.append(label);return input;};
  if(kind==='cafe'){for(const l of info.lines.filter(l=>l.remainingQuantity>0||pending?.lines?.some(p=>p.index===l.index))){const input=field(l.name+' · '+money(l.unitCents)+' / шт.',el('input'));input.type='number';input.min=0;input.max=l.remainingQuantity;input.step=1;input.inputMode='numeric';input.value=pending?.lines?.find(p=>p.index===l.index)?.quantity||0;inputs.push({line:l,input});}form.append(el('p','Приготовленные продукты остаются списанными. Возврат денег не отменяет выдачу заказа.'));}
  else{amount=field('Сумма возврата, ₽',el('input'));amount.inputMode='decimal';amount.required=true;amount.value=((pending?.amountCents??info.remainingCents)/100).toFixed(2);form.append(el('p','Возврат денег не закрывает аренду. Когда техника вернётся, нажмите «Вернулся».'));}
  const reason=field('Причина',el('textarea'));reason.required=true;reason.maxLength=300;reason.value=pending?.reason||'';
  const total=el('p'),message=el('p');message.setAttribute('role','status');const button=el('button',pending?'Повторить сохранение':'Зафиксировать возврат');button.type='submit';form.append(total,button,message);out.append(form);
  function calculate(){return kind==='cafe'?inputs.reduce((n,x)=>n+Number(x.input.value)*x.line.unitCents,0):cents(amount.value);}
  function update(){confirmed=false;button.textContent=pending?'Повторить сохранение':'Зафиксировать возврат';try{total.textContent='Вернуть гостю: '+money(calculate());}catch{total.textContent='Проверьте сумму';}}
  function lock(){for(const input of [...inputs.map(x=>x.input),amount,reason].filter(Boolean))input.disabled=!!pending||busy;button.disabled=busy;}
  form.oninput=update;update();lock();
  form.onsubmit=async e=>{e.preventDefault();if(busy)return;try{
   if(!pending){const amountCents=calculate();if(!Number.isSafeInteger(amountCents)||amountCents<=0||amountCents>info.remainingCents)throw Error('Проверьте сумму возврата.');if(!confirmed){confirmed=true;button.textContent='Подтвердить возврат '+money(amountCents);message.textContent='Деньги нужно вернуть гостю отдельно. Здесь сохраняется учёт операции.';return;}pending={requestId:crypto.randomUUID(),kind,id,amountCents,reason:reason.value.trim(),...(kind==='cafe'?{lines:inputs.filter(x=>Number(x.input.value)>0).map(x=>({index:x.line.index,quantity:Number(x.input.value)}))}:{})};try{sessionStorage.setItem(key,JSON.stringify(pending));}catch{}}
   busy=true;lock();await api('',pending);pending=null;try{sessionStorage.removeItem(key);}catch{}busy=false;await load();await onSaved?.();document.dispatchEvent(new Event('station-updated'));
  }catch(e){message.textContent=e.message;if(e.status>=400&&e.status<500&&![401,403,408,429].includes(e.status)){pending=null;try{sessionStorage.removeItem(key);}catch{}confirmed=false;button.textContent='Зафиксировать возврат';}}finally{busy=false;lock();}}
 }
}};
})();
