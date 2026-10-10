import {randomUUID} from 'node:crypto';
import {normalizeInventoryName, quantityText} from './inventory.mjs';
import {linkReadyMadePizzas} from './cafe-stock-links.mjs';
import {linkReadyMadeProducts} from './cafe-ready-stock-links.mjs';

// One-time, explicitly requested starting recipes. Never executed on startup.
// Only missing recipes are filled; staff corrections and real stock are preserved.
// Pack sizes below are provisional assumptions, documented for the owner.
const g = (name, value) => ({name, amount: value, kind: 'g'});
const ml = (name, value) => ({name, amount: value, kind: 'ml'});
const pack = (name, milli) => ({name, amount: milli, kind: 'pack'});
const unit = name => ({name, amount: 1000, kind: 'unit'});
const coffee = g('Кофе',18), milk = n => ml('Молоко обычное',n);
const key = normalizeInventoryName;
const packUnits = new Set(['упаковки','упаковка','пачки']);
const unitUnits = new Set(['шт','штуки','бутылки','банки','комплекты']);
const milkDoses = new Map([['Капучино',250],['Латте',280],['Флэт уайт',180],['Мокачино',180],['Какао',220]]);
const basePlans = new Map([
 ['Сырники',[g('Сырники',180)]],
 ['Пельмени говяжьи',[g('Пельмени',300)]],
 ['Картошка фри',[g('Картофель фри',180),ml('Масло для фритюра',15)]],
 ['Стрипсы',[g('Стрипсы',180),ml('Масло для фритюра',15)]],
 ['Сырные палочки',[g('Сырные палочки',150),ml('Масло для фритюра',15)]],
 ['Креветки фри',[g('Креветки',150),ml('Масло для фритюра',15)]],
 ['Двойной эспрессо',[coffee]], ['Американо',[coffee]],
 ['Капучино',[coffee,milk(250)]], ['Латте',[coffee,milk(280)]],
 ['Флэт уайт',[coffee,milk(180)]],
 ['Мокачино',[coffee,milk(180),g('Какао',15)]],
 ['Какао',[g('Какао',25),milk(220)]],
 ['Бамбл кофе',[coffee,g('Апельсины',300),pack('Сироп карамель',20)]],
 ['Квас разливной',[ml('Квас разливной',500)]],
 ['Чайный набор «У самовара»',[unit('Чайный набор «У самовара» — готовый комплект')]],
]);
const classic = ['Ассам','Изысканный бергамот (Эрл Грей)','Кимун','Золотой пух','Чёрный с саган-дайля','Чёрный со специями и молоком'];
const herbal = ['Иван-чай','Гречишный','Смородина с брусничным листом','Русские традиции','Шиповник','Мятная малина','Имбирный лимонник с ягодами годжи','Клюква, апельсин, корица','Таёжный','Облепиха с зелёным яблоком','Цветки липы, имбирь, тимьян','Чайный глинтвейн'];
const flavors = ['Таёжный','Гвоздика','Шиповник','Женьшень','Зефирки','Лемонграсс-лайм','Лесные ягоды','Вишня','Мороженое','Ежевика','Кислые ягоды','Черника','Арбуз','Дыня'];

