const fail=(message,status=400,extra={})=>{throw Object.assign(Error(message),{status,...extra});};
const money=n=>{if(!Number.isSafeInteger(n)||n<0||n>100000000)fail('Укажите сумму от 0 до 1 000 000 ₽.');return n;};
const staff=u=>{if(!['admin','staff','waiter'].includes(u?.role))fail('Нет доступа.',403);};
const owner=u=>{if(u?.role!=='admin')fail('Доступно только администратору.',403);};
const day=now=>new Date(now+10800000).toISOString().slice(0,10);
export class SimpleShift {
 constructor(work){this.work=work;this.db=work.db;this.admin=work.admin;
  this.db.exec('CREATE TABLE IF NOT EXISTS cash_desk_actions(request_id TEXT PRIMARY KEY,actor INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,result TEXT NOT NULL)');
  for(const [name,type] of [['declared_revenue_cents','INTEGER'],['close_request_id','TEXT']])if(!this.db.prepare('PRAGMA table_info(shifts)').all().some(c=>c.name===name))this.db.exec('ALTER TABLE shifts ADD COLUMN '+name+' '+type);
 }
 get enabled(){return this.work.env.START_SIMPLE_SHIFT==='1';}
 state(now=Date.now()){const shift=this.admin.currentShift(this.work.accountingDay(now));return {enabled:this.enabled,day:this.work.accountingDay(now),autoClose:!!this.work.auto.from,canStart:new Date(now+10800000).getUTCHours()>=8,needsOpening:!shift,shiftId:shift?.id||null,closed:!!shift?.closed_at};}
 // Called inside the same transaction as the attendance mark.
 ensureOpening(b,u,now){if(!this.enabled)return;const state=this.state(now);if(!state.canStart)fail('Начать новую смену можно с 08:00 по Москве.',409);
  if(!state.needsOpening)return;
  if(b.cashStartCents===undefined)fail('Первый сотрудник указывает наличные в кассе на начало дня.',409,{needsCashStart:true});
  money(b.cashStartCents);const settings=this.work.daySettings(state.day,now,true);
  const id=Number(this.db.prepare('INSERT INTO shifts(day,opened_at,opened_by,cash_start_cents,salary_settings_json) VALUES(?,?,?,?,?)').run(state.day,now,u.id,b.cashStartCents,JSON.stringify(settings)).lastInsertRowid);
  this.work.audit(u,'cash_shift_open',id,null,this.admin.currentShift(state.day),'Начальный остаток при первом приходе',now);
 }
 summary(u,now=Date.now(),requestedDay){const date=requestedDay||this.work.accountingDay(now);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('Проверьте дату.');const shift=this.admin.currentShift(date),calc=this.work.calculate(date,now);return {day:date,shift,registeredCents:calc.revenue.cents,employees:calc.employees,afterClose:calc.after_close||null,automaticClose:shift?this.db.prepare('SELECT * FROM automatic_shift_closures WHERE shift_id=?').get(shift.id)||null:null,withdrawals:shift?this.admin.shiftMovements(shift.id):[],canEdit:u.role==='admin'};}
 correctOpening(b,u,now=Date.now()){owner(u);money(b.cashStartCents);return this.work.tx(()=>{const s=this.db.prepare('SELECT * FROM shifts WHERE id=?').get(b.shiftId);if(!s||s.closed_at||s.cash_start_cents!==b.expectedCashStartCents)fail('Остаток изменился или итог уже сохранён. Обновите данные.',409);this.db.prepare('UPDATE shifts SET cash_start_cents=? WHERE id=?').run(b.cashStartCents,s.id);this.work.audit(u,'opening_balance_correct',s.id,{cashStartCents:s.cash_start_cents},{cashStartCents:b.cashStartCents},'Исправление начального остатка',now);return {ok:true};});}
 withdrawalContext(u,now=Date.now()){staff(u);const shift=this.db.prepare('SELECT * FROM shifts WHERE day<=? ORDER BY day DESC,id DESC LIMIT 1').get(day(now));return {shift:shift?{id:shift.id,day:shift.day,closed_at:shift.closed_at}:null};}
 withdrawal(b,u,now=Date.now()){staff(u);if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))fail('Обновите форму.');const body=JSON.stringify({shiftId:b.shiftId,amountCents:b.amountCents,comment:b.comment||''});return this.work.tx(()=>{const old=this.db.prepare('SELECT * FROM cash_desk_actions WHERE request_id=?').get(b.requestId);if(old){if(old.actor!==u.id||old.kind!=='withdrawal'||old.body!==body)fail('Запрос уже использован.',409);return JSON.parse(old.result);}const target=this.withdrawalContext(u,now).shift;if(!target)fail('Рабочий день ещё ни разу не открывали. Сначала нажмите «Я на смене».',409);if(target.id!==b.shiftId)fail('Рабочий день изменился. Закройте форму изъятия и откройте её снова.',409);const result=this.admin.addWithdrawal(b,u,now,{allowClosed:true});this.db.prepare('INSERT INTO cash_desk_actions VALUES(?,?,?,?,?)').run(b.requestId,u.id,'withdrawal',body,JSON.stringify(result));return result;});}
}
