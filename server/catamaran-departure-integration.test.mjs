import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {AdminStore,adminHandler,fleet} from './admin.mjs';
import {departRental} from './rental-departure.mjs';
import {CafeStore} from './cafe.mjs';
import {CafeBoard} from './cafe-board.mjs';
import {SmsStore} from './sms.mjs';
import {OperationsAnalytics,analyticsPeriod} from './operations-analytics.mjs';
import {GuestBills} from './guest-bills.mjs';
import {AqsiRental} from './aqsi-rental.mjs';
import {calendarData} from './calendar.mjs';

const now=Date.parse('2026-10-08T12:00:00+03:00'),owner={id:1,role:'admin'};
function fixture(t){
 const store=new AdminStore(':memory:');
 store.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");
 store.workforce.requireOnDuty=()=>{};
 const cafe=new CafeStore(store,new SmsStore(store,null,{}));
 t.after(()=>store.close());
 const create=extra=>store.create({requestId:randomUUID(),equipment:'catamaran',quantity:1,name:'Test',phone:'+79000000000',departed:'2026-10-08T12:00',expectedReturn:'2026-10-08T13:00',amount:'1000',method:'cash',...extra},owner,now);
 return {store,cafe,create,row:id=>store.db.prepare('SELECT * FROM rentals WHERE id=?').get(id)};
}
test('On-water board counts only physical departures; payments remain in the financial report during waiting',t=>{
 const f=fixture(t),id=f.create(),board=new CafeBoard(f.cafe),analytics=Object.assign(Object.create(OperationsAnalytics.prototype),{db:f.store.db});
 const costs=()=>({issueCents:100,hourCents:200,electricityIncluded:1,rentalCardBps:0});
 const period=analyticsPeriod('2026-10-08','2026-10-08',now+3600000);
 let report=analytics.rentalReport(period,costs,now+1800000);
 assert.equal(board.snapshot(now+1800000).onWaterCount,0);
 assert.equal(report.totals.unitMinutes,0);assert.equal(report.totals.costCents,0);
 assert.equal(report.paymentReceiptsCents,100000);assert.equal(report.estimated,false);
 departRental(f.store,fleet,{id,revision:0},owner,now+1800000);
 report=analytics.rentalReport(period,costs,now+3600000);
 assert.equal(board.snapshot(now+3600000).onWaterCount,1);
 assert.equal(report.totals.unitMinutes,30);assert.equal(report.totals.costCents,200);
 assert.equal(report.paymentReceiptsCents,100000);
});
test('An online booking shows pending departure after payment, then preserves one reservation when started',t=>{
 const f=fixture(t),booking=f.store.receive(randomUUID(),{equipment:'catamaran',quantity:1,plan:'hour',duration:1,date:'2026-10-08',time:'12:00',name:'Test',phone:'+79000000000'},now);
 f.store.inquiryStatus({id:booking,revision:0,status:'confirmed'},owner,now);
 const id=f.create({inquiryId:booking});
 assert.equal(calendarData(f.store,fleet,'2026-10-08',1,now).rows[0].state,'departure_pending');
 departRental(f.store,fleet,{id,revision:0},owner,now+1800000);
 const row=calendarData(f.store,fleet,'2026-10-08',1,now+1800000).rows[0];
 assert.equal(row.state,'issued');assert.equal(row.start,now+1800000);
 assert.equal(f.store.dashboard('2026-10-08',owner).fleet.find(r=>r.id==='catamaran').available,2);
});
test('Deferred guest-bill rules remain unchanged but require explicit departure',t=>{
 const f=fixture(t),connection={read:()=>({}),request:()=>{throw Error('External calls forbidden');}};
 f.store.guestBills=new GuestBills(f.store,connection,f.cafe);
 const bill=f.store.guestBills.create({requestId:randomUUID(),name:'Guest',location:'',phone:'+79000000000',deferred:true},owner,now);
 const id=f.create({guestBillId:bill.id});
 assert.equal(f.row(id).initial_due,0);assert.equal(f.row(id).departure_pending,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM payments').get().n,0);
 departRental(f.store,fleet,{id,revision:0},owner,now+1800000);
 assert.equal(f.row(id).departure_pending,0);
 assert.equal(f.store.guestBills.get(bill.id).paid_at,null);
});
test('Confirmed card accounting clears payment due without marking departure; departure sends no new charge',t=>{
 const f=fixture(t),connection={read:()=>({}),request:()=>{throw Error('External calls forbidden');}};
 const terminal=new AqsiRental(f.store,connection,{enabled:true});f.store.rentalTerminal=terminal;
 const id=f.create(),payment=randomUUID();
 f.store.db.prepare("INSERT INTO aqsi_rental(id,request_id,device_id,amount,state,created,updated,actor,slip) VALUES(?,?,?,?, 'paid',?,?,?,?)").run(payment,randomUUID(),1,100000,now,now,owner.id,JSON.stringify({content:{dateTime:new Date(now).toISOString()}}));
 f.store.db.prepare('INSERT INTO aqsi_rental_links VALUES(?,?,?,NULL)').run(id,'issue',payment);
 f.store.workforce.tx(()=>terminal.account(terminal.row(payment)));
 assert.equal(f.row(id).initial_due,0);assert.equal(f.row(id).departure_pending,1);
 assert.throws(()=>departRental(f.store,fleet,{id,revision:f.row(id).revision},owner,now+1800000),/оплату/);
 terminal.set(payment,'done');
 departRental(f.store,fleet,{id,revision:f.row(id).revision},owner,now+1800000);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM payments').get().n,1);
 assert.equal(f.row(id).expected_return,now+5400000);
});
test('Departure HTTP requires a session, valid origin, working role and current revision',async t=>{
 const f=fixture(t),id=f.create();let currentUser=null;
 f.store.user=()=>currentUser;
 let origin;
 const server=http.createServer((req,res)=>adminHandler(f.store,origin)(req,res,new URL(req.url,origin)));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 origin='http://127.0.0.1:'+server.address().port;
 try{
  const send=(headers={},body={id,revision:0})=>fetch(origin+'/api/admin/rental-depart',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await send()).status,401);
  currentUser={id:2,role:'waiter'};assert.equal((await send()).status,403);
  currentUser=owner;assert.equal((await send({Origin:'https://other.invalid'})).status,403);
  assert.equal((await send({}, {id,revision:99})).status,409);
  assert.equal(f.row(id).departure_pending,1);
  const response=await send();assert.equal(response.status,200);assert.equal(f.row(id).departure_pending,0);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
