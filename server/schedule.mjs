import {readFileSync} from 'node:fs';
const fail=(s,status=400)=>{throw Object.assign(Error(s),{status});};
const allowed=u=>{if(!u||!['admin','staff','waiter'].includes(u.role))fail('Нет доступа.',403);};
const validDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const today=()=>new Date(Date.now()+10800000).toISOString().slice(0,10);
export class ScheduleStore{
 constructor(admin){this.admin=admin;this.db=admin.db;this.db.exec(readFileSync(new URL('./migrations/006-schedule.sql',import.meta.url),'utf8'));this.db.exec('CREATE TABLE IF NOT EXISTS schedule_access_policy(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO schedule_access_policy VALUES(1,0)');}
 people(){return this.admin.workforce.people();}
 list(week,u){allowed(u);if(!validDay(week)||new Date(week).getUTCDay()!==1)fail('Выберите начало недели — понедельник.');const end=new Date(Date.parse(week)+7*86400000).toISOString().slice(0,10);return {user:{id:u.id,role:u.role,...(u.scheduleOnly?{scheduleOnly:true}:{})},today:this.accessDay()||today(),people:this.people().map(p=>({id:p.id,name:p.name})),rows:this.db.prepare('SELECT * FROM staff_schedule WHERE day>=? AND day<? ORDER BY day,user_id').all(week,end)};}
 enabled(){return this.db.prepare('SELECT enabled FROM schedule_access_policy WHERE id=1').get()?.enabled===1;}
 accessDay(now=Date.now()){
  const local=new Date(now+10800000),hour=local.getUTCHours();
  if(hour>=2&&hour<8)return null;
  return new Date(now+10800000-(hour<2?86400000:0)).toISOString().slice(0,10);
 }
 canWork(u,now=Date.now()){
  if(u?.role==='admin')return true;
  const day=this.accessDay(now);
  return !!day&&!!this.db.prepare('SELECT 1 FROM staff_schedule WHERE user_id=? AND day=? AND confirmed=1').get(u?.id||0,day);
 }
 replace(b,u,now=Date.now()){
  allowed(u);if(u.role!=='admin')fail('Заменяет сотрудника только администратор.',403);
  if(!validDay(b.day)||b.day<(this.accessDay(now)||today()))fail('Прошедшие дни доступны только для просмотра.');
  if(!Number.isSafeInteger(b.userId)||!Number.isSafeInteger(b.replacementId)||b.userId===b.replacementId||![b.userId,b.replacementId].every(id=>this.people().some(p=>p.id===id)))fail('Выберите другого сотрудника.');
  if(!Number.isSafeInteger(b.revision)||!Number.isSafeInteger(b.replacementRevision))fail('Обновите график.');
  return this.admin.workforce.tx(()=>{
   const source=this.db.prepare('SELECT * FROM staff_schedule WHERE user_id=? AND day=?').get(b.userId,b.day),target=this.db.prepare('SELECT * FROM staff_schedule WHERE user_id=? AND day=?').get(b.replacementId,b.day);
   if(!source?.confirmed||source.revision!==b.revision||(target?.revision||0)!==b.replacementRevision)fail('График изменился. Обновите его перед заменой.',409);
   if(target?.confirmed)fail('Этот сотрудник уже назначен на этот день.',409);
   this.db.prepare("INSERT INTO staff_schedule(user_id,day,confirmed,plan_start,plan_end,plan_note,revision) VALUES(?,?,1,?,?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET confirmed=1,plan_start=excluded.plan_start,plan_end=excluded.plan_end,plan_note=excluded.plan_note,pending=0,revision=staff_schedule.revision+1").run(b.replacementId,b.day,source.plan_start,source.plan_end,source.plan_note);
   this.db.prepare("UPDATE staff_schedule SET confirmed=0,plan_start='',plan_end='',plan_note='',pending=0,revision=revision+1 WHERE user_id=? AND day=?").run(b.userId,b.day);
   if(this.accessDay(now)===b.day){
    this.db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(b.userId);
    const active=this.db.prepare('SELECT * FROM employee_work_sessions WHERE user_id=? AND ended_at IS NULL').get(b.userId);
    if(active){
     if(active.started_at>now)fail('Проверьте время начатой смены.',409);
     this.admin.workforce.daySettings(this.admin.workforce.accountingDay(active.started_at),now,true);
     this.db.prepare('UPDATE employee_work_sessions SET ended_at=?,revision=revision+1 WHERE id=?').run(now,active.id);
     this.admin.workforce.audit(u,'work_end',active.id,active,{...active,ended_at:now},'Замена сотрудника в графике',now);
    }
   }
   return {ok:true};
  });
 }
 save(b,u){if(b.action==='replace')return this.replace(b,u);allowed(u);if(!validDay(b.day)||b.day<(this.accessDay()||today()))fail('Прошедшие дни доступны только для просмотра.');if(!Number.isSafeInteger(b.userId)||!this.people().some(p=>p.id===b.userId))fail('Сотрудник не найден.');if(!['wish','confirm','cancel','reject'].includes(b.action))fail('Неизвестное действие.');if(b.action==='wish'?b.userId!==u.id:u.role!=='admin')fail('Можно менять только свои пожелания. Назначает администратор.',403);
  if(!Number.isSafeInteger(b.revision)||b.revision<0)fail('Обновите график.');
  const times=()=>{for(const t of [b.start,b.end])if(typeof t!=='string'||t!==''&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))fail('Проверьте время.');if(b.start&&b.end&&b.start>=b.end)fail('Окончание должно быть позже начала в этот день.');if(typeof b.note!=='string'||b.note.length>300||/[\x00-\x1f]/.test(b.note))fail('Комментарий — до 300 символов.');};
  if(['wish','confirm'].includes(b.action))times();if(b.action==='wish'&&!['want','cannot','none'].includes(b.preference))fail('Выберите пожелание.');
  return this.admin.workforce.tx(()=>{const old=this.db.prepare('SELECT * FROM staff_schedule WHERE user_id=? AND day=?').get(b.userId,b.day)||{revision:0,preference:'none',wish_start:'',wish_end:'',wish_note:'',confirmed:0,plan_start:'',plan_end:'',plan_note:'',pending:0};if(old.revision!==b.revision)fail('График уже изменён. Обновите его и проверьте данные.',409);const r={...old};
   if(b.action==='wish')Object.assign(r,{preference:b.preference,wish_start:b.start,wish_end:b.end,wish_note:b.note.trim(),pending:old.confirmed?1:0});
   if(b.action==='confirm')Object.assign(r,{confirmed:1,plan_start:b.start,plan_end:b.end,plan_note:b.note.trim(),pending:0});
   if(b.action==='cancel')Object.assign(r,{confirmed:0,plan_start:'',plan_end:'',plan_note:'',pending:0});
   if(b.action==='reject')Object.assign(r,{pending:0,preference:old.confirmed?'want':old.preference,wish_start:old.plan_start,wish_end:old.plan_end,wish_note:''});
   this.db.prepare(`INSERT INTO staff_schedule(user_id,day,preference,wish_start,wish_end,wish_note,confirmed,plan_start,plan_end,plan_note,pending,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET preference=excluded.preference,wish_start=excluded.wish_start,wish_end=excluded.wish_end,wish_note=excluded.wish_note,confirmed=excluded.confirmed,plan_start=excluded.plan_start,plan_end=excluded.plan_end,plan_note=excluded.plan_note,pending=excluded.pending,revision=excluded.revision`).run(b.userId,b.day,r.preference,r.wish_start,r.wish_end,r.wish_note,r.confirmed,r.plan_start,r.plan_end,r.plan_note,r.pending,old.revision+1);return {ok:true};
  });
 }
}
