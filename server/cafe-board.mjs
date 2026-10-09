import cafeNumber from '../dist/cafe-number.js';
import boardText from '../dist/cafe-board-text.js';
import {readFile} from 'node:fs/promises';
const locationFor=d=>{if(d.fulfillment==='pickup')return 'Самовывоз';if(d.fulfillment==='yacht')return 'На яхту';if(d.fulfillment==='house')return 'Домик';if(['place','lounge'].includes(d.fulfillment)){const name=d.place?.name||d.location||'';return /^(?:(?:стол|место)\s*[\dа-яa-z -]{1,20}|\d{1,3}\s*стол)$/i.test(name)?name:'Лаунж-зона';}return 'В кафе';};
export class CafeBoard {
 constructor(cafe,env=process.env){this.cafe=cafe;this.env=env;}
 snapshot(now=Date.now()){
  const rows=this.cafe.db.prepare("SELECT o.id,o.status,o.source,o.details,o.created,(SELECT min(e.created) FROM cafe_order_events e WHERE e.order_id=o.id AND e.kind IN ('NEW','ACCEPTED','COOKING')) started FROM cafe_orders o WHERE o.status IN ('NEW','ACCEPTED','COOKING','READY') ORDER BY coalesce(started,o.created),o.id").all();
  const orders=[];for(const r of rows){const d=JSON.parse(r.details),website=['customer_web','customer_nfc'].includes(r.source);if(d.pendingKitchen===true||!website&&d.terminalPaymentRequired&&!d.terminalPaidAt&&!d.guestDeferred&&!d.complimentary)continue;orders.push({id:r.id,displayNumber:cafeNumber(r.id),status:r.status==='READY'?'ready':'cooking',waitingSince:r.started??r.created,waitingBasis:r.started==null?'created':'work',source:website?'Сайт':'POS',location:locationFor(d),items:(d.items||[]).map(i=>({quantity:i.quantity,name:i.name,variant:i.variant?.name||'',modifiers:(i.modifiers||[]).map(m=>m.name),comment:i.comment||''})),comment:d.comment||''});}
  const onWaterCount=this.cafe.db.prepare("SELECT coalesce(sum(quantity),0) n FROM rentals WHERE returned IS NULL AND initial_due=0 AND departure_pending=0 AND equipment<>'manual'").get().n;
  const staffNames=this.cafe.db.prepare("SELECT p.display_name name FROM employee_profiles p WHERE NOT EXISTS(SELECT 1 FROM admin_users au WHERE au.id=p.user_id AND au.login='admin') AND trim(p.display_name)<>'' AND EXISTS(SELECT 1 FROM employee_work_sessions w WHERE w.user_id=p.user_id AND w.ended_at IS NULL AND w.started_at<=?) AND NOT EXISTS(SELECT 1 FROM archived_accounts a WHERE a.user_id=p.user_id) ORDER BY p.user_id").all(now).map(p=>p.name.trim());
  const settings=this.cafe.catalog().settings;
  return {staffNames,onWaterCount,serverTime:now,warningMinutes:settings.prepMinutes||0,boardText:boardText.resolve(settings.boardText),partSeconds:Math.max(8,Math.min(30,Number(this.env.CAFE_BOARD_PART_SECONDS)||10)),orders};
 }
}
export function cafeBoardHandler(board){return async(req,res,url)=>{
 const launch=url.pathname==='/admin/cafe/board',page=['/cafe/board','/cafe/board/'].includes(url.pathname),api=url.pathname==='/api/cafe/board';if(!page&&!api&&!launch)return false;
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
 const reply=(code,body)=>{res.writeHead(code,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(req.method==='HEAD'?undefined:JSON.stringify(body));return true;};
 if(!['GET','HEAD'].includes(req.method))return reply(405,{error:'Табло доступно только для просмотра.'});
 if(launch){res.writeHead(302,{...headers,Location:'/cafe/board'});res.end();return true;}
 if(page){const html=await readFile(new URL('../dist/cafe-board.html',import.meta.url));res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(req.method==='HEAD'?undefined:html);return true;}
 if(!board?.cafe)return reply(503,{error:'Сервер заказов недоступен.'});return reply(200,board.snapshot());
};}
