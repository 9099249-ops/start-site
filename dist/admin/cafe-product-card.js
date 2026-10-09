(()=>{'use strict';
const M=window.STARTCafeProductCardModel;
let active=null;
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
const icon=name=>{const image=el('img');image.src='/assets/product-card-icons/'+name+'.svg';image.alt='';image.width=16;image.height=16;return image;};
const formatted=value=>value.toLocaleString('ru-RU',{maximumFractionDigits:4});

function open(item,callbacks={}){
 if(active)return;
 const state={data:null,component:'base',purchaseId:null,query:'',dirty:!item,busy:false,uploading:false,uncertain:false,conflict:false,retryBody:null,popover:null,focusBefore:document.activeElement};
 active=state;
 const dialog=el('dialog',undefined,'product-card-dialog');dialog.setAttribute('aria-labelledby','pc-dialog-title');
 const form=el('form',undefined,'pc-form');form.noValidate=true;
 const header=el('header',undefined,'pc-header'),heading=el('div',undefined,'pc-heading'),title=el('h2','Карточка товара'),subtitle=el('p',item?.name||'Новый товар','pc-subtitle');title.id='pc-dialog-title';heading.append(title,subtitle);
 const close=button('',requestClose,'pc-close');close.append(icon('x'));close.title='Закрыть';close.setAttribute('aria-label','Закрыть карточку товара');header.append(heading,close);
 const layout=el('div',undefined,'pc-layout'),left=el('section',undefined,'pc-basics'),right=el('section',undefined,'pc-work');layout.append(left,right);
 const status=el('div',undefined,'pc-status');status.setAttribute('role','alert');status.setAttribute('aria-live','polite');
 const footer=el('footer',undefined,'pc-footer'),completeness=el('div',undefined,'pc-completeness'),actions=el('div',undefined,'pc-actions');
 const cancel=button('Отмена',requestClose,'pc-secondary'),save=el('button','Сохранить все настройки','pc-primary');save.type='submit';actions.append(cancel,save);footer.append(completeness,actions);form.append(header,layout,status,footer);dialog.append(form);document.body.append(dialog);
 let variantsSection,variantBody,composition,finance,basicInputs=new Map();
 const variantRows=new Map();

 function button(text,action,cls='pc-secondary'){const node=el('button',text,cls);node.type='button';node.addEventListener('click',action);return node;}
 function dirty(){state.dirty=true;state.retryBody=null;updateCompleteness();}
 function field(host,label,value,onInput,type='text',key){
  const wrapper=el('label',undefined,'pc-field'),caption=el('span',label,'pc-label'),input=el(type==='textarea'?'textarea':'input');
  if(type!=='textarea')input.type=type;
  input.value=value??'';if(key)input.dataset.field=key;
  if(onInput)input.addEventListener('input',()=>{input.removeAttribute('aria-invalid');onInput(input.value);dirty();});
  wrapper.append(caption,input);host.append(wrapper);return input;
 }
 function selectField(host,label,value,options,onChange,key){
  const wrapper=el('label',undefined,'pc-field'),caption=el('span',label,'pc-label'),input=el('select');
  for(const [id,name] of options){const option=el('option',name);option.value=id;input.append(option);}
  input.value=String(value??'');if(key)input.dataset.field=key;
  if(onChange)input.addEventListener('change',()=>onChange(input.value));
  wrapper.append(caption,input);host.append(wrapper);return input;
 }
 function check(host,label,value,onChange){
  const wrapper=el('label',undefined,'pc-check'),input=el('input');input.type='checkbox';input.checked=!!value;
  input.addEventListener('change',()=>{if(onChange(input.checked)!==false)dirty();});wrapper.append(input,el('span',label));host.append(wrapper);return input;
 }
 function sectionHeading(section,name,badge){
  const row=el('div',undefined,'pc-section-heading'),heading=el('h3',name,'pc-section-name');row.append(heading);if(badge)row.append(badge);section.append(row);return heading;
 }
 function table(section,cls,headers,widths){
  const wrap=el('div',undefined,'pc-table-wrap'),node=el('table',undefined,cls),columns=el('colgroup');
  for(const width of widths){const col=el('col');if(width)col.setAttribute('width',width);columns.append(col);}
  const head=el('thead'),row=el('tr');for(const name of headers){const cell=el('th',name);cell.scope='col';row.append(cell);}head.append(row);
  const body=el('tbody');node.append(columns,head,body);wrap.append(node);section.append(wrap);return body;
 }
 function empty(body,columns,text){const row=el('tr',undefined,'pc-empty'),cell=el('td',text);cell.colSpan=columns;row.append(cell);body.append(row);}
 function cell(row,text){const node=el('td',text);row.append(node);return node;}
 function rowMenu(row,label,commands){
  const node=button('',()=>showPopover(node,commands),'pc-icon pc-row-menu');node.append(icon('more-vertical'));node.title=label;node.setAttribute('aria-label',label);cell(row).append(node);return node;
 }
 function closePopover(){state.popover?.remove();state.popover=null;}
 function showPopover(anchor,commands){
  if(state.busy||state.uploading||state.uncertain||state.conflict)return;
  closePopover();const popup=el('div',undefined,'pc-popover');popup.setAttribute('role','menu');
  for(const [label,action] of commands){const command=button(label,()=>{closePopover();action();});command.setAttribute('role','menuitem');popup.append(command);}
  dialog.append(popup);state.popover=popup;
  const rect=anchor.getBoundingClientRect(),bounds=dialog.getBoundingClientRect();
  popup.style.left=Math.max(bounds.left+8,Math.min(rect.right-popup.offsetWidth,bounds.right-popup.offsetWidth-8))+'px';
  popup.style.top=Math.max(bounds.top+8,Math.min(rect.bottom+4,bounds.bottom-popup.offsetHeight-8))+'px';popup.querySelector('button')?.focus();
 }
 function updateCompleteness(){
  if(!state.data)return;
  const keys=[...state.data.variants.values()].filter(v=>v.active).map(v=>'variant:'+v.id);if(!keys.length)keys.push('base');
  for(const group of state.data.snapshot.catalog.groups.filter(g=>g.active&&state.data.item.groupIds.includes(g.id)))for(const option of group.options.filter(o=>o.active))keys.push('option:'+option.id);
  const incomplete=keys.some(key=>{const ready=M.readiness(state.data,key);return !ready.recipe||!ready.cost;});
  completeness.replaceChildren(icon(incomplete?'circle-alert':'info'),el('span',incomplete?'Есть незаполненные нормы или себестоимость':'Все обязательные настройки заполнены'));
  completeness.dataset.incomplete=String(incomplete);
 }
 function showMessage(message,error=false){status.replaceChildren();status.dataset.error=String(error);if(message)status.append(el('span',message));}
 function lock(){
  const blocked=state.busy||state.uploading||state.uncertain||state.conflict;
  for(const control of form.querySelectorAll('input,select,textarea,button'))control.disabled=blocked||control.dataset.permanentDisabled==='true';
  close.disabled=cancel.disabled=state.busy||state.uploading||state.uncertain;
  save.disabled=state.busy||state.uploading||state.conflict||!state.data;
 }
 function confirmInCard(message,accept,acceptLabel='Отбросить изменения'){
  status.replaceChildren();const box=el('div',undefined,'pc-inline-warning'),text=el('span',message),tools=el('div');
  const stay=button('Продолжить редактирование',()=>{showMessage('');save.focus();}),discard=button(acceptLabel,()=>{void accept();});
  tools.append(stay,discard);box.append(text,tools);status.append(box);stay.focus();
 }
 function requestClose(){
  if(state.popover){closePopover();return;}
  if(state.busy||state.uploading||state.uncertain)return;
  if(state.dirty&&state.data){confirmInCard('Есть несохранённые изменения. Закрыть карточку без сохранения?',()=>dialog.close());return;}
  dialog.close();
 }
 function protectDraft(event){if(state.dirty||state.busy||state.uncertain){event.preventDefault();event.returnValue='';}}
 window.addEventListener('beforeunload',protectDraft);
 dialog.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
 dialog.addEventListener('close',()=>{window.removeEventListener('beforeunload',protectDraft);closePopover();active=null;dialog.remove();state.focusBefore?.focus?.();});
 dialog.addEventListener('click',event=>{if(state.popover&&!state.popover.contains(event.target)&&!event.target.closest('.pc-row-menu'))closePopover();});
 layout.addEventListener('scroll',closePopover,{passive:true});

 function renderBasics(){
  left.replaceChildren();basicInputs=new Map();const data=state.data,item=data.item;
  const photo=el('div',undefined,'pc-photo');if(item.image){const image=el('img');image.src=item.image;image.alt='Фото товара';photo.append(image);}else photo.append(el('span','Фото товара','pc-photo-placeholder'));
  const photoTools=el('div',undefined,'pc-photo-actions'),upload=el('input');upload.type='file';upload.accept='image/jpeg,image/png,image/webp';upload.setAttribute('aria-label','Загрузить фото (JPEG, PNG, WebP, до 8 МБ)');
  const uploadButton=button('Загрузить фото',()=>upload.click());uploadButton.prepend(icon('upload'));
  const removePhoto=button('Убрать фото',()=>{data.item.image='';dirty();renderBasics();lock();});removePhoto.prepend(icon('trash-2'));removePhoto.disabled=!item.image;removePhoto.dataset.permanentDisabled=String(!item.image);
  upload.addEventListener('change',()=>void uploadPhoto(upload.files?.[0]));photoTools.append(uploadButton,removePhoto,upload);left.append(photo,photoTools);
  const name=field(left,'Название товара',item.name,value=>{item.name=value;subtitle.textContent=value||'Новый товар';updateSectionTitle();},'text','name');name.maxLength=120;basicInputs.set('name',name);
  const description=field(left,'Описание',item.description,value=>item.description=value,'textarea','description');description.maxLength=600;description.rows=2;
  selectField(left,'Категория',item.categoryId,data.snapshot.catalog.categories.map(c=>[c.id,c.name]),value=>{item.categoryId=value;dirty();refreshVariantsHeading();});
  const prices=el('div',undefined,'pc-two');left.append(prices);
  const price=field(prices,'Цена продажи, ₽',data.price,value=>data.price=value,'text','price');price.inputMode='decimal';basicInputs.set('price',price);
  field(prices,'Вес / объём',item.size,value=>item.size=value);
  const stations=[['kitchen','Кухня'],['bar','Бар'],['tea_hookah','Чайная смесь без табака / никотина'],['none','Без цеха']];if(!stations.some(([key])=>key===item.station))stations.push([item.station,'Текущий цех: '+item.station]);
  selectField(left,'Приготовление',item.station,stations,value=>{item.station=value;dirty();});
  for(const [label,key] of [['Показывать в меню','active'],['Стоп-лист: сегодня нет','soldOut'],['Заблокировать сразу выдать','blockQuickSale'],['Доступно на яхту','yacht']])check(left,label,item[key],value=>item[key]=value);
  const details=el('details',undefined,'pc-additional'),summary=el('summary','Дополнительные настройки');details.append(summary,el('small','Порядок в меню, метки, группы добавок'));
  const sort=field(details,'Порядок отображения',data.sort,value=>data.sort=value,'number','sort');sort.min=0;sort.max=10000;basicInputs.set('sort',sort);
  field(details,'Метки через запятую',data.tags,value=>data.tags=value);
  check(details,'Ограниченный товар',item.restricted,value=>item.restricted=value);
  for(const group of data.snapshot.catalog.groups)check(details,group.name,item.groupIds.includes(group.id),checked=>{
   item.groupIds=checked?[...item.groupIds,group.id]:item.groupIds.filter(id=>id!==group.id);
   if(!M.components(data).includes(state.component))state.component=data.variants.size?'variant:'+data.variants.keys().next().value:'base';renderComposition();renderFinance();
  });
  left.append(details);
 }
 async function uploadPhoto(file){
  if(!file)return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){showMessage('Поддерживаются JPEG, PNG и WebP до 8 МБ.',true);return;}
  closePopover();state.uploading=true;lock();showMessage('Загружаю фото…');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
  try{
   const response=await fetch('/api/admin/content-upload',{method:'POST',headers:{'Content-Type':file.type},body:file,signal:controller.signal}),data=await response.json();
   if(!response.ok||!data.url)throw Error(data.error||'Не удалось загрузить фото.');
   state.data.item.image=data.url;dirty();renderBasics();showMessage('Фото загружено. Сохраните настройки товара.');
  }catch(error){showMessage(error.name==='AbortError'?'Не удалось завершить загрузку фото. Попробуйте ещё раз.':error.message,true);}
  finally{clearTimeout(timer);state.uploading=false;lock();}
 }
 function refreshVariantsHeading(){
  if(!variantsSection)return;
  const category=state.data.snapshot.catalog.categories.find(c=>c.id===state.data.item.categoryId)?.name.trim().toLocaleLowerCase('ru-RU');
  variantsSection.querySelector('h3').textContent=category==='чай'?'Виды чая':'Варианты товара';
 }
 function updateVariantRows(){
  for(const [id,controls] of variantRows){
   controls.row.dataset.current=String(state.component==='variant:'+id);controls.pick.checked=state.component==='variant:'+id;
   const effective=M.effectiveCost(state.data,'variant:'+id),value=effective.value,number=Number(String(value).replace(',','.'));controls.cost.textContent=value.trim()&&Number.isFinite(number)?formatted(number)+(effective.source==='base'?' · общий':effective.source==='recipe'?' · состав':'')+(effective.estimated?' · Ориентировочная':''):'—';
  }
 }
 function refreshRecipeCostView(){
  const data=state.data,key=state.component;
  if(data?.costMode==='recipe'){
   const effective=M.effectiveCost(data,key),cost=finance.querySelector('[data-field="cost"]');
   if(cost)cost.value=effective.value;
   const note=finance.querySelector('.pc-recipe-cost-note');
   if(note)note.textContent=[effective.estimated?'Ориентировочная':'По составу',...effective.missingPrices.map(id=>'Нет цены: '+(data.snapshot.stock.inventory.find(item=>item.id===id)?.name||id)),...effective.missingNorms.map(name=>'Нет нормы: '+name)].join(' · ');
  }
  updateVariantRows();updateCompleteness();
 }
 function selectComponent(key){
  if(state.component===key)return;
  closePopover();state.component=key;state.purchaseId=null;updateVariantRows();renderComposition();renderFinance();
 }
 function addVariant(source){
  const data=state.data,id=crypto.randomUUID(),copy=source?{id,name:source.name,price:source.price,priceCents:source.priceCents,active:true,useBaseRecipe:true}:{id,name:'',price:'0',priceCents:0,active:true,useBaseRecipe:true};
  data.variants.set(id,copy);state.component='variant:'+id;state.query='';state.purchaseId=null;dirty();renderVariants();renderComposition();renderFinance();variantRows.get(id).name.focus();
 }
 function renderVariants(){
  variantsSection.replaceChildren();variantRows.clear();sectionHeading(variantsSection,'Варианты товара');refreshVariantsHeading();
  const tools=el('div',undefined,'pc-variant-tools'),search=el('div',undefined,'pc-search'),input=el('input');input.type='search';input.placeholder='Найти вариант';input.setAttribute('aria-label','Найти вариант');input.value=state.query;search.append(icon('search'),input);
  const add=button('Добавить вариант',()=>addVariant(),'pc-primary pc-addvariant');add.prepend(el('span','+'));tools.append(search,add);variantsSection.append(tools);
  input.addEventListener('input',()=>{state.query=input.value;filterVariants();});
  variantBody=table(variantsSection,'pc-variant-table',['','Название','Доплата, ₽','Себестоимость, ₽','В меню',''],['24px',null,'90px','110px','70px','36px']);
  for(const variant of [...state.data.variants.values()].sort((a,b)=>Number(b.active)-Number(a.active))){
   const row=el('tr',undefined,'pc-variant');row.dataset.variantId=variant.id;
   const pick=el('input');pick.type='radio';pick.name='pc-selected-variant';pick.className='pc-variant-pick';pick.setAttribute('aria-label','Выбрать '+(variant.name||'новый вариант'));pick.addEventListener('change',()=>selectComponent('variant:'+variant.id));cell(row).append(pick);
   const name=el('input');name.value=variant.name;name.placeholder='Название';name.className='pc-name';name.maxLength=80;name.setAttribute('aria-label','Название варианта');name.dataset.variantName=variant.id;name.title=variant.name;
   name.addEventListener('focus',()=>selectComponent('variant:'+variant.id));name.addEventListener('input',()=>{variant.name=name.value;name.title=name.value;pick.setAttribute('aria-label','Выбрать '+(name.value||'новый вариант'));updateSectionTitle();dirty();});cell(row).append(name);
   const price=el('input');price.value=variant.price;price.className='pc-price';price.inputMode='decimal';price.setAttribute('aria-label','Доплата, ₽');price.dataset.variantPrice=variant.id;price.addEventListener('input',()=>{variant.price=price.value;dirty();});cell(row).append(price);
   const cost=cell(row);cost.className='pc-cell-state';
   const enabled=el('input');enabled.type='checkbox';enabled.checked=variant.active;enabled.setAttribute('aria-label','В меню: '+(variant.name||'новый вариант'));enabled.addEventListener('change',()=>{variant.active=enabled.checked;dirty();});cell(row).append(enabled);
   rowMenu(row,'Действия с вариантом '+(variant.name||''),[
    ['Переименовать',()=>name.focus()],['Копировать название и доплату',()=>addVariant(variant)],
    [state.data.snapshot.catalog.items.find(i=>i.id===state.data.item.id)?.variants.some(v=>v.id===variant.id)?'Архивировать вариант':'Удалить вариант',()=>{
     const existing=state.data.snapshot.catalog.items.find(i=>i.id===state.data.item.id)?.variants.some(v=>v.id===variant.id);
     if(existing){variant.active=false;enabled.checked=false;dirty();return;}
     state.data.variants.delete(variant.id);state.data.recipes.delete('variant:'+variant.id);state.data.costs.delete('variant:'+variant.id);
     if(state.component==='variant:'+variant.id)state.component=state.data.variants.size?'variant:'+state.data.variants.keys().next().value:'base';dirty();renderVariants();renderComposition();renderFinance();
    }]
   ]);
   row.addEventListener('click',event=>{if(!event.target.closest('input,button'))selectComponent('variant:'+variant.id);});
   variantBody.append(row);variantRows.set(variant.id,{row,pick,name,price,cost,enabled});
  }
  if(!variantRows.size)empty(variantBody,6,'У товара нет вариантов. Настройки ниже относятся ко всей порции.');filterVariants();updateVariantRows();
 }
 function filterVariants(){const query=state.query.toLocaleLowerCase('ru-RU');for(const [id,controls] of variantRows)controls.row.hidden=!state.data.variants.get(id).name.toLocaleLowerCase('ru-RU').includes(query);}
 function updateSectionTitle(){if(composition?.querySelector('h3'))composition.querySelector('h3').textContent='Состав и расход · '+M.name(state.data,state.component);}
 function renderComposition(){
  composition.replaceChildren();const data=state.data,key=state.component,ready=M.readiness(data,key),badge=el('span',ready.recipe?'Нормы заполнены':'Нормы не заполнены','pc-badge '+(ready.recipe?'pc-badge-ready':'pc-badge-warning'));
  sectionHeading(composition,'Состав и расход · '+M.name(data,key),badge);
  const variant=key.startsWith('variant:')?data.variants.get(key.slice(8)):null,inherited=variant?.useBaseRecipe===true;
  if(variant){
   const toggle=check(composition,'Использовать общий состав',inherited,value=>{
    if(!value){
     const own=M.recipe(data,'variant:'+variant.id).ingredients,base=M.recipe(data,'base').ingredients;
     const signature=rows=>JSON.stringify(rows.map(row=>({id:row.id,amount:String(row.amount),...(row.replacesId?{replacesId:row.replacesId}:{})})));
     if(own.length&&signature(own)!==signature(base)){
      toggle.checked=true;
      confirmInCard('Создать собственный состав на основе общего? Прежний состав этого вида будет заменён после сохранения.',()=>{
       M.useBaseRecipe(data,variant.id,false);dirty();renderComposition();renderFinance();updateVariantRows();
      },'Создать собственный состав');
      return false;
     }
    }
    M.useBaseRecipe(data,variant.id,value);renderComposition();renderFinance();updateVariantRows();
   });
   toggle.dataset.commonRecipeToggle=variant.id;
  }
  const recipe=inherited?M.recipe(data,'base'):M.recipe(data,key);
  const markers=M.missingNormMarkers(data,key),normActions=[];
  if(markers.length){
   const norms=el('div',undefined,'pc-unit-warning');norms.append(el('strong','Неуточнённые нормы:'));
   for(const marker of markers){
    const row=el('p',undefined,'pc-finance-note');row.append(el('span',marker.label));
    const resolve=button('Норма заполнена',()=>{
     if(!M.resolveMissingNorm(data,key,marker))return;
     dirty();renderComposition();renderFinance();updateVariantRows();
    },'pc-secondary pc-resolve-norm');
    resolve.disabled=!M.canResolveMissingNorm(data,key,marker);resolve.dataset.permanentDisabled=String(resolve.disabled);
    resolve.setAttribute('aria-label','Подтвердить норму: '+marker.label);row.append(resolve);norms.append(row);normActions.push({button:resolve,marker});
   }
   composition.append(norms);
  }
  if(inherited){
   const edit=button('Изменить общий состав',()=>selectComponent('base'));composition.append(edit);
   if(!recipe.ingredients.length)composition.append(el('small','Общий состав пока не заполнен.'));
  }
  const body=table(composition,'pc-recipe-table',['Ингредиент / расходник','Единица','Расход на порцию','Остаток',''],[null,'56px','120px','95px','36px']);
  recipe.ingredients.forEach((row,index)=>{
   const tr=el('tr');tr.dataset.recipeRow=String(index);
   const ingredient=el('select');ingredient.setAttribute('aria-label','Ингредиент или расходник');ingredient.dataset.field='ingredient';ingredient.dataset.row=String(index);ingredient.append(new Option('Выберите позицию',''));
   for(const stock of data.snapshot.stock.inventory.filter(i=>i.active||i.id===Number(row.id)))ingredient.append(new Option(stock.name+(stock.active?'':' (архив)'),String(stock.id)));
   ingredient.value=String(row.id||'');ingredient.addEventListener('change',()=>{row.id=ingredient.value?Number(ingredient.value):'';const selected=data.snapshot.stock.inventory.find(i=>i.id===Number(row.id));row.amount='';row.unitId=selected?.unit_id;delete row.displayDraft;state.purchaseId=null;dirty();renderComposition();renderFinance();composition.querySelector('[data-row="'+index+'"][data-field="amount"]')?.focus();});ingredient.disabled=inherited;ingredient.dataset.permanentDisabled=String(inherited);cell(tr).append(ingredient);
   const stock=data.snapshot.stock.inventory.find(i=>i.id===Number(row.id)),nativeUnit=stock?.unit||'',shownUnit=M.consumptionUnit(nativeUnit),savedUnitId=Number(row.unitId)||Number(stock?.unit_id),unitMismatch=!!stock&&!!row.unitId&&Number(row.unitId)!==Number(stock.unit_id),savedUnit=data.snapshot.stock.units.find(unit=>unit.id===savedUnitId)?.name||(unitMismatch?'ед. #'+savedUnitId:nativeUnit);cell(tr,shownUnit||'—');
   let unitWarning=null;
   const quantity=el('input');quantity.inputMode='decimal';quantity.value=unitMismatch?'':(row.displayDraft??M.displayConsumption(row.amount,nativeUnit));quantity.placeholder='Укажите';quantity.setAttribute('aria-label','Расход на порцию');quantity.dataset.field='amount';quantity.dataset.row=String(index);quantity.addEventListener('input',()=>{row.displayDraft=quantity.value;const converted=M.setConsumption(quantity.value,nativeUnit);if(converted!==null&&Number(converted)>0){row.amount=converted;if(stock)row.unitId=Number(stock.unit_id);delete row.displayDraft;unitWarning?.remove();}dirty();badge.textContent=M.readiness(data,key).recipe?'Нормы заполнены':'Нормы не заполнены';badge.className='pc-badge '+(M.readiness(data,key).recipe?'pc-badge-ready':'pc-badge-warning');for(const action of normActions){action.button.disabled=!M.canResolveMissingNorm(data,key,action.marker);action.button.dataset.permanentDisabled=String(action.button.disabled);}refreshRecipeCostView();});quantity.disabled=inherited;quantity.dataset.permanentDisabled=String(inherited);cell(tr).append(quantity);
   const shownBalance=stock?.current===null||stock?.current===undefined?null:M.displayConsumption(stock.current,nativeUnit),balance=cell(tr,shownBalance===null?'Не указан':shownBalance+' '+shownUnit);balance.className='pc-cell-state';
   const commands=inherited?[]:[['Удалить из состава',()=>{recipe.ingredients.splice(index,1);dirty();renderComposition();renderFinance();}]];
   if(key.startsWith('option:'))commands.unshift(['Настроить замену ингредиента',()=>editReplacement(row)]);
   const menu=rowMenu(tr,'Действия с ингредиентом '+(stock?.name||''),commands);menu.disabled=inherited;menu.dataset.permanentDisabled=String(inherited);body.append(tr);
   if(unitMismatch){unitWarning=el('tr',undefined,'pc-row-note');const savedDisplayUnit=M.consumptionUnit(savedUnit),note=el('td','Сохранённое значение: '+M.displayConsumption(row.amount,savedUnit)+' '+savedDisplayUnit+' (единица нормы: '+savedUnit+'). Единица изменилась на '+shownUnit+'. Укажите расход заново в '+shownUnit+'.');note.colSpan=5;unitWarning.append(note);body.append(unitWarning);}
   if(row.replacesId){const note=el('tr',undefined,'pc-row-note'),td=el('td','Заменяет: '+(data.snapshot.stock.inventory.find(i=>i.id===Number(row.replacesId))?.name||'Складской товар #'+row.replacesId));td.colSpan=5;note.append(td);body.append(note);}
  });
  if(!recipe.ingredients.length&&!inherited)empty(body,5,'Состав пока не заполнен');
  const add=button('Добавить ингредиент или расходник',()=>{recipe.ingredients.push({id:'',amount:''});dirty();renderComposition();renderFinance();composition.querySelector('[data-row="'+(recipe.ingredients.length-1)+'"][data-field="ingredient"]')?.focus();},'pc-secondary pc-add-ingredient');add.prepend(el('span','+'));add.disabled=inherited;add.dataset.permanentDisabled=String(inherited);composition.append(add);
  const groups=data.snapshot.catalog.groups.filter(g=>data.item.groupIds.includes(g.id));
  if(data.variants.size||groups.length){
   const options=el('details',undefined,'pc-options');options.append(el('summary','Общий состав и добавки'));const tools=el('div',undefined,'pc-options-tools');
   if(data.variants.size)tools.append(button('Общий состав',()=>selectComponent('base')));
   for(const group of groups)for(const option of group.options)tools.append(button(group.name+' · '+option.name,()=>selectComponent('option:'+option.id)));
   options.append(tools);composition.append(options);
  }
 }
 function editReplacement(row){
  const data=state.data,wrapper=el('div',undefined,'pc-inline-warning');
  const choices=M.replacementChoices(data,row.replacesId).map(i=>[String(i.id),i.name]);if(row.replacesId&&!choices.some(([id])=>id===String(row.replacesId)))choices.push([String(row.replacesId),'Складской товар #'+row.replacesId+' (архив)']);
  selectField(wrapper,'Заменяет ингредиент основы',row.replacesId||'',[['','Не заменяет'],...choices],value=>{if(value)row.replacesId=Number(value);else delete row.replacesId;dirty();renderComposition();renderFinance();showMessage('');});
  wrapper.append(el('small','Добавка недоступна для вариантов, в составе которых нет выбранного ингредиента.'));status.replaceChildren(wrapper);wrapper.querySelector('select').focus();
 }
 function selectedInventory(){
  const key=state.component,rows=key.startsWith('variant:')&&state.data.variants.get(key.slice(8))?.useBaseRecipe?M.recipe(state.data,'base').ingredients:M.recipe(state.data,key).ingredients,ids=[...new Set(rows.filter(r=>r.id).map(r=>Number(r.id)))];
  if(!ids.includes(Number(state.purchaseId)))state.purchaseId=ids[0]??null;
  return {ids,stock:state.data.snapshot.stock.inventory.find(i=>i.id===Number(state.purchaseId))};
 }
 function renderFinance(){
  finance.replaceChildren();const data=state.data,key=state.component,access=el('span','Доступно сотрудникам','pc-badge pc-badge-access');access.prepend(icon('info'));sectionHeading(finance,'Закупочная цена и себестоимость',access);
  check(finance,'Считать себестоимость по составу',data.costMode==='recipe',enabled=>{M.setCostMode(data,enabled?'recipe':'manual');renderFinance();updateVariantRows();});
  const {ids,stock}=selectedInventory(),receipt=el('div',undefined,'pc-three pc-finance-fields');finance.append(receipt);
  const selection=selectField(receipt,'Позиция из закупочного чека',state.purchaseId??'',ids.length?ids.map(id=>[String(id),data.snapshot.stock.inventory.find(i=>i.id===id)?.name||'Складской товар #'+id]):[['','Добавьте ингредиент в состав']],value=>{state.purchaseId=Number(value);renderFinance();});selection.dataset.permanentDisabled=String(!ids.length);selection.disabled=!ids.length;
  const purchase=stock?M.purchase(data,stock.id):{quantity:'',total:'',unitId:null};
  const units=data.snapshot.stock.units,currentUnit=units.find(u=>u.id===Number(purchase.unitId))?.name||stock?.unit||'ед.';
  const quantity=field(receipt,'Куплено, '+currentUnit,purchase.quantity,value=>purchase.quantity=value,'text','purchaseQuantity');quantity.inputMode='decimal';
  const total=field(receipt,'Сумма по чеку, ₽',purchase.total,value=>purchase.total=value,'text','purchaseTotal');total.inputMode='decimal';
  for(const input of [quantity,total]){input.disabled=!stock;input.dataset.permanentDisabled=String(!stock);input.dataset.inventoryId=stock?.id??'';}
  const sourceNote=stock&&(purchase.sourceLabel||purchase.sourceUrl||purchase.estimated)?el('small',[purchase.sourceLabel,purchase.sourceUrl,purchase.estimated?'Ориентировочная':null].filter(Boolean).join(' · '),'pc-finance-note'):null;
  if(sourceNote)receipt.append(sourceNote);
  const costs=el('div',undefined,'pc-two');finance.append(costs);
  const preview=field(costs,'Цена за 1 '+currentUnit+', ₽','—',null);preview.readOnly=true;preview.dataset.permanentDisabled='true';preview.disabled=true;
  const effective=M.effectiveCost(data,key),inheritedCost=key.startsWith('variant:')&&effective.source==='base';
  const cost=field(costs,inheritedCost?'Общая себестоимость, ₽':key.startsWith('option:')?'Дополнительная себестоимость, ₽':'Себестоимость порции, ₽',effective.value,value=>{data.costs.set(key,value);data.costSources.set(key,'own');updateVariantRows();},'text','cost');cost.inputMode='decimal';
  if(inheritedCost||data.costMode==='recipe'){cost.readOnly=true;cost.dataset.permanentDisabled='true';cost.disabled=true;}
  let costSourceNote=null;
  if(effective.source==='recipe'){
   const labels=[effective.estimated?'Ориентировочная':'По составу',...effective.missingPrices.map(id=>'Нет цены: '+(data.snapshot.stock.inventory.find(item=>item.id===id)?.name||id)),...effective.missingNorms.map(name=>'Нет нормы: '+name)];
   costSourceNote=el('small',labels.join(' · '),'pc-finance-note pc-recipe-cost-note');costs.append(costSourceNote);
  }else if(effective.source==='base'){
   costSourceNote=el('small','Источник: общий состав','pc-finance-note');costs.append(costSourceNote);
  }
  if(key==='base'&&!M.baseCostEditable(data)){cost.disabled=true;cost.dataset.permanentDisabled='true';finance.append(el('small','Себестоимость укажите для каждого вида в таблице.','pc-finance-note'));}
  const updatePrice=(edited=false)=>{
   if(stock&&edited){purchase.estimated=false;delete purchase.sourceUrl;delete purchase.sourceLabel;}
   if(sourceNote){const text=[purchase.sourceLabel,purchase.sourceUrl,purchase.estimated?'Ориентировочная':null].filter(Boolean).join(' · ');sourceNote.textContent=text;if(!text)sourceNote.remove();}
   const value=M.unitPrice(purchase);preview.value=value===null?'—':formatted(value);
   if(data.costMode==='recipe'){
    const next=M.effectiveCost(data,key);cost.value=next.value;
    if(costSourceNote)costSourceNote.textContent=[next.estimated?'Ориентировочная':'По составу',...next.missingPrices.map(id=>'Нет цены: '+(data.snapshot.stock.inventory.find(item=>item.id===id)?.name||id)),...next.missingNorms.map(name=>'Нет нормы: '+name)].join(' · ');
    updateVariantRows();
   }
  };
  quantity.addEventListener('input',()=>updatePrice(true));total.addEventListener('input',()=>updatePrice(true));updatePrice(false);
  if(stock&&Number(purchase.unitId)!==stock.unit_id){
   const warning=el('div',undefined,'pc-unit-warning');warning.append(el('small','Сохранённая закупочная цена привязана к другой единице. Количество автоматически не пересчитывается.'));
   selectField(warning,'Единица закупочного чека',purchase.unitId,[...new Set([Number(purchase.unitId),stock.unit_id])].map(id=>[String(id),units.find(u=>u.id===id)?.name||'Сохранённая единица']),value=>{purchase.unitId=Number(value);dirty();renderFinance();});finance.append(warning);
  }
  const note=el('p',undefined,'pc-finance-note');note.append(icon('info'),el('span','Незаполненные значения не считаются нулём.'));finance.append(note);
  const extra=el('details',undefined,'pc-options');extra.append(el('summary','Как учитывается закупочная цена'),el('p','Это справочная цена. Она не принимает товар на склад и не создаёт денежный расход. Приход товара оформляется в разделе «Закупка».'));finance.append(extra);
 }
 function render(){
  left.replaceChildren();right.replaceChildren();variantRows.clear();
  variantsSection=el('section',undefined,'pc-variants-section');composition=el('section',undefined,'pc-composition');finance=el('section',undefined,'pc-finance');right.append(variantsSection,composition,finance);
  renderBasics();renderVariants();renderComposition();renderFinance();updateCompleteness();lock();
 }
 function focusError(error){
  const target=error.target||{};
  if(target.component&&target.component!==state.component)selectComponent(target.component);
  if(target.inventoryId){
   if(!M.recipe(state.data,state.component).ingredients.some(row=>Number(row.id)===target.inventoryId)){
    const owner=M.components(state.data).find(key=>M.recipe(state.data,key).ingredients.some(row=>Number(row.id)===target.inventoryId));
    if(owner)selectComponent(owner);
   }
   state.purchaseId=target.inventoryId;renderFinance();
  }
  let input=target.id?variantRows.get(target.id)?.[target.field==='variantPrice'?'price':'name']:null;
  if(!input&&target.row!==undefined)input=composition.querySelector('[data-row="'+target.row+'"][data-field="'+target.field+'"]');
  if(!input)input=basicInputs.get(target.field)||finance.querySelector('[data-field="'+target.field+'"]');
  input?.setAttribute('aria-invalid','true');input?.focus();
 }
 async function readSnapshot(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{const response=await fetch('/api/admin/cafe/product-card',{cache:'no-store',signal:controller.signal}),snapshot=await response.json();if(!response.ok)throw Error(snapshot.error||'Не удалось загрузить товар.');if(!snapshot.catalog||!snapshot.stock||!Array.isArray(snapshot.costs)||!Array.isArray(snapshot.purchasePrices))throw Error('Не удалось получить все настройки товара.');return snapshot;}finally{clearTimeout(timer);}
 }
 async function initialize(){
  try{
   const snapshot=await readSnapshot();state.data=M.create(snapshot,item);const first=[...state.data.variants.values()].find(v=>v.active)||state.data.variants.values().next().value,defaultComponent=first?'variant:'+first.id:'base';state.component=M.components(state.data).includes(callbacks.initialComponent)?callbacks.initialComponent:defaultComponent;subtitle.textContent=state.data.item.name||'Новый товар';render();showMessage('');if(!dialog.open)dialog.showModal();
   if(!item)basicInputs.get('name')?.focus();
  }catch(error){showMessage(error.name==='AbortError'?'Сервер не ответил. Повторите загрузку.':error.message,true);actions.prepend(button('Повторить загрузку',event=>{event.currentTarget.remove();void initialize();}));lock();if(!dialog.open)dialog.showModal();}
 }
 async function reload(){
  confirmInCard('Загрузить сохранённые настройки и отбросить ваш черновик?',async()=>{state.busy=true;lock();try{const snapshot=await readSnapshot(),current=item?snapshot.catalog.items.find(i=>i.id===item.id):null;state.data=M.create(snapshot,current);state.dirty=!item;state.conflict=false;state.uncertain=false;state.retryBody=null;state.component=state.data.variants.size?'variant:'+state.data.variants.keys().next().value:'base';state.purchaseId=null;state.query='';state.busy=false;save.textContent='Сохранить все настройки';render();showMessage('');}catch(error){state.busy=false;lock();showMessage(error.message,true);}});
 }
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy||state.uploading||state.conflict||!state.data)return;
  try{
   closePopover();if(!state.retryBody)state.retryBody=M.buildPayload(state.data,crypto.randomUUID());
   state.busy=true;lock();showMessage('Сохраняю все настройки…');
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);let response,data;
   try{response=await fetch('/api/admin/cafe/product-card',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state.retryBody),signal:controller.signal});data=await response.json();}
   catch{state.busy=false;state.uncertain=true;save.textContent='Повторить сохранение';lock();showMessage('Нет подтверждения от сервера. Повторное сохранение проверит тот же запрос, не создавая дубликатов.',true);return;}
   finally{clearTimeout(timer);}
   if(response.status>=500||response.ok&&(!data.catalog||!data.stock||!Array.isArray(data.costs)||!Array.isArray(data.purchasePrices))){state.busy=false;state.uncertain=true;save.textContent='Повторить сохранение';lock();showMessage('Сервер не подтвердил сохранение. Повторите тот же запрос.',true);return;}
   if(response.status===409){state.busy=false;state.uncertain=false;state.conflict=true;state.retryBody=null;lock();showMessage(data.error||'Настройки изменены в другом окне. Ваш черновик сохранён.',true);status.append(button('Загрузить актуальные настройки',reload));return;}
   if(!response.ok){state.busy=false;state.uncertain=false;state.retryBody=null;save.textContent='Сохранить все настройки';lock();showMessage(data.error||'Не удалось сохранить товар.',true);return;}
   state.busy=false;state.dirty=false;callbacks.onSaved?.(data);dialog.close();
  }catch(error){state.busy=false;lock();showMessage(error.message,true);focusError(error);}
 });
 save.disabled=true;
 void initialize();
}
window.STARTCafeProductCard={open};
})();
