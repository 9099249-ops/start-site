import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore,fleet} from './admin.mjs';
import {extendRental} from './rental-actions.mjs';

function fixture(){
 const store=new AdminStore(':memory:'),user={id:1,role:'admin'},now=Date.parse('2026-10-05T12:00:00+03:00');
 store.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'second','staff','unused')");
 const requestId=randomUUID(),body={requestId,equipment:'sup',quantity:1,name:'Test',phone:'+79000000000',departed:'2026-10-05T12:00',expectedReturn:'2026-10-05T13:00',amount:'1000',method:'card'};
 const id=store.create(body,user,now);
 return {store,user,now,id,body,requestId};
}
test('return surcharge requires current amount, revision and actual received payment method atomically',()=>{
 const {store:s,user:u,now,id}=fixture();
 try{
  extendRental(s,fleet,{id,revision:0,minutes:30},u,now);
  const good={confirmed:true,method:'cash',amountCents:50000};
  for(const [revision,payment] of [[undefined,good],[0,good],[1,undefined],[1,{...good,confirmed:false}],[1,{...good,amountCents:1}],[1,{...good,method:'unspecified'}]]){
   assert.throws(()=>s.returned(id,u,now,revision,payment));
   assert.equal(s.db.prepare('SELECT count(*) n FROM payments').get().n,1);
   assert.equal(s.db.prepare('SELECT returned FROM rentals WHERE id=?').get(id).returned,null);
  }
  s.returned(id,u,now,1,good);s.returned(id,u,now+1,1,good);
  assert.deepEqual(s.db.prepare('SELECT amount,method FROM payments ORDER BY id').all().map(x=>({...x})),[{amount:100000,method:'card'},{amount:50000,method:'cash'}]);
 }finally{s.close();}
});
test('request recovery is read-only, actor scoped and supports safe same-request retry',()=>{
 const {store:s,user:u,now,id,body,requestId}=fixture();
 try{
  assert.deepEqual(s.rentalRequest(requestId,u),{found:true,id,returned:null,initialDue:0});
  assert.deepEqual(s.rentalRequest(requestId,{id:2}),{found:false});
  assert.deepEqual(s.rentalRequest(randomUUID(),u),{found:false});
  assert.throws(()=>s.rentalRequest('not-an-id',u));
  assert.equal(s.create(body,u,now),id);
  assert.equal(s.db.prepare('SELECT count(*) n FROM payments').get().n,1);
  s.returned(id,u,now,0);
  assert.equal(s.rentalRequest(requestId,u).returned,now);
 }finally{s.close();}
});
test('explicit cash issuance without a terminal records cash rather than legacy unspecified method',()=>{
 const {store:s,user:u,now,body}=fixture();
 try{
  const id=s.create({...body,requestId:randomUUID(),method:'unspecified',cash:true},u,now);
  assert.equal(s.db.prepare('SELECT method FROM payments WHERE rental_id=?').get(id).method,'cash');
 }finally{s.close();}
});
