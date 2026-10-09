import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../dist/admin/financial-analytics.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../dist/admin/operations-analytics.js',import.meta.url),'utf8');
const expensesSource=readFileSync(new URL('../dist/admin/finance-expenses.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/admin/operations-analytics.css',import.meta.url),'utf8');

class Element {
 constructor(id=''){this.id=id;this.dataset={};this.style={};this.attributes={};this.children=[];this.options=[];this.handlers={};this.classList={add(){},remove(){},toggle(){}};this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.innerHTML='';}
 addEventListener(name,fn){this.handlers[name]=fn;}
 setAttribute(name,value){this.attributes[name]=value;}
 getAttribute(name){return this.attributes[name]||null;}
 append(...nodes){this.children.push(...nodes);for(const node of nodes)if(node?.tagName==='option')this.options.push(node);}
 replaceChildren(...nodes){this.children=[];this.options=[];this.append(...nodes);}
 click(){this.handlers.click?.({});}
 closest(){return null;}
}

const makeRow=(key,name,extra={})=>({key,name,unknown:false,rentalsCount:2,unitMinutes:120,revenueCents:10000,refundCents:500,costCents:2500,electricityCents:300,electricityIncluded:false,otherDirectCostCents:100,feesCents:200,wagesCents:1000,rentalOverheadCents:300,sharedOverheadCents:400,directOverheadCents:100,overheadCents:800,netCents:4500,complete:true,estimated:true,paymentReceiptsCents:10500,paymentRefundsCents:500,paymentCashCents:4000,paymentCardCents:6000,paymentUnknownCents:500,...extra});

async function boot(rows,unallocated={wagesCents:700,rentalOverheadCents:800,sharedOverheadCents:900}){
 const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,new Element(id)]));
 elements.get('operations-analytics').dataset.scope='financial';
 const tabs=[...html.matchAll(/<button([^>]*)data-tab="([^"]+)"[^>]*>/g)].map(([,attributes,tab])=>{const element=new Element();element.dataset.tab=tab;const panel=attributes.match(/aria-controls="([^"]+)"/);if(panel)element.setAttribute('aria-controls',panel[1]);return element;});
 const document={getElementById:id=>elements.get(id)||null,createElement:()=>new Element(),createTextNode:text=>({textContent:text}),querySelectorAll(selector){if(selector==='.oa-tabs [role=tab]'||selector==='[data-tab]')return tabs;if(selector==='[data-preset]'||selector==='[data-trend-mode]'||selector==='[data-metric]')return [];return [];}};
 let csv='';
 const report={period:{from:'2026-10-01',to:'2026-10-07',days:7,timezone:'Europe/Moscow'},warnings:[],cafe:{items:[],buckets:[],totals:{}},rental:{items:[],buckets:[],totals:{}},finance:{profit:{},cashFlow:{},catamarans:{rows,allocationBasis:'gross-revenue',unallocated,warnings:['Распределение предварительное']}}};
 const context={window:{},document,fetch:async()=>({ok:true,status:200,json:async()=>report}),Intl,Date,Number,String,Math,Map,URL:{createObjectURL:()=>'',revokeObjectURL(){}},Blob:class{constructor(parts){csv=String(parts[0]);}},setTimeout,Option:class{constructor(text,value){this.tagName='option';this.text=text;this.value=value;}},CSS:{escape:value=>value},crypto:{randomUUID:()=> 'test-id'}};
 runInNewContext(source,context);
 await new Promise(resolve=>setImmediate(resolve));
 return {elements,tabs,getCsv:()=>csv};
}

