import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fleet} from './admin.mjs';
import {calculateRecipeCost,combineRecipeIngredients} from './cafe-recipe-cost.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const stable=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
export const cafeCostKey=(itemId,component='base')=>itemId+'|'+component;
function automaticLineCost(reader,line,at){
 const component=line.variant?'variant:'+line.variant.id:'base',snapshot=reader('cafe',cafeCostKey(line.itemId,component),at).recipeCost;
 if(!snapshot)return {portionCents:null,estimated:false};
 const options=(line.modifiers||[]).map(m=>reader('cafe',cafeCostKey(line.itemId,'option:'+m.optionId),at).recipeCost);
 if(options.some(o=>!o))return {portionCents:null,estimated:false};
 const ingredients=combineRecipeIngredients(snapshot.ingredients,options.map(o=>o.ingredients));if(!ingredients)return {portionCents:null,estimated:false};
 const prices=new Map([...snapshot.prices,...options.flatMap(o=>o.prices)].map(p=>[p.id,p]));
 return calculateRecipeCost(ingredients,prices,{missing:[...snapshot.missingNorms,...options.flatMap(o=>o.missingNorms)]});
}
export function cafeLineCost(reader,line,at){
 const component=line.variant?'variant:'+line.variant.id:'base',own=reader('cafe',cafeCostKey(line.itemId,component),at);
 if(line.costMode==='recipe')return automaticLineCost(reader,line,at).portionCents;
 return line.variant?.useBaseRecipe===true&&!Object.hasOwn(own,'portionCents')?reader('cafe',cafeCostKey(line.itemId,'base'),at).portionCents:own.portionCents;
}
export function cafeLineCostEstimated(reader,line,at){
 if(line.costMode!=='recipe')return false;
 return automaticLineCost(reader,line,at).estimated;
}
const fields={cafe:['portionCents'],rental:['issueCents','hourCents','kwhPerHour','electricityTariffCents','electricityIncluded'],settings:['cafeCardBps','rentalCardBps','cafeWageBps','deliveryCostCents']};
export class OperationsCosts{
 constructor(admin,cafe){this.admin=admin;this.db=admin.db;this.cafe=cafe;this.db.exec(readFileSync(new URL('./migrations/operations-analytics.sql',import.meta.url),'utf8'));if(cafe)cafe.recipeCosts=this;}
 revision(){return this.db.prepare('SELECT coalesce(max(id),0) n FROM operations_cost_versions').get().n;}
 definitions(includeInactive=false){
  const rows=[];
  for(const item of this.cafe?.catalog().items||[]){
   if(!item.active&&!includeInactive)continue;
   const variants=item.variants.filter(v=>includeInactive||v.active),components=variants.length?variants.map(v=>['variant:'+v.id,item.name+' · '+v.name]):[['base',item.name]];
   if(variants.length&&(includeInactive||variants.some(v=>v.useBaseRecipe===true)))components.unshift(['base',item.name+' · Общий состав']);
   for(const group of this.cafe.catalog().groups.filter(g=>item.groupIds.includes(g.id)&&(includeInactive||g.active)))for(const option of group.options.filter(o=>includeInactive||o.active))components.push(['option:'+option.id,item.name+' · '+group.name+' · '+option.name]);
   for(const [component,name] of components)rows.push({kind:'cafe',key:cafeCostKey(item.id,component),name,component,itemId:item.id,fields:{portionCents:null}});
  }
  for(const [key,name] of fleet)rows.push({kind:'rental',key,name,fields:{issueCents:null,hourCents:null,...(['catamaran','electric'].includes(key)?{kwhPerHour:null,electricityTariffCents:null,electricityIncluded:null}:{})}});
  rows.push({kind:'settings',key:'global',name:'Комиссии и распределение зарплаты',fields:{cafeCardBps:null,rentalCardBps:null,cafeWageBps:null,deliveryCostCents:null}});
  return rows;
 }
 at(kind,key,at=Date.now()){const row=this.db.prepare('SELECT body FROM operations_cost_versions WHERE kind=? AND target_key=? AND effective_at<=? ORDER BY effective_at DESC,id DESC LIMIT 1').get(kind,key,at);return row?JSON.parse(row.body):{};}
 recipeCostSnapshot(item,component,now=Date.now()){
  const variant=component.startsWith('variant:')?item.variants.find(v=>'variant:'+v.id===component):null;
  const source=variant?.useBaseRecipe===true?'base':component,recipe=this.cafe.stock.recipe(item.id,source),ingredients=recipe?.ingredients||[];
  const missingNorms=[...(item.missingRecipeNorms||[]),...(variant?.missingRecipeNorms||[])];
  if(!recipe)missingNorms.push('Не заполнен состав');
  const prices=[],hasPrices=!!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cafe_purchase_price_versions'").get();
  for(const id of new Set(ingredients.map(i=>i.id))){
   if(!hasPrices)continue;
   const inventory=this.cafe.stock.inventory.row(id);
   if(!inventory.active||ingredients.some(i=>i.id===id&&i.unitId!==inventory.unit_id))continue;
   const row=this.db.prepare('SELECT p.* FROM cafe_purchase_price_versions p WHERE inventory_id=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1').get(id,now);
   if(!row)continue;
   const audit=this.db.prepare("SELECT body FROM cafe_audit WHERE action='purchase_price' AND json_extract(body,'$.priceVersionId')=? ORDER BY id DESC LIMIT 1").get(row.id);
   const provenance=audit?JSON.parse(audit.body):{};
   prices.push({id,unitId:row.unit_id,quantityMilli:row.quantity_milli,totalCents:row.total_cents,estimated:provenance.estimated===true});
  }
  const result=calculateRecipeCost(ingredients,new Map(prices.map(p=>[p.id,p])),{allowEmpty:component.startsWith('option:')&&!!recipe,missing:missingNorms});
  return {ingredients,prices,missingNorms:result.missingNorms,missingPrices:result.missingPrices,estimated:result.estimated,portionCents:result.portionCents};
 }
 syncRecipeCosts(u,now=Date.now(),requestId='recipe-sync:'+now){
  for(const item of this.cafe?.catalog().items||[]){
   if(item.costMode!=='recipe')continue;
   const components=['base',...item.variants.map(v=>'variant:'+v.id),...this.cafe.catalog().groups.filter(g=>item.groupIds.includes(g.id)).flatMap(g=>g.options.map(o=>'option:'+o.id))];
   for(const component of new Set(components)){
    const key=cafeCostKey(item.id,component),recipeCost=this.recipeCostSnapshot(item,component,now),after={portionCents:recipeCost.portionCents,recipeCost};
    if(stable(this.at('cafe',key,now))===stable(after))continue;
    this.db.prepare('INSERT INTO operations_cost_versions(kind,target_key,effective_at,body,actor,request_id) VALUES(?,?,?,?,?,?)').run('cafe',key,now,JSON.stringify(after),u.id,requestId);
    this.cafe.audit(u,'recipe_cost',{itemId:item.id,component,portionCents:after.portionCents,estimated:recipeCost.estimated,missingPrices:recipeCost.missingPrices,missingNorms:recipeCost.missingNorms});
   }
  }
 }
 currentCafeCost(itemId,component,now=Date.now()){
  const own=this.at('cafe',cafeCostKey(itemId,component),now),item=this.cafe.catalog().items.find(i=>i.id===itemId),variant=component.startsWith('variant:')?item?.variants.find(v=>'variant:'+v.id===component):null;
  if(item?.costMode==='recipe'){const result=this.recipeCostSnapshot(item,component,now);return {...result,source:'recipe'};}
  if(variant?.useBaseRecipe===true&&!Object.hasOwn(own,'portionCents')){const shared=this.at('cafe',cafeCostKey(itemId,'base'),now);return {portionCents:shared.portionCents??null,source:'base'};}
  return {portionCents:own.portionCents??null,source:Object.hasOwn(own,'portionCents')?'own':'missing'};
 }
 catalog(u,now=Date.now()){if(u?.role!=='admin'||u.scheduleOnly)fail('Себестоимость доступна администратору.',403);return {revision:this.revision(),canEdit:true,role:u.role,rows:this.definitions().map(r=>({...r,fields:{...r.fields,...this.at(r.kind,r.key,now),...(r.kind==='cafe'?{portionCents:this.currentCafeCost(r.itemId,r.component,now).portionCents}:{})}}))};}
 save(body,u,now=Date.now(),{cafeOnly=false,transaction=fn=>this.admin.workforce.tx(fn)}={}){
  if(u?.scheduleOnly||!(cafeOnly?['admin','staff','waiter'].includes(u?.role):u?.role==='admin'))fail('Аналитика доступна администратору.',403);
  if(!body||!/^[-a-f0-9]{36}$/i.test(body.requestId||'')||!Number.isSafeInteger(body.revision)||!Array.isArray(body.changes)||!body.changes.length||body.changes.length>500)fail('Проверьте изменения себестоимости.');
  const fingerprint=createHash('sha256').update(stable({body,actor:u.id})).digest('hex');
  return transaction(()=>{
   const previous=this.db.prepare('SELECT * FROM operations_cost_requests WHERE request_id=?').get(body.requestId);
   if(previous){if(previous.fingerprint!==fingerprint||previous.actor!==u.id)fail('Ключ операции уже использован.',409);return cafeOnly?{revision:this.revision(),duplicate:true}:{...this.catalog(u,now),duplicate:true};}
   if(body.revision!==this.revision())fail('Себестоимость уже изменена. Обновите данные, сохранив ваши значения.',409);
   const definitions=new Map(this.definitions(cafeOnly).filter(r=>!cafeOnly||r.kind==='cafe').map(r=>[r.kind+'\0'+r.key,r])),seen=new Set();
   for(const change of body.changes){
    if(!change||!definitions.has(change.kind+'\0'+change.key)||!change.values||typeof change.values!=='object'||Array.isArray(change.values)||!Object.keys(change.values).length)fail('Неизвестная позиция или поле себестоимости.');
    const key=change.kind+'\0'+change.key;if(seen.has(key))fail('Позиция указана дважды.');seen.add(key);
    for(const [field,value] of Object.entries(change.values)){
     if(!fields[change.kind].includes(field)||!Object.hasOwn(definitions.get(key).fields,field))fail('Неизвестное поле себестоимости.');
     if(value===null)continue;
     const max=field.endsWith('Bps')?10000:field==='electricityIncluded'?1:100000000;
     if(field==='kwhPerHour'){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1000||Math.abs(value*1000-Math.round(value*1000))>1e-6)fail('Расход электричества: число до трёх знаков после запятой.');}
     else if(!Number.isSafeInteger(value)||value<0||value>max)fail('Проверьте стоимость, процент или количество.');
    }
    const before=this.at(change.kind,change.key,now),after={...before,...change.values};if(change.kind==='cafe'&&Object.hasOwn(change.values,'portionCents'))delete after.recipeCost;
    if(stable(before)!==stable(after))this.db.prepare('INSERT INTO operations_cost_versions(kind,target_key,effective_at,body,actor,request_id) VALUES(?,?,?,?,?,?)').run(change.kind,change.key,now,JSON.stringify(after),u.id,body.requestId);
   }
   this.db.prepare('INSERT INTO operations_cost_requests VALUES(?,?,?,?,?)').run(body.requestId,fingerprint,u.id,this.revision(),now);
   return cafeOnly?{revision:this.revision()}:this.catalog(u,now);
  });
 }
 reader(){const rows=this.db.prepare('SELECT kind,target_key,effective_at,id,body FROM operations_cost_versions ORDER BY effective_at,id').all(),map=new Map();for(const r of rows){const key=r.kind+'\0'+r.target_key;if(!map.has(key))map.set(key,[]);map.get(key).push({...r,body:JSON.parse(r.body)});}return (kind,key,at)=>{const versions=map.get(kind+'\0'+key)||[];for(let i=versions.length-1;i>=0;i--)if(versions[i].effective_at<at)return versions[i].body;return {};};}
}
