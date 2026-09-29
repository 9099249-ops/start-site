// API v4 contract, verified against https://api.aqsi.ru/pub/v1/swagger.json.
// These helpers do not send requests or enable live payments.
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function purchaseRequest(deviceId,amountCents){
 if(!Number.isSafeInteger(deviceId)||deviceId<=0||!Number.isSafeInteger(amountCents)||amountCents<=0)throw Error('Invalid payment');
 return {deviceId,amount:amountCents,mode:'sbp_with_card',ttlMillis:120000,printCount:1};
}
export function operationReference(response){return typeof response?.operationId==='string'&&uuid.test(response.operationId)?response.operationId:null;}
export function purchaseOutcome(expected,operation){
 const unknown=reason=>({state:'unknown',reason,canRetryPayment:false});
 if(!expected.operationId||operation?.operationId!==expected.operationId||operation.deviceId!==expected.deviceId||operation.type!=='acquiring.purchase')return unknown('operation_mismatch');
 if(['Pending','Processing','Finishing'].includes(operation.status))return {state:'pending',canRetryPayment:false};
 // Canceled is a terminal device-confirmed cancellation, unlike a network timeout.
 // Contradictory/malformed result evidence keeps the operation locked.
 if(operation.status==='Canceled'){
  if(operation.result!==null&&operation.result!==undefined&&operation.result!=='')return unknown('cancellation_has_result');
  return {state:'cancelled',canRetryPayment:true};
 }
 // An unsuccessful process is not proof that the bank did not debit the card.
 if(operation.status!=='Completed')return unknown('not_confirmed');
 let slip;try{slip=JSON.parse(operation.result);}catch{return unknown('missing_result');}
 if(!slip||typeof slip.id!=='string'||!slip.id||slip.device?.id!==expected.deviceId||slip.content?.type!=='purchase'||slip.content?.amount!==expected.amountCents)return unknown('slip_mismatch');
 if(!['00','000','SUCCESS'].includes(slip.content.responseCode))return unknown('bank_result_unconfirmed');
 return {state:'paid',slipId:slip.id,canRetryPayment:false};
}
