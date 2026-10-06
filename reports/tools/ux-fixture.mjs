import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AdminStore} from '../../server/admin.mjs';
import {CafeStore} from '../../server/cafe.mjs';
import {SmsStore} from '../../server/sms.mjs';
import {fillTestCafeStock} from '../../server/testing/cafe-stock-fixture.mjs';
import {randomUUID} from 'node:crypto';
import {startUxAudit} from '../../server/ux-audit.mjs';

const folder=mkdtempSync(path.join(tmpdir(),'start-ux-audit-'));
const port=process.env.UX_AUDIT_PORT||'14941';
Object.assign(process.env,{PORT:port,SITE_ORIGIN:`http://127.0.0.1:${port}`,BOOKING_DB:path.join(folder,'audit.sqlite'),SMS_ENABLED:'false',AQSI_CAFE_ENABLED:'0',AQSI_RENTAL_ENABLED:'0',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',CASH_LEDGER_ENABLED:'0',START_WORKSPACE_SHELL:'1'});
process.env.UX_AUDIT_ENABLED=process.env.UX_AUDIT_FIXTURE_TELEMETRY==='1'?'1':'0';
if(process.env.UX_AUDIT_ENABLED==='1'){process.env.UX_AUDIT_DIR=path.join(folder,'ux');await startUxAudit(process.env.UX_AUDIT_DIR);}
globalThis.fetch=async()=>{throw Error('UX fixture: external integrations disabled');};
const admin=new AdminStore(process.env.BOOKING_DB);
admin.setupToken('ux-fixture');
admin.setup({token:'ux-fixture',adminPassword:'audit-admin-123456',staffPassword:'audit-staff-123456'},'ux-fixture');
const owner={id:1,role:'admin'};
const cafe=new CafeStore(admin,new SmsStore(admin,null,{}),{env:{}});
fillTestCafeStock(cafe);
const loaded=process.env.UX_AUDIT_LOAD==='1';
const names=['Сырники','Американо','Капучино','Латте','Картошка фри','4 сыра'];
const now=Date.now(),stamp=t=>new Date(t+10800000).toISOString().slice(0,16);
for(let i=0;i<(loaded?10:3);i++){
 const item=cafe.catalog().items.find(x=>x.name===names[i%names.length]);
 const quantity=1+i%3;
 const order=cafe.create({requestId:randomUUID(),name:'Тестовый гость '+(i+1),phone:'',fulfillment:'pickup',payment:'unspecified',comment:i%3===0?'Тест: позвать гостя перед выдачей':'',items:[{itemId:item.id,quantity,optionIds:[],comment:i%2?'Без сахара':''}],expectedTotalCents:item.priceCents*quantity},owner,now-(i+1)*120000);
 const status=loaded?'COOKING':['NEW','COOKING','READY'][i];
 if(status!=='NEW')cafe.status({id:order.id,revision:order.revision,status},owner);
}
if(loaded)for(let i=0;i<40;i++){
 const due=now+(i<8?-(8-i)*300000:i<16?(i-7)*60000:(i-13)*300000);
 admin.create({requestId:randomUUID(),equipment:i<36?'sup':['electric','kayak2','rowing','bike'][i-36],quantity:i===35?2:1,name:'Тестовый гость '+String(i+1).padStart(2,'0'),phone:'+7900123'+String(1000+i),departed:stamp(now-3600000),expectedReturn:stamp(due),amount:i===35?'2000':'1000',method:i%2?'cash':'card'},owner,now);
}
admin.close();
console.log(JSON.stringify({fixture:true,origin:process.env.SITE_ORIGIN,database:process.env.BOOKING_DB,integrations:false,orders:loaded?10:3,rentals:loaded?40:0}));
await import('../../server/server.mjs');