test('finance page provides a separate catamaran tab and documents allocation rules',()=>{
 assert.match(html,/data-tab="catamarans">Катамараны</);
 assert.match(html,/id="panel-catamarans"/);
 assert.match(html,/<details class="oa-catamaran-disclosure"><summary>Как рассчитано<\/summary>/);
 assert.match(html,/Зарплата распределяется по валовой выручке до возвратов между всеми видами проката/);
 assert.match(html,/Адресный расход относится только к выбранному катамарану/);
 assert.match(html,/operations-analytics\.js\?v=catamaran-finance-ui-20261010-3/);
 assert.match(html,/operations-analytics\.css\?v=catamaran-finance-ui-20261010-2/);
 assert.match(html,/finance-expenses\.js\?v=finance-expenses-catamaran-20261010-3/);
 assert.match(html,/id="fe-catamaran-wrap"[^>]*hidden[^>]*>Катамаран<select name="catamaranLabel"/);
 assert.match(css,/oa-catamaran-table\{min-width:760px/);
 assert.match(html,/Расчётный результат<\/th><th>Выручка после возвратов<\/th><th>Себестоимость и комиссии<\/th><th>Зарплата<\/th><th>Накладные \/ адресные<\/th><th>Аренды<\/th><th>Часы × ед\.<\/th>/);
});

test('catamaran report keeps an eight-column summary and shows selected boat detail with unknowns intact',async()=>{
 const page=await boot([makeRow('unknown','Катамаран не указан',{unknown:true}),makeRow('catamaran-a','Сашин',{electricityIncludedPartly:true}),makeRow('catamaran-b','Наташин',{electricityIncluded:true,electricityCents:null,netCents:null,complete:false,estimated:true})]);
 const select=page.elements.get('oa-catamaran-filter'),body=page.elements.get('oa-catamaran-rows');
 assert.deepEqual(select.options.map(option=>option.value),['','catamaran-a','catamaran-b','unknown']);
 assert.equal(body.children.length,3);
 assert.ok(body.children.every(row=>row.children.length===8));
 assert.equal(body.children[0].children[1].textContent,'+45,00 ₽');
 assert.equal(body.children[0].children[2].textContent,'100,00 ₽');
 assert.equal(body.children[0].children[3].textContent,'27,00 ₽');
 assert.equal(body.children[0].children[5].textContent,'8,00 ₽');
 assert.equal(body.children[2].children[0].textContent,'Катамаран не указан');
 const detail=page.elements.get('oa-catamaran-detail');
 assert.equal(detail.children[0].textContent,'Сашин');
 assert.equal(detail.children[2].children[0].children[1].textContent,'100,00 ₽');
 assert.equal(detail.children[3].textContent,'Структура затрат');
 assert.equal(detail.children[4].children[0].children[1].textContent,'3,00 ₽');
 assert.equal(detail.children[4].children[0].children[2].textContent,'Часть уже включена в себестоимость');
 assert.deepEqual(detail.children[4].children.map(item=>item.children[0].textContent),['Электричество','Прочая себестоимость','Комиссии','Зарплата','Адресные расходы','Расходы проката','Общие расходы']);
 assert.equal(page.elements.get('oa-catamaran-payments').children.length,6);
 const pools=page.elements.get('oa-catamaran-unallocated');
 assert.equal(pools.children.length,3);
 select.value='catamaran-b';select.handlers.change();
 assert.equal(page.elements.get('oa-catamaran-detail').children[0].textContent,'Наташин');
 assert.equal(page.elements.get('oa-catamaran-detail').children[1].children[0].textContent,'Нет данных');
 assert.equal(page.elements.get('oa-catamaran-detail').children[4].children[0].children[1].textContent,'В себестоимости');
 assert.equal(pools.children.length,3);
 assert.equal(page.elements.get('oa-catamaran-warnings').children[0].textContent,'Распределение предварительное');
});

test('catamaran selector filters its rows and active tab exports selected boat with unallocated totals',async()=>{
 const page=await boot([makeRow('catamaran-a','Сашин'),makeRow('catamaran-b','Наташин')]);
 const select=page.elements.get('oa-catamaran-filter');select.value='catamaran-b';select.handlers.change();
 assert.equal(page.elements.get('oa-catamaran-rows').children.length,2);
 assert.equal(page.elements.get('oa-catamaran-rows').children[0].dataset.catamaran,'catamaran-a');
 assert.equal(page.elements.get('oa-catamaran-detail').children[0].textContent,'Наташин');
 const tab=page.tabs.find(button=>button.dataset.tab==='catamarans');tab.click();
 page.elements.get('oa-export').click();
 const csv=page.getCsv();
 assert.match(csv,/Наташин/);assert.doesNotMatch(csv,/Сашин/);
 assert.match(csv,/Не распределено: зарплата/);
 assert.match(csv,/Не распределено: расходы проката/);
 assert.match(csv,/Не распределено: общие расходы/);
 assert.match(csv,/Предварительный/);
 assert.match(csv,/Часть электричества включена в себестоимость/);
 assert.match(csv,/Прочая себестоимость, коп\./);
 assert.match(csv,/Адресные расходы, коп\./);
 assert.doesNotMatch(csv,/Прямой ремонт/);
});

test('catamaran summary rows select the detail by mouse or keyboard and zero unallocated pools stay hidden',async()=>{
 const page=await boot([makeRow('catamaran-a','Сашин'),makeRow('catamaran-b','Наташин')],{wagesCents:0,rentalOverheadCents:0,sharedOverheadCents:0});
 const rows=page.elements.get('oa-catamaran-rows').children,select=page.elements.get('oa-catamaran-filter');
 assert.equal(page.elements.get('oa-catamaran-unallocated').hidden,true);
 rows[1].click();assert.equal(select.value,'catamaran-b');
 rows[0].handlers.keydown({key:'Enter',preventDefault(){}});assert.equal(select.value,'catamaran-a');
});

test('financial rendering remains guarded when shared analytics runs in operations scope',async()=>{
 assert.match(source,/function renderCatamarans\(\)\{if\(state\.scope!==\'financial\'\)return/);
 assert.match(source,/operations-analytics-expenses-open/);
});

test('rental expense editor loads catalog labels and preserves omitted versus cleared assignment',()=>{
 assert.match(expensesSource,/catalog\?\.catamaranLabels\|\|\[\]/);
 assert.match(expensesSource,/function copyNextMonth\(item\)[\s\S]*?setForm\(\{\.\.\.item/);
 assert.match(expensesSource,/catamaranOriginal=Object\.prototype\.hasOwnProperty\.call\(entry,'catamaranLabel'\)/);
 assert.match(expensesSource,/catamaranOriginal,catamaranTouched/);
 assert.match(expensesSource,/if\(department!==\'rental\'\)entry\.catamaranLabel=null;else if\(catamaranTouched\|\|!entry\.id\|\|catamaranOriginal!==\'__omitted__\'\)entry\.catamaranLabel=form\.elements\.catamaranLabel\.value\|\|null/);
 assert.match(expensesSource,/form\.elements\.catamaranLabel\.addEventListener\('change'/);
});
