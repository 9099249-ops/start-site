import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsAnalytics,analyticsPeriod} from './operations-analytics.mjs';
import {expenseAllocation,expenseDate,FinancialExpenses} from './financial-expenses.mjs';

const DAY=86400000,MSK=3*60*60*1000;
const local=(d,h='00:00')=>Date.parse(`${d}T${h}:00+03:00`);
const owner={id:1,role:'admin'},staff={id:2,role:'staff'},scheduleOnly={id:3,role:'admin',scheduleOnly:true};

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'owner','admin','unused'),(2,'staff','staff','unused'),(3,'schedule','admin','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});
 const analytics=new OperationsAnalytics(admin,cafe);
 t.after(()=>admin.close());
 return {admin,cafe,analytics,expenses:analytics.expenses,costs:analytics.costs};
}
const period=(from,to)=>analyticsPeriod(from,to,local(to,'23:00'));
function entry(overrides={}){return {name:'Тестовый расход',category:'rent',department:'shared',amountCents:10000,includedCents:0,from:'2024-02-01',to:'2024-02-29',paidOn:'2024-02-10',method:'bank',withdrawalId:null,active:true,...overrides};}
function save(expenses,p,u=owner,extra={},now=local('2024-03-01','12:00')){return expenses.save({requestId:randomUUID(),revision:expenses.revision(),action:'save',entry:entry(),...extra},p,u,now);}

test('expense dates and integer proration use Moscow calendar days, including leap February',()=>{
 assert.equal(expenseDate('2024-02-29'),local('2024-02-29'));
 assert.throws(()=>expenseDate('2023-02-29'));
 assert.equal(expenseAllocation(101,'2024-02-01','2024-02-29',local('2024-02-01'),local('2024-02-15')),48);
 assert.equal(expenseAllocation(101,'2024-02-01','2024-02-29',local('2024-02-15'),local('2024-03-01')),53);
 assert.equal(expenseAllocation(101,'2024-02-01','2024-02-29',local('2024-02-01'),local('2024-03-01')),101);
 assert.equal(expenseAllocation(101,'2024-02-01','2024-02-29',local('2024-03-01'),local('2024-04-01')),0);
});

test('unknown values remain unknown while explicit zero is a valid known amount',t=>{
 const {expenses}=fixture(t),p=period('2024-02-01','2024-02-29');
 save(expenses,p,owner,{entry:entry({amountCents:null,includedCents:null})});
 let result=expenses.report(p,local('2024-03-01'));
 assert.equal(result.summary.overheadCents,null);
 assert.equal(result.summary.unknownCount,1);
 assert.equal(result.rows[0].allocatedCents,null);
 const separate=fixture(t).expenses;
 save(separate,p,owner,{entry:entry({amountCents:0,includedCents:0})});
 result=separate.report(p,local('2024-03-01'));
 assert.equal(result.summary.overheadCents,0);
 assert.equal(result.summary.unknownCount,0);
});

test('cost already included is subtracted; stock, equipment and owner withdrawals affect cash only',t=>{
 const {expenses}=fixture(t),p=period('2024-02-01','2024-02-29'),now=local('2024-03-01');
 for(const [category,amount,included] of [['rent',10000,2500],['stock',4000,0],['equipment',5000,0],['owner',3000,0]])
  save(expenses,p,owner,{entry:entry({category,amountCents:amount,includedCents:included})});
 const result=expenses.report(p,now);
 assert.equal(result.summary.overheadCents,7500);
 assert.equal(result.summary.departments.shared,7500);
 assert.equal(result.summary.expensePaymentsCents,22000);
 assert.equal(result.summary.knownOverheadCents,7500);
});

test('unpaid expenses reduce accrued profit but do not count as cash payments',t=>{
 const {expenses}=fixture(t),p=period('2024-02-01','2024-02-29'),now=local('2024-03-01');
 save(expenses,p,owner,{entry:entry({amountCents:12000,includedCents:2000,method:'unpaid',paidOn:null})});
 const report=expenses.report(p,now);
 assert.equal(report.summary.overheadCents,10000);
 assert.equal(report.summary.expensePaymentsCents,0);
 assert.equal(report.rows[0].paidInPeriod,false);
});

