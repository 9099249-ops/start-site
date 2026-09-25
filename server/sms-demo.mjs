// Isolated manual test environment. All outbound requests are mocked.
// Run: node server/sms-demo.mjs ; open http://127.0.0.1:14876/admin/
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AdminStore} from './admin.mjs';
import {SmsStore} from './sms.mjs';
const folder=mkdtempSync(path.join(tmpdir(),'start-sms-demo-'));
Object.assign(process.env,{PORT:'14876',SITE_ORIGIN:'http://127.0.0.1:14876',BOOKING_DB:path.join(folder,'demo.sqlite'),SMS_ENABLED:'true',SMSAERO_EMAIL:'demo@example.invalid',SMSAERO_API_KEY:'demo-not-real',TELEGRAM_BOT_TOKEN:'demo-not-real',TELEGRAM_CHAT_ID:'1'});
let id=100;globalThis.fetch=async url=>({ok:true,status:200,json:async()=>String(url).includes('sms/status')?{success:true,data:{status:1}}:String(url).includes('sms/send')?{success:true,data:{id:++id,status:0}}:{ok:true,result:{message_id:1}}});
const admin=new AdminStore(process.env.BOOKING_DB);admin.setupToken('demo');admin.setup({token:'demo',adminPassword:'demo-admin-123456',staffPassword:'demo-staff-123456'},'demo');const sms=new SmsStore(admin);sms.save({...sms.settings(),enabled:true},{id:1,role:'admin'});admin.close();
console.log('DEMO ONLY: outbound SMS and Telegram mocked. Login admin / demo-admin-123456. Database:',folder);
await import('./server.mjs');
