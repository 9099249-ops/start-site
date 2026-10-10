import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {BatteryStateStore} from './battery-state.mjs';
import {BatteryTripStore} from './battery-trips.mjs';
import {OperationsAnalytics,analyticsPeriod,operationsAnalyticsHandler} from './operations-analytics.mjs';
import {cafeCostKey} from './operations-analytics-costs.mjs';

const owner={id:1,role:'admin'},staff={id:2,role:'staff'},scheduleOnly={id:3,role:'admin',scheduleOnly:true};
const local=(d,h='12:00')=>Date.parse(`${d}T${h}:00+03:00`);
const day='2026-10-08',next='2026-10-09',now=local(next,'23:00');
const period=(from=day,to=day)=>analyticsPeriod(from,to,now);
const labels=['Сашин','Наташин','С серой крышей'];

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'owner','admin','unused'),(2,'staff','staff','unused'),(3,'schedule','admin','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),analytics=new OperationsAnalytics(admin,cafe);
 const battery=new BatteryStateStore(admin);new BatteryTripStore(battery);
 t.after(()=>admin.close());
 return {admin,cafe,analytics,battery};
}

function costs(analytics,values={}){
 const changes=[{kind:'rental',key:'catamaran',values:{issueCents:0,hourCents:0,kwhPerHour:0,electricityTariffCents:0,electricityIncluded:1,...values}},
  {kind:'settings',key:'global',values:{rentalCardBps:0,cafeWageBps:0}}];
 analytics.costs.save({requestId:randomUUID(),revision:analytics.costs.revision(),changes},owner,local(day,'00:00')-1);
}

