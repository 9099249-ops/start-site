import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const stop=readFileSync(new URL('../dist/admin/cafe-stop-list.js',import.meta.url),'utf8');
const stopCss=readFileSync(new URL('../dist/admin/cafe-stop-list.css',import.meta.url),'utf8');
const groups=readFileSync(new URL('../dist/admin/cafe-menu-groups.js',import.meta.url),'utf8');
const cafe=readFileSync(new URL('../dist/cafe.js',import.meta.url),'utf8');

test('Stop list stays staff scoped, uses safe text, and exposes both rail and toolbar entry points',()=>{
 assert.match(stop,/if\(!document\.body\.classList\.contains\('cafe-integrated'\)\)return/);
 assert.match(stop,/window\.STARTCafeStopList=\{open,attachButton\}/);
 assert.match(stop,/querySelector\('#open-stop-list'\)/);
 assert.match(groups,/window\.STARTCafeStopList&&document\.body\.classList\.contains\('cafe-integrated'\)/);
 assert.match(groups,/links\.splice\(hookah<0\?links\.length:hookah\+1,0,stop\)/);
 assert.match(stop,/textContent=/);assert.doesNotMatch(stop,/innerHTML/);
 assert.match(stopCss,/\.cafe-stop-list-nav/);assert.match(stopCss,/@media\(max-width:700px\)/);
});

test('Resume is limited to canResume and preserves one request id through uncertain retries',()=>{
 assert.match(stop,/if\(item\.canResume\)/);
 assert.match(stop,/action:'resume'/);
 assert.match(stop,/control\.onclick=\(\)=>submitResume\(itemId,payload,control\)/);
 assert.match(stop,/await request\('\/api\/admin\/cafe\/stop-list',payload\);loading=false;await finishResume\(itemId\)/);
 assert.match(stop,/refreshed=await request\('\/api\/admin\/cafe\/stop-list'\)/);
 assert.match(stop,/if\(!item\|\|item\.canOrder\)\{render\(\);await orderProduct\(\{id:itemId\}\);return;\}/);
 assert.match(stop,/Стоп остался: '\+\(reasons\.join\(' · '\)\|\|'доступность всё ещё заблокирована'\)/);
 assert.match(stop,/error\.status===409/);
 assert.match(stop,/revision:data\.revision,itemId:item\.id,action:'resume'/);
});

test('Parent stock reasons represented on variants appear once with their variant labels',()=>{
 const definition=stop.split(/\r?\n/).find(line=>line.trim().startsWith('function detailFor('));assert.ok(definition);
 const detail=runInNewContext('('+definition.trim().replace(/^function detailFor/,'function')+')');
 const shared={code:'STOCK_SHORT',message:'Не хватает остатка',inventoryId:119},rows=detail({reasons:[shared],variants:[{name:'Большая',reasons:[shared]},{name:'Малая',reasons:[{...shared,inventoryId:120}]}]});
 assert.equal(rows.length,2);assert.deepEqual(Array.from(rows,row=>row.variant),['Большая','Малая']);
});

test('Dead-end availability reasons offer product settings only when recipe repair is absent',()=>{
 for(const code of ['NO_ACTIVE_VARIANT','HIDDEN_ITEM','HIDDEN_CATEGORY','MODIFIER_UNAVAILABLE'])assert.ok(stop.includes("'"+code+"'"),code);
 assert.match(stop,/if\(!hasRecipeFix&&allReasons\.some\(reason=>settingsCodes\.has\(reason\.code\)\)\)/);
 assert.match(stop,/configure\.onclick=\(\)=>openCard\(item\)/);
 assert.match(stop,/const hasRecipeFix=!item\.canResume&&allReasons\.some/);
});

test('Piece normalization requires an explicit unchecked confirmation and an entered whole count',()=>{
 assert.match(stop,/confirm\.checked=false/);
 assert.match(stop,/Подтверждаю: числа в нормах означают количество отдельных крышек, стаканов и других предметов, а не целых упаковок/);
 assert.match(stop,/!input\.value\.trim\(\)\|\|!\/\^\\d\+\$\//);
 assert.match(stop,/confirmPieceNorms:true/);
 assert.match(stop,/revision:reason\.inventoryRevision/);
 assert.match(stop,/requestId:crypto\.randomUUID\(\),inventoryId:reason\.inventoryId/);
 assert.match(stop,/\/api\/admin\/cafe\/stock-units/);
 assert.match(stop,/error\.status===409/);
});

test('Ordering goes through a fresh staff menu and the existing dish selector only',()=>{
 assert.match(stop,/adapter\.openProduct\(item\.id\)/);
 assert.match(stop,/async function ensureComposer\(\)/);
 assert.ok(stop.indexOf('await ensureComposer()')<stop.indexOf('const adapter=window.STARTCafeOrder'));
 assert.match(stop,/document\.querySelector\('\[data-tab="compose"\]'\)/);
 assert.match(stop,/document\.addEventListener\('cafe-compose-visibility',visible\)/);
 assert.match(cafe,/window\.cafeComposerReady\.then\(\(\)=>\{if\(!staffMode\|\|!staff\)return;window\.STARTCafeOrder=\{async openProduct\(itemId\)/);
 const adapter=cafe.slice(cafe.indexOf('window.STARTCafeOrder='));
 assert.match(adapter,/await request\('\/api\/cafe\/menu'\)/);
 assert.match(adapter,/renderMenu\(\);refreshDishStock\(\);orderingState\(\)/);
 assert.match(adapter,/!item\.active\|\|item\.soldOut\|\|item\.restricted\|\|!\(item\.stock\?\.available>0\)/);
 assert.match(adapter,/document\.querySelector\('\[data-tab="compose"\]'\)/);
 assert.match(adapter,/document\.addEventListener\('cafe-compose-visibility',visible\)/);
 assert.ok(adapter.indexOf('tab.click()')<adapter.indexOf("request('/api/cafe/menu')"));
 assert.match(adapter,/openDish\(item\)/);
 assert.doesNotMatch(adapter.slice(0,adapter.indexOf(';\n')),/quickAdd|checkout|payment|fetch\('\/api\/.*orders/);
});

test('Card edits close the stop dialog and resume it from the saved callback',()=>{
 assert.match(stop,/initialComponent:componentFor\(item\)/);
 assert.match(stop,/onSaved:\(\)=>\{if\(openAfterCard\)\{openAfterCard=false;queueMicrotask\(\(\)=>void open\(\)\);\}\}/);
 assert.match(stop,/stock\.href='\/admin\/purchase\/'/);
});
