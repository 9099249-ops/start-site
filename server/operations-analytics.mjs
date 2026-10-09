import {OperationsCosts,cafeCostKey,cafeLineCost,cafeLineCostEstimated} from './operations-analytics-costs.mjs';
import {staffAnalytics} from './operations-analytics-staff.mjs';
import {fleet} from './admin.mjs';
import {FinancialExpenses} from './financial-expenses.mjs';
import {NamedCatamaranCollector,catamaranFinance,allocateCatamaranCents} from './operations-analytics-catamarans.mjs';
const DAY=86400000,HOUR=3600000,MSK=3*HOUR;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const day=t=>new Date(t+MSK).toISOString().slice(0,10);
const json=s=>JSON.parse(s||'{}');
export function analyticsPeriod(from,to,now=Date.now()){
 const today=day(now);from??=today.slice(0,8)+'01';to??=today;
 const stamp=d=>{if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d))fail('Проверьте даты.');const n=Date.parse(d+'T00:00:00+03:00');if(!Number.isFinite(n)||day(n)!==d)fail('Проверьте даты.');return n;};
 const start=stamp(from),end=stamp(to)+DAY,days=(end-start)/DAY;
 if(days<1||days>366)fail('Выберите период до 366 дней.');
 return {from,to,start,end,days,timezone:'Europe/Moscow'};
}
const empty=()=>({quantity:0,issues:0,units:0,unitMinutes:0,revenueCents:0,refundCents:0,costCents:0,knownCostCents:0,feesCents:0,contributionCents:0,missingCostCount:0,estimatedCostCount:0});
const add=(a,b)=>{for(const key of ['quantity','issues','units','unitMinutes','revenueCents','refundCents','knownCostCents','missingCostCount','estimatedCostCount'])a[key]=(a[key]||0)+(b[key]||0);for(const key of ['costCents','feesCents'])a[key]=a[key]===null||b[key]===null?null:(a[key]||0)+(b[key]||0);a.contributionCents=a.costCents===null?null:a.revenueCents-a.costCents;};
const bucket=(map,time,itemKey)=>{const d=day(time),hour=new Date(time+MSK).getUTCHours(),key=d+'@'+hour+(itemKey?'\0'+itemKey:'');if(!map.has(key))map.set(key,{day:d,hour,weekday:(new Date(d).getUTCDay()+6)%7,...(itemKey?{itemKey}:{}),...empty()});return map.get(key);};
const known=n=>Number.isSafeInteger(n)&&n>=0;
const fee=(gross,method,setting)=>gross===0||method==='cash'?0:method==='card'&&known(setting)?Math.round(gross*setting/10000):null;
export function splitService(start,end,cents){
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>366*DAY)return [];
 const result=[];let previous=0;
 for(let at=start;at<end;){const until=Math.min(end,(Math.floor(at/HOUR)+1)*HOUR),allocated=Number(BigInt(cents)*BigInt(until-start)/BigInt(end-start));result.push({start:at,end:until,minutes:(until-at)/60000,cents:allocated-previous});previous=allocated;at=until;}
 return result;
}

