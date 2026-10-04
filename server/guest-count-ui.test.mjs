import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/guest-bills.js',import.meta.url),'utf8');
const update=source.slice(source.indexOf('let openBillCount='),source.indexOf('async function api('));

test('Guest bill count updates do not change navigation labels or badges',()=>{
 const button={textContent:'Счета гостей',attributes:{'aria-label':'Счета гостей'},children:[]},selectors=[];
 const context={Number,document:{querySelectorAll(selector){selectors.push(selector);return [];}}};
 runInNewContext(update+';updateCount(4);',context);
 assert.equal(button.textContent,'Счета гостей');
 assert.equal(button.attributes['aria-label'],'Счета гостей');
 assert.deepEqual(selectors,['iframe']);
 assert.doesNotMatch(source,/guest-open-count|data-guest-count-button|paintCount/);
});