function rental(admin,{quantity=1,start=local(day,'10:00'),end=start+3600000,name='Guest',equipment='catamaran',created=start-60000}={}){
 return Number(admin.db.prepare('INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by,returned,returned_by,expected_return,initial_due,extension_due,people,custom_json,departed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(randomUUID(),equipment,quantity,name,'',new Date(start+10800000).toISOString().slice(0,16),created,owner.id,end,owner.id,end,0,0,null,null,start).lastInsertRowid);
}

function trip(admin,rentalId,label,{state='returned',createdAt=local(day,'09:00')}={}){
 const id=randomUUID();
 admin.db.prepare('INSERT INTO battery_trips(id,label,rental_id,state,created_at,updated_at,actor_id) VALUES(?,?,?,?,?,?,?)').run(id,label,rentalId,state,createdAt,createdAt,owner.id);
 return id;
}

function payment(admin,rentalId,amount,method,created){
 admin.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(rentalId,amount,method,new Date(created+10800000).toISOString().slice(0,10),created,owner.id,'finance fixture');
}

function refund(admin,rentalId,amount,created){
 admin.db.prepare('INSERT INTO customer_refunds(request_id,fingerprint,kind,source_id,amount_cents,lines_json,reason,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)')
  .run(randomUUID(),'refund-'+randomUUID(),'rental',rentalId,amount,'[]','fixture',created,owner.id);
}

function saveExpense(analytics,{name,department,amountCents,includedCents=0,catamaranLabel=null}){
 const entry={id:null,name,category:'repair',department,catamaranLabel,amountCents,includedCents,from:day,to:day,paidOn:null,method:'unpaid',withdrawalId:null,active:true};
 return analytics.expenses.save({requestId:randomUUID(),revision:analytics.expenses.revision(),action:'save',entry},period(),owner,now);
}

function paidCafeLine(admin,item,created,cents=101){
 const line={itemId:item.id,name:item.name,quantity:1,unitCents:cents,totalCents:cents,basePriceCents:cents,variant:null,modifiers:[],comment:'',station:'none'};
 admin.db.prepare('INSERT INTO cafe_orders(id,request_id,fingerprint,public_token,source,details,total_cents,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run(1,randomUUID(),'finance-cafe-fixture','finance-cafe-token','admin',JSON.stringify({items:[line],payment:'cash',paymentMethod:'cash'}),cents,'DELIVERED',created,created);
}

function closedPayroll(admin,salaryCents){
 const shift=admin.openShift({day,cashStartCents:0},owner,local(day,'00:01'));
 admin.db.prepare('UPDATE shifts SET closed_at=? WHERE id=?').run(local(next,'00:01'),shift);
 admin.db.prepare('INSERT INTO shift_employees(shift_id,user_id,fixed_cents,bonus_cents,salary_cents,worked_ms,calculation_json) VALUES(?,?,0,0,?,1,?)').run(shift,2,salaryCents,'{}');
 return shift;
}

function confirmExpenses(analytics,p=period()){
 analytics.expenses.save({requestId:randomUUID(),revision:analytics.expenses.revision(),action:'confirm',from:p.from,to:p.to,costRevision:analytics.costs.revision()},p,owner,now);
}

function catRows(analytics,p=period()){
 return analytics.financialReport({from:p.from,to:p.to},owner,now).finance.catamarans;
}

const requiredFields=['name','key','unknown','rentalsCount','unitMinutes','revenueCents','refundCents','costCents','electricityCents','otherDirectCostCents','electricityIncluded','feesCents','wagesCents','rentalOverheadCents','sharedOverheadCents','directOverheadCents','overheadCents','netCents','complete','estimated','paymentReceiptsCents','paymentRefundsCents','paymentCashCents','paymentCardCents','paymentUnknownCents'];

test('financial report contract retains zero-known costs, explicit unknown cost/fee and historical named labels',t=>{
 const {admin,analytics,battery}=fixture(t);costs(analytics);
 const id=rental(admin),old=trip(admin,id,'Сашин');trip(admin,id,'Сашин');
 const device=battery.manage({action:'create',requestId:randomUUID(),name:'Gateway',catamaranLabel:'Сашин',bmsId:'41:18:12:01:37:50'},owner,local(day,'08:00'));
 battery.manage({action:'update',requestId:randomUUID(),deviceId:device.device.deviceId,revision:device.device.revision,name:'Gateway',catamaranLabel:'Наташин'},owner,local(next,'08:00'));
 payment(admin,id,1001,'cash',local('2026-10-07','09:00'));
 refund(admin,id,101,local(next,'10:00'));
 const report=analytics.financialReport({from:day,to:day},owner,now),rows=report.finance.catamarans.rows,row=rows.find(item=>item.key==='catamaran:boat:Сашин');
 assert.ok(old);
 assert.ok(row);
 assert.deepEqual(requiredFields.filter(key=>!Object.hasOwn(row,key)),[]);
 assert.equal(row.rentalsCount,1);
 assert.equal(row.unitMinutes,60);
 assert.equal(row.revenueCents,900);
 assert.equal(row.refundCents,101);
 assert.equal(row.paymentReceiptsCents,0);
 assert.equal(row.paymentRefundsCents,0);
 assert.equal(row.paymentCashCents,0);
 assert.equal(row.costCents,0);
 assert.equal(row.electricityCents,0);
 assert.equal(row.otherDirectCostCents,0);
 assert.equal(row.electricityIncluded,true);
 assert.equal(row.unknown,false);
 assert.equal(rows.some(item=>item.key==='catamaran:unknown'),false);
 assert.equal(report.finance.catamarans.allocationBasis,'gross-revenue');
});

test('partial bindings and multiple boats conserve exact service and payment cents',t=>{
 const {admin,analytics}=fixture(t);costs(analytics,{issueCents:3,hourCents:0});
 const one=rental(admin,{quantity:2}),two=rental(admin,{quantity:2,start:local(day,'12:00')});
 trip(admin,one,'Сашин');trip(admin,one,'Наташин');trip(admin,one,'Наташин');
 trip(admin,two,'Сашин');
 payment(admin,one,101,'cash',local('2026-10-07','09:00'));payment(admin,two,202,'unspecified',local('2026-10-07','11:00'));
 closedPayroll(admin,7);
 confirmExpenses(analytics);
 const rows=catRows(analytics).rows,named=rows.filter(row=>!row.unknown&&row.rentalsCount),unknown=rows.find(row=>row.key==='catamaran:unknown');
 assert.equal(named.find(row=>row.key==='catamaran:boat:Сашин').rentalsCount,2);
 assert.equal(named.find(row=>row.key==='catamaran:boat:Наташин').rentalsCount,1);
 assert.equal(unknown.rentalsCount,1);
 assert.equal(rows.reduce((sum,row)=>sum+row.revenueCents,0),303);
 assert.equal(rows.reduce((sum,row)=>sum+row.paymentReceiptsCents,0),0);
 assert.equal(rows.reduce((sum,row)=>sum+row.costCents,0),12);
 assert.equal(rows.reduce((sum,row)=>sum+row.unitMinutes,0),240);
 assert.equal(rows.reduce((sum,row)=>sum+row.wagesCents,0),7);
 assert.equal(rows.reduce((sum,row)=>sum+row.paymentUnknownCents,0),0);
});

test('seven physical units split small cents exactly with nonnegative direct and electricity costs',t=>{
 const {admin,analytics}=fixture(t);costs(analytics,{hourCents:1,kwhPerHour:0.4,electricityTariffCents:1,electricityIncluded:0});
 const id=rental(admin,{quantity:7});
 for(const label of labels)trip(admin,id,label);
 payment(admin,id,700,'cash',local('2026-10-07','09:00'));
 const rows=catRows(analytics).rows.filter(row=>row.rentalsCount>0);
 assert.equal(rows.reduce((sum,row)=>sum+row.costCents,0),10);
 assert.equal(rows.reduce((sum,row)=>sum+row.electricityCents,0),3);
 assert.equal(rows.reduce((sum,row)=>sum+row.otherDirectCostCents,0),7);
 for(const row of rows){
  assert.ok(row.electricityCents>=0);
  assert.ok(row.otherDirectCostCents>=0);
  assert.equal(row.costCents,row.electricityCents+row.otherDirectCostCents);
 }
});

test('invalid service interval marks named costs and fees unknown instead of treating them as zero',t=>{
 const {admin,analytics}=fixture(t);costs(analytics);
 const start=local(day,'10:00'),id=rental(admin,{start,end:start});trip(admin,id,'Сашин');
 payment(admin,id,1000,'cash',local('2026-10-07','09:00'));
 confirmExpenses(analytics);
 const row=catRows(analytics).rows.find(item=>item.key==='catamaran:boat:Сашин');
 assert.equal(row.costCents,null);
 assert.equal(row.electricityCents,null);
 assert.equal(row.otherDirectCostCents,null);
 assert.equal(row.feesCents,null);
 assert.equal(row.netCents,null);
 assert.equal(row.complete,false);
 assert.equal(row.estimated,true);
});

test('overflowed labels and dismissed-only history are assigned to unknown without inventing boat attribution',t=>{
 const {admin,analytics}=fixture(t);costs(analytics);
 const tooMany=rental(admin,{quantity:1,start:local(day,'10:00')}),dismissed=rental(admin,{quantity:1,start:local(day,'12:00')});
 trip(admin,tooMany,'Сашин');trip(admin,tooMany,'Наташин');trip(admin,dismissed,'Серый',{state:'dismissed'});
 payment(admin,tooMany,100,'cash',local(day,'09:00'));payment(admin,dismissed,200,'cash',local(day,'11:00'));
 const report=catRows(analytics),unknown=report.rows.find(row=>row.unknown);
 assert.equal(unknown.rentalsCount,2);
 assert.equal(unknown.revenueCents,300);
 assert.equal(report.rows.find(row=>row.key==='catamaran:boat:Сашин').rentalsCount,0);
 assert.equal(report.rows.find(row=>row.key==='catamaran:boat:Наташин').rentalsCount,0);
});

test('no trip table and no rental history yield zero rows without accidental fleet attribution',t=>{
 const {admin,analytics}=fixture(t);
 admin.db.exec('DROP TABLE battery_trip_events; DROP TABLE battery_trip_requests; DROP TABLE battery_trips;');
 const result=analytics.financialReport({from:day,to:day},owner,now).finance.catamarans;
 assert.ok(result.rows.every(row=>row.rentalsCount===0&&row.revenueCents===0));
 assert.equal(result.rows.some(row=>row.key==='catamaran:unknown'&&row.unknown),false);
});

test('a historical boat named unknown cannot collide with the synthetic unassigned group',t=>{
 const {admin,analytics}=fixture(t);costs(analytics);
 const id=rental(admin,{quantity:2});trip(admin,id,'unknown');payment(admin,id,101,'cash',local(day,'09:00'));
 const rows=catRows(analytics).rows,boat=rows.find(row=>row.key==='catamaran:boat:unknown'),unassigned=rows.find(row=>row.key==='catamaran:unknown');
 assert.equal(boat.unknown,false);assert.equal(unassigned.unknown,true);
 assert.equal(boat.revenueCents+unassigned.revenueCents,101);
});

test('rental receipt and cash refund follow payment dates while service refund stays with its original rental',t=>{
 const {admin,analytics}=fixture(t);costs(analytics);
 const id=rental(admin,{start:local(day,'10:00'),end:local(day,'11:00')});trip(admin,id,'Сашин');
 payment(admin,id,1000,'card',local('2026-10-07','09:00'));refund(admin,id,200,local(next,'09:00'));
 const service=catRows(analytics),cash=catRows(analytics,period(next,next));
 const boat=service.rows.find(row=>row.key==='catamaran:boat:Сашин'),cashBoat=cash.rows.find(row=>row.key==='catamaran:boat:Сашин');
 assert.equal(boat.revenueCents,800);
 assert.equal(boat.refundCents,200);
 assert.equal(boat.paymentReceiptsCents,0);
 assert.equal(boat.paymentRefundsCents,0);
 assert.equal(cashBoat.revenueCents,0);
 assert.equal(cashBoat.paymentReceiptsCents,0);
 assert.equal(cashBoat.paymentRefundsCents,200);
});

test('unknown costs, fees and unconfirmed expenses remain incomplete; report is read-only and role gated',t=>{
 const {admin,analytics}=fixture(t);
 const id=rental(admin);trip(admin,id,'Сашин');payment(admin,id,1000,'unspecified',local('2026-10-07','09:00'));
 const before={payroll:admin.db.prepare('SELECT count(*) n FROM payroll_payments').get().n,cash:admin.db.prepare('SELECT count(*) n FROM cash_movements').get().n};
 const data=analytics.financialReport({from:day,to:day},owner,now),row=data.finance.catamarans.rows.find(item=>item.key==='catamaran:boat:Сашин');
 assert.equal(row.costCents,null);
 assert.equal(row.electricityCents,null);
 assert.equal(row.feesCents,null);
 assert.equal(row.paymentUnknownCents,0);
 assert.equal(row.complete,false);
 assert.equal(row.estimated,true);
 assert.equal(row.netCents,null);
 assert.equal(data.finance.catamarans.unallocated.wagesCents,null);
 assert.deepEqual({payroll:admin.db.prepare('SELECT count(*) n FROM payroll_payments').get().n,cash:admin.db.prepare('SELECT count(*) n FROM cash_movements').get().n},before);
 assert.equal(Object.hasOwn(analytics.report({from:day,to:day},staff,now),'finance'),false);
 assert.throws(()=>analytics.financialReport({from:day,to:day},staff,now),error=>error.status===403);
 assert.throws(()=>analytics.financialReport({from:day,to:day},scheduleOnly,now),error=>error.status===403);
});

test('financial analytics HTTP exposes catamarans only to admins and regular report omits finance',async t=>{
 const {admin,analytics}=fixture(t);costs(analytics);
 const id=rental(admin);trip(admin,id,'Сашин');payment(admin,id,1000,'cash',local('2026-10-07','09:00'));
 admin.user=token=>({owner,staff,schedule:scheduleOnly}[token]||null);
 const origin='http://finance.test',handler=operationsAnalyticsHandler(analytics,admin,origin),server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,origin))){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=(path,token)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{Cookie:`__Host-start_session=${token}`}});
 const regular=await request('/api/admin/operations-analytics?from='+day+'&to='+day,'staff');
 assert.equal(regular.status,200);
 assert.equal(Object.hasOwn(await regular.json(),'finance'),false);
 const denied=await request('/api/admin/financial-analytics?from='+day+'&to='+day,'staff');
 assert.equal(denied.status,403);
 assert.equal((await request('/api/admin/financial-analytics?from='+day+'&to='+day,'schedule')).status,403);
 const finance=await request('/api/admin/financial-analytics?from='+day+'&to='+day,'owner');
 assert.equal(finance.status,200);
 assert.ok((await finance.json()).finance.catamarans.rows.some(row=>row.key==='catamaran:boat:Сашин'));
});

