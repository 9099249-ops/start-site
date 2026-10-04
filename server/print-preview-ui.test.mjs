import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../dist/admin/print-ui.js',import.meta.url),'utf8');
const preview=runInNewContext(source.slice(source.indexOf(' function reportPreview('),source.indexOf(' function mountReport('))+';reportPreview');
const snapshot={shiftId:7,date:'2026-09-29',preliminary:false,asOf:Date.parse('2026-09-29T18:00:00Z'),totalCents:585000,employees:[{name:'Иван · 28.09',remainingCents:120050},{name:'Анна',remainingCents:30025},{name:'Уже выплачено',remainingCents:0},{name:'Проверить выплату',remainingCents:0,reviewRequired:true}]};
test('Report preview includes only remaining transfers and sums integer cents',()=>{
 const text=preview({snapshot,reports:[]});assert.match(text,/ИТОГОВЫЙ ОТЧЁТ/);assert.match(text,/5850.00 ₽/);assert.match(text,/Иван · 28\.09\n1200.50 ₽/);assert.match(text,/Проверить выплату\nУже выплачено, сумма требует сверки/);assert.match(text,/Всего к выплате: 1500.75 ₽/);assert.match(text,/Даты начислений указаны рядом с сотрудником/);assert.doesNotMatch(text,/Переводов нет/);assert.doesNotMatch(text,/Уже выплачено\n0/);assert.match(text,/start-shift-7-final-v1/);
});

test('Print UI exposes stale snapshots, preserves explicit revision, and uses accurate preliminary wording',()=>{
 const ui=readFileSync(new URL('../dist/admin/print-ui.js',import.meta.url),'utf8');
 assert.match(ui,/Сохранённая редакция устарела: выплаты или суммы изменились/);
 assert.match(ui,/newRevision:true/);assert.match(ui,/askReason\('Будет создана новая редакция с актуальными суммами\.'/);
 assert.match(ui,/Предварительно, до сохранения итога\./);
 assert.doesNotMatch(ui,/Только за эту смену/);
 assert.match(ui,/action\('Напечатать отчёт'/);
});

test('Report preview includes the existing source note from current or saved report data',()=>{
 const current=preview({snapshot:{...snapshot,source:'Ранее выплаченная зарплата требует сверки'},reports:[]});
 assert.match(current,/Ранее выплаченная зарплата требует сверки/);
 const saved=preview({snapshot,reports:[{snapshot,payload:{date:snapshot.date,shift_id:'7',preliminary:false,revision:1,total:'5850.00',source:'Сохранённая пометка сверки',transfers:[],as_of:new Date(snapshot.asOf).toISOString(),report_id:'saved'}}]});
 assert.match(saved,/Сохранённая пометка сверки/);
});
test('A saved report preview uses its immutable payload instead of current payroll',()=>{
 const text=preview({snapshot,reports:[{snapshot,payload:{date:'2026-09-28',shift_id:'6',preliminary:true,revision:2,total:'100.00',transfers:[],report_id:'saved-report'},operation:'reprint'}]});
 assert.match(text,/ПОВТОР/);assert.match(text,/НОВАЯ РЕДАКЦИЯ 2/);assert.match(text,/ПРЕДВАРИТЕЛЬНЫЙ ОТЧЁТ/);assert.match(text,/100.00 ₽/);assert.match(text,/Проверить выплату\nУже выплачено, сумма требует сверки/);assert.match(text,/saved-report/);assert.doesNotMatch(text,/5850|Иван/);
});
