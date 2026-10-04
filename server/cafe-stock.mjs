import {readFileSync} from 'node:fs';
import {InventoryStore,quantity} from './inventory.mjs';
const fail=(message,status=409,extra={})=>{throw Object.assign(new Error(message),{status,...extra});};
export class CafeStock{
 constructor(cafe){this.cafe=cafe;this.db=cafe.db;this.inventory=new InventoryStore(cafe.admin);this.db.exec(readFileSync(new URL('./migrations/003-cafe-stock.sql',import.meta.url),'utf8'));}
 recipe(itemId,component){const r=this.db.prepare('SELECT * FROM cafe_recipes WHERE item_id=? AND component=?').get(itemId,component);return r?{...r,ingredients:JSON.parse(r.body)}:null;}
 config(u){if(u?.role!=='admin')fail('Доступно только admin.',403);return {items:this.cafe.catalog().items,groups:this.cafe.catalog().groups,recipes:this.db.prepare('SELECT * FROM cafe_recipes').all().map(r=>({...r,ingredients:JSON.parse(r.body)})),inventory:this.inventory.catalog(u).items};}
 save(b,u){if(u?.role!=='admin')fail('Доступно только admin.',403);const item=this.cafe.catalog().items.find(i=>i.id===b.itemId);if(!item)fail('Блюдо не найдено.',404);const components=['base',...item.variants.map(v=>'variant:'+v.id),...this.cafe.catalog().groups.filter(g=>item.groupIds.includes(g.id)).flatMap(g=>g.options.map(o=>'option:'+o.id))];if(!components.includes(b.component)||!Array.isArray(b.ingredients)||b.ingredients.length>30||(!b.ingredients.length&&!b.component.startsWith('option:')))fail('Укажите расход на одну порцию.',400);
 const option=b.component.startsWith('option:')?this.cafe.catalog().groups.filter(g=>item.groupIds.includes(g.id)).flatMap(g=>g.options).find(o=>'option:'+o.id===b.component):null;if(option&&((option.id==='coffee_sugar-0'&&option.name==='Без сахара')||(option.id==='coffee_milk-0'&&option.name==='Обычное'))&&b.ingredients.length)fail('Эта опция не добавляет ингредиенты. Кофе и обычное молоко укажите только в основной порции.',400);
 return this.cafe.transaction(()=>{const old=this.recipe(b.itemId,b.component);if(b.revision!==(old?.revision??-1))fail('Рецептура изменена. Обновите страницу.');const seen=new Set(),replaced=new Set(),ingredients=b.ingredients.map(i=>{
  if(!i||typeof i!=='object'||Array.isArray(i))fail('Проверьте товар и расход.',400);
  const row=this.inventory.row(i.id),amount=quantity(i.amount);if(!row.active||!amount||seen.has(i.id))fail('Проверьте товар и расход.',400);seen.add(i.id);
  const ingredient={id:i.id,unitId:row.unit_id,amount};
  if(Object.hasOwn(i,'replacesId')){
   if(!b.component.startsWith('option:')||!Number.isSafeInteger(i.replacesId)||i.replacesId<1||i.replacesId===i.id||replaced.has(i.replacesId))fail('Проверьте заменяемый ингредиент основы.',400);
   this.inventory.row(i.replacesId); // An archived original can still be replaced in an existing base.
   replaced.add(i.replacesId);ingredient.replacesId=i.replacesId;
  }
  return ingredient;
 });this.db.prepare('INSERT INTO cafe_recipes VALUES(?,?,?,0) ON CONFLICT(item_id,component) DO UPDATE SET body=excluded.body,revision=revision+1').run(b.itemId,b.component,JSON.stringify(ingredients));const after=this.recipe(b.itemId,b.component);this.cafe.audit(u,'recipe',{before:old,after});return after;});}
 requirements(line,recipeFor=(itemId,component)=>this.recipe(itemId,component)){
  if(line.custom===true)return [];
  const unconfigured=()=>fail(`«${line.name}»: расход ещё не настроен. Обратитесь к администратору.`,409,{stockCode:'UNCONFIGURED',itemId:line.itemId,available:0});
  const load=key=>{const recipe=recipeFor(line.itemId,key);if(!recipe)unconfigured();return recipe.ingredients;};
  const base=load(line.variant?'variant:'+line.variant.id:'base'),options=(line.modifiers||[]).flatMap(m=>load('option:'+m.optionId)),replaced=new Set();
  for(const ingredient of options){if(ingredient.replacesId===undefined)continue;
   if(!base.some(i=>i.id===ingredient.replacesId)||replaced.has(ingredient.replacesId))unconfigured();
   replaced.add(ingredient.replacesId);
  }
  // Replacements affect the original portion only; other additions always remain.
  return [...base.filter(i=>!replaced.has(i.id)),...options];
 }
 check(lines){const total=new Map();for(const l of lines){for(const r of this.requirements(l)){const old=total.get(r.id)||{amount:0,unitId:r.unitId,lines:[]};if(old.unitId!==r.unitId)fail('Изменилась единица склада. Проверьте рецептуру.');old.amount+=r.amount*l.quantity;old.lines.push({line:l,perUnit:r.amount});total.set(r.id,old);}}
 for(const [id,r] of total){const stock=this.inventory.row(id);if(!stock.active||stock.current_milli===null||stock.unit_id!==r.unitId)fail(`«${stock.name}»: фактический остаток или единица не заполнены.`,409,{stockCode:'UNCONFIGURED',available:0,itemId:r.lines[0].line.itemId});if(stock.current_milli<r.amount){const l=r.lines[0].line,own=r.lines.filter(x=>x.line===l).reduce((n,x)=>n+x.perUnit,0),others=r.amount-own*l.quantity,available=Math.max(0,Math.floor((stock.current_milli-others)/own));fail(`«${l.name}»: доступно ${available} шт. Уменьшите количество в корзине.`,409,{stockCode:'INSUFFICIENT',available,itemId:l.itemId});}}
 return total;}
 consume(orderId,lines,u,now){const need=this.check(lines);for(const [id,r] of need){const before=this.inventory.row(id);const result=this.db.prepare('UPDATE inventory_items SET current_milli=current_milli-?,updated_at=?,updated_by=?,revision=revision+1 WHERE id=? AND current_milli>=?').run(r.amount,now,u?.id??null,id,r.amount);if(!result.changes)fail('Остаток изменился. Проверьте заказ.');this.db.prepare('INSERT INTO cafe_stock_usage(order_id,item_id,unit_id,amount_milli,created_at) VALUES(?,?,?,?,?)').run(orderId,id,r.unitId,r.amount,now);this.inventory.event(u||{login:'Заказ кафе'},'SALE',before,this.inventory.row(id),'Заказ кафе №'+orderId,null,null,now);}}
 cancel(order,u,now){
 // Food already in preparation stays consumed. The cancellation and usage remain in history.
 const prepared=order.events.some(e=>['COOKING','READY','DELIVERED'].includes(e.kind));if(prepared)return {restored:false,reason:'Заказ уже готовился; расход сохранён.'};
 for(const usage of this.db.prepare('SELECT * FROM cafe_stock_usage WHERE order_id=? AND restored_at IS NULL').all(order.id)){const before=this.inventory.row(usage.item_id);if(before.unit_id!==usage.unit_id||before.current_milli===null)fail('Перед отменой восстановите единицу и фактический остаток «'+before.name+'».');if(before.current_milli+usage.amount_milli>999999999999)fail('Остаток превышает допустимый предел.');this.db.prepare('UPDATE inventory_items SET current_milli=current_milli+?,updated_at=?,updated_by=?,revision=revision+1 WHERE id=?').run(usage.amount_milli,now,u.id,usage.item_id);this.db.prepare('UPDATE cafe_stock_usage SET restored_at=? WHERE id=?').run(now,usage.id);this.inventory.event(u,'RETURN',before,this.inventory.row(usage.item_id),'Отмена заказа кафе №'+order.id,null,null,now);}return {restored:true};}
 availability(item,groups=this.cafe.catalog().groups,context){
  const recipeCache=new Map(),stockCache=new Map();
  const recipeFor=context?.recipeFor||((id,key)=>{if(!recipeCache.has(key))recipeCache.set(key,this.recipe(id,key));return recipeCache.get(key);});
  const stockFor=context?.stockFor||(id=>{if(!stockCache.has(id))stockCache.set(id,this.inventory.row(id));return stockCache.get(id);});
  const options=groups.filter(g=>g.active&&item.groupIds.includes(g.id)).flatMap(g=>g.options.filter(o=>o.active&&!o.soldOut).map(o=>({optionId:o.id,groupId:g.id,replaces:!!recipeFor(item.id,'option:'+o.id)?.ingredients.some(i=>i.replacesId!==undefined)})));
  const replacements=options.filter(o=>o.replaces),optionEntries=[];
  const measure=(variant,modifiers)=>{try{
   const totals=new Map();for(const r of this.requirements({itemId:item.id,name:item.name,variant,modifiers},recipeFor)){const old=totals.get(r.id);if(old&&old.unitId!==r.unitId)return {available:0,configured:false};totals.set(r.id,{amount:(old?.amount||0)+r.amount,unitId:r.unitId});}
   let available=1000000;for(const [id,r] of totals){const stock=stockFor(id);if(!stock?.active||stock.current_milli===null||stock.unit_id!==r.unitId)return {available:0,configured:false};available=Math.min(available,Math.floor(stock.current_milli/r.amount));}
   return {available,configured:true};
  }catch{return {available:0,configured:false};}};
  const best=states=>({available:Math.max(0,...states.map(s=>s.available)),configured:states.some(s=>s.configured)});
  const variants=item.variants.filter(v=>v.active),entries=(variants.length?variants:[null]).map(variant=>{
   const plain=measure(variant,[]),variantId=variant?.id??null;
   // One replacement choice covers milk selection without an exponential search
   // through unrelated modifier groups. Checkout validates the complete selection.
   const available=best([plain,...replacements.map(option=>measure(variant,[option]))]);
   for(const option of options){const states=[measure(variant,[option])];for(const replacement of replacements)if(replacement.groupId!==option.groupId)states.push(measure(variant,[option,replacement]));optionEntries.push({optionId:option.optionId,variantId,...best(states),replaces:option.replaces});}
   return {variantId,...available,defaultAvailable:plain.available};
  });
  return {variants:entries,options:optionEntries,...best(entries),defaultAvailable:Math.max(0,...entries.map(e=>e.defaultAvailable))};
 }
 menu(d){d.stockRevision=this.db.prepare('SELECT coalesce(max(id),0) n FROM inventory_transactions').get().n+':'+this.db.prepare('SELECT coalesce(sum(revision+1),0) n FROM cafe_recipes').get().n;
  const recipes=new Map(this.db.prepare('SELECT item_id,component,body FROM cafe_recipes').all().map(r=>[r.item_id+'\0'+r.component,{ingredients:JSON.parse(r.body)}])),stocks=new Map();
  const context={recipeFor:(id,key)=>recipes.get(id+'\0'+key),stockFor:id=>{if(!stocks.has(id))stocks.set(id,this.inventory.row(id));return stocks.get(id);}};
  for(const i of d.items)i.stock=this.availability(i,d.groups,context);return d;}
}