export function fillDefaultCafeRecipes(cafe,user) {
 if(user?.role!=='admin')throw Object.assign(new Error('Автозаполнение доступно только администратору.'),{status:403});
 const stock=cafe.stock;
 stock.config(user);
 const results=[...linkReadyMadePizzas(cafe,user),...linkReadyMadeProducts(cafe,user)];
 let config=stock.config(user);
 const findGood=name=>{const found=config.inventory.filter(i=>key(i.name)===key(name));return found.length===1?found[0]:null;};
 const kit='Чайный набор «У самовара» — готовый комплект';
 if(config.items.some(i=>i.active&&i.name==='Чайный набор «У самовара»')&&!findGood(kit)) {
  stock.inventory.save({name:kit,category:'Кофе, чай и молоко',unit:'комплекты',current:null,minimum:null,target:null,manualBuy:false,comment:'Стартовая рецептура: 1 полный набор на заказ. Укажите количество комплектов со всеми составляющими. Остаток автоматически не придуман.',requestId:randomUUID()},user);
  config=stock.config(user);
 }
 // The old generic tea-hookah item did not specify a flavour. Track the selected
 // tobacco/nicotine-free blend instead of silently charging an arbitrary flavour.
 const catalog=cafe.catalog(),hookah=catalog.items.find(i=>i.active&&i.name==='Кальян на чайной смеси'&&i.station==='tea_hookah');
 if(hookah&&!hookah.variants.length&&!stock.recipe(hookah.id,'base')) {
  hookah.variants=flavors.map((name,index)=>({id:'tea-blend-'+index,name,priceCents:0,active:true}));
  cafe.saveCatalog(catalog,user);
  config=stock.config(user);
 }
 const convert=spec=>{
  const row=findGood(spec.name);
  if(!row||!row.active)throw new Error(!row?'stock_missing: '+spec.name:'stock_archived: '+spec.name);
  const u=key(row.unit);let milli;
  if(spec.kind==='g')milli=u==='кг'?spec.amount:u==='г'?spec.amount*1000:null;
  else if(spec.kind==='ml')milli=u==='л'?spec.amount:u==='мл'?spec.amount*1000:null;
  else if(spec.kind==='unit')milli=unitUnits.has(u)?spec.amount:null;
  else milli=packUnits.has(u)||u==='бутылки'?spec.amount:null;
  if(!Number.isSafeInteger(milli)||milli<=0)throw new Error('incompatible_unit: '+spec.name+' / '+row.unit);
  return {id:row.id,amount:quantityText(milli),...(spec.replaces?{replacesId:findGood(spec.replaces)?.id}:{})};
 };
 const save=(dish,component,specs)=>{
  if(stock.recipe(dish.id,component)){results.push({name:dish.name,itemId:dish.id,component,status:'kept_existing'});return;}
  try {
   const ingredients=specs.map(convert);
   stock.save({itemId:dish.id,component,revision:-1,ingredients},user);
   results.push({name:dish.name,itemId:dish.id,component,status:'linked'});
  }catch(e){results.push({name:dish.name,itemId:dish.id,component,status:'needs_review',reason:e.message});}
 };
 for(const dish of config.items.filter(i=>i.active&&!i.restricted)) {
  if(!dish.variants.length&&basePlans.has(dish.name))save(dish,'base',basePlans.get(dish.name));
  for(const v of dish.variants.filter(v=>v.active)) {
   let specs;
   if(dish.name==='Классический чай'&&classic.includes(v.name))specs=[pack('Чай в стиках',1000),...(v.name==='Чёрный со специями и молоком'?[milk(100),g('Корица',1)]:[])];
   if(dish.name==='Травяной и ягодный чай'&&herbal.includes(v.name))specs=[pack('Чай травяной',1000)];
   if(dish.name==='Смузи'&&v.name==='Клубника-Банан')specs=[g('Бананы',150),g('Клубника замороженная',150),milk(200)];
   if(dish.name==='Смузи'&&v.name==='Облепиха-Банан')specs=[g('Бананы',150),g('Облепиха',150),milk(200)];
   if(dish.name==='Кальян на чайной смеси'&&dish.station==='tea_hookah'&&flavors.includes(v.name))specs=[pack('Чайная смесь — '+v.name,400),pack('Угли',30),pack('Мундштуки',10)];
   if(specs)save(dish,'variant:'+v.id,specs);
  }
  for(const group of config.groups.filter(gr=>gr.active&&dish.groupIds.includes(gr.id)))for(const option of group.options.filter(o=>o.active)) {
   let specs;
   if(group.id==='coffee_sugar') {
    const n={'Без сахара':0,'1 пакетик':1,'2 пакетика':2,'3 пакетика':3}[option.name];
    if(n!==undefined)specs=n?[pack('Сахар в стиках',n*1000)]:[];
   }
   if(group.id==='coffee_milk'&&milkDoses.has(dish.name)) {
    const original=findGood('Молоко обычное'),base=stock.recipe(dish.id,'base');
    const included=base?.ingredients.find(i=>i.id===original?.id&&i.unitId===original.unit_id&&i.amount>0);
    if(!included){results.push({name:dish.name,itemId:dish.id,component:'option:'+option.id,status:'needs_review',reason:'existing_base_has_no_ordinary_milk'});continue;}
    const milkMl=key(original.unit)==='л'?included.amount:key(original.unit)==='мл'?included.amount/1000:null;
    if(milkMl===null){results.push({name:dish.name,itemId:dish.id,component:'option:'+option.id,status:'needs_review',reason:'incompatible_base_milk_unit'});continue;}
    const alt={'Овсяное':'Молоко овсяное','Кокосовое':'Молоко кокосовое','Безлактозное':'Молоко безлактозное'}[option.name];
    if(option.name==='Обычное')specs=[];
    else if(alt)specs=[{...ml(alt,milkMl),replaces:'Молоко обычное'}];
   }
   if(group.id==='sauces') {
    const name={'Кетчуп':'Кетчуп','Сырный соус':'Сырный соус','BBQ':'BBQ-соус','Чесночный соус':'Чесночный соус'}[option.name];
    if(name)specs=[pack(name,1000)];
   }
   if(group.id==='syrniki_toppings')specs={
    'Сгущёнка':[pack('Сгущёнка обычная',80)],'Сметана':[pack('Сметана',150)],
    'Варенье':[pack('Варенье',100)],'Мёд':[pack('Мёд',100)],
   }[option.name];
   if(specs)save(dish,'option:'+option.id,specs);
  }
 }
 return results;
}
