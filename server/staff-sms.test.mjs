import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AdminStore} from './admin.mjs';
import {SmsStore} from './sms.mjs';

const env={SMS_ENABLED:'true',SMSAERO_EMAIL:'test',SMSAERO_API_KEY:'test-only'};
const owner={id:2,role:'admin',login:'owner'};
const day='2026-10-10';
const at=(value)=>Date.parse(value+'+03:00');
const midnight=at(day+'T00:00:00');
const moscowDate=(timestamp)=>new Date(timestamp+10800000).toISOString().slice(0,10);

function fixture({file=null,ownFile=true,enabled=true,dailyLimit=100}={}){
 const folder=ownFile?mkdtempSync(path.join(tmpdir(),'staff-sms-')):null;
 const dbFile=file||path.join(folder,'staff.sqlite');
 const admin=new AdminStore(dbFile);
 admin.db.exec("INSERT INTO admin_users(id,login,role,password) VALUES(1,'admin','admin','unused'),(2,'owner','admin','unused'),(3,'staff-one','staff','unused'),(4,'staff-two','staff','unused'),(5,'staff-three','staff','unused')");
 admin.db.prepare('INSERT INTO employee_profiles(user_id,display_name) VALUES(3,\'Иван\'),(4,\'Мария\'),(5,\'Павел\')').run();
 const sms=new SmsStore(admin,null,env);
 sms.save({...sms.settings(),enabled},owner);
 sms.save({...sms.settings(),dailyLimit},owner);
 const staff=sms.staffReminders;
 const jobsFor=(userId)=>staff.snapshot(owner).jobs.filter(job=>job.userId===userId);
 const confirm=(userId,date=day,start='09:00',end='18:00')=>admin.db.prepare('INSERT INTO staff_schedule(user_id,day,confirmed,plan_start,plan_end) VALUES(?,?,1,?,?) ON CONFLICT(user_id,day) DO UPDATE SET confirmed=1,plan_start=excluded.plan_start,plan_end=excluded.plan_end').run(userId,date,start,end);
 const contact=(userId,number='79030000000')=>staff.saveContact({userId,phone:number,revision:0},owner,midnight-86400000);
 let nextId=10;
 const sent=[];
 const service={send:async(number,text,sign)=>{sent.push({number,text,sign});return {ok:true,data:{id:nextId++}};},status:async()=>({ok:true,data:{status:1}})};
 const close=()=>{admin.close();if(folder)rmSync(folder,{recursive:true,force:true});};
 return {admin,sms,staff,jobsFor,confirm,contact,service,sent,close,folder,dbFile};
}

test('only confirmed eligible staff with contacts receive jobs; admin and archived accounts are excluded',t=>{
 const f=fixture();t.after(f.close);
 f.contact(5);
 f.admin.db.prepare('INSERT INTO archived_accounts(user_id,archived_at,archived_by) VALUES(5,?,1)').run(midnight);
 for(const id of [1,2,3,4,5])f.confirm(id);
 for(const id of [2,3,4])f.contact(id);
 f.confirm(4,day,'','');
 f.staff.sync(midnight-86400000);
 const active=new Set(['scheduled','retry','needs_phone','sending','unknown','accepted']);
 assert.equal(f.jobsFor(1).filter(j=>active.has(j.status)).length,0);
 assert.deepEqual(f.jobsFor(2).map(j=>j.kind).sort(),['evening','hour']);
 assert.deepEqual(f.jobsFor(3).map(j=>j.kind).sort(),['evening','hour']);
 assert.equal(f.jobsFor(4).filter(j=>active.has(j.status)).length,0);
 assert.equal(f.jobsFor(5).filter(j=>active.has(j.status)).length,0);
});

test('missing phone leaves eligible jobs in needs_phone without creating customers',t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);
 f.staff.sync(midnight-86400000);
 assert.ok(f.jobsFor(3).length>0);
 assert.ok(f.jobsFor(3).every(j=>j.status==='needs_phone'));
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM clients').get().n,0);
});

