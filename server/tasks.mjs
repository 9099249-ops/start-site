import {readFileSync} from 'node:fs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const allowed=u=>{if(!u||!['admin','staff','waiter'].includes(u.role))fail('Войдите в админку.',403);};
export const taskDay=(now=Date.now())=>new Date(now+10800000).toISOString().slice(0,10);
const taskPeriod=now=>{const local=new Date(now+10800000),hour=Math.floor(local.getUTCHours()/2)*2;return taskDay(now)+'@'+String(hour).padStart(2,'0');};
const nextReset=now=>Math.floor((now+10800000)/7200000)*7200000+7200000-10800000;
export class TasksStore {
 constructor(admin){this.db=admin.db;this.db.exec(readFileSync(new URL('./migrations/005-tasks.sql',import.meta.url),'utf8'));
 for(const [name,type] of [['archived_at','INTEGER'],['sort_order','INTEGER NOT NULL DEFAULT 0'],['edit_revision','INTEGER NOT NULL DEFAULT 0']])if(!this.db.prepare('PRAGMA table_info(station_tasks)').all().some(c=>c.name===name))this.db.exec('ALTER TABLE station_tasks ADD COLUMN '+name+' '+type);
 this.db.exec('CREATE TABLE IF NOT EXISTS station_task_edits(id INTEGER PRIMARY KEY,task_id INTEGER,actor INTEGER,created INTEGER,before_json TEXT,after_json TEXT)');}
 list(user,day=taskDay(),now=Date.now()){allowed(user);if(!/^\d{4}-\d{2}-\d{2}$/.test(day))fail('Неверная дата.');return this.db.prepare(`SELECT t.*,a.login created_name,b.login completed_name FROM station_tasks t JOIN admin_users a ON a.id=t.created_by LEFT JOIN admin_users b ON b.id=t.completed_by WHERE t.archived_at IS NULL ORDER BY t.sort_order,t.created_at DESC,t.id DESC`).all().map(t=>{if(t.kind==='task')return t;const period=t.kind==='during'?day+'@'+taskPeriod(now).split('@')[1]:null;const c=this.db.prepare('SELECT c.*,u.login completed_name FROM station_task_checks c LEFT JOIN admin_users u ON u.id=c.completed_by WHERE task_id=? AND day=?').get(t.id,period||day);return {...t,...(period?{period,nextResetAt:nextReset(now)}:{}),completed_at:c?.completed_at??null,completed_by:c?.completed_by??null,completed_name:c?.completed_name??null,revision:c?.revision??0,day};});}
 create(body,user,now=Date.now()){
  allowed(user);if(user.role!=='admin')fail('Добавлять дела может только администратор.',403);
  if(typeof body.text!=='string'||!body.text.trim()||body.text.trim().length>500||/[\x00-\x08\x0b-\x1f]/.test(body.text)||typeof body.requestId!=='string'||! /^[a-f0-9-]{36}$/i.test(body.requestId))fail('Введите дело — до 500 символов.');
  const kind=body.kind??'task';if(!['task','opening','during','closing'].includes(kind))fail('Выберите раздел дел.');const text=body.text.trim();this.db.exec('BEGIN IMMEDIATE');
  try{const old=this.db.prepare('SELECT * FROM station_tasks WHERE request_id=?').get(body.requestId);if(old){if(old.text!==text||old.created_by!==user.id||old.kind!==kind)fail('Повтор запроса с другими данными.',409);this.db.exec('COMMIT');return old.id;}
   const id=Number(this.db.prepare('INSERT INTO station_tasks(request_id,text,kind,created_at,created_by) VALUES(?,?,?,?,?)').run(body.requestId,text,kind,now,user.id).lastInsertRowid);
   this.db.prepare("INSERT INTO station_task_events(task_id,actor,action,created_at) VALUES(?,?,'created',?)").run(id,user.id,now);this.db.exec('COMMIT');return id;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 edit(b,u,now=Date.now()){
 allowed(u);if(u.role!=='admin')fail('Только администратор.',403);
 this.db.exec('BEGIN IMMEDIATE');try{
 if(b.action==='reorder'){
  if(!['task','opening','during','closing'].includes(b.kind)||!Array.isArray(b.items)||b.items.some(x=>!x||!Number.isSafeInteger(x.id)||x.id<=0||!Number.isSafeInteger(x.edit_revision)||x.edit_revision<0)||new Set(b.items.map(x=>x.id)).size!==b.items.length)fail('Некорректный порядок дел.');
  const rows=this.db.prepare('SELECT * FROM station_tasks WHERE kind=? AND archived_at IS NULL ORDER BY sort_order,created_at DESC,id DESC').all(b.kind),byId=new Map(rows.map(x=>[x.id,x]));
  if(rows.length!==b.items.length||b.items.some(x=>!byId.has(x.id)||byId.get(x.id).edit_revision!==x.edit_revision))fail('Список изменился. Обновите страницу.',409);
  if(b.items.some((x,i)=>x.id!==rows[i].id)){
   const update=this.db.prepare('UPDATE station_tasks SET sort_order=?,edit_revision=edit_revision+1 WHERE id=?'),audit=this.db.prepare('INSERT INTO station_task_edits(task_id,actor,created,before_json,after_json) VALUES(?,?,?,?,?)');
   b.items.forEach((x,i)=>{const before=byId.get(x.id),after={...before,sort_order:i,edit_revision:before.edit_revision+1};update.run(i,x.id);audit.run(x.id,u.id,now,JSON.stringify(before),JSON.stringify(after));});
  }
  this.db.exec('COMMIT');return {ok:true};
 }
 const row=this.db.prepare('SELECT * FROM station_tasks WHERE id=?').get(b.id);
 if(!row||row.archived_at||row.edit_revision!==b.revision)fail('Список изменился. Обновите страницу.',409);
 if(b.action==='text'){if(typeof b.text!=='string'||!b.text.trim()||b.text.trim().length>500)fail('Введите текст до 500 символов.');this.db.prepare('UPDATE station_tasks SET text=?,edit_revision=edit_revision+1 WHERE id=?').run(b.text.trim(),row.id);}
 else if(b.action==='archive')this.db.prepare('UPDATE station_tasks SET archived_at=?,edit_revision=edit_revision+1 WHERE id=?').run(now,row.id);
 else if(b.action==='up'||b.action==='down'){const rows=this.db.prepare('SELECT * FROM station_tasks WHERE kind=? AND archived_at IS NULL ORDER BY sort_order,created_at DESC,id DESC').all(row.kind),i=rows.findIndex(x=>x.id===row.id),j=i+(b.action==='up'?-1:1);if(j<0||j>=rows.length)fail('Пункт уже на краю списка.');[rows[i],rows[j]]=[rows[j],rows[i]];rows.forEach((x,n)=>this.db.prepare('UPDATE station_tasks SET sort_order=?,edit_revision=edit_revision+1 WHERE id=?').run(n,x.id));}
 else fail('Неизвестное действие.');
 this.db.prepare('INSERT INTO station_task_edits(task_id,actor,created,before_json,after_json) VALUES(?,?,?,?,?)').run(row.id,u.id,now,JSON.stringify(row),JSON.stringify(this.db.prepare('SELECT * FROM station_tasks WHERE id=?').get(row.id)));this.db.exec('COMMIT');return {ok:true};
 }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 complete(body,user,now=Date.now()){ 
  allowed(user);if(!Number.isSafeInteger(body.id)||!Number.isSafeInteger(body.revision)||typeof body.done!=='boolean')fail('Некорректное действие.');
  this.db.exec('BEGIN IMMEDIATE');try{const row=this.db.prepare('SELECT * FROM station_tasks WHERE id=?').get(body.id);if(!row||row.archived_at)fail('Дело не найдено.',404);
   if(row.kind!=='task'){
    const day=taskDay(now);if(body.day!==day)fail('Начался другой день. Обновите чек-лист.',409);
    const period=row.kind==='during'?taskPeriod(now):null;if(period&&body.period!==period)fail('Начался новый двухчасовой период. Обновите чек-лист.',409);
    const checkDay=period||day;
    const current=this.db.prepare('SELECT * FROM station_task_checks WHERE task_id=? AND day=?').get(row.id,checkDay);
    if((current?.revision??0)!==body.revision)fail('Пункт уже изменён. Список обновлён.',409);
    if(Boolean(current?.completed_at)!==body.done){this.db.prepare('INSERT INTO station_task_checks(task_id,day,completed_at,completed_by,revision) VALUES(?,?,?,?,1) ON CONFLICT(task_id,day) DO UPDATE SET completed_at=excluded.completed_at,completed_by=excluded.completed_by,revision=station_task_checks.revision+1').run(row.id,checkDay,body.done?now:null,body.done?user.id:null);this.db.prepare('INSERT INTO station_task_events(task_id,actor,action,created_at) VALUES(?,?,?,?)').run(row.id,user.id,body.done?'completed':'reopened',now);}
    this.db.exec('COMMIT');return {ok:true};
   }
   if(row.revision!==body.revision)fail('Дело уже изменено. Список обновлён — проверьте результат.',409);
   if(Boolean(row.completed_at)!==body.done){this.db.prepare('UPDATE station_tasks SET completed_at=?,completed_by=?,revision=revision+1 WHERE id=?').run(body.done?now:null,body.done?user.id:null,row.id);this.db.prepare('INSERT INTO station_task_events(task_id,actor,action,created_at) VALUES(?,?,?,?)').run(row.id,user.id,body.done?'completed':'reopened',now);}
   this.db.exec('COMMIT');return {ok:true};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
}
