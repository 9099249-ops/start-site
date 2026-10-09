import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {BatteryStateStore,batteryStateHandler} from './battery-state.mjs';
import {BatteryControlStore,batteryControlHandler} from './battery-control.mjs';

const BMS='41:18:12:01:37:50';
function fixture(t,{firmware=true,secureOrigin=true}={}){
 const admin=new AdminStore(':memory:');
 admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused'),(3,'schedule','staff','unused')");
 const users={admin:{id:1,role:'admin'},staff:{id:2,role:'staff'},schedule:{id:3,role:'staff',scheduleOnly:true}};
 admin.user=token=>users[token]||null;
 const battery=new BatteryStateStore(admin),key=randomBytes(32);
 let firmwareDir=null;
 if(firmware){firmwareDir=mkdtempSync(join(tmpdir(),'battery-release-'));t.after(()=>rmSync(firmwareDir,{recursive:true,force:true}));
  const image=randomBytes(2048),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),manifest={release:'gateway-1.1.0',version:'1.1.0',chip:'ESP32',size:image.length,sha256:createHash('sha256').update(image).digest('hex'),signature:sign('sha256',image,pair.privateKey).toString('base64')};
  writeFileSync(join(firmwareDir,'application.bin'),image);writeFileSync(join(firmwareDir,'recovery.bin'),randomBytes(2048));writeFileSync(join(firmwareDir,'Восстановление-ESP32.txt'),'fixture');writeFileSync(join(firmwareDir,'public-key.pem'),pair.publicKey.export({type:'spki',format:'pem'}));writeFileSync(join(firmwareDir,'manifest.json'),JSON.stringify(manifest));
 }
 const control=new BatteryControlStore(battery,{key,firmwareDir,secureOrigin});battery.control=control;t.after(()=>admin.close());
 const create=(overrides={})=>battery.manage({action:'create',requestId:randomUUID(),name:'Test battery',catamaranLabel:'Сашин',bmsId:BMS,...overrides},users.admin);
 return {admin,battery,control,key,users,create,firmwareDir};
}
function serverFor(t,f){const origin='https://station.test';const batteryHandler=batteryStateHandler(f.battery,f.admin,origin),controlHandler=batteryControlHandler(f.control,f.battery,f.admin,origin);const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://127.0.0.1');if(await controlHandler(req,res,url)||await batteryHandler(req,res,url))return;res.writeHead(404);res.end();});return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{t.after(()=>new Promise(r=>server.close(r)));resolve({origin,request:(path,options={})=>fetch('http://127.0.0.1:'+server.address().port+path,options)});}));}
const adminHeaders=net=>({Cookie:'__Host-start_session=admin',Origin:net.origin,'Content-Type':'application/json'});
function heartbeat(deviceId,bmsId=BMS,extra={}){return {deviceId,bootId:'deadbeef',sequence:0,measurementAgeMs:0,bmsId,bmsConnected:false,telemetry:null,controlCapabilityVersion:1,wifiSsid:'Test WiFi',bmsLastSeenAgeMs:null,commandAck:null,...extra};}
function command(f,device,action,extra={}){return {action,deviceId:device.deviceId,requestId:randomUUID(),revision:device.revision,...extra};}

test('admin session controls commands; HTTP writes require origin and JSON',async t=>{
 const f=fixture(t),net=await serverFor(t,f),made=f.create();
 const get=(path,cookie)=>net.request(path,{headers:cookie?{Cookie:`__Host-start_session=${cookie}`}:{}});
 assert.equal((await get('/api/admin/battery-state/commands?deviceId='+made.device.deviceId)).status,401);
 const wifi=command(f,made.device,'wifi-config',{ssid:'Test WiFi',password:'correct horse'});
 f.battery.ingest(heartbeat(made.device.deviceId),made.token,500);
 const machineReply=await net.request('/api/devices/battery-telemetry',{method:'POST',headers:{Authorization:'Bearer '+made.token,'Content-Type':'application/json'},body:JSON.stringify(heartbeat(made.device.deviceId))});
 const machineText=await machineReply.text();assert.equal(machineReply.status,200);assert.equal(Number(machineReply.headers.get('content-length')),Buffer.byteLength(machineText));assert.equal(machineReply.headers.get('transfer-encoding'),null);
 const post=(body,headers={})=>net.request('/api/admin/battery-state/commands',{method:'POST',headers:{...adminHeaders(net),...headers},body:JSON.stringify(body)});
 assert.equal((await post(wifi,{Cookie:'__Host-start_session=staff'})).status,403);
 assert.equal((await post(wifi,{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await post(wifi,{Origin:'http://station.test'})).status,403);
 assert.equal((await net.request('/api/admin/battery-state/commands',{method:'POST',headers:{...adminHeaders(net),'Content-Type':'text/plain'},body:JSON.stringify(wifi)})).status,403);
 const accepted=await post(wifi);assert.equal(accepted.status,200);assert.equal((await accepted.json()).command.status,'queued');
 const listed=await (await get('/api/admin/battery-state/commands?deviceId='+made.device.deviceId,'admin')).text();assert.equal(listed.includes('correct horse'),false);
 const row=f.admin.db.prepare('SELECT id,device_id,kind,encrypted_payload FROM battery_commands').get();assert.ok(row);const stored=row.encrypted_payload;assert.equal(stored.includes('correct horse'),false);assert.equal(f.control.decode(stored,row.device_id+'\0'+row.id+'\0'+row.kind).password,'correct horse');
});

test('insecure configured origin neither accepts controls nor delivers a queued command',t=>{
 const f=fixture(t),made=f.create(),dev=made.device,id=dev.deviceId;
 f.battery.ingest(heartbeat(id),made.token,500);
 assert.throws(()=>f.control.manage(command(f,dev,'wifi-config',{ssid:'Boat WiFi',password:'secret-pass'}),f.users.admin,'http://station.test',1000),{status:403});
 const queued=f.control.manage(command(f,dev,'wifi-config',{ssid:'Boat WiFi',password:'secret-pass'}),f.users.admin,'https://station.test',1100).command;
 f.control.secureOrigin=false;
 const response=f.battery.ingest(heartbeat(id),made.token,1200);assert.equal(response.command,null);
 assert.equal(f.admin.db.prepare('SELECT status FROM battery_commands WHERE id=?').get(queued.id).status,'queued');
});

test('device commands are encrypted, scoped, retry-safe and acknowledged only for its delivered command',t=>{
 const f=fixture(t),made=f.create(),dev=made.device,id=dev.deviceId,body=command(f,dev,'wifi-config',{ssid:'Boat WiFi',password:'credential-secret'});
 f.battery.ingest(heartbeat(id),made.token,500);
 const first=f.control.manage(body,f.users.admin,'https://station.test',1000),retry=f.control.manage(body,f.users.admin,'https://station.test',2000);
 assert.equal(retry.duplicate,true);assert.equal(retry.command.id,first.command.id);assert.equal(JSON.stringify(first).includes('credential-secret'),false);
 assert.throws(()=>f.control.manage({...body,password:'changed'},f.users.admin,'https://station.test',3000),{status:409});
 assert.throws(()=>f.control.manage({...command(f,dev,'cancel',{commandId:first.command.id}),revision:dev.revision},f.users.staff,'https://station.test'),{status:403});
 const delivered=f.battery.ingest(heartbeat(id),made.token,4000);assert.equal(delivered.command.kind,'wifi-config');assert.equal(delivered.command.payload.password,'credential-secret');
 const other=f.create({name:'Other',bmsId:'41:18:12:01:37:51'});
 f.battery.ingest(heartbeat(other.device.deviceId,other.device.bmsId,{commandAck:{id:first.command.id,status:'applied',code:'WIFI_SET'}}),other.token,5000);
 assert.equal(f.admin.db.prepare('SELECT status FROM battery_commands WHERE id=?').get(first.command.id).status,'delivered');
 f.battery.ingest(heartbeat(id, BMS,{commandAck:{id:first.command.id,status:'applied',code:'WIFI_SET'}}),made.token,6000);
 assert.equal(f.admin.db.prepare('SELECT status FROM battery_commands WHERE id=?').get(first.command.id).status,'applied');
 assert.equal(f.admin.db.prepare('SELECT encrypted_payload FROM battery_commands WHERE id=?').get(first.command.id).encrypted_payload,'');
});

test('cancel, expiry, stale revision, capability and disabled-device gates are enforced',t=>{
 const f=fixture(t),made=f.create(),dev=made.device;
 assert.throws(()=>f.control.manage(command(f,dev,'wifi-config',{ssid:'x',password:'12345678'}),f.users.admin,'https://station.test',1000),{status:409});
 f.battery.ingest(heartbeat(dev.deviceId),made.token,1000);
 const stale={...command(f,dev,'wifi-config',{ssid:'Boat',password:'12345678'}),revision:dev.revision+1};assert.throws(()=>f.control.manage(stale,f.users.admin,'https://station.test',1100),{status:409});
 const queued=f.control.manage(command(f,dev,'wifi-config',{ssid:'Boat',password:'12345678'}),f.users.admin,'https://station.test',2000).command;
 const cancel=f.control.manage({action:'cancel',deviceId:dev.deviceId,requestId:randomUUID(),revision:dev.revision,commandId:queued.id},f.users.admin,'https://station.test',3000);assert.equal(cancel.command.status,'cancelled');
 const expired=f.control.manage(command(f,dev,'wifi-config',{ssid:'Boat',password:'12345678'}),f.users.admin,'https://station.test',4000).command;
 f.control.expire(4000+15*60000+1);assert.equal(f.admin.db.prepare('SELECT status FROM battery_commands WHERE id=?').get(expired.id).status,'expired');
 f.battery.manage({action:'update',requestId:randomUUID(),deviceId:dev.deviceId,revision:dev.revision,enabled:false},f.users.admin,500000);
 assert.throws(()=>f.battery.ingest(heartbeat(dev.deviceId),made.token,500001),{status:401});
});

test('signed OTA manifest is validated and binary download requires enabled device bearer, release and fixed artifact path',async t=>{
 const f=fixture(t),net=await serverFor(t,f),made=f.create(),release=f.control.release();assert.equal(release.version,'1.1.0');
 f.battery.ingest(heartbeat(made.device.deviceId),made.token,500);
 const cmd=f.control.manage(command(f,made.device,'firmware-update',{release:release.release}),f.users.admin,net.origin,1000).command;
 const ack=f.battery.ingest(heartbeat(made.device.deviceId),made.token,2000);assert.equal(ack.command.payload.url,net.origin+'/api/devices/battery-firmware?deviceId='+encodeURIComponent(made.device.deviceId)+'&release=gateway-1.1.0');
 const get=(url,token)=>net.request(url,{headers:token?{Authorization:'Bearer '+token}:{}});
 assert.equal((await get(`/api/devices/battery-firmware?deviceId=${made.device.deviceId}&release=gateway-1.1.0`)).status,401);
 assert.equal((await get(`/api/devices/battery-firmware?deviceId=${made.device.deviceId}&release=gateway-1.1.0`,made.token)).status,200);
 assert.equal((await get(`/api/devices/battery-firmware?deviceId=${made.device.deviceId}&release=other`,made.token)).status,404);
 assert.equal((await get('/api/devices/battery-firmware?deviceId=other-device&release=gateway-1.1.0',made.token)).status,401);
 assert.equal((await get(`/api/admin/battery-firmware?part=application`,null)).status,401);
 const adminFile=await net.request('/api/admin/battery-firmware?part=application',{headers:{Cookie:'__Host-start_session=admin'}});assert.equal(adminFile.status,200);assert.equal(Number(adminFile.headers.get('content-length')),readFileSync(join(f.firmwareDir,'application.bin')).length);
 assert.equal((await net.request('/api/admin/battery-firmware?part=../../server.mjs',{headers:{Cookie:'__Host-start_session=admin'}})).status,404);
 f.battery.manage({action:'update',requestId:randomUUID(),deviceId:made.device.deviceId,revision:made.device.revision,enabled:false},f.users.admin,3000);
 assert.equal((await get(`/api/devices/battery-firmware?deviceId=${made.device.deviceId}&release=gateway-1.1.0`,made.token)).status,401);
 assert.equal(cmd.kind,'firmware-update');
});

test('firmware fixture tampering fails closed',t=>{
 const f=fixture(t);writeFileSync(join(f.firmwareDir,'application.bin'),randomBytes(2048));assert.throws(()=>f.control.release(),/signature mismatch/i);
});