test('evening reminders are due at 20:00 on the previous day and accepted messages stay accepted after midnight',async t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);f.contact(3);
 const previous=midnight-86400000;
 f.staff.sync(previous);
 const evening=f.jobsFor(3).find(j=>j.kind==='evening');
 assert.ok(evening);
 assert.equal(evening.due,previous+20*3600000);
 await f.staff.tick(f.service,evening.due);
 assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].number,'79030000000');
 assert.equal(f.staff.snapshot(owner).jobs.find(j=>j.id===evening.id).status,'accepted');
 await f.staff.tick(f.service,midnight);
 assert.equal(f.sent.length,1);
 assert.equal(f.staff.snapshot(owner).jobs.find(j=>j.id===evening.id).status,'delivered');
});

test('evening and hourly reminders use their exact distinct SMS text',async t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
 const jobs=f.jobsFor(3);
 const evening=jobs.find(j=>j.kind==='evening');
 const hour=jobs.find(j=>j.kind==='hour');
 await f.staff.tick(f.service,evening.due);
 await f.staff.tick(f.service,hour.due);
 assert.deepEqual(f.sent.map(m=>m.text),[
  'Станция СТАРТ. Завтра у вас смена с 09:00. Пожалуйста, не опаздывайте!',
  'Станция СТАРТ. Через час у вас начало смены, в 09:00. Пожалуйста, не опаздывайте!'
 ]);
});

test('late evening job catches up before midnight; an unaccepted pending job expires at shift-day midnight',async t=>{
 const previous=midnight-86400000;
 const late=fixture();t.after(late.close);
 late.confirm(3);late.contact(3);
 late.staff.sync(previous+21*3600000);
 const lateJob=late.jobsFor(3).find(j=>j.kind==='evening');
 await late.staff.tick(late.service,midnight-1);
 assert.equal(late.sent.length,1);
 assert.equal(late.staff.snapshot(owner).jobs.find(j=>j.id===lateJob.id).status,'accepted');

 const pending=fixture();t.after(pending.close);
 pending.confirm(3);pending.contact(3);
 pending.staff.sync(previous+21*3600000);
 const pendingJob=pending.jobsFor(3).find(j=>j.kind==='evening');
 await pending.staff.tick(pending.service,midnight);
 const expired=pending.staff.snapshot(owner).jobs.find(j=>j.id===pendingJob.id);
 assert.equal(pending.sent.length,0);
 assert.equal(expired.status,'cancelled');
 assert.equal(expired.cancelReason,'expired');
});

test('hour reminder is due one hour before start, expires after its short window, and cannot send after shift start',async t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);f.contact(3);
 f.staff.sync(midnight-86400000);
 const hour=f.jobsFor(3).find(j=>j.kind==='hour');
 assert.ok(hour);
 assert.equal(hour.due,at(day+'T08:00:00'));
 assert.equal(hour.expires,Math.min(hour.due+60000,at(day+'T09:00:00')));
 await f.staff.tick(f.service,hour.due+60001);
 assert.equal(f.sent.length,0);
 const expired=f.staff.snapshot(owner).jobs.find(j=>j.id===hour.id);
 assert.equal(expired.status,'cancelled');
 assert.equal(expired.cancelReason,'expired');
 await f.staff.tick(f.service,at(day+'T09:00:01'));
 assert.equal(f.sent.length,0);
});

test('sync across seven dates including midnight creates one evening and hour job per shift',t=>{
 const f=fixture();t.after(f.close);
 for(let offset=0;offset<7;offset++)f.confirm(3,moscowDate(midnight+offset*86400000));
 f.contact(3);
 for(let offset=0;offset<7;offset++){
  const shiftMidnight=midnight+offset*86400000;
  f.staff.sync(shiftMidnight-86400000+19*3600000);
  f.staff.sync(shiftMidnight-86400000+20*3600000);
  f.staff.sync(shiftMidnight);
 }
 const jobs=f.jobsFor(3);
 for(let offset=0;offset<7;offset++){
  const shiftDay=moscowDate(midnight+offset*86400000);
  assert.equal(jobs.filter(j=>j.day===shiftDay&&j.kind==='evening').length,1);
  assert.equal(jobs.filter(j=>j.day===shiftDay&&j.kind==='hour').length,1);
 }
 assert.equal(jobs.length,14);
});