test('confirmed zero activity expenses stay numeric but report unallocated pools instead of spreading fictitious amounts',t=>{
 const {analytics}=fixture(t);costs(analytics);confirmExpenses(analytics);
 const result=analytics.financialReport({from:day,to:day},owner,now).finance.catamarans;
 assert.equal(result.unallocated.rentalOverheadCents,0);
 assert.equal(result.unallocated.sharedOverheadCents,0);
 assert.equal(result.rows.every(row=>row.complete===true),true);
 assert.equal(result.rows.every(row=>row.netCents===0),true);
});

test('rental wage pool is split across SUP and named catamaran by gross revenue with the remainder conserved',t=>{
 const {admin,analytics}=fixture(t);costs(analytics);
 analytics.costs.save({requestId:randomUUID(),revision:analytics.costs.revision(),changes:[{kind:'rental',key:'sup',values:{issueCents:0,hourCents:0}}]},owner,local(day,'00:00'));
 const sup=rental(admin,{equipment:'sup',start:local(day,'10:00')}),boat=rental(admin,{start:local(day,'10:00')});trip(admin,boat,'Сашин');
 payment(admin,sup,101,'cash',local(day,'10:00'));payment(admin,boat,101,'cash',local(day,'10:00'));
 closedPayroll(admin,7);confirmExpenses(analytics);
 const report=analytics.financialReport({from:day,to:day},owner,now),row=report.finance.catamarans.rows.find(item=>item.key==='catamaran:boat:Сашин');
 assert.equal(report.finance.rentalWagesCents,7);
 assert.equal(row.wagesCents,4);
 assert.equal(report.finance.rentalWagesCents-row.wagesCents,3);
 assert.equal(row.revenueCents,101);
 assert.equal(report.rental.items.find(item=>item.key==='sup').revenueCents,101);
 assert.equal(row.wagesCents+(report.finance.rentalWagesCents-row.wagesCents),7);
});