test('accrual period and payment period are independent',t=>{
 const {expenses}=fixture(t),accrual=period('2024-02-01','2024-02-29'),march=period('2024-03-01','2024-03-31');
 save(expenses,accrual,owner,{entry:entry({paidOn:'2024-03-05'})},local('2024-03-31'));
 assert.equal(expenses.report(accrual,local('2024-03-31')).summary.overheadCents,10000);
 assert.equal(expenses.report(accrual,local('2024-03-31')).summary.expensePaymentsCents,0);
 assert.equal(expenses.report(march,local('2024-03-31')).summary.overheadCents,0);
 assert.equal(expenses.report(march,local('2024-03-31')).summary.expensePaymentsCents,10000);
});

test('linked cash withdrawal validates exact amount/date, cannot be linked twice, and appears once in cash flow',t=>{
 const {admin,expenses}=fixture(t),p=period('2024-02-01','2024-02-29'),now=local('2024-02-20','12:00');
 const shift=admin.openShift({day:'2024-02-20',cashStartCents:0},owner,now-1000);
 admin.addWithdrawal({shiftId:shift,amountCents:5000,comment:'Изъятие'},owner,now);
 const withdrawalId=admin.db.prepare('SELECT id FROM cash_movements').get().id;
 const linked=entry({category:'owner',amountCents:5000,paidOn:'2024-02-20',method:'withdrawal',withdrawalId});
 save(expenses,p,owner,{entry:linked},now);
 const first=expenses.report(p,now);
 assert.equal(first.rows[0].linkValid,true);
 assert.deepEqual(first.linkedWithdrawalIds,[withdrawalId]);
 const second=save(expenses,p,owner,{entry:entry({name:'Второй расход',method:'unpaid',paidOn:null})},now).rows.find(row=>row.name==='Второй расход').id;
 assert.throws(()=>save(expenses,p,owner,{entry:entry({...linked,id:second})},now),e=>e.status===409);
 const flow=expenses.cashFlow(p,now,{receiptsCents:0,refundsCents:0,feesCents:0});
 assert.equal(flow.expensePaymentsCents,5000);
 assert.equal(flow.withdrawalsCents,0);
 assert.equal(flow.netCents,-5000);
 const bad=entry({...linked,id:second,amountCents:4999});
 assert.throws(()=>save(expenses,p,owner,{entry:bad},now),/Сумма и дата/);
});

test('voided withdrawals invalidate the link and are no longer counted as paid expenses',t=>{
 const {admin,expenses,costs}=fixture(t),p=period('2024-02-01','2024-02-29'),now=local('2024-02-20','12:00');
 const shift=admin.openShift({day:'2024-02-20',cashStartCents:0},owner,now-1000);
 admin.addWithdrawal({shiftId:shift,amountCents:5000,comment:'Изъятие'},owner,now);
 const id=admin.db.prepare('SELECT id FROM cash_movements').get().id;
 save(expenses,p,owner,{entry:entry({category:'owner',amountCents:5000,paidOn:'2024-02-20',method:'withdrawal',withdrawalId:id})},now);
 admin.db.prepare('UPDATE cash_movements SET voided_at=? WHERE id=?').run(now+1,id);
 const result=expenses.report(p,now+2);
 assert.equal(result.rows[0].linkValid,false);
 assert.equal(result.summary.expensePaymentsCents,null);
 assert.equal(result.summary.unknownPayments,1);
 assert.deepEqual(result.linkedWithdrawalIds,[]);
 assert.throws(()=>expenses.save({requestId:randomUUID(),revision:expenses.revision(),action:'confirm',from:p.from,to:p.to,costRevision:costs.revision()},p,owner,now+2),/оплаты/i);
});

test('edits and voids append versions while preserving prior history; revision and request fingerprints are enforced',t=>{
 const {admin,expenses}=fixture(t),p=period('2024-02-01','2024-02-29'),requestId=randomUUID();
 const body={requestId,revision:0,action:'save',entry:entry()};
 const created=expenses.save(body,p,owner,local('2024-03-01'));
 const id=created.rows[0].id;
 assert.equal(expenses.save(body,p,owner,local('2024-03-02')).duplicate,true);
 assert.throws(()=>expenses.save({...body,entry:entry({id,amountCents:10001})},p,owner,local('2024-03-02')),e=>e.status===409);
 const revision=expenses.revision();
 expenses.save({requestId:randomUUID(),revision,action:'save',entry:entry({id,amountCents:8000})},p,owner,local('2024-03-03'));
 const afterEdit=expenses.revision();
 expenses.save({requestId:randomUUID(),revision:afterEdit,action:'save',entry:entry({id,amountCents:8000,active:false})},p,owner,local('2024-03-04'));
 assert.equal(admin.db.prepare('SELECT count(*) n FROM financial_expense_versions WHERE expense_id=?').get(id).n,3);
 assert.equal(JSON.parse(admin.db.prepare('SELECT body FROM financial_expense_versions WHERE expense_id=? ORDER BY id LIMIT 1').get(id).body).amountCents,10000);
 assert.equal(expenses.entries().find(row=>row.id===id).active,false);
 const stale={requestId:randomUUID(),revision:0,action:'save',entry:entry()};
 assert.throws(()=>expenses.save(stale,p,owner,local('2024-03-05')),e=>e.status===409);
});

