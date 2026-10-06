import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/cafe-compose.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/admin/cafe-compose.css',import.meta.url),'utf8');
const html=readFileSync(new URL('../dist/admin/cafe.html',import.meta.url),'utf8');
const chooser=source.match(/function chooseActiveCategory\(positions,top,requestedId,atBottom\)\{[\s\S]*?\n  \}/)?.[0];
assert.ok(chooser,'category selection helper is present');
const context={};
runInNewContext(`${chooser};globalThis.chooseActiveCategory=chooseActiveCategory;`,context);
const entry=(id,top)=>({section:{id},top});

test('A clicked category stays selected within its reachable equal-top row',()=>{
 const row=[entry('bar',605),entry('icecream',605),entry('hookah',605)];
 assert.equal(context.chooseActiveCategory(row,615,'bar',false).current.section.id,'bar');
 assert.equal(context.chooseActiveCategory(row,615,'icecream',false).current.section.id,'icecream');
});

test('At the scroll limit a clicked bottom category stays selected, while automatic selection uses the last visible group',()=>{
 const groups=[entry('food',-100),entry('bar',605),entry('icecream',605),entry('hookah',605)];
 assert.equal(context.chooseActiveCategory(groups,615,'icecream',true).current.section.id,'icecream');
 assert.equal(context.chooseActiveCategory(groups,50,'',true).current.section.id,'hookah');
 const stale=context.chooseActiveCategory(groups,50,'food',true);
 assert.equal(stale.current.section.id,'hookah');
 assert.equal(stale.requestedId,'');
});

test('Missing or hidden requested categories are discarded and geometry resumes',()=>{
 const visible=[entry('food',100),entry('hookah',605)];
 const result=context.chooseActiveCategory(visible,200,'hidden-icecream',false);
 assert.equal(result.current.section.id,'food');
 assert.equal(result.requestedId,'');
});

test('A clamped mobile category stays selected even above the final category',()=>{
 const mobile=[entry('food',-2500),entry('fridge',-228),entry('bar',457),entry('icecream',669),entry('hookah',765)];
 for(const id of ['bar','icecream','hookah'])assert.equal(context.chooseActiveCategory(mobile,285,id,true).current.section.id,id);
 assert.equal(context.chooseActiveCategory(mobile,285,'food',true).current.section.id,'hookah');
});

test('The desktop rail uses its button height and mobile keeps all categories wrapped in view',()=>{
 assert.match(css,/\.menu-categories\{[^}]*height:auto;max-height:var\(--categories-available-height/);
 assert.match(css,/@media\(max-width:759px\)\{[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,1fr\)\)[\s\S]*?overflow:visible!important/);
 assert.match(html,/cafe-compose\.js\?v=quick-sale-block-20261005-3/);
 assert.match(html,/cafe-compose\.css\?v=staff-menu-rail-20261005-2/);
});
