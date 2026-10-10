import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

class Element {
 constructor(){this.children=[];this.dataset={};this.style={setProperty(){}};this.listeners={};this.hidden=false;this.parentElement=null;this.textContent='';}
 append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}}
 replaceChildren(...items){this.children=[];this.append(...items);}
 addEventListener(type,fn){this.listeners[type]=fn;}
}
function response(data){return {ok:true,status:200,json:async()=>data};}

test('rental battery renderer applies server thresholds and requires fresh state before active mode',async()=>{
 const nodes=new Map(['rental-battery-panel','rental-battery-list','rental-battery-status','rental-battery-admin-link'].map(id=>[id,new Element()]));
 const document={hidden:false,querySelector:selector=>nodes.get(selector.slice(1)),createElement:()=>new Element(),addEventListener(){},dispatchEvent(){}};
 const fixture={catamarans:[{label:'Сашин',devices:[{name:'АКБ',socPercent:35,online:true,stale:false,bmsConnected:true,state:'charging',estimatedChargeMinutes:60}]}],colorSettings:{greenFrom:70,yellowFrom:30}};
 const context={document,window:{},CustomEvent:function(){},fetch:async url=>response(url.endsWith('/session')?{user:{role:'staff'}}:fixture),setInterval(){return 1;},clearInterval(){},Date,Math};
 const source=await readFile(new URL('../dist/admin/rental-batteries.js',import.meta.url),'utf8');vm.runInNewContext(source,context);await new Promise(resolve=>setTimeout(resolve,5));
 const card=nodes.get('rental-battery-list').children.find(node=>node.dataset.catamaran==='Сашин');
 assert.equal(card.children[0].dataset.charge,'medium');assert.equal(card.children[0].dataset.mode,'charging');
 assert.equal(card.children[0].children[1].children[2].textContent,'Заряжается');
 fixture.catamarans[0].devices[0].stateFresh=false;context.fetch=async url=>response(url.endsWith('/session')?{user:{role:'staff'}}:fixture);
 // Exercise a separate renderer instance with retained but stale status data.
 const secondNodes=new Map(['rental-battery-panel','rental-battery-list','rental-battery-status','rental-battery-admin-link'].map(id=>[id,new Element()]));document.querySelector=selector=>secondNodes.get(selector.slice(1));
 vm.runInNewContext(source,{...context,document,fetch:async url=>response(url.endsWith('/session')?{user:{role:'staff'}}:fixture)});await new Promise(resolve=>setTimeout(resolve,5));
 const stale=secondNodes.get('rental-battery-list').children.find(node=>node.dataset.catamaran==='Сашин');
 assert.equal(stale.children[0].dataset.mode,'unknown');assert.equal(stale.children[0].dataset.charge,'medium');
});

test('battery color form has immutable pending attempts, conflict reload guard, and exact ring geometry',async()=>{
 const [state,html,rentalCss,stateCss,mockupCss,indexHtml]=await Promise.all([
  readFile(new URL('../dist/admin/battery-state.js',import.meta.url),'utf8'),
  readFile(new URL('../dist/admin/battery-state.html',import.meta.url),'utf8'),
  readFile(new URL('../dist/admin/rental-batteries.css',import.meta.url),'utf8'),
  readFile(new URL('../dist/admin/battery-state.css',import.meta.url),'utf8'),
  readFile(new URL('../dist/admin/rental-mockup.css',import.meta.url),'utf8'),
  readFile(new URL('../dist/admin/index.html',import.meta.url),'utf8')
 ]);
 assert.match(html,/Зелёный от, %/);assert.match(html,/Жёлтый от, %/);assert.match(html,/Повторить сохранение/);assert.match(html,/Загрузить актуальные настройки/);
 assert.match(state,/requestId:requestId\(\)/);assert.match(state,/error\.status===409/);assert.match(state,/colorConflict=true/);assert.match(state,/colorPending=null;colorMessage\.textContent=error\.message/);
 assert.match(state,/if\(colorForm&&!colorDirty&&!colorPending\)/);assert.match(state,/colorRetry\.hidden=false/);
 const reloadHandler=state.match(/colorReload\.addEventListener\('click',async\(\)=>\{([\s\S]*?)\}\);async function submitColorSettings/)[1];
 assert.match(reloadHandler,/api\('battery-state\/colors'\)/);assert.match(reloadHandler,/colorConflict=false/);assert.match(reloadHandler,/catch\(error\)\{colorMessage\.textContent/);assert.match(reloadHandler,/finally\{colorReload\.disabled=false/);
 assert.match(rentalCss,/\.rental-battery-ring:before\{inset:14px\}/);assert.match(rentalCss,/max-width:760px\)\{\.rental-battery-ring:before\{inset:10px\}\}/);assert.match(rentalCss,/max-width:420px\)\{\.rental-battery-ring:before\{inset:8px\}/);assert.match(rentalCss,/font-size:7px/);
 assert.match(rentalCss,/width:76px/);assert.match(rentalCss,/width:48px/);assert.match(rentalCss,/width:34px/);assert.match(rentalCss,/#00a9ed/);
 assert.match(mockupCss,/\.rental-battery-ring\{width:44px!important\}/);assert.match(mockupCss,/\.rental-battery-ring:before\{inset:10px!important\}/);assert.match(mockupCss,/\.rental-battery-ring b\{font-size:9px!important\}/);assert.match(indexHtml,/rental-mockup\.css\?v=rental-controls-20261010-7/);
 assert.match(stateCss,/\.battery-color-form/);
});