test('shared overhead spans cafe, SUP and catamaran; Natas repair nets included cost once without changing global profit algebra',t=>{
 const {admin,cafe,analytics}=fixture(t);costs(analytics);
 const item=cafe.catalog().items[0],created=local(day,'10:00');
 analytics.costs.save({requestId:randomUUID(),revision:analytics.costs.revision(),changes:[
  {kind:'cafe',key:cafeCostKey(item.id),values:{portionCents:0}},
  {kind:'rental',key:'sup',values:{issueCents:0,hourCents:0}}
 ]},owner,local(day,'00:00'));
 paidCafeLine(admin,item,created);
 const sup=rental(admin,{equipment:'sup',start:created}),boat=rental(admin,{start:created});trip(admin,boat,'Наташин');
 payment(admin,sup,101,'cash',created);payment(admin,boat,101,'cash',created);
 saveExpense(analytics,{name:'Общие мелкие расходы',department:'shared',amountCents:7});
 saveExpense(analytics,{name:'Ремонт Наташиного катамарана',department:'rental',catamaranLabel:'Наташин',amountCents:11,includedCents:4});
 confirmExpenses(analytics);
 const report=analytics.financialReport({from:day,to:day},owner,now),catamarans=report.finance.catamarans.rows;
 const natas=catamarans.find(row=>row.key==='catamaran:boat:Наташин'),sasha=catamarans.find(row=>row.key==='catamaran:boat:Сашин');
 assert.equal(report.cafe.totals.revenueCents,101);
 assert.equal(report.rental.items.find(row=>row.key==='sup').revenueCents,101);
 assert.equal(natas.revenueCents,101);
 assert.equal(natas.directOverheadCents,7);
 assert.equal(natas.sharedOverheadCents,3);
 assert.equal(natas.rentalOverheadCents,0);
 assert.equal(sasha.directOverheadCents,0);
 assert.equal(report.finance.expenses.summary.knownOverheadCents,14);
 assert.equal(report.finance.profit.netCents,289);
 assert.equal(report.finance.profit.netCents,303-report.finance.profit.directCostCents-report.finance.profit.feesCents-report.finance.profit.wageCents-report.finance.profit.knownOverheadCents);
 assert.equal(report.finance.catamarans.rows.reduce((sum,row)=>sum+row.sharedOverheadCents,0),3);
});

