import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const opsHtml=readFileSync(new URL('../dist/admin/operations-analytics.html',import.meta.url),'utf8');
const financeHtml=readFileSync(new URL('../dist/admin/financial-analytics.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../dist/admin/operations-analytics.css',import.meta.url),'utf8');
const source=readFileSync(new URL('../dist/admin/operations-analytics.js',import.meta.url),'utf8');
const helpers={};
runInNewContext(source,{window:{set OperationsAnalyticsInternals(value){Object.assign(helpers,value);}},document:{getElementById:()=>null},Intl,Date,Number,String,Math,Map});

class Element {
 constructor(id=''){this.id=id;this.dataset={};this.style={setProperty(){}};this.attributes={};this.children=[];this.options=[];this.classList={add(){},remove(){},toggle(){}};this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.innerHTML='';this.clientWidth=480;this.drawCalls=[];}
 addEventListener(){} setAttribute(k,v){this.attributes[k]=v;} getAttribute(k){return this.attributes[k]||null;}
 append(...nodes){this.children.push(...nodes);for(const node of nodes)if(node?.tagName==='option')this.options.push(node);}
 replaceChildren(...nodes){this.children=[];this.options=[];this.append(...nodes);}
 insertBefore(node,before){const i=this.children.indexOf(before);this.children.splice(i<0?this.children.length:i,0,node);}
 getContext(){return new Proxy({},{get:(_,method)=>(...args)=>this.drawCalls.push({method,args})});}
 closest(){return null;} querySelectorAll(){return [];} querySelector(){return null;} matches(){return false;}
 click(){} showModal(){}
}
function boot(html,scope,expectedEndpoint,fixture={}){
 const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,new Element(id)]));
 const root=elements.get('operations-analytics');root.dataset.scope=scope;
 const document={getElementById:id=>elements.get(id)||null,createElement:tag=>{const e=new Element();e.tagName=tag;return e;},createTextNode:text=>({textContent:text}),querySelectorAll:()=>[]};
 const calls=[];
 const responseData={period:{from:'2026-10-01',to:'2026-10-07',days:7,timezone:'Europe/Moscow'},warnings:[],employees:[],cafe:{items:[],buckets:[],totals:{}},rental:{items:[],buckets:[],totals:{}},finance:{},...fixture};
 const fetch=async url=>{calls.push(String(url));return {ok:true,status:200,json:async()=>responseData};};
 const browserDate=class extends Date{constructor(...args){super(...(args.length?args:[Date.UTC(2026,9,7,12)]));}static now(){return Date.UTC(2026,9,7,12);}};
 browserDate.UTC=Date.UTC;browserDate.parse=Date.parse;
 const context={window:{},document,fetch,Intl,Date:browserDate,Number,String,Math,Map,URL:{createObjectURL:()=>'',revokeObjectURL(){}},Blob:class{},setTimeout,Option:class{constructor(text,value){this.text=text;this.value=value;}},CSS:{escape:s=>s},crypto:{randomUUID:()=> 'test-id'}};
 runInNewContext(source,context);
 return new Promise((resolve,reject)=>setImmediate(()=>calls[0]===expectedEndpoint&&root.attributes['aria-busy']==='false'?resolve({calls,elements}):reject(new Error(`page did not finish initial load: ${calls.join(', ')}; busy=${root.attributes['aria-busy']}`))));
}

