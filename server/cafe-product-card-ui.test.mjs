import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const M=createRequire(import.meta.url)('../dist/admin/cafe-product-card-model.js');
const source=readFileSync(new URL('../dist/admin/cafe-product-card.js',import.meta.url),'utf8');
const model=readFileSync(new URL('../dist/admin/cafe-product-card-model.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../dist/admin/cafe.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/admin/cafe-product-card.css',import.meta.url),'utf8');

test('Reference card loads its model and stylesheet before the controller and cafe editor',()=>{
 assert.ok(html.indexOf('cafe-product-card-model.js')<html.indexOf('cafe-product-card.js'));
 assert.ok(html.indexOf('cafe-recipe-cost.js')<html.indexOf('cafe-product-card-model.js'));
 assert.ok(html.indexOf('cafe-product-card.js')<html.indexOf('cafe-stop-list.js'));
 assert.ok(html.indexOf('cafe-stop-list.js')<html.indexOf('/admin/cafe.js'));
 assert.ok(html.indexOf('cafe-stop-list.css')<html.indexOf('cafe-product-card.css'));
 const version=html.match(/cafe-product-card\.js\?v=(unified-product-card-\d+)/)?.[1];
 assert.equal(version,'unified-product-card-16');
 assert.ok(version);assert.ok(html.includes('cafe-product-card.css?v='+version));assert.ok(html.includes('cafe-product-card-model.js?v='+version));
 assert.match(html,/<button type="button" id="open-stop-list">Блюда в стопе<\/button>/);
});
test('Card presents compact variant and ingredient tables, not repeated forms or a technical component selector',()=>{
 assert.match(source,/'pc-variant-table'/);assert.match(source,/'pc-recipe-table'/);
 for(const heading of ['Название','Доплата, ₽','Себестоимость, ₽','В меню','Ингредиент / расходник','Единица','Расход на порцию','Остаток'])assert.ok(source.includes(heading),heading);
 assert.doesNotMatch(source,/Поиск компонента|Поиск ингредиента|Выбранный компонент|confirm\(/);
 assert.match(source,/rowMenu\(row,/);assert.match(source,/rowMenu\(tr,/);assert.match(source,/Общий состав и добавки/);
 assert.doesNotMatch(source,/innerHTML/);
});
test('One selected procurement form shares unit prices without converting existing inventory units',()=>{
 assert.match(source,/Позиция из закупочного чека/);assert.match(source,/Куплено, /);assert.match(source,/Сумма по чеку, ₽/);
 assert.match(source,/M\.purchase\(data,stock\.id\)/);assert.match(source,/M\.unitPrice\(purchase\)/);
 assert.match(source,/Количество автоматически не пересчитывается/);assert.match(source,/permanentDisabled/);
 assert.match(model,/saved\.unitId!==Number\(row\.unitId\)/);
});
test('Recipe cost mode uses the shared calculator, preserves receipt focus, and labels estimates and missing inputs',()=>{
 assert.match(source,/Считать себестоимость по составу/);assert.match(source,/M\.setCostMode\(data,enabled\?'recipe':'manual'\)/);
 assert.match(source,/purchase\.estimated=false/);assert.match(source,/delete purchase\.sourceUrl/);assert.match(source,/delete purchase\.sourceLabel/);
 assert.match(source,/Ориентировочная/);assert.match(source,/Нет цены:/);assert.match(source,/Нет нормы:/);
 assert.match(model,/STARTCafeRecipeCost\?\.calculateRecipeCost/);assert.match(model,/quantityMilli:Number\(quantity\)/);
 assert.match(model,/state\.costMode==='recipe'\?'':state\.costs\.get\(key\)/);
});
test('Opening receipt pricing preserves saved quote metadata until the operator edits an amount',()=>{
 assert.match(source,/const updatePrice=\(edited=false\)=>\{/);
 assert.match(source,/if\(stock&&edited\)\{purchase\.estimated=false;delete purchase\.sourceUrl;delete purchase\.sourceLabel;\}/);
 assert.match(source,/quantity\.addEventListener\('input',\(\)=>updatePrice\(true\)\);total\.addEventListener\('input',\(\)=>updatePrice\(true\)\);updatePrice\(false\)/);
});
test('Shared variant composition is explicit, read-only while inherited, and private mode clones the base',()=>{
 assert.match(source,/Использовать общий состав/);assert.match(source,/Изменить общий состав/);
 assert.match(source,/dataset\.permanentDisabled=String\(inherited\)/);assert.match(source,/M\.useBaseRecipe\(data,variant\.id,value\)/);
 assert.match(source,/useBaseRecipe:true/);assert.match(model,/if\(!inherited\)\{[\s\S]*?savedRecipe\(state,key\)/);
 assert.match(model,/function baseCostEditable\(state\)/);assert.match(source,/!M\.baseCostEditable\(data\)/);
});
test('Card honors only a valid initial component after loading its snapshot',()=>{
 assert.match(source,/M\.components\(state\.data\)\.includes\(callbacks\.initialComponent\)\?callbacks\.initialComponent:defaultComponent/);
});
test('Composition markers are resolved explicitly per label only after a nonzero effective component recipe exists',()=>{
 assert.match(source,/Неуточнённые нормы:/);assert.match(source,/Норма заполнена/);
 assert.match(source,/M\.missingNormMarkers\(data,key\)/);assert.match(source,/M\.canResolveMissingNorm\(data,key,marker\)/);
 assert.match(source,/M\.resolveMissingNorm\(data,key,marker\)/);
 assert.match(source,/action\.button\.disabled=!M\.canResolveMissingNorm\(data,key,action\.marker\)/);
 assert.match(model,/function missingNormMarkers\(state,key\)/);assert.match(model,/function canResolveMissingNorm\(state,key,marker\)/);
 assert.match(model,/value!==null&&value>0n/);assert.match(model,/list\.splice\(marker\.index,1\)/);
 assert.match(model,/scope:'item'/);assert.match(model,/scope:'variant'/);
});
test('Changed recipe units show the saved old quantity, require current-unit re-entry, and SKU changes clear the amount',()=>{
 assert.match(model,/unitId:i\.unitId/);assert.match(model,/savedUnitId!==Number\(stock\.unit_id\)/);
 assert.match(model,/Единица нормы изменилась:/);assert.match(model,/единица складского товара изменилась/);
 assert.match(source,/quantity\.value=unitMismatch\?'':/);assert.match(source,/Сохранённое значение:/);
 assert.match(source,/Укажите расход заново в '\+shownUnit/);assert.match(source,/row\.amount='';row\.unitId=selected\?\.unit_id/);
 assert.match(source,/row\.unitId=Number\(stock\.unit_id\)/);
});
test('Editing a recipe amount refreshes cost and variant previews in place without replacing the focused field',()=>{
 assert.match(source,/function refreshRecipeCostView\(\)/);assert.match(source,/finance\.querySelector\('\[data-field="cost"\]'\)/);
 assert.match(source,/refreshRecipeCostView\(\);\}\);quantity\.disabled=inherited/);
 assert.match(source,/updateVariantRows\(\);updateCompleteness\(\);/);
 assert.match(model,/entry\.displayDraft!==undefined\)\{const draft=setConsumption\(entry\.displayDraft,stock\?\.unit\);if\(draft===null\|\|decimalMilli\(draft\)<=0n\)/);
});
test('Изменить общий состав opens the base without making the variant private or disabling its base cost',()=>{
 const action=source.match(/const edit=button\('Изменить общий состав',\(\)=>selectComponent\('base'\)\);/)?.[0];assert.ok(action);
 const state={component:'variant:new'},variant={active:true,useBaseRecipe:true};
 const context={state,selectComponent:key=>{state.component=key;}};
 const edit=runInNewContext(`(()=>{let control;const button=(label,onClick)=>control={label,onClick};${action};return control;})()`,context);
 edit.onClick();assert.equal(state.component,'base');assert.equal(variant.useBaseRecipe,true);
 assert.equal(M.baseCostEditable({variants:new Map([['new',variant]])}),true);
 assert.doesNotMatch(action,/useBaseRecipe|dirty\(/);
});
test('Turning shared mode off confirms before replacing a different own recipe and cancellation stays clean',()=>{
 const toggleBlock=source.match(/const toggle=check\(composition,'Использовать общий состав',inherited,value=>\{[\s\S]*?\n   \}\);/)?.[0];assert.ok(toggleBlock);
 const variant={id:'new',active:true,useBaseRecipe:true},own={revision:4,ingredients:[{id:11,amount:'100'}]},base={revision:2,ingredients:[{id:10,amount:'2'}]};
 const data={recipes:new Map([['variant:new',own],['base',base]])},state={dirty:false},captured={};
 const context={composition:{},inherited:true,variant,data,state,callback:null,toggleNode:{checked:true,dataset:{}},
  check(host,label,value,onChange){context.callback=onChange;return context.toggleNode;},
  M:{recipe:(model,key)=>model.recipes.get(key),useBaseRecipe(model,id,enabled){variant.useBaseRecipe=enabled;own.ingredients=base.ingredients.map(row=>({...row}));}},
  confirmInCard(message,accept,label){captured.message=message;captured.accept=accept;captured.label=label;},dirty(){state.dirty=true;},renderComposition(){},renderFinance(){},updateVariantRows(){}};
 runInNewContext(`(()=>{const toggle=check(composition,'Использовать общий состав',inherited,value=>{${toggleBlock.match(/value=>\{([\s\S]*)\n   \}\);$/)?.[1]}});toggle.dataset.commonRecipeToggle=variant.id;callback(false);})()`,context);
 assert.equal(context.toggleNode.checked,true);assert.equal(state.dirty,false);assert.equal(variant.useBaseRecipe,true);
 assert.deepEqual(own.ingredients,[{id:11,amount:'100'}]);assert.match(captured.message,/Создать собственный состав на основе общего\?/);assert.equal(captured.label,'Создать собственный состав');
 captured.accept();assert.equal(variant.useBaseRecipe,false);assert.deepEqual(own.ingredients,base.ingredients);assert.equal(state.dirty,true);
});
test('Consumption units are converted only for recipe rows, with native-unit balance labels and inherited cost display',()=>{
 assert.match(source,/M\.displayConsumption\(row\.amount,nativeUnit\)/);assert.match(source,/M\.consumptionUnit\(nativeUnit\)/);
 assert.match(source,/shownBalance\+' '\+shownUnit/);assert.match(source,/Общая себестоимость, ₽/);
 assert.match(source,/effective\.source==='base'/);assert.match(model,/displayConsumption/);assert.match(model,/setConsumption/);
});
test('Draft protection only blocks leaving real edits or an uncertain save, and is removed on close',()=>{
 const definition=source.split(/\r?\n/).find(line=>line.trim().startsWith('function protectDraft('));assert.ok(definition);
 for(const flags of [{dirty:false,busy:false,uncertain:false},{dirty:true},{busy:true},{uncertain:true}]){
  let blocked=false;const handler=runInNewContext('('+definition.trim()+')',{state:flags});handler({preventDefault(){blocked=true;}});
  assert.equal(blocked,Boolean(flags.dirty||flags.busy||flags.uncertain));
 }
 assert.match(source,/removeEventListener\('beforeunload',protectDraft\)/);
 assert.match(source,/confirmInCard\(/);
});
test('The exact request is locked for a network or server uncertainty; conflicts need an explicit reload',()=>{
 assert.match(source,/state\.retryBody=M\.buildPayload/);assert.match(source,/JSON\.stringify\(state\.retryBody\)/);
 assert.match(source,/response\.status>=500/);assert.match(source,/response\.status===409/);
 assert.match(source,/state\.busy\|\|state\.uploading\|\|state\.uncertain\|\|state\.conflict/);
 assert.match(source,/Загрузить актуальные настройки/);
});
test('Photo changes re-render only the basics; variant, recipe and procurement drafts remain in the model',()=>{
 assert.match(source,/state\.data\.item\.image=data\.url;dirty\(\);renderBasics\(\)/);
 assert.match(source,/image\/jpeg,image\/png,image\/webp/);assert.match(source,/8\*1024\*1024/);
 assert.match(source,/fetch\('\/api\/admin\/content-upload'/);
 assert.match(model,/quantity:row\.quantity,total:rubles\(row\.totalCents\),unitId:row\.unitId/);
});
test('Window layout uses bounded tables, one-third basics and two-thirds work area, and a mobile layout',()=>{
 assert.match(css,/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*2fr\)/);
 assert.match(css,/max-height:\s*184px/);assert.match(css,/@media\s*\(max-width:\s*760px\)/);
 assert.match(css,/\.pc-footer/);assert.match(css,/\.pc-primary/);assert.match(css,/#1673ef/);
 assert.match(source,/setAttribute\('width',width\)/);assert.doesNotMatch(source,/col\.style\.width/);
});

test('Product card is top-aligned and reserves bottom space for its pinned actions',()=>{
 assert.match(css,/position:\s*fixed;\s*inset:\s*4px 0 auto;\s*margin:\s*0 auto/);
 assert.match(css,/height:\s*min\(948px,\s*calc\(100dvh - 48px\)\)/);
 assert.match(css,/inset:\s*0 0 auto/);
 assert.match(css,/100dvh - 16px - env\(safe-area-inset-bottom, 0px\)/);
 assert.match(css,/grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto auto/);
});
