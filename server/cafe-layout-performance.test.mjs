import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../dist/admin/cafe-compose.js',import.meta.url),'utf8');
function fixture(source){
 const metrics={queries:0,writes:0,rects:0},sections=[],links=[];
 for(let i=0;i<10;i++){
  const props=new Map(),attrs=new Map([['href','#cat-'+i]]);
  const rect=()=>{metrics.rects++;return {top:100+i*200,bottom:140+i*200};};
  sections.push({id:'cat-'+i,getBoundingClientRect:rect,style:{getPropertyValue:k=>props.get(k),setProperty:(k,v)=>{metrics.writes++;props.set(k,v);}},querySelectorAll:()=>{metrics.queries++;return Array(12).fill({});}});
  links.push({dataset:{},getAttribute:k=>attrs.get(k),hasAttribute:k=>attrs.has(k),setAttribute:(k,v)=>{metrics.writes++;attrs.set(k,v);},removeAttribute:k=>{metrics.writes++;attrs.delete(k);},getBoundingClientRect:rect});
 }
 const query=items=>()=>{metrics.queries++;return items;};
 const context={categoryEntries:[],innerWidth:1280,innerHeight:800,scrollY:0,document:{documentElement:{scrollHeight:4000}},content:{querySelectorAll:query(sections)},categories:{querySelectorAll:query(links),getBoundingClientRect:()=>({top:0,bottom:800}),scrollTop:0},getComputedStyle:()=>({scrollMarginTop:'0'}),matchMedia:()=>({matches:true})};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  function compactCategories(){'),source.indexOf("  categories.addEventListener('click'")),context);
 vm.runInContext('compactCategories();updateCategory();',context);
 return {context,metrics,sections,links};
}
test('Category scroll does not rescan dishes or rewrite unchanged attributes',()=>{
 const f=fixture(source);Object.keys(f.metrics).forEach(k=>f.metrics[k]=0);
 vm.runInContext('for(let i=0;i<100;i++)updateCategory();',f.context);
 assert.equal(f.metrics.queries,0);assert.equal(f.metrics.writes,0);assert.equal(f.metrics.rects,1000);
});
test('Category geometry is refreshed and selection updates only changed links',()=>{
 const f=fixture(source);f.sections[0].getBoundingClientRect=()=>({top:-190});f.sections[1].getBoundingClientRect=()=>({top:10});f.context.getComputedStyle=()=>({scrollMarginTop:'5'});
 vm.runInContext('updateCategory();',f.context);assert.equal(f.links[1].getAttribute('aria-current'),'true');assert.equal(f.links[0].hasAttribute('aria-current'),false);
 f.sections[2].getBoundingClientRect=()=>({top:10});vm.runInContext("activeCategory='cat-2';updateCategory();",f.context);assert.equal(f.links[2].getAttribute('aria-current'),'true');
});
