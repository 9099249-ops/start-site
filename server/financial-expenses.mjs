import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

const DAY=86400000,MSK=10800000;
const categories=new Set(['rent','electricity','water','tax','subscription','repair','other','bank_fee','stock','equipment','owner','depreciation']);
const cashOnly=new Set(['stock','equipment','owner']);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const owner=u=>{if(u?.role!=='admin'||u.scheduleOnly)fail('Расходы доступны только администратору.',403);};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const stable=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
const money=(v)=>v===null||Number.isSafeInteger(v)&&v>=0&&v<=10000000000;
const day=t=>new Date(t+MSK).toISOString().slice(0,10);
export function expenseDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail('Проверьте даты расхода.');
 const at=Date.parse(value+'T00:00:00+03:00');
 if(!Number.isFinite(at)||day(at)!==value||value<'2000-01-01'||value>'2100-12-31')fail('Проверьте даты расхода.');
 return at;
}
export function expenseAllocation(amount,from,to,start,end){
 if(amount===null)return null;
 const first=expenseDate(from),last=expenseDate(to)+DAY;
 const left=Math.max(first,start),right=Math.min(last,end);
 if(right<=left)return 0;
 // Cumulative integer allocation keeps every kopeck across disjoint date ranges.
 return Number(BigInt(amount)*BigInt(right-first)/BigInt(last-first)-BigInt(amount)*BigInt(left-first)/BigInt(last-first));
}

