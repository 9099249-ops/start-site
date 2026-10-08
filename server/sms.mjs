import {bookingWindow,assertCapacity} from './calendar.mjs';
import {createHash} from 'node:crypto';
import {fleet} from './admin.mjs';
import {defaults} from './content.mjs';
import {bookingText} from './telegram.mjs';
import {StaffShiftReminders,dailySmsUsed} from './staff-sms.mjs';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function sanitizeSmsUrl(value){return String(value??'').trim().replace(/^https?:\/\//i,'');}
export function getSmsSegments(text){const characters=String(text??'').length;const encoding=/[\u0080-\uFFFF]/.test(String(text??''))?'UCS-2':'GSM-7';const single=encoding==='UCS-2'?70:160;const multipart=encoding==='UCS-2'?67:153;return {encoding,characters,segments:characters<=single?1:Math.ceil(characters/multipart)};}
export function prepareSmsText(text,kind='sms'){const value=String(text??'').replace(/https?:\/\//gi,'').replace(/[ \t]{2,}/g,' ').replace(/\s+([,.!?])/g,'$1').trim();if(!/[А-Яа-яЁё]/.test(value))throw new Error('SMS должен содержать кириллицу.');const info=getSmsSegments(value);if(info.segments>=3)console.warn('SMS_TOO_LONG',JSON.stringify({kind,characters:info.characters,segments:info.segments}));return {text:value,...info};}
export function phone(value){let p=String(value||'').replace(/[^\d]/g,'');if(p.length===10)p='7'+p;if(p.length===11&&p[0]==='8')p='7'+p.slice(1);if(!/^7\d{10}$/.test(p))fail('Укажите российский телефон: +7 и 10 цифр.');return p;}
const day=now=>new Date(now+10800000).toISOString().slice(0,10);
export const startAt=b=>b.plan==='season'?NaN:Date.parse(`${b.date}T${b.time}:00+03:00`);
const accepted=['accepted','delivered','unknown','sending'];
export class SmsService {
 constructor(env=process.env,request=fetch){this.env=env;this.request=request;}
 async call(path,body){
  try{const r=await this.request('https://gate.smsaero.ru/v2/'+path,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(this.env.SMSAERO_EMAIL+':'+this.env.SMSAERO_API_KEY).toString('base64'),'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
   const result=await r.json();
   if(result.success===true&&result.data)return {ok:true,data:result.data};
   // A structured rejection explicitly reports that this attempt was not accepted.
   if(result.success===false)return {ok:false,retry:true,error:'Провайдер отклонил запрос (HTTP '+r.status+'). Проверьте баланс, отправителя и модерацию.'};
   return {ok:false,unknown:true,error:'Неоднозначный ответ провайдера; автоматический повтор остановлен.'};
  }catch{return {ok:false,unknown:true,error:'Ответ провайдера не получен. Возможна отправка; требуется сверка, чтобы не создать дубль.'};}
 }
 async send(number,text,sign){const prepared=prepareSmsText(text,'provider');console.info('SMS_LENGTH',JSON.stringify({characters:prepared.characters,segments:prepared.segments,encoding:prepared.encoding}));return this.call('sms/send',{number,text:prepared.text,sign});}
 status(id){return this.call('sms/status',{id});}
}

export class SmsStore {
 constructor(admin,content=null,env=process.env){this.admin=admin;this.db=admin.db;this.content=content;this.env=env;this.busy=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY,phone TEXT NOT NULL UNIQUE,name TEXT NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,marketing_consent INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS sms_settings(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS discounts(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),code TEXT NOT NULL,amount INTEGER NOT NULL,created INTEGER NOT NULL,consent INTEGER NOT NULL,source TEXT NOT NULL,redeemed INTEGER,redeemed_by INTEGER,UNIQUE(client_id,code));
   CREATE TABLE IF NOT EXISTS sms_jobs(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,inquiry_id INTEGER,discount_id INTEGER,client_id INTEGER NOT NULL REFERENCES clients(id),generation INTEGER NOT NULL DEFAULT 0,booking_start INTEGER,due INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',sent_at INTEGER,provider_id INTEGER,claimed_at INTEGER,payload TEXT,phone TEXT,cancel_reason TEXT,changed INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,checked_at INTEGER,UNIQUE(inquiry_id,generation),UNIQUE(discount_id));
   CREATE INDEX IF NOT EXISTS sms_due ON sms_jobs(status,due);
   CREATE TABLE IF NOT EXISTS discount_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
  this.db.prepare('INSERT OR IGNORE INTO sms_settings(id,body) VALUES(1,?)').run(JSON.stringify({enabled:false,promoEnabled:true,remindersEnabled:true,sign:'СТАРТ',YANDEX_NAVIGATOR_URL:'https://yandex.ru/navi/org/start/239145365381',BOOKING_LATE_CANCEL_MINUTES:15,dailyLimit:10,promoCode:'АЭЛИТА',promoAmount:100}));
  const stored=this.db.prepare('SELECT body FROM sms_settings WHERE id=1').get();let migrated;try{migrated=JSON.parse(stored.body);}catch{migrated={};}let changed=false;if(['SMS Aero','START'].includes(migrated.sign)){migrated.sign='СТАРТ';changed=true;}if(['AELITA','START10','PROMO10','TEST'].includes(migrated.promoCode)){migrated.promoCode='АЭЛИТА';changed=true;}if(changed)this.db.prepare('UPDATE sms_settings SET body=?,revision=revision+1 WHERE id=1').run(JSON.stringify(migrated));
  this.staffReminders=new StaffShiftReminders(admin,{phone,prepareSmsText,settings:()=>this.settings(),service:()=>new SmsService(this.env)});
  admin.sms=this;this.sync();
 }
 settings(){const row=this.db.prepare('SELECT * FROM sms_settings WHERE id=1').get();return {...JSON.parse(row.body),STATION_PHONE:this.content?.live().phone||defaults.phone,revision:row.revision,configured:Boolean(this.env.SMSAERO_EMAIL&&this.env.SMSAERO_API_KEY),transportEnabled:this.env.SMS_ENABLED==='true'};}
 save(b,user){if(user.role!=='admin')fail('Настройки доступны администратору.',403);const current=this.settings();if(current.revision!==b.revision)fail('Настройки уже изменены. Обновите страницу.',409);
  let url;try{url=new URL(b.YANDEX_NAVIGATOR_URL);}catch{fail('Проверьте ссылку на Яндекс.');}if(url.protocol!=='https:'||!['yandex.ru','yandex.com','maps.yandex.ru'].includes(url.hostname)||url.username||url.password||b.YANDEX_NAVIGATOR_URL.length>300)fail('Нужна HTTPS-ссылка на Яндекс.Карты или Навигатор.');
  for(const [k,min,max] of [['BOOKING_LATE_CANCEL_MINUTES',1,120],['dailyLimit',1,1000],['promoAmount',1,100000]])if(!Number.isInteger(b[k])||b[k]<min||b[k]>max)fail('Проверьте числовые настройки.');
  for(const k of ['enabled','promoEnabled','remindersEnabled'])if(typeof b[k]!=='boolean')fail('Проверьте переключатели.');
  for(const k of ['sign','promoCode'])if(typeof b[k]!=='string'||!b[k].trim()||b[k].length>32||/[\x00-\x1f]/.test(b[k])||!/[А-Яа-яЁё]/.test(b[k]))fail('Имя отправителя и промокод должны быть на кириллице.');
  const value={};for(const k of ['enabled','promoEnabled','remindersEnabled','sign','YANDEX_NAVIGATOR_URL','BOOKING_LATE_CANCEL_MINUTES','dailyLimit','promoCode','promoAmount'])value[k]=b[k];
  const result=this.db.prepare('UPDATE sms_settings SET body=?,revision=revision+1 WHERE id=1 AND revision=?').run(JSON.stringify(value),b.revision);if(!result.changes)fail('Настройки уже изменились.',409);this.admin.audit(user,'sms_settings');return this.settings();
 }
 client(name,number,now=Date.now(),consent=false){const p=phone(number);this.db.prepare('INSERT INTO clients(phone,name,first_seen,last_seen,marketing_consent) VALUES(?,?,?,?,?) ON CONFLICT(phone) DO UPDATE SET name=CASE WHEN excluded.last_seen>=clients.last_seen THEN excluded.name ELSE clients.name END,last_seen=max(clients.last_seen,excluded.last_seen),first_seen=min(clients.first_seen,excluded.first_seen),marketing_consent=max(clients.marketing_consent,excluded.marketing_consent)').run(p,name,now,now,consent?1:0);return this.db.prepare('SELECT * FROM clients WHERE phone=?').get(p);}
 sync(now=Date.now()){
  for(const r of this.db.prepare('SELECT id,details,status,updated,created FROM inquiries').all()){
   const b=JSON.parse(r.details);let c;try{c=this.client(b.name,b.phone,r.updated);}catch{continue;}
   const start=startAt(b),last=this.db.prepare('SELECT * FROM sms_jobs WHERE inquiry_id=? ORDER BY generation DESC LIMIT 1').get(r.id);
   const active=r.status==='confirmed'&&Number.isFinite(start)&&start>now;
   const changed=last&&last.booking_start!==start;
   if(last&&(!active||changed)&&['scheduled','retry','sending','unknown'].includes(last.status)){
    const reason=changed?'rescheduled':r.status==='cancelled'||r.status==='deleted'?'cancelled':r.status==='issued'||r.status==='completed'?'completed':'expired';
    if(['sending','unknown'].includes(last.status))this.db.prepare('UPDATE sms_jobs SET cancel_reason=? WHERE id=?').run(reason,last.id);
    else this.db.prepare("UPDATE sms_jobs SET status='cancelled',cancel_reason=? WHERE id=?").run(reason,last.id);
   }
   if(active&&(!last||changed)){
    const notified=this.db.prepare("SELECT id FROM sms_jobs WHERE inquiry_id=? AND (sent_at IS NOT NULL OR status IN ('unknown','sending')) LIMIT 1").get(r.id);
    this.db.prepare('INSERT INTO sms_jobs(kind,inquiry_id,client_id,generation,booking_start,due,changed,created) VALUES(?,?,?,?,?,?,?,?)').run('reminder',r.id,c.id,(last?.generation||0)+1,start,notified?now:Math.max(now,start-3600000),notified?1:0,now);
   }
  }
  // Missing/deleted rows cannot leave reminders queued.
  this.db.exec("UPDATE sms_jobs SET status='cancelled',cancel_reason='cancelled' WHERE inquiry_id IS NOT NULL AND inquiry_id NOT IN(SELECT id FROM inquiries) AND status IN ('scheduled','retry')");
  for(const r of this.db.prepare('SELECT name,phone,created FROM rentals').all())try{this.client(r.name,r.phone,r.created);}catch{}
 }
 reschedule(b,user,now=Date.now()){
  const r=this.db.prepare('SELECT * FROM inquiries WHERE id=?').get(b.id);if(!r||r.revision!==b.revision||!['new','confirmed'].includes(r.status))fail('Заявка уже изменена или неактивна.',409);
  const details={...JSON.parse(r.details),date:b.date,time:b.time};if(details.plan==='takeaway'&&b.returnDate)details.returnDate=b.returnDate;if(details.plan==='season')fail('У абонемента нет времени посещения.');bookingText(details,new Date(now),this.content?.live());if(startAt(details)<=now)fail('Укажите будущее время.');
  this.db.exec('BEGIN IMMEDIATE');try{if(r.status==='confirmed')assertCapacity(this.db,fleet,bookingWindow(details,this.content?.live().close),{ignoreInquiry:r.id,now,close:this.content?.live().close});const result=this.db.prepare('UPDATE inquiries SET details=?,revision=revision+1,actor=?,updated=? WHERE id=? AND revision=?').run(JSON.stringify(details),user.id,now,b.id,b.revision);if(!result.changes)fail('Заявка уже изменена.',409);this.db.prepare('INSERT INTO inquiry_events(inquiry_id,actor,status,created) VALUES(?,?,?,?)').run(b.id,user.id,'rescheduled '+details.date+' '+details.time,now);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}this.sync(now);
 }
 promo(b,ip,now=Date.now()){
  const s=this.settings();if(!s.enabled||!s.promoEnabled||!s.configured||!s.transportEnabled)fail('СМС со скидкой пока недоступны.',503);
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80||/[\x00-\x1f]/.test(b.name)||b.website||b.consent!==true)fail('Укажите имя и согласие на обработку заявки.');const p=phone(b.phone);
  this.db.exec('BEGIN IMMEDIATE');try{
   this.db.prepare('DELETE FROM discount_limits WHERE expires<=?').run(now);
   for(const key of ['ip:'+ip,'phone:'+p]){const h=createHash('sha256').update(key).digest('hex');const row=this.db.prepare('SELECT count FROM discount_limits WHERE key=?').get(h);if(row?.count>=3)fail('Повторите через час.',429);this.db.prepare('INSERT INTO discount_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(h,now+3600000);}
   const c=this.client(b.name.trim(),p,now,b.marketing===true);const source=JSON.stringify({utm_source:String(b.utm_source||'').slice(0,100),utm_campaign:String(b.utm_campaign||'').slice(0,100)});
   const d=this.db.prepare('INSERT INTO discounts(client_id,code,amount,created,consent,source) VALUES(?,?,?,?,?,?) ON CONFLICT(client_id,code) DO NOTHING').run(c.id,s.promoCode,s.promoAmount,now,b.marketing===true?1:0,source);
   if(d.changes)this.db.prepare('INSERT INTO sms_jobs(kind,discount_id,client_id,due,created) VALUES(?,?,?,?,?)').run('promo',Number(d.lastInsertRowid),c.id,now,now);
   this.db.exec('COMMIT');return {ok:true,duplicate:!d.changes,message:'Заявка сохранена. СМС поступит после обработки оператором. Повторная заявка не отправляет ещё одно СМС.'};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 message(job){const s=this.settings(),client=this.db.prepare('SELECT * FROM clients WHERE id=?').get(job.client_id);
  if(job.kind==='promo'){const d=this.db.prepare('SELECT * FROM discounts WHERE id=?').get(job.discount_id);return {number:client.phone,text:prepareSmsText(`СТАРТ: промокод ${d.code} на водные развлечения. spotsup.ru Маршрут: ${sanitizeSmsUrl(s.YANDEX_NAVIGATOR_URL)}`,'promo').text};}
  const r=this.db.prepare('SELECT * FROM inquiries WHERE id=?').get(job.inquiry_id);if(!r||r.status!=='confirmed')return null;const b=JSON.parse(r.details);if(startAt(b)!==job.booking_start)return null;
  const label=this.content?.live().inventory.find(i=>i.id===b.equipment)?.name||fleet.find(i=>i[0]===b.equipment)?.[1]||b.equipment;
  return {number:phone(b.phone),text:prepareSmsText(`СТАРТ: ${job.changed?'время брони изменено. Новое время':'бронь через 1 час'}, ${label}, ${b.time}. Опоздание более ${s.BOOKING_LATE_CANCEL_MINUTES} мин — бронь отменяется. ${sanitizeSmsUrl(s.YANDEX_NAVIGATOR_URL)} Тел. ${s.STATION_PHONE}`,'reminder').text};
 }
 async tick(service=new SmsService(this.env),now=Date.now()){
  const fixedTime=arguments.length>=2;
  if(this.busy)return;this.busy=true;try{
   this.sync(now);
   this.db.prepare("UPDATE sms_jobs SET status='unknown',last_error='Работа прервалась после начала отправки. Проверьте кабинет SMS Aero.' WHERE status='sending' AND claimed_at<?").run(now-120000);
   const s=this.settings();if(!s.enabled||!s.configured||!s.transportEnabled)return;
   for(const j of this.db.prepare("SELECT * FROM sms_jobs WHERE status IN ('scheduled','retry') AND due<=? ORDER BY due,id LIMIT 10").all(now)){
    if(!fixedTime)now=Date.now();
    if((j.kind==='promo'&&!s.promoEnabled)||(j.kind==='reminder'&&!s.remindersEnabled))continue;
    // Claim and daily quota reservation are one SQLite transaction, safe across workers.
    this.db.exec('BEGIN IMMEDIATE');let message;
    try{const count=dailySmsUsed(this.db,now);if(count>=s.dailyLimit){this.db.exec('COMMIT');break;}
     message=this.message(j);if(!message||j.kind==='reminder'&&j.booking_start<=now){this.db.prepare("UPDATE sms_jobs SET status='cancelled',cancel_reason='expired' WHERE id=? AND status IN ('scheduled','retry')").run(j.id);this.db.exec('COMMIT');continue;}
     const claim=this.db.prepare("UPDATE sms_jobs SET status='sending',attempts=attempts+1,claimed_at=?,payload=?,phone=? WHERE id=? AND status IN ('scheduled','retry')").run(now,message.text,message.number,j.id);this.db.exec('COMMIT');if(!claim.changes)continue;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    const result=await service.send(message.number,message.text,s.sign);
    if(result.ok&&Number.isSafeInteger(Number(result.data.id))&&Number(result.data.id)>0)this.db.prepare("UPDATE sms_jobs SET status='accepted',provider_id=?,sent_at=?,last_error='' WHERE id=?").run(Number(result.data.id),fixedTime?now:Date.now(),j.id);
    else {const attempts=j.attempts+1;const unknown=result.unknown||result.ok;this.db.prepare('UPDATE sms_jobs SET status=?,due=?,last_error=? WHERE id=?').run(unknown?'unknown':attempts<5?'retry':'failed',now+Math.min(900000,60000*2**(attempts-1)),result.error||'Не получен номер сообщения. Нужна сверка.',j.id);}
   }
   for(const j of this.db.prepare("SELECT * FROM sms_jobs WHERE status='accepted' AND provider_id IS NOT NULL AND coalesce(checked_at,sent_at,0)<? ORDER BY id LIMIT 10").all(now-60000)){
    const result=await service.status(j.provider_id);this.db.prepare('UPDATE sms_jobs SET checked_at=? WHERE id=?').run(now,j.id);
    if(result.ok){const status=Number(result.data.status);if(status===1)this.db.prepare("UPDATE sms_jobs SET status='delivered' WHERE id=?").run(j.id);else if([2,6].includes(status))this.db.prepare("UPDATE sms_jobs SET status='failed',last_error='Провайдер сообщил о недоставке или отклонении; автоматический повтор отключён.' WHERE id=?").run(j.id);}
   }
  }finally{this.busy=false;}
 }
 jobs(id){return this.db.prepare('SELECT id,kind,status,booking_start,due,sent_at,attempts,last_error,cancel_reason,provider_id FROM sms_jobs WHERE inquiry_id=? ORDER BY id DESC').all(id);}
 clients(query=''){const q='%'+query.slice(0,100)+'%';return this.db.prepare('SELECT * FROM clients WHERE name LIKE ? OR phone LIKE ? ORDER BY last_seen DESC LIMIT 100').all(q,q).map(c=>({...c,discounts:this.db.prepare('SELECT * FROM discounts WHERE client_id=? ORDER BY id DESC').all(c.id),bookings:this.db.prepare('SELECT id,details,status FROM inquiries').all().filter(r=>{try{return phone(JSON.parse(r.details).phone)===c.phone;}catch{return false;}})}));}
 redeem(id,user){this.db.prepare('UPDATE discounts SET redeemed=?,redeemed_by=? WHERE id=? AND redeemed IS NULL').run(Date.now(),user.id,id);this.admin.audit(user,'promo_redeemed',null);}
}

export function smsHandler(store,admin,origin){return async(req,res,url)=>{
 if(!['/api/discount','/api/discount-config','/api/admin/sms','/api/admin/sms-settings','/api/admin/clients','/api/admin/promo-redeem','/api/admin/inquiry-reschedule'].includes(url.pathname))return false;
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));return true;};
 try{if(!store)return reply(503,{error:'Недоступно'});let user;
  if(url.pathname.startsWith('/api/admin/')){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.split('=')[1];user=admin.user(token);if(!user)return reply(401,{error:'Войдите в админку.'});}
  if(user?.role==='waiter')return reply(403,{error:'Недоступно для официанта.'});
  if(req.method==='GET'){
   if(url.pathname==='/api/discount-config'){const s=store.settings();return reply(200,{enabled:s.enabled&&s.promoEnabled&&s.configured&&s.transportEnabled,amount:s.promoAmount});}
   if(url.pathname==='/api/admin/sms'){const s=store.settings();return reply(200,{settings:user.role==='admin'?s:null,jobs:url.searchParams.has('inquiry')?store.jobs(Number(url.searchParams.get('inquiry'))):store.db.prepare('SELECT id,kind,inquiry_id,status,due,sent_at,attempts,last_error,cancel_reason FROM sms_jobs ORDER BY id DESC LIMIT 100').all()});}
   if(url.pathname==='/api/admin/clients')return reply(200,{clients:store.clients(url.searchParams.get('q')||'')});
   return reply(405,{error:'Метод не поддерживается.'});
  }
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return reply(403,{error:'Недопустимый источник.'});
  let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>4096)return reply(413,{error:'Слишком большой запрос.'});chunks.push(c);}let b;try{b=JSON.parse(Buffer.concat(chunks));}catch{return reply(400,{error:'Неверный запрос.'});}if(!b||Array.isArray(b)||typeof b!=='object')return reply(400,{error:'Неверный запрос.'});
  if(url.pathname==='/api/discount'){const result=store.promo(b,req.headers['x-real-ip']||req.socket.remoteAddress);void store.tick().catch(()=>{});return reply(200,result);}
  if(url.pathname==='/api/admin/sms-settings')return reply(200,{settings:store.save(b,user)});
  if(url.pathname==='/api/admin/inquiry-reschedule'){store.reschedule(b,user);void store.tick().catch(()=>{});return reply(200,{ok:true});}
  if(url.pathname==='/api/admin/promo-redeem'){store.redeem(b.id,user);return reply(200,{ok:true});}
  return reply(405,{error:'Метод не поддерживается.'});
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось выполнить операцию.'});}
};}
