import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {AdminStore} from '../admin.mjs';
import {BatteryStateStore} from '../battery-state.mjs';
import {BatteryTripStore} from '../battery-trips.mjs';

const port=Number(process.env.RENTAL_DEMO_PORT||14975),origin='http://localhost:'+port;
const sensorDemo=process.env.RENTAL_DEMO_DEPARTURE==='1';
Object.assign(process.env,{PORT:String(port),SITE_ORIGIN:origin,BOOKING_DB:join(mkdtempSync(join(tmpdir(),'start-rental-mockup-')),'demo.sqlite'),SMS_ENABLED:'false',SMSAERO_EMAIL:'',SMSAERO_API_KEY:'',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',AQSI_CAFE_ENABLED:'0',AQSI_RENTAL_ENABLED:'0',PRINT_ENABLED:'false',UX_AUDIT_ENABLED:'0'});
globalThis.fetch=async()=>{throw Error('External services are blocked in this isolated demo');};
const admin=new AdminStore(process.env.BOOKING_DB),password=randomBytes(20).toString('base64url');
admin.setupToken('demo');admin.setup({token:'demo',adminPassword:password,staffPassword:randomBytes(20).toString('base64url')},'demo');
const session=admin.login({login:'admin',password},'demo'),owner=admin.user(session),now=Date.now(),day=new Date(now+10800000).toISOString().slice(0,10);
admin.db.prepare("INSERT INTO employee_profiles(user_id,display_name) VALUES(2,'Илья') ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name").run();
admin.db.prepare('INSERT INTO employee_work_sessions(user_id,started_at) VALUES(2,?)').run(now-3*3600000);
const entries=[['catamaran','Анна',90,true],['sup','Михаил',60,true],['catamaran','Иван',42,false],['sup','Ольга',72,false],['sup','Дмитрий',18,false],['kayak','Мария',55,false],['sup','Алексей',-8,false],['kayak','Елена',26,false]];
for(const [equipment,name,minutes,pending] of entries){
 const started=now-3600000,departed=new Date((pending?now:started)+10800000).toISOString().slice(0,16),price=equipment==='catamaran'?150000:equipment==='kayak'?90000:70000;
 const id=Number(admin.db.prepare('INSERT INTO rentals(request_id,equipment,quantity,name,phone,departed,created,created_by,expected_return,departure_pending,departed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),equipment,1,name,'+79990000000',departed,now,owner.id,now+minutes*60000,pending?1:0,pending?null:started).lastInsertRowid);
 admin.db.prepare('INSERT INTO payments(rental_id,amount,method,day,created,user_id,note) VALUES(?,?,?,?,?,?,?)').run(id,price,'cash',day,now,owner.id,'Synthetic demo payment');
}
const battery=new BatteryStateStore(admin),trips=new BatteryTripStore(battery);
const devices=[];
for(const [i,label] of ['Сашин','Сашин','Наташин','Наташин','С серой крышей'].entries())devices.push(battery.manage({action:'create',requestId:randomUUID(),name:'Аккумулятор '+(i+1),catamaranLabel:label,bmsId:'02:00:00:00:00:0'+(i+1),capacityAh:100},owner));
let sequence=0;
if(sensorDemo){admin.db.prepare('UPDATE rentals SET created=? WHERE id=1').run(now-300000);trips.assignPending(1,'Сашин',owner,now-240000);for(const made of devices.slice(0,2))battery.ingest({deviceId:made.device.deviceId,bmsId:made.device.bmsId,bootId:'1234abcd',sequence:0,measurementAgeMs:0,bmsConnected:true,telemetry:null},made.token,now-181000);}
function telemetry(){sequence++;for(const [i,made] of devices.entries()){const soc=[85,82,42,39,12][i],charging=i===4,absent=sensorDemo&&i<2;battery.ingest({deviceId:made.device.deviceId,bmsId:made.device.bmsId,bootId:'1234abcd',sequence,measurementAgeMs:0,bmsConnected:!absent,...(absent?{bmsDisconnectedAgeMs:Date.now()-(now-180000)}:{}),telemetry:absent?null:{socPercent:soc,voltageV:13.3,currentA:charging?20:-20,remainingCapacityAh:soc,state:charging?'charging':'discharging',fieldAgesMs:{status:0},temperaturesC:[22]}},made.token);}}
telemetry();const tick=setInterval(telemetry,15000);tick.unref();
const create=http.createServer.bind(http);
http.createServer=(listener)=>create((req,res)=>{
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){res.writeHead(403);res.end();return;}
 if(req.url==='/testing-login'){res.writeHead(302,{Location:'/admin/','Cache-Control':'no-store'});res.end();return;}
 // This loopback-only server always uses its synthetic demo session.
 req.headers.cookie='__Host-start_session='+session;
 listener(req,res);
});
console.log('Isolated rental demo: '+origin+'/testing-login');
await import('../server.mjs');
