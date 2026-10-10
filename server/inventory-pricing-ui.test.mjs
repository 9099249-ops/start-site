import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../dist/admin/purchase.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../dist/admin/purchase.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/admin/purchase.css',import.meta.url),'utf8');
function extracted(name,next){const start=source.indexOf('function '+name+'('),end=source.indexOf('\n function '+next+'(',start);return start<0||end<0?null:source.slice(start,end);}

test('Purchase estimate counter uses server summary until filters narrow the visible buy rows',()=>{
 const format=source.match(/function formatCents\(cents\)\{[^\n]+/)[0];
 const summary=extracted('purchaseSummaryText','render');assert.ok(summary);
 const context={};vm.createContext(context);vm.runInContext(format+'\n'+summary,context);
 assert.equal(context.purchaseSummaryText([], {knownEstimateCents:12345,pricedCount:2,incompleteCount:1,totalCount:3},false),'≈123,45 ₽ · +1 поз. без расчёта');
 assert.equal(context.purchaseSummaryText([], {knownEstimateCents:0,pricedCount:0,incompleteCount:2,totalCount:2},false),'Сумма не рассчитана · +2 поз. без расчёта');
 assert.equal(context.purchaseSummaryText([{purchaseEstimateCents:1000},{purchaseEstimateCents:null},{purchaseEstimateCents:0}],{knownEstimateCents:999999,pricedCount:9,incompleteCount:0,totalCount:9},true),'≈10,00 ₽ · +1 поз. без расчёта');
});

test('All products shows unit price state and opens a compact authorized price editor',()=>{
 assert.match(source,/if\(catalog\.canEditPricing&&i\.active\)priceLine\.append\(button\('Цена',\(\)=>editPrice\(i\)/);
 assert.match(source,/Цена не задана/);assert.match(source,/Цена сохранена для другой единицы/);
 assert.match(source,/Ориентир · /);assert.match(source,/formatCents\(i\.unitPriceCents\)/);
 assert.match(html,/id="buy-estimate"/);assert.match(html,/id="price-dialog"/);
 for(const field of ['quantity','total','unitId'])assert.match(html,new RegExp(`name="${field}"`));
 assert.match(html,/Обновить цены, оставить ввод/);
});

test('Price save distinguishes unchanged estimates from edited actual receipts and sends the global revision',()=>{
 assert.match(source,/keepEstimate=original\.estimated&&unchanged/);
 assert.match(source,/estimated:keepEstimate/);
 assert.match(source,/pricingRevision:priceDraft\.pricingRevision,inventoryId:priceDraft\.itemId,unitId,quantity,totalCents/);
 assert.match(source,/fetch\('\/api\/admin\/inventory\/prices'/);
 assert.match(source,/priceDraft\.retryBody=body/);
 assert.match(source,/body:JSON\.stringify\(body\)/);
 assert.match(source,/if\(response\.status===409\)[\s\S]*?priceDraft\.conflict=true/);
 assert.match(source,/priceDraft\.pricingRevision=catalog\.pricingRevision/);
 assert.match(source,/priceDraft\.requestId=crypto\.randomUUID\(\)/);
 assert.match(source,/priceDraft=null;\$\('#price-dialog'\)\.close\(\);try\{await reloadCatalog\(\)/);
 assert.match(source,/input\.disabled=priceBusy\|\|uncertain/);
});

test('Price amount parser accepts actual zero and rejects empty, malformed, and out-of-range totals',()=>{
 const parser=source.match(/function priceCents\(value\)\{[^\n]+/)[0],context={};vm.createContext(context);vm.runInContext(parser,context);
 assert.equal(context.priceCents('0'),0);assert.equal(context.priceCents('12,3'),1230);
 assert.equal(context.priceCents(''),null);assert.equal(context.priceCents('4.567'),null);
 assert.match(source,/totalCents>100000000/);assert.match(source,/Сумма может быть 0/);
});

test('Price unit mismatch requires an explicit unit choice without changing entered quantities',()=>{
 assert.match(source,/select\.value=String\(ids\.includes\(Number\(selected\)\)\?Number\(selected\):item\.purchasePrice\?\.unitId\|\|item\.unit_id\)/);
 assert.match(source,/Количество и сумму не пересчитываем/);
 assert.match(source,/if\(unitId!==Number\(priceDraft\.item\.unit_id\)\)/);
});

test('Existing stock movement remains intact; purchase page versions its updated script and stays responsive',()=>{
 assert.match(source,/move\(i,'PURCHASE'\)/);assert.match(source,/\$\('#move-form'\)\.onsubmit=/);
 assert.match(html,/purchase\.js\?v=purchase-filters-20261008-1/);
 assert.match(css,/@media\(max-width:420px\)/);assert.match(css,/\.stock-price/);assert.match(css,/\.price-fields/);
});
