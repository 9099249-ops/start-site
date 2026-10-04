import test from 'node:test';
import assert from 'node:assert/strict';
import {AdminStore} from './admin.mjs';
function fixture(t){const a=new AdminStore(':memory:');t.after(()=>a.close());a.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'worker','staff','unused'),(3,'substitute','waiter','unused')");return a;}
test('Schedule access: confirmed assignment only, Moscow 08:00–02:00, admin always',t=>{
 const a=fixture(t),s=a.schedule,u={id:2,role:'staff'},admin={id:1,role:'admin'},day='2026-10-01';
 a.db.prepare('INSERT INTO staff_schedule(user_id,day,preference,confirmed) VALUES(?,?,?,?)').run(2,day,'want',0);
 assert.equal(s.canWork(u,Date.parse(day+'T12:00:00+03:00')),false);
 a.db.exec('UPDATE staff_schedule SET confirmed=1');
 for(const [when,result] of [['2026-10-01T07:59:59+03:00',false],['2026-10-01T08:00:00+03:00',true],['2026-10-02T01:59:59+03:00',true],['2026-10-02T02:00:00+03:00',false],['2026-10-02T08:00:00+03:00',false]])assert.equal(s.canWork(u,Date.parse(when)),result,when);
 assert.equal(s.canWork(admin,Date.parse(day+'T03:00:00+03:00')),true);
});
test('Replace atomically transfers plan, ends real attendance, revokes former login, never starts replacement',t=>{
 const a=fixture(t),s=a.schedule,now=Date.parse(new Date(Date.now()+10800000).toISOString().slice(0,10)+'T12:00:00+03:00'),day=s.accessDay(now),u={id:1,role:'admin'};
 a.db.prepare("INSERT INTO staff_schedule(user_id,day,confirmed,plan_start,plan_end,revision) VALUES(?,?,1,'10:00','20:00',1)").run(2,day);
 a.db.prepare('INSERT INTO employee_work_sessions(user_id,started_at) VALUES(2,?)').run(now-3600000);a.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run('old-token',2,now+3600000);
 const b={action:'replace',userId:2,replacementId:3,day,revision:1,replacementRevision:0};
 assert.throws(()=>s.replace(b,{id:2,role:'staff'},now),e=>e.status===403);
 assert.throws(()=>s.replace({...b,revision:0},u,now),e=>e.status===409);
 s.replace(b,u,now);assert.equal(s.canWork({id:2,role:'staff'},now),false);assert.equal(s.canWork({id:3,role:'waiter'},now),true);
 assert.equal(a.db.prepare('SELECT ended_at FROM employee_work_sessions WHERE user_id=2').get().ended_at,now);
 assert.equal(a.db.prepare('SELECT count(*) n FROM employee_work_sessions WHERE user_id=3').get().n,0);assert.equal(a.db.prepare('SELECT count(*) n FROM admin_sessions WHERE user_id=2').get().n,0);
 assert.equal(a.db.prepare('SELECT plan_start FROM staff_schedule WHERE user_id=3').get().plan_start,'10:00');
 assert.throws(()=>s.replace(b,u,now),e=>e.status===409);assert.equal(a.db.prepare('SELECT count(*) n FROM financial_audit_log').get().n,1);
});
import {createHash} from 'node:crypto';
import http from 'node:http';
import {adminHandler} from './admin.mjs';
test('Off-duty credentials retain only schedule access; approval/revocation rechecks existing sessions',async t=>{
 const a=fixture(t);a.db.exec('UPDATE schedule_access_policy SET enabled=1');
 const token='schedule-token';a.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),2,Date.now()+3600000);
 assert.equal(a.user(token),null);assert.equal(a.user(token,true).scheduleOnly,true);
 const origin='http://localhost',handler=adminHandler(a,origin),server=http.createServer((req,res)=>handler(req,res,new URL(req.url,origin)));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port,headers={Cookie:'__Host-start_session='+token,Origin:origin,'Content-Type':'application/json'};
 const d=new Date(Date.now()+10800000);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));const week=d.toISOString().slice(0,10);
 assert.equal((await fetch(base+'/api/admin/schedule?week='+week,{headers})).status,200);
 assert.equal((await fetch(base+'/api/admin/rentals',{headers})).status,401);
 assert.equal((await fetch(base+'/api/admin/tasks/complete',{method:'POST',headers,body:'{}'})).status,401);
 const day=a.schedule.accessDay();if(day){a.db.prepare('INSERT INTO staff_schedule(user_id,day,confirmed) VALUES(?,?,1)').run(2,day);assert.ok(a.user(token));a.db.exec('UPDATE staff_schedule SET confirmed=0');assert.equal(a.user(token),null);}
 const session=await (await fetch(base+'/api/admin/session',{headers})).json();assert.equal(session.user.scheduleOnly,true);
});
