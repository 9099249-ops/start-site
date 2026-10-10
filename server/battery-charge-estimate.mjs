// Use only the current charging session; a falling current must not shorten the estimate.
export function estimateChargeMinutes(telemetry,capacityAh,samples=[]){
 const t=telemetry;
 if(t?.state!=='charging'||!Number.isFinite(t.currentA)||t.currentA<=0||!Number.isFinite(capacityAh)||capacityAh<=0||!Number.isFinite(t.remainingCapacityAh)||t.remainingCapacityAh<0||t.remainingCapacityAh>capacityAh)return null;
 const currents=[t.currentA];
 for(const sample of samples){
  if(sample?.state!=='charging'||!Number.isFinite(sample.currentA)||sample.currentA<=0)break;
  currents.push(sample.currentA);
 }
 const average=currents.reduce((sum,value)=>sum+value,0)/currents.length;
 const effective=Math.min(t.currentA,average);
 const minutes=(capacityAh-t.remainingCapacityAh)/effective*60;
 return minutes>=0&&minutes<=10080?Math.round(minutes):null;
}
