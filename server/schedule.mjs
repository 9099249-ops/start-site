import {readFileSync} from 'node:fs';
const fail=(s,status=400)=>{throw Object.assign(Error(s),{status});};
const allowed=u=>{if(!u||!['admin','staff','waiter'].includes(u.role))fail('Нет доступа.',403);};
const validDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const today=()=>new Date(Date.now()+10800000).toISOString().slice(0,10);
export class ScheduleStore{
 constructor(admin){this.admin=admin;this.db=admin.db;this.db.exec(readFileSync(new URL('./migrations/006-schedule.sql',import.meta.url),'utf8'));}
 people(){return this.admin.workforce.people();}
 list(week,u){allowed(u);if(!validDay(week)||new Date(week).getUTCDay()!==1)fail('Выберите начало недели — понедельник.');const end=new Date(Date.parse(week)+7*86400000).toISOString().slice(0,10);return {user:{id:u.id,role:u.role},today:today(),people:this.people().map(p=>({id:p.id,name:p.name})),rows:this.db.prepare('SELECT * FROM staff_schedule WHERE day>=? AND day<? ORDER BY day,user_id').all(week,end)};}
 save(b,u){allowed(u);if(!validDay(b.day)||b.day<today())fail('Прошедшие дни доступны только для просмотра.');if(!Number.isSafeInteger(b.userId)||!this.people().some(p=>p.id===b.userId))fail('Сотрудник не найден.');if(!['wish','confirm','cancel','reject'].includes(b.action))fail('Неизвестное действие.');if(b.action==='wish'?b.userId!==u.id:u.role!=='admin')fail('Можно менять только свои пожелания. Назначает администратор.',403);
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
