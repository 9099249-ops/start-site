import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../dist/admin/print-ui.js',import.meta.url),'utf8');
const preview=runInNewContext(source.slice(source.indexOf(' function reportPreview('),source.indexOf(' function mountReport('))+';reportPreview');
const snapshot={shiftId:7,date:'2026-09-29',preliminary:false,asOf:Date.parse('2026-09-29T18:00:00Z'),totalCents:585000,employees:[{name:'Иван',remainingCents:120050},{name:'Анна',remainingCents:30025},{name:'Уже выплачено',remainingCents:0}]};
test('Report preview includes only remaining transfers and sums integer cents',()=>{
 const text=preview({snapshot,reports:[]});assert.match(text,/ИТОГОВЫЙ ОТЧЁТ/);assert.match(text,/5850.00 ₽/);assert.match(text,/Иван\n1200.50 ₽/);assert.match(text,/Всего к выплате: 1500.75 ₽/);assert.doesNotMatch(text,/Уже выплачено/);assert.match(text,/start-shift-7-final-v1/);
});
test('A saved report preview uses its immutable payload instead of current payroll',()=>{
 const text=preview({snapshot,reports:[{snapshot,payload:{date:'2026-09-28',shift_id:'6',preliminary:true,revision:2,total:'100.00',transfers:[],report_id:'saved-report'},operation:'reprint'}]});
 assert.match(text,/ПОВТОР/);assert.match(text,/НОВАЯ РЕДАКЦИЯ 2/);assert.match(text,/ПРЕДВАРИТЕЛЬНЫЙ ОТЧЁТ/);assert.match(text,/100.00 ₽/);assert.match(text,/Переводов нет/);assert.match(text,/saved-report/);assert.doesNotMatch(text,/5850|Иван/);
});