test('schedule removal cancels queued jobs; reconfirmation reuses the unique shift jobs',t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
 const before=f.jobsFor(3);
 f.admin.db.prepare('UPDATE staff_schedule SET confirmed=0 WHERE user_id=3 AND day=?').run(day);
 f.staff.sync(midnight-86400000+1000);
 assert.ok(before.every(j=>f.staff.snapshot(owner).jobs.find(x=>x.id===j.id).status==='cancelled'));
 f.confirm(3);f.staff.sync(midnight-86400000+2000);
 const after=f.jobsFor(3);
 assert.deepEqual(after.map(j=>j.id).sort(),before.map(j=>j.id).sort());
 assert.equal(after.filter(j=>j.status!=='cancelled').length,2);
});

test('accepted reminders are never repeated after schedule cancellation and reconfirmation',async t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
 const evening=f.jobsFor(3).find(j=>j.kind==='evening');
 await f.staff.tick(f.service,evening.due);
 assert.equal(f.sent.length,1);
 f.staff.saveContact({userId:3,phone:'79031112233',revision:1},owner,evening.due+500);
 f.admin.db.prepare('UPDATE staff_schedule SET plan_note=? WHERE user_id=3 AND day=?').run('Updated note',day);
 f.staff.sync(evening.due+1000);
 await f.staff.tick(f.service,evening.due+1500);
 assert.equal(f.sent.length,1);
 f.admin.db.prepare('UPDATE staff_schedule SET confirmed=0 WHERE user_id=3 AND day=?').run(day);
 f.staff.sync(evening.due+2000);
 f.confirm(3);f.staff.sync(evening.due+3000);
 await f.staff.tick(f.service,evening.due+4000);
 assert.equal(f.sent.length,1);
 assert.equal(f.staff.snapshot(owner).jobs.find(j=>j.id===evening.id).status,'accepted');
});

test('changed shift start cancels obsolete timing and creates jobs at the new time',t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
 const old=f.jobsFor(3);
 f.confirm(3,day,'10:30','19:00');f.staff.sync(midnight-86400000+1000);
 for(const job of old)assert.equal(f.staff.snapshot(owner).jobs.find(x=>x.id===job.id).status,'cancelled');
 const hour=f.jobsFor(3).find(j=>j.kind==='hour'&&j.status!=='cancelled');
 assert.equal(hour.due,at(day+'T09:30:00'));
});

test('contact update replaces the number for future sends without creating a customer',async t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);f.contact(3,'79030000000');f.staff.sync(midnight-86400000);
 f.staff.saveContact({userId:3,phone:'79031112233',revision:1},owner,midnight-86300000);
 const hour=f.jobsFor(3).find(j=>j.kind==='hour');
 await f.staff.tick(f.service,hour.due);
 assert.equal(f.sent[0].number,'79031112233');
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM clients').get().n,0);
});

test('explicit provider rejection retries with kind-specific exponential backoff and caps attempts',async t=>{
 for(const [kind,base] of [['evening',60000],['hour',5000]]){
  const f=fixture();t.after(f.close);
  f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
  const job=f.jobsFor(3).find(j=>j.kind===kind);
  let sends=0;
  const rejecting={...f.service,send:async()=>{sends++;return {ok:false,retry:true,error:'temporary'};}};
  await f.staff.tick(rejecting,job.due);
  let current=f.staff.snapshot(owner).jobs.find(j=>j.id===job.id);
  assert.equal(current.status,'retry');
  assert.equal(current.attempts,1);
  assert.equal(current.due,job.due+base);
  await f.staff.tick(rejecting,current.due);
  current=f.staff.snapshot(owner).jobs.find(j=>j.id===job.id);
  assert.equal(current.due,job.due+base+base*2);
  if(kind==='hour'){
   await f.staff.tick(rejecting,current.due);
   current=f.staff.snapshot(owner).jobs.find(j=>j.id===job.id);
   assert.equal(current.status,'retry');
   await f.staff.tick(rejecting,current.due);
   current=f.staff.snapshot(owner).jobs.find(j=>j.id===job.id);
   assert.equal(current.status,'retry');
   assert.equal(current.due,job.due+75_000);
   await f.staff.tick(rejecting,current.due);
   current=f.staff.snapshot(owner).jobs.find(j=>j.id===job.id);
   assert.equal(current.status,'cancelled');
   assert.equal(current.cancelReason,'expired');
   assert.equal(current.attempts,4);
   assert.equal(sends,4);
   continue;
  }
  for(let i=2;i<5;i++)await f.staff.tick(rejecting,f.staff.snapshot(owner).jobs.find(j=>j.id===job.id).due);
  current=f.staff.snapshot(owner).jobs.find(j=>j.id===job.id);
  assert.equal(current.status,'failed');
  assert.equal(current.attempts,5);
  assert.equal(sends,5);
 }
});

