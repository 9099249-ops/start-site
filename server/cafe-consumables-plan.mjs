import {createHash} from 'node:crypto';
import {quantityText} from './inventory.mjs';

const key=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const unit=value=>{const name=key(value);return ['шт','штуки','штук'].includes(name)?'шт':name;};
const id=(...parts)=>createHash('sha256').update(parts.join('\0')).digest('hex').slice(0,24);

export function buildConsumablesPlan(config){
 const {items=[],categories=[],groups=[],recipes=[],inventory=[]}=config;
 const active=items.filter(i=>i.active),category=new Map(categories.map(c=>[c.id,key(c.name)])),byId=new Map(inventory.map(i=>[i.id,i]));
 const units=new Map(inventory.map(i=>[i.unit_id,i.unit]));for(const u of config.units||[])units.set(u.id,u.name);
 const names=new Map();for(const stock of inventory)for(const name of [stock.name,...(stock.aliases||[])]){const normalized=key(name);if(!names.has(normalized))names.set(normalized,stock);else if(names.get(normalized)?.id!==stock.id)names.set(normalized,null);}
 const rows=[],byKey=new Map();
 function add(item,component,name,quantity,measure,source,reason='',basis='portion',purchaseQuantity=null,existing=null){
  const stock=existing?byId.get(existing.id):names.get(key(name)),rowKey=[item?.id??'utility',component,stock?.id??key(name)].join('\0');
  const previous=byKey.get(rowKey);
  if(previous){
   // Keep actual recipes, but expose a piece norm when a whole pack is currently charged.
   if(!existing&&quantity!=null&&previous.source==='existing'&&unit(previous.unit)!==unit(measure)){
    previous.existingQuantity=previous.quantity;previous.existingUnit=previous.unit;
    previous.quantity=String(quantity);previous.unit=measure;previous.source=source;previous.status='needs_package';
    previous.reason='Сейчас списывается '+previous.existingQuantity+' '+previous.existingUnit+'. Уточнить количество штук в упаковке; действующая рецептура сохранена.';
   }
   if(purchaseQuantity!=null)previous.purchaseQuantity=String(purchaseQuantity);
   return previous;
  }
  let status;
  if(existing)status=quantity==null?'needs_quantity':existing.unitId!==stock?.unit_id?'needs_package':'existing';
  else if(!stock)status='needs_mapping';
  else if(quantity==null)status='needs_quantity';
  else if(unit(stock.unit)!==unit(measure))status='needs_package';
  else if(!stock.active||stock.current_milli==null)status='needs_stock';
  else if(!recipes.some(r=>r.item_id===item?.id&&r.component===component&&r.ingredients?.some(i=>i.amount>0)))status='needs_mapping';
  else status='ready';
  if(!reason){
   if(status==='needs_mapping')reason=stock?'Основной расход ещё не настроен.':'Нужна складская позиция или однозначное сопоставление.';
   if(status==='needs_package')reason='Уточнить единицу склада и количество в закупочной упаковке.';
   if(status==='needs_stock')reason='Заполнить фактический остаток; количество не придумано.';
   if(status==='needs_quantity')reason='Уточнить расход или формат выдачи.';
   if(existing&&/упак|пачк/.test(unit(measure)))reason='Текущая норма в упаковках: уточнить, это отдельная порция или закупочная пачка.';
  }
  const row={id:id(item?.id??'utility',component,stock?.id??key(name)),itemId:item?.id??null,itemName:item?.name??'Расход за смену',component,variantName:component.startsWith('variant:')?item?.variants?.find(v=>'variant:'+v.id===component)?.name??null:component.startsWith('option:')?groups.flatMap(g=>g.options||[]).find(o=>'option:'+o.id===component)?.name??null:null,stockItemId:stock?.id??null,stockName:stock?.name??name,unit:measure??null,quantity:quantity==null?null:String(quantity),purchaseQuantity:purchaseQuantity==null?null:String(purchaseQuantity),basis,source,status,reason,existingQuantity:existing&&quantity!=null?String(quantity):null,existingUnit:existing?measure:null};
  rows.push(row);byKey.set(rowKey,row);return row;
 }
 for(const item of active){
  const own=recipes.filter(r=>r.item_id===item.id),variants=(item.variants||[]).filter(v=>v.active),components=variants.length?variants.map(v=>'variant:'+v.id):['base'];
  for(const recipe of own)for(const ingredient of recipe.ingredients||[]){
   const stock=byId.get(ingredient.id),storedUnit=units.get(ingredient.unitId)??stock?.unit??null,storedKey=unit(storedUnit);
   const measure=storedKey==='кг'?'г':storedKey==='л'?'мл':storedUnit;
   const milli=Number.isSafeInteger(ingredient.amount)&&ingredient.amount>0?ingredient.amount:null;
   const amount=milli==null?null:quantityText(['кг','л'].includes(storedKey)?milli*1000:milli);
   const row=add(item,recipe.component,stock?.name??'Неизвестный складской товар',amount,measure,'existing','', 'portion',null,ingredient);
   const proof=(config.provenance||[]).find(p=>p.itemId===item.id&&p.component===recipe.component&&p.recipeRevision===recipe.revision&&p.additions?.some(a=>a.stockItemId===ingredient.id));
   const source=proof?.additions.find(a=>a.stockItemId===ingredient.id)?.source;
   if(source==='confirmed'||source==='assumed'){row.source=source;if(source==='assumed')row.reason='Предложенная норма выдачи: проверьте и при необходимости исправьте.';}
  }
  const name=key(item.name),cat=category.get(item.categoryId)||key(item.category),size=String(item.size||item.name||'');
  const proposal=(name,quantity=1,measure='шт',source='assumed',reason='',purchase=null)=>components.forEach(c=>add(item,c,name,quantity,measure,source,reason,'portion',purchase));
  const pizza=cat==='пицца',soup=cat==='супы',food=/сырник|пельмен|карто(?:фель|шка) фри|стрипс|сырные палочки|кревет/.test(name),hotdog=/хот дог/.test(name);
  if(pizza){proposal('Коробки для пиццы',1,'шт','confirmed','Одна коробка на пиццу; размер коробки уточнить.');proposal('Пергамент',30,'см','confirmed','30 см на пиццу. Рулон 20 м = 2000 см.',2000);}
  const fresh=name.includes('апельс')&&/фреш|фрэш/.test(name),cold=/бамбл|смузи/.test(name)&&/500/.test(size);
  if(fresh||cold){const source=fresh?'confirmed':'assumed';proposal('Стаканы матовые',1,'шт',source,'Матовый стакан 0,5 л; подтвердить формат выдачи.');proposal('Крышки большие',1,'шт',source);proposal('Трубочки',1,'шт',source);}
  if(/американо|капучино|латте/.test(name)&&/350/.test(size)){proposal('Стаканы 350 мл');proposal('Крышки большие');proposal('Мешалки');}
  if(/флэт уайт|флет уайт|мокачино|какао/.test(name)&&/250/.test(size)){proposal('Стаканы 250 мл');proposal('Крышки маленькие');proposal('Мешалки');}
  if(/эспрессо/.test(name))proposal('Стаканы 250 мл',null,'шт','unknown','Уточнить чашку для 70 мл; отдельный малый стакан не указан.');
  if(/квас разливной/.test(name)){proposal('Стаканы для пива 500 мл');proposal('Крышки большие',null,'шт','unknown','Не подтверждено, нужна ли крышка и подходит ли диаметр.');}
  if(/чай в стакане/.test(name)){proposal('Стаканы 350 мл',1,'шт','assumed','Предположение: 350 мл. Уточнить объём стакана.');proposal('Крышки большие');proposal('Мешалки');}
  if(/классический чай|травяной и ягодный чай/.test(name)){proposal('Стаканы 350 мл',null,'шт','unknown','500 мл чая: уточнить чайник или стакан и число чашек.');proposal('Крышки большие',null,'шт','unknown','Уточнить формат подачи чая; пластиковую тару для горячего не предполагать.');}
  if(food){proposal(/пельмен/.test(name)?'Тарелки для пельменей':/карто(?:фель|шка) фри/.test(name)?'Конверты для картофеля фри':'Тарелки одноразовые');proposal('Вилки');proposal('Салфетки');}
  if(hotdog){proposal('Конверты для хот-догов');proposal('Салфетки');}
  if(soup){proposal('WOK-контейнеры',null,'шт','unknown','Готовый суп уже в контейнере? Не дублировать заводскую тару.');proposal('Ложки');proposal('Салфетки');}
  for(const recipe of own.filter(r=>r.component.startsWith('option:')&&r.ingredients?.some(i=>i.amount>0))){
   const group=groups.find(g=>g.active&&item.groupIds?.includes(g.id)&&g.options?.some(o=>o.active&&'option:'+o.id===recipe.component));
   if(group?.id==='sauces')add(item,recipe.component,'Соусницы',null,'шт','unknown','Соус порционный или наливной? Не дублировать заводскую тару.');
   if(group?.id==='syrniki_toppings')add(item,recipe.component,'Соусницы',1,'шт','assumed','Одна соусница на выбранную добавку; уточнить выдачу.');
  }
  for(const component of components)if(!own.some(r=>r.component===component))add(item,component,'Основной ингредиент',null,null,'unknown','Отсутствует основная рецептура варианта; количество не придумано.');
  if(pizza||soup||food||hotdog)for(const component of components)add(item,component,'Фасовочные пакеты',null,'шт','unknown','Общая упаковка на заказ: уточнить вместимость и когда нужен пакет. Не списывать пакет на каждое блюдо.','order');
 }
 for(const stock of inventory.filter(i=>i.active&&(/салфет|перчат|мусорн|тряпк|мойк|моющ|жидкое мыло|чистящ/.test(key(i.name))||/химия|хозяйственные расходники/.test(key(i.category)))))add(null,'shift',stock.name,null,stock.unit,'unknown','Уточнить расход за смену; не списывать автоматически на каждый заказ.','shift');
 const byStatus={},bySource={};for(const row of rows){byStatus[row.status]=(byStatus[row.status]||0)+1;bySource[row.source]=(bySource[row.source]||0)+1;}
 return {rows,summary:{total:rows.length,distinctActiveItems:active.length,byStatus,bySource}};
}
