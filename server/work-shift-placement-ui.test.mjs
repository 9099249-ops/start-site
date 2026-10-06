import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const admin=new URL('../dist/admin/',import.meta.url);
const readAdmin=name=>readFile(new URL(name,admin),'utf8');

test('Work bar places shift action after schedule in redesigned and fallback layouts',async()=>{
 const posCss=await readAdmin('pos-chrome.css'),navCss=await readAdmin('ops-nav.css');
 assert.match(posCss,/body\.pos-redesign \.work-bar \.schedule-link\{order:4\}/);
 assert.match(posCss,/body\.pos-redesign \.work-bar \.work-shift-action\{order:5\}/);
 assert.doesNotMatch(posCss,/body\.pos-redesign \.work-bar \.work-shift-action\{order:1\}/);
 for(const rule of [
  '.work-bar>.active-people{order:0}',
  '.work-bar>span:not(.work-error){order:2}',
  '.work-bar>.pos-toggle{order:3}',
  '.work-bar>.schedule-link{order:4}',
  '.work-bar>button:not(.pos-toggle){order:5}',
  '.work-bar>.work-account{order:6}',
  '.work-bar>.work-error{order:8}',
 ])assert.ok(navCss.includes(rule),`Missing fallback order rule in ops-nav.css: ${rule}`);
 assert.doesNotMatch(navCss,/\.work-bar>button:not\(\.pos-toggle\)\{[^}]*order:1/);
});

test('Shift placement leaves both labels and the shared start/end request handler intact',async()=>{
 const work=await readAdmin('work-bar.js');
 assert.match(work,/action\.textContent=data\.own\?'Завершить мою смену':'Я на смене'/);
 assert.match(work,/const kind=data\.own\?'end':'start'/);
 assert.match(work,/request\(pending\.kind,pending\.body\)/);
 assert.match(work,/action\.onclick=async\(\)=>\{/);
});
