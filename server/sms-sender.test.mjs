import test from 'node:test';
import assert from 'node:assert/strict';
import {AdminStore} from './admin.mjs';
import {SmsStore,SmsService} from './sms.mjs';
import {StaffShiftReminders} from './staff-sms.mjs';

test('saved provider sender survives restart, including the standard SMS Aero sender',()=>{
 const admin=new AdminStore(':memory:');
 try{
  const store=new SmsStore(admin),user={id:1,role:'admin'};
  admin.db.prepare("INSERT INTO admin_users(id,login,role,password) VALUES(1,'admin','admin','unused')").run();
  assert.equal(store.settings().sign,'SMS Aero');
  store.save({...store.settings(),sign:'SMS Aero'},user);
  assert.equal(new SmsStore(admin).settings().sign,'SMS Aero');
  store.save({...store.settings(),sign:'APPROVED'},user);
  assert.equal(new SmsStore(admin).settings().sign,'APPROVED');
  assert.throws(()=>store.save({...store.settings(),sign:''},user));
  assert.throws(()=>store.save({...store.settings(),promoCode:'LATIN'},user));
 }finally{admin.close();}
});

test('invalid sender is a clear permanent rejection without exposing provider payload',async()=>{
 const service=new SmsService({},async()=>({status:400,json:async()=>({success:false,data:{sign:['incorrect'],number:['79991112233']},message:'private raw error'})}));
 const result=await service.send('79990000000','СТАРТ проверка','СТАРТ');
 assert.equal(result.ok,false);assert.equal(result.retry,false);assert.match(result.error,/имя отправителя/);assert.doesNotMatch(result.error,/79991112233|private/);
});

test('customer jobs do not retry a rejected sender; unknown outcome remains protected',async()=>{
 const admin=new AdminStore(':memory:');
 try{
  admin.db.prepare("INSERT INTO admin_users(id,login,role,password) VALUES(1,'admin','admin','unused')").run();
  const store=new SmsStore(admin,null,{SMS_ENABLED:'true',SMSAERO_EMAIL:'test',SMSAERO_API_KEY:'test'});
  store.save({...store.settings(),enabled:true},{id:1,role:'admin'});
  const now=Date.now();store.promo({name:'Тест',phone:'79990000000',consent:true},'test',now);
  let sends=0;const service={send:async()=>{sends++;return {ok:false,retry:false,error:'Неверное имя отправителя'};},status:async()=>({ok:false})};
  await store.tick(service,now);await store.tick(service,now+120000);
  const job=admin.db.prepare('SELECT * FROM sms_jobs').get();
  assert.equal(job.status,'failed');assert.equal(job.attempts,1);assert.equal(sends,1);
 }finally{admin.close();}
});

test('staff job records permanent rejection instead of ambiguous or repeated send',()=>{
 const admin=new AdminStore(':memory:');
 try{
  new SmsStore(admin);
  admin.db.prepare("INSERT INTO admin_users(id,login,role,password) VALUES(2,'tester','staff','unused')").run();
  const reminders=new StaffShiftReminders(admin,{}),now=Date.now();
  const result=admin.db.prepare("INSERT INTO staff_sms_jobs(user_id,day,start_at,kind,due,expires_at,status,attempts,created_at) VALUES(2,'2026-10-10',?,'evening',?,?,'sending',1,?)").run(now+86400000,now,now+3600000,now);
  reminders.finish({id:Number(result.lastInsertRowid),user_id:2,kind:'evening',attempts:1},{ok:false,retry:false,error:'Неверное имя отправителя'},now);
  const job=admin.db.prepare('SELECT * FROM staff_sms_jobs WHERE id=?').get(Number(result.lastInsertRowid));
  assert.equal(job.status,'failed');assert.equal(job.last_error,'Неверное имя отправителя');
 }finally{admin.close();}
});
