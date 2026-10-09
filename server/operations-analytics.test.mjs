import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsAnalytics,analyticsPeriod,splitService} from './operations-analytics.mjs';
import {cafeCostKey} from './operations-analytics-costs.mjs';

const DAY=86400000,HOUR=3600000,owner={id:1,role:'admin'},staff={id:2,role:'staff'},waiter={id:4,role:'waiter'};
const instant=s=>Date.parse(s+'+03:00');

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'owner','admin','unused'),(2,'staff','staff','unused'),(4,'waiter','waiter','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),analytics=new OperationsAnalytics(admin,cafe);
 t.after(()=>admin.close());
 return {admin,cafe,analytics};
}

function insertOrder(admin,{id,created,details,status='DELIVERED',totalCents=0}){
 admin.db.prepare('INSERT INTO cafe_orders(id,request_id,fingerprint,public_token,source,details,total_cents,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run(id,randomUUID(),'fixture','token-'+id,'admin',JSON.stringify(details),totalCents,status,created,created);
}
function event(admin,orderId,kind,created,body={}){
 admin.db.prepare('INSERT INTO cafe_order_events(order_id,kind,body,created) VALUES(?,?,?,?)').run(orderId,kind,JSON.stringify(body),created);
}
function setCosts(analytics,changes,now){
 const costs=analytics.costs;
 return costs.save({requestId:randomUUID(),revision:costs.revision(),changes},owner,now);
}
const cafeChange=(key,portionCents)=>({kind:'cafe',key,values:{portionCents}});
const rentalChange=(key,values)=>({kind:'rental',key,values});

test('analytics period validates calendar dates and caps inclusive ranges at 366 days',()=>{
 const now=instant('2026-10-07T12:00:00');
 assert.deepEqual(analyticsPeriod('2026-10-01','2026-10-07',now),{from:'2026-10-01',to:'2026-10-07',start:instant('2026-10-01T00:00:00'),end:instant('2026-10-08T00:00:00'),days:7,timezone:'Europe/Moscow'});
 assert.throws(()=>analyticsPeriod('2026-02-30','2026-03-01',now),/даты/i);
 assert.throws(()=>analyticsPeriod('2026-10-07','2026-10-06',now),/366 дней/i);
 assert.throws(()=>analyticsPeriod('2025-10-06','2026-10-07',now),/366 дней/i);
 assert.equal(analyticsPeriod('2025-10-07','2026-10-07',now).days,366);
});

test('splitService conserves every kopeck across hourly and midnight boundaries',()=>{
 const start=instant('2026-09-27T23:00:00'),end=instant('2026-09-28T01:00:00'),parts=splitService(start,end,1001);
 assert.deepEqual(parts.map(p=>[p.start,p.end,p.minutes,p.cents]),[[start,start+HOUR,60,500],[start+HOUR,end,60,501]]);
 assert.equal(parts.reduce((n,p)=>n+p.cents,0),1001);
 assert.deepEqual(splitService(end,start,1),[]);
});

test('cafe costs multiply portion and modifier unit costs by quantity exactly once',t=>{
 const {admin,cafe,analytics}=fixture(t),item=cafe.catalog().items.find(x=>x.groupIds.length),group=cafe.catalog().groups.find(g=>item.groupIds.includes(g.id)&&g.options.length),option=group.options[0],created=instant('2026-09-27T12:00:00'),key=cafeCostKey(item.id),optionKey=cafeCostKey(item.id,'option:'+option.id),quantity=3;
 setCosts(analytics,[cafeChange(key,101),cafeChange(optionKey,17)],created-1);
 const line={itemId:item.id,name:item.name,quantity,unitCents:1000,totalCents:3000,basePriceCents:1000,variant:null,modifiers:[{optionId:option.id,name:option.name,priceCents:1}],comment:'',station:'none'};
 insertOrder(admin,{id:1,created,details:{items:[line],payment:'cash',paymentMethod:'cash'},totalCents:3000});
 const report=analytics.financialReport({from:'2026-09-27',to:'2026-09-27'},owner,instant('2026-09-28T12:00:00'));
 const row=report.cafe.items.find(x=>x.key===key);
 assert.equal(row.quantity,quantity);
 assert.equal(row.costCents,(101+17)*quantity);
 assert.equal(row.revenueCents,3000);
});

test('complimentary cafe lines have zero revenue while prepared cancellation and refunds retain consumed cost',t=>{
 const {admin,cafe,analytics}=fixture(t),item=cafe.catalog().items[0],created=instant('2026-09-27T10:00:00'),key=cafeCostKey(item.id);
 setCosts(analytics,[cafeChange(key,250)],created-1);
 const line={itemId:item.id,name:item.name,quantity:2,unitCents:500,totalCents:1000,basePriceCents:500,variant:null,modifiers:[],comment:'',station:'none'};
 insertOrder(admin,{id:1,created,details:{items:[line],complimentary:{reason:'owner'},payment:'cash'},totalCents:0});
 insertOrder(admin,{id:2,created:created+1,details:{items:[line],payment:'cash',paymentMethod:'cash'},status:'CANCELLED',totalCents:1000});
 event(admin,2,'COOKING',created+2);
 insertOrder(admin,{id:3,created:created+3,details:{items:[line],payment:'cash',paymentMethod:'cash'},totalCents:1000});
 admin.db.prepare('INSERT INTO customer_refunds(request_id,fingerprint,kind,source_id,amount_cents,lines_json,reason,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)')
  .run(randomUUID(),'refund-fixture','cafe',3,500,JSON.stringify([{index:0,quantity:1,unitCents:500}]),'test',created+4,owner.id);
 const report=analytics.financialReport({from:'2026-09-27',to:'2026-09-27'},owner,instant('2026-09-28T12:00:00'));
 const normal=report.cafe.items.find(x=>x.key===key);
 assert.equal(report.cafe.complimentaryQuantity,2);
 assert.equal(report.cafe.unpaidQuantity,0);
 assert.equal(report.cafe.paymentReceiptsCents,1000);
 assert.equal(normal.revenueCents,500);
 assert.equal(normal.refundCents,500);
 assert.equal(normal.costCents,1500);
 assert.equal(normal.cancelledQuantity,2);
 assert.equal(normal.quantity,4);
});

test('rental service allocates paid cents and hourly cost across two hours crossing midnight',t=>{
 const {admin,analytics}=fixture(t),departed='2026-09-27T23:00',start=instant('2026-09-27T23:00:00'),end=instant('2026-09-28T01:00:00'),created=start-60000;
 setCosts(analytics,[rentalChange('sup',{issueCents:101,hourCents:50})],created-1);
 const rentalId=Number(admin.db.prepare('INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by,returned,returned_by,expected_return,initial_due,extension_due,people,custom_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(randomUUID(),'sup',1,'Guest','',departed,created,owner.id,end,owner.id,end,0,0,null,null).lastInsertRowid);
 admin.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(rentalId,1001,'cash','2026-09-27',start,owner.id,'fixture');
 const first=analytics.financialReport({from:'2026-09-27',to:'2026-09-27'},owner,end+HOUR).rental;
 const second=analytics.financialReport({from:'2026-09-28',to:'2026-09-28'},owner,end+HOUR).rental;
 const a=first.items.find(x=>x.key==='sup'),b=second.items.find(x=>x.key==='sup');
 assert.equal(a.revenueCents+b.revenueCents,1001);
 assert.equal(a.costCents+b.costCents,201);
 assert.equal(a.costCents,151);
 assert.equal(b.costCents,50);
 assert.equal(a.unitMinutes+b.unitMinutes,120);
});

test('catamaran energy cost is added only when electricity is not included',t=>{
 const {admin,analytics}=fixture(t),startA=instant('2026-09-27T10:00:00'),endA=startA+2*HOUR,createdA=startA-60000,startB=instant('2026-09-28T10:00:00'),endB=startB+2*HOUR,createdB=startB-60000;
 setCosts(analytics,[rentalChange('catamaran',{issueCents:101,hourCents:50,kwhPerHour:2,electricityTariffCents:100,electricityIncluded:0})],createdA-1);
 const insert=(departed,created,returned)=>admin.db.prepare('INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by,returned,returned_by,expected_return,initial_due,extension_due,people,custom_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(randomUUID(),'catamaran',1,'Guest','',departed,created,owner.id,returned,owner.id,returned,0,0,null,null);
 insert('2026-09-27T10:00',createdA,endA);
 setCosts(analytics,[rentalChange('catamaran',{electricityIncluded:1})],createdB-1);
 insert('2026-09-28T10:00',createdB,endB);
 const first=analytics.financialReport({from:'2026-09-27',to:'2026-09-27'},owner,endB+HOUR).rental.items.find(x=>x.key==='catamaran');
 const second=analytics.financialReport({from:'2026-09-28',to:'2026-09-28'},owner,endB+HOUR).rental.items.find(x=>x.key==='catamaran');
 assert.equal(first.costCents,601);
 assert.equal(second.costCents,201);
});

test('unpaid demand is counted and same-millisecond cost history stays conservatively unknown',t=>{
 const {admin,cafe,analytics}=fixture(t),item=cafe.catalog().items[0],created=instant('2026-09-27T10:00:00'),line={itemId:item.id,name:item.name,quantity:1,unitCents:500,totalCents:500,basePriceCents:500,variant:null,modifiers:[],comment:'',station:'none'};
 setCosts(analytics,[cafeChange(cafeCostKey(item.id),100)],created);
 insertOrder(admin,{id:1,created,details:{items:[line],payment:'unspecified',terminalPaymentRequired:true},status:'NEW',totalCents:500});
 const report=analytics.financialReport({from:'2026-09-27',to:'2026-09-27'},owner,instant('2026-09-28T12:00:00'));
 const row=report.cafe.items.find(x=>x.key===cafeCostKey(item.id));
 assert.equal(report.cafe.unpaidQuantity,1);
 assert.equal(row.unpaidQuantity,1);
 assert.equal(row.revenueCents,0);
 assert.equal(row.costCents,null);
 assert.equal(row.knownCostCents,0);
 assert.equal(row.missingCostCount,1);
 assert.equal(report.finance.cafeResultCents,null);
 assert.ok(report.warnings.some(w=>/не для всех операций/i.test(w)));
});

test('operational report is a safe staff projection; financial report remains owner-only',t=>{
 const {analytics}=fixture(t);
 for(const user of [staff,waiter]){
  const report=analytics.report({},user);
  assert.ok(report.period);
  assert.equal(Object.hasOwn(report,'finance'),false);
  assert.equal(Object.hasOwn(report.cafe,'paymentReceiptsCents'),false);
  assert.equal(Object.hasOwn(report.cafe,'paymentRefundsCents'),false);
  assert.equal(Object.hasOwn(report.cafe,'paymentNetCents'),false);
  assert.ok(Object.keys(report.cafe.totals).every(key=>['quantity','issues','units','unitMinutes'].includes(key)));
  assert.ok(report.cafe.items.every(row=>Object.keys(row).every(key=>!/(cents|revenue|cost|fee|wage|salary|profit|contribution)/i.test(key))));
 }
 assert.ok(analytics.financialReport({},owner).finance);
 for(const user of [{id:9,role:'guest'},null,{}, {id:10,role:'staff',scheduleOnly:true}])assert.throws(()=>analytics.report({},user),e=>e.status===403);
 for(const user of [staff,waiter,{id:9,role:'guest'},null,{}])assert.throws(()=>analytics.financialReport({},user),e=>e.status===403);
});
