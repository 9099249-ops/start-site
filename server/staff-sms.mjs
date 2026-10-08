import {readFileSync} from 'node:fs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const owner=u=>{if(u?.role!=='admin'||u.scheduleOnly)fail('Доступно только администратору.',403);};
const date=now=>new Date(now+10800000).toISOString().slice(0,10);
const clock=now=>new Date(now+10800000).toISOString().slice(11,16);
const pending=new Set(['scheduled','retry','needs_phone']);
const quotaStatuses="('sending','unknown','accepted','delivered','failed')";
export function dailySmsUsed(db,now){
 const start=Date.parse(date(now)+'T00:00:00+03:00'),end=start+86400000;
 let used=db.prepare(`SELECT count(*) n FROM sms_jobs WHERE claimed_at>=? AND claimed_at<? AND status IN ${quotaStatuses}`).get(start,end).n;
 if(db.prepare("SELECT name FROM sqlite_master WHERE name='staff_sms_jobs'").get())used+=db.prepare(`SELECT count(*) n FROM staff_sms_jobs WHERE claimed_at>=? AND claimed_at<? AND status IN ${quotaStatuses}`).get(start,end).n;
 return used;
}
export function staffReminderTimes(day,start){
 if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||!/^([01]\d|2[0-3]):[0-5]\d$/.test(start||''))return null;
 const at=Date.parse(day+'T'+start+':00+03:00'),midnight=Date.parse(day+'T00:00:00+03:00');
 return {start:at,evening:{due:midnight-4*3600000,expires:Math.min(at,midnight)},hour:{due:at-3600000,expires:Math.min(at,at-3600000+60000)}};
}
export class StaffShiftReminders{
 constructor(admin,options){this.admin=admin;this.db=admin.db;this.options=options;this.busy=false;this.db.exec(readFileSync(new URL('./migrations/014-staff-sms.sql',import.meta.url),'utf8'));}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 config(){return this.db.prepare('SELECT * FROM staff_sms_settings WHERE id=1').get();}
 people(){return this.db.prepare("SELECT u.id userId,u.login,coalesce(p.display_name,u.login) name,coalesce(c.phone,'') phone,coalesce(c.revision,0) revision FROM admin_users u LEFT JOIN employee_profiles p ON p.user_id=u.id LEFT JOIN staff_sms_contacts c ON c.user_id=u.id WHERE u.role IN ('admin','staff','waiter') AND NOT EXISTS(SELECT 1 FROM archived_accounts a WHERE a.user_id=u.id) ORDER BY u.id").all();}
 event(job,action,body,now,actor=null){this.db.prepare('INSERT INTO staff_sms_events(job_id,user_id,actor,action,body,created_at) VALUES(?,?,?,?,?,?)').run(job?.id??null,job?.user_id??body.userId??null,actor,action,JSON.stringify(body),now);}
 saveContact(b,u,now=Date.now()){
  owner(u);if(!Number.isSafeInteger(b.userId)||!this.people().some(p=>p.userId===b.userId))fail('Учётная запись не найдена.',404);
  if(!Number.isSafeInteger(b.revision)||b.revision<0||typeof b.phone!=='string'||b.phone.length>32)fail('Проверьте телефон и версию записи.');
  const number=b.phone.trim()?this.options.phone(b.phone):'';
  this.tx(()=>{const old=this.db.prepare('SELECT * FROM staff_sms_contacts WHERE user_id=?').get(b.userId);if((old?.revision??0)!==b.revision)fail('Телефон уже изменён. Обновите учётные записи.',409);
   this.db.prepare('INSERT INTO staff_sms_contacts(user_id,phone,revision,updated_at,updated_by) VALUES(?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,revision=revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(b.userId,number,now,u.id);
   this.event(null,'contact_changed',{userId:b.userId,revision:(old?.revision??0)+1,phoneConfigured:!!number},now,u.id);
  });this.sync(now);return this.snapshot(u);
 }
 saveSettings(b,u,now=Date.now()){owner(u);if(typeof b.enabled!=='boolean'||!Number.isSafeInteger(b.revision))fail('Проверьте настройку.');this.tx(()=>{const result=this.db.prepare('UPDATE staff_sms_settings SET enabled=?,revision=revision+1 WHERE id=1 AND revision=?').run(b.enabled?1:0,b.revision);if(!result.changes)fail('Настройки уже изменены.',409);this.event(null,'settings_changed',{enabled:b.enabled},now,u.id);});return this.snapshot(u);}
 plans(now,futureOnly=true){
  return this.db.prepare("SELECT s.*,c.phone FROM staff_schedule s JOIN admin_users u ON u.id=s.user_id LEFT JOIN staff_sms_contacts c ON c.user_id=s.user_id WHERE s.confirmed=1 AND u.login<>'admin' AND u.role IN ('admin','staff','waiter') AND NOT EXISTS(SELECT 1 FROM archived_accounts a WHERE a.user_id=u.id)").all().map(row=>({...row,times:staffReminderTimes(row.day,row.plan_start)})).filter(row=>row.times&&(!futureOnly||row.times.start>now));
 }
 sync(now=Date.now()){
  return this.tx(()=>{
   const assigned=this.plans(now,false),plans=assigned.filter(p=>p.times.start>now),keys=new Set(assigned.map(p=>p.user_id+'|'+p.day+'|'+p.times.start));
   for(const job of this.db.prepare('SELECT * FROM staff_sms_jobs WHERE status IN (\'scheduled\',\'retry\',\'needs_phone\',\'sending\',\'unknown\',\'accepted\')').all()){
    const eligible=keys.has(job.user_id+'|'+job.day+'|'+job.start_at),expired=job.expires_at<=now;
    if(!eligible||expired&&pending.has(job.status)){
     const reason=eligible?'expired':job.start_at<=now?'expired':'schedule_changed';
     if(pending.has(job.status)){this.db.prepare("UPDATE staff_sms_jobs SET status='cancelled',cancel_reason=? WHERE id=?").run(reason,job.id);this.event(job,'cancelled',{reason},now);}
     else if(!eligible&&job.cancel_reason!==reason){this.db.prepare('UPDATE staff_sms_jobs SET cancel_reason=? WHERE id=?').run(reason,job.id);this.event(job,'schedule_changed_after_dispatch',{reason},now);}
    }
   }
   for(const plan of plans)for(const kind of ['evening','hour']){
    const times=plan.times[kind],status=times.expires<=now?'cancelled':plan.phone?'scheduled':'needs_phone';
    const inserted=this.db.prepare('INSERT INTO staff_sms_jobs(user_id,day,start_at,kind,due,expires_at,status,cancel_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,day,start_at,kind) DO NOTHING').run(plan.user_id,plan.day,plan.times.start,kind,times.due,times.expires,status,status==='cancelled'?'expired':'',now);
    const job=this.db.prepare('SELECT * FROM staff_sms_jobs WHERE user_id=? AND day=? AND start_at=? AND kind=?').get(plan.user_id,plan.day,plan.times.start,kind);
    if(inserted.changes)this.event(job,status==='cancelled'?'cancelled':'scheduled',{due:times.due,status,...(status==='cancelled'?{reason:'expired'}:{})},now);
    else if(status!=='cancelled'&&job.status==='cancelled'&&job.provider_id===null&&job.sent_at===null&&job.attempts<5){this.db.prepare('UPDATE staff_sms_jobs SET status=?,due=?,cancel_reason=\'\',last_error=\'\' WHERE id=?').run(status,times.due,job.id);this.event(job,'resumed',{due:times.due,status},now);}
    else if(job.status==='needs_phone'&&plan.phone){this.db.prepare("UPDATE staff_sms_jobs SET status='scheduled',last_error='' WHERE id=?").run(job.id);this.event(job,'phone_available',{},now);}
    else if(pending.has(job.status)&&!plan.phone&&job.status!=='needs_phone'){this.db.prepare("UPDATE staff_sms_jobs SET status='needs_phone',last_error='' WHERE id=?").run(job.id);this.event(job,'needs_phone',{},now);}
   }
  });
 }
 snapshot(u){owner(u);const config=this.config(),s=this.options.settings();return {enabled:!!config.enabled,revision:config.revision,transport:{enabled:s.enabled&&s.configured&&s.transportEnabled,dailyLimit:s.dailyLimit,sign:s.sign},people:this.people(),
  jobs:this.db.prepare('SELECT j.*,coalesce(p.display_name,u.login) name FROM staff_sms_jobs j JOIN admin_users u ON u.id=j.user_id LEFT JOIN employee_profiles p ON p.user_id=u.id ORDER BY j.id DESC LIMIT 200').all().map(j=>({id:j.id,userId:j.user_id,name:j.name,day:j.day,startTime:clock(j.start_at),kind:j.kind,due:j.due,expires:j.expires_at,status:j.status,attempts:j.attempts,lastError:j.last_error,sentAt:j.sent_at,providerId:j.provider_id,cancelReason:j.cancel_reason})),
  events:this.db.prepare('SELECT id,job_id jobId,user_id userId,action,body,created_at at FROM staff_sms_events ORDER BY id DESC LIMIT 200').all().map(e=>({...e,body:JSON.parse(e.body)}))};}
 claim(id,now,fresh=false){return this.tx(()=>{
  if(fresh)now=Date.now();
  const job=this.db.prepare('SELECT * FROM staff_sms_jobs WHERE id=?').get(id),s=this.options.settings();
  if(!job||!['scheduled','retry'].includes(job.status)||job.due>now||!this.config().enabled||!s.enabled||!s.configured||!s.transportEnabled)return null;
  const plan=this.plans(now).find(p=>p.user_id===job.user_id&&p.day===job.day&&p.times.start===job.start_at);
  if(!plan||job.expires_at<=now){this.db.prepare("UPDATE staff_sms_jobs SET status='cancelled',cancel_reason=? WHERE id=?").run(!plan?'schedule_changed':'expired',id);this.event(job,'cancelled',{reason:!plan?'schedule_changed':'expired'},now);return null;}
  if(!plan.phone){this.db.prepare("UPDATE staff_sms_jobs SET status='needs_phone' WHERE id=?").run(id);this.event(job,'needs_phone',{},now);return null;}
  if(dailySmsUsed(this.db,now)>=s.dailyLimit){if(job.last_error!=='Достигнут общий дневной лимит SMS.'){this.db.prepare('UPDATE staff_sms_jobs SET last_error=? WHERE id=?').run('Достигнут общий дневной лимит SMS.',id);this.event(job,'daily_limit',{},now);}return null;}
  const text=this.options.prepareSmsText(job.kind==='evening'?`Станция СТАРТ. Завтра у вас смена с ${clock(job.start_at)}. Пожалуйста, не опаздывайте!`:`Станция СТАРТ. Через час у вас начало смены, в ${clock(job.start_at)}. Пожалуйста, не опаздывайте!`,'staff_'+job.kind).text;
  const changed=this.db.prepare("UPDATE staff_sms_jobs SET status='sending',claimed_at=?,attempts=attempts+1,phone=?,payload=?,last_error='' WHERE id=? AND status IN ('scheduled','retry')").run(now,plan.phone,text,id);if(!changed.changes)return null;
  this.event(job,'attempt',{attempt:job.attempts+1},now);return {...job,attempts:job.attempts+1,number:plan.phone,text,sign:s.sign};
 });}
 finish(job,result,now){this.tx(()=>{
  const current=this.db.prepare('SELECT * FROM staff_sms_jobs WHERE id=?').get(job.id);if(!current||!['sending','unknown'].includes(current.status))return;
  const accepted=result?.ok&&Number.isSafeInteger(Number(result.data?.id))&&Number(result.data.id)>0;
  if(accepted){this.db.prepare("UPDATE staff_sms_jobs SET status='accepted',provider_id=?,sent_at=?,last_error='' WHERE id=?").run(Number(result.data.id),now,job.id);this.event(job,'accepted',{providerId:Number(result.data.id)},now);}
  else{
   const explicit=result?.ok===false&&result.retry===true&&!result.unknown,status=explicit?(job.attempts<5?'retry':'failed'):'unknown',error=explicit?'SMS Aero явно отклонил запрос.':'Отправка не подтверждена. Проверьте SMS Aero; автоматический повтор остановлен.';
   const due=now+Math.min(900000,(job.kind==='hour'?5000:60000)*2**(job.attempts-1));
   this.db.prepare('UPDATE staff_sms_jobs SET status=?,due=?,last_error=? WHERE id=?').run(status,due,error,job.id);this.event(job,status,{attempt:job.attempts,error},now);
  }
 });}
 async tick(service=this.options.service(),now=Date.now()){
  const fixed=arguments.length>=2;if(this.busy)return;this.busy=true;
  try{
   this.sync(now);
   this.tx(()=>{for(const job of this.db.prepare("SELECT * FROM staff_sms_jobs WHERE status='sending' AND claimed_at<?").all(now-120000)){this.db.prepare("UPDATE staff_sms_jobs SET status='unknown',last_error='Процесс прервался после начала отправки. Нужна сверка SMS Aero.' WHERE id=?").run(job.id);this.event(job,'unknown',{reason:'interrupted'},now);}});
   const settings=this.options.settings();if(!this.config().enabled||!settings.enabled||!settings.configured||!settings.transportEnabled)return;
   const sends=await Promise.allSettled(this.db.prepare("SELECT id FROM staff_sms_jobs WHERE status IN ('scheduled','retry') AND due<=? ORDER BY expires_at,due,id LIMIT 10").all(now).map(async row=>{
    const job=this.claim(row.id,fixed?now:Date.now(),!fixed);if(!job)return;
    let result;try{result=await service.send(job.number,job.text,job.sign);}catch{result={ok:false,unknown:true};}
    this.finish(job,result,fixed?now:Date.now());
   }));
   const checks=await Promise.allSettled(this.db.prepare("SELECT * FROM staff_sms_jobs WHERE status='accepted' AND provider_id IS NOT NULL AND coalesce(checked_at,sent_at,0)<? ORDER BY id LIMIT 10").all(now-60000).map(async job=>{
    let result;try{result=await service.status(job.provider_id);}catch{result={ok:false};}
    this.tx(()=>{this.db.prepare("UPDATE staff_sms_jobs SET checked_at=max(coalesce(checked_at,0),?) WHERE id=? AND status='accepted'").run(now,job.id);if(!result.ok)return;const status=Number(result.data?.status);if(status===1||[2,6].includes(status)){const next=status===1?'delivered':'failed';const changed=this.db.prepare('UPDATE staff_sms_jobs SET status=?,last_error=? WHERE id=? AND status=\'accepted\'').run(next,next==='failed'?'Провайдер сообщил о недоставке; автоматического повтора нет.':'',job.id);if(changed.changes)this.event(job,next,{providerStatus:status},now);}});
   }));
   const rejected=[...sends,...checks].find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
  }finally{this.busy=false;}
 }
}
export function staffSmsHandler(store,admin,origin){return async(req,res,url)=>{
 if(url.pathname!=='/api/admin/staff-sms')return false;
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));return true;};
 try{
  if(!store)return reply(503,{error:'SMS сотрудников недоступны.'});
  const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.slice(21),user=admin.user(token);if(!user)return reply(401,{error:'Войдите в админку.'});owner(user);
  if(req.method==='GET')return reply(200,store.snapshot(user));
  if(req.method!=='POST')return reply(405,{error:'Метод недоступен.'});
  if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return reply(403,{error:'Недопустимый источник.'});
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>4096)return reply(413,{error:'Слишком большой запрос.'});chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return reply(400,{error:'Неверный запрос.'});}
  if(!body||typeof body!=='object'||Array.isArray(body))return reply(400,{error:'Неверный запрос.'});
  if(body.action==='contact'){const result=store.saveContact(body,user);store.wake?.();return reply(200,result);}
  if(body.action==='settings'){const result=store.saveSettings(body,user);store.wake?.();return reply(200,result);}
  return reply(400,{error:'Неизвестное действие.'});
 }catch(error){return reply(error.status||500,{error:error.status?error.message:'Не удалось изменить SMS сотрудников.'});}
};}

export function startStaffSmsWorker(store,{setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now,onError=()=>console.error('Staff SMS worker unavailable; inspect staff SMS journal')}={}){
 let timer,stopped=false,running=false,again=false;
 const delay=()=>{const at=now(),next=store.db.prepare("SELECT min(due) due FROM staff_sms_jobs WHERE status IN ('scheduled','retry') AND due>? AND expires_at>?").get(at,at)?.due;return next==null?5000:Math.max(1,Math.min(5000,next-at));};
 const run=async()=>{
  if(stopped)return;if(running){again=true;return;}running=true;
  try{await store.tick();}catch{onError();}
  finally{running=false;if(!stopped){let wait=5000;try{wait=again?1:delay();}catch{onError();}again=false;timer=setTimer(run,wait);timer?.unref?.();}}
 };
 store.wake=()=>{if(stopped)return;clearTimer(timer);void run();};
 store.wake();
 return ()=>{stopped=true;clearTimer(timer);delete store.wake;};
}
