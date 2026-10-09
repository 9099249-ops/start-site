(()=>{'use strict';
const clone=value=>JSON.parse(JSON.stringify(value));
const rubles=cents=>cents===null||cents===undefined?'':String(cents/100);
const fail=(message,target={})=>{throw Object.assign(Error(message),{target});};
function money(value,label,target={}){
 const text=String(value??'').trim().replace(',','.');
 if(!text)return null;
 if(!/^\d{1,7}(\.\d{1,2})?$/.test(text))fail(label+': укажите сумму в рублях и копейках.',target);
 return Math.round(Number(text)*100);
}
function amount(value,label,target={}){
 const text=String(value??'').trim().replace(',','.');
 if(!/^\d{1,9}(\.\d{1,3})?$/.test(text)||decimalMilli(text)===0n)fail(label+': укажите количество больше нуля, до трёх знаков после запятой.',target);
 const [whole,fraction='']=text.split('.'),normalizedWhole=whole.replace(/^0+(?=\d)/,'')||'0',normalizedFraction=fraction.replace(/0+$/,'');
 return normalizedWhole+(normalizedFraction?'.'+normalizedFraction:'');
}
function decimalMilli(value){
 const text=String(value??'').trim().replace(',','.');
 if(!/^\d{1,9}(\.\d{1,3})?$/.test(text))return null;
 const [whole,fraction='']=text.split('.');return BigInt(whole)*1000n+BigInt((fraction+'000').slice(0,3));
}
function milliText(value){const whole=value/1000n,fraction=String(value%1000n).padStart(3,'0').replace(/0+$/,'');return String(whole)+(fraction?'.'+fraction:'');}
function consumptionUnit(unit){return unit==='кг'?'г':unit==='л'?'мл':unit;}
function displayConsumption(value,unit){
 const milli=decimalMilli(value);if(milli===null)return String(value??'');
 return (unit==='кг'||unit==='л')?String(milli):milliText(milli);
}
function setConsumption(value,unit){
 const text=String(value??'').trim().replace(',','.');
 if(unit==='кг'||unit==='л'){
  if(!/^\d{1,12}$/.test(text))return null;
  return milliText(BigInt(text));
 }
 return decimalMilli(text)===null?null:milliText(decimalMilli(text));
}
function create(snapshot,item){
 const current=item? snapshot.catalog.items.find(row=>row.id===item.id)||item:null;
 const product=current?clone(current):{id:crypto.randomUUID(),name:'',description:'',priceCents:0,categoryId:snapshot.catalog.categories.find(c=>c.active)?.id||snapshot.catalog.categories[0]?.id||'',size:'',image:'',tags:[],active:true,soldOut:false,yacht:true,station:'kitchen',restricted:false,blockQuickSale:false,sort:snapshot.catalog.items.length+1,variants:[],groupIds:[]};
 const state={snapshot,item:product,price:rubles(product.priceCents),sort:String(product.sort),tags:product.tags.join(', '),variants:new Map(product.variants.map(v=>[v.id,{...v,price:rubles(v.priceCents)}])),recipes:new Map(),costs:new Map(),purchases:new Map(),costSources:new Map(),forceCosts:new Set(),costMode:product.costMode==='recipe'?'recipe':'manual',costModeChanged:!current};
 for(const row of snapshot.stock.recipes.filter(r=>r.item_id===product.id))state.recipes.set(row.component,{revision:row.revision,ingredients:row.ingredients.map(i=>({id:i.id,unitId:i.unitId,amount:String(Number(i.amount)/1000),...(i.replacesId?{replacesId:i.replacesId}:{})}))});
 for(const row of snapshot.costs.filter(r=>r.itemId===product.id))state.costs.set(row.component,rubles(row.portionCents));
 for(const [index,row] of (snapshot.costSources||[]).entries()){
  const cost=snapshot.costs.find(r=>r.itemId===product.id&&r.component===row.component)||snapshot.costs.filter(r=>r.itemId===product.id)[index];
  const component=row.component||cost?.component;if((row.itemId===undefined||row.itemId===product.id)&&component)state.costSources.set(component,row.source);
 }
 for(const row of snapshot.purchasePrices)state.purchases.set(String(row.inventoryId),{quantity:row.quantity,total:rubles(row.totalCents),unitId:row.unitId,...(row.estimated===true?{estimated:true}:{}),...(row.sourceUrl?{sourceUrl:row.sourceUrl}:{}),...(row.sourceLabel?{sourceLabel:row.sourceLabel}:{})});
 return state;
}
function components(state){
 const result=['base',...[...state.variants.keys()].map(id=>'variant:'+id)];
 for(const group of state.snapshot.catalog.groups.filter(g=>state.item.groupIds.includes(g.id)))for(const option of group.options)result.push('option:'+option.id);
 return result;
}
function recipe(state,key){if(!state.recipes.has(key))state.recipes.set(key,{revision:-1,ingredients:[]});return state.recipes.get(key);}
function name(state,key){
 if(key==='base')return state.variants.size?'Общий состав':state.item.name||'Порция';
 if(key.startsWith('variant:'))return state.variants.get(key.slice(8))?.name||'Новый вариант';
 for(const group of state.snapshot.catalog.groups)for(const option of group.options)if('option:'+option.id===key)return group.name+' · '+option.name;
 return 'Добавка';
}
function savedRecipe(state,key){return state.snapshot.stock.recipes.find(r=>r.item_id===state.item.id&&r.component===key);}
function effectiveCost(state,key){
 const row=state.snapshot.costs.find(r=>r.itemId===state.item.id&&r.component===key);
 const own=state.costSources.get(key)==='own'||(!state.costSources.has(key)&&row?.portionCents!==null&&row?.portionCents!==undefined);
 if(state.costMode==='recipe'){
  const recipeKey=key.startsWith('variant:')&&state.variants.get(key.slice(8))?.useBaseRecipe===true?'base':key;
  const configured=recipe(state,recipeKey).ingredients,inventory=new Map(state.snapshot.stock.inventory.map(item=>[item.id,item])),variant=key.startsWith('variant:')?state.variants.get(key.slice(8)):null;
  const missing=[...(Array.isArray(state.item.missingRecipeNorms)?state.item.missingRecipeNorms.filter(value=>typeof value==='string'):[]),...(Array.isArray(variant?.missingRecipeNorms)?variant.missingRecipeNorms.filter(value=>typeof value==='string'):[])];
  const ingredients=[];
  for(const entry of configured){
   const stock=inventory.get(Number(entry.id)),amountValue=decimalMilli(entry.amount);
   if(entry.displayDraft!==undefined){const draft=setConsumption(entry.displayDraft,stock?.unit);if(draft===null||decimalMilli(draft)<=0n){missing.push(stock?.name||'Незаполненная норма');continue;}}
   if(!entry.id||!stock||amountValue===null||amountValue<=0n){missing.push(stock?.name||'Незаполненная норма');continue;}
   const savedUnitId=Number(entry.unitId)||Number(stock.unit_id);
   if(savedUnitId!==Number(stock.unit_id)){missing.push('Единица нормы изменилась: '+stock.name);continue;}
   ingredients.push({id:Number(entry.id),unitId:savedUnitId,amount:Number(amountValue)});
  }
  const prices=new Map();
  for(const [id,purchase] of state.purchases){
   const quantity=decimalMilli(purchase.quantity);let total=null;try{total=money(purchase.total,'Сумма по чеку');}catch{}
   if(quantity===null||quantity===0n||total===null)continue;
   prices.set(Number(id),{unitId:Number(purchase.unitId),quantityMilli:Number(quantity),totalCents:total,estimated:purchase.estimated===true});
  }
  const result=globalThis.STARTCafeRecipeCost?.calculateRecipeCost(ingredients,prices,{allowEmpty:key.startsWith('option:')&&!!savedRecipe(state,key),missing:[...new Set(missing)]});
  const value=result?.portionCents===null||result?.portionCents===undefined?'':rubles(result.portionCents);
  return {value,source:'recipe',own:false,estimated:!!result?.estimated,missingPrices:result?.missingPrices||[],missingNorms:result?.missingNorms||missing};
 }
 if(key.startsWith('variant:')&&state.variants.get(key.slice(8))?.useBaseRecipe===true&&!own)return {value:state.costs.get('base')??'',source:'base',own:false,estimated:false,missingPrices:[],missingNorms:[]};
 return {value:state.costs.get(key)??'',source:own?'own':'missing',own,estimated:false,missingPrices:[],missingNorms:[]};
}
function setCostMode(state,mode){
 if(mode!=='recipe'&&mode!=='manual')throw new TypeError('Cost mode must be recipe or manual.');
 if(state.costMode===mode)return;
 if(mode==='manual')for(const key of components(state)){
  if(key==='base'&&!baseCostEditable(state))continue;
  const effective=effectiveCost(state,key);if(effective.source==='recipe'&&effective.value!==''){
   state.costs.set(key,effective.value);state.costSources.set(key,'own');state.forceCosts.add(key);
  }
 }
 state.costMode=mode;state.costModeChanged=true;state.item.costMode=mode;
}
function baseCostEditable(state){
 const active=[...state.variants.values()].filter(variant=>variant.active);
 return !active.length||active.some(variant=>variant.useBaseRecipe===true);
}
function useBaseRecipe(state,id,enabled){
 const variant=state.variants.get(id);if(!variant)return;
 if(!enabled){
  const own=recipe(state,'variant:'+id),base=recipe(state,'base');
  own.ingredients=base.ingredients.map(row=>({...row}));variant.useBaseRecipe=false;
  const key='variant:'+id,baseCost=effectiveCost(state,'base');if(baseCost.value!==''&&baseCost.value!==undefined){state.costs.set(key,baseCost.value);state.costSources.set(key,'own');state.forceCosts.add(key);}
 }else variant.useBaseRecipe=true;
}
function replacementChoices(state,current){
 const candidates=new Set(recipe(state,'base').ingredients.map(r=>Number(r.id)));
 for(const id of state.variants.keys())for(const row of recipe(state,'variant:'+id).ingredients)candidates.add(Number(row.id));
 if(current)candidates.add(Number(current));
 return state.snapshot.stock.inventory.filter(i=>candidates.has(i.id));
}
function purchase(state,id){
 const key=String(id);
 if(!state.purchases.has(key)){const stock=state.snapshot.stock.inventory.find(i=>i.id===Number(id));state.purchases.set(key,{quantity:'',total:'',unitId:stock?.unit_id});}
 return state.purchases.get(key);
}
function unitPrice(row){
 const quantity=String(row?.quantity??'').trim().replace(',','.'),total=String(row?.total??'').trim().replace(',','.');
 if(!quantity||!total||!Number.isFinite(Number(quantity))||!Number.isFinite(Number(total))||Number(quantity)<=0||Number(total)<0)return null;
 return Number(total)/Number(quantity);
}
function readiness(state,key){
 const variant=key.startsWith('variant:')?state.variants.get(key.slice(8)):null,recipeKey=variant?.useBaseRecipe===true?'base':key,rows=recipe(state,recipeKey).ingredients,option=key.startsWith('option:');
 const configured=rows.length>0&&rows.every(r=>r.id&&String(r.amount).trim()&&Number(String(r.amount).replace(',','.'))>0)||option&&savedRecipe(state,key)&&rows.length===0;
 const effective=effectiveCost(state,key);
 return {recipe:!!configured,cost:String(effective.value??'').trim()!==''};
}
function missingNormMarkers(state,key){
 const markers=[];
 const variant=key.startsWith('variant:')?state.variants.get(key.slice(8)):null;
 const inheritsBase=variant?.useBaseRecipe===true;
 const itemNorms=Array.isArray(state.item.missingRecipeNorms)?state.item.missingRecipeNorms:[];
 if(key==='base'||inheritsBase)itemNorms.forEach((label,index)=>{if(typeof label==='string')markers.push({label,scope:'item',index});});
 if(variant&&Array.isArray(variant.missingRecipeNorms))variant.missingRecipeNorms.forEach((label,index)=>{if(typeof label==='string')markers.push({label,scope:'variant',id:variant.id,index});});
 return markers;
}
function canResolveMissingNorm(state,key,marker){
 if(!marker||!missingNormMarkers(state,key).some(row=>row.scope===marker.scope&&row.id===marker.id&&row.index===marker.index&&row.label===marker.label))return false;
 const variant=key.startsWith('variant:')?state.variants.get(key.slice(8)):null;
 const recipeKey=variant?.useBaseRecipe===true?'base':key;
 const rows=recipe(state,recipeKey).ingredients,inventory=new Map(state.snapshot.stock.inventory.map(item=>[item.id,item]));
 if(rows.some(row=>{const stock=inventory.get(Number(row.id));return stock&&Number(row.unitId)&&Number(row.unitId)!==Number(stock.unit_id);}))return false;
 const normalize=value=>String(value).normalize('NFKC').trim().toLocaleLowerCase();
 const matching=state.snapshot.stock.inventory.filter(item=>item.active===true&&normalize(item.name)===normalize(marker.label));
 if(matching.length){
  if(matching.some(stock=>stock.current_milli===null||stock.current_milli===undefined))return false;
  return matching.some(stock=>rows.some(row=>Number(row.id)===Number(stock.id)&&decimalMilli(row.amount)>0n));
 }
 return rows.some(row=>{const value=decimalMilli(row.amount);return row.id&&value!==null&&value>0n;});
}
function resolveMissingNorm(state,key,marker){
 if(!canResolveMissingNorm(state,key,marker))return false;
 const owner=marker.scope==='item'?state.item:state.variants.get(marker.id);
 const list=owner?.missingRecipeNorms;
 if(!Array.isArray(list)||list[marker.index]!==marker.label)return false;
 list.splice(marker.index,1);
 return true;
}
function buildPayload(state,requestId){
 const item=clone(state.item);item.name=item.name.trim();item.description=item.description.trim();
 if(!item.name)fail('Укажите название товара.',{field:'name'});
 item.priceCents=money(state.price,'Цена продажи',{field:'price'});if(item.priceCents===null)fail('Укажите цену продажи.',{field:'price'});
 if(!/^\d{1,5}$/.test(String(state.sort))||Number(state.sort)>10000)fail('Порядок отображения: число от 0 до 10000.',{field:'sort'});
 item.sort=Number(state.sort);item.tags=state.tags.split(',').map(v=>v.trim()).filter(Boolean);
 item.variants=[...state.variants.values()].map(v=>{
  if(!v.name.trim())fail('Укажите название варианта.',{component:'variant:'+v.id,field:'variantName',id:v.id});
  const {price,...rest}=v;return {...rest,name:v.name.trim(),priceCents:money(price,'Доплата варианта',{component:'variant:'+v.id,field:'variantPrice',id:v.id})??0};
 });
 const recipes=[],costs=[],purchasePrices=[],inventoryIds=new Set();
 if(state.costModeChanged||Object.hasOwn(item,'costMode'))item.costMode=state.costMode;
 if(state.costMode==='recipe')delete item.costs;
 for(const key of components(state)){
  const inherited=key.startsWith('variant:')&&state.variants.get(key.slice(8))?.useBaseRecipe===true;
  if(!inherited){
   const data=recipe(state,key),ingredients=[];
   for(const [index,row] of data.ingredients.entries()){
    if(row.displayDraft!==undefined){const draft=setConsumption(row.displayDraft,state.snapshot.stock.inventory.find(i=>i.id===Number(row.id))?.unit);if(draft===null||decimalMilli(draft)===0n)fail(name(state,key)+': укажите расход больше нуля в текущей единице.',{component:key,row:index,field:'amount'});}
    const hasId=!!row.id,hasAmount=String(row.amount).trim()!=='';
    if(!hasId&&!hasAmount)continue;
    if(!hasId||!hasAmount)fail(name(state,key)+': выберите ингредиент и укажите расход, либо удалите незаполненную строку.',{component:key,row:index,field:hasId?'amount':'ingredient'});
   const entry={id:Number(row.id),amount:amount(row.amount,'Расход на порцию',{component:key,row:index,field:'amount'}),...(row.replacesId?{replacesId:Number(row.replacesId)}:{})};
    ingredients.push(entry);inventoryIds.add(entry.id);
   }
   const saved=savedRecipe(state,key),before=(saved?.ingredients||[]).map(r=>({id:r.id,amount:String(Number(r.amount)/1000),...(r.replacesId?{replacesId:r.replacesId}:{})}));
   if(!ingredients.length&&saved?.ingredients.length&&!key.startsWith('option:'))fail(name(state,key)+': нельзя убрать весь сохранённый расход. Оставьте норму или отключите вариант.',{component:key,field:'ingredient'});
   const changed=JSON.stringify(ingredients)!==JSON.stringify(before);
   if(changed){
    const staleIndex=data.ingredients.findIndex(row=>{const stock=state.snapshot.stock.inventory.find(item=>item.id===Number(row.id));return stock&&Number(row.unitId)&&Number(row.unitId)!==Number(stock.unit_id);});
    if(staleIndex>=0)fail(name(state,key)+': единица складского товара изменилась. Укажите расход заново в текущей единице.',{component:key,row:staleIndex,field:'amount'});
    if(saved||ingredients.length)recipes.push({component:key,revision:data.revision,ingredients});
   }
  }
  const cost=state.costMode==='recipe'?'':state.costs.get(key)??'',parsed=money(cost,'Себестоимость',{component:key,field:'cost'}),savedCost=state.snapshot.costs.find(r=>r.itemId===item.id&&r.component===key),previous=savedCost?.portionCents??null;
  const costSource=effectiveCost(state,key).source;
  if(parsed!==null&&(!inherited||costSource==='own')&&(parsed!==previous||costSource==='base'||state.forceCosts.has(key))){if(key==='base'&&!baseCostEditable(state))fail('Себестоимость заполняется для каждого вида отдельно.',{component:key,field:'cost'});costs.push({component:key,portionCents:parsed});}
 }
 for(const id of inventoryIds){
  const row=state.purchases.get(String(id));if(!row)continue;
  const hasQuantity=String(row.quantity).trim()!=='',hasTotal=String(row.total).trim()!=='';if(!hasQuantity&&!hasTotal)continue;
  if(!hasQuantity||!hasTotal)fail('По закупочному чеку укажите количество и сумму, либо оставьте оба поля пустыми.',{inventoryId:id,field:hasQuantity?'purchaseTotal':'purchaseQuantity'});
  const quantity=amount(row.quantity,'Куплено',{inventoryId:id,field:'purchaseQuantity'}),totalCents=money(row.total,'Сумма по чеку',{inventoryId:id,field:'purchaseTotal'}),saved=state.snapshot.purchasePrices.find(p=>p.inventoryId===id);
  if(!saved||Number(saved.quantity)!==Number(quantity)||saved.totalCents!==totalCents||saved.unitId!==Number(row.unitId))purchasePrices.push({inventoryId:id,quantity,totalCents,unitId:Number(row.unitId),...(row.estimated===true?{estimated:true}:{}),...(row.sourceUrl?{sourceUrl:row.sourceUrl}:{}),...(row.sourceLabel?{sourceLabel:row.sourceLabel}:{})});
 }
 const payload={requestId,menuRevision:state.snapshot.catalog.revision,costRevision:state.snapshot.costRevision,pricingRevision:state.snapshot.pricingRevision,item,recipes,purchasePrices};
 if(state.costMode!=='recipe')payload.costs=costs;
 return payload;
}
const model={create,components,recipe,name,savedRecipe,replacementChoices,purchase,unitPrice,readiness,missingNormMarkers,canResolveMissingNorm,resolveMissingNorm,buildPayload,money,rubles,consumptionUnit,displayConsumption,setConsumption,effectiveCost,setCostMode,useBaseRecipe,baseCostEditable};
if(typeof module==='object'&&module.exports)module.exports=model;
else window.STARTCafeProductCardModel=model;
})();
