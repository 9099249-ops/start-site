import {createHash} from 'node:crypto';
import cafeNumber from '../dist/cafe-number.js';
import {TableVersion} from './table-version.mjs';
const active=s=>!['DELIVERED','CANCELLED'].includes(s);
const names={NEW:'В работе',ACCEPTED:'В работе',COOKING:'В работе',READY:'Готов к выдаче',DELIVERED:'Выполнен',CANCELLED:'Отменён'};
export function cafeListRow(r,p,refundedCents=0){
 const d=r.details,needs=!d.guestBillId&&!d.manualPaymentRequired&&d.terminalPaymentRequired&&!d.terminalPaidAt&&active(r.status);
 const tone=r.status==='CANCELLED'||['review','payment_unknown','receipt_unknown'].includes(p?.state)?'red':p?.paid&&!['done','cash_done'].includes(p.state)?'yellow':d.terminalPaidAt||d.complimentary||['done','cash_done'].includes(p?.state)?'green':'yellow';
 const place=d.place?.name||(d.fulfillment==='lounge'&&d.location);
 const placeLabel=place?(['place','lounge'].includes(d.fulfillment)&&/^\d+$/.test(String(place).trim())?'Стол '+String(place).trim():place):d.fulfillment==='house'?'Домик: '+d.house:({pickup:'В кафе',lounge:'К столу / в лаунж',yacht:'На яхту / катер',place:'Стол / место'}[d.fulfillment]||'');
 const row={id:r.id,number:cafeNumber(r.id),status:r.status,revision:r.revision,created:r.created,totalCents:r.total_cents,refundedCents,free:!!d.complimentary,placeLabel,customerLabel:d.complimentary?d.complimentary.recipientName:d.name||'',itemsLabel:d.items.map(i=>i.quantity+'× '+i.name).join(', '),tone,
 paymentLabel:tone==='red'?(r.status==='CANCELLED'?'Отменён':'Нужна сверка'):tone==='green'?(d.complimentary?'Выдан бесплатно':'Оплачено'):p?.paid?'Оплачено · проверить чек':'Ожидает оплаты',
 statusLabel:r.status==='CANCELLED'?names.CANCELLED:['review','receipt_unknown','payment_unknown'].includes(p?.state)?p.label:d.terminalPaidAt?names[r.status]+' · Оплачен':p?.label||(d.terminalPaymentRequired?'Ожидает оплаты':names[r.status]),
 ready:['NEW','ACCEPTED','COOKING'].includes(r.status)&&!needs,action:active(r.status)?needs?(p?'check':'pay'):'complete':null};if(d.guestBillId){row.guestBillId=d.guestBillId;row.statusLabel='Счёт гостя №'+d.guestBillId+' · '+row.statusLabel;}return {...row,version:createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0,16)};
}
export class CafeList {
 constructor(store){this.store=store;this.db=store.db;this.cache=new Map();this.version=new TableVersion(this.db,'cafe_list',['cafe_orders','cafe_order_events','cafe_stock_usage','inventory_items','inventory_units','customer_refunds','aqsi_cafe','aqsi_cafe_orders','aqsi_pilot','aqsi_rental','aqsi_guest']);
  this.db.function('cafe_list_match',{deterministic:true},(id,name,phone,q)=>{q=String(q).toLocaleLowerCase('ru-RU');const digits=q.replace(/\D/g,'');return Number(String(id)===q||cafeNumber(id)===q||String(name||'').toLocaleLowerCase('ru-RU').includes(q)||digits.length>=4&&String(phone||'').includes(digits));});
 }
 read(params){
  const date=params.get('date')||this.store.admin.workforce.accountingDay(),status=params.get('status')??'active',source=params.get('source')||'',place=params.get('place')||'',q=(params.get('q')||'').trim().slice(0,100),limit=Math.min(500,Math.max(50,Number(params.get('limit'))||50));
  const start=Date.parse(date+'T00:00:00+03:00');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(start)||new Date(start+10800000).toISOString().slice(0,10)!==date)throw Object.assign(Error('Проверьте дату.'),{status:400});
  const key=JSON.stringify([date,this.store.admin.workforce.auto.from,status,source,place,q,limit]),stamp=this.version.read(),revision=createHash('sha256').update(stamp+key).digest('hex').slice(0,24);
  if(params.get('since')===revision)return {unchanged:true,revision};
  const cached=this.cache.get(key);if(cached?.revision===revision)return cached;
  const db=this.db,store=this.store,[from,end]=store.admin.workforce.accountingBounds(date),args=[],where=["(json_extract(details,'$.guestBillId') IS NULL OR status IN ('DELIVERED','CANCELLED'))"];
  if(status==='active')where.push("status NOT IN ('DELIVERED','CANCELLED')");else{where.push('(created>=? AND created<?)');args.push(from,end);if(status){where.push('status=?');args.push(status);}}
  if(source){where.push('source=?');args.push(source);}if(place){where.push('place_id=?');args.push(place);}if(q){where.push("cafe_list_match(id,json_extract(details,'$.name'),json_extract(details,'$.phone'),?)=1");args.push(q);}
  const clause=where.join(' AND ');
  db.exec('SAVEPOINT cafe_list_snapshot');let result;
  try{
   const total=db.prepare('SELECT count(*) n FROM cafe_orders WHERE '+clause).get(...args).n;
   const rows=db.prepare('SELECT id,status,revision,created,total_cents,details FROM cafe_orders WHERE '+clause+' ORDER BY created DESC,id DESC LIMIT ?').all(...args,Math.floor(limit)).map(r=>({...r,details:JSON.parse(r.details)}));
   const payments=store.terminal?.payments?.(rows),refunds=new Map(rows.length?db.prepare(`SELECT source_id,sum(amount_cents) n FROM customer_refunds WHERE kind='cafe' AND source_id IN (${rows.map(()=>'?').join(',')}) GROUP BY source_id`).all(...rows.map(r=>r.id)).map(r=>[r.source_id,r.n]):[]);
   const totals=db.prepare("SELECT count(*) dayCount,coalesce(sum(CASE WHEN status<>'CANCELLED' OR json_extract(details,'$.terminalPaidAt') IS NOT NULL THEN total_cents ELSE 0 END),0) totalCents,coalesce(sum(CASE WHEN status<>'CANCELLED' THEN coalesce(json_extract(details,'$.complimentary.menuValueCents'),0) ELSE 0 END),0) complimentaryCents FROM cafe_orders WHERE created>=? AND created<?").get(from,end);
   result={revision,...totals,paidRevenueCents:store.admin.workforce.revenue(date,Date.now()).cafe_cents,stockCancellations:store.stock.cancellationReport(from,end),refundsCents:store.admin.refunds.total(date,Date.now(),'cafe'),activeCount:db.prepare("SELECT count(*) n FROM cafe_orders WHERE status NOT IN ('DELIVERED','CANCELLED')").get().n,total,rows:rows.map(r=>cafeListRow(r,payments?payments.get(r.id):store.terminal?.payment(r.id),refunds.get(r.id)||0)),terminalIssues:store.terminal?.terminalIssues()||[]};
  }finally{db.exec('RELEASE cafe_list_snapshot');}
  if(this.cache.size>=16)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,result);return result;
 }
}
