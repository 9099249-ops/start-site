import {CATAMARANS} from './battery-state.mjs';

const unknownKey='catamaran:unknown';
const keyFor=label=>'catamaran:boat:'+label;
const hasTrips=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='battery_trips'").get();
export function catamaranLabels(db){
 const historical=hasTrips(db)?db.prepare('SELECT DISTINCT label FROM battery_trips ORDER BY label').all().map(row=>row.label):[];
 return [...new Set([...CATAMARANS,...historical])];
}

// Cumulative integer shares conserve cents, including refunds and rounding remainders.
export function allocateCatamaranCents(amount,weights){
 if(amount===null)return weights.map(()=>null);
 const total=weights.reduce((sum,value)=>sum+value,0);
 if(!total)return weights.map(()=>0);
 let cumulative=0,assigned=0;
 return weights.map(weight=>{cumulative+=weight;const until=Number(BigInt(amount)*BigInt(cumulative)/BigInt(total)),share=until-assigned;assigned=until;return share;});
}
const sum=(a,b)=>a===null||b===null?null:a+b;
const moneyFields=['revenueCents','refundCents','costCents','electricityCents','otherDirectCostCents','feesCents','paymentReceiptsCents','paymentRefundsCents','paymentCashCents','paymentCardCents','paymentUnknownCents'];
function emptyRow(label){
 return {key:label===null?unknownKey:keyFor(label),name:label??'Катамаран не указан',unknown:label===null,rentalsCount:0,unitMinutes:0,...Object.fromEntries(moneyFields.map(key=>[key,0])),electricityIncluded:false,electricityIncludedPartly:false,estimated:false};
}

export class NamedCatamaranCollector{
 constructor(db,period,now){
  this.period=period;this.now=now;this.items=new Map(catamaranLabels(db).map(label=>[keyFor(label),emptyRow(label)]));this.bindings=new Map();this.ids=new Map();this.energyModes=new Map();
  if(hasTrips(db))for(const trip of db.prepare("SELECT rental_id,label FROM battery_trips WHERE state!='dismissed' AND created_at<=? ORDER BY rental_id,label").all(now)){
   if(!this.bindings.has(trip.rental_id))this.bindings.set(trip.rental_id,new Set());this.bindings.get(trip.rental_id).add(trip.label);
  }
 }
 targets(rental){
  if(rental.equipment!=='catamaran'||rental.custom_json)return [];
  const labels=[...(this.bindings.get(rental.id)||[])],quantity=rental.quantity;
  const targets=labels.length<=quantity?labels.map(label=>({label,units:1})):[];
  const missing=quantity-targets.length;if(missing>0)targets.push({label:null,units:missing});
  return targets.map(target=>{
   const key=target.label===null?unknownKey:keyFor(target.label);if(!this.items.has(key))this.items.set(key,emptyRow(target.label));return {...target,key};
  });
 }
 add(rental,values,{minutes=0,estimated=false,electricityIncluded=null}={}){
  const targets=this.targets(rental);if(!targets.length)return;
  const weights=targets.map(target=>target.units),shares=Object.fromEntries(Object.entries(values).map(([field,cents])=>[field,allocateCatamaranCents(cents,weights)]));
  if(Object.hasOwn(values,'costCents')&&values.costCents!==null&&values.electricityCents!==null){
   shares.electricityCents=allocateCatamaranCents(values.electricityCents,shares.costCents);
   shares.otherDirectCostCents=shares.costCents.map((cents,index)=>cents-shares.electricityCents[index]);
  }
  for(let i=0;i<targets.length;i++){
   const target=targets[i],row=this.items.get(target.key);for(const [field,amounts] of Object.entries(shares))row[field]=sum(row[field],amounts[i]);row.unitMinutes+=minutes*target.units;
   row.estimated||=estimated;if(!this.ids.has(target.key))this.ids.set(target.key,new Set());this.ids.get(target.key).add(rental.id);
   if(electricityIncluded!==null){if(!this.energyModes.has(target.key))this.energyModes.set(target.key,new Set());this.energyModes.get(target.key).add(electricityIncluded);}
  }
 }
 payments(rental,payments,refunds){
  const inPeriod=at=>at>=this.period.start&&at<this.period.end&&at<=this.now;
  for(const payment of payments.filter(payment=>inPeriod(payment.created))){
   this.add(rental,{paymentReceiptsCents:payment.amount,paymentCashCents:payment.method==='cash'?payment.amount:0,paymentCardCents:payment.method==='card'?payment.amount:0,paymentUnknownCents:!['cash','card'].includes(payment.method)?payment.amount:0});
  }
  for(const refund of refunds.filter(refund=>inPeriod(refund.created_at)))this.add(rental,{paymentRefundsCents:refund.amount_cents});
 }
 service(rental,part,values,electricityCents,electricityIncluded){
  this.add(rental,{revenueCents:values.revenueCents,refundCents:values.refundCents,costCents:values.costCents,electricityCents,otherDirectCostCents:values.costCents===null||electricityCents===null?null:values.costCents-electricityCents,feesCents:values.feesCents},{minutes:part.minutes,estimated:rental.returned===null,electricityIncluded});
 }
 review(rental){this.add(rental,{costCents:null,electricityCents:null,otherDirectCostCents:null,feesCents:null},{estimated:true});}
 rows(){
  return [...this.items.values()].map(row=>{const modes=this.energyModes.get(row.key)||new Set();return {...row,rentalsCount:this.ids.get(row.key)?.size||0,electricityIncluded:modes.has(true)&&!modes.has(false),electricityIncludedPartly:modes.has(true)&&modes.has(false)};});
 }
}

