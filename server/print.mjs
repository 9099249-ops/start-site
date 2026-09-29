import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const owner=u=>{if(!u)fail('Войдите в админку.',401);if(u.role!=='admin')fail('Печать финансового отчёта доступна администратору.',403);};
const staff=u=>{if(!u)fail('Войдите в админку.',401);if(!['admin','staff','waiter'].includes(u.role))fail('Нет доступа.',403);};
const day=now=>new Date(now+10800000).toISOString().slice(0,10);
export const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const payloadHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function rubles(cents){if(!Number.isSafeInteger(cents)||Math.abs(cents)>100000000000)fail('Некорректная сумма отчёта.');const n=BigInt(cents),a=n<0n?-n:n;return (n<0n?'-':'')+String(a/100n)+'.'+String(a%100n).padStart(2,'0');}
const label=(v,max=500)=>Array.from(String(v??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/[\uD800-\uDFFF]/gu,'�').trim()).slice(0,max).join('');
const id=v=>{if(typeof v!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(v))fail('Неверный идентификатор.');return v;};

export class PrintStore {
 constructor(admin,{env=process.env}={}){
  this.admin=admin;this.db=admin.db;this.env=env;
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS print_documents(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,snapshot TEXT NOT NULL,created_at INTEGER NOT NULL,created_by INTEGER REFERENCES admin_users(id));
   CREATE TABLE IF NOT EXISTS print_jobs(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES print_documents(id),operation TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,parent_job_id TEXT REFERENCES print_jobs(id),status TEXT NOT NULL DEFAULT 'queued',sequence INTEGER NOT NULL DEFAULT 0,attempt_id TEXT,cups_id INTEGER,offered_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS print_jobs_pending ON print_jobs(status,created_at);
   CREATE TABLE IF NOT EXISTS print_events(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES print_jobs(id),sequence INTEGER NOT NULL,body TEXT NOT NULL,received_at INTEGER NOT NULL,UNIQUE(job_id,sequence));
   CREATE TABLE IF NOT EXISTS print_audit(id INTEGER PRIMARY KEY,job_id TEXT,actor INTEGER REFERENCES admin_users(id),action TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS print_device(id TEXT PRIMARY KEY,database_id TEXT NOT NULL,heartbeat TEXT NOT NULL,last_seen INTEGER NOT NULL);
  `);
 }
 enabled(){return this.env.PRINT_ENABLED==='true';}
 configured(){return this.enabled()&&String(this.env.PRINT_AGENT_TOKEN||'').length>=32&&!!this.env.PRINT_AGENT_DATABASE_ID;}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 audit(job,u,action,reason='',now=Date.now()){this.db.prepare('INSERT INTO print_audit(job_id,actor,action,reason,created_at) VALUES(?,?,?,?,?)').run(job,u?.id??null,action,label(reason,300),now);}
 enqueue(sourceKey,payload,snapshot,u,now=Date.now()){
  const old=this.db.prepare('SELECT id FROM print_documents WHERE source_key=?').get(sourceKey);
  if(old)return this.job(this.db.prepare("SELECT id FROM print_jobs WHERE document_id=? AND operation='submit'").get(old.id).id);
  if(this.db.prepare("SELECT count(*) n FROM print_jobs WHERE status IN ('queued','received','printing')").get().n>=10000)fail('Очередь печати заполнена.',503);
  const documentId=randomUUID(),jobId=randomUUID();
  this.db.prepare('INSERT INTO print_documents VALUES(?,?,?,?,?,?,?,?)').run(documentId,sourceKey,payload.type,canonical(payload),payloadHash(payload),JSON.stringify(snapshot),now,u?.id??null);
  this.db.prepare('INSERT INTO print_jobs(id,document_id,operation,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(jobId,documentId,'submit',sourceKey,now,now);
  this.audit(jobId,u,'submit','',now);return this.job(jobId);
 }
 job(jobId){const r=this.db.prepare('SELECT j.*,d.kind,d.payload,d.payload_hash,d.snapshot FROM print_jobs j JOIN print_documents d ON d.id=j.document_id WHERE j.id=?').get(jobId);if(!r)fail('Задание не найдено.',404);return {...r,payload:JSON.parse(r.payload),snapshot:JSON.parse(r.snapshot)};}
 selectedShift(shiftId,now){
  if(shiftId!==undefined&&(!Number.isSafeInteger(shiftId)||shiftId<1))fail('Неверная смена.');
  // The current day's shift wins. Otherwise use the most recent station shift,
  // including a still-open overnight shift, never a future scheduled day.
  const s=shiftId?this.db.prepare('SELECT * FROM shifts WHERE id=?').get(shiftId):this.db.prepare('SELECT * FROM shifts WHERE day<=? ORDER BY day DESC,id DESC LIMIT 1').get(day(now));
  if(!s)fail('Кассовых смен пока нет.',404);if(s.day>day(now))fail('Будущая смена ещё не началась.');return s;
 }
 reportSnapshot(shiftId,now=Date.now()){
  const s=this.selectedShift(shiftId,now),calc=this.admin.workforce.calculate(s.day,now);
  const employees=calc.employees.map(e=>{const paid=this.db.prepare('SELECT coalesce(sum(amount_cents),0) n FROM payroll_payments WHERE shift_id=? AND user_id=? AND paid_at<=?').get(s.id,e.user_id,now).n;const p=this.db.prepare('SELECT coalesce(p.display_name,u.login) name FROM admin_users u LEFT JOIN employee_profiles p ON p.user_id=u.id WHERE u.id=?').get(e.user_id);return {userId:e.user_id,name:label(p?.name||e.name,200),salaryCents:e.salary_cents,paidCents:paid,remainingCents:Math.max(0,e.salary_cents-paid-this.admin.refunds.closedAdjustment(s.id,e.user_id,now))};});
  return {shiftId:s.id,date:s.day,preliminary:!s.closed_at,asOf:now,totalCents:s.closed_at?s.total_revenue_cents:calc.revenue.cents,source:s.closed_at?'Итог кассы: кафе + прокат':calc.revenue.source,employees};
 }
 reportInfo(u,shiftId,now=Date.now()){
  owner(u);const snapshot=this.reportSnapshot(shiftId,now),base=`shift:${snapshot.shiftId}:${snapshot.preliminary?'preliminary':'final'}`;
  const docs=this.db.prepare("SELECT d.id FROM print_documents d WHERE source_key LIKE ? ORDER BY created_at DESC,rowid DESC").all(base+':%');
  const reports=docs.map(d=>this.job(this.db.prepare('SELECT id FROM print_jobs WHERE document_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(d.id).id));
  return {snapshot,reports,device:this.device(now)};
 }
 report(b,u,now=Date.now()){
  owner(u);if(!this.enabled())fail('Подключение печати ещё не включено.',503);
  return this.tx(()=>{const info=this.reportInfo(u,b.shiftId,now),latest=info.reports[0];
   if(latest&&!b.newRevision)return {job:latest,duplicate:true};
   if(b.newRevision){id(b.previousDocumentId);if(!latest)fail('Предыдущий отчёт не найден.',409);if(latest.document_id!==b.previousDocumentId)return {job:latest,duplicate:true};if(!label(b.reason,300))fail('Укажите причину новой редакции.');}
   const snapshot=info.snapshot,revision=info.reports.length+1,phase=snapshot.preliminary?'preliminary':'final';
   const payload={type:'shift_report',report_id:`start-shift-${snapshot.shiftId}-${phase}-v${revision}`,shift_id:String(snapshot.shiftId),date:snapshot.date,preliminary:snapshot.preliminary,revision,as_of:new Date(now).toISOString(),source:snapshot.source,total:rubles(snapshot.totalCents),transfers:snapshot.employees.filter(e=>e.remainingCents>0).map(e=>({recipient:e.name,amount:rubles(e.remainingCents)}))};
   const job=this.enqueue(`shift:${snapshot.shiftId}:${phase}:${revision}`,payload,snapshot,u,now);if(b.newRevision)this.audit(job.id,u,'new_revision',b.reason,now);return {job,duplicate:false};
  });
 }
 cafeEvent(eventId,u,now=Date.now()){
  // Called inside the cafe transaction: a committed order cannot lose its ticket.
  if(!this.enabled())return;
  const e=this.db.prepare('SELECT * FROM cafe_order_events WHERE id=?').get(eventId);if(!['NEW','ADD','CANCELLED','LOCATION'].includes(e?.kind))return;
  const r=this.db.prepare('SELECT * FROM cafe_orders WHERE id=?').get(e.order_id),d=JSON.parse(r.details),batch=JSON.parse(e.body);
  if(e.kind==='CANCELLED'){
   const prior=this.db.prepare("SELECT j.* FROM print_jobs j JOIN print_documents d ON d.id=j.document_id WHERE json_extract(d.snapshot,'$.orderId')=?").all(r.id);
   if(!prior.length)return;const delivered=prior.some(j=>j.offered_at!==null);
   for(const j of prior.filter(j=>j.status==='queued'&&j.offered_at===null)){this.db.prepare("UPDATE print_jobs SET status='cancelled',updated_at=? WHERE id=?").run(now,j.id);this.audit(j.id,u,'cancel_before_delivery','',now);}
   if(!delivered)return;
  }
  const items=e.kind==='CANCELLED'?d.items:batch.items;
  const payload={type:'cafe_order',order_id:`start-cafe-${r.id}-event-${e.id}`,order_number:String(r.id),ticket_kind:e.kind,order_source:['admin','waiter'].includes(r.source)?'admin':'site',customer_name:label(d.name),fulfillment:label((d.complimentary?'БЕСПЛАТНО · '+d.complimentary.recipientName+' · ':'')+(d.place?.name||{house:'Домик в яхт клубе: '+d.house,pickup:'Заберут в кафе',lounge:'Лаунж-зона',yacht:'На яхту / катер',place:'На месте'}[d.fulfillment])),comment:label([d.complimentary?'БЕСПЛАТНО. К оплате: 0 ₽. '+(d.complimentary.comment||''):'',d.yacht,d.location,d.deliveryCents!==undefined?'Доставка: '+rubles(d.deliveryCents)+' ₽':'',d.requestedAt?'К '+d.requestedAt:'',d.comment].filter(Boolean).join('\n'),1500),items:items.map(i=>({name:label(i.name,200),qty:i.quantity,price:rubles(d.complimentary?0:i.totalCents),modifiers:[i.variant?.name,...(i.modifiers||[]).map(m=>m.name),i.comment].filter(Boolean).map(x=>label(x,200))})),total:rubles(e.kind==='CANCELLED'?r.total_cents:batch.totalCents)};
  return this.enqueue(`cafe:event:${e.id}`,payload,{orderId:r.id,eventId:e.id,eventKind:e.kind},u,now);
 }
 cafeJobs(orderId,u){staff(u);if(!Number.isSafeInteger(orderId)||orderId<1)fail('Неверный заказ.');return {jobs:this.db.prepare("SELECT j.id FROM print_jobs j JOIN print_documents d ON d.id=j.document_id WHERE d.kind='cafe_order' AND json_extract(d.snapshot,'$.orderId')=? ORDER BY j.created_at,j.rowid").all(orderId).map(r=>this.job(r.id)),device:this.device()};}
 reprint(b,u,now=Date.now()){
  owner(u);if(!this.enabled())fail('Печать отключена.',503);id(b.jobId);if(!label(b.reason,300))fail('Укажите причину перепечатки.');
  return this.tx(()=>{const parent=this.job(b.jobId),key='reprint:'+parent.id,old=this.db.prepare('SELECT id FROM print_jobs WHERE request_key=?').get(key);if(old)return {job:this.job(old.id),duplicate:true};
   const latest=this.db.prepare('SELECT id,status FROM print_jobs WHERE document_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(parent.document_id);
   if(latest.id!==parent.id||!['printed','failed'].includes(parent.status))fail('Дождитесь завершения текущей попытки. При ошибке сначала проверьте принтер.',409);
   const jobId=randomUUID();this.db.prepare('INSERT INTO print_jobs(id,document_id,operation,request_key,parent_job_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(jobId,parent.document_id,'reprint',key,parent.id,now,now);this.audit(jobId,u,'reprint',b.reason,now);return {job:this.job(jobId),duplicate:false};
  });
 }
 device(now=Date.now()){const d=this.db.prepare('SELECT * FROM print_device WHERE id=?').get(this.env.PRINT_AGENT_ID||'station-printer-1');return {enabled:this.enabled(),configured:this.configured(),online:!!d&&now-d.last_seen<90000,lastSeen:d?.last_seen??null,health:d?JSON.parse(d.heartbeat):null};}
 authorize(req){const expected=String(this.env.PRINT_AGENT_TOKEN||''),actual=String(req.headers.authorization||'');if(expected.length<32||!this.configured())fail('Print agent not configured',503);const a=Buffer.from(actual),b=Buffer.from('Bearer '+expected);if(a.length!==b.length||!timingSafeEqual(a,b))fail('Unauthorized',401);if(req.headers['x-print-agent-id']!==(this.env.PRINT_AGENT_ID||'station-printer-1')||req.headers['x-print-database-id']!==this.env.PRINT_AGENT_DATABASE_ID)fail('Device database mismatch; manual pairing required',409);}
 poll(now=Date.now()){
  return this.tx(()=>{const rows=this.db.prepare("SELECT id FROM print_jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 10").all();let bytes=0;const jobs=[];for(const r of rows){const j=this.job(r.id),envelope={job_id:j.id,operation:j.operation,payload_hash:j.payload_hash,payload:j.payload};const n=Buffer.byteLength(JSON.stringify(envelope));if(jobs.length&&bytes+n>750000)break;bytes+=n;this.db.prepare('UPDATE print_jobs SET offered_at=coalesce(offered_at,?) WHERE id=?').run(now,j.id);jobs.push(envelope);}return {protocol_version:1,jobs};});
 }
 events(b,now=Date.now()){
  if(!Array.isArray(b.events)||b.events.length>100)fail('Invalid events');
  return this.tx(()=>{const accepted=[];for(const e of b.events){id(e.event_id);id(e.job_id);id(e.attempt_id);if(!Number.isSafeInteger(e.sequence)||e.sequence<1||!['received','printing','printed','failed'].includes(e.status))fail('Invalid event');if(e.cups_id!=null&&(!Number.isSafeInteger(e.cups_id)||e.cups_id<1))fail('Invalid CUPS id');const body=canonical(e),old=this.db.prepare('SELECT * FROM print_events WHERE id=? OR (job_id=? AND sequence=?)').get(e.event_id,e.job_id,e.sequence);if(old){if(old.id!==e.event_id||old.body!==body)fail('Event conflict',409);accepted.push(e.event_id);continue;}
   const j=this.job(e.job_id);if(j.payload_hash!==e.payload_hash||!j.offered_at||(j.attempt_id&&j.attempt_id!==e.attempt_id))fail('Attempt or payload conflict',409);
   if(e.sequence>j.sequence){const rank={queued:0,received:1,printing:2,printed:3,failed:3};if(rank[e.status]<rank[j.status]||(['printed','failed'].includes(j.status)&&e.status!==j.status))fail('Invalid status transition',409);this.db.prepare('UPDATE print_jobs SET status=?,sequence=?,attempt_id=?,cups_id=coalesce(?,cups_id),updated_at=? WHERE id=?').run(e.status,e.sequence,e.attempt_id,e.cups_id??null,now,j.id);}
   this.db.prepare('INSERT INTO print_events VALUES(?,?,?,?,?)').run(e.event_id,e.job_id,e.sequence,body,now);accepted.push(e.event_id);
  }return {accepted_event_ids:accepted};});
 }
 heartbeat(b,now=Date.now()){if(b.protocol_version!==1)fail('Unsupported protocol');const health={printing_enabled:b.printing_enabled===true,printer_configured:b.printer_configured===true,cups:b.cups===true,queue_length:Number.isSafeInteger(b.queue_length)?b.queue_length:0,printer_state:b.printer_state??null,physical_print_confirmed:false};this.db.prepare('INSERT INTO print_device VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET database_id=excluded.database_id,heartbeat=excluded.heartbeat,last_seen=excluded.last_seen').run(this.env.PRINT_AGENT_ID||'station-printer-1',this.env.PRINT_AGENT_DATABASE_ID,JSON.stringify(health),now);return {ok:true};}
}

export function printHandler(store,admin,origin){return async(req,res,url)=>{
 const agent=url.pathname.startsWith('/api/print-agent/v1/'),internal=url.pathname.startsWith('/api/admin/print/');if(!agent&&!internal)return false;
 const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));return true;};
 try{if(!store)fail('Печать не настроена.',503);let u;if(agent)store.authorize(req);else{const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-start_session='))?.slice(21);u=admin.user(token);staff(u);}
  const p=url.pathname.split('/').at(-1);
  if(req.method==='GET'){if(agent&&p==='jobs')return reply(200,store.poll());if(internal&&p==='report')return reply(200,store.reportInfo(u,url.searchParams.has('shiftId')?Number(url.searchParams.get('shiftId')):undefined));if(internal&&p==='cafe')return reply(200,store.cafeJobs(Number(url.searchParams.get('orderId')),u));if(internal&&p==='device')return reply(200,store.device());return reply(404,{error:'Не найдено.'});}
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});if(!req.headers['content-type']?.startsWith('application/json')||(!agent&&req.headers.origin!==origin))fail('Недопустимый источник запроса.',403);
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>(agent?262144:4096))fail('Запрос слишком большой.',413);chunks.push(chunk);}let b;try{b=JSON.parse(Buffer.concat(chunks));}catch{fail('Неверный запрос.');}if(!b||typeof b!=='object'||Array.isArray(b))fail('Неверный запрос.');
  if(agent&&p==='events')return reply(200,store.events(b));if(agent&&p==='heartbeat')return reply(200,store.heartbeat(b));if(internal&&p==='report')return reply(200,store.report(b,u));if(internal&&p==='reprint')return reply(200,store.reprint(b,u));return reply(404,{error:'Не найдено.'});
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Операция печати недоступна.'});}
};}
