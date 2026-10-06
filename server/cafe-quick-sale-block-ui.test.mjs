import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const cafe=readFileSync(new URL('../dist/cafe.js',import.meta.url),'utf8');
const compose=readFileSync(new URL('../dist/admin/cafe-compose.js',import.meta.url),'utf8');
const admin=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');

function blockedItems(items,cart){
 const line=cafe.split(/\r?\n/).find(line=>line.trim().startsWith('function blockedQuickSaleItems()'));
 return runInNewContext('('+line.trim()+')()',{
  menu:{items},cart,
 });
}

test('Immediate sale block follows catalog items across variants and clears when blocked line is removed',()=>{
 const items=[{id:'coffee',name:'Кофе',blockQuickSale:true},{id:'tea',name:'Чай'}];
 const cart=[{itemId:'coffee',variantId:'large',quantity:1},{itemId:'tea',variantId:'mint',quantity:1}];
 assert.deepEqual([...blockedItems(items,cart)].map(item=>item.name),['Кофе']);
 assert.deepEqual([...blockedItems(items,cart.slice(1))],[]);
 assert.deepEqual([...blockedItems(items,[{itemId:'manual',custom:true}])],[]);
});

test('Block only applies to an otherwise eligible immediate pickup sale',()=>{
 const line=cafe.split(/\r?\n/).find(line=>line.trim().startsWith('function quickSaleCheckoutBlocked()'));
 const blocked=runInNewContext('('+line.trim()+')()',{
  canQuickSell:()=>true,freeChoice:()=>null,form:{dataset:{}},sessionStorage:{getItem:()=>null},pendingKey:'pending',
  blockedQuickSaleItems:()=>[{name:'Пельмени'}],read:(_store,_key,fallback)=>fallback,
 });
 assert.equal(blocked,true);
 for(const context of [
  {canQuickSell:false,dataset:{}},
  {canQuickSell:true,dataset:{guestBill:'18'}},
 ]){
  const actual=runInNewContext('('+line.trim()+')()',{
   canQuickSell:()=>context.canQuickSell,freeChoice:()=>null,form:{dataset:context.dataset},
   sessionStorage:{getItem:()=>null},pendingKey:'pending',blockedQuickSaleItems:()=>[{name:'Пельмени'}],read:(_store,_key,fallback)=>fallback,
  });
  assert.equal(actual,false);
 }
});

test('Block is explicitly saved in the item editor and defaults off for new items',()=>{
 assert.match(admin,/blockQuickSale:false/);
 assert.match(admin,/check\(out,'Заблокировать сразу выдать',x\.blockQuickSale===true\)/);
 assert.match(admin,/blockQuickSale:blockQuickSale\.checked/);
});

test('Blocked basket exposes the work path and disables cash/manual immediate delivery only',()=>{
 assert.match(cafe,/\$\('#prepare-order'\)\.hidden=!!form\.dataset\.guestBill\|\|!canQuickSell\(\)\|\|!!pending/);
 assert.match(compose,/blockedNote\.textContent=blockedItems\?'Только «В работу»: '\+blockedItems/);
 assert.match(compose,/cashDeliver\.disabled=checkoutButton\.disabled\|\|!!blockedItems/);
 assert.match(compose,/manualDeliver\.disabled=checkoutButton\.disabled\|\|prepareButton\.disabled\|\|!!form\.dataset\.quickSaleBlockedItems/);
 assert.match(cafe,/quickSaleCheckoutBlocked\(\)/);
 assert.match(compose,/cashWork\.disabled=prepareButton\.hidden\?checkoutButton\.disabled:prepareButton\.disabled/);
 assert.match(compose,/manualRegister\.disabled=prepareButton\.hidden\?checkoutButton\.disabled:prepareButton\.disabled/);
 assert.match(compose,/if\(cashDeliver\)cashDeliver\.disabled=checkoutButton\.disabled\|\|!!blockedItems/);
});

test('Pending submissions bypass current catalog block checks for reconciliation',()=>{
 assert.match(cafe,/b\.quickSale=!pending&&!b\.guestBillId&&quickSaleAvailable\(\)/);
 assert.match(cafe,/if\(!pending\)\{if\(b\.manualPaidRequested/);
});
