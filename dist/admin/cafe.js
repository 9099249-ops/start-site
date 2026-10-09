(()=>{'use strict';
function paymentDiagnostic(p){const d=p?.diagnostic;if(!d?.message||['done','cash_done','cancelled'].includes(p.state))return null;const box=document.createElement('details'),heading=document.createElement('summary'),message=document.createElement('p');box.dataset.paymentDiagnostic='1';box.open=true;const receipt=d.phase==='receipt'||p.paid,waiting=['payment_waiting','receipt_waiting','payment_sending','receipt_sending','paid'].includes(p.state);heading.textContent=waiting?(receipt?'Проверка чека':'Проверка оплаты'):(receipt?'Почему чек ещё не подтверждён':'Почему оплата остановилась');message.textContent=d.message;box.append(heading,message);const checked=Number(d.checkedAt);if(Number.isFinite(checked)&&checked>0){const when=document.createElement('small');when.textContent='Проверено '+new Date(checked).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})+' МСК';box.append(when);}return box;}
const $=s=>document.querySelector(s),make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const money=n=>(n/100).toLocaleString('ru-RU')+' ₽',date=n=>new Date(n).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}),clone=v=>JSON.parse(JSON.stringify(v)),id=()=>crypto.randomUUID();
const statuses={NEW:'В работе',ACCEPTED:'В работе',COOKING:'В работе',READY:'Готов к выдаче',DELIVERED:'Выполнен',CANCELLED:'Отменён'},nextStatus={NEW:'DELIVERED',ACCEPTED:'DELIVERED',COOKING:'DELIVERED',READY:'DELIVERED'},sources={admin:'Администратор',waiter:'Сотрудник',customer_web:'Сайт',customer_nfc:'QR / NFC'},kinds={pickup:'В кафе',lounge:'К столу / в лаунж',house:'Домик в яхт клубе',yacht:'Яхта / причал',place:'Стол / место'};
let terminalIssues=[];let visibleOrders=50;let user,catalog,ownerLoaded=false,ownerLoadedUser=null,places=[],rows=[],current=null,tab='compose',ordersSignature='',qrBlob=null,scrolls={},changingTab=false;
let noticeTimer;
const notice=(t,transient=false)=>{clearTimeout(noticeTimer);$('#notice').textContent=t||'';if(t&&transient)noticeTimer=setTimeout(()=>{$('#notice').textContent='';},4000);};
const cafeToday=()=>new Date(Date.now()+10800000).toISOString().slice(0,10);
let observedDay=cafeToday();
function syncOrderDay(){const today=cafeToday();if(today!==observedDay){if($('#order-date').value===observedDay)$('#order-date').value=today;observedDay=today;}}
function restoreOrderDay(saved){return saved?.savedDay===cafeToday()&&/^\d{4}-\d{2}-\d{2}$/.test(saved.date)?saved.date:cafeToday();}
function orderDayLabel(value){return value===cafeToday()?'Заказы за сегодня':'Заказы за '+new Date(value+'T12:00:00+03:00').toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'});}
async function request(path,body){
 let r,d;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),body?45000:15000);
 try{r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:controller.signal});d=await r.json();}
 catch{throw Object.assign(Error(body?'Нет подтверждения от сервера. Изменение могло сохраниться. После восстановления связи проверьте заказ перед повтором.':'Нет связи с сервером. Данные на экране могут быть устаревшими.'),{network:true});}finally{clearTimeout(timer);}
 if(!r.ok){if(r.status===401){$('#cabinet').hidden=true;$('#login').hidden=false;}throw Object.assign(Error(r.status>=500?'Сервер временно недоступен. '+(body?'Изменение могло сохраниться — проверьте заказ перед повтором.':'Повторите после восстановления связи.'):(d.error||'Ошибка запроса.')),{status:r.status});}return d;
}
const api=(p,b)=>request('/api/admin/cafe/'+p,b);
const safe=fn=>async e=>{try{notice('');await fn(e);}catch(e){notice(e.message);}};
function button(label,fn,cls){const b=make('button',label,cls);b.type='button';b.onclick=safe(async e=>{b.disabled=true;try{await fn(e);}finally{b.disabled=false;}});return b;}
function field(out,label,value,type='text'){const l=make('label',label),i=make(type==='textarea'?'textarea':'input');if(type!=='textarea')i.type=type;i.value=value??'';if(type==='number'){i.min=0;i.step=1;}l.append(i);out.append(l);return i;}
function check(out,label,value){const l=make('label',undefined,'check'),i=make('input');i.type='checkbox';i.checked=!!value;l.append(i,document.createTextNode(label));out.append(l);return i;}
function select(out,label,value,options){const l=make('label',label),i=make('select');for(const [v,n] of options){const o=make('option',n);o.value=v;i.append(o);}i.value=value;l.append(i);out.append(l);return i;}
function cents(v){const s=String(v).replace(',','.');if(!/^\d{1,6}(\.\d{1,2})?$/.test(s))throw Error('Цена: рубли, не больше двух знаков после запятой.');const [r,k='']=s.split('.');return Number(r)*100+Number(k.padEnd(2,'0'));}
async function save(change){const d=clone(catalog);change(d);catalog=await api('menu',d);renderCatalog();}
const boardTextGroups=[['Бренд и сотрудники',['brandName','brandSubtitle','tagline','staffLabel']],['Колонки заказов',['cookingTitle','cookingSubtitle','readyTitle','readySubtitle']],['Пустые колонки',['emptyCookingTitle','emptyCookingHint','emptyReadyTitle','emptyReadyHint']],['Подписи табло',['shoreNote','footerNote','siteLabel']],['Выдача заказа',['readyMessage','pickupLabel']]];
function renderBoardTextForm(value){const form=$('#board-text-form'),out=$('#board-text-fields'),settings=window.CafeBoardText.resolve(value);out.replaceChildren();const controls=new Map();for(const [title,keys] of boardTextGroups){const group=make('fieldset'),legend=make('legend',title);group.append(legend);let row=null;for(const [index,key] of keys.entries()){if(index%2===0){row=make('div',undefined,'two');group.append(row);}const definition=window.CafeBoardText.fields.find(field=>field.key===key),label=make('label',definition.label),input=make('input');input.type='text';input.name=key;input.value=settings[key];input.maxLength=definition.max;input.required=definition.required;label.append(input);row.append(label);controls.set(key,input);}out.append(group);}form.dataset.ready='1';return controls;}
function fillBoardTextForm(value){renderBoardTextForm(value);}
function editor(title,build,onError){$('#editor-title').textContent=title;$('#editor-error').textContent='';$('#editor-form').querySelector(':scope > button.primary').hidden=false;const out=$('#editor-fields');out.replaceChildren();const submit=build(out);$('#editor-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;if(!b||b.hidden)return;b.disabled=true;try{await submit();$('#editor').close();notice('Сохранено.',true);}catch(e){$('#editor-error').textContent=e.message;if(onError)await onError(e,out);}finally{b.disabled=false;}};$('#editor').showModal();}
function variants(out,initial,{options=false}={}){const list=make('div');out.append(list);const entries=[];function add(v={id:id(),name:'',priceCents:0,active:true,soldOut:false}){const row=make('div',undefined,'mini-row'),name=field(row,'Название',v.name),price=field(row,'Доплата, ₽',v.priceCents/100);price.inputMode='decimal';const flags=make('div',undefined,'flags'),active=check(flags,'Включён',v.active),sold=options?check(flags,'Стоп',v.soldOut):null;row.append(flags);list.append(row);entries.push({v,name,price,active,sold});}initial.forEach(add);out.append(button('+ Вариант',()=>add()));return ()=>entries.filter(e=>e.name.value.trim()).map(e=>({...e.v,name:e.name.value.trim(),priceCents:cents(e.price.value),active:e.active.checked,...(options?{soldOut:e.sold.checked}:{})}));}
function editItem(item){window.STARTCafeProductCard.open(item,{onSaved:data=>{catalog=data.catalog;renderCatalog();},onError:message=>notice(message)});}
function editCategory(c){const original=c||{id:id(),name:'',sort:catalog.categories.length*10+10,active:true};editor('Категория',out=>{const name=field(out,'Название',original.name),sort=field(out,'Порядок',original.sort,'number'),active=check(out,'Показывать категорию',original.active);name.required=true;return ()=>save(d=>{const x={...original,name:name.value,sort:Number(sort.value),active:active.checked},i=d.categories.findIndex(x=>x.id===original.id);if(i>=0)d.categories[i]=x;else d.categories.push(x);});});}
function editGroup(g){const original=g||{id:id(),name:'',min:0,max:1,active:true,options:[]};editor('Группа добавок',out=>{const name=field(out,'Название',original.name),two=make('div',undefined,'two');out.append(two);name.required=true;const min=field(two,'Минимум выборов',original.min,'number'),max=field(two,'Максимум выборов',original.max,'number'),active=check(out,'Группа включена',original.active),getOptions=variants(out,original.options,{options:true});return ()=>save(d=>{const x={...original,name:name.value,min:Number(min.value),max:Number(max.value),active:active.checked,options:getOptions()},i=d.groups.findIndex(x=>x.id===original.id);if(i>=0)d.groups[i]=x;else d.groups.push(x);});});}
function renderCatalog(){if(!catalog)return;const out=$('#catalog-list'),query=$('#catalog-search').value.toLowerCase();out.replaceChildren();for(const c of [...catalog.categories].sort((a,b)=>a.sort-b.sort)){const title=make('div',undefined,'category-title');title.append(make('h2',c.name+(c.active?'':' · скрыта')),button('Изменить',()=>editCategory(c)));out.append(title);for(const i of catalog.items.filter(i=>i.categoryId===c.id&&i.name.toLowerCase().includes(query)).sort((a,b)=>a.sort-b.sort)){const row=make('div',undefined,'catalog-row'+(!i.active?' off':''));row.append(make('span',i.name+' · '+money(i.priceCents)),button(i.soldOut?'Вернуть':'В стоп',()=>save(d=>{d.items.find(x=>x.id===i.id).soldOut=!i.soldOut;})),button('Правка',()=>editItem(i)));out.append(row);}}$('#group-list').replaceChildren(...catalog.groups.map(g=>button(g.name,()=>editGroup(g))));}
function editPlace(p){const x=p||{name:'',type:'table',active:true};editor('Стол / место',out=>{const name=field(out,'Название',x.name),type=select(out,'Тип',x.type,[['table','Стол'],['lounge','Лаунж'],['other','Другое']]),active=check(out,'Принимать заказы на место',x.active);name.required=true;return async()=>{places=(await api('places',{...x,name:name.value,type:type.value,active:active.checked})).items;renderPlaces();};});}
function showQR(p){const url=location.origin+'/cafe/t/'+p.token;const code=qrcode(0,'M');code.addData(url);code.make();const svg=code.createSvgTag({cellSize:6,margin:24,scalable:true});$('#qr-title').textContent=p.name;$('#qr-image').innerHTML=svg;$('#qr-url').textContent=url;if(qrBlob)URL.revokeObjectURL(qrBlob);qrBlob=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));$('#qr-download').href=qrBlob;$('#qr-download').download='START-place-'+p.id+'.svg';$('#qr-dialog').showModal();}
function renderPlaces(){const out=$('#place-list');out.replaceChildren();for(const p of places){const row=make('div',undefined,'place-row'),url=location.origin+'/cafe/t/'+p.token;row.append(make('h3',p.name+(p.active?'':' · выключено')));const link=make('input');link.readOnly=true;link.value=url;link.setAttribute('aria-label','Ссылка NFC для '+p.name);row.append(link);const tools=make('div',undefined,'toolbar');tools.append(button('QR',()=>showQR(p)),button('Копировать NFC',async()=>{await navigator.clipboard.writeText(url);notice('Ссылка скопирована. Запишите её в NFC-метку.');}),button('Изменить',()=>editPlace(p)),button('Заменить ссылку',async()=>{if(!confirm('Старые QR и NFC перестанут работать. Заменить ссылку?'))return;places=(await api('places',{...p,active:!!p.active,rotate:true})).items;renderPlaces();}));row.append(tools);out.append(row);}const value=$('#order-place').value;$('#order-place').replaceChildren(new Option('Все места',''),...places.map(p=>new Option(p.name,p.id)));$('#order-place').value=value;}
function orderPlaceLabel(d){const place=d.place?.name||(d.fulfillment==='lounge'&&d.location);if(place)return ['place','lounge'].includes(d.fulfillment)&&/^\d+$/.test(String(place).trim())?'Стол '+String(place).trim():place;return d.fulfillment==='house'?'Домик: '+d.house:kinds[d.fulfillment];}
function wasPrepared(r){return r.events.some(e=>['COOKING','READY','DELIVERED'].includes(e.kind));}
function stockNotice(out,r){
 if(r.status!=='CANCELLED'&&!r.refundedCents)return;
 const stock=r.stock;if(!stock)return;
 const titles={retained:'Ингредиенты не восстановлены',restored:'Ингредиенты восстановлены',mixed:'Ингредиенты восстановлены частично',none:'Без складского расхода'};
 const box=make('details');box.dataset.stockOutcome='1';box.append(make('summary',titles[stock.state]));
 for(const event of r.events)if(event.kind==='CANCELLED'&&event.comment)box.append(make('p','Причина отмены: '+event.comment));
 if(r.refundedCents&&r.status!=='CANCELLED')box.append(make('p','Расход всего заказа сохранён. Денежный возврат не восстанавливает ингредиенты.'));
 for(const item of stock.items){if(item.retainedMilli>0)box.append(make('p',item.name+': списано '+item.retained+' '+item.unit));if(item.restoredMilli>0)box.append(make('p',item.name+': восстановлено '+item.restored+' '+item.unit));}
 out.append(box);
}
function renderStockReport(report){
 let box=$('#stock-cancellations');if(!box){box=make('details');box.id='stock-cancellations';$('#order-list').before(box);}
 box.hidden=!report?.count;box.replaceChildren();if(box.hidden)return;
 box.append(make('summary','Отмены со списанием за день: '+report.count));
 for(const item of report.items)box.append(make('p',item.name+': '+item.retained+' '+item.unit));
}
function cancellationAdvice(out,r){
 const d=r.details||{},p=r.terminalPayment,paid=!!d.terminalPaidAt||p?.paid||['done','cash_done'].includes(p?.state)||r.status==='DELIVERED'&&!d.terminalPaymentRequired;
 const remaining=Math.max(0,r.total_cents-(r.refundedCents||0));
 const openRefund=async()=>{await openOrder(r.id);const panel=$('#order-detail').querySelector('.refund-panel');if(panel){panel.open=true;panel.scrollIntoView({block:'center'});}};
 if(d.guestBillId){out.append(make('p','Заказ входит в счёт гостя. Отмену неоплаченных позиций или возврат нужно оформить в этом счёте.'),button('Открыть счёт гостя №'+d.guestBillId,()=>{$('#editor').close();return window.STARTGuests.show(d.guestBillId);}));return true;}
 if(p&&!['done','cash_done','cancelled'].includes(p.state)){
  out.append(make('p',p.paid?'Деньги уже получены. Перед отменой нужно завершить проверку чека. Повторно принимать оплату нельзя.':'Результат оплаты пока неизвестен. Сначала проверьте историю CS50: без этого нельзя безопасно отменить заказ или повторить списание.'));
  reconciliationActions(out,r);receiptActions(out,r);
  out.append(button('Проверить статус оплаты',async()=>{const fresh=await api('order?id='+r.id);out.replaceChildren();if(!cancellationAdvice(out,fresh)){$('#editor').close();cancelOrder(fresh);}}));
  return true;
 }
 if(paid&&!d.complimentary&&(remaining>0||r.status==='DELIVERED')){
  out.append(make('p',remaining>0?'Заказ уже оплачен. Чтобы отменить покупку, сначала верните гостю деньги и сохраните возврат. Повторная оплата не нужна.':'Деньги уже возвращены. Выданный заказ остаётся выполненным, возврат сохранён отдельно.'));
  out.append(button(remaining>0?'Открыть возврат · '+money(remaining):'Посмотреть возврат',()=>{$('#editor').close();return openRefund();},'primary'));
  return true;
 }
 return false;
}
function cancelOrder(r){
 editor('Отмена заказа №'+window.STARTCafeNumber(r.id),out=>{
  if(cancellationAdvice(out,r)){$('#editor-form').querySelector(':scope > button.primary').hidden=true;return async()=>{};}
  const prepared=wasPrepared(r);let choice;
  if(prepared){choice={value:'yes'};out.append(make('p','Приготовление: начато / уже готово · зафиксировано в истории заказа.'));}
  else{choice=select(out,'Приготовление','',[['','Выберите'],['no','Не начинали готовить'],['yes','Начали готовить / уже готово']]);choice.required=true;}
  const warning=make('p');out.append(warning);const update=()=>{warning.textContent=choice.value==='yes'?'Ингредиенты останутся списанными.':choice.value==='no'?'Ингредиенты будут возвращены на склад.':'';};choice.onchange=update;update();
  const reason=field(out,'Причина отмены','','textarea');reason.required=true;reason.maxLength=200;
  return async()=>{
   if(!['yes','no'].includes(choice.value))throw Error('Укажите, начали ли готовить заказ.');
   current=await api('status',{id:r.id,revision:r.revision,status:'CANCELLED',prepared:choice.value==='yes',comment:reason.value});
   renderDetail();await loadOrders(true);document.dispatchEvent(new Event('station-updated'));
  };
 },async(e,out)=>{
  try{const fresh=await api('order?id='+r.id),help=make('section');if(cancellationAdvice(help,fresh)){out.replaceChildren(help);$('#editor-form').querySelector(':scope > button.primary').hidden=true;}}
  catch{}
 });
}

