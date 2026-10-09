const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const localDate=n=>new Date(n+10800000).toISOString().slice(0,10);
export function localStamp(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))fail('Укажите дату и время.');const n=Date.parse(value+':00+03:00');if(!Number.isFinite(n)||new Date(n+10800000).toISOString().slice(0,16)!==value)fail('Неверная дата.');return n;}
export function bookingWindow(b,close='22:00'){
 if(b.plan==='season')return null;
 const start=localStamp(b.date+'T'+b.time);
 const end=b.plan==='hour'?start+Number(b.duration)*3600000:localStamp((b.plan==='takeaway'?b.returnDate:b.date)+'T'+close);
 if(!Number.isFinite(end)||end<=start)fail('Окончание должно быть позже начала.');
 return {start,end,quantity:b.equipment==='big'?1:b.quantity,equipment:b.equipment};
}
export function availability(db,fleet,equipment,start,end,{ignoreInquiry=0,ignoreRental=0,now=Date.now(),close='22:00'}={}){
 const item=fleet.find(i=>i[0]===equipment);if(!item||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)fail('Проверьте технику и интервал.');
 const occupied=[];
 for(const r of db.prepare("SELECT id,details FROM inquiries WHERE status='confirmed' AND id<>?").all(ignoreInquiry)){
  const b=JSON.parse(r.details);if(b.equipment!==equipment)continue;const w=bookingWindow(b,close);if(w)occupied.push({...w,source:'booking',id:r.id});
 }
 for(const r of db.prepare('SELECT id,quantity,departed,departed_at,departure_pending,expected_return FROM rentals WHERE equipment=? AND returned IS NULL AND id<>?').all(equipment,ignoreRental)){
  const a=r.departed_at??localStamp(r.departed),planned=r.expected_return||a+3600000;
  // An overdue craft is physically absent; no future return can be assumed.
  occupied.push({start:a,end:r.departure_pending||planned<=now?Infinity:planned,quantity:r.quantity,source:'rental',id:r.id});
 }
 const overlapping=occupied.filter(w=>w.start<end&&w.end>start),points=[];
 for(const w of overlapping){points.push([Math.max(start,w.start),w.quantity],[Math.min(end,w.end),-w.quantity]);}
 points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let used=0,peak=0;for(const [,delta] of points){used+=delta;peak=Math.max(peak,used);}
 return {equipment,total:item[2],available:Math.max(0,item[2]-peak),occupied:peak,conflicts:overlapping.map(({source,id})=>({source,id}))};
}
export function assertCapacity(db,fleet,w,options={}){if(!w)return;const a=availability(db,fleet,w.equipment,w.start,w.end,options);if(w.quantity>a.available)fail(`Недостаточно техники на это время: свободно ${a.available}, требуется ${w.quantity}. Перенесите бронь или дождитесь возврата.`,409);}
export function calendarData(store,fleet,date,days=1,now=Date.now()){
 if(![1,7].includes(days))fail('Выберите день или неделю.');const start=localStamp(date+'T00:00'),end=start+days*86400000;
 const settings=store.sms?.settings(),close=store.sms?.content?.live().close||'22:00',lateMinutes=settings?.BOOKING_LATE_CANCEL_MINUTES||15;
 const rows=[];
 for(const r of store.db.prepare('SELECT i.*,r.returned,r.departed,r.departed_at,r.departure_pending,r.expected_return,r.initial_due FROM inquiries i LEFT JOIN rentals r ON r.id=i.rental_id ORDER BY i.id').all()){
  const b=JSON.parse(r.details);let w=bookingWindow(b,close);if(w&&r.departed)w={...w,start:r.departed_at??localStamp(r.departed),end:r.returned||(r.departure_pending?Math.max(end,now+1):Math.max(r.expected_return||0,now+1))};if(!w||w.start>=end||w.end<=start)continue;
  rows.push({...r,details:b,start:w.start,end:w.end,units:w.quantity,late:r.status==='confirmed'&&now>w.start+lateMinutes*60000,state:r.returned?(r.departure_pending?'cancelled':'completed'):r.initial_due>0?'payment_pending':r.departure_pending?'departure_pending':r.status,availability:r.status==='new'?availability(store.db,fleet,b.equipment,w.start,w.end,{now,close}):null});
 }
 const rentals=store.db.prepare('SELECT id,equipment,quantity,name,phone,departed,departed_at,departure_pending,expected_return,returned,initial_due FROM rentals WHERE id NOT IN (SELECT rental_id FROM inquiries WHERE rental_id IS NOT NULL)').all().filter(r=>(r.departed_at??localStamp(r.departed))<end&&(r.returned||(r.departure_pending?end:Math.max(r.expected_return||0,end)))>start);
 return {date,days,now,close,lateMinutes,rows,rentals,fleet:fleet.map(([id,label,total])=>({id,label,total})),overdue:store.db.prepare('SELECT id,equipment,quantity,expected_return FROM rentals WHERE returned IS NULL AND initial_due=0 AND departure_pending=0 AND expected_return<=?').all(now)};
}
