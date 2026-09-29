import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore,fleet,adminHandler} from './admin.mjs';
import {Readable} from 'node:stream';
import {extendRental,undoReturn,deskSearch,nearbyBookings} from './rental-actions.mjs';
import Desk from '../dist/admin/desk-utils.js';
const now=Date.parse('2026-09-25T09:00:00Z'),stamp=t=>new Date(t+10800000).toISOString().slice(0,16);
function fixture(t){const s=new AdminStore(':memory:');s.setupToken('test');s.setup({token:'test',adminPassword:'test-admin-password',staffPassword:'test-staff-password'},'test');const u={id:2,role:'staff'};t.after(()=>s.close());return {s,u,create:(more={})=>s.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Иван Петров',phone:'+7 (916) 123-88-22',departed:stamp(now),expectedReturn:stamp(now+3600000),amount:'1000',method:'cash',...more},u,now)};}

test('Day history includes active, returned and overnight rentals without losing older returns',t=>{
 const {s,u,create}=fixture(t),active=create(),returned=create(),overnight=create();s.returned(returned,u,now+5000);s.db.prepare('UPDATE rentals SET departed=? WHERE id=?').run('2026-09-24T23:50',overnight);
 const today=s.dashboard('2026-09-25',u);assert.deepEqual(new Set(today.dayRentals.map(r=>r.id)),new Set([active,returned,overnight]));assert.equal(today.returned.length,1);assert.deepEqual(s.dashboard('2026-09-24',u).dayRentals.map(r=>r.id),[overnight]);assert.ok(!s.dashboard('2026-09-26',u).dayRentals.some(r=>r.id===returned));
});
test('Desk search normalizes full Russian phones, preserves suffixes starting 7/8, matches case and categories',()=>{
 const r={id:17,name:'Иван Петров',phone:'+7 (916) 123-88-22',equipment:'sup'};
 for(const q of ['8822','+7 (916) 123-88-22','8 916 123 88 22','9161238822','ПЕТРОВ','иван','SUP','17'])assert.equal(Desk.matches(r,q),true,q);
 assert.equal(Desk.phone('7788'),'7788');assert.equal(Desk.phone('8822'),'8822');assert.equal(Desk.matches(r,'Другой'),false);
});
test('One clock filters and sorts 100 rows, sub-minute deadlines, exact boundaries',()=>{
 const rows=Array.from({length:100},(_,i)=>({id:i,name:'Клиент',phone:'7900123'+(4000+i),expected_return:now+(i-10)*60000})).reverse();
 assert.equal(Desk.active(rows,'','all',now,[])[0].id,0);assert.equal(Desk.active(rows,'','overdue',now,[]).length,10);assert.equal(Desk.active(rows,'','soon',now,[]).length,11);assert.equal(Desk.active(rows,'4005','overdue',now,[]).length,1);
 assert.equal(Desk.duration(59999),'<1 мин');assert.equal(Desk.duration(-60000),'1 мин');assert.equal(Desk.duration(4680000),'1 ч 18 мин');
});
test('Quick extension keeps payments and has revision conflict protection and audit',t=>{
 const {s,u,create}=fixture(t),id=create();const other={id:1,role:'admin'};
 const result=extendRental(s,fleet,{id,revision:0,minutes:30},u,now+1000);assert.equal(result.expectedReturn,now+5400000);
 assert.throws(()=>extendRental(s,fleet,{id,revision:0,minutes:30},other,now+1000),/изменена/);
 assert.equal(s.db.prepare('SELECT amount FROM payments WHERE rental_id=?').get(id).amount,100000);
 assert.equal(s.db.prepare('SELECT count(*) n FROM rental_changes').get().n,1);
 assert.throws(()=>extendRental(s,fleet,{id,revision:1,minutes:30},{id:3,role:'waiter'},now),/роли/);
 s.returned(id,u,now+2000);assert.throws(()=>extendRental(s,fleet,{id,revision:2,minutes:30},u,now+3000),/изменена/);
});
test('Extension cannot overlap a confirmed booking; overdue stock remains occupied',t=>{
 const {s,u,create}=fixture(t),id=create({equipment:'boat'});
 const bid=s.receive('reservation',{equipment:'boat',quantity:1,plan:'hour',duration:1,date:'2026-09-25',time:'13:00',name:'Бронь',phone:'+79000000000'},now);
 s.inquiryStatus({id:bid,revision:0,status:'confirmed'},u,now);
 assert.throws(()=>extendRental(s,fleet,{id,revision:0,minutes:30},u,now+1000),/пересекается/);
 assert.equal(s.db.prepare('SELECT revision FROM rentals WHERE id=?').get(id).revision,0);
});
test('Return undo only by original actor within 15 seconds; no double undo, money unchanged',t=>{
 const {s,u,create}=fixture(t),id=create();s.returned(id,u,now+5000);const body={id,revision:1,returnedAt:now+5000};
 assert.throws(()=>undoReturn(s,fleet,body,{id:1,role:'admin'},now+6000),/недоступна/);
 undoReturn(s,fleet,body,u,now+6000);assert.equal(s.db.prepare('SELECT returned FROM rentals WHERE id=?').get(id).returned,null);
 assert.throws(()=>undoReturn(s,fleet,body,u,now+6001),/недоступна/);
 s.returned(id,u,now+7000);assert.throws(()=>undoReturn(s,fleet,{id,revision:3,returnedAt:now+7000},u,now+23000),/недоступна/);
 assert.equal(s.db.prepare('SELECT sum(amount) n FROM payments').get().n,100000);
});
test('Undo refuses when another cashier issued the freed craft',t=>{
 const {s,u,create}=fixture(t),id=create({equipment:'boat'});s.returned(id,u,now+5000);create({equipment:'boat'});
 assert.throws(()=>undoReturn(s,fleet,{id,revision:1,returnedAt:now+5000},u,now+6000),/занята/);
 assert.ok(s.db.prepare('SELECT returned FROM rentals WHERE id=?').get(id).returned);
});
test('Unified server search preserves history data and matches Cyrillic case/phone/booking',t=>{
 const {s,u,create}=fixture(t),id=create();s.receive('r',{equipment:'sup',quantity:1,plan:'hour',duration:1,date:'2026-09-25',time:'13:00',name:'ИВАН Петров',phone:'89161238822'},now);
 for(const q of ['8822','8 (916) 123-88-22','ПЕТРОВ','sup']){const r=deskSearch(s,fleet,q,u);assert.equal(r.rentals[0].id,id);assert.equal(r.bookings.length,1);}
 assert.equal(deskSearch(s,fleet,"%' OR 1=1 --",u).rentals.length,0);assert.throws(()=>deskSearch(s,fleet,'Иван',{role:'waiter'}),/роли/);
});
test('Nearest bookings use visit time rather than newest received IDs',t=>{
 const {s,u}=fixture(t);
 for(let i=0;i<55;i++){const id=s.receive('n'+i,{equipment:'sup',quantity:1,plan:'hour',duration:1,date:'2026-09-25',time:i===0?'13:00':'18:00',name:'Гость',phone:'+79000000000'},now);s.db.prepare("UPDATE inquiries SET status='confirmed' WHERE id=?").run(id);}
 const rows=nearbyBookings(s,now);assert.equal(rows[0].id,1);assert.equal(rows.length,8);
});

test('Desk HTTP handlers require existing session, role and same-origin JSON; return and undo round trip',async t=>{
 const {s,u}=fixture(t),at=Date.now(),origin='https://spotsup.ru',handler=adminHandler(s,origin);
 const token=s.login({login:'station',password:'test-staff-password'},'test-desk');
 s.workforce.action({requestId:randomUUID()},u,'start',at);
 const id=s.create({requestId:randomUUID(),equipment:'sup',quantity:1,name:'Тест',phone:'+79001238822',departed:stamp(at),expectedReturn:stamp(at+3600000),amount:'1000',method:'cash'},u,at);
 const call=async(path,body,session=token,requestOrigin=origin)=>{
  const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);req.method=body?'POST':'GET';req.headers={origin:requestOrigin,'content-type':'application/json',cookie:session?'__Host-start_session='+session:''};req.socket={remoteAddress:'test-desk'};
  let status,result;const res={writeHead:s=>{status=s;},end:text=>{result=JSON.parse(text);}};
  await handler(req,res,new URL('/api/admin/'+path,origin));return {status,result};
 };
 assert.equal((await call('search?q=8822',undefined,'')).status,401);
 assert.equal((await call('extend',{id,revision:0,minutes:30},token,'https://other.test')).status,403);
 assert.equal((await call('extend',{id,revision:0,minutes:30})).status,200);
 assert.equal((await call('extend',{id,revision:0,minutes:30})).status,409);
 assert.equal((await call('search?q=8822')).result.rentals[0].id,id);
 const back=await call('return',{id});assert.equal(back.status,200);assert.equal(back.result.canUndo,false);
 assert.equal((await call('undo-return',{id,revision:back.result.revision,returnedAt:back.result.returnedAt})).status,409);
 assert.equal(s.db.prepare('SELECT returned FROM rentals WHERE id=?').get(id).returned,back.result.returnedAt);
 s.db.prepare("UPDATE admin_users SET role='waiter' WHERE id=?").run(u.id);
 assert.equal((await call('search?q=8822')).status,403);
 assert.equal((await call('extend',{id,revision:3,minutes:60})).status,403);
});
