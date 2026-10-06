import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore,fleet} from './admin.mjs';
import {extendRental,undoReturn} from './rental-actions.mjs';
import {rentalPrice} from './rental-pricing.mjs';
test('Rental tariff, repeated extensions, Big SUP people and return payment are consistent',()=>{
 const s=new AdminStore(':memory:'),u={id:1,role:'admin'},now=Date.parse('2026-09-26T10:00:00+03:00');
 s.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused')");
 try{
  const make=extra=>s.create({requestId:randomUUID(),equipment:'sup',quantity:2,name:'Тест',phone:'+79000000000',departed:'2026-09-26T10:00',expectedReturn:'2026-09-26T11:00',amount:'2000',method:'card',...extra},u,now);
  assert.equal(rentalPrice(s,'sup',2,30),100000);assert.equal(rentalPrice(s,'sup',2,60),200000);assert.equal(rentalPrice(s,'sup',2,120),400000);
  const id=make();extendRental(s,fleet,{id,revision:0,minutes:30},u,now);extendRental(s,fleet,{id,revision:1,minutes:60},u,now);
  assert.equal(s.db.prepare('SELECT extension_due FROM rentals WHERE id=?').get(id).extension_due,300000);
  assert.equal(s.db.prepare('SELECT sum(amount) n FROM payments').get().n,200000);
  assert.throws(()=>s.returned(id,u,now+7200000),/Подтвердите/);
  s.returned(id,u,now+7200000,2,{confirmed:true,method:'card',amountCents:300000});s.returned(id,u,now+7200001);
  const payments=s.db.prepare('SELECT * FROM payments WHERE rental_id=? ORDER BY id').all(id);
  assert.equal(payments.length,2);assert.equal(payments[1].amount,300000);assert.equal(payments[1].method,'card');assert.equal(payments[1].created,now+7200000);
  assert.equal(s.db.prepare('SELECT extension_due FROM rentals WHERE id=?').get(id).extension_due,0);
  assert.throws(()=>undoReturn(s,fleet,{id,revision:3,returnedAt:now+7200000},u,now+7200001),/сверка/);
  const noSplit=make({method:'unspecified'});extendRental(s,fleet,{id:noSplit,revision:0,minutes:30},u,now);s.returned(noSplit,u,now+3600000,1,{confirmed:true,method:'cash',amountCents:100000});assert.deepEqual(s.db.prepare('SELECT method FROM payments WHERE rental_id=?').all(noSplit).map(x=>x.method),['unspecified','cash']);
  const big=make({equipment:'big',quantity:1,people:5});assert.equal(rentalPrice(s,'big',1,30,5),250000);
  extendRental(s,fleet,{id:big,revision:0,minutes:60},u,now);assert.equal(s.db.prepare('SELECT extension_due FROM rentals WHERE id=?').get(big).extension_due,500000);
 }finally{s.close();}
});