function orderTone(r){const p=r.terminalPayment;if(r.status==='CANCELLED'||['review','payment_unknown','receipt_unknown'].includes(p?.state))return 'red';if(p?.paid&&!['done','cash_done'].includes(p.state))return 'yellow';return r.details.terminalPaidAt||r.details.complimentary||['done','cash_done'].includes(p?.state)?'green':'yellow';}
function toneLabel(r){return orderTone(r)==='red'?(r.status==='CANCELLED'?'Отменён':'Нужна сверка'):orderTone(r)==='green'?(r.details.complimentary?'Выдан бесплатно':'Оплачено'):r.terminalPayment?.paid?'Оплачено · проверить чек':'Ожидает оплаты';}
function manualPaidActions(root,r){
 if(!needsTerminal(r)||r.terminalPayment&&!['cancelled'].includes(r.terminalPayment.state))return;
 for(const [method,label] of [['card','Карта / QR уже оплачены'],['cash','Наличные уже получены']])root.append(button(label,async()=>{
  const note=method==='cash'?'Сотрудник подтвердил: наличные получены, фискальный чек пробит, операция на кассе завершена.':'Сотрудник подтвердил: карта / QR оплачены, фискальный чек пробит, операция на кассе завершена.';
  if(!confirm('Заказ №'+window.STARTCafeNumber(r.id)+' · '+money(r.total_cents)+'\n'+note+'\nТолько учёт: повторного списания и печати чека не будет.'))return;
  await api('manual-paid',{id:r.id,revision:r.revision,paymentId:r.terminalPayment?.id||null,method,note,confirmed:true,terminalIdle:true,receiptExists:true});
  await loadOrders(true);await openOrder(r.id);document.dispatchEvent(new Event('station-updated'));
 }));
}
function reconciliationActions(root,r){
 const p=r.terminalPayment;if(!p||!['review','payment_unknown','payment_waiting'].includes(p.state)||p.paid)return;
 root.append(make('p','Сверьте историю CS50 и завершите прежний запрос. Если результат неизвестен, повторно принимать оплату нельзя.'));
 for(const [result,label,note] of [
  ['unpaid','Списания нет · снять блокировку','Сотрудник проверил историю CS50: списания нет, запрос на кассе завершён.'],
  ['card','Карта / QR оплачены · учесть','Сотрудник проверил: карта / QR оплачены, фискальный чек пробит, запрос на кассе завершён.'],
  ['cash','Наличные получены · учесть','Сотрудник проверил: наличные получены, фискальный чек пробит, запрос на кассе завершён.']
 ])root.append(button(label,async()=>{
  if(!confirm('Заказ №'+window.STARTCafeNumber(r.id)+' · '+money(r.total_cents)+'\n'+note+'\n'+(result==='unpaid'?'После подтверждения станет доступна повторная оплата.':'Деньги повторно не списываются, новый чек не печатается.')))return;
  await api('reconcile-payment',{id:r.id,paymentId:p.id,result,confirmed:true,note});
  await openOrder(r.id);await loadOrders(true);document.dispatchEvent(new Event('station-updated'));
 }));
}
function receiptActions(root,r){const p=r.terminalPayment;if(!p?.paid||!['review','receipt_unknown'].includes(p.state))return;root.append(make('p',p.terminalReleased?'Касса освобождена для следующих заказов. Этот чек ещё нужно сверить.':'Оплата уже получена. Проверьте историю CS50; повторно принимать деньги нельзя.'));root.append(button('Оплата прошла, чек есть',async()=>{if(!confirm('Проверили фискальный чек на '+money(r.total_cents)+' по заказу №'+window.STARTCafeNumber(r.id)+' в истории CS50? Операция на кассе завершена?'))return;await api('confirm-receipt',{id:r.id,paymentId:p.id,result:'receipt_exists',confirmed:true,terminalIdle:true});await loadOrders(true);await openOrder(r.id);document.dispatchEvent(new Event('station-updated'));}));if(!p.terminalReleased)root.append(button('Касса свободна — продолжить работу',async()=>{if(!confirm('На CS50 операция завершена и экран оплаты закрыт? Подтверждение освободит кассу, но этот чек останется на сверке.'))return;await api('confirm-receipt',{id:r.id,paymentId:p.id,result:'terminal_free',confirmed:true,terminalIdle:true});await loadOrders(true);await openOrder(r.id);document.dispatchEvent(new Event('station-updated'));}));}
function issueLinks(root,issues){for(const issue of issues){root.append(make('p',(issue.blocking?'Блокирует кассу: ':'Проверить чек: ')+(issue.orderId?'заказ №'+window.STARTCafeNumber(issue.orderId)+' · ':'')+money(issue.amountCents)+' · '+issue.reason));if(issue.scope==='aqsi_cafe'&&issue.orderId)root.append(button('Сверить заказ №'+window.STARTCafeNumber(issue.orderId),()=>openOrder(issue.orderId)));else{const link=make('a','Открыть сверку');link.href=issue.href;root.append(link);}}}
function renderTerminalNotice(){if(!$('#payment-help')){const help=make('details',undefined,'payment-help'),summary=make('summary','Статусы оплаты');help.id='payment-help';help.append(summary,make('p','Зелёный — оплачено · Жёлтый — ожидание · Красный — нужна сверка или отменён. Текст статуса и предупреждения показаны в заказе.'));$('#order-list').before(help);}let box=$('#terminal-issues');if(!box){box=make('section',undefined,'terminal-issues');box.id='terminal-issues';$('#order-list').before(box);}box.replaceChildren();box.hidden=!terminalIssues.length;if(terminalIssues.length){box.append(make('strong',terminalIssues.some(i=>i.blocking)?'Касса требует сверки':'Есть чеки для сверки'));issueLinks(box,terminalIssues);}}
function needsTerminal(r){return !r.details.guestBillId&&!r.details.manualPaymentRequired&&r.details.terminalPaymentRequired&&!r.details.terminalPaidAt&&!['DELIVERED','CANCELLED'].includes(r.status);}
function canMarkReady(r){const d=r.details;return ['NEW','ACCEPTED','COOKING'].includes(r.status)&&!needsTerminal(r)&&(!d.guestBillId||d.guestDeferred||d.terminalPaidAt);}
async function payOrder(r,cash=false){await openOrder(r.id);try{const payment=await api('pay',{id:r.id,revision:r.revision,cash,retryPaymentId:r.terminalPayment?.state==='cancelled'?r.terminalPayment.id:undefined});window.STARTTerminalVoice?.prompt(payment,{cash,previousId:r.terminalPayment?.id});}finally{await loadOrders(true);await openOrder(r.id);}}
let orderListTotal=0,orderActiveCount=0;
function updateOrderAges(){for(const e of $('#order-list').querySelectorAll('[data-order-created]')){const text=' · '+Math.max(0,Math.floor((Date.now()-Number(e.dataset.orderCreated))/60000))+' мин';if(e.textContent!==text)e.textContent=text;}}
function renderOrders(){
 document.querySelector('[data-tab=orders]').textContent='Все заказы'+(orderActiveCount?' · '+orderActiveCount:'');
 const out=$('#order-list'),existing=new Map([...out.querySelectorAll('article[data-order-id]')].map(x=>[Number(x.dataset.orderId),x])),nextRows=[];
 for(const r of rows){
  const old=existing.get(r.id);if(old?._signature===r.version){nextRows.push(old);continue;}
  const wrap=make('article',undefined,'order-line'),b=make('button',undefined,'order-row '+r.status+' payment-'+r.tone);wrap.dataset.orderId=r.id;wrap._signature=r.version;b.type='button';
  b.append(make('b','№'+r.number+' · '+r.placeLabel),make('strong',r.free?'Бесплатно':money(r.totalCents-r.refundedCents)+(r.refundedCents?' · возврат':'')));
  const state=make('span',r.customerLabel+' · '+r.statusLabel);if(!['DELIVERED','CANCELLED'].includes(r.status)){const age=make('span');age.dataset.orderCreated=r.created;state.append(age);}b.append(state,make('small',r.itemsLabel));
  const commentLines=[];if(r.comment)commentLines.push('Комментарий: '+r.comment);for(const item of r.itemComments||[]){const details=[item.variant,...item.options].filter(Boolean).join(' · ');commentLines.push(item.name+(details?' · '+details:'')+(item.comment?': '+item.comment:''));}if(commentLines.length)b.append(make('small',commentLines.join('\n'),'order-comments'));
  b.append(make('small',r.paymentLabel,'payment-label'));b.onclick=safe(()=>openOrder(r.id));wrap.append(b);
  const actions=make('div',undefined,'order-actions');wrap.append(actions);
  if(r.ready){const ready=button('Готов к выдаче',async()=>{await api('status',{id:r.id,revision:r.revision,status:'READY'});await loadOrders(true);document.dispatchEvent(new Event('station-updated'));},'order-next order-ready order-primary');ready.setAttribute('aria-label','Готов к выдаче заказ №'+r.number);actions.append(ready);}
  if(r.action){const quick=button(r.action==='check'?'Проверить оплату':r.action==='pay'?'Оплатить':r.ready?'Выдать сразу':'Выполнен',async()=>{if(r.action==='check')return openOrder(r.id);if(r.action==='pay')return payOrder(await api('order?id='+r.id));await api('status',{id:r.id,revision:r.revision,status:'DELIVERED'});await loadOrders(true);document.dispatchEvent(new Event('station-updated'));},'order-next'+(r.ready?' order-secondary':''));quick.setAttribute('aria-label',quick.textContent+' заказ №'+r.number);actions.append(quick);}
  nextRows.push(wrap);
 }
 const wanted=new Set(nextRows);for(const old of [...out.children])if(!wanted.has(old))old.remove();nextRows.forEach((node,i)=>{if(out.children[i]!==node)out.insertBefore(node,out.children[i]||null);});
 if(orderListTotal>rows.length)out.append(button('Показать ещё 50 · осталось '+(orderListTotal-rows.length),async()=>{visibleOrders+=50;await loadOrders(true);}));
 if(!rows.length){out.append(make('p',$('#order-status').value==='active'?'Нет заказов в работе.':'Нет заказов по выбранным условиям.','muted'));out.append(button('Показать все за этот день',async()=>{$('#order-status').value='';$('#order-source').value='';$('#order-place').value='';$('#order-search').value='';visibleOrders=50;await loadOrders(true);}));}
 updateOrderAges();saveCafeView();
}
let ordersReadAt=0,ordersTask=null,ordersReload=false;
function loadOrders(fresh=false){
 if(ordersTask){if(fresh===true)ordersReload=true;return ordersTask;}
 ordersTask=(async()=>{try{do{ordersReload=false;await readOrders();}while(ordersReload);}finally{ordersTask=null;}})();return ordersTask;
}
let ordersQuery='';
function orderQuery(){return new URLSearchParams({list:'1',date:$('#order-date').value,status:$('#order-status').value,source:$('#order-source').value,place:$('#order-place').value,q:$('#order-search').value.trim(),limit:String(visibleOrders)}).toString();}
async function readOrders(){
 syncOrderDay();const query=orderQuery(),selectedDate=$('#order-date').value;
 const d=await api('orders?'+query+(query===ordersQuery&&ordersSignature?'&since='+encodeURIComponent(ordersSignature):''));
 if(query!==orderQuery()){ordersReload=true;return;}
 ordersReadAt=Date.now();if(d.unchanged){updateOrderAges();return;}
 ordersQuery=query;ordersSignature=d.revision;rows=d.rows;orderListTotal=d.total;orderActiveCount=d.activeCount;terminalIssues=d.terminalIssues||[];renderTerminalNotice();
 $('#order-total').textContent=orderDayLabel(selectedDate)+': '+'оплачено '+money(d.paidRevenueCents??(d.totalCents-(d.refundsCents||0)))+' · '+d.dayCount+' заказов'+(d.refundsCents?' · возвраты: '+money(d.refundsCents):'')+(d.complimentaryCents?' · Бесплатно по меню: '+money(d.complimentaryCents):'');
 $('#export').href='/api/admin/cafe/export?date='+selectedDate;renderStockReport(d.stockCancellations);renderOrders();
}
async function openOrder(orderId){current=await api('order?id='+orderId);renderDetail();if(!$('#order-dialog').open){if(matchMedia('(min-width:1100px)').matches)$('#order-dialog').show();else $('#order-dialog').showModal();}history.replaceState(null,'','#order-'+orderId);}
function renderPaymentDiagnostic(root,p){root.querySelector('[data-payment-diagnostic]')?.remove();const diagnostic=paymentDiagnostic(p);if(diagnostic)root.append(diagnostic);}
function renderDetail(){const r=current,d=r.details,out=$('#order-detail');out.dataset.paymentTone=orderTone(r);out.replaceChildren(make('h2','Заказ №'+window.STARTCafeNumber(r.id)),make('small','Внутренний ID: '+r.id),make('p',(needsTerminal(r)?'Ожидает оплаты':statuses[r.status])+' · '+date(r.created)),make('p',d.name+(d.phone?' · +'+d.phone:'')),make('p',orderPlaceLabel(d)),make('p',[d.yacht,!['lounge','place','house'].includes(d.fulfillment)&&d.location].filter(Boolean).join(' · ')),make('p',d.requestedAt?'К '+d.requestedAt.replace('T',' '):'Как можно скорее · от '+d.prepMinutes+' мин'),make('p',d.complimentary?'За счёт заведения · к оплате 0 ₽':d.manualCashReceipt?'Наличные · чек вручную на CS50':d.terminalPaymentRequired?'Карта / QR СБП на CS50':d.payment==='unspecified'?'Оплата без разделения':d.payment==='cash'?'Наличные при получении':'Карта при получении'));
 const next=needsTerminal(r)||r.status==='READY'||!d.items.some(item=>item.blockQuickSale===true)?nextStatus:{};
 for(const i of d.items){const box=make('div',undefined,'place-row');box.append(make('b',i.quantity+' × '+i.name+' · '+money(i.totalCents)));if(i.variant)box.append(make('p',i.variant.name));for(const m of i.modifiers)box.append(make('p','+ '+m.name+' · '+money(m.priceCents)));if(i.comment)box.append(make('p',i.comment));out.append(box);}if(d.deliveryCents!==undefined)out.append(make('p','Доставка: '+money(d.deliveryCents)));if(d.complimentary)out.append(make('p','БЕСПЛАТНО · '+d.complimentary.recipientName+' · по меню '+money(d.complimentary.menuValueCents)+(d.complimentary.comment?' · '+d.complimentary.comment:'')));if(d.comment)out.append(make('p','Комментарий: '+d.comment));out.append(make('h2','Итого '+money(r.total_cents)));if(r.refundedCents)out.append(make('p','Возвращено: '+money(r.refundedCents)+' · осталось оплачено: '+money(r.total_cents-r.refundedCents)));const tools=make('div',undefined,'toolbar');async function change(status){if(status==='CANCELLED'&&!confirm('Отменить заказ №'+window.STARTCafeNumber(r.id)+'?'))return;try{current=await api('status',{id:r.id,revision:r.revision,status});renderDetail();await loadOrders(true);document.dispatchEvent(new Event('station-updated'));}catch(e){$('#detail-error').textContent=e.message;}}
 if(['lounge','place'].includes(d.fulfillment)&&!['CANCELLED','DELIVERED'].includes(r.status)){const placeForm=make('form',undefined,'place-assignment'),input=field(placeForm,'Номер места / стол',d.place?.name||d.location);input.required=true;input.maxLength=160;input.placeholder='Например: стол 3';const save=make('button','Сохранить место');save.type='submit';placeForm.append(save);let pending;placeForm.onsubmit=async e=>{e.preventDefault();if(save.disabled)return;save.disabled=true;try{if(!pending)pending={id:r.id,revision:r.revision,requestId:id(),location:input.value};input.disabled=true;current=await api('location',pending);renderDetail();await loadOrders(true);}catch(e){$('#detail-error').textContent=e.message+' Повторное сохранение безопасно.';if(e.status&&e.status<500){pending=null;input.disabled=false;if(e.status===409){try{await openOrder(r.id);$('#detail-error').textContent='Заказ обновился. Проверьте место и сохраните снова.';}catch{}}}}finally{save.disabled=false;}};out.append(placeForm);}
 if(['NEW','ACCEPTED'].includes(r.status)&&!needsTerminal(r)&&(!d.guestBillId||d.guestDeferred||d.terminalPaidAt))tools.append(button('Начать готовить',()=>change('COOKING')));if(['NEW','ACCEPTED','COOKING'].includes(r.status)&&!needsTerminal(r)&&(!d.guestBillId||d.guestDeferred||d.terminalPaidAt))tools.append(button('Готов к выдаче',()=>change('READY'))); if(next[r.status]&&(!d.guestBillId||d.guestDeferred||d.terminalPaidAt))tools.append(needsTerminal(r)?button(r.terminalPayment?.state==='cancelled'?'Повторить на кассе':r.terminalPayment?'Обновить оплату':'Оплатить · '+money(r.total_cents),()=>r.terminalPayment&&r.terminalPayment.state!=='cancelled'?openOrder(r.id):payOrder(r),'primary'):button(statuses[next[r.status]],()=>change(next[r.status]),'primary'));if((needsTerminal(r)||!d.terminalPaymentRequired&&!d.terminalPaidAt&&!d.guestBillId&&!d.complimentary&&!['DELIVERED','CANCELLED'].includes(r.status)&&['admin','waiter'].includes(r.source))&&(!r.terminalPayment||r.terminalPayment.state==='cancelled'))tools.append(button('Получено наличными · '+money(r.total_cents),()=>payOrder(r,true)));if(!r.terminalPayment&&!r.details.guestBillId&&!wasPrepared(r)&&!['DELIVERED','CANCELLED'].includes(r.status)){const a=make('a','+ Дозаказ','primary');a.href='/admin/cafe/?append='+r.id+'#new';tools.append(a);}if(r.status!=='CANCELLED')tools.append(button('Отменить заказ',()=>cancelOrder(r),'danger'));manualPaidActions(tools,r);out.append(tools);if(d.terminalPaymentRequired&&!d.guestBillId&&!d.manualPaymentRequired){const payment=make('section',undefined,'place-row');payment.classList.add('payment-state');payment.dataset.state=r.terminalPayment?.state||'waiting';payment.setAttribute('aria-live','polite');payment.append(make('h3',r.terminalPayment?.state==='cancelled'?'Клиент отменил оплату':r.terminalPayment?.state==='done'||r.terminalPayment?.state==='cash_done'?'Оплачено':r.terminalPayment?.paid?'Оплата получена · проверяем чек':r.terminalPayment?.label||'Ждём оплату'),make('p',r.terminalPayment?.state==='cash_done'?(d.paymentMethod==='card'?'Ручная оплата картой / QR учтена.':(d.manualFiscalConfirmation?.confirmed?'Наличные учтены. Фискальный чек подтверждён сотрудником.':'Наличные учтены. Фискальный чек пробейте вручную на CS50.')):r.terminalPayment?.state==='cancelled'?'Касса свободна. Можно повторить оплату, принять наличные или отменить заказ.':r.terminalPayment?.paid?'Оплата получена. '+(r.terminalPayment.state==='done'?'Фискальный чек подтверждён.':'Проверяем фискальный чек — повторно оплачивать не нужно.'):'На экране CS50 одновременно доступны карта и QR СБП.'));reconciliationActions(payment,r);receiptActions(payment,r);renderPaymentDiagnostic(payment,r.terminalPayment);if(r.terminalPayment?.paid)payment.append(make('p','Возврат денег выполняется вручную на CS50. После возврата внесите его в учёт ниже.'));out.append(payment);}if(needsTerminal(r)){const issues=terminalIssues.filter(i=>i.blocking&&i.orderId!==r.id);if(issues.length){const box=make('section',undefined,'terminal-issues');issueLinks(box,issues);out.append(box);}}const detail=make('details');detail.append(make('summary','Печать'));out.append(detail);stockNotice(out,r);if(r.details.guestBillId)out.append(button('Счёт гостя №'+r.details.guestBillId,()=>window.STARTGuests.show(r.details.guestBillId)));if(r.details.manualPaymentRequired&&!r.details.terminalPaidAt&&r.status!=='CANCELLED'){out.append(make('strong','НЕ ОПЛАЧЕНО'));for(const [method,label] of [['cash','Получено наличными'],['card','Оплачено вручную картой / QR']])out.append(button(label,async()=>{if(method!=='cash'&&!confirm('Подтвердить получение '+money(r.total_cents)+'?'))return;await window.STARTGuests.api('guest-bills/website-paid',{id:r.id,revision:r.revision,method});await openOrder(r.id);await loadOrders(true);document.dispatchEvent(new Event('station-updated'));}));}window.STARTRefunds?.mount(out,'cafe',r.id,user.id,async()=>{await loadOrders(true);await openOrder(r.id);});window.STARTPrint?.mountCafe(detail,r.id,user.role==='admin');$('#detail-error').textContent='';}
