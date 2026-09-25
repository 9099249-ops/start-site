import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {AdminStore} from './admin.mjs';
test('HTTP SMS: access, owner settings, promo consent/dedup, unified client, CSRF and invalid body',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'start-sms-http-')),db=join(dir,'db'),mock=join(dir,'mock.mjs');
 writeFileSync(mock,"globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({success:true,data:{id:999,status:1}})});");
 const store=new AdminStore(db);store.setupToken('test');store.setup({token:'test',adminPassword:'admin-test-only-123',staffPassword:'staff-test-only-456'},'test');
 const port=14877,origin='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['--import',pathToFileURL(mock).href,'server/server.mjs'],{env:{...process.env,PORT:String(port),SITE_ORIGIN:origin,BOOKING_DB:db,SMSAERO_EMAIL:'fake',SMSAERO_API_KEY:'fake',SMS_ENABLED:'true'},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('exit',()=>{clearTimeout(timer);reject(Error('server exited'));});});
  const request=(path,b,cookie)=>fetch(origin+path,{method:b?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:b?JSON.stringify(b):undefined});
  assert.equal((await request('/api/admin/sms')).status,401);assert.equal((await request('/api/admin/calendar?date=2026-10-01')).status,401);assert.equal((await request('/api/admin/clients')).status,401);
  let r=await request('/api/admin/login',{login:'admin',password:'admin-test-only-123'}),cookie=r.headers.get('set-cookie').split(';')[0];
  const settings=(await (await request('/api/admin/sms',null,cookie)).json()).settings;
  assert.equal(settings.enabled,false);r=await request('/api/admin/sms-settings',{...settings,enabled:true},cookie);assert.equal(r.status,200);
  const b={name:'Тест',phone:'79030000000',consent:true,marketing:false};
  assert.equal((await request('/api/discount',{...b,consent:false})).status,400);
  assert.equal((await request('/api/discount',b)).status,200);assert.equal((await request('/api/discount',{...b,phone:'8 903 000 00 00'})).status,200);
  assert.equal(store.db.prepare('SELECT count(*) n FROM discounts').get().n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM clients').get().n,1);
  r=await fetch(origin+'/api/discount',{method:'POST',headers:{Origin:'https://evil.invalid','Content-Type':'application/json'},body:JSON.stringify(b)});assert.equal(r.status,403);
  r=await fetch(origin+'/api/discount',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'null'});assert.equal(r.status,400);
  r=await request('/api/admin/login',{login:'station',password:'staff-test-only-456'});const staff=r.headers.get('set-cookie').split(';')[0];assert.equal((await request('/api/admin/sms-settings',{...settings,enabled:true},staff)).status,403);assert.equal((await request('/api/admin/calendar?date=2026-10-01&days=7',null,staff)).status,200);assert.equal((await request('/api/admin/availability?start=2026-10-01T12:00&end=2026-10-01T13:00',null,staff)).status,200);const page=await request('/prokat/sup/');assert.equal(page.status,200);assert.match(await page.text(),/САПборд/);assert.equal((await request('/prokat/foil/')).status,404);
 }finally{if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});store.close();rmSync(dir,{recursive:true,force:true});}
});