export function catamaranFinance(rental,cafe,finance,expenses,period,now){
 const rows=(rental.catamaranRows||[]).map(row=>({...row}));
 const gross=row=>Math.max(0,row.revenueCents+row.refundCents);
 const other=rental.items.filter(row=>row.key!=='catamaran');
 const groups=[...other,...rows],weights=groups.map(gross),rentalGross=weights.reduce((a,b)=>a+b,0);
 const targeted=new Map(rows.map(row=>[row.key,0]));let rentalOverhead=0,sharedOverhead=0;
 for(const expense of expenses.rows){
  if(expense.department==='shared')sharedOverhead=sum(sharedOverhead,expense.allocatedCents);
  if(expense.department!=='rental')continue;
  if(expense.catamaranLabel){const key=keyFor(expense.catamaranLabel);if(!targeted.has(key)){const row=emptyRow(expense.catamaranLabel);rows.push(row);groups.push(row);weights.push(0);targeted.set(key,0);}targeted.set(key,sum(targeted.get(key),expense.allocatedCents));}
  else rentalOverhead=sum(rentalOverhead,expense.allocatedCents);
 }
 const wages=allocateCatamaranCents(finance.rentalWagesCents,weights),own=allocateCatamaranCents(rentalOverhead,weights);
 const sharedWeights=[Math.max(0,cafe.totals.revenueCents+cafe.totals.refundCents),...weights],shared=allocateCatamaranCents(sharedOverhead,sharedWeights).slice(1);
 const residual=(amount,total)=>amount===null?null:total?0:amount;
 const unallocated={wagesCents:residual(finance.rentalWagesCents,rentalGross),rentalOverheadCents:residual(rentalOverhead,rentalGross),sharedOverheadCents:residual(sharedOverhead,sharedWeights.reduce((a,b)=>a+b,0))};
 const unresolvedAllocation=Object.values(unallocated).some(value=>value===null||value!==0),warnings=[];
 for(const row of rows){
  const index=groups.indexOf(row);row.wagesCents=wages[index];row.rentalOverheadCents=own[index];row.sharedOverheadCents=shared[index];row.directOverheadCents=targeted.get(row.key)||0;
  // A missing targeted expense is unknown, not an absent expense.
  if(targeted.get(row.key)===null)row.directOverheadCents=null;
  row.overheadCents=sum(sum(row.rentalOverheadCents,row.sharedOverheadCents),row.directOverheadCents);
  const deductions=[row.costCents,row.feesCents,row.wagesCents,row.overheadCents];
  row.netCents=unresolvedAllocation||deductions.some(value=>value===null)?null:row.revenueCents-deductions.reduce((a,b)=>a+b,0);
  row.complete=row.netCents!==null&&expenses.confirmed&&!finance.wageEstimated&&!row.estimated&&!rental.estimated&&!rental.reviewCount&&period.end<=now;
  row.estimated||=!row.complete;
 }
 if(rows.some(row=>row.unknown&&row.rentalsCount))warnings.push('Аренды без однозначной исторической привязки показаны отдельно: катамаран не указан.');
 if(unresolvedAllocation)warnings.push('Часть зарплаты или общих расходов не распределена: нет выручки для распределения либо сумма неизвестна.');
 if(!expenses.confirmed)warnings.push('Полнота расходов периода не подтверждена. Результат предварительный.');
 return {rows,allocationBasis:'gross-revenue',unallocated,warnings};
}