async function loadCatalog(){catalog=await api('menu');renderCatalog();}
async function loadOwner(){if(!catalog)await loadCatalog();const f=$('#settings-form'),s=catalog.settings;for(const k of ['open','close','prepMinutes','busyMessage'])f.elements[k].value=s[k];f.elements.enabled.checked=s.enabled;for(const k of ['payments','fulfillments'])f.querySelectorAll('[name='+k+']').forEach(x=>x.checked=s[k].includes(x.value));fillBoardTextForm(s.boardText);const staff=await api('staff');$('#staff-list').textContent=staff.items.map(x=>x.login).join(', ')||'Пока нет отдельных учётных записей.';ownerLoaded=true;ownerLoadedUser=user.id;}
function saveCafeView(){
 if(!user||changingTab||new URLSearchParams(location.search).has('settings'))return;
 scrolls[tab]=Math.max(0,scrollY);
 try{sessionStorage.setItem('cafe-filters-v3',JSON.stringify({user:user.id,status:$('#order-status').value,source:$('#order-source').value,place:$('#order-place').value,query:$('#order-search').value,date:$('#order-date').value,savedDay:observedDay,tab,scrolls,filtersOpen:$('#order-filters').open}));}catch{}
}
function allowedTab(value){return ['orders','compose','guests',...(user&&['admin','staff','waiter'].includes(user.role)?['menu']:[]),...(user?.role==='admin'?['management','places','settings']:[])].includes(value)?value:'compose';}
function needsOwnerLoad(role,tab,loaded){return role==='admin'&&!loaded&&!['orders','compose','guests','menu'].includes(tab);}
async function init(){
 const session=await request('/api/admin/session');user=session.user;if(ownerLoadedUser!==user?.id){ownerLoaded=false;ownerLoadedUser=user?.id??null;}$('#login').hidden=!!user;$('#cabinet').hidden=!user;$('#logout').hidden=!user;if(!user)return;
 $('#identity').textContent=user.login;$('.tabs').hidden=false;document.querySelectorAll('[data-owner]:not([data-tab="menu"])').forEach(e=>e.hidden=user.role!=='admin');places=(await api('places')).items;window.STARTCafeBootstrap={user,places};renderPlaces();
 let initial='compose';scrolls={};
 try{const f=JSON.parse(sessionStorage.getItem('cafe-filters-v3'));if(f&&f.user===user.id){$('#order-status').value=f.status??'active';$('#order-source').value=f.source||'';$('#order-place').value=f.place||'';$('#order-search').value=f.query||'';$('#order-date').value=restoreOrderDay(f);initial=allowedTab(f.tab);scrolls=f.scrolls&&typeof f.scrolls==='object'?f.scrolls:{[initial]:f.scroll||0};$('#order-filters').open=!!f.filtersOpen;}}catch{}
 const match=location.hash.match(/^#order-(\d+)$/);
 if(location.hash==='#new'||new URLSearchParams(location.search).has('append'))initial='compose';else if(match||location.hash==='#orders')initial='orders';
 const settingsTab=new URLSearchParams(location.search).get('settings');if(user.role==='admin'&&['places','settings','management'].includes(settingsTab)||['admin','staff','waiter'].includes(user.role)&&settingsTab==='menu')initial=settingsTab;
 if(initial==='orders'){changingTab=true;try{await loadOrders(true);}finally{changingTab=false;}}
 await selectCafeTab(initial,{initial:true});if(match)await openOrder(Number(match[1]));
}
$('#order-status').value='active';$('#order-date').value=cafeToday();try{const f=JSON.parse(sessionStorage.getItem('cafe-filters-v3'));if(f&&f.user===user?.id){$('#order-status').value=f.status;$('#order-source').value=f.source;$('#order-search').value=f.query;}}catch{}
$('#login-form').onsubmit=safe(async e=>{e.preventDefault();const f=e.currentTarget;const result=await request('/api/admin/login',{login:f.elements.login.value,password:f.elements.password.value});if(result.scheduleOnly){window.top.location.replace('/admin/schedule/?standalone=1');return;}f.reset();await init();});$('#logout').onclick=safe(async()=>{await request('/api/admin/logout',{});location.reload();});
$('#settings-form').onsubmit=safe(async e=>{e.preventDefault();const f=e.currentTarget;await save(d=>{d.settings={...d.settings,enabled:f.elements.enabled.checked,open:f.elements.open.value,close:f.elements.close.value,prepMinutes:Number(f.elements.prepMinutes.value),busyMessage:f.elements.busyMessage.value,payments:[...f.querySelectorAll('[name=payments]:checked')].map(x=>x.value),fulfillments:[...f.querySelectorAll('[name=fulfillments]:checked')].map(x=>x.value)};});notice('Настройки сохранены.');});
$('#board-text-form').onsubmit=safe(async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit],button:not([type])');if(b.disabled)return;const boardText=Object.fromEntries(window.CafeBoardText.fields.map(field=>[field.key,f.elements[field.key].value])),controls=[...f.querySelectorAll('input,button')],disabled=controls.map(control=>control.disabled);controls.forEach(control=>{control.disabled=true;});try{await save(d=>{d.settings.boardText=boardText;});fillBoardTextForm(catalog.settings.boardText);notice('Тексты табло сохранены.');}finally{controls.forEach((control,index)=>{control.disabled=disabled[index];});}});
$('#board-text-reset').onclick=()=>fillBoardTextForm(window.CafeBoardText.resolve());
$('#staff-form').onsubmit=safe(async e=>{e.preventDefault();const f=e.currentTarget;await api('staff',{login:f.elements.login.value,password:f.elements.password.value});f.reset();await loadOwner();notice('Доступ сотрудника сохранён.');});
async function selectCafeTab(next,{initial=false,keepGuest=false}={}){
 next=allowedTab(next);if(next==='compose'&&!initial&&!keepGuest&&window.STARTGuests?.clearCafe()===false)return;if(!initial&&$('#order-dialog').open)$('#order-dialog').close();
 if(!initial&&next==='compose'&&new URLSearchParams(location.search).has('append')){location.href='/admin/cafe/#new';return;}
 if(!initial)saveCafeView();
 const targetScroll=Math.max(0,Number(scrolls[next])||0);changingTab=true;tab=next;
 try{
  document.querySelectorAll('.screen').forEach(s=>s.hidden=s.id!==tab);document.querySelectorAll('[data-tab]').forEach(x=>{x.classList.toggle('selected',x.dataset.tab===tab);x.setAttribute('aria-pressed',String(x.dataset.tab===tab));});
  if(tab==='orders')await loadOrders(true);if(tab==='guests'){await window.STARTGuests.show(null,$('#guests'));const heading=$('#guests .guest-panel > h2');if(heading?.textContent==='Счета гостей')heading.remove();}if(tab==='compose')await window.openCafeComposer();
  document.dispatchEvent(new CustomEvent('cafe-compose-visibility',{detail:tab==='compose'}));
  if(tab==='menu'&&!catalog)await loadCatalog();if(needsOwnerLoad(user.role,tab,ownerLoaded&&ownerLoadedUser===user.id))await loadOwner();
  await new Promise(resolve=>requestAnimationFrame(resolve));scrollTo(0,targetScroll);
  if(!initial&&!new URLSearchParams(location.search).has('settings')&&!new URLSearchParams(location.search).has('append')){
   const routeHash=next==='compose'?'#new':next==='orders'?'#orders':'';
   if(location.hash!==routeHash)history.replaceState(null,'',location.pathname+location.search+routeHash);
  }
 }finally{changingTab=false;saveCafeView();}
}
function syncSharedGuestEntry(){
 const docs=[document];try{if(parent!==window)docs.push(parent.document);}catch{}
 const available=docs.some(doc=>{const footer=doc.querySelector('.station-utility');return !!footer&&!footer.hidden&&doc.defaultView.getComputedStyle(footer).display!=='none'&&[...footer.querySelectorAll('button')].some(b=>b.textContent.trim()==='Счета гостей'&&!b.hidden&&!b.disabled);});
 const guestTab=document.querySelector('[data-tab="guests"]');if(guestTab)guestTab.hidden=available;
}
function watchSharedGuestEntry(doc){
 const Observer=doc.defaultView?.MutationObserver||MutationObserver,observer=new Observer(()=>attach());let target=null,waiting=false;
 const attach=()=>{const footer=doc.querySelector('.station-utility');if(footer){if(target!==footer){observer.disconnect();target=footer;observer.observe(footer,{attributes:true,childList:true,subtree:true});}syncSharedGuestEntry();return true;}const root=doc.body||doc.documentElement;if(root){if(target!==root){observer.disconnect();target=root;observer.observe(root,{childList:true,subtree:true});}return false;}if(!waiting){waiting=true;doc.addEventListener('DOMContentLoaded',()=>{waiting=false;attach();},{once:true});}return false;};
 attach();
}
window.STARTCafeDesk={async addToBill(b){await selectCafeTab('compose',{keepGuest:true});await window.STARTGuests.selectCafe(b);},async showBill(id){await selectCafeTab('guests');await window.STARTGuests.show(id,$('#guests'));}};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=safe(()=>selectCafeTab(b.dataset.tab)));
try{if(parent!==window)watchSharedGuestEntry(parent.document);}catch{}watchSharedGuestEntry(document);
$('#new-cafe-order').onclick=safe(()=>selectCafeTab('compose'));$('#new-cafe-order').hidden=true;
window.addEventListener('hashchange',()=>{if(location.hash==='#new')safe(()=>selectCafeTab('compose',{keepGuest:true}))();else if(location.hash==='#orders')safe(()=>selectCafeTab('orders'))();});
async function createdCafeOrder(e){
 const stay=()=>selectCafeTab('compose');
 const followUp=(message,actionLabel,action)=>{clearTimeout(noticeTimer);const out=$('#notice');out.replaceChildren(document.createTextNode(message+' '));const button=make('button',actionLabel);button.type='button';button.onclick=()=>safe(action)();out.append(button);};
 if(e.detail.guestBillId){await stay();followUp('Заказ добавлен к счёту гостя №'+e.detail.guestBillId+'.', 'Открыть счёт',()=>window.STARTCafeDesk.showBill(e.detail.guestBillId));document.dispatchEvent(new Event('station-updated'));return;}
 if(e.detail.manualPaidRequested){
  await stay();
  try{const r=await api('order?id='+e.detail.id);await api('manual-paid',{id:r.id,revision:r.revision,paymentId:r.terminalPayment?.id||null,method:'card',note:'Сотрудник подтвердил: карта / QR оплачены, фискальный чек пробит, операция на кассе завершена.',confirmed:true,terminalIdle:true,receiptExists:true});notice('Оплата картой учтена · №'+window.STARTCafeNumber(e.detail.id),true);}
  catch(error){followUp('Не удалось подтвердить оплату. Проверьте заказ №'+window.STARTCafeNumber(e.detail.id)+':', 'Открыть заказ',()=>openOrder(e.detail.id));}
  document.dispatchEvent(new Event('station-updated'));
  return;
 }
 if(e.detail.payNow){
  await stay();let r;
  try{r=await api('order?id='+e.detail.id);const paymentStart=await api('pay',{id:r.id,revision:r.revision,cash:e.detail.cashRequested===true,retryPaymentId:r.terminalPayment?.state==='cancelled'?r.terminalPayment.id:undefined});window.STARTTerminalVoice?.prompt(paymentStart,{cash:e.detail.cashRequested===true,previousId:r.terminalPayment?.id});const fresh=await api('order?id='+r.id);await loadOrders(true);const payment=fresh.terminalPayment;if(!fresh.details.terminalPaidAt||payment&&!['done','cash_done'].includes(payment.state)){followUp('Заказ №'+window.STARTCafeNumber(r.id)+' · '+(payment?.label||'ожидает подтверждения оплаты')+'.', 'Открыть заказ',()=>openOrder(r.id));}else notice((e.detail.cashRequested?'Продажа сохранена':'Оплата подтверждена')+' · №'+window.STARTCafeNumber(r.id),true);}
  catch(error){followUp('Не удалось подтвердить результат оплаты: '+error.message+' Повторно не оплачивайте. Проверьте заказ №'+window.STARTCafeNumber(e.detail.id)+':', 'Открыть заказ',()=>openOrder(e.detail.id));}
  document.dispatchEvent(new Event('station-updated'));return;
 }
 await stay();notice((e.detail.quickSale?'Продажа сохранена':'Заказ в работе')+' · №'+window.STARTCafeNumber(e.detail.id),true);document.dispatchEvent(new Event('station-updated'));
}
document.addEventListener('cafe-order-created',safe(createdCafeOrder));

