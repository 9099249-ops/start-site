import {createHash} from 'node:crypto';

const counters=['cafe','task','booking'];
const query=`WITH newest AS (
 SELECT (SELECT coalesce(max(id),0) FROM cafe_orders) cafe,
        (SELECT coalesce(max(id),0) FROM station_tasks) task,
        (SELECT coalesce(max(id),0) FROM inquiries) booking
)
SELECT cafe,task,booking,
 (SELECT id FROM cafe_orders WHERE id>? AND id<=newest.cafe
  AND source IN ('customer_web','customer_nfc') ORDER BY id DESC LIMIT 1) cafeEvent,
 (SELECT id FROM station_tasks WHERE id>? AND id<=newest.task
  AND kind='task' ORDER BY id DESC LIMIT 1) taskEvent,
 (SELECT id FROM inquiries WHERE id>? AND id<=newest.booking ORDER BY id DESC LIMIT 1) bookingEvent
FROM newest`;

export function voiceEventsHandler(admin){
 let statement;
 return async(req,res,url)=>{
  if(url.pathname!=='/api/admin/voice-events')return false;
  const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:JSON.stringify(data));return true;};
  if(!['GET','HEAD'].includes(req.method))return reply(405,{error:'Оповещения доступны только для чтения.'});
  const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.slice(21);
  const user=admin?.user(token);
  if(!user)return reply(401,{error:'Войдите в админку.'});
  if(user.scheduleOnly||!['admin','staff','waiter'].includes(user.role))return reply(403,{error:'Нет доступа.'});
  const scope=createHash('sha256').update('voice-events\0'+token).digest('hex').slice(0,24);
  const hasCursor=['scope',...counters].some(key=>url.searchParams.has(key));
  const after={};
  if(hasCursor){
   if(!/^[a-f0-9]{24}$/.test(url.searchParams.get('scope')||''))return reply(400,{error:'Некорректный указатель оповещений.'});
   for(const key of counters){const value=url.searchParams.get(key);if(!/^\d{1,16}$/.test(value||'')||!Number.isSafeInteger(Number(value)))return reply(400,{error:'Некорректный указатель оповещений.'});after[key]=Number(value);}
  }
  try{
   // One SQLite statement fixes both the upper bounds and event selection to one snapshot.
   statement??=admin.db.prepare(query);
   const row=statement.get(...counters.map(key=>after[key]??0));
   const cursor={scope,...Object.fromEntries(counters.map(key=>[key,row[key]]))};
   const baseline=!hasCursor||url.searchParams.get('scope')!==scope||counters.some(key=>after[key]>row[key]);
   const events=[];
   if(!baseline)for(const [field,kind] of [['cafeEvent','cafe_order'],['taskEvent','task'],['bookingEvent','booking']])if(row[field]!=null)events.push({kind,id:row[field]});
   return reply(200,{cursor,baseline,events});
  }catch{return reply(503,{error:'Оповещения временно недоступны.'});}
 };
}
