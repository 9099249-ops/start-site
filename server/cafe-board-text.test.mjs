import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {AdminStore} from './admin.mjs';
import {SmsStore} from './sms.mjs';
import {CafeStore,cafeHandler} from './cafe.mjs';
import {CafeBoard,cafeBoardHandler} from './cafe-board.mjs';
import texts from '../dist/cafe-board-text.js';

const owner={id:1,role:'admin'},employee={id:2,role:'staff'};
function fixture(){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");
 const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{},request:async()=>{throw Error('No external requests');}});
 return {admin,cafe,board:new CafeBoard(cafe,{})};
}

test('board texts default without writing or migrating old catalogs',()=>{
 const f=fixture();try{
  const before=f.admin.db.prepare('SELECT body,revision FROM cafe_catalog').get();
  assert.deepEqual(f.cafe.catalog().settings.boardText,texts.resolve());
  assert.deepEqual(f.board.snapshot().boardText,texts.resolve());
  assert.deepEqual(f.admin.db.prepare('SELECT body,revision FROM cafe_catalog').get(),before);
 }finally{f.admin.close();}
});

test('board edits persist, audit, retain unrelated settings and reject stale or unauthorized saves',()=>{
 const f=fixture();try{
  const original=f.cafe.catalog(),draft=structuredClone(original);
  draft.settings.boardText.brandName='КАФЕ СТАРТ';draft.settings.boardText.tagline='';
  const saved=f.cafe.saveCatalog(draft,owner);
  assert.equal(saved.settings.boardText.brandName,'КАФЕ СТАРТ');
  assert.equal(saved.settings.boardText.tagline,'');
  assert.deepEqual(saved.items,original.items.map(item=>({...item,blockQuickSale:item.blockQuickSale===true})));
  for(const key of ['enabled','open','close','prepMinutes','payments','fulfillments'])assert.deepEqual(saved.settings[key],original.settings[key]);
  assert.equal(saved.revision,original.revision+1);
  assert.throws(()=>f.cafe.saveCatalog(draft,owner),/изменено/);
  assert.throws(()=>f.cafe.saveCatalog(saved,employee),/администратору/);
  const legacy=f.cafe.catalog();delete legacy.settings.boardText;
  assert.equal(f.cafe.saveCatalog(legacy,owner).settings.boardText.brandName,'КАФЕ СТАРТ');
  const partial=f.cafe.catalog();partial.settings.boardText={readyTitle:'МОЖНО ЗАБИРАТЬ'};
  const next=f.cafe.saveCatalog(partial,owner);
  assert.equal(next.settings.boardText.brandName,'КАФЕ СТАРТ');
  assert.equal(next.settings.boardText.readyTitle,'МОЖНО ЗАБИРАТЬ');
 }finally{f.admin.close();}
});

test('board text validation rejects invalid types, unknown fields, limits, controls and empty required labels atomically',()=>{
 const f=fixture();try{
  const before=f.admin.db.prepare('SELECT body,revision FROM cafe_catalog').get();
  for(const boardText of [null,[],1,{brandName:''},{brandName:'x'.repeat(25)},{tagline:'line\nline'},{tagline:12},{privateToken:'secret'},{brandName:'\u007f'}]){
   const draft=f.cafe.catalog();draft.settings.boardText=boardText;
   assert.throws(()=>f.cafe.saveCatalog(draft,owner));
   assert.deepEqual(f.admin.db.prepare('SELECT body,revision FROM cafe_catalog').get(),before);
  }
 }finally{f.admin.close();}
});

test('public board projects only approved text keys even from legacy unvalidated storage',()=>{
 const f=fixture();try{
  const draft=f.cafe.catalog();draft.settings.boardText.brandName='<img src=x>';
  const saved=f.cafe.saveCatalog(draft,owner);
  saved.settings.secret='PRIVATE_SETTING';saved.settings.boardText.privateToken='PRIVATE_TOKEN';
  f.admin.db.prepare('UPDATE cafe_catalog SET body=? WHERE id=1').run(JSON.stringify(saved));
  const result=f.board.snapshot();
  assert.equal(result.boardText.brandName,'<img src=x>');
  assert.deepEqual(Object.keys(result.boardText),texts.fields.map(f=>f.key));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret|privateToken/);
 }finally{f.admin.close();}
});

test('board HTTP remains read-only; text edits use existing authenticated origin-checked admin contract',async()=>{
 const f=fixture();let origin;
 const admin={user:cookie=>cookie==='owner'?owner:cookie==='staff'?employee:null};
 const boardHandler=cafeBoardHandler(f.board);
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,origin);
  if(await boardHandler(req,res,url))return;
  if(await cafeHandler(f.cafe,admin,origin)(req,res,url))return;
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const draft=f.cafe.catalog();draft.settings.boardText.readyTitle='ЗАКАЗ ГОТОВ';
 const save=(cookie,source=origin)=>fetch(origin+'/api/admin/cafe/menu',{method:'POST',headers:{'Content-Type':'application/json',Origin:source,...(cookie?{Cookie:'__Host-start_session='+cookie}:{})},body:JSON.stringify(draft)});
 try{
  assert.equal((await save()).status,401);
  assert.equal((await save('staff')).status,403);
  assert.equal((await save('owner','https://wrong.example')).status,403);
  assert.equal((await save('owner')).status,200);
  assert.equal((await save('owner')).status,409);
  const snapshot=await (await fetch(origin+'/api/cafe/board')).json();
  assert.equal(snapshot.boardText.readyTitle,'ЗАКАЗ ГОТОВ');
  for(const method of ['POST','PUT','DELETE'])assert.equal((await fetch(origin+'/api/cafe/board',{method})).status,405);
 }finally{await new Promise(r=>server.close(r));f.admin.close();}
});
