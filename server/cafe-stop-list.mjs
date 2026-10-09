import {createHash} from 'node:crypto';
import {quantityText} from './inventory.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const editor=u=>{if(!['admin','staff','waiter'].includes(u?.role)||u.scheduleOnly)fail('Войдите в рабочую админку.',403);};
const uuid=value=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value||''))fail('Обновите окно и повторите действие.');};
const fingerprint=(body,u)=>createHash('sha256').update(JSON.stringify({body,actor:u.id})).digest('hex');
const exact=(body,keys)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))fail('Проверьте поля действия.');};
const packaged=unit=>/упаков|пачк/.test(unit.toLocaleLowerCase('ru-RU'));
const consumable=name=>/крышк|стакан|мешалк|трубочк|салфетк|вилк|ложк|коробк|конверт|тарелк|мундштук/.test(name.toLocaleLowerCase('ru-RU'));
function display(milli,unit){
 const normal=unit.trim().toLocaleLowerCase('ru-RU');
 const scaled=['кг','kg'].includes(normal)?'г':['л','l'].includes(normal)?'мл':null;
 return (scaled?milli:milli/1000).toLocaleString('ru-RU',{maximumFractionDigits:3})+' '+(scaled||unit);
}
export class CafeStopList{
 constructor(cafe){this.cafe=cafe;this.db=cafe.db;this.stock=cafe.stock;this.inventory=cafe.stock.inventory;}
 previous(action,body,u){
  const row=this.db.prepare("SELECT actor,body FROM cafe_audit WHERE action=? AND json_extract(body,'$.requestId')=? ORDER BY id DESC LIMIT 1").get(action,body.requestId);
  if(!row)return null;const saved=JSON.parse(row.body);
  if(row.actor!==u.id||saved.fingerprint!==fingerprint(body,u))fail('Ключ действия уже использован.',409);return saved;
 }
 reasons(item,variant){
  let requirements;
  try{requirements=this.stock.requirements({itemId:item.id,name:item.name,variant,modifiers:[]});}
  catch{return [{code:'MISSING_RECIPE',message:variant?.useBaseRecipe===true?'Не заполнен общий состав.':'Не заполнен расход этого вида.'}];}
  const totals=new Map(),result=[];
  for(const ingredient of requirements){const old=totals.get(ingredient.id);if(old&&old.unitId!==ingredient.unitId){result.push({code:'UNIT_CHANGED',inventoryId:ingredient.id,message:'В составе смешаны разные единицы одного ингредиента.'});continue;}totals.set(ingredient.id,{...ingredient,amount:(old?.amount||0)+ingredient.amount});}
  for(const [id,row] of totals){
   const stock=this.inventory.row(id),common={inventoryId:id,inventoryRevision:stock.revision};
   if(!stock.active)result.push({...common,code:'INGREDIENT_ARCHIVED',message:stock.name+': складская позиция в архиве.'});
   else if(stock.unit_id!==row.unitId)result.push({...common,code:'UNIT_CHANGED',message:stock.name+': единица склада изменилась. Проверьте расход.'});
   else if(stock.current_milli===null)result.push({...common,code:'STOCK_UNSET',message:stock.name+': фактический остаток не указан.'});
   else if(stock.current_milli<row.amount)result.push({...common,code:'STOCK_SHORT',message:stock.name+': расход '+display(row.amount,stock.unit)+' на порцию, остаток '+display(stock.current_milli,stock.unit)+'.'});
   if(packaged(stock.unit)&&consumable(stock.name))result.push({...common,code:'PACKAGE_UNIT',message:stock.name+': в расходе используется '+quantityText(row.amount)+' '+stock.unit+'. Для штучного учёта нужен фактический пересчёт.'});
  }
  return result;
 }
 read(u){
  editor(u);const catalog=this.cafe.catalog(),items=[];
  for(const item of catalog.items){
   const category=catalog.categories.find(c=>c.id===item.categoryId),restricted=item.restricted||item.station==='hookah',availability=this.stock.availability(item,catalog.groups);
   const reasons=[];
   if(!item.active)reasons.push({code:'HIDDEN_ITEM',message:'Товар скрыт в меню.'});
   if(!category?.active)reasons.push({code:'HIDDEN_CATEGORY',message:'Категория скрыта в меню.'});
   if(item.soldOut)reasons.push({code:'MANUAL_STOP',message:'Включён ручной стоп.'});
   if(restricted)reasons.push({code:'VIEW_ONLY',message:'Товар доступен только для просмотра.'});
   const source=item.variants.filter(v=>v.active),variants=(source.length?source:[null]).map(variant=>{
    const entry=availability.variants.find(e=>e.variantId===(variant?.id??null))||{available:0,configured:false};
    const details=entry.available===0?this.reasons(item,variant):[];
    for(const group of catalog.groups.filter(g=>g.active&&item.groupIds.includes(g.id)&&g.min>0)){
     const choices=group.options.filter(o=>o.active&&!o.soldOut).filter(o=>availability.options.some(s=>s.variantId===(variant?.id??null)&&s.optionId===o.id&&s.available>0));
     if(choices.length<group.min)details.push({code:'MODIFIER_UNAVAILABLE',message:'Нет доступного выбора в группе «'+group.name+'».'});
    }
    if(entry.available===0&&!details.length)details.push({code:'MISSING_RECIPE',message:'Расход или единицы состава требуют проверки.'});
    return {id:variant?.id??null,name:variant?.name||'Основная порция',useBaseRecipe:variant?.useBaseRecipe===true,available:entry.available,configured:entry.configured,reasons:details};
   });
   if(item.variants.length&&!source.length)reasons.push({code:'NO_ACTIVE_VARIANT',message:'Все виды товара скрыты в меню.'});
   const orderable=!(item.variants.length&&!source.length)&&variants.some(v=>v.available>0&&!v.reasons.some(r=>r.code==='MODIFIER_UNAVAILABLE'));
   if(!reasons.length&&orderable&&!variants.some(v=>v.reasons.length))continue;
   if(!orderable)for(const variant of variants)for(const reason of variant.reasons)if(!reasons.some(r=>r.code===reason.code&&r.message===reason.message))reasons.push(reason);
   items.push({id:item.id,name:item.name,image:item.image,priceCents:item.priceCents,soldOut:item.soldOut,active:item.active,categoryActive:!!category?.active,restricted:!!restricted,available:orderable?availability.available:0,variants,reasons,canResume:item.soldOut&&item.active&&!!category?.active&&!restricted,canOrder:!item.soldOut&&item.active&&!!category?.active&&!restricted&&orderable});
  }
  return {revision:catalog.revision,canNormalizeUnits:u.role==='admin',items};
 }
 resume(body,u){
  editor(u);exact(body,['requestId','revision','itemId','action']);uuid(body.requestId);if(body.action!=='resume'||!Number.isSafeInteger(body.revision))fail('Проверьте действие.');
  return this.cafe.transaction(()=>{
   if(this.previous('stop_resume',body,u))return {...this.read(u),duplicate:true};
   const catalog=this.cafe.catalog();if(catalog.revision!==body.revision)fail('Меню изменилось. Обновите список перед снятием стопа.',409);
   const item=catalog.items.find(i=>i.id===body.itemId);if(!item)fail('Товар не найден.',404);
   if(!item.active||!catalog.categories.some(c=>c.id===item.categoryId&&c.active)||item.restricted||item.station==='hookah')fail('Сначала проверьте настройки доступности товара.',409);
   if(!item.soldOut)fail('Ручной стоп уже снят. Обновите список.',409);
   item.soldOut=false;this.cafe.saveCatalog(catalog,u,fn=>fn());this.cafe.audit(u,'stop_resume',{requestId:body.requestId,fingerprint:fingerprint(body,u),itemId:item.id,before:true,after:false,reason:'Сотрудник снял ручной стоп для оформления заказа'});
   return this.read(u);
  });
 }
 normalizeUnits(body,u){
  editor(u);if(u.role!=='admin')fail('Изменение единицы учёта доступно администратору.',403);
  exact(body,['requestId','inventoryId','revision','actualCount','confirmPieceNorms']);uuid(body.requestId);
  if(!Number.isSafeInteger(body.inventoryId)||!Number.isSafeInteger(body.revision)||typeof body.actualCount!=='string'||!/^\d{1,9}$/.test(body.actualCount)||body.confirmPieceNorms!==true)fail('Укажите фактическое количество в штуках и подтвердите штучные нормы.');
  return this.cafe.transaction(()=>{
   const previous=this.previous('stock_unit_normalize',body,u);if(previous)return {revision:this.cafe.catalog().revision,item:this.inventory.serialize(this.inventory.row(previous.targetId)),normalized:true,duplicate:true};
   const source=this.inventory.row(body.inventoryId);
   if(source.revision!==body.revision)fail('Остаток уже изменён. Обновите список перед пересчётом.',409);
   if(!source.active||!packaged(source.unit)||!consumable(source.name))fail('Для этой позиции штучный переход не требуется.',409);
   const pending=this.db.prepare("SELECT DISTINCT o.id FROM cafe_stock_usage s JOIN cafe_orders o ON o.id=s.order_id WHERE s.item_id=? AND s.restored_at IS NULL AND o.status NOT IN ('CANCELLED','DELIVERED') AND NOT EXISTS(SELECT 1 FROM cafe_order_events e WHERE e.order_id=o.id AND e.kind IN ('COOKING','READY','DELIVERED'))").all(source.id);
   if(pending.length)fail('Есть незавершённые заказы со старой единицей: '+pending.map(r=>r.id).join(', ')+'. Завершите их перед переходом на штуки.',409);
   const recipes=this.db.prepare('SELECT item_id,component,body,revision FROM cafe_recipes').all().filter(row=>JSON.parse(row.body).some(i=>i.id===source.id||i.replacesId===source.id));
   for(const row of recipes)for(const ingredient of JSON.parse(row.body))if(ingredient.id===source.id&&(ingredient.amount%1000!==0||ingredient.unitId!==source.unit_id))fail('Есть дробный расход упаковки или другая единица в рецептуре. Уточните нормы перед переводом в штуки.',409);
   const archivedName=source.name+' (архив: '+source.unit+')';
   const renamed=this.inventory.save({id:source.id,revision:source.revision,name:archivedName,unit:source.unit,category:source.category,current:quantityText(source.current_milli),minimum:quantityText(source.minimum_milli),target:quantityText(source.target_milli),comment:source.comment||'',manualBuy:!!source.manual_buy,reason:'Сохранение истории упаковочного учёта при переходе в штуки',requestId:body.requestId+'-old'},u,fn=>fn()).item;
   const created=this.inventory.save({name:source.name,unit:'шт.',category:source.category,current:body.actualCount,minimum:null,target:null,comment:'Фактический пересчёт в штуках; прежний учёт сохранён в архиве.',manualBuy:false,requestId:body.requestId+'-new'},u,fn=>fn()).item;
   const changed=[];
   for(const row of recipes){
    const ingredients=JSON.parse(row.body).map(i=>({...i,id:i.id===source.id?created.id:i.id,...(i.replacesId===source.id?{replacesId:created.id}:{})}));
    this.stock.save({itemId:row.item_id,component:row.component,revision:row.revision,ingredients:ingredients.map(i=>({id:i.id,amount:quantityText(i.amount),...(i.replacesId?{replacesId:i.replacesId}:{})}))},u,null,fn=>fn());
    changed.push({itemId:row.item_id,component:row.component});
   }
   this.inventory.archive({id:source.id,revision:renamed.revision,active:false,requestId:body.requestId+'-archive'},u,fn=>fn());
   this.cafe.audit(u,'stock_unit_normalize',{requestId:body.requestId,fingerprint:fingerprint(body,u),sourceId:source.id,targetId:created.id,beforeUnit:source.unit,actualCount:body.actualCount,confirmedPieceNorms:true,changed});
   return {revision:this.cafe.catalog().revision,item:created,normalized:true};
  });
 }
}
export function cafeStopListHandler(store,admin,origin){return async(req,res,url)=>{
 if(!['/api/admin/cafe/stop-list','/api/admin/cafe/stock-units'].includes(url.pathname))return false;
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));return true;};
 try{
  if(!store)fail('Кафе временно недоступно.',503);
  const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-start_session='))?.slice(21),user=admin.user(token);
  if(!user)fail('Войдите в админку.',401);editor(user);
  if(req.method==='GET'&&url.pathname.endsWith('/stop-list'))return reply(200,store.read(user));
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});
  if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))fail('Недопустимый источник запроса.',403);
  let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>32768)fail('Слишком большой запрос.',413);chunks.push(c);}let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Неверный запрос.');}
  return reply(200,url.pathname.endsWith('/stock-units')?store.normalizeUnits(body,user):store.resume(body,user));
 }catch(error){return reply(error.status||500,{error:error.status?error.message:'Не удалось проверить доступность блюда.'});}
};}
