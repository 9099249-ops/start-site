import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {AdminStore} from './admin.mjs';

test('HTTP inbox accepts saved requests when Telegram fails; authenticated staff can confirm',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'start-inbox-http-')),db=join(dir,'db'),mock=join(dir,'mock.mjs');
 writeFileSync(mock,"globalThis.fetch=async()=>{throw new Error('Simulated Telegram failure');};");
 const store=new AdminStore(db);store.setupToken('test');store.setup({token:'test',adminPassword:'admin-test-only-123',staffPassword:'staff-test-only-456'},'test');
 const port=14873,origin='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['--import',pathToFileURL(mock).href,'server/server.mjs'],{env:{...process.env,PORT:String(port),SITE_ORIGIN:origin,BOOKING_DB:db,TELEGRAM_BOT_TOKEN:'test-only',TELEGRAM_CHAT_ID:'1'},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('exit',()=>{clearTimeout(timer);reject(Error('server exited'));});});
  const request=(path,b,cookie)=>fetch(origin+path,{method:b?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:b?JSON.stringify(b):undefined});
  // Season inquiry is valid throughout the year and does not require an appointment.
  const b={equipment:'sup',plan:'season',quantity:1,name:'HTTP test',phone:'+70000000000'};
  let r=await request('/api/bookings',b);assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
  r=await request('/api/bookings',b);assert.equal((await r.json()).duplicate,true);assert.equal(store.inquiries().rows.length,1);assert.equal(store.inquiries().rows[0].notification,'unknown');
  assert.equal((await request('/api/admin/inquiries')).status,401);
  r=await request('/api/admin/login',{login:'station',password:'staff-test-only-456'});const cookie=r.headers.get('set-cookie').split(';')[0];
  r=await request('/api/admin/inquiries',null,cookie);const row=(await r.json()).rows[0];assert.equal(row.details.name,'HTTP test');
  r=await request('/api/admin/inquiry-status',{id:row.id,revision:0,status:'confirmed'},cookie);assert.equal(r.status,200);
  assert.equal(store.inquiries('confirmed').rows.length,1);
 }finally{if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});store.close();rmSync(dir,{recursive:true,force:true});}
});
