import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AdminStore,fleet} from './admin.mjs';
import {departRental,initializeDepartures} from './rental-departure.mjs';
import {extendRental} from './rental-actions.mjs';
import {availability,calendarData} from './calendar.mjs';
import {AqsiRental} from './aqsi-rental.mjs';
import {clientRows} from './clients-export.mjs';

const now=Date.parse('2026-10-08T12:00:00+03:00'),owner={id:1,role:'admin'},day='2026-10-08';
function fixture(t,file=':memory:'){
 const store=new AdminStore(file);
 store.db.exec("INSERT OR IGNORE INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");
 store.workforce.requireOnDuty=()=>{};
 t.after(()=>store.close());
 const body={requestId:randomUUID(),equipment:'catamaran',quantity:1,name:'Test',phone:'+79000000000',departed:'2026-10-08T12:00',expectedReturn:'2026-10-08T13:00',amount:'1000',method:'cash'};
 const create=extra=>store.create({...body,requestId:randomUUID(),...extra},owner,now);
 return {store,body,create,row:id=>store.db.prepare('SELECT * FROM rentals WHERE id=?').get(id)};
}

test('Paid catamaran reserves stock but is not on water or overdue; creation retries do not start it',t=>{
 const f=fixture(t),id=f.store.create(f.body,owner,now);
 assert.equal(f.store.create(f.body,owner,now+1800000),id);
 assert.equal(f.row(id).departure_pending,1);assert.equal(f.row(id).departed_at,null);
 const dashboard=f.store.dashboard(day,owner);
 assert.equal(dashboard.active.length,0);assert.equal(dashboard.waitingDepartures[0].id,id);
 assert.equal(dashboard.fleet.find(r=>r.id==='catamaran').available,2);
 assert.equal(f.store.db.prepare('SELECT sum(amount) n FROM payments').get().n,100000);
 assert.equal(calendarData(f.store,fleet,day,1,now+7200000).overdue.length,0);
 assert.equal(calendarData(f.store,fleet,'2026-10-09',1,now+86400000).rentals[0].id,id);
 assert.equal(availability(f.store.db,fleet,'catamaran',now+7200000,now+10800000,{now:now+7200000}).available,2);
 assert.throws(()=>extendRental(f.store,fleet,{id,revision:0,minutes:30},owner,now),/Отплыли/);
 assert.throws(()=>f.store.returned(id,owner,now,0),/ещё не отмечено/);
});
test('Departure shifts the purchased hour by thirty minutes and preserves precise seconds and payment day',t=>{
 const f=fixture(t),id=f.create(),at=now+1800000+37000;
 const before=[...f.store.db.prepare('SELECT * FROM payments').all()];
 const result=departRental(f.store,fleet,{id,revision:0},owner,at);
 assert.equal(result.departedAt,at);assert.equal(result.expectedReturn,at+3600000);
 assert.equal(f.row(id).departed,'2026-10-08T12:30');assert.equal(f.row(id).departure_pending,0);
 assert.equal(f.store.dashboard(day,owner).active[0].id,id);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM payments').all(),before);
 assert.deepEqual(departRental(f.store,fleet,{id,revision:0},owner,at+60000),result);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM rental_changes WHERE reason='Отплытие'").get().n,1);
});
test('Existing equipment and catamaran rows keep the old started behavior after schema initialization',t=>{
 const f=fixture(t),sup=f.create({equipment:'sup'}),legacy=f.create();
 f.store.db.prepare('UPDATE rentals SET departure_pending=0 WHERE id IN (?,?)').run(legacy,sup);
 const before=f.row(legacy);initializeDepartures(f.store.db);
 assert.deepEqual(f.row(legacy),before);
 assert.equal(f.row(sup).departure_pending,0);
 assert.equal(f.store.dashboard(day,owner).active.length,2);
 assert.throws(()=>departRental(f.store,fleet,{id:sup,revision:0},owner,now),/уже началась/);
 assert.throws(()=>departRental(f.store,fleet,{id:legacy,revision:0},owner,now),/уже началась/);
});
test('An unpaid or unresolved terminal transaction cannot depart',t=>{
 const f=fixture(t);f.store.rentalTerminal={enabled:true,locked:()=>false,list:()=>[]};
 const id=f.create();assert.equal(f.row(id).initial_due,100000);
 assert.throws(()=>departRental(f.store,fleet,{id,revision:0},owner,now),/оплату/);
 f.store.db.prepare('UPDATE rentals SET initial_due=0 WHERE id=?').run(id);
 f.store.rentalTerminal.locked=()=>true;
 assert.throws(()=>departRental(f.store,fleet,{id,revision:0},owner,now),/оплату/);
 assert.equal(f.row(id).departure_pending,1);
});
test('Cash terminal accounting pays once without starting a catamaran or requiring departure to repeat payment',async t=>{
 const f=fixture(t),connection={read:()=>({apiKey:'test-only',deviceId:1}),request:()=>{throw Error('No real terminal request allowed');}};
 const terminal=new AqsiRental(f.store,connection,{enabled:true});f.store.rentalTerminal=terminal;
 const id=f.create();
 await terminal.begin({id,phase:'issue',revision:0,cash:true},owner);
 assert.equal(f.row(id).initial_due,0);assert.equal(f.row(id).departure_pending,1);
 await terminal.begin({id,phase:'issue',revision:0,cash:true},owner);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM payments').get().n,1);
 departRental(f.store,fleet,{id,revision:f.row(id).revision},owner,now+1800000);
 assert.equal(f.row(id).departure_pending,0);
});
test('Delayed departure cannot collide with a following confirmed booking and rejection is atomic',t=>{
 const f=fixture(t);
 const inquiry=f.store.receive(randomUUID(),{name:'Future',phone:'+79001111111',equipment:'catamaran',plan:'hour',quantity:3,duration:1,date:day,time:'14:00'},now);
 f.store.inquiryStatus({id:inquiry,revision:0,status:'confirmed'},owner,now);
 const id=f.create(),before=f.row(id);
 assert.throws(()=>departRental(f.store,fleet,{id,revision:0},owner,now+5400000),/Недостаточно техники/);
 assert.deepEqual(f.row(id),before);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM rental_changes').get().n,0);
});
test('Waiting units cannot be sold again; stale and unauthorized departure leave the timer untouched',t=>{
 const f=fixture(t),id=f.create({quantity:3});
 assert.throws(()=>f.create(),/Недостаточно/);
 assert.throws(()=>departRental(f.store,fleet,{id,revision:1},owner,now),/изменилась/);
 assert.throws(()=>departRental(f.store,fleet,{id,revision:0},{id:2,role:'waiter'},now),/Недоступно/);
 assert.equal(f.row(id).departure_pending,1);
});
test('Full refund closes an unstarted catamaran and releases its reservation; partial refund does not',t=>{
 const f=fixture(t),id=f.create();
 const refund=amount=>f.store.refunds.create({requestId:randomUUID(),kind:'rental',id,amountCents:amount,method:'cash',reason:'Test cancellation'},owner,now+60000);
 refund(20000);assert.equal(f.row(id).returned,null);
 refund(80000);assert.equal(f.row(id).returned,now+60000);
 assert.equal(f.store.dashboard(day,owner).waitingDepartures.length,0);
 assert.equal(f.store.dashboard(day,owner).fleet.find(r=>r.id==='catamaran').available,3);
 assert.throws(()=>departRental(f.store,fleet,{id,revision:f.row(id).revision},owner,now+120000),/возвращён/);
});
test('Visit export counts actual departure while customer spend remains recorded at payment',t=>{
 const f=fixture(t),id=f.create();
 let client=clientRows(f.store).find(r=>r[1]==='+79000000000');
 assert.equal(client[3],1000);assert.equal(client[2],0);
 departRental(f.store,fleet,{id,revision:0},owner,now+1800000);
 client=clientRows(f.store).find(r=>r[1]==='+79000000000');
 assert.equal(client[2],1);assert.equal(client[3],1000);
});
test('Restart and two database connections preserve waiting state and start exactly once',t=>{
 const directory=mkdtempSync(join(tmpdir(),'start-departure-')),file=join(directory,'test.sqlite');
 const f=fixture(t,file),id=f.create(),other=new AdminStore(file);t.after(()=>other.close());
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 assert.equal(other.dashboard(day,owner).waitingDepartures[0].id,id);
 const one=departRental(f.store,fleet,{id,revision:0},owner,now+1800000);
 assert.deepEqual(departRental(other,fleet,{id,revision:0},owner,now+1805000),one);
 assert.equal(other.db.prepare("SELECT count(*) n FROM rental_changes WHERE reason='Отплытие'").get().n,1);
});
test('Every fleet type waits for explicit departure, including Big SUP groups, without a second payment',t=>{
 const f=fixture(t);
 for(const [equipment] of fleet){
  const id=f.create({equipment,people:3});
  assert.equal(f.row(id).departure_pending,1,equipment);
  assert.equal(f.store.dashboard(day,owner).active.some(r=>r.id===id),false,equipment);
  const payments=f.store.db.prepare('SELECT count(*) n FROM payments').get().n;
  departRental(f.store,fleet,{id,revision:0},owner,now+1800000);
  assert.equal(f.row(id).departed_at,now+1800000,equipment);
  assert.equal(f.row(id).expected_return,now+5400000,equipment);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM payments').get().n,payments);
 }
});
test('A day booking retains its fixed closing deadline when departure is delayed',t=>{
 const f=fixture(t),inquiry=f.store.receive(randomUUID(),{equipment:'sup',quantity:1,plan:'day',date:day,time:'12:00',name:'Test',phone:'+79000000000'},now);
 f.store.inquiryStatus({id:inquiry,revision:0,status:'confirmed'},owner,now);
 const id=f.create({equipment:'sup',inquiryId:inquiry,expectedReturn:'2026-10-08T22:00'});
 departRental(f.store,fleet,{id,revision:0},owner,now+1800000);
 assert.equal(f.row(id).expected_return,Date.parse('2026-10-08T22:00:00+03:00'));
});