test('confirmation is exact-period and invalidated by expense or cost revisions; only admins can manage it',t=>{
 const {expenses,costs}=fixture(t),p=period('2024-02-01','2024-02-29');
 save(expenses,p);
 const confirmation={requestId:randomUUID(),revision:expenses.revision(),action:'confirm',from:p.from,to:p.to,costRevision:costs.revision()};
 expenses.save(confirmation,p,owner,local('2024-03-01'));
 assert.equal(expenses.report(p,local('2024-03-01')).confirmed,true);
 assert.equal(expenses.report(period('2024-02-02','2024-02-29'),local('2024-03-01')).confirmed,false);
 costs.save({requestId:randomUUID(),revision:costs.revision(),changes:[{kind:'settings',key:'global',values:{cafeWageBps:0}}]},owner,local('2024-03-02'));
 assert.equal(expenses.report(p,local('2024-03-02')).confirmed,false);
 for(const user of [staff,scheduleOnly,null]){
  assert.throws(()=>expenses.catalog(p,user),e=>e.status===403);
  assert.throws(()=>expenses.save({requestId:randomUUID(),revision:expenses.revision(),action:'confirm',from:p.from,to:p.to,costRevision:costs.revision()},p,user),e=>e.status===403);
 }
});

test('unknown expense allocation marks its department unknown without erasing known departments',t=>{
 const {expenses}=fixture(t),p=period('2024-02-01','2024-02-29');
 save(expenses,p,owner,{entry:entry({department:'cafe',amountCents:null,includedCents:null})});
 save(expenses,p,owner,{entry:entry({department:'shared',amountCents:12000,includedCents:2000})});
 const departments=expenses.report(p,local('2024-03-01')).summary.departments;
 assert.equal(departments.cafe,null);
 assert.equal(departments.shared,10000);
 assert.equal(departments.rental,0);
});

test('an expense can be voided after its cash withdrawal is voided, without retaining a cash link',t=>{
 const {admin,expenses}=fixture(t),p=period('2024-02-01','2024-02-29'),now=local('2024-02-20','12:00');
 const shift=admin.openShift({day:'2024-02-20',cashStartCents:0},owner,now-1000);
 admin.addWithdrawal({shiftId:shift,amountCents:5000,comment:'Изъятие'},owner,now);
 const withdrawalId=admin.db.prepare('SELECT id FROM cash_movements').get().id;
 const created=save(expenses,p,owner,{entry:entry({category:'owner',amountCents:5000,paidOn:'2024-02-20',method:'withdrawal',withdrawalId})},now);
 const id=created.rows[0].id;
 admin.db.prepare('UPDATE cash_movements SET voided_at=? WHERE id=?').run(now+1,withdrawalId);
 expenses.save({requestId:randomUUID(),revision:expenses.revision(),action:'save',entry:entry({id,category:'owner',amountCents:5000,paidOn:'2024-02-20',method:'withdrawal',withdrawalId,active:false})},p,owner,now+2);
 const result=expenses.report(p,now+2);
 assert.deepEqual(result.rows,[]);
 assert.deepEqual(result.linkedWithdrawalIds,[]);
});

test('a confirmed current-day period remains preliminary until its calendar day ends',t=>{
 const {analytics,expenses,costs}=fixture(t),d='2026-10-07',p=period(d,d),now=local(d,'23:59');
 save(expenses,p,owner,{entry:entry({from:d,to:d,paidOn:d,amountCents:0,includedCents:0})},now);
 expenses.save({requestId:randomUUID(),revision:expenses.revision(),action:'confirm',from:p.from,to:p.to,costRevision:costs.revision()},p,owner,now);
 const result=analytics.financialReport({from:d,to:d},owner,now);
 assert.equal(result.finance.expenses.confirmed,true);
 assert.equal(result.finance.profit.confirmed,false);
});