test('ambiguous network outcome becomes unknown and remains unknown after another worker instance',async t=>{
 const f=fixture({ownFile:true});t.after(f.close);
 f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
 const job=f.jobsFor(3).find(j=>j.kind==='hour');
 let sends=0;
 const uncertain={...f.service,send:async()=>{sends++;return {ok:false,unknown:true,error:'timeout'};}};
 await f.staff.tick(uncertain,job.due);
 const secondAdmin=new AdminStore(f.dbFile);
 try{
  const secondStore=new SmsStore(secondAdmin,null,env);
  await secondStore.staffReminders.tick(uncertain,job.due+600000);
  assert.equal(sends,1);
  assert.equal(f.staff.snapshot(owner).jobs.find(j=>j.id===job.id).status,'unknown');
 }finally{secondAdmin.close();}
});

test('stale sending claim becomes unknown after restart and never auto retries',async t=>{
 const f=fixture();t.after(f.close);
 f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
 const job=f.jobsFor(3).find(j=>j.kind==='hour');
 f.admin.db.prepare("UPDATE staff_sms_jobs SET status='sending',claimed_at=? WHERE id=?").run(job.due,job.id);
 let sends=0;
 const neverSend={...f.service,send:async()=>{sends++;return {ok:true,data:{id:99}};}};
 await f.staff.tick(neverSend,job.due+120001);
 await f.staff.tick(neverSend,job.due+600000);
 assert.equal(sends,0);
 assert.equal(f.staff.snapshot(owner).jobs.find(j=>j.id===job.id).status,'unknown');
});

test('daily quota counts bookings and staff sends together',async t=>{
 const f=fixture({dailyLimit:1});t.after(f.close);
 f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
 f.admin.db.prepare("INSERT INTO clients(phone,name,first_seen,last_seen) VALUES('79990000000','quota booking',?,?)").run(midnight,midnight);
 const clientId=f.admin.db.prepare("SELECT id FROM clients WHERE phone='79990000000'").get().id;
 const job=f.jobsFor(3).find(j=>j.kind==='evening');
 f.admin.db.prepare("INSERT INTO sms_jobs(kind,client_id,due,status,claimed_at,created) VALUES('reminder',? ,?,'delivered',?,?)").run(clientId,job.due,job.due-1,job.due-1);
 await f.staff.tick(f.service,job.due);
 assert.equal(f.sent.length,0);
 assert.ok(['scheduled','cancelled','expired'].includes(f.staff.snapshot(owner).jobs.find(j=>j.id===job.id).status));
});

test('two SQLite connections claim a staff job at most once',async t=>{
 const f=fixture({ownFile:true});t.after(f.close);
 f.confirm(3);f.contact(3);f.staff.sync(midnight-86400000);
 const secondAdmin=new AdminStore(f.dbFile);
 try{
  const secondSms=new SmsStore(secondAdmin,null,env);
  const secondStaff=secondSms.staffReminders;
  const job=f.jobsFor(3).find(j=>j.kind==='hour');
  let sends=0;
  let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const slow={...f.service,send:async()=>{sends++;await barrier;return {ok:true,data:{id:77}};}};
  const a=f.staff.tick(slow,job.due);
  await new Promise(resolve=>setTimeout(resolve,20));
  await secondStaff.tick(slow,job.due);
  release();await a;
  assert.equal(sends,1);
 }finally{secondAdmin.close();}
});
