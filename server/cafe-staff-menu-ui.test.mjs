import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const cafe=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
const productCard=readFileSync(new URL('../dist/admin/cafe-product-card.js',import.meta.url),'utf8');
const cafeHtml=readFileSync(new URL('../dist/admin/cafe.html',import.meta.url),'utf8');
const settings=readFileSync(new URL('../dist/admin/settings.js',import.meta.url),'utf8');
const settingsHtml=readFileSync(new URL('../dist/admin/settings.html',import.meta.url),'utf8');

function allowedTab(role,value){
 const source=cafe.split(/\r?\n/).find(line=>line.startsWith('function allowedTab('));
 const context={user:role?{role}:null};
 return runInNewContext(source+'; allowedTab('+JSON.stringify(value)+')',context);
}

test('Cafe menu tab is available to staff and waiter while owner tabs remain restricted',()=>{
 for(const role of ['staff','waiter','admin'])assert.equal(allowedTab(role,'menu'),'menu');
 for(const role of ['staff','waiter'])for(const tab of ['management','places','settings'])assert.equal(allowedTab(role,tab),'compose');
 assert.equal(allowedTab(null,'menu'),'compose');
 assert.match(cafeHtml,/<button data-tab="menu">Меню<\/button>/);
 assert.match(cafe,/data-owner\]:not\(\[data-tab="menu"\]\)/);
});

test('Staff catalog loader requests only the menu and leaves owner settings and staff list separate',async()=>{
 const definition=cafe.split(/\r?\n/).find(line=>line.startsWith('async function loadCatalog('));
 const calls=[];let rendered=0;
 const context={api:async path=>{calls.push(path);return {items:[],settings:{}};},renderCatalog:()=>rendered++};
 await runInNewContext('('+definition+')()',context);
 assert.deepEqual(calls,['menu']);
 assert.equal(rendered,1);
 assert.match(cafe,/async function loadOwner\(\)\{if\(!catalog\)await loadCatalog\(\).*api\('staff'\)/);
 assert.match(cafe,/if\(tab==='menu'&&!catalog\)await loadCatalog\(\)/);
 assert.match(cafe,/needsOwnerLoad\(user\.role,tab,ownerLoaded&&ownerLoadedUser===user\.id\)/);
});

test('Menu then Settings loads owner data for admin, never for staff or waiter',()=>{
 const definition=cafe.split(/\r?\n/).find(line=>line.startsWith('function needsOwnerLoad('));
 for(const role of ['admin','staff','waiter']){
  const context={role,loaded:false,calls:[]};
  runInNewContext(definition+'; for(const tab of ["menu","settings"]){if(needsOwnerLoad(role,tab,loaded)){calls.push("loadOwner");loaded=true;}}',context);
  assert.deepEqual(context.calls,role==='admin'?['loadOwner']:[]);
 }
});

test('Staff Settings exposes only the unified product card; global settings stay admin-only',()=>{
 assert.match(settings,/if\(user\.role!=='admin'\).*renderGroup\(root,'Моя работа'/);
 assert.match(settings,/if\(\['staff','waiter'\]\.includes\(user\.role\)\)renderGroup\(root,'Кафе',\[\['Товары: фото, варианты, расход и себестоимость','\/admin\/cafe\/\?settings=menu'\]\]\)/);
 assert.doesNotMatch(settings,/\/admin\/cafe-stock\/\?settings=stock/);
 assert.match(settings,/return;\}.*Все настройки станции/);
 assert.match(settingsHtml,/settings\.js\?v=battery-state-20261009-1/);
 assert.match(cafeHtml,/cafe\.js\?v=staff-menu-20261007-2/);
});

test('Product card photo upload remains available in its dedicated frontend module',()=>{
 assert.match(productCard,/Загрузить фото \(JPEG, PNG, WebP, до 8 МБ\)/);
 assert.match(productCard,/fetch\('\/api\/admin\/content-upload'/);
 assert.match(cafe,/window\.STARTCafeProductCard\.open\(item/);
});
