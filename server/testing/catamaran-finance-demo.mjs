// Fictional, isolated preview for per-catamaran finance. No real integrations are enabled.
// Run: node server/testing/catamaran-finance-demo.mjs
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {AdminStore} from '../admin.mjs';
import {CafeStore} from '../cafe.mjs';
import {SmsStore} from '../sms.mjs';
import {OperationsAnalytics,analyticsPeriod} from '../operations-analytics.mjs';
import {BatteryStateStore} from '../battery-state.mjs';
import {BatteryTripStore} from '../battery-trips.mjs';

const day='2026-10-09';
const local=(time)=>Date.parse(`${day}T${time}:00+03:00`);
const labels=['Сашин','Наташин','С серой крышей'];
const blockedPorts=[14973,14974];

function available(port){
 return new Promise(resolve=>{
  const probe=net.createServer();
  probe.once('error',()=>resolve(false));
  probe.listen(port,'127.0.0.1',()=>probe.close(()=>resolve(true)));
 });
}

async function selectPort(){
 for(const port of blockedPorts)if(await available(port))return port;
 throw new Error('Ports 14973 and 14974 are both occupied.');
}

if(process.argv.includes('--check')){
 console.log('Catamaran finance demo helper syntax OK.');
 process.exit(0);
}

const port=await selectPort();
const folder=mkdtempSync(path.join(tmpdir(),'catamaran-finance-demo-'));
const dbPath=path.join(folder,'demo.sqlite');
for(const name of Object.keys(process.env))if(/^(SMS|TELEGRAM|AQSI|PRINT|BOOKING_GUARD|METRIKA|UX_AUDIT)/i.test(name))process.env[name]='';
Object.assign(process.env,{
 PORT:String(port),SITE_ORIGIN:`http://127.0.0.1:${port}`,BOOKING_DB:dbPath,
 SMS_ENABLED:'false',SMSAERO_EMAIL:'',SMSAERO_API_KEY:'',
 TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TELEGRAM_OWNER_CHAT_ID:'',
 AQSI_ENABLED:'',AQSI_CAFE_ENABLED:'',AQSI_RENTAL_ENABLED:'',AQSI_LOGIN:'',AQSI_PASSWORD:'',
 PRINT_ENABLED:'false',PRINT_AGENT_TOKEN:'',PRINT_AGENT_DATABASE_ID:'',
 METRIKA_COUNTER_ID:'',UX_AUDIT_ENABLED:'0',UX_AUDIT_DIR:''
});
globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({}),text:async()=>''});

const admin=new AdminStore(dbPath);
admin.setupToken('catamaran-finance-demo-setup');
admin.setup({token:'catamaran-finance-demo-setup',adminPassword:'demo-admin-123456',staffPassword:'demo-staff-123456'},'127.0.0.1');
const owner={id:1,login:'admin',role:'admin'};
const staff={id:2,login:'station',role:'staff'};
const sms=new SmsStore(admin,null,{env:{}});
const cafe=new CafeStore(admin,sms,{env:{}});
const battery=new BatteryStateStore(admin);
new BatteryTripStore(battery);
const analytics=new OperationsAnalytics(admin,cafe);
const costs=analytics.costs;