test('Operations and finance pages expose separate Russian navigation and retain shared chrome v2',()=>{
 for(const tab of ['Обзор','Сотрудники','Кафе','Прокат'])assert.match(opsHtml,new RegExp(`>${tab}<`));
 for(const tab of ['Обзор','Кафе','Прокат','Себестоимость'])assert.match(financeHtml,new RegExp(`>${tab}<`));
 assert.match(opsHtml,/data-scope="operations"/);assert.match(financeHtml,/data-scope="financial"/);
 for(const html of [opsHtml,financeHtml]){assert.match(html,/ops-nav\.js\?v=operations-analytics-20261007-2/);assert.match(html,/ops-nav\.css\?v=operations-analytics-20261007-3/);assert.match(html,/assets\/start-logo-horizontal\.webp/);}
 for(const html of [opsHtml,financeHtml]){
  assert.match(html,/operations-analytics\.js\?v=finance-expenses-20261007-1/);
  assert.match(html,/operations-analytics\.css\?v=finance-expenses-20261008-1/);
  assert.doesNotMatch(html,/<script[^>]+src="https?:/);
 }
 assert.doesNotMatch(opsHtml,/data-tab="costs"|Выручка|Себестоимость|Результат|paymentNetCents|revenueCents|refundCents|costCents|contributionCents/);
 assert.match(source,/state\.scope==='financial'\?'\/api\/admin\/financial-analytics':'\/api\/admin\/operations-analytics'/);
 assert.doesNotMatch(source,/\/api\/admin\/operations-analytics\/costs/);
});

test('Unknown values remain explicit and CSV cells neutralize spreadsheet formulas',()=>{
 assert.equal(helpers.rub(null),'Не заполнено');assert.equal(helpers.unknown(undefined),'Нет данных');
 const result=helpers.csv([['name','value'],['=1+1','-20'],['normal','@SUM(A1)']]);
 assert.match(result,/"'=1\+1"/);assert.match(result,/"'-20"/);assert.match(result,/"'@SUM\(A1\)"/);assert.match(result,/\r\n/);
});

test('Period guard supports inclusive days and the 366-day limit',()=>{
 assert.equal(helpers.daysBetween('2026-01-01','2026-01-01'),1);assert.equal(helpers.daysBetween('2026-01-01','2027-01-01'),366);assert.equal(helpers.csvSafeName('../../report'),'report');
});

test('Both actual page scopes boot, render the empty state and call only their report API',async()=>{
 const ops=await boot(opsHtml,'operations','/api/admin/operations-analytics?from=2026-10-01&to=2026-10-07');
 const finance=await boot(financeHtml,'financial','/api/admin/financial-analytics?from=2026-10-01&to=2026-10-07');
 assert.equal(ops.elements.get('oa-export').disabled,false);assert.equal(finance.elements.get('oa-export').disabled,false);
 assert.equal(ops.calls.length,1);assert.equal(finance.calls.length,1);
});

test('Operations KPI totals propagate unknowns and label reviewed hours as confirmed',async()=>{
 const page=await boot(opsHtml,'operations','/api/admin/operations-analytics?from=2026-10-01&to=2026-10-07',{
  employees:[{id:1,name:'Тест',minutes:null,taskCompleted:3,lateCount:0,overtimeMinutes:0,reviewCount:1,shifts:[]}],
  cafe:{items:[{key:'a',name:'A',quantity:4},{key:'b',name:'B',quantity:null}],buckets:[]},
  rental:{items:[{key:'r',name:'R',unitMinutes:null}],buckets:[]}
 });
 const kpis=page.elements.get('oa-kpis').children;
 assert.equal(kpis[0].children[0].textContent,'Подтверждённые часы');
 assert.equal(kpis[0].children[1].textContent,'Нет данных');
 assert.equal(kpis.length,4);
 assert.equal(kpis[1].children[1].textContent,'3');
});

test('Popularity grouping ranks actual demand and aggregates duplicate item buckets without inventing values',()=>{
 const buckets=[{itemKey:'a',day:'2026-10-01',hour:9,quantity:2},{itemKey:'a',day:'2026-10-01',hour:9,quantity:3},{itemKey:'b',day:'2026-10-01',hour:12,quantity:4},{itemKey:'a',day:'2026-10-02',hour:9,quantity:1}];
 const daily=helpers.groupPopularity({buckets,items:[{key:'a',name:'Кофе'},{key:'b',name:'Чай'}]});
 assert.equal(daily.top[0].name,'Кофе');assert.equal(daily.top[0].total,6);
 assert.deepEqual(Array.from(daily.points[0].values),[5,4]);
 assert.deepEqual(Array.from(daily.points[1].values),[1,0]);
 const hourly=helpers.groupPopularity({buckets,mode:'hour'});
 assert.deepEqual(Array.from(hourly.points.find(p=>p.key==='9').values),[6,0]);
 assert.deepEqual(Array.from(hourly.points.find(p=>p.key==='12').values),[0,4]);
});

test('Popularity grouping keeps unknown costs or usage as gaps and preserves raw rental minutes',()=>{
 const result=helpers.groupPopularity({buckets:[{itemKey:'sup',day:'2026-10-01',hour:10,unitMinutes:120},{itemKey:'sup',day:'2026-10-02',hour:11,unitMinutes:null}],field:'unitMinutes'});
 assert.equal(result.top[0].total,null);
 assert.equal(result.points[0].values[0],120);
 assert.equal(result.points[1].values[0],null);
 assert.deepEqual(Array.from(helpers.groupPopularity({}).top),[]);
});

test('Popularity timeline covers zero-demand dates and all 24 Moscow hours',()=>{
 const buckets=[{itemKey:'a',day:'2026-10-01',hour:9,quantity:2},{itemKey:'a',day:'2026-10-03',hour:12,quantity:1}];
 const daily=helpers.groupPopularity({buckets,from:'2026-10-01',to:'2026-10-03'});
 assert.equal(daily.points.length,3);assert.equal(daily.points[1].key,'2026-10-02');assert.equal(daily.points[1].values[0],0);
 const hourly=helpers.groupPopularity({buckets,mode:'hour'});
 assert.equal(hourly.points.length,24);assert.equal(hourly.points[0].key,'0');assert.equal(hourly.points[23].key,'23');assert.equal(hourly.points[8].values[0],0);
});

test('Zero staff metrics draw no colored bar, with unknown values remaining explicit',async()=>{
 const page=await boot(opsHtml,'operations','/api/admin/operations-analytics?from=2026-10-01&to=2026-10-07',{employees:[{id:1,name:'A',minutes:60,taskCompleted:2,lateCount:0,overtimeMinutes:null,shifts:[]},{id:2,name:'B',minutes:120,taskCompleted:0,lateCount:3,overtimeMinutes:60,shifts:[]}]});
 const groups=page.elements.get('oa-hours-chart').children;
 assert.equal(groups[2].children[1].children[1].children[0].style.width,'0%');
 assert.equal(groups[3].children[1].children[1].children[0].style.width,'0%');
 assert.equal(groups[3].children[1].children[2].textContent,'Нет данных');
});

test('Overview has colorful staff comparisons and local accessible popularity charts',()=>{
 assert.equal((source.match(/function renderOverview\(/g)||[]).length,1);
 for(const color of ['#3478e5','#19a891','#f07869','#e6a33a'])assert.ok(source.includes(color));
 assert.match(source,/canvas\.setAttribute\('role','img'\)/);
 assert.match(source,/Таблица данных графика/);
 for(const id of ['oa-cafe-trend','oa-rental-trend'])assert.ok(opsHtml.includes(`id="${id}"`));
 assert.match(css,/\.oa-line-canvas\{display:block;width:100%;height:190px/);
 assert.match(source,/window\.addEventListener\('resize'/);
 for(const html of [opsHtml,financeHtml])assert.match(html,/class="theme-rental analytics-page"/);
 assert.match(css,/body\.analytics-page \.desk-chrome \.ops-nav\{display:flex/);
});

test('Populated overview draws cafe and rental trends with finite coordinates',async()=>{
 const page=await boot(opsHtml,'operations','/api/admin/operations-analytics?from=2026-10-01&to=2026-10-07',{
  cafe:{items:[{key:'coffee',name:'Кофе',quantity:3}],buckets:[],itemBuckets:[{itemKey:'coffee',day:'2026-10-01',hour:9,quantity:3}]},
  rental:{items:[{key:'sup',name:'SUP',unitMinutes:120}],buckets:[],itemBuckets:[{itemKey:'sup',day:'2026-10-01',hour:10,unitMinutes:120}]}
 });
 for(const kind of ['cafe','rental']){
  const canvas=page.elements.get(`oa-${kind}-trend`).children.find(e=>e.tagName==='canvas');
  assert.ok(canvas);assert.ok(canvas.drawCalls.some(call=>call.method==='stroke'));
  assert.ok(canvas.width>0);assert.ok(canvas.height>0);
  for(const call of canvas.drawCalls)for(const value of call.args)if(typeof value==='number')assert.ok(Number.isFinite(value));
 }
});

test('Daily bars aggregate repeated days, keep missing days as zero and unknown values explicit',()=>{
 const rows=helpers.dailySeries({buckets:[{day:'2026-10-01',quantity:2},{day:'2026-10-01',quantity:3},{day:'2026-10-03',quantity:null}],field:'quantity',from:'2026-10-01',to:'2026-10-03'});
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(row=>`${row.day}:${row.value}`).join(','),'2026-10-01:5,2026-10-02:0,2026-10-03:null');
 const money=helpers.dailySeries({buckets:[{day:'2026-10-01',contributionCents:-2500}],field:'contributionCents',from:'2026-10-01',to:'2026-10-01'});
 assert.equal(money[0].value,-2500);
});

test('Analytics rows and line spacing are compact without shrinking the primary touch controls',()=>{
 assert.match(css,/font:15px\/1\.25/);
 assert.match(css,/\.oa-cost-row\{[^}]*align-items:start[^}]*padding:8px 0;border-bottom:1px solid #[0-9a-f]{6}/);
 assert.match(css,/#operations-analytics \.oa-employee-bar\{min-height:24px;padding:2px 0/);
 assert.match(css,/\.oa-controls input[^}]*min-height:40px/);
 assert.match(css,/\.oa-tabs button\{[^}]*min-height:44px/);
});

test('Daily chart shows dates, visible horizontal bars and exact quantities, not orphan day numbers',async()=>{
 const page=await boot(opsHtml,'operations','/api/admin/operations-analytics?from=2026-10-01&to=2026-10-07',{
  cafe:{items:[],itemBuckets:[],buckets:[{day:'2026-10-01',hour:9,weekday:3,quantity:2},{day:'2026-10-01',hour:10,weekday:3,quantity:3},{day:'2026-10-03',hour:10,weekday:5,quantity:null}]},
  rental:{items:[],itemBuckets:[],buckets:[{day:'2026-10-01',hour:10,weekday:3,unitMinutes:120}]}
 });
 const rows=page.elements.get('oa-cafe-daily').children;
 assert.equal(rows.length,7);
 assert.equal(rows[0].children[0].textContent,'01.10');
 assert.equal(rows[0].children[1].children[0].style.width,'100%');
 assert.equal(rows[0].children[2].textContent,'5');
 assert.equal(rows[1].children[1].children[0].style.width,'0%');
 assert.equal(rows[1].children[2].textContent,'0');
 assert.equal(rows[2].children[2].textContent,'Нет данных');
 assert.match(page.elements.get('oa-rental-daily').children[0].children[2].textContent,/2.*ч/);
 assert.match(css,/\.oa-daily-item/);assert.match(css,/\.oa-daily-track/);
});

test('Cost writer is financial-owner gated and uses revision plus stable request ID',()=>{
 assert.match(source,/request\('\/api\/admin\/financial-analytics\/costs'/);
 assert.match(source,/requestId:crypto\.randomUUID\(\),revision:state\.costs\.revision,changes/);
 assert.match(source,/if\(e\.status===409\).*preserveDraft:true/);assert.match(source,/state\.canEdit=saved\.canEdit===true/);
 assert.match(source,/if\(state\.scope!=='financial'\|\|!state\.canEdit\)/);assert.match(source,/values\[input\.dataset\.field\]=null/);
 assert.doesNotMatch(source,/deliveryCostCents.*kind==='rental'/);
});

test('Reports remain read-only; scenario preserves unknown inputs and models explicit labor savings',()=>{
 assert.match(source,/method:'POST'/);assert.doesNotMatch(source,/fetch\(['"]https?:/i);assert.doesNotMatch(source,/sendBeacon|google-analytics|telemetry|mixpanel/i);
 assert.match(source,/response\.status===401|error\.status===401/);assert.match(source,/response\.status===403|error\.status===403/);
 assert.match(source,/Спрос и свободная мощность не гарантируются/);assert.match(source,/knownRentalCost\(\$\('oa-rental-equipment'\)\.value\)/);
 assert.match(source,/Нужен известный вклад кафе/);assert.match(source,/state\.scope==='financial'.*recalcScenario/s);
 assert.match(source,/const powered=kind==='rental'&&\['catamaran','electric'\]/);
 assert.match(css,/@media\(max-width:780px\)/);assert.doesNotMatch(css,/font-size\s*:\s*[^;]*vw/i);
});

test('Finance shows profit separately from cash movement, with unknown totals never rendered as zero',async()=>{
 const finance={profit:{netCents:null,overheadCents:null,confirmed:false},cashFlow:{netCents:12000,reviewCount:1},cafeResultCents:5000,rentalResultCents:7000,wageTotalCents:1000,wageEstimated:true};
 const page=await boot(financeHtml,'financial','/api/admin/financial-analytics?from=2026-10-01&to=2026-10-07',{finance});
 const kpis=page.elements.get('oa-kpis').children;
 assert.equal(kpis[0].children[0].textContent,'Прибыль · предварительно');
 assert.equal(kpis[0].children[1].textContent,'Не заполнено');
 assert.equal(kpis[1].children[1].textContent,'Не заполнено');
 assert.equal(kpis[2].children[0].textContent,'Движение денег · учтено');
 assert.match(kpis[2].children[1].textContent,/120/);
 assert.match(financeHtml,/data-tab="expenses"/);
 assert.match(financeHtml,/finance-expenses\.js\?v=finance-expenses-20261007-1/);
 assert.doesNotMatch(opsHtml,/finance-expenses\.js|fe-form|panel-expenses/);
});
