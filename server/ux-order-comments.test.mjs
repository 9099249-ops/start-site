import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cafeListRow} from './cafe-list.mjs';

const now=Date.parse('2026-10-02T12:00:00+03:00');
const rowFor=details=>cafeListRow({id:149,status:'COOKING',revision:2,created:now,total_cents:12500,details},null);

test('Cafe list projects order and item comments with only known option display names',()=>{
 const row=rowFor({name:'Гость',phone:'PRIVATE_PHONE',comment:'Без крышки',items:[
  {name:'Латте',quantity:1,comment:'Овсяное молоко',variant:{name:'350 мл'},modifiers:[{optionId:'milk-oat',name:'Овсяное'}]},
  {name:'Американо',quantity:1,comment:'',variant:null,modifiers:[]},
  {name:'Чай',quantity:1,comment:'',variant:{name:'Большой'},modifiers:[]}
 ],fulfillment:'pickup',terminalPaidAt:now,consent:true,publicToken:'PRIVATE_TOKEN'});
 assert.equal(row.comment,'Без крышки');
 assert.deepEqual(row.itemComments,[
  {name:'Латте',comment:'Овсяное молоко',variant:'350 мл',options:['Овсяное']},
  {name:'Чай',comment:'',variant:'Большой',options:[]}
 ]);
 assert.equal(row.itemsLabel,'1× Латте, 1× Американо, 1× Чай');
 for(const privateValue of ['PRIVATE_PHONE','PRIVATE_TOKEN','consent','publicToken','details','fingerprint'])assert.ok(!JSON.stringify(row).includes(privateValue),privateValue);
});

test('Cafe list comment changes invalidate the projected row version',()=>{
 const base={name:'Гость',items:[{name:'Кофе',quantity:1,comment:'Без сахара'}],fulfillment:'pickup'};
 const first=rowFor(base),second=rowFor({...base,comment:'К столу'});
 assert.notEqual(first.version,second.version);
 assert.equal(rowFor({...base,items:[{name:'Кофе',quantity:1,comment:'',variant:null,modifiers:[]}]}).itemComments.length,0);
});

test('Cafe order cards append comments as wrapped text content after item names',async()=>{
 const js=await readFile(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
 const css=await readFile(new URL('../dist/admin/cafe-pos.css',import.meta.url),'utf8');
 assert.match(js,/make\('small',commentLines\.join\('\\n'\),'order-comments'\)/);
 assert.match(js,/item\.name\+\(details\?' · '\+details:''\)/);
 assert.match(css,/\.order-row \.order-comments\{[^}]*white-space:pre-wrap;overflow-wrap:anywhere/);
 assert.doesNotMatch(js,/order-comments[^\n]*innerHTML/);
});
