import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';

const root=new URL('../dist/admin/',import.meta.url);
const read=name=>readFileSync(new URL(name,root),'utf8');

test('Finance shared surfaces parse and expose one close entry on POS',()=>{
 const workbar=read('work-bar.js'),chrome=read('pos-chrome.js'),desk=read('day-desk.js');
 for(const name of ['day-desk.js','work-bar.js','pos-chrome.js','print-ui.js'])assert.doesNotThrow(()=>new Script(read(name),{filename:name}));
 assert.match(workbar,/Подвести и сохранить итог дня/);
 assert.match(workbar,/dayButton\.hidden=!data\.desk\?\.enabled\|\|\['\/admin\/','\/admin\/cafe\/'\]\.includes\(location\.pathname\)/);
 assert.match(chrome,/Подвести и сохранить итог дня/);assert.match(chrome,/STARTWork\.summary\(\)/);
 assert.match(desk,/Подвести и сохранить итог дня/);assert.match(desk,/Не влияет на начисления/);
 assert.doesNotMatch(desk,/Бонус с разницы/);
});

test('Day summary separates current-day wages from carried payroll by source day',()=>{
 const desk=read('day-desk.js');
 assert.match(desk,/carry\.day\|\|carry\.origin_day/);
 assert.match(desk,/за день '\+money\(Math\.max\(0,e\.salary_cents-carry\)\)/);
 assert.match(desk,/ledger\.unknownCount/);
 assert.match(desk,/ledger\.shift\?\.id===s\.shift\.id/);
 assert.match(desk,/cashEndCents:readCash\(\),cashlessCents:readCashless\(\)/);
 assert.match(desk,/Безнал за вычетом возвратов, ₽',undefined,true/);
 assert.match(desk,/s\.calculation\?\.revenue/);
 assert.match(desk,/registered=revenue\.cents\?\?/);
 assert.match(desk,/Наличные по пересчёту, ₽/);
 assert.match(desk,/Расчётный остаток для ориентира/);
 assert.doesNotMatch(desk,/Наличные по пересчёту, ₽',ledger\.balanceCents/);
 assert.match(desk,/e\.review_required/);
 assert.match(desk,/e\.origins/);
 assert.match(desk,/Подвести и сохранить итог дня/);
 assert.match(desk,/Есть активная смена/);
});

test('Print stays a separate command and distinguishes preliminary from final reports',()=>{
 const desk=read('day-desk.js'),print=read('print-ui.js'),chrome=read('pos-chrome.js');
 assert.match(desk,/mountReport\(slot,\{shiftId:s\.shift\.id,preview:true,closed:true\}\)/);
 assert.match(print,/closed\?'Распечатать итоговый отчёт':'Распечатать предварительный отчёт'/);
 assert.match(print,/api\('report'/);
 assert.doesNotMatch(print,/day-close/);
 assert.match(chrome,/STARTPrint\?\.mountReport\(print\)/);
 assert.doesNotMatch(chrome,/printButton\.textContent='Печать отчёта'/);
});
