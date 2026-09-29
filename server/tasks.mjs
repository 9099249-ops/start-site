import {readFileSync} from 'node:fs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const allowed=u=>{if(!u||!['admin','staff','waiter'].includes(u.role))fail('Войдите в админку.',403);};
export const taskDay=()=>new Date(Date.now()+10800000).toISOString().slice(0,10);
export class TasksStore {
 constructor(admin){this.db=admin.db;this.db.exec(readFileSync(new URL('./migrations/005-tasks.sql',import.meta.url),'utf8'));}
 list(user,day=taskDay()){allowed(user);if(!/^\d{4}-\d{2}-\d{2}$/.test(day))fail('Неверная дата.');return this.db.prepare(`SELECT t.*,a.login created_name,b.login completed_name FROM station_tasks t JOIN admin_users a ON a.id=t.created_by LEFT JOIN admin_users b ON b.id=t.completed_by ORDER BY t.created_at DESC,t.id DESC`).all().map(t=>{if(t.kind==='task')return t;const c=this.db.prepare('SELECT c.*,u.login completed_name FROM station_task_checks c LEFT JOIN admin_users u ON u.id=c.completed_by WHERE task_id=? AND day=?').get(t.id,day);return {...t,completed_at:c?.completed_at??null,completed_by:c?.completed_by??null,completed_name:c?.completed_name??null,revision:c?.revision??0,day};});}
 create(body,user,now=Date.now()){
  allowed(user);if(user.role!=='admin')fail('Добавлять дела может только администратор.',403);
  if(typeof body.text!=='string'||!body.text.trim()||body.text.trim().length>500||/[\x00-\x08\x0b-\x1f]/.test(body.text)||typeof body.requestId!=='string'||! /^[a-f0-9-]{36}$/i.test(body.requestId))fail('Введите дело — до 500 символов.');
  const kind=body.kind??'task';if(!['task','opening','during','closing'].includes(kind))fail('Выберите раздел дел.');const text=body.text.trim();this.db.exec('BEGIN IMMEDIATE');
  try{const old=this.db.prepare('SELECT * FROM station_tasks WHERE request_id=?').get(body.requestId);if(old){if(old.text!==text||old.created_by!==user.id||old.kind!==kind)fail('Повтор запроса с другими данными.',409);this.db.exec('COMMIT');return old.id;}
   const id=Number(this.db.prepare('INSERT INTO station_tasks(request_id,text,kind,created_at,created_by) VALUES(?,?,?,?,?)').run(body.requestId,text,kind,now,user.id).lastInsertRowid);
   this.db.prepare("INSERT INTO station_task_events(task_id,actor,action,created_at) VALUES(?,?,'created',?)").run(id,user.id,now);this.db.exec('COMMIT');return id;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 complete(body,user,now=Date.now()){
  allowed(user);if(!Number.isSafeInteger(body.id)||!Number.isSafeInteger(body.revision)||typeof body.done!=='boolean')fail('Некорректное действие.');
  this.db.exec('BEGIN IMMEDIATE');try{const row=this.db.prepare('SELECT * FROM station_tasks WHERE id=?').get(body.id);if(!row)fail('Дело не найдено.',404);
   if(row.kind!=='task'){
    const day=taskDay();if(body.day!==day)fail('Начался другой день. Обновите чек-лист.',409);
    const current=this.db.prepare('SELECT * FROM station_task_checks WHERE task_id=? AND day=?').get(row.id,day);
    if((current?.revision??0)!==body.revision)fail('Пункт уже изменён. Список обновлён.',409);
    if(Boolean(current?.completed_at)!==body.done){this.db.prepare('INSERT INTO station_task_checks(task_id,day,completed_at,completed_by,revision) VALUES(?,?,?,?,1) ON CONFLICT(task_id,day) DO UPDATE SET completed_at=excluded.completed_at,completed_by=excluded.completed_by,revision=station_task_checks.revision+1').run(row.id,day,body.done?now:null,body.done?user.id:null);this.db.prepare('INSERT INTO station_task_events(task_id,actor,action,created_at) VALUES(?,?,?,?)').run(row.id,user.id,body.done?'completed':'reopened',now);}
    this.db.exec('COMMIT');return {ok:true};
   }
   if(row.revision!==body.revision)fail('Дело уже изменено. Список обновлён — проверьте результат.',409);
   if(Boolean(row.completed_at)!==body.done){this.db.prepare('UPDATE station_tasks SET completed_at=?,completed_by=?,revision=revision+1 WHERE id=?').run(body.done?now:null,body.done?user.id:null,row.id);this.db.prepare('INSERT INTO station_task_events(task_id,actor,action,created_at) VALUES(?,?,?,?)').run(row.id,user.id,body.done?'completed':'reopened',now);}
   this.db.exec('COMMIT');return {ok:true};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
}
