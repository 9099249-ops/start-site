import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {SmsStore} from './sms.mjs';
import {CafeStore} from './cafe.mjs';
import {OperationsAnalytics,operationsAnalyticsHandler} from './operations-analytics.mjs';
import {cafeCostKey} from './operations-analytics-costs.mjs';

async function fixture(t){
 const admin=new AdminStore(':memory:');admin.setupToken('test');admin.setup({token:'test',adminPassword:'owner-only-test',staffPassword:'staff-only-test'},'test');
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),store=new OperationsAnalytics(admin,cafe),origin='http://station.test';
 const tokens={owner:admin.login({login:'admin',password:'owner-only-test'},'owner'),staff:admin.login({login:'station',password:'staff-only-test'},'staff')};
 const handler=operationsAnalyticsHandler(store,admin,origin),server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,origin))){res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.close();server.closeAllConnections();await once(server,'close');admin.close();});
 const request=(path='',options={},who='owner',financial=false)=>fetch('http://127.0.0.1:'+server.address().port+'/api/admin/'+(financial?'financial-analytics':'operations-analytics')+path,{...options,headers:{...(who?{cookie:'__Host-start_session='+tokens[who]}:{}),...options.headers}});
 return {admin,cafe,store,origin,request};
}
test('operations analytics HTTP: staff read access, private cache and HEAD',async t=>{
 const {admin,cafe,request}=await fixture(t);
 assert.equal((await request('',{},null)).status,401);assert.equal((await request('',{},'staff')).status,200);
 const now=Date.now();cafe.db.prepare("INSERT INTO cafe_orders(request_id,fingerprint,public_token,source,details,total_cents,status,created,updated) VALUES(?,?,?,'customer_web',?,0,'DELIVERED',?,?)")
  .run(randomUUID(),'private-fixture','private-token',JSON.stringify({name:'PRIVATE_CUSTOMER_NAME',phone:'+79990001122',items:[]}),now,now);
 const before=admin.db.prepare('SELECT total_changes() n').get().n;
 const response=await request();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const data=await response.json();assert.ok(data.period);assert.equal(admin.db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(Object.hasOwn(data,'finance'),false);
 assert.equal(JSON.stringify(data).includes('Cents'),false);
 assert.equal((await request('',{},'staff')).status,200);
 const ownerFinancial=await request('',{},'owner',true);assert.equal(ownerFinancial.status,200);assert.ok((await ownerFinancial.json()).finance);
 assert.equal((await request('',{},'staff',true)).status,403);
 assert.equal((await request('/costs',{},'staff',true)).status,403);
 assert.equal((await request('/costs',{},'owner',true)).status,200);
 assert.equal((await request('/costs',{},'staff')).status,404);
 assert.equal(JSON.stringify(data).includes('password'),false);assert.equal(JSON.stringify(data).includes('public_token'),false);assert.equal(JSON.stringify(data).includes('PRIVATE_CUSTOMER'),false);assert.equal(JSON.stringify(data).includes('+79990001122'),false);
 const head=await request('',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 assert.equal((await request('/missing')).status,404);assert.equal((await request('',{method:'DELETE'})).status,405);
});
test('operations analytics HTTP: cost writes validate origin/type/body, revision and safe retry',async t=>{
 const setup=await fixture(t),{store,cafe,origin}=setup,request=(path,options,who='owner')=>setup.request(path,options,who,true),key=cafeCostKey(cafe.catalog().items[0].id),payload={requestId:randomUUID(),revision:0,changes:[{kind:'cafe',key,values:{portionCents:1234}}]};
 const options={method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(payload)};
 assert.equal((await request('/costs',{...options,headers:{origin:'http://evil.test','content-type':'application/json'}})).status,403);
 assert.equal((await request('/costs',{...options,headers:{origin,'content-type':'text/plain'}})).status,403);
 assert.equal((await request('/costs',{...options,body:'{' })).status,400);
 assert.equal((await request('/costs',options,'staff')).status,403);assert.equal(store.costs.revision(),0);
 const saved=await request('/costs',options);assert.equal(saved.status,200);
 const again=await request('/costs',options);assert.equal((await again.json()).duplicate,true);assert.equal(store.costs.revision(),1);
 const stale=await request('/costs',{...options,body:JSON.stringify({...payload,requestId:randomUUID()})});assert.equal(stale.status,409);
 const invalid=await request('/costs',{...options,body:JSON.stringify({...payload,requestId:randomUUID(),revision:1,changes:[{kind:'cafe',key,values:{portionCents:-1}}]})});assert.equal(invalid.status,400);assert.equal(store.costs.revision(),1);
 const dates=await request('?from=2026-02-30&to=2026-03-01');assert.equal(dates.status,400);
});

test('financial expenses HTTP: owner-only writes, safe retry and staff report isolation',async t=>{
 const {request,origin}=await fixture(t),today=new Date(Date.now()+10800000).toISOString().slice(0,10),path='/expenses?from='+today+'&to='+today;
 assert.equal((await request(path,{},null,true)).status,401);
 assert.equal((await request(path,{},'staff',true)).status,403);
 assert.equal((await request(path,{},'staff',false)).status,404);
 const data=await (await request(path,{},'owner',true)).json();
 assert.equal(data.revision,0);assert.equal(data.confirmed,false);
 const payload={requestId:randomUUID(),revision:0,action:'save',entry:{id:null,name:'Аренда',category:'rent',department:'shared',amountCents:310000,includedCents:0,from:today,to:today,method:'unpaid',paidOn:null,withdrawalId:null,active:true}};
 const options={method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(payload)};
 assert.equal((await request(path,{...options,headers:{origin:'http://evil.test','content-type':'application/json'}},'owner',true)).status,403);
 assert.equal((await request(path,options,'staff',true)).status,403);
 assert.equal((await request(path,{...options,body:'{'},'owner',true)).status,400);
 assert.equal((await request(path,{...options,body:' '.repeat(131073)},'owner',true)).status,413);
 const saved=await request(path,options,'owner',true);assert.equal(saved.status,200);assert.equal((await saved.json()).rows.length,1);
 assert.equal((await (await request(path,options,'owner',true)).json()).duplicate,true);
 assert.equal((await request(path,{...options,body:JSON.stringify({...payload,requestId:randomUUID()})},'owner',true)).status,409);
 const privateReport=await (await request('?from='+today+'&to='+today,{},'owner',true)).json();
 assert.equal(privateReport.finance.profit.overheadCents,310000);assert.equal(privateReport.finance.profit.netCents,-310000);
 assert.equal(privateReport.finance.cashFlow.expensePaymentsCents,0);
 const staff=await (await request('?from='+today+'&to='+today,{},'staff')).json();
 assert.equal(JSON.stringify(staff).includes('Cents'),false);assert.equal(Object.hasOwn(staff,'finance'),false);
 const head=await request(path,{method:'HEAD'},'owner',true);assert.equal(head.status,200);assert.equal(await head.text(),'');
});
