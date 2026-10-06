import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('Cafe order search stays outside optional filters and keeps its existing control ID',async()=>{
 const html=await read('dist/admin/cafe.html');
 const details=html.match(/<details class="extra-filters" id="order-filters">([\s\S]*?)<\/details>/)?.[1]||'';
 assert.match(html,/<input id="order-search" type="search"/);
 assert.doesNotMatch(details,/id="order-search"/);
 assert.match(details,/<summary>Фильтры<\/summary>/);
 for(const id of ['order-date','order-status','order-source','order-place'])assert.match(details,new RegExp(`id="${id}"`));
});

test('Cafe order actions keep READY primary and immediate delivery secondary',async()=>{
 const js=await read('dist/admin/cafe.js');
 assert.match(js,/id:r\.id,revision:r\.revision,status:'READY'/);
 assert.match(js,/r\.ready\?'Выдать сразу':'Выполнен'/);
 assert.match(js,/r\.ready\?' order-secondary':''/);
 assert.match(js,/order-primary/);
 assert.match(js,/status:'DELIVERED'/);
});

test('Cafe list cards keep number, amount, status, items, payment and elapsed time visible',async()=>{
 const js=await read('dist/admin/cafe.js');
 assert.match(js,/make\('b','№'\+r\.number/);
 assert.match(js,/money\(r\.totalCents-r\.refundedCents\)/);
 assert.match(js,/r\.customerLabel\+' · '\+r\.statusLabel/);
 assert.match(js,/make\('small',r\.itemsLabel\)/);
 assert.match(js,/make\('small',r\.paymentLabel,'payment-label'\)/);
 assert.match(js,/data-order-created/);
 assert.match(js,/Math\.floor\(\(Date\.now\(\)-Number\(e\.dataset\.orderCreated\)\)\/60000\)/);
});

test('Payment legend is optional while order-specific reconciliation warnings remain textual',async()=>{
 const js=await read('dist/admin/cafe.js');
 assert.match(js,/id='payment-help'/);
 assert.match(js,/box\.hidden=!terminalIssues\.length/);
 assert.match(js,/issue\.blocking\?'Блокирует кассу: ':'Проверить чек: '/);
});

test('Guest list omits only the duplicated list heading',async()=>{
 const js=await read('dist/admin/cafe.js');
 assert.match(js,/#guests \.guest-panel > h2/);
 assert.match(js,/heading\?\.textContent==='Счета гостей'\)heading\.remove\(\)/);
 assert.match(js,/STARTGuests\.show\(null,\$\('#guests'\)\)/);
});
