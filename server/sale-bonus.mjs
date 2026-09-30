// Integer kopecks. A shift starts inclusively and ends exclusively.
export function saleBonuses(events,employees,percent,cashAdjustment=0){
 const rows=employees.map(e=>({...e,bonus_cents:0,sales_bonus_cents:0,cash_bonus_cents:0}));
 let sales=0,pool=0,unallocated=0;
 const allocate=(amount,eligible,weighted=false)=>{
  if(!amount)return;
  const sign=Math.sign(amount),total=eligible.reduce((n,e)=>n+BigInt(weighted?e.worked_ms:1),0n);
  if(!total){unallocated+=amount;return;}
  const parts=eligible.map(e=>{const n=BigInt(Math.abs(amount))*BigInt(weighted?e.worked_ms:1);return {e,n:Number(n/total),rest:n%total};});
  let left=Math.abs(amount)-parts.reduce((n,p)=>n+p.n,0);
  for(const p of [...parts].sort((a,b)=>a.rest===b.rest?a.e.user_id-b.e.user_id:a.rest>b.rest?-1:1)){if(left-->0)p.n++;}
  for(const p of parts){const cents=sign*p.n;p.e.bonus_cents+=cents;p.e[weighted?'cash_bonus_cents':'sales_bonus_cents']+=cents;}
 };
 for(const event of [...events].sort((a,b)=>a.at-b.at||String(a.id).localeCompare(String(b.id)))){
  if(!Number.isSafeInteger(event.cents)||event.cents<0)throw Error('Некорректная сумма продажи');
  sales+=event.cents;const next=Number(BigInt(sales)*BigInt(percent)/100n),delta=next-pool;pool=next;
  allocate(delta,rows.filter(e=>event.bonusActor?e.user_id===event.bonusActor:e.sessions.some(s=>s.started_at<=event.at&&(s.ended_at===null||s.ended_at>event.at))));
 }
 const finalPool=Number(BigInt(Math.max(0,sales+cashAdjustment))*BigInt(percent)/100n);
 allocate(finalPool-pool,rows.filter(e=>e.worked_ms>0),true);
 return {rows,pool:finalPool,sales,unallocated,cashAdjustment};
}
