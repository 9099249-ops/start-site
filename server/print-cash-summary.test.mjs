import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {PrintStore} from './print.mjs';

const day='2026-10-07',at=time=>Date.parse(day+'T'+time+':00+03:00'),owner={id:1,role:'admin'};
function fixture(t){
 const admin=new AdminStore(':memory:');t.after(()=>admin.close());
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'worker','staff','unused')");
 new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});
 const print=new PrintStore(admin,{env:{PRINT_ENABLED:'true',PRINT_AGENT_TOKEN:'fake-print-token-'.repeat(5),PRINT_AGENT_DATABASE_ID:'fake-database',PRINT_AGENT_ID:'fake-printer'}});
 const id=Number(admin.db.prepare('INSERT INTO shifts(day,opened_at,opened_by,cash_start_cents) VALUES(?,?,1,100000)').run(day,at('09:00')).lastInsertRowid);
 const shift=()=>admin.db.prepare('SELECT * FROM shifts WHERE id=?').get(id);
 const sale=(time,amount,method)=>admin.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Test guest',phone:'79001234567',departed:day+'T'+time,amount,method},owner,at(time));
 return {admin,print,id,shift,sale};
}
test('Report keeps physical closing cash and declared cashless figures, including genuine zero',t=>{
 const f=fixture(t);f.sale('12:00','100','card');
 f.admin.db.prepare('UPDATE shifts SET cash_end_cents=0,cashless_cents=0,closed_at=? WHERE id=?').run(at('18:00'),f.id);
 assert.deepEqual(f.print.reportCash(f.shift(),at('20:00')),{cashStartCents:100000,cashEndCents:0,cashEndEstimated:false,cardTotalCents:0});
});
test('Report totals confirmed card payments in rental and cafe, subtracts card refunds only, and cuts off at close',t=>{
 const f=fixture(t);f.sale('12:00','100','card');f.sale('13:00','30','cash');
 const stamp=at('14:00');f.admin.db.prepare("INSERT INTO cafe_orders(request_id,fingerprint,public_token,source,details,total_cents,status,created,updated) VALUES(?,?,?,'admin',?,20000,'READY',?,?)").run(randomUUID(),'fixture',randomUUID(),JSON.stringify({items:[],terminalPaidAt:stamp,paymentMethod:'card'}),stamp,stamp);
 // refund rows are isolated bookkeeping fixtures, not provider refund calls.
 const addRefund=(id,method,cents)=>f.admin.db.prepare("INSERT INTO customer_refunds(kind,source_id,amount_cents,lines_json,reason,created_by,created_at,request_id,fingerprint,method) VALUES('cafe',?,?,?,?,1,?,?,?,?)").run(id,cents,'[]','Test fixture',at('15:00'),randomUUID(),'fixture',method);
 addRefund(1,'card',1000);addRefund(1,'cash',500);
 f.admin.db.prepare('UPDATE shifts SET closed_at=? WHERE id=?').run(at('18:00'),f.id);f.sale('19:00','50','card');
 const result=f.print.reportCash(f.shift(),at('20:00'));assert.equal(result.cardTotalCents,29000);assert.equal(result.cashEndEstimated,true);assert.equal(result.cashEndCents,102500);
});
test('Unknown payment method produces unknown card and ending cash, not fabricated zeros',t=>{
 const f=fixture(t);assert.equal(f.print.reportCash(f.shift(),at('11:00')).cardTotalCents,0);
 f.sale('12:00','100','unspecified');const result=f.print.reportCash(f.shift(),at('13:00'));
 assert.equal(result.cardTotalCents,null);assert.equal(result.cashEndCents,null);
});
test('Printed snapshot remains immutable and cash changes mark it stale without a second print',t=>{
 const f=fixture(t),job=f.print.report({shiftId:f.id},owner,at('11:00')).job;
 assert.equal(job.payload.cash_start,'1000.00');assert.equal(job.payload.cash_end,'1000.00');assert.equal(job.payload.card_total,'0.00');
 f.sale('12:00','100','cash');const info=f.print.reportInfo(owner,f.id,at('13:00'));assert.equal(info.stale,true);
 assert.equal(f.print.report({shiftId:f.id},owner,at('13:00')).job.id,job.id);assert.equal(f.print.job(job.id).payload.cash_end,'1000.00');
});