const rentals=[
 {label:'Сашин',start:'10:00',end:'12:00',amount:1200000,method:'cash'},
 {label:'Наташин',start:'11:00',end:'14:00',amount:1800000,method:'card'},
 {label:'С серой крышей',start:'13:00',end:'15:00',amount:1400000,method:'card'},
 {label:null,start:'16:00',end:'17:00',amount:700000,method:'cash'}
];
const db=admin.db;
for(const [index,row] of rentals.entries()){
 const start=local(row.start),end=local(row.end),created=start-3600000;
 const id=Number(db.prepare(`INSERT INTO rentals
  (request_id,equipment,quantity,name,phone,departed,created,created_by,returned,returned_by,revision,expected_return,initial_due,extension_due,people,custom_json,departure_pending,departed_at)
  VALUES(?,'catamaran',1,'Демо-гость','',?,?,?,?,?,0,?,0,0,2,NULL,0,?)`).run(randomUUID(),day+'T'+row.start,created,owner.id,end,owner.id,end,start).lastInsertRowid);
 const paidAt=start+1800000;
 db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(id,row.amount,row.method,day,paidAt,staff.id,'Fictional demo receipt');
 const label=row.label??'Неизвестный катамаран';
 if(row.label){
  const tripId=randomUUID();
  db.prepare("INSERT INTO battery_trips(id,label,rental_id,state,created_at,updated_at,actor_id,confirmed_departure_at,confirmed_return_at) VALUES(?,?,?,'returned',?,?,?, ?,?)").run(tripId,label,id,start,start,staff.id,start,end);
  db.prepare("INSERT INTO battery_trip_events(trip_id,kind,actor_id,created_at) VALUES(?,'rental-departure-confirmed',?,?)").run(tripId,staff.id,start);
  db.prepare("INSERT INTO battery_trip_events(trip_id,kind,actor_id,created_at) VALUES(?,'rental-return-confirmed',?,?)").run(tripId,staff.id,end);
 }
 if(index===1){
  const refundAt=local('15:30');
  const refundId=Number(db.prepare(`INSERT INTO customer_refunds
   (request_id,fingerprint,kind,source_id,amount_cents,lines_json,reason,created_at,created_by,method)
   VALUES(?,?,'rental',?,300000,'[]','Fictional partial refund',?,?, 'card')`).run(randomUUID(),'demo-'+randomUUID(),id,refundAt,owner.id).lastInsertRowid);
  db.prepare('INSERT INTO refund_allocations(refund_id,sale_key,original_day,original_at,amount_cents) VALUES(?,?,?,?,?)').run(refundId,'rental-'+id,day,paidAt,300000);
 }
}

const costChanges=[
 {kind:'rental',key:'catamaran',values:{issueCents:250,hourCents:1750,kwhPerHour:1.4,electricityTariffCents:920,electricityIncluded:0}},
 {kind:'settings',key:'global',values:{cafeCardBps:200,rentalCardBps:200,cafeWageBps:3000}}
];
costs.save({requestId:randomUUID(),revision:costs.revision(),changes:costChanges},owner,Date.parse('2026-09-30T12:00:00+03:00'));

const period=analyticsPeriod(day,day,local('23:00'));
function saveExpense(entry){
 const revision=analytics.expenses.revision();
 analytics.expenses.save({requestId:randomUUID(),revision,action:'save',entry:{
  id:null,category:'repair',department:'shared',catamaranLabel:null,amountCents:600000,includedCents:0,
  from:day,to:day,paidOn:day,method:'bank',withdrawalId:null,active:true,...entry
 }},period,owner,local('22:00'));
}
saveExpense({name:'Общие расходы демо',department:'shared'});
saveExpense({name:'Ремонт катамарана Наташин',department:'rental',catamaranLabel:'Наташин',amountCents:120000});
analytics.expenses.save({requestId:randomUUID(),revision:analytics.expenses.revision(),action:'confirm',from:period.from,to:period.to,costRevision:costs.revision()},period,owner,local('22:01'));

// Closed shift data is a fixture because payroll snapshots must remain immutable.
const shiftId=Number(db.prepare(`INSERT INTO shifts(day,opened_at,opened_by,cash_start_cents,closed_at,closed_by,cash_end_cents,cashless_cents,cash_revenue_cents,total_revenue_cents,bonus_pool_cents)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(day,local('08:00'),owner.id,0,local('22:00'),owner.id,1900000,2900000,1900000,4800000,0).lastInsertRowid);
db.prepare('INSERT INTO shift_employees(shift_id,user_id,fixed_cents,bonus_cents,salary_cents) VALUES(?,?,?,?,?)').run(shiftId,staff.id,720000,0,720000);
db.prepare('INSERT INTO payroll_payments(shift_id,user_id,amount_cents,paid_at,paid_by,method,request_id) VALUES(?,?,?,?,?,?,?)').run(shiftId,staff.id,720000,local('22:05'),owner.id,'cash',randomUUID());

admin.close();
console.log(`DEMO ONLY: all prices and records are fictional; outbound integrations are disabled and fetch is mocked.`);
console.log(`Login: admin / demo-admin-123456 (staff account: station / demo-staff-123456)`);
console.log(`Database folder: ${folder}`);
console.log(`Preview: http://127.0.0.1:${port}/admin/financial-analytics/ (select 2026-10-09)`);
await import('../server.mjs');
