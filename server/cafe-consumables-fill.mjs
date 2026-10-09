import {randomUUID} from 'node:crypto';
import {normalizeInventoryName,quantity,quantityText} from './inventory.mjs';
import {buildConsumablesPlan} from './cafe-consumables-plan.mjs';

export function fillCafeConsumables(cafe,user){
 if(user?.role!=='admin')throw Object.assign(new Error('Автозаполнение доступно только администратору.'),{status:403});
 const stock=cafe.stock,initial=stock.config(user),changes=[];
 const named=(config,name)=>config.inventory.filter(i=>normalizeInventoryName(i.name)===normalizeInventoryName(name));
 const paper=named(initial,'Пергамент');
 if(paper.length===1){
  const row=paper[0],name=normalizeInventoryName(row.unit);
  if(['рулон','рулоны'].includes(name)){
   const used=stock.db.prepare('SELECT id FROM cafe_stock_usage WHERE item_id=? LIMIT 1').get(row.id);
   const referenced=initial.recipes.some(r=>r.ingredients.some(i=>i.id===row.id||i.replacesId===row.id));
   if(used||referenced)changes.push({kind:'unit_review',stockItemId:row.id,reason:'Есть сохранённый расход или рецептура в рулонах. Единица и история не переписаны.'});
   else{
    const converted=value=>value==null?null:quantityText(value*2000);
    stock.inventory.save({id:row.id,revision:row.revision,name:row.name,category:row.category,unit:'см',current:converted(row.current_milli),minimum:converted(row.minimum_milli),target:converted(row.target_milli),manualBuy:!!row.manual_buy,comment:[row.comment,'Подтверждено владельцем: рулон 20 м = 2000 см; расход на пиццу 30 см.'].filter(Boolean).join('\n'),reason:'Перевод рулонов в сантиметры по 2000 см; физический запас не изменён.',requestId:randomUUID()},user);
    changes.push({kind:'unit_converted',stockItemId:row.id,factor:2000,unit:'см'});
   }
  }
 }
 for(const [name,category] of [['Коробки для пиццы','Упаковка'],['Трубочки','Стаканы и крышки']]){
  const config=stock.config(user);if(named(config,name).length)continue;
  const result=stock.inventory.save({name,category,unit:'шт',current:null,minimum:null,target:null,manualBuy:false,comment:'Норма: 1 шт. Фактический остаток и количество в закупочной пачке не известны и не придуманы.',requestId:randomUUID()},user);
  changes.push({kind:'stock_created',stockItemId:result.item.id,name,current:null});
 }
 let config=stock.config(user),plan=buildConsumablesPlan({...config,categories:cafe.catalog().categories});
 const groups=new Map();
 for(const row of plan.rows.filter(r=>r.status==='ready'&&r.basis==='portion'&&r.quantity!=null&&r.stockItemId!=null&&r.source!=='existing')){
  const key=row.itemId+'\0'+row.component;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
 }
 for(const rows of groups.values()){
  const head=rows[0],old=stock.recipe(head.itemId,head.component);if(!old?.ingredients.length)continue;
  // Existing doses and replacement relations are never inferred or rewritten.
  if(old.ingredients.some(i=>{const item=config.inventory.find(s=>s.id===i.id);return !item?.active||item.unit_id!==i.unitId||Object.keys(i).some(k=>!['id','unitId','amount','replacesId'].includes(k));})){
   changes.push({kind:'recipe_review',itemId:head.itemId,component:head.component,reason:'Сохранённые ингредиенты или единицы требуют сверки; рецептура оставлена без изменений.'});continue;
  }
  const inputs=old.ingredients.map(i=>({id:i.id,amount:quantityText(i.amount),...(i.replacesId!==undefined?{replacesId:i.replacesId}:{})}));
  const additions=[];
  for(const row of rows){if(inputs.some(i=>i.id===row.stockItemId))continue;quantity(row.quantity);inputs.push({id:row.stockItemId,amount:row.quantity});additions.push({stockItemId:row.stockItemId,quantity:row.quantity,source:row.source});}
  if(!additions.length)continue;
  stock.save({itemId:head.itemId,component:head.component,revision:old.revision,ingredients:inputs},user,{additions});
  changes.push({kind:'recipe_extended',itemId:head.itemId,component:head.component,additions});
 }
 config=stock.config(user);plan=buildConsumablesPlan({...config,categories:cafe.catalog().categories});
 return {changes,...plan};
}
