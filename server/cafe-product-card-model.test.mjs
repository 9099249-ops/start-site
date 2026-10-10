import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const M=createRequire(import.meta.url)('../dist/admin/cafe-product-card-model.js');
globalThis.STARTCafeRecipeCost=createRequire(import.meta.url)('../dist/cafe-recipe-cost.js');
const requestId='11111111-1111-4111-8111-111111111111';
function fixture(){
 const item={id:'tea',name:'Классический чай',description:'Чай',priceCents:50000,size:'500 мл',image:'/assets/tea.jpg',categoryId:'tea-cat',station:'bar',sort:3,tags:[],active:true,soldOut:false,restricted:false,yacht:true,blockQuickSale:false,groupIds:['milk'],variants:[{id:'green',name:'Зелёный',priceCents:0,active:true},{id:'black',name:'Чёрный',priceCents:5000,active:true},{id:'old',name:'Архивный',priceCents:0,active:false,soldOut:true}]};
 const snapshot={catalog:{revision:7,items:[item],categories:[{id:'tea-cat',name:'Чай',active:true}],groups:[{id:'milk',name:'Молоко',active:true,options:[{id:'alt',name:'Альтернативное',active:true}]}]},stock:{units:[{id:1,name:'г'},{id:2,name:'шт'}],inventory:[{id:10,name:'Чай',unit_id:1,unit:'г',active:true,current:'2000'},{id:11,name:'Стакан',unit_id:2,unit:'шт',active:true,current:'50'},{id:12,name:'Архивный ингредиент',unit_id:1,unit:'г',active:false,current:'2'}],recipes:[{item_id:'tea',component:'variant:green',revision:3,ingredients:[{id:10,unitId:1,amount:30000}]},{item_id:'tea',component:'option:alt',revision:1,ingredients:[{id:11,unitId:2,amount:1000,replacesId:10}]}]},costRevision:8,pricingRevision:4,costs:[{itemId:'tea',component:'variant:green',portionCents:3500},{itemId:'tea',component:'variant:black',portionCents:null}],purchasePrices:[{inventoryId:10,unitId:1,quantity:'2000',totalCents:100000}]};
 return {item,snapshot,state:M.create(snapshot,item)};
}
test('Card model: an untouched card preserves all variant ids and extras, norms, photo and unknown costs',()=>{
 const {state,item}=fixture(),body=M.buildPayload(state,requestId);
 assert.deepEqual(body.item,item);assert.deepEqual(body.recipes,[]);assert.deepEqual(body.costs,[]);assert.deepEqual(body.purchasePrices,[]);
 assert.equal(M.recipe(state,'variant:green').ingredients[0].amount,'30');assert.equal(state.costs.get('variant:black'),'');
});
test('Card model: opening uses the fresh server item, never overwrites with a stale menu row',()=>{
 const {snapshot,item}=fixture(),old={...item,name:'Старое название'};assert.equal(M.create(snapshot,old).item.name,item.name);
});
test('Card model: every variant draft and every receipt remains independent when editing another variant or uploading a photo',()=>{
 const {state}=fixture();state.item.image='/media/new.png';state.variants.set('new',{id:'new',name:'Улун',price:'25',active:true});
 M.recipe(state,'variant:new').ingredients=[{id:10,amount:'2,5'},{id:11,amount:'1'}];state.costs.set('variant:new','40,20');
 M.purchase(state,10).quantity='1000';M.purchase(state,10).total='700';M.purchase(state,11).quantity='50';M.purchase(state,11).total='100';
 state.costs.set('variant:green','36');const body=M.buildPayload(state,requestId);
 assert.equal(body.item.image,'/media/new.png');assert.equal(body.item.variants.at(-1).id,'new');assert.equal(body.item.variants.at(-1).priceCents,2500);
 assert.deepEqual(body.recipes,[{component:'variant:new',revision:-1,ingredients:[{id:10,amount:'2.5'},{id:11,amount:'1'}]}]);
 assert.deepEqual(body.costs,[{component:'variant:green',portionCents:3600},{component:'variant:new',portionCents:4020}]);assert.equal(body.purchasePrices.length,2);
});
test('Card model: blank financial fields do not clear saved costs or saved prices; explicit zero is valid',()=>{
 const {state}=fixture();state.costs.set('variant:green','');state.costs.set('variant:black','0');M.purchase(state,10).quantity='';M.purchase(state,10).total='';
 const body=M.buildPayload(state,requestId);assert.deepEqual(body.costs,[{component:'variant:black',portionCents:0}]);assert.deepEqual(body.purchasePrices,[]);
 assert.equal(M.unitPrice({quantity:'20',total:''}),null);assert.equal(M.unitPrice({quantity:'20',total:'0'}),0);
});
test('Card model: missing quantity is not silently dropped and points to the exact hidden variant row',()=>{
 const {state}=fixture();M.recipe(state,'variant:black').ingredients=[{id:11,amount:''}];
 assert.throws(()=>M.buildPayload(state,requestId),error=>error.target.component==='variant:black'&&error.target.row===0&&error.target.field==='amount');
});
test('Card model: invalid visible prices and unnamed new variants are rejected without normalizing to zero',()=>{
 const {state}=fixture();state.price='abc';assert.throws(()=>M.buildPayload(state,requestId),error=>error.target.field==='price');state.price='500';
 state.variants.set('new',{id:'new',name:'',price:'0',active:true});assert.throws(()=>M.buildPayload(state,requestId),error=>error.target.id==='new');
});
test('Card model: variant-only and archived replacement ids stay available and unchanged',()=>{
 const {state}=fixture();assert.deepEqual(M.replacementChoices(state,12).map(i=>i.id),[10,12]);assert.deepEqual(M.buildPayload(state,requestId).recipes,[]);
});
test('Card model: replacing an option is explicit; clearing an option is allowed but clearing the entire saved portion is rejected',()=>{
 const {state}=fixture();M.recipe(state,'option:alt').ingredients=[];assert.deepEqual(M.buildPayload(state,requestId).recipes,[{component:'option:alt',revision:1,ingredients:[]}]);
 M.recipe(state,'variant:green').ingredients=[];assert.throws(()=>M.buildPayload(state,requestId),error=>error.target.component==='variant:green');
});
test('Card model: saved procurement units are not silently rebased after an inventory unit change',()=>{
 const {snapshot,item}=fixture();snapshot.stock.inventory[0].unit_id=2;snapshot.stock.inventory[0].unit='шт';const state=M.create(snapshot,item);
 assert.equal(M.purchase(state,10).unitId,1);assert.deepEqual(M.buildPayload(state,requestId).purchasePrices,[]);
 M.purchase(state,10).total='900';assert.equal(M.buildPayload(state,requestId).purchasePrices[0].unitId,1);
});
test('Card model: unknown recipes and costs remain incomplete, never made up from another variant',()=>{
 const {state}=fixture();assert.deepEqual(M.readiness(state,'variant:black'),{recipe:false,cost:false});assert.deepEqual(M.recipe(state,'variant:black').ingredients,[]);
 assert.deepEqual(M.readiness(state,'variant:green'),{recipe:true,cost:true});assert.equal(M.unitPrice({quantity:'2000',total:'1000'}),0.5);
});
test('Card model: legacy variants retain private recipes while explicit shared mode never submits duplicate custom recipes',()=>{
 const {state}=fixture();M.recipe(state,'base').ingredients=[{id:10,amount:'12'}];M.recipe(state,'variant:green').ingredients=[{id:11,amount:'4'}];
 assert.equal(Object.hasOwn(state.variants.get('green'),'useBaseRecipe'),false);
 const unchanged=M.buildPayload(state,requestId);assert.deepEqual(unchanged.recipes,[{component:'base',revision:-1,ingredients:[{id:10,amount:'12'}]},{component:'variant:green',revision:3,ingredients:[{id:11,amount:'4'}]}]);
 M.useBaseRecipe(state,'green',true);const body=M.buildPayload(state,requestId);
 assert.equal(body.item.variants.find(v=>v.id==='green').useBaseRecipe,true);assert.deepEqual(body.recipes,[{component:'base',revision:-1,ingredients:[{id:10,amount:'12'}]}]);
 assert.deepEqual(M.recipe(state,'variant:green').ingredients,[{id:11,amount:'4'}]);
});
test('Card model: an untouched legacy variant keeps its missing shared-recipe flag absent in the saved item',()=>{
 const {state}=fixture(),body=M.buildPayload(state,requestId);
 for(const variant of body.item.variants)assert.equal(Object.hasOwn(variant,'useBaseRecipe'),false);
});
test('Card model: consumption displays and stores exact grams and millilitres without changing purchase units',()=>{
 assert.equal(M.consumptionUnit('л'),'мл');assert.equal(M.displayConsumption('0.25','л'),'250');assert.equal(M.setConsumption('250','л'),'0.25');
 assert.equal(M.displayConsumption('0.07','кг'),'70');assert.equal(M.setConsumption('70','кг'),'0.07');
 assert.equal(M.setConsumption('0.5','л'),null);assert.equal(M.setConsumption('0.5','г'),'0.5');
});
test('Card model: fractional ml draft fails on its row and is never rounded into the request',()=>{
 const {state}=fixture();state.snapshot.stock.inventory.push({id:13,name:'Молоко',unit_id:3,unit:'л',active:true,current:'0.25'});M.recipe(state,'variant:black').ingredients=[{id:13,amount:'1',displayDraft:'2.5'}];
 assert.throws(()=>M.buildPayload(state,requestId),error=>error.target.component==='variant:black'&&error.target.row===0&&error.target.field==='amount');
});
test('Card model: inherited cost is used once, while switching private materializes the shared cost',()=>{
 const {state}=fixture();state.snapshot.stock.recipes.push({item_id:'tea',component:'base',revision:5,ingredients:[{id:10,amount:250}]});
 state.recipes.set('base',{revision:5,ingredients:[{id:10,amount:'0.25'}]});state.costs.set('base','150');state.snapshot.costs.push({itemId:'tea',component:'base',portionCents:15000});
 state.costSources.set('base','own');state.costSources.set('variant:black','base');state.snapshot.costs.find(r=>r.component==='variant:black').portionCents=15000;state.costs.set('variant:black','150');state.variants.get('black').useBaseRecipe=true;
 const inherited=M.buildPayload(state,requestId);assert.deepEqual(inherited.costs,[]);assert.ok(!inherited.recipes.some(r=>r.component==='variant:black'));
 M.recipe(state,'variant:black').revision=7;M.recipe(state,'variant:black').ingredients=[{id:11,amount:'8'}];
 M.useBaseRecipe(state,'black',false);assert.equal(M.recipe(state,'variant:black').revision,7);assert.deepEqual(M.recipe(state,'variant:black').ingredients,[{id:10,amount:'0.25'}]);
 assert.equal(M.effectiveCost(state,'variant:black').source,'own');
 assert.deepEqual(M.buildPayload(state,requestId).costs,[{component:'variant:black',portionCents:15000}]);
});
test('Card model: base cost edits are allowed with active shared variants and do not create duplicate variant costs',()=>{
 const {state}=fixture();state.variants.get('black').useBaseRecipe=true;state.costs.set('base','150');
 const body=M.buildPayload(state,requestId);
 assert.deepEqual(body.costs,[{component:'base',portionCents:15000}]);
 assert.ok(!body.costs.some(row=>row.component==='variant:black'));
});
test('Card model: procurement includes shared base ingredients once and ignores inherited custom recipe rows',()=>{
 const {state}=fixture();state.variants.get('green').useBaseRecipe=true;state.variants.get('black').useBaseRecipe=true;
 state.item.groupIds=[];
 state.recipes.set('base',{revision:2,ingredients:[{id:10,amount:'3'}]});
 M.purchase(state,10).quantity='1000';M.purchase(state,10).total='700';M.purchase(state,11).quantity='50';M.purchase(state,11).total='100';
 const body=M.buildPayload(state,requestId);
 assert.deepEqual(body.purchasePrices,[{inventoryId:10,quantity:'1000',totalCents:70000,unitId:1}]);
 assert.deepEqual(body.recipes,[{component:'base',revision:2,ingredients:[{id:10,amount:'3'}]}]);
});
test('Card model: recipe costs use shared purchase prices and react to receipt edits',()=>{
 const {state}=fixture();M.recipe(state,'variant:green').ingredients=[{id:10,amount:'30'}];M.setCostMode(state,'recipe');
 assert.deepEqual(M.effectiveCost(state,'variant:green'),{value:'15',source:'recipe',own:false,estimated:false,missingPrices:[],missingNorms:[]});
 M.purchase(state,10).total='2000';assert.equal(M.effectiveCost(state,'variant:green').value,'30');
 assert.equal(Object.hasOwn(M.buildPayload(state,requestId),'costs'),false);
});
test('Card model: legacy items stay manual, unknown recipe costs stay blank, and empty add-ons may cost zero',()=>{
 const {state}=fixture();assert.equal(state.costMode,'manual');assert.equal(Object.hasOwn(state.item,'costMode'),false);
 M.setCostMode(state,'recipe');assert.equal(M.effectiveCost(state,'base').value,'');
 assert.equal(M.effectiveCost(state,'base').source,'recipe');
 state.snapshot.catalog.groups[0].options.push({id:'unconfigured',name:'Новый вариант',active:true});
 assert.equal(M.effectiveCost(state,'option:unconfigured').value,'');
 M.recipe(state,'option:alt').ingredients=[];assert.equal(M.effectiveCost(state,'option:alt').value,'0');
 const body=M.buildPayload(state,requestId);assert.equal(body.item.costMode,'recipe');assert.equal(Object.hasOwn(body,'costs'),false);
});
test('Card model: selected variant missing norms invalidate its recipe estimate',()=>{
 const {state}=fixture();M.recipe(state,'variant:green').ingredients=[{id:10,amount:'30'}];
 state.variants.get('green').missingRecipeNorms=['Вес упаковки'];M.setCostMode(state,'recipe');
 const cost=M.effectiveCost(state,'variant:green');assert.equal(cost.value,'');assert.deepEqual(cost.missingNorms,['Вес упаковки']);
});
test('Card model: changed stock units invalidate recipe costs and stale rows block only changed recipe writes',()=>{
 const {state}=fixture(),stock=state.snapshot.stock.inventory[0],saved=M.recipe(state,'variant:green').ingredients[0];
 stock.unit_id=2;stock.unit='шт';
 state.variants.get('green').missingRecipeNorms=['Вес стакана'];
 assert.equal(saved.unitId,1);
 const [missingMarker]=M.missingNormMarkers(state,'variant:green');assert.equal(M.canResolveMissingNorm(state,'variant:green',missingMarker),false);
 M.setCostMode(state,'recipe');
 const effective=M.effectiveCost(state,'variant:green');assert.equal(effective.value,'');assert.ok(effective.missingNorms.includes('Единица нормы изменилась: Чай'));
 state.item.description='Обновлено без изменения состава';assert.deepEqual(M.buildPayload(state,requestId).recipes,[]);
 const recipe=M.recipe(state,'variant:green');recipe.ingredients.push({id:11,unitId:2,amount:'2'});
 assert.throws(()=>M.buildPayload(state,requestId),error=>error.target.component==='variant:green'&&error.target.row===0&&error.target.field==='amount');
 recipe.ingredients[0].amount='5';recipe.ingredients[0].unitId=2;assert.equal(M.canResolveMissingNorm(state,'variant:green',missingMarker),true);
 assert.deepEqual(M.buildPayload(state,requestId).recipes,[{component:'variant:green',revision:3,ingredients:[{id:10,amount:'5'},{id:11,amount:'2'}]}]);
});
test('Card model: empty or invalid quantity drafts hide saved recipe cost and cannot submit the retained amount',()=>{
 const {state}=fixture();M.setCostMode(state,'recipe');const row=M.recipe(state,'variant:green').ingredients[0];
 for(const draft of ['', 'не число']){
  row.displayDraft=draft;
  const effective=M.effectiveCost(state,'variant:green');assert.equal(effective.value,'');assert.ok(effective.missingNorms.includes('Чай'));
  assert.throws(()=>M.buildPayload(state,requestId),error=>error.target.component==='variant:green'&&error.target.field==='amount');
 }
});
test('Card model: missing norms require a nonzero component recipe and resolve only the explicitly selected marker',()=>{
 const {state}=fixture();state.item.missingRecipeNorms=['Общая норма','Сохранить неизвестную'];
 state.variants.get('green').missingRecipeNorms=['Вес упаковки'];
 const variantKey='variant:green',baseMarkers=M.missingNormMarkers(state,'base'),variantMarkers=M.missingNormMarkers(state,variantKey);
 assert.equal(M.canResolveMissingNorm(state,'base',baseMarkers[0]),false);
 M.recipe(state,'base').ingredients=[{id:10,amount:'0'}];assert.equal(M.canResolveMissingNorm(state,'base',baseMarkers[0]),false);
 M.recipe(state,'base').ingredients=[{id:10,amount:'30'}];assert.equal(M.resolveMissingNorm(state,'base',baseMarkers[0]),true);
 assert.deepEqual(state.item.missingRecipeNorms,['Сохранить неизвестную']);
 assert.deepEqual(state.variants.get('green').missingRecipeNorms,['Вес упаковки']);
 M.recipe(state,variantKey).ingredients=[{id:10,amount:'0'}];
 assert.equal(M.canResolveMissingNorm(state,variantKey,variantMarkers[0]),false);
 M.recipe(state,variantKey).ingredients=[{id:10,amount:'30'}];
 assert.equal(M.resolveMissingNorm(state,variantKey,variantMarkers[0]),true);
 assert.deepEqual(state.variants.get('green').missingRecipeNorms,[]);
 assert.deepEqual(state.item.missingRecipeNorms,['Сохранить неизвестную']);
 const body=M.buildPayload(state,requestId);
 assert.deepEqual(body.item.missingRecipeNorms,['Сохранить неизвестную']);
 assert.deepEqual(body.item.variants.find(v=>v.id==='green').missingRecipeNorms,[]);
});
test('Card model: named marker leaf cannot clear when recipe contains only another row',()=>{
 const {state}=fixture();state.variants.get('green').missingRecipeNorms=['Чай'];
 const [marker]=M.missingNormMarkers(state,'variant:green');
 M.recipe(state,'variant:green').ingredients=[{id:11,unitId:2,amount:'1'}];
 assert.equal(M.canResolveMissingNorm(state,'variant:green',marker),false);
});
test('Card model: named marker leaf clears once its norm exists and stock count is known',()=>{
 const {state}=fixture();state.variants.get('green').missingRecipeNorms=['  ЧАЙ  '];state.snapshot.stock.inventory[0].current_milli=0;
 const [marker]=M.missingNormMarkers(state,'variant:green');
 M.recipe(state,'variant:green').ingredients=[{id:10,unitId:1,amount:'30'}];
 assert.equal(M.canResolveMissingNorm(state,'variant:green',marker),true);
 assert.equal(M.resolveMissingNorm(state,'variant:green',marker),true);
});
test('Card model: exact named marker cannot clear when stock count is unknown even with a norm',()=>{
 const {state}=fixture();state.variants.get('green').missingRecipeNorms=['Чай'];state.snapshot.stock.inventory[0].current_milli=null;
 const [marker]=M.missingNormMarkers(state,'variant:green');
 M.recipe(state,'variant:green').ingredients=[{id:10,unitId:1,amount:'30'}];
 assert.equal(M.canResolveMissingNorm(state,'variant:green',marker),false);
 assert.equal(M.resolveMissingNorm(state,'variant:green',marker),false);
});
test('Card model: resolving the last product-level norm serializes an explicit empty array without changing variant markers',()=>{
 const {state}=fixture();state.item.missingRecipeNorms=['Вес стакана'];state.variants.get('green').missingRecipeNorms=['Вес упаковки'];
 M.recipe(state,'base').ingredients=[{id:10,amount:'25'}];
 const [marker]=M.missingNormMarkers(state,'base');assert.equal(M.resolveMissingNorm(state,'base',marker),true);
 const body=M.buildPayload(state,requestId);
 assert.deepEqual(body.item.missingRecipeNorms,[]);
 assert.deepEqual(body.item.variants.find(v=>v.id==='green').missingRecipeNorms,['Вес упаковки']);
});
test('Card model: quote estimates are labeled, become actual on receipt edit, and materialize when switching to manual',()=>{
 const {state}=fixture();M.recipe(state,'variant:green').ingredients=[{id:10,amount:'30'}];
 const purchase=M.purchase(state,10);purchase.estimated=true;purchase.sourceUrl='https://prices.example/tea';purchase.sourceLabel='Прайс поставщика';
 M.setCostMode(state,'recipe');assert.equal(M.effectiveCost(state,'variant:green').estimated,true);
 purchase.estimated=false;delete purchase.sourceUrl;delete purchase.sourceLabel;
 assert.equal(M.effectiveCost(state,'variant:green').estimated,false);
 M.setCostMode(state,'manual');const body=M.buildPayload(state,requestId);
 assert.ok(body.costs.some(row=>row.component==='variant:green'&&row.portionCents===1500));
 assert.equal(body.item.costMode,'manual');
});
test('Card model: recipe to manual skips an ineligible shared base cost',()=>{
 const {state}=fixture();state.recipes.set('base',{revision:2,ingredients:[{id:10,amount:'10'}]});
 state.snapshot.stock.recipes.push({item_id:'tea',component:'base',revision:2,ingredients:[{id:10,unitId:1,amount:10000}]});
 M.setCostMode(state,'recipe');assert.equal(M.effectiveCost(state,'base').value,'5');
 assert.equal(M.baseCostEditable(state),false);M.setCostMode(state,'manual');
 assert.equal(state.forceCosts.has('base'),false);
 assert.ok(!M.buildPayload(state,requestId).costs.some(row=>row.component==='base'));
});
