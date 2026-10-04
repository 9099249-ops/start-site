const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const owner=u=>{if(u?.role!=='admin')fail('Только администратор.',403);};
export class PayrollLedger {
 constructor(work){
  this.work=work;this.db=work.db;
  for(const [name,type] of [['method',"TEXT NOT NULL DEFAULT 'external'"],['request_id','TEXT']])if(!this.db.prepare('PRAGMA table_info(payroll_payments)').all().some(c=>c.name===name))this.db.exec('ALTER TABLE payroll_payments ADD COLUMN '+name+' '+type);
  this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS payroll_payment_request ON payroll_payments(request_id) WHERE request_id IS NOT NULL;
   CREATE TABLE IF NOT EXISTS payroll_payment_reviews(shift_id INTEGER NOT NULL REFERENCES shifts(id),user_id INTEGER NOT NULL REFERENCES admin_users(id),reported_at INTEGER NOT NULL,actor INTEGER NOT NULL REFERENCES admin_users(id),resolved_at INTEGER,PRIMARY KEY(shift_id,user_id));`);
 }
 origins(shiftId,userId,amount){
  const shift=this.db.prepare('SELECT day FROM shifts WHERE id=?').get(shiftId),parts=[];
  for(const row of this.db.prepare('SELECT snapshot_json FROM late_work_settlements WHERE settled_shift_id=?').all(shiftId)){
   const source=JSON.parse(row.snapshot_json),e=source.employees.find(e=>e.user_id===userId);
   if(e?.salary_cents)parts.push({day:source.day,cents:e.salary_cents});
  }
  const current=amount-parts.reduce((n,p)=>n+p.cents,0);if(current||!parts.length)parts.push({day:shift.day,cents:current});
  return parts.sort((a,b)=>a.day.localeCompare(b.day));
 }
 employee(shiftId,e,now=Date.now()){
  const paid=this.db.prepare('SELECT coalesce(sum(amount_cents),0) cents FROM payroll_payments WHERE shift_id=? AND user_id=? AND paid_at<=?').get(shiftId,e.user_id,now).cents;
  const adjustment=this.work.admin.refunds.closedAdjustment(shiftId,e.user_id,now),review=this.db.prepare('SELECT reported_at FROM payroll_payment_reviews WHERE shift_id=? AND user_id=? AND reported_at<=? AND (resolved_at IS NULL OR resolved_at>?)').get(shiftId,e.user_id,now,now);
  const remaining=Math.max(0,e.salary_cents-paid-adjustment);
  return {...e,shift_id:shiftId,paid,refund_adjustment_cents:adjustment,overpaid_cents:Math.max(0,paid-e.salary_cents+adjustment),remaining_cents:review?0:remaining,review_required:!!review,review_amount_cents:review?remaining:0,origins:this.origins(shiftId,e.user_id,e.salary_cents)};
 }
 list(u,now=Date.now()){
  owner(u);
  return this.db.prepare("SELECT e.*,u.login,s.day FROM shift_employees e JOIN admin_users u ON u.id=e.user_id JOIN shifts s ON s.id=e.shift_id WHERE s.closed_at IS NOT NULL AND u.login<>'admin' ORDER BY s.day DESC,u.login").all().map(e=>this.employee(e.shift_id,e,now));
 }
 reportPaid(b,u,now=Date.now()){
  owner(u);if(!Number.isSafeInteger(b.shiftId)||!Number.isSafeInteger(b.userId))fail('Выберите начисление.');
  return this.work.tx(()=>{
   const row=this.list(u,now).find(e=>e.shift_id===b.shiftId&&e.user_id===b.userId);if(!row)fail('Начисление не найдено.',404);
   if(row.review_required||!row.remaining_cents)return this.list(u,now);
   this.db.prepare('INSERT INTO payroll_payment_reviews VALUES(?,?,?,?,NULL) ON CONFLICT(shift_id,user_id) DO UPDATE SET reported_at=excluded.reported_at,actor=excluded.actor,resolved_at=NULL').run(b.shiftId,b.userId,now,u.id);
   this.work.audit(u,'payroll_reported_paid',b.shiftId,{userId:b.userId,remainingCents:row.remaining_cents},{userId:b.userId,reviewRequired:true},'Владелец подтвердил выплату; сумма и способ требуют сверки. Движение денег не создавалось.',now);
   return this.list(u,now);
  });
 }
 pay(b,u,now=Date.now()){
  owner(u);for(const k of ['shiftId','userId','amountCents'])if(!Number.isSafeInteger(b[k])||b[k]<=0)fail('Проверьте сумму и начисление.');
  const method=b.method??'external';if(!['cash','card','external'].includes(method))fail('Выберите способ выплаты.');
  if(b.requestId!==undefined&&!/^[a-f0-9-]{36}$/.test(b.requestId))fail('Обновите форму выплаты.');
  return this.work.tx(()=>{
   const old=b.requestId?this.db.prepare('SELECT * FROM payroll_payments WHERE request_id=?').get(b.requestId):null;
   if(old){if(old.shift_id!==b.shiftId||old.user_id!==b.userId||old.amount_cents!==b.amountCents||old.method!==method||old.paid_by!==u.id)fail('Запрос выплаты уже использован.',409);return this.list(u,now);}
   const shift=this.db.prepare('SELECT * FROM shifts WHERE id=?').get(b.shiftId);if(!shift?.closed_at)fail('Выплата доступна после сохранения итога дня.',409);
   const row=this.list(u,now).find(e=>e.shift_id===b.shiftId&&e.user_id===b.userId);if(!row)fail('Начисление не найдено.',404);
   if(row.review_required&&b.resolveReview!==true)fail('Сначала уточните ранее выполненную выплату.',409);
   const due=row.review_required?row.review_amount_cents:row.remaining_cents;
   if(b.amountCents>due)fail('Сумма выплаты больше остатка начисления.',409);
   if(method==='cash'&&row.review_required)fail('Для старой выплаты сначала отдельно сверьте кассу. Не списывайте её из сегодняшних наличных.',409);
   if(method==='cash'&&!this.work.admin.cashLedger.summary(u,now).shift)fail('Сначала откройте кассу для выплаты наличными.',409);
   this.db.prepare('INSERT INTO payroll_payments(shift_id,user_id,amount_cents,paid_at,paid_by,method,request_id) VALUES(?,?,?,?,?,?,?)').run(b.shiftId,b.userId,b.amountCents,now,u.id,method,b.requestId||null);
   if(row.review_required)this.db.prepare('UPDATE payroll_payment_reviews SET resolved_at=? WHERE shift_id=? AND user_id=?').run(now,b.shiftId,b.userId);
   this.work.audit(u,'payroll_payment',b.shiftId,{paid:row.paid},{paid:row.paid+b.amountCents,userId:b.userId,method},row.review_required?'Уточнение ранее выполненной выплаты':'Отметка выплаты',now);
   return this.list(u,now);
  });
 }
}