export class OperationsAnalytics{
 constructor(admin,cafe){this.admin=admin;this.cafe=cafe;this.db=admin.db;this.costs=new OperationsCosts(admin,cafe);this.expenses=new FinancialExpenses(admin,this.costs);}
 report(query={},u,now=Date.now()){
  if(!['admin','staff','waiter'].includes(u?.role)||u.scheduleOnly)fail('Войдите в рабочую админку.',403);
  const data=this.buildReport(query,now,false);
  const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));
  const bucketKeys=['day','weekday','hour','itemKey','quantity','issues','units','unitMinutes'];
  const department=(kind)=>({items:data[kind].items.map(i=>pick(i,['key','name','itemId','component','quantity','cancelledQuantity','completedQuantity','unpaidQuantity','complimentaryQuantity','issues','units','unitMinutes','availableUnits','capacity'])),buckets:data[kind].buckets.map(b=>pick(b,bucketKeys)),itemBuckets:data[kind].itemBuckets.map(b=>pick(b,bucketKeys)),totals:pick(data[kind].totals,['quantity','issues','units','unitMinutes']),reviewCount:data[kind].reviewCount??0});
  return {period:data.period,asOf:data.asOf,employees:data.employees,cafe:department('cafe'),rental:department('rental'),bookings:data.bookings,warnings:data.staffWarnings};
 }
 financialReport(query={},u,now=Date.now()){
  if(u?.role!=='admin'||u.scheduleOnly)fail('Финансовая аналитика доступна администратору.',403);
  return this.buildReport(query,now,true);
 }
 buildReport(query,now,includeFinance){
  const period=analyticsPeriod(query.from,query.to,now);
  this.db.exec('BEGIN');
  try{
   const readCost=this.costs.reader(),staff=staffAnalytics(this.admin,period,now);
   if(staff.employees.some(e=>e.reviewCount))staff.warnings.push('Есть смены, требующие проверки. Их непроверенные часы и задержки не включены в подтверждённые итоги.');
   const warnings=[...staff.warnings];
   const cafe=this.cafeReport(period,readCost,now),rental=this.rentalReport(period,readCost,now,includeFinance);
   const wages=includeFinance?this.wages(period,now,staff.employees):{cents:null,estimated:false},settings=readCost('settings','global',period.start);
   const cafeWagesCents=wages.cents!==null&&known(settings.cafeWageBps)?Math.round(wages.cents*settings.cafeWageBps/10000):null;
   const rentalWagesCents=cafeWagesCents===null?null:wages.cents-cafeWagesCents;
   const result=(summary,wage)=>summary.contributionCents===null||summary.feesCents===null||wage===null?null:summary.contributionCents-summary.feesCents-wage;
   if(cafe.totals.missingCostCount||rental.totals.missingCostCount)warnings.push('Себестоимость заполнена не для всех операций. Неполный расчёт не считается прибылью.');
   if(cafe.totals.estimatedCostCount)warnings.push('Часть себестоимости рассчитана по ориентировочным интернет-ценам. Прибыль предварительная.');
   if(cafe.totals.feesCents===null||rental.totals.feesCents===null)warnings.push('Не для всех оплат известны способ или комиссия. Доход после комиссии не рассчитан.');
   if(cafeWagesCents===null)warnings.push('Для результата после зарплаты укажите долю зарплаты кафе. Оставшаяся доля относится к прокату.');
   if(wages.estimated)warnings.push('Начисления незакрытых дней предварительные; выплаты зарплаты не являются повторным расходом.');
   warnings.push('Спрос и доход отнесены ко времени заказа/катания; движение денег показано отдельно. Возвраты уменьшают доход исходных продаж на дату расчёта; в движении денег они показаны по дате возврата.');
   const bookings={count:this.db.prepare('SELECT count(*) n FROM inquiries WHERE created>=? AND created<?').get(period.start,Math.min(period.end,now+1)).n};
   const data={period,asOf:now,employees:staff.employees,cafe,rental,bookings,finance:{wageTotalCents:wages.cents,wageEstimated:wages.estimated,cafeWagesCents,rentalWagesCents,cafeResultCents:result(cafe.totals,cafeWagesCents),rentalResultCents:result(rental.totals,rentalWagesCents),cafeWageBps:settings.cafeWageBps??null},warnings:[...new Set(warnings)],staffWarnings:staff.warnings};
   if(includeFinance){
    const expenses=this.expenses.report(period,now),sum=(a,b)=>a===null||b===null?null:a+b;
    const revenueCents=cafe.totals.revenueCents+rental.totals.revenueCents,directCostCents=sum(cafe.totals.costCents,rental.totals.costCents),feesCents=sum(cafe.totals.feesCents,rental.totals.feesCents);
    const beforeGeneralCents=directCostCents===null||feesCents===null||wages.cents===null?null:revenueCents-directCostCents-feesCents-wages.cents;
    const netCents=beforeGeneralCents===null||expenses.summary.overheadCents===null?null:beforeGeneralCents-expenses.summary.overheadCents;
    const confirmed=expenses.confirmed&&netCents!==null&&!wages.estimated&&!rental.estimated&&!rental.reviewCount&&!cafe.totals.estimatedCostCount&&period.end<=now;
    data.finance.profit={revenueCents,directCostCents,feesCents,wageCents:wages.cents,overheadCents:expenses.summary.overheadCents,knownOverheadCents:expenses.summary.knownOverheadCents,beforeGeneralCents,netCents,confirmed};
    data.finance.expenses=expenses;
    data.finance.catamarans=catamaranFinance(rental,cafe,data.finance,expenses,period,now);
    warnings.push(...data.finance.catamarans.warnings);
    data.finance.cafeAfterOwnExpensesCents=data.finance.cafeResultCents===null||expenses.summary.departments.cafe===null?null:data.finance.cafeResultCents-expenses.summary.departments.cafe;
    data.finance.rentalAfterOwnExpensesCents=data.finance.rentalResultCents===null||expenses.summary.departments.rental===null?null:data.finance.rentalResultCents-expenses.summary.departments.rental;
    data.finance.sharedExpensesCents=expenses.summary.departments.shared;
    data.finance.cashFlow=this.expenses.cashFlow(period,now,{receiptsCents:cafe.paymentReceiptsCents+rental.paymentReceiptsCents,refundsCents:cafe.paymentRefundsCents+rental.paymentRefundsCents,feesCents:sum(cafe.paymentFeesCents,rental.paymentFeesCents)});
    if(!expenses.confirmed)warnings.push('Общие расходы не подтверждены для выбранного периода. Добавьте расходы и подтвердите полноту во вкладке «Расходы».');
    if(expenses.summary.unknownCount)warnings.push('Есть расходы с неизвестной суммой или неизвестной частью, уже учтённой в себестоимости. Прибыль не рассчитана.');
    if(rental.estimated)warnings.push('Есть незавершённые аренды; доход и расходы по ним предварительные.');
    warnings.push('Движение денег включает только зарегистрированные оплаты, расходы, выплаты и изъятия. Комиссия банка оценена по ставке; это не остаток банковского счёта или кассы.');
    data.warnings=[...new Set(warnings)];
   }
   delete rental.catamaranRows;
   this.db.exec('COMMIT');return data;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 cafeReport(p,cost,now){
  const items=new Map(),buckets=new Map(),itemBuckets=new Map(),totals=empty();let unpaidQuantity=0,complimentaryQuantity=0,cash=0,paymentFeesCents=0;
  const events=this.db.prepare('SELECT order_id,kind,created,body FROM cafe_order_events WHERE created<=? ORDER BY id').all(now),byOrder=new Map();
  for(const e of events){if(!byOrder.has(e.order_id))byOrder.set(e.order_id,[]);byOrder.get(e.order_id).push(e);}
  const refunds=this.db.prepare("SELECT source_id,amount_cents,lines_json FROM customer_refunds WHERE kind='cafe' AND created_at<=?").all(now),byRefund=new Map();
  for(const r of refunds){if(!byRefund.has(r.source_id))byRefund.set(r.source_id,[]);byRefund.get(r.source_id).push(r);}
  for(const row of this.db.prepare('SELECT id,details,status,total_cents,created,updated FROM cafe_orders WHERE created<? AND created<=?').all(p.end,now)){
   const d=json(row.details),lines=d.items||[],history=byOrder.get(row.id)||[],appends=history.filter(e=>e.kind==='ADD').map(e=>({at:e.created,items:json(e.body).items||[]}));
   const initial=Math.max(0,lines.length-appends.reduce((n,e)=>n+e.items.length,0)),times=lines.map(()=>row.created);let offset=initial;
   for(const e of appends)for(const ignored of e.items){if(offset<times.length)times[offset++]=e.at;}
   const delivered=history.find(e=>e.kind==='DELIVERED');
   const paid=!d.complimentary&&(d.terminalPaidAt||(delivered||row.status==='DELIVERED')&&!d.terminalPaymentRequired),prepared=history.some(e=>['COOKING','READY','DELIVERED'].includes(e.kind)),cancelled=row.status==='CANCELLED',chargeStock=!cancelled||prepared;
   const paidAt=d.terminalPaidAt??delivered?.created??(row.status==='DELIVERED'?row.updated:null);
   const grossLines=lines.reduce((sum,line)=>sum+line.totalCents,0)+(d.deliveryCents||0),orderFees=fee(paid?row.total_cents:0,d.paymentMethod??(d.payment==='cash'?'cash':null),cost('settings','global',paidAt??row.created).cafeCardBps);
   let grossBefore=0;
   const lineFee=gross=>{const before=grossBefore;grossBefore+=gross;if(!paid||!gross)return 0;if(orderFees===null)return null;if(!grossLines)return 0;return Number(BigInt(orderFees)*BigInt(grossBefore)/BigInt(grossLines)-BigInt(orderFees)*BigInt(before)/BigInt(grossLines));};
   if(paid&&paidAt>=p.start&&paidAt<p.end&&paidAt<=now){cash+=row.total_cents;const charge=fee(row.total_cents,d.paymentMethod??(d.payment==='cash'?'cash':null),cost('settings','global',paidAt).cafeCardBps);paymentFeesCents=paymentFeesCents===null||charge===null?null:paymentFeesCents+charge;}
   const returned=new Map();for(const r of byRefund.get(row.id)||[])for(const line of json(r.lines_json))returned.set(line.index,(returned.get(line.index)||0)+line.quantity*line.unitCents);
   for(let index=0;index<lines.length;index++){
    const line=lines[index],at=times[index],allocatedFee=lineFee(line.totalCents);if(at<p.start||at>=p.end||at>now)continue;
    const component=line.variant?'variant:'+line.variant.id:'base',key=cafeCostKey(line.itemId,component),name=line.name+(line.variant?' · '+line.variant.name:'');
    if(!items.has(key))items.set(key,{key,name,itemId:line.itemId,component,cancelledQuantity:0,completedQuantity:0,unpaidQuantity:0,complimentaryQuantity:0,...empty()});
    const r=empty();r.quantity=cancelled?0:line.quantity;r.cancelledQuantity=cancelled?line.quantity:0;
    const refund=returned.get(index)||0;r.refundCents=refund;r.revenueCents=(paid?line.totalCents:0)-refund;
    if(chargeStock){const base=cafeLineCost(cost,line,at),options=line.costMode==='recipe'?[]:(line.modifiers||[]).map(m=>cost('cafe',cafeCostKey(line.itemId,'option:'+m.optionId),at).portionCents);r.costCents=known(base)&&options.every(known)?(base+options.reduce((a,b)=>a+b,0))*line.quantity:null;r.missingCostCount=r.costCents===null?line.quantity:0;r.knownCostCents=r.costCents||0;r.estimatedCostCount=cafeLineCostEstimated(cost,line,at)?line.quantity:0;}
    r.feesCents=allocatedFee;
    add(items.get(key),r);items.get(key).cancelledQuantity+=r.cancelledQuantity;items.get(key).completedQuantity+=paid&&!cancelled?line.quantity:0;
    add(bucket(buckets,at),r);add(bucket(itemBuckets,at,key),r);add(totals,r);
    if(!paid&&!cancelled&&!d.complimentary){unpaidQuantity+=line.quantity;items.get(key).unpaidQuantity+=line.quantity;}if(d.complimentary&&!cancelled){complimentaryQuantity+=line.quantity;items.get(key).complimentaryQuantity+=line.quantity;}
   }
   if(row.created>=p.start&&row.created<p.end&&d.deliveryCents){const refund=returned.get(-1)||0,r=empty(),deliveryCost=cost('settings','global',row.created).deliveryCostCents;r.revenueCents=(paid?d.deliveryCents:0)-refund;r.refundCents=refund;r.costCents=chargeStock?known(deliveryCost)?deliveryCost:null:0;r.knownCostCents=r.costCents||0;r.missingCostCount=r.costCents===null?1:0;r.feesCents=lineFee(d.deliveryCents);add(totals,r);add(bucket(buckets,row.created),r);}
  }
  const cashRefund=this.db.prepare("SELECT coalesce(sum(amount_cents),0) cents FROM customer_refunds WHERE kind='cafe' AND created_at>=? AND created_at<?").get(p.start,Math.min(p.end,now+1)).cents;
  return {items:[...items.values()].sort((a,b)=>b.quantity-a.quantity),buckets:[...buckets.values()],itemBuckets:[...itemBuckets.values()],totals,unpaidQuantity,complimentaryQuantity,paymentFeesCents,paymentReceiptsCents:cash,paymentRefundsCents:cashRefund,paymentNetCents:cash-cashRefund};
 }
 rentalReport(p,cost,now,includeFinance=false){
  const items=new Map(fleet.map(([key,name,capacity])=>[key,{key,name,capacity,availableUnits:capacity,...empty()}])),buckets=new Map(),itemBuckets=new Map(),totals=empty();let reviewCount=0,estimated=false;
  const pays=this.db.prepare('SELECT rental_id,amount,method,created FROM payments WHERE created<=?').all(now),payments=new Map();for(const r of pays){if(!payments.has(r.rental_id))payments.set(r.rental_id,[]);payments.get(r.rental_id).push(r);}
  const catamarans=includeFinance?new NamedCatamaranCollector(this.db,p,now):null,refundRows=this.db.prepare("SELECT source_id,amount_cents,created_at FROM customer_refunds WHERE kind='rental' AND created_at<=?").all(now),refundsByRental=new Map();
  for(const refund of refundRows){if(!refundsByRental.has(refund.source_id))refundsByRental.set(refund.source_id,[]);refundsByRental.get(refund.source_id).push(refund);}
  const refunds=new Map(this.db.prepare("SELECT source_id,sum(amount_cents) cents FROM customer_refunds WHERE kind='rental' AND created_at<=? GROUP BY source_id").all(now).map(r=>[r.source_id,r.cents]));
  for(const row of this.db.prepare('SELECT id,equipment,quantity,departed,departed_at,departure_pending,created,returned,custom_json FROM rentals WHERE created<=?').all(now)){
   let item=items.get(row.equipment);if(!item){item={key:row.equipment,name:row.equipment==='manual'?'Свободная цена':row.equipment,availableUnits:null,...empty()};items.set(row.equipment,item);}
   if(row.returned===null&&item.availableUnits!==null)item.availableUnits=Math.max(0,item.availableUnits-row.quantity);
   catamarans?.payments(row,payments.get(row.id)||[],refundsByRental.get(row.id)||[]);
   if(row.departure_pending)continue;const start=row.departed_at??Date.parse(row.departed+':00+03:00'),end=row.returned??now,version=cost('rental',row.equipment,row.created),totalPaid=(payments.get(row.id)||[]).reduce((n,r)=>n+r.amount,0),refunded=refunds.get(row.id)||0;
   if(row.custom_json){if(row.created>=p.start&&row.created<p.end){const r=empty();r.revenueCents=totalPaid-refunded;r.refundCents=refunded;r.costCents=null;r.feesCents=null;r.missingCostCount=1;add(item,r);add(bucket(buckets,row.created),r);add(totals,r);}continue;}
   const parts=splitService(start,end,totalPaid-refunded);
   if(row.returned===null&&start<p.end&&end>p.start)estimated=true;
   if(!parts.length){if(start>=p.start&&start<p.end){reviewCount++;catamarans?.review(row);}continue;}
   const hours=(end-start)/HOUR,energyRequired=['catamaran','electric'].includes(row.equipment)&&version.electricityIncluded!==1;
   const energyKnown=!energyRequired||typeof version.kwhPerHour==='number'&&known(version.electricityTariffCents);
   const hourCents=known(version.hourCents)&&energyKnown?version.hourCents+(energyRequired?version.kwhPerHour*version.electricityTariffCents:0):null;
   const fullCost=known(version.issueCents)&&hourCents!==null?Math.round((version.issueCents+hourCents*hours)*row.quantity):null;
   // Issue preparation is charged at departure; hourly costs follow physical use.
   const variable=hourCents===null?null:Math.round(hourCents*hours*row.quantity),variableParts=splitService(start,end,variable??0),refundParts=splitService(start,end,refunded);
   const fullElectricity=energyKnown?energyRequired?Math.round(version.kwhPerHour*version.electricityTariffCents*hours*row.quantity):0:null;
   const electricityParts=fullElectricity===null?null:variable===null?splitService(start,end,fullElectricity).map(part=>part.cents):allocateCatamaranCents(fullElectricity,variableParts.map(part=>part.cents));
   let fullFees=0;for(const payment of payments.get(row.id)||[]){const f=fee(payment.amount,payment.method,cost('settings','global',payment.created).rentalCardBps);if(f===null){fullFees=null;break;}fullFees+=f;}
   const feeParts=splitService(start,end,fullFees??0);
   for(let n=0;n<parts.length;n++){
    const part=parts[n];if(part.start<p.start||part.start>=p.end)continue;
    const r=empty();r.unitMinutes=part.minutes*row.quantity;r.quantity=row.quantity*part.minutes/60;r.issues=n===0?1:0;r.units=n===0?row.quantity:0;r.revenueCents=part.cents;r.refundCents=refundParts[n].cents;r.costCents=fullCost===null?null:variableParts[n].cents+(n===0?version.issueCents*row.quantity:0);r.knownCostCents=r.costCents||0;r.missingCostCount=r.costCents===null?1:0;r.feesCents=fullFees===null?null:feeParts[n].cents;
    add(item,r);add(bucket(buckets,part.start),r);add(bucket(itemBuckets,part.start,row.equipment),r);add(totals,r);
    catamarans?.service(row,part,r,electricityParts?.[n]??null,version.electricityIncluded===1);
   }
  }
  const paymentReceiptsCents=pays.filter(r=>r.created>=p.start&&r.created<p.end).reduce((n,r)=>n+r.amount,0),paymentRefundsCents=this.db.prepare("SELECT coalesce(sum(amount_cents),0) n FROM customer_refunds WHERE kind='rental' AND created_at>=? AND created_at<?").get(p.start,Math.min(p.end,now+1)).n;
  let paymentFeesCents=0;for(const payment of pays.filter(r=>r.created>=p.start&&r.created<p.end)){const charge=fee(payment.amount,payment.method,cost('settings','global',payment.created).rentalCardBps);paymentFeesCents=paymentFeesCents===null||charge===null?null:paymentFeesCents+charge;}
  return {items:[...items.values()].filter(i=>i.units||i.unitMinutes||i.revenueCents||i.key==='catamaran'),buckets:[...buckets.values()],itemBuckets:[...itemBuckets.values()],totals,reviewCount,estimated,paymentFeesCents,paymentReceiptsCents,paymentRefundsCents,paymentNetCents:paymentReceiptsCents-paymentRefundsCents,catamaranRows:catamarans?.rows()||[]};
 }
 wages(p,now,employees){
  if(employees.some(e=>e.reviewCount))return {cents:null,estimated:true};
  let cents=0,estimated=false;
  for(const entry of this.admin.workforce.payroll.list({role:'admin'},now)){
   const total=entry.salary_cents-entry.refund_adjustment_cents;
   const origins=this.admin.workforce.payroll.origins(entry.shift_id,entry.user_id,entry.salary_cents);let assigned=0;
   for(let i=0;i<origins.length;i++){const origin=origins[i],share=i===origins.length-1?total-assigned:entry.salary_cents?Math.round(total*origin.cents/entry.salary_cents):0;assigned+=share;if(origin.day>=p.from&&origin.day<=p.to)cents+=share;}
  }
  for(let at=p.start;at<p.end&&at<=now;at+=DAY){const d=day(at);if(this.admin.currentShift(d)?.closed_at)continue;const calc=this.admin.workforce.calculate(d,now);cents+=calc.employees.reduce((n,e)=>n+e.salary_cents,0);if(calc.employees.length)estimated=true;}
  return {cents,estimated};
 }
}

export function operationsAnalyticsHandler(store,admin,origin){return async(req,res,url)=>{
 const base='/api/admin/operations-analytics',financialBase='/api/admin/financial-analytics';if(!url.pathname.startsWith(base)&&!url.pathname.startsWith(financialBase))return false;
 const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:JSON.stringify(body));return true;};
 const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.slice(21),u=admin?.user(token,true);
 if(!u)return reply(401,{error:'Войдите в админку.'});if(!['admin','staff','waiter'].includes(u.role)||u.scheduleOnly)return reply(403,{error:'Войдите в рабочую админку.'});if(!store)return reply(503,{error:'База аналитики не настроена.'});
 const financial=url.pathname.startsWith(financialBase);
 if(financial&&u.role!=='admin')return reply(403,{error:'Финансовая аналитика доступна администратору.'});
 try{
  if(req.method==='GET'||req.method==='HEAD'){
   if(url.pathname===financialBase+'/costs')return reply(200,store.costs.catalog(u));
   if(url.pathname===financialBase+'/expenses')return reply(200,store.expenses.catalog(analyticsPeriod(url.searchParams.get('from')??undefined,url.searchParams.get('to')??undefined),u));
   if(url.pathname!==base&&url.pathname!==financialBase)return reply(404,{error:'Не найдено.'});
   const query={from:url.searchParams.get('from')??undefined,to:url.searchParams.get('to')??undefined};
   return reply(200,financial?store.financialReport(query,u):store.report(query,u));
  }
  if(req.method!=='POST'||![financialBase+'/costs',financialBase+'/expenses'].includes(url.pathname))return reply(405,{error:'Метод не поддерживается.'});
  if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return reply(403,{error:'Недопустимый источник запроса.'});
  const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>131072)return reply(413,{error:'Слишком большой запрос.'});chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'Некорректные данные.'});}
  if(url.pathname===financialBase+'/expenses')return reply(200,store.expenses.save(body,analyticsPeriod(url.searchParams.get('from')??undefined,url.searchParams.get('to')??undefined),u));
  return reply(200,store.costs.save(body,u));
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось рассчитать аналитику.'});}
};}