$('#refresh').onclick=safe(()=>loadOrders(true));$('#order-date').onchange=safe(async()=>{observedDay=cafeToday();await loadOrders(true);});const reloadFilters=safe(async()=>{visibleOrders=50;await loadOrders(true);});for(const selector of ['#order-status','#order-source','#order-place'])$(selector).onchange=reloadFilters;let searchTimer;$('#order-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(reloadFilters,250);};$('#catalog-search').oninput=renderCatalog;$('#new-item').onclick=()=>editItem();$('#new-category').onclick=()=>editCategory();$('#new-group').onclick=()=>editGroup();$('#new-place').onclick=()=>editPlace();document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());$('#order-dialog').addEventListener('close',()=>history.replaceState(null,'',location.pathname));
window.addEventListener('pagehide',saveCafeView);$('#order-filters').addEventListener('toggle',saveCafeView);
document.addEventListener('visibilitychange',()=>{if(user&&!document.hidden&&tab==='orders'&&Date.now()-ordersReadAt>15000)safe(loadOrders)();});
setInterval(()=>{if(!user||document.hidden)return;if(!$('#order-dialog').open){if(tab==='orders')safe(loadOrders)();return;}if(current?.terminalPayment&&!['done','cash_done','cancelled'].includes(current.terminalPayment.state))safe(async()=>{const id=current.id,r=await api('order?id='+id);if(current?.id!==id||!$('#order-dialog').open)return;if(r.terminalPayment?.state!==current.terminalPayment?.state||r.terminalPayment?.terminalReleased!==current.terminalPayment?.terminalReleased||r.status!==current.status){current=r;renderDetail();document.dispatchEvent(new Event('station-updated'));}else if(JSON.stringify(r.terminalPayment?.diagnostic)!==JSON.stringify(current.terminalPayment?.diagnostic)){current=r;const panel=$('#order-detail').querySelector('.payment-state');if(panel)renderPaymentDiagnostic(panel,r.terminalPayment);}})();},5000);safe(init)();
})();
