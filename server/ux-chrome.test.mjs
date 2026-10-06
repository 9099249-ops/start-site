import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';

const root=new URL('../dist/admin/',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');

test('Cash footer opens the shared cash area and leaves the daily close action there',async()=>{
 const chrome=await read('pos-chrome.js'),work=await read('work-bar.js');
 new Script(chrome,{filename:'pos-chrome.js'});
 assert.match(chrome,/\.work-bar \.work-account/);
 assert.match(chrome,/day\.hidden=false/);
 assert.doesNotMatch(chrome,/action\('Подвести и сохранить итог дня'/);
 assert.match(chrome,/day\.hidden=false/);
 assert.match(work,/dayButton\.textContent='Подвести и сохранить итог дня'/);
 assert.match(work,/takeButton\.textContent='Забрать деньги из кассы'/);
 assert.match(chrome,/unknownPayments/);
 assert.match(chrome,/нет свежих данных/);
});

test('Rare website and SMS configuration is only exposed in settings context',async()=>{
 const nav=await read('ops-nav.js'),desk=await read('desk.css'),settings=await read('settings.js'),index=await read('index.html');
 new Script(nav,{filename:'ops-nav.js'});
 assert.match(nav,/classList\.toggle\('settings-context',settingsPage\)/);
 assert.match(desk,/body:not\(\.settings-context\) #content-editor,body:not\(\.settings-context\) #sms-settings/);
 assert.match(settings,/\/admin\/\?settings=content/);
 assert.match(settings,/\/admin\/\?settings=sms/);
 assert.match(index,/id="content-editor"/);
});

test('Mobile rental rows keep visible search and primary return controls at touch size',async()=>{
 const desk=await read('desk.css'),index=await read('index.html');
 assert.match(index,/id="active-search"/);
 assert.match(desk,/#active-list \.quick-return\{[^}]*font-size:12px/);
 assert.match(desk,/#active-list button\{min-height:44px/);
 assert.match(desk,/grid-template-columns:minmax\(0,1fr\) 68px 44px 44px/);
});
