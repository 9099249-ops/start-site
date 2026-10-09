import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../dist/admin/purchase.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../dist/admin/purchase.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/admin/purchase.css',import.meta.url),'utf8');
const helperSource=source.slice(source.indexOf(' const matchesStatus='),source.indexOf(' const $='));
const context={window:{},Number};vm.createContext(context);vm.runInContext(helperSource,context);
const matches=context.window.PurchaseFilterInternals.matchesStatus;

test('Procurement status filters preserve zero and distinguish unknown values',()=>{
 const base={minimum:0,target:0,current:0,unit_id:4,purchasePrice:{unitId:4,estimated:false},unitPriceCents:0};
 assert.equal(matches(base,'unconfigured'),false);
 assert.equal(matches({...base,minimum:null},'unconfigured'),true);
 assert.equal(matches({...base,current:null},'unknown-stock'),true);
 assert.equal(matches(base,'unknown-stock'),false);
 assert.equal(matches(base,'out-of-stock'),true);
 assert.equal(matches({...base,current:'0'},'out-of-stock'),true);
 assert.equal(matches(base,'no-price'),false);
 assert.equal(matches({...base,purchasePrice:null},'no-price'),true);
 assert.equal(matches({...base,unitPriceCents:null},'no-price'),true);
 assert.equal(matches({...base,purchasePrice:{unitId:7}},'no-price'),true);
 assert.equal(matches({...base,purchasePrice:{unitId:4,estimated:true}},'estimated-price'),true);
 assert.equal(matches({...base,purchasePrice:{unitId:4,estimated:false}},'estimated-price'),false);
 assert.equal(matches({...base,needsPurchase:true},'needs-purchase'),true);
 assert.equal(matches({...base,manual_buy:true},'manual-buy'),true);
});

test('Status selection is All-only and does not enter buy, print, or history filtering',()=>{
 assert.match(source,/const status=tab==='all'\?\$\('#status'\)\.value:''/);
 assert.match(source,/\$\('#status'\)\.hidden=tab!=='all';\$\('#all-reset'\)\.hidden=tab!=='all'\|\|!\(/);
 assert.ok(source.indexOf("$('#all-reset').hidden=tab!=='all'")<source.indexOf("if(tab==='history'){loadHistory();return;}"));
 assert.match(source,/tab==='buy'\?i\.needsPurchase:.*matchesStatus\(i,status\)/);
 assert.match(source,/function printPurchaseList\(\)[\s\S]*?catalog\.items\.filter\(i=>i\.active&&i\.needsPurchase\)/);
 assert.match(source,/function loadHistory\(append=false\)[\s\S]*?\['category','category'\],\['date','history-date'\]/);
 assert.match(html,/id="archived"/);
 assert.match(html,/id="all-reset"/);
 assert.match(html,/id="status"[\s\S]*?value="manual-buy"/);
 assert.match(source,/\$\('#all-reset'\)\.onclick=\(\)=>\{\$\('#search'\)\.value='';\$\('#category'\)\.value='';\$\('#status'\)\.value='';\$\('#archived'\)\.checked=false/);
 assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
 assert.match(css,/@media\(max-width:600px\)/);
});