test('predeparture catamaran payment is cashflow only and creates no service minutes, revenue or cost',t=>{
 const {admin,analytics}=fixture(t);costs(analytics);
 const id=rental(admin,{start:local(day,'10:00')});trip(admin,id,'Сашин');
 admin.db.prepare('UPDATE rentals SET departure_pending=1 WHERE id=?').run(id);
 payment(admin,id,1234,'cash',local(day,'09:00'));
 const report=analytics.financialReport({from:day,to:day},owner,now),row=report.finance.catamarans.rows.find(item=>item.key==='catamaran:boat:Сашин');
 assert.equal(row.paymentReceiptsCents,1234);
 assert.equal(row.paymentCashCents,1234);
 assert.equal(row.revenueCents,0);
 assert.equal(row.refundCents,0);
 assert.equal(row.unitMinutes,0);
 assert.equal(row.costCents,0);
 assert.equal(row.electricityCents,0);
 assert.equal(report.finance.cashFlow.receiptsCents,1234);
});

test('zero activity leaves nonzero wage and overhead pools unallocated and catamaran net unknown',t=>{
 const {analytics}=fixture(t);costs(analytics);closedPayroll(analytics.admin,7);
 saveExpense(analytics,{name:'Rental overhead',department:'rental',amountCents:9});
 saveExpense(analytics,{name:'Shared overhead',department:'shared',amountCents:11});
 confirmExpenses(analytics);
 const result=analytics.financialReport({from:day,to:day},owner,now).finance.catamarans;
 assert.equal(result.unallocated.wagesCents,7);
 assert.equal(result.unallocated.rentalOverheadCents,9);
 assert.equal(result.unallocated.sharedOverheadCents,11);
 assert.equal(result.rows.every(row=>row.netCents===null),true);
 assert.equal(result.rows.every(row=>row.complete===false),true);
});

test('a finished named rental stays preliminary while another rental is active in the same period',t=>{
 const {admin,analytics}=fixture(t);costs(analytics);confirmExpenses(analytics);
 const completed=rental(admin,{start:local(day,'10:00'),end:local(day,'11:00')}),active=rental(admin,{start:local(day,'10:30'),end:null});
 trip(admin,completed,'Наташин');trip(admin,active,'Сашин');
 payment(admin,completed,100,'cash',local(day,'10:00'));payment(admin,active,100,'cash',local(day,'10:30'));
 const report=analytics.financialReport({from:day,to:day},owner,now),rows=report.finance.catamarans.rows;
 const natas=rows.find(row=>row.key==='catamaran:boat:Наташин'),sasha=rows.find(row=>row.key==='catamaran:boat:Сашин');
 assert.ok(natas.revenueCents>0);
 assert.ok(sasha.revenueCents>0);
 assert.equal(report.rental.estimated,true);
 assert.equal(natas.complete,false);
 assert.equal(natas.estimated,true);
});