export class FinancialExpenses{
 constructor(admin,costs){this.admin=admin;this.db=admin.db;this.costs=costs;this.db.exec(readFileSync(new URL('./migrations/financial-expenses.sql',import.meta.url),'utf8'));}
 revision(){return this.db.prepare('SELECT coalesce(max(id),0) n FROM financial_expense_versions').get().n;}
 entries(){return this.db.prepare('SELECT expense_id,body FROM financial_expense_versions WHERE id IN (SELECT max(id) FROM financial_expense_versions GROUP BY expense_id) ORDER BY id DESC').all().map(row=>({...JSON.parse(row.body),id:row.expense_id}));}
 withdrawals(now){return this.db.prepare('SELECT id,amount_cents,created_at FROM cash_movements WHERE created_at<=? AND voided_at IS NULL ORDER BY created_at DESC,id DESC').all(now).map(row=>({id:row.id,amountCents:row.amount_cents,day:day(row.created_at)}));}
 catalog(p,u,now=Date.now()){
  owner(u);const result=this.report(p,now);
  return {...result,revision:this.revision(),costRevision:this.costs.revision(),canEdit:true,withdrawals:this.withdrawals(now)};
 }
 report(p,now=Date.now()){
  const entries=this.entries(),withdrawals=new Map(this.withdrawals(now).map(row=>[row.id,row]));
  const end=Math.min(p.end,expenseDate(day(now))+DAY),rows=[],departments={cafe:0,rental:0,shared:0};
  let knownOverheadCents=0,unknownCount=0,expensePaymentsCents=0,unknownPayments=0;
  const linkedWithdrawals=new Set();
  for(const entry of entries){
   if(!entry.active)continue;
   const match=entry.from<=p.to&&entry.to>=p.from&&expenseDate(entry.from)<end;
   const paidInPeriod=entry.method!=='unpaid'&&entry.paidOn>=p.from&&entry.paidOn<=p.to&&entry.paidOn<=day(now);
   const withdrawal=entry.method==='withdrawal'?withdrawals.get(entry.withdrawalId):null;
   const linkValid=entry.method!=='withdrawal'||withdrawal?.amountCents===entry.amountCents&&withdrawal.day===entry.paidOn;
   const overhead=!cashOnly.has(entry.category),net=entry.amountCents===null||entry.includedCents===null?null:entry.amountCents-entry.includedCents;
   const allocatedCents=match&&overhead?expenseAllocation(net,entry.from,entry.to,p.start,end):0;
   if(match&&overhead){if(allocatedCents===null){unknownCount++;departments[entry.department]=null;}else{knownOverheadCents+=allocatedCents;if(departments[entry.department]!==null)departments[entry.department]+=allocatedCents;}}
   if(paidInPeriod){if(entry.amountCents===null||!linkValid)unknownPayments++;else expensePaymentsCents+=entry.amountCents;}
   if(entry.method==='withdrawal'&&linkValid)linkedWithdrawals.add(entry.withdrawalId);
   if(match||paidInPeriod)rows.push({...entry,allocatedCents,paidInPeriod,linkValid});
  }
  const confirmation=this.db.prepare('SELECT * FROM financial_expense_confirmations WHERE period_from=? AND period_to=? ORDER BY id DESC LIMIT 1').get(p.from,p.to);
  const confirmed=!!confirmation&&confirmation.expense_revision===this.revision()&&confirmation.cost_revision===this.costs.revision()&&!unknownCount&&!unknownPayments;
  return {rows,confirmed,summary:{overheadCents:unknownCount?null:knownOverheadCents,knownOverheadCents,unknownCount,departments,expensePaymentsCents:unknownPayments?null:expensePaymentsCents,knownExpensePaymentsCents:expensePaymentsCents,unknownPayments},linkedWithdrawalIds:[...linkedWithdrawals]};
 }
 save(body,p,u,now=Date.now()){
  owner(u);
  if(!body||!uuid(body.requestId)||!Number.isSafeInteger(body.revision)||!['save','confirm'].includes(body.action))fail('Проверьте расход и повторите сохранение.');
  const fingerprint=createHash('sha256').update(stable({body,actor:u.id})).digest('hex');
  return this.admin.workforce.tx(()=>{
   const old=this.db.prepare('SELECT * FROM financial_expense_requests WHERE request_id=?').get(body.requestId);
   if(old){if(old.actor!==u.id||old.fingerprint!==fingerprint)fail('Ключ операции уже использован.',409);return {...this.catalog(p,u,now),duplicate:true};}
   if(body.revision!==this.revision())fail('Расходы изменились. Обновите список; ваш черновик сохранён.',409);
   if(body.action==='confirm'){
    if(body.from!==p.from||body.to!==p.to||body.costRevision!==this.costs.revision())fail('Период или себестоимость изменились. Обновите отчёт.',409);
    const summary=this.report(p,now).summary;
    if(summary.unknownCount||summary.unknownPayments)fail('Заполните суммы расходов и проверьте зарегистрированные оплаты.');
    this.db.prepare('INSERT INTO financial_expense_confirmations(period_from,period_to,expense_revision,cost_revision,actor,created_at) VALUES(?,?,?,?,?,?)').run(p.from,p.to,this.revision(),this.costs.revision(),u.id,now);
   }else{
    const input=body.entry;
    if(!input||typeof input!=='object'||Array.isArray(input))fail('Проверьте расход.');
    const allowed=['id','name','category','department','amountCents','includedCents','from','to','paidOn','method','withdrawalId','active'];
    if(Object.keys(input).some(key=>!allowed.includes(key)))fail('Неизвестное поле расхода.');
    const id=input.id??randomUUID(),previous=input.id?this.entries().find(row=>row.id===input.id):null;
    if(!uuid(id)||input.id&&!previous)fail('Расход не найден.',404);
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>120||!categories.has(input.category)||!['cafe','rental','shared'].includes(input.department)||typeof input.active!=='boolean'||!money(input.amountCents)||!money(input.includedCents))fail('Проверьте название, категорию и суммы расхода.');
    const first=expenseDate(input.from),last=expenseDate(input.to);
    if(last<first||last-first>=366*DAY)fail('Период расхода: от 1 до 366 дней.');
    if(input.amountCents!==null&&input.includedCents!==null&&input.includedCents>input.amountCents)fail('Учтённая себестоимость не может быть больше всего расхода.');
    if(cashOnly.has(input.category)&&input.includedCents!==0)fail('Закупки, оборудование и изъятия учитываются только в движении денег.');
    if(!['bank','external_cash','withdrawal','unpaid'].includes(input.method))fail('Выберите источник оплаты расхода.');
    if(input.category==='depreciation'&&input.method!=='unpaid')fail('Амортизация не создаёт оплату.');
    if(input.method==='unpaid'){if(input.paidOn!==null||input.withdrawalId!==null)fail('Для неоплаченного расхода не указывайте оплату.');}
    else{expenseDate(input.paidOn);if(input.paidOn>day(now))fail('Дата фактической оплаты не может быть в будущем.');}
    if(input.method==='withdrawal'){
     const row=this.withdrawals(now).find(row=>row.id===input.withdrawalId);
     if(input.active&&(!row||row.amountCents!==input.amountCents||row.day!==input.paidOn))fail('Сумма и дата должны совпадать с изъятием из кассы.');
     if(input.active&&this.entries().some(row=>row.active&&row.id!==id&&row.method==='withdrawal'&&row.withdrawalId===input.withdrawalId))fail('Это изъятие уже связано с другим расходом.',409);
    }else if(input.withdrawalId!==null)fail('Изъятие выбирается только для оплаты из кассы.');
    const entry=Object.fromEntries(allowed.filter(key=>key!=='id').map(key=>[key,key==='name'?input.name.trim():input[key]]));
    this.db.prepare('INSERT INTO financial_expense_versions(expense_id,body,actor,request_id,created_at) VALUES(?,?,?,?,?)').run(id,JSON.stringify(entry),u.id,body.requestId,now);
   }
   this.db.prepare('INSERT INTO financial_expense_requests VALUES(?,?,?,?)').run(body.requestId,fingerprint,u.id,now);
   return this.catalog(p,u,now);
  });
 }
 cashFlow(p,now,{receiptsCents,refundsCents,feesCents}){
  const expenses=this.report(p,now),end=Math.min(p.end,now+1);
  const payroll=this.db.prepare('SELECT coalesce(sum(amount_cents),0) n FROM payroll_payments WHERE paid_at>=? AND paid_at<?').get(p.start,end).n;
  const reviews=this.db.prepare('SELECT count(*) n FROM payroll_payment_reviews WHERE reported_at>=? AND reported_at<? AND (resolved_at IS NULL OR resolved_at>?)').get(p.start,end,now).n;
  const linked=new Set(expenses.linkedWithdrawalIds);
  const withdrawals=this.db.prepare('SELECT id,amount_cents FROM cash_movements WHERE created_at>=? AND created_at<? AND voided_at IS NULL').all(p.start,end).filter(row=>!linked.has(row.id)).reduce((sum,row)=>sum+row.amount_cents,0);
  const deposits=this.db.prepare("SELECT coalesce(sum(cents),0) n FROM cash_ledger WHERE kind='deposit' AND created>=? AND created<?").get(p.start,end).n;
  const out=expenses.summary.expensePaymentsCents;
  return {receiptsCents,refundsCents,feesCents,payrollCents:reviews?null:payroll,knownPayrollCents:payroll,expensePaymentsCents:out,withdrawalsCents:withdrawals,depositsCents:deposits,reviewCount:reviews+expenses.summary.unknownPayments,netCents:reviews||out===null||feesCents===null?null:receiptsCents-refundsCents-feesCents-payroll-out-withdrawals+deposits};
 }
}
