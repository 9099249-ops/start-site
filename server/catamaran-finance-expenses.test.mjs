import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsAnalytics,analyticsPeriod} from './operations-analytics.mjs';

const owner={id:1,role:'admin'},staff={id:2,role:'staff'};
const local=(d,h='12:00')=>Date.parse(`${d}T${h}:00+03:00`);
const day='2026-10-08',now=local(day,'23:00');
const period=analyticsPeriod(day,day,now);

function fixture(t){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'owner','admin','unused'),(2,'staff','staff','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}}),analytics=new OperationsAnalytics(admin,cafe);
 t.after(()=>admin.close());
 return {admin,analytics,expenses:analytics.expenses};
}

function expense(overrides={}){
 return {id:null,name:'Расход катамарана',category:'repair',department:'rental',amountCents:10001,includedCents:1001,from:day,to:day,paidOn:day,method:'bank',withdrawalId:null,catamaranLabel:null,active:true,...overrides};
}

function save(expenses,row,requestId=randomUUID()){
 return expenses.save({requestId,revision:expenses.revision(),action:'save',entry:row},period,owner,now);
}

test('rental expense labels are nullable and append with the versioned expense while included costs reduce allocation',t=>{
 const {expenses}=fixture(t);
 const created=save(expenses,expense({catamaranLabel:'Сашин'}));
 assert.deepEqual(created.catamaranLabels,['Сашин','Наташин','С серой крышей']);
 const id=created.rows.find(row=>row.name==='Расход катамарана').id;
 assert.ok(id);
 assert.equal(created.rows.find(row=>row.id===id).catamaranLabel,'Сашин');
 assert.equal(created.rows.find(row=>row.id===id).allocatedCents,9000);

 const revised=save(expenses,expense({id,amountCents:14001,includedCents:1001,catamaranLabel:null}));
 const row=revised.rows.find(item=>item.id===id);
 assert.equal(row.catamaranLabel,null);
 assert.equal(row.allocatedCents,13000);
 assert.equal(expenses.db.prepare('SELECT count(*) n FROM financial_expense_versions WHERE expense_id=?').get(id).n,2);
});

test('named rental expense is charged only to its boat and an unlabelled rental expense remains rental-wide',t=>{
 const {expenses,analytics}=fixture(t);
 save(expenses,expense({name:'Сашин борт',amountCents:10001,includedCents:1,catamaranLabel:'Сашин'}));
 save(expenses,expense({name:'Общий ремонт',amountCents:20003,includedCents:3,catamaranLabel:null}));
 const result=analytics.financialReport({from:day,to:day},owner,now),rows=result.finance.catamarans.rows;
 const named=rows.find(row=>row.key==='catamaran:boat:Сашин'),other=rows.find(row=>row.key==='catamaran:boat:Наташин'),unknown=rows.find(row=>row.unknown);
 assert.ok(named);
 assert.equal(named.directOverheadCents,10000);
 assert.equal(other.directOverheadCents,0);
 assert.equal(unknown,undefined);
 assert.equal(result.finance.catamarans.unallocated.rentalOverheadCents,20000);
 assert.equal(rows.reduce((sum,row)=>sum+(row.directOverheadCents||0),0),10000);
});

test('catamaranLabel is accepted only for rental-department expenses and owner retry remains idempotent',t=>{
 const {expenses}=fixture(t),requestId=randomUUID(),body={requestId,revision:0,action:'save',entry:expense({catamaranLabel:'Наташин'})};
 const created=expenses.save(body,period,owner,now);
 assert.equal(expenses.save(body,period,owner,now+1).duplicate,true);
 assert.equal(expenses.revision(),1);
 assert.throws(()=>expenses.save({requestId:randomUUID(),revision:1,action:'save',entry:expense({department:'shared',catamaranLabel:'Наташин'})},period,owner,now+2),/катамаран|подразделен/i);
 assert.throws(()=>expenses.save({requestId:randomUUID(),revision:1,action:'save',entry:expense({department:'cafe',catamaranLabel:'Наташин'})},period,owner,now+2),/катамаран|подразделен/i);
 assert.equal(expenses.revision(),1);
 assert.ok(created.rows.some(row=>row.catamaranLabel==='Наташин'));
 assert.throws(()=>expenses.catalog(period,staff,now),error=>error.status===403);
});
