import {createHash} from 'node:crypto';
import {saleBonuses} from './sale-bonus.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const staff=u=>{if(!['admin','staff','waiter'].includes(u?.role))fail('Войдите в админку.',401);};
const day=t=>new Date(t+10800000).toISOString().slice(0,10);
const int=(n,min=0)=>{if(!Number.isSafeInteger(n)||n<min||n>100000000)fail('Проверьте сумму и количество.');return n;};
const stable=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);

export class RefundStore{
 constructor(admin){this.admin=admin;this.db=admin.db;this.db.exec(`
 CREATE TABLE IF NOT EXISTS customer_refunds(id INTEGER PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('rental','cafe')),source_id INTEGER NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),lines_json TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,created_by INTEGER NOT NULL REFERENCES admin_users(id));
 CREATE INDEX IF NOT EXISTS customer_refunds_source ON customer_refunds(kind,source_id);
 CREATE INDEX IF NOT EXISTS customer_refunds_date ON customer_refunds(created_at);
 CREATE TABLE IF NOT EXISTS refund_allocations(refund_id INTEGER NOT NULL REFERENCES customer_refunds(id),sale_key TEXT NOT NULL,original_day TEXT NOT NULL,original_at INTEGER NOT NULL,amount_cents INTEGER NOT NULL,PRIMARY KEY(refund_id,sale_key));
 CREATE TABLE IF NOT EXISTS refund_bonus_adjustments(refund_id INTEGER NOT NULL REFERENCES customer_refunds(id),sale_key TEXT NOT NULL,user_id INTEGER NOT NULL REFERENCES admin_users(id),original_day TEXT NOT NULL,original_at INTEGER NOT NULL,amount_cents INTEGER NOT NULL,closed_shift_id INTEGER REFERENCES shifts(id),PRIMARY KEY(refund_id,sale_key,user_id));
 `);}
 total(dayValue,now=Date.now(),kind=null,after=0){const [start,end]=this.admin.workforce.accountingBounds(dayValue);return this.db.prepare('SELECT coalesce(sum(amount_cents),0) n FROM customer_refunds WHERE created_at>=? AND created_at<=? AND (? IS NULL OR kind=?)').get(Math.max(start,after?after+1:start),Math.min(now,end-1),kind,kind).n;}
 closedAdjustment(shiftId,userId,now=Date.now()){return this.db.prepare('SELECT coalesce(sum(a.amount_cents),0) n FROM refund_bonus_adjustments a JOIN customer_refunds r ON r.id=a.refund_id WHERE a.closed_shift_id=? AND a.user_id=? AND r.created_at<=?').get(shiftId,userId,now).n;}
 openAdjustments(dayValue,now,after=0){return this.db.prepare('SELECT a.user_id,sum(a.amount_cents) cents FROM refund_bonus_adjustments a JOIN customer_refunds r ON r.id=a.refund_id WHERE a.original_day=? AND a.closed_shift_id IS NULL AND a.original_at>? AND r.created_at<=? GROUP BY a.user_id').all(dayValue,after,now);}
 history(kind,id){return this.db.prepare('SELECT r.id,r.amount_cents,r.lines_json,r.reason,r.created_at,u.login actor FROM customer_refunds r JOIN admin_users u ON u.id=r.created_by WHERE r.kind=? AND r.source_id=? ORDER BY r.id DESC').all(kind,id).map(r=>({...r,lines:JSON.parse(r.lines_json),lines_json:undefined}));}
 info(kind,id,u){staff(u);int(id,1);if(!['rental','cafe'].includes(kind))fail('Неверный вид заказа.');const history=this.history(kind,id),refundedCents=history.reduce((n,r)=>n+r.amount_cents,0);let paidCents=0,lines=[];
  if(kind==='rental'){if(!this.db.prepare('SELECT id FROM rentals WHERE id=?').get(id))fail('Аренда не найдена.',404);paidCents=this.db.prepare('SELECT coalesce(sum(amount),0) n FROM payments WHERE rental_id=?').get(id).n;}
  else{const row=this.db.prepare('SELECT * FROM cafe_orders WHERE id=?').get(id);if(!row)fail('Заказ не найден.',404);const d=JSON.parse(row.details);paidCents=(d.terminalPaidAt||row.status==='DELIVERED'&&!d.terminalPaymentRequired)&&!d.complimentary?row.total_cents:0;
   lines=(d.items||[]).map((i,index)=>{const returned=history.flatMap(r=>r.lines).filter(l=>l.index===index).reduce((n,l)=>n+l.quantity,0);return {index,name:i.name+(i.variant?' · '+i.variant.name:''),quantity:i.quantity,remainingQuantity:i.quantity-returned,unitCents:i.unitCents};});
   if(d.deliveryCents>0)lines.push({index:-1,name:'Доставка',quantity:1,remainingQuantity:history.some(r=>r.lines.some(l=>l.index===-1))?0:1,unitCents:d.deliveryCents});
  }
  return {kind,id,paidCents,refundedCents,remainingCents:Math.max(0,paidCents-refundedCents),lines,history};
 }
 allocate(refundId,sale,amount,now){
  const before=this.db.prepare('SELECT coalesce(sum(amount_cents),0) n FROM refund_allocations WHERE sale_key=?').get(sale.id).n;
  this.db.prepare('INSERT INTO refund_allocations VALUES(?,?,?,?,?)').run(refundId,sale.id,this.admin.workforce.accountingDay(sale.at),sale.at,amount);
  const w=this.admin.workforce,shift=this.admin.currentShift(this.admin.workforce.accountingDay(sale.at)),closed=shift?.closed_at?(sale.at<=shift.closed_at?shift:this.db.prepare('SELECT s.* FROM late_work_settlements l JOIN shifts s ON s.id=l.settled_shift_id WHERE l.source_shift_id=?').get(shift.id)):null;
  const settings=shift?.salary_settings_json?JSON.parse(shift.salary_settings_json):w.daySettings(this.admin.workforce.accountingDay(sale.at));
  let employees;
  if(closed){employees=this.db.prepare('SELECT * FROM shift_employees WHERE shift_id=?').all(closed.id).map(e=>e.calculation_json?JSON.parse(e.calculation_json).employee:{...e,sessions:[]});}
  else{const sessions=this.db.prepare('SELECT * FROM employee_work_sessions WHERE started_at<=? AND (ended_at IS NULL OR ended_at>?)').all(sale.at,sale.at),map=new Map();for(const saved of sessions){const s=w.auto.capped(saved,now);if(s.ended_at!==null&&s.ended_at<=sale.at)continue;if(!map.has(s.user_id))map.set(s.user_id,{user_id:s.user_id,worked_ms:0,sessions:[]});map.get(s.user_id).sessions.push(s);}employees=[...map.values()];}
  const events=w.sales(this.admin.workforce.accountingDay(sale.at),Math.max(sale.at,now)).sort((a,b)=>a.at-b.at||String(a.id).localeCompare(String(b.id))),index=events.findIndex(e=>e.id===sale.id);
  if(index<0)return;
  const previous=saleBonuses(events.slice(0,index),employees,settings.bonus_percent).rows,current=saleBonuses(events.slice(0,index+1),employees,settings.bonus_percent).rows;
  for(const e of current){const grant=e.bonus_cents-(previous.find(p=>p.user_id===e.user_id)?.bonus_cents||0);if(grant<=0)continue;const cents=Number(BigInt(grant)*BigInt(before+amount)/BigInt(sale.cents)-BigInt(grant)*BigInt(before)/BigInt(sale.cents));if(cents)this.db.prepare('INSERT INTO refund_bonus_adjustments VALUES(?,?,?,?,?,?,?)').run(refundId,sale.id,e.user_id,this.admin.workforce.accountingDay(sale.at),sale.at,cents,closed?.id||null);}
 }
 create(b,u,now=Date.now()){staff(u);if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))fail('Обновите форму возврата.');if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>300)fail('Укажите причину возврата.');const fingerprint=createHash('sha256').update(stable(b)).digest('hex');
  return this.admin.workforce.tx(()=>{const old=this.db.prepare('SELECT * FROM customer_refunds WHERE request_id=?').get(b.requestId);if(old){if(old.fingerprint!==fingerprint)fail('Запрос уже использован для другого возврата.',409);return {...this.info(b.kind,b.id,u),refundId:old.id,duplicate:true};}
   const info=this.info(b.kind,b.id,u);let lines=[],amount=int(b.amountCents,1);if(!info.remainingCents)fail('Нет оплаченной суммы для возврата.',409);
   if(b.kind==='cafe'){if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>101)fail('Выберите блюда для возврата.');const seen=new Set();for(const l of b.lines){if(seen.has(l.index))fail('Блюдо указано дважды.');seen.add(l.index);const original=info.lines.find(x=>x.index===l.index);int(l.quantity,1);if(!original||l.quantity>original.remainingQuantity)fail('Это количество уже возвращено. Обновите заказ.',409);lines.push({index:l.index,quantity:l.quantity,name:original.name,unitCents:original.unitCents});}if(lines.reduce((n,l)=>n+l.quantity*l.unitCents,0)!==amount)fail('Сумма изменилась. Проверьте выбранные блюда.',409);}
   if(amount>info.remainingCents)fail('Возврат превышает оставшуюся оплату.',409);
   const id=Number(this.db.prepare('INSERT INTO customer_refunds(request_id,fingerprint,kind,source_id,amount_cents,lines_json,reason,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)').run(b.requestId,fingerprint,b.kind,b.id,amount,JSON.stringify(lines),b.reason.trim(),now,u.id).lastInsertRowid);
   const sales=b.kind==='rental'?this.db.prepare('SELECT id,amount cents,created at FROM payments WHERE rental_id=? ORDER BY created,id').all(b.id).map(r=>({...r,id:'rental-'+r.id})):[this.db.prepare("SELECT 'cafe-'||o.id id,o.total_cents cents,coalesce(json_extract(o.details,'$.terminalPaidAt'),(SELECT min(created) FROM cafe_order_events WHERE order_id=o.id AND kind='DELIVERED'),o.updated) at FROM cafe_orders o WHERE id=?").get(b.id)];
   let remaining=amount;for(const sale of sales){const refunded=this.db.prepare('SELECT coalesce(sum(amount_cents),0) n FROM refund_allocations WHERE sale_key=?').get(sale.id).n,take=Math.min(remaining,sale.cents-refunded);if(take>0){this.allocate(id,sale,take,now);remaining-=take;}if(!remaining)break;}if(remaining)fail('Не удалось сопоставить оплату. Нужна сверка.',409);
   this.admin.workforce.audit(u,'customer_refund',id,{kind:b.kind,sourceId:b.id,refundedCents:info.refundedCents},{amountCents:amount,lines},b.reason.trim(),now);
   return {...this.info(b.kind,b.id,u),refundId:id};
  });
 }
}