test('a rental review item prevents confirmed financial profit for a closed period',t=>{
 const {admin,analytics,expenses,costs}=fixture(t),d='2026-10-05',p=period(d,d),now=local('2026-10-07','12:00');
 const created=local(d,'10:00'),returned=local(d,'09:00');
 admin.db.prepare('INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by,returned,returned_by,expected_return,initial_due,extension_due,people,custom_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(randomUUID(),'sup',1,'Guest','',`${d}T10:00`,created,owner.id,returned,owner.id,returned,0,0,null,null);
 save(expenses,p,owner,{entry:entry({from:d,to:d,paidOn:d,amountCents:0,includedCents:0})},now);
 expenses.save({requestId:randomUUID(),revision:expenses.revision(),action:'confirm',from:p.from,to:p.to,costRevision:costs.revision()},p,owner,now);
 const result=analytics.financialReport({from:d,to:d},owner,now);
 assert.equal(result.rental.reviewCount,1);
 assert.equal(result.rental.estimated,false);
 assert.equal(result.finance.expenses.confirmed,true);
 assert.equal(result.finance.profit.confirmed,false);
});

test('integrated financial profit has one total wage cost and does not expose staff salary allocations as expense',t=>{
 const {analytics,admin}=fixture(t),d='2026-10-06',p=period(d,d),now=local(d,'23:00');
 admin.db.prepare('INSERT INTO employee_profiles(user_id,display_name) VALUES(2,?)').run('Работник');
 admin.db.prepare('INSERT INTO employee_work_sessions(user_id,started_at,ended_at) VALUES(?,?,?)').run(2,local(d,'09:00'),local(d,'17:00'));
 const shift=admin.openShift({day:d,cashStartCents:0},owner,local(d,'08:00'));
 admin.db.prepare('INSERT INTO payroll_payments(shift_id,user_id,amount_cents,paid_at,paid_by) VALUES(?,?,?,?,?)').run(shift,2,100000,local(d,'18:00'),owner.id);
 const result=analytics.financialReport({from:d,to:d},owner,now);
 assert.equal(result.finance.profit.wageCents,250000);
 assert.equal(result.finance.profit.beforeGeneralCents,-250000);
 assert.equal(result.finance.profit.knownOverheadCents,0);
 assert.equal(result.finance.profit.netCents,-250000);
 assert.equal(Object.hasOwn(result.finance.profit,'employees'),false);
 assert.equal(result.finance.wageTotalCents,250000);
 assert.equal(result.finance.cashFlow.payrollCents,100000);
 assert.equal(result.finance.cashFlow.netCents,-100000);
 assert.equal(result.employees.find(row=>row.id===2).name,'Работник');
 assert.equal(Object.hasOwn(result.finance.profit,'salaryCents'),false);
});

test('cafe card commission rounds once per order and line allocations conserve that fee',t=>{
 const {admin,analytics}=fixture(t),d='2026-10-06',paidAt=local(d,'12:00'),p=period(d,d);
 analytics.costs.save({requestId:randomUUID(),revision:analytics.costs.revision(),changes:[{kind:'settings',key:'global',values:{cafeCardBps:50}}]},owner,paidAt-1);
 const line=(id,name)=>({itemId:id,name,quantity:1,unitCents:100,totalCents:100,basePriceCents:100,variant:null,modifiers:[],comment:'',station:'none'});
 admin.db.prepare('INSERT INTO cafe_orders(id,request_id,fingerprint,public_token,source,details,total_cents,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run(1,randomUUID(),'commission-fixture','commission-token','admin',JSON.stringify({name:'Тест',fulfillment:'pickup',items:[line('item-a','Первый'),line('item-b','Второй')],paymentMethod:'card',terminalPaidAt:paidAt}),200,'DELIVERED',paidAt,paidAt);
 const result=analytics.financialReport({from:d,to:d},owner,local(d,'23:00'));
 assert.equal(result.cafe.totals.feesCents,1);
 assert.equal(result.cafe.items.reduce((sum,item)=>sum+item.feesCents,0),1);
 assert.equal(result.finance.cashFlow.feesCents,1);
});
