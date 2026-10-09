import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {AdminStore,adminHandler} from './admin.mjs';
import {SmsStore} from './sms.mjs';
import {staffSmsHandler,staffReminderTimes,startStaffSmsWorker} from './staff-sms.mjs';

async function fixture(t){
 const admin=new AdminStore(':memory:');admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'employee','staff','unused'),(3,'waiter','waiter','unused')");
 for(const [token,id] of [['owner',1],['staff',2],['waiter',3]])admin.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+60000);
 admin.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update('expired').digest('hex'),1,Date.now()-1);
 const sms=new SmsStore(admin,null,{SMS_ENABLED:'false'});let origin;
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,origin);if(await staffSmsHandler(sms.staffReminders,admin,origin)(req,res,url))return;if(await adminHandler(admin,origin)(req,res,url))return;res.writeHead(404);res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));admin.close();});
 const request=(token='owner',body,headers={},path='/api/admin/staff-sms')=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Cookie:'__Host-start_session='+token,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
 return {admin,sms,origin,request};
}
test('Staff SMS HTTP: private contacts, roles, origin, malformed bodies and stale versions',async t=>{
 const f=await fixture(t);
 for(const token of ['missing','expired'])assert.equal((await f.request(token)).status,401);
 for(const token of ['staff','waiter'])assert.equal((await f.request(token)).status,403);
 const change={action:'contact',userId:2,phone:'8 (903) 000-00-00',revision:0};
 assert.equal((await f.request('owner',change,{Origin:'https://wrong.invalid'})).status,403);
 assert.equal((await f.request('owner','{broken')).status,400);
 assert.equal((await f.request('owner','x'.repeat(5000))).status,413);
 const response=await f.request('owner',change);assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.people.find(p=>p.userId===2).phone,'79030000000');assert.equal(data.people.find(p=>p.userId===2).revision,1);
 assert.doesNotMatch(JSON.stringify(data),/unused|SMSAERO_API_KEY/);
 assert.equal((await f.request('owner',change)).status,409);
 assert.equal((await f.request('owner',{...change,phone:'bad',revision:1})).status,400);
 assert.equal((await f.request('owner',{...change,phone:'',revision:1})).status,200);
 assert.equal(f.admin.db.prepare('SELECT count(*) n FROM clients').get().n,0);
 const audit=f.sms.staffReminders.snapshot({role:'admin'}).events;
 assert.ok(audit.some(e=>e.action==='contact_changed'));assert.doesNotMatch(JSON.stringify(audit),/79030000000/);
 const settings={action:'settings',revision:0,enabled:false};assert.equal((await f.request('owner',settings)).status,200);assert.equal((await f.request('owner',settings)).status,409);
});
test('A successful schedule save wakes the worker only after commit; rejected edits do not wake or change wages',async t=>{
 const f=await fixture(t),day=new Date(Date.now()+10800000+86400000).toISOString().slice(0,10),before=f.admin.db.prepare('SELECT * FROM salary_settings').get();let wakes=0;
 f.sms.staffReminders.wake=()=>{wakes++;assert.equal(f.admin.db.isTransaction,false);assert.equal(f.admin.db.prepare('SELECT confirmed FROM staff_schedule WHERE user_id=2 AND day=?').get(day).confirmed,1);};
 const body={action:'confirm',userId:2,day,revision:0,start:'09:00',end:'18:00',note:''};
 assert.equal((await f.request('owner',body,{},'/api/admin/schedule')).status,200);assert.equal(wakes,1);
 assert.equal((await f.request('owner',body,{},'/api/admin/schedule')).status,409);assert.equal(wakes,1);
 assert.deepEqual(f.admin.db.prepare('SELECT * FROM salary_settings').get(),before);assert.equal(f.admin.db.prepare('SELECT count(*) n FROM employee_work_sessions').get().n,0);
});
test('Moscow midnight and year boundary yield previous-day 20:00 and 23:00',()=>{
 const result=staffReminderTimes('2027-01-01','00:00');
 assert.equal(result.evening.due,Date.parse('2026-12-31T20:00:00+03:00'));assert.equal(result.hour.due,Date.parse('2026-12-31T23:00:00+03:00'));
 assert.equal(staffReminderTimes('2026-02-30','09:00'),null);assert.equal(staffReminderTimes('2026-10-10','24:00'),null);
});
test('Server worker schedules nearest due time without a browser and can be stopped',async()=>{
 let ticks=0,delay,cleared=0,unrefs=0;
 const store={db:{prepare:()=>({get:()=>({due:1123})})},tick:async()=>{ticks++;}};
 const stop=startStaffSmsWorker(store,{now:()=>1000,setTimer:(fn,ms)=>{delay=ms;return {unref(){unrefs++;}};},clearTimer:()=>{cleared++;},onError:()=>assert.fail('Unexpected worker error')});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(ticks,1);assert.equal(delay,123);assert.equal(unrefs,1);
 stop();assert.equal(store.wake,undefined);assert.ok(cleared>=1);
});
function loadFixture(t,count=10){
 const admin=new AdminStore(':memory:');admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");t.after(()=>admin.close());
 const sms=new SmsStore(admin,null,{SMS_ENABLED:'true',SMSAERO_EMAIL:'test@example.invalid',SMSAERO_API_KEY:'not-real'}),owner={id:1,role:'admin'},due=Date.parse('2026-10-10T08:00:00+03:00');sms.save({...sms.settings(),enabled:true,dailyLimit:100},owner);
 for(let id=2;id<count+2;id++){admin.db.prepare('INSERT INTO admin_users VALUES(?,?,?,?)').run(id,'employee-'+id,'staff','unused');admin.db.prepare("INSERT INTO staff_schedule(user_id,day,confirmed,plan_start) VALUES(?,'2026-10-10',1,'09:00')").run(id);sms.staffReminders.saveContact({userId:id,phone:'79030000000',revision:0},owner,due-86400000);}
 return {admin,sms,owner,due};
}
test('Ten simultaneous hour reminders are handed off before a slow provider consumes the window',async t=>{
 const f=loadFixture(t),messages=[];let release,time=f.due;const barrier=new Promise(resolve=>{release=resolve;});
 t.mock.method(Date,'now',()=>time);
 const service={send:async(number,text)=>{const id=messages.length+1;messages.push({number,text});await barrier;return {ok:true,data:{id}};},status:async()=>({ok:true,data:{status:0}})};
 const running=f.sms.staffReminders.tick(service);assert.equal(messages.length,10);time+=61000;release();await running;
 assert.equal(f.sms.staffReminders.snapshot(f.owner).jobs.filter(j=>j.kind==='hour'&&j.status==='accepted').length,10);
 assert.ok(messages.every(m=>m.text==='Станция СТАРТ. Через час у вас начало смены, в 09:00. Пожалуйста, не опаздывайте!'));
});
test('Cancelling while the provider is receiving an SMS preserves the known result and prevents further sends',async t=>{
 const f=loadFixture(t,1);let release,sends=0;const barrier=new Promise(resolve=>{release=resolve;});
 const service={send:async()=>{sends++;await barrier;return {ok:true,data:{id:123}};},status:async()=>({ok:true,data:{status:0}})};
 const running=f.sms.staffReminders.tick(service,f.due);
 f.admin.db.prepare('UPDATE staff_schedule SET confirmed=0 WHERE user_id=2').run();f.sms.staffReminders.sync(f.due+1);release();await running;
 const job=f.sms.staffReminders.snapshot(f.owner).jobs.find(j=>j.kind==='hour');assert.equal(job.status,'accepted');assert.equal(job.cancelReason,'schedule_changed');
 await f.sms.staffReminders.tick(service,f.due+1000);assert.equal(sends,1);
});
test('Concurrent provider-status checks produce one terminal journal event',async t=>{
 const f=loadFixture(t,1),send={send:async()=>({ok:true,data:{id:321}}),status:async()=>({ok:true,data:{status:0}})};
 await f.sms.staffReminders.tick(send,f.due);
 const second=new SmsStore(f.admin,null,{SMS_ENABLED:'true',SMSAERO_EMAIL:'test',SMSAERO_API_KEY:'not-real'});
 let release,checks=0;const barrier=new Promise(resolve=>{release=resolve;});
 const provider={send:async()=>assert.fail('No additional SMS expected'),status:async()=>{checks++;await barrier;return {ok:true,data:{status:1}};}};
 const running=[f.sms.staffReminders.tick(provider,f.due+60001),second.staffReminders.tick(provider,f.due+60001)];
 await new Promise(resolve=>setImmediate(resolve));assert.equal(checks,2);release();await Promise.all(running);
 assert.equal(f.admin.db.prepare("SELECT count(*) n FROM staff_sms_events WHERE action='delivered'").get().n,1);
});
test('Booking SMS cannot exceed the shared limit reserved by a staff reminder',async t=>{
 const f=loadFixture(t,1),now=Date.parse('2026-10-10T12:00:00+03:00');f.sms.save({...f.sms.settings(),dailyLimit:1},f.owner);
 f.admin.db.prepare("UPDATE staff_schedule SET plan_start='13:00' WHERE user_id=2").run();f.sms.staffReminders.sync(now);
 const job=f.sms.staffReminders.snapshot(f.owner).jobs.find(j=>j.kind==='hour'&&j.startTime==='13:00');assert.ok(f.sms.staffReminders.claim(job.id,now));
 const id=f.admin.receive('quota-client',{name:'Тест',phone:'79991112233',equipment:'sup',plan:'hour',date:'2026-10-10',time:'12:30',quantity:1,duration:1},now);
 f.admin.inquiryStatus({id,revision:0,status:'confirmed'},f.owner,now);
 let sent=0;await f.sms.tick({send:async()=>{sent++;return {ok:true,data:{id:555}};},status:async()=>({ok:true,data:{status:0}})},now);
 assert.equal(sent,0);assert.equal(f.sms.jobs(id)[0].status,'scheduled');
});
