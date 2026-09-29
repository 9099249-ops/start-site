import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseRequest,operationReference,purchaseOutcome} from './aqsi-protocol.mjs';
const expected={operationId:'11111111-1111-4111-8111-111111111111',deviceId:709740,amountCents:100};
const slip={id:'slip-test',device:{id:expected.deviceId},content:{type:'purchase',amount:100,responseCode:'00'}};
const operation={...expected,type:'acquiring.purchase',status:'Completed',result:JSON.stringify(slip)};
test('aQsi purchase uses kopecks and card and SBP mode; never treats creation as payment',()=>{
 assert.deepEqual(purchaseRequest(709740,100),{deviceId:709740,amount:100,mode:'sbp_with_card',ttlMillis:120000,printCount:1});
 assert.throws(()=>purchaseRequest(1,1.2));assert.throws(()=>purchaseRequest(1,0));
 assert.equal(operationReference({operationId:expected.operationId}),expected.operationId);
 assert.equal(operationReference({id:'another-id'}),null);
 assert.equal(purchaseOutcome(expected,{operationId:expected.operationId}).state,'unknown');
});
test('aQsi payment confirmation requires the exact operation, device, amount and bank success',()=>{
 assert.equal(purchaseOutcome(expected,operation).state,'paid');
 for(const responseCode of ['000','SUCCESS'])assert.equal(purchaseOutcome(expected,{...operation,result:JSON.stringify({...slip,content:{...slip.content,responseCode}})}).state,'paid');
 for(const status of ['Pending','Processing','Finishing'])assert.equal(purchaseOutcome(expected,{...operation,status}).state,'pending');
 for(const status of ['Error','Canceled','Timeout','unrecognized'])assert.equal(purchaseOutcome(expected,{...operation,status}).state,'unknown');
 for(const change of [{operationId:'other'},{deviceId:1},{type:'receipt.process'},{result:'bad json'}])assert.equal(purchaseOutcome(expected,{...operation,...change}).state,'unknown');
 for(const content of [{...slip.content,amount:101},{...slip.content,type:'refund'},{...slip.content,responseCode:'DECLINED'},{...slip.content,responseCode:undefined}])assert.equal(purchaseOutcome(expected,{...operation,result:JSON.stringify({...slip,content})}).state,'unknown');
 for(const status of ['Completed','Pending','Error','Timeout'])assert.equal(purchaseOutcome(expected,{...operation,status}).canRetryPayment,false);
});

test('Only exact final cancellation without contradictory result permits retry; timeout/error remain unknown',()=>{
 const expected={operationId:'op',deviceId:709740,amountCents:100},op={operationId:'op',deviceId:709740,type:'acquiring.purchase',status:'Canceled',result:null};
 assert.equal(purchaseOutcome(expected,op).state,'cancelled');for(const status of ['Timeout','Error','Processing'])assert.notEqual(purchaseOutcome(expected,{...op,status}).state,'cancelled');
 for(const change of [{deviceId:1},{operationId:'other'},{type:'receipt.process'},{result:'{}'},{result:'garbage'}])assert.equal(purchaseOutcome(expected,{...op,...change}).state,'unknown');
});
