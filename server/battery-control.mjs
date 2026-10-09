import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {randomBytes,randomUUID,createHash,createHmac,createCipheriv,createDecipheriv,verify} from 'node:crypto';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const owner=u=>{if(u?.role!=='admin'||u.scheduleOnly)fail('Недоступно для этой роли.',403);};
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(x);
const terminal=new Set(['applied','failed','rolled-back','cancelled','expired']);
const canonical=x=>JSON.stringify(Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])));

export function batteryControlKey(file){
 if(!file)fail('Управление ESP32 не настроено.',503);
 mkdirSync(dirname(file),{recursive:true,mode:0o700});
 try{writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 const key=readFileSync(file);if(key.length!==32)throw Error('Battery control key has invalid length');return key;
}

export class BatteryControlStore {
 constructor(battery,{key,keyFile,firmwareDir,secureOrigin=true}={}){
  this.battery=battery;this.db=battery.db;this.key=key||batteryControlKey(keyFile);
  if(!Buffer.isBuffer(this.key)||this.key.length!==32)throw Error('Battery control key has invalid length');
  this.firmwareDir=firmwareDir?resolve(firmwareDir):null;
  this.secureOrigin=secureOrigin;
  this.db.exec(readFileSync(new URL('./migrations/battery-control.sql',import.meta.url),'utf8'));
 }
 encode(payload,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(aad));const encrypted=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');}
 decode(value,aad){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));}
 release(){
  if(!this.firmwareDir||!existsSync(join(this.firmwareDir,'manifest.json')))return null;
  const m=JSON.parse(readFileSync(join(this.firmwareDir,'manifest.json'),'utf8'));
  if(typeof m.version!=='string'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(m.version)||m.release!=='gateway-'+m.version||m.chip!=='ESP32'||!Number.isSafeInteger(m.size)||m.size<1024||m.size>1966080||!/^[a-f0-9]{64}$/.test(m.sha256)||typeof m.signature!=='string')throw Error('Invalid firmware manifest');
  const image=readFileSync(join(this.firmwareDir,'application.bin'));
  if(image.length!==m.size||createHash('sha256').update(image).digest('hex')!==m.sha256||!verify('sha256',image,readFileSync(join(this.firmwareDir,'public-key.pem')),Buffer.from(m.signature,'base64')))throw Error('Firmware signature mismatch');
  return {...m,recoveryAvailable:existsSync(join(this.firmwareDir,'recovery.bin'))};
 }
 expire(now){this.db.prepare("UPDATE battery_commands SET status='expired',code='COMMAND_EXPIRED',encrypted_payload='',acknowledged_at=? WHERE expires_at<? AND status IN ('queued','delivered')").run(now,now);}
 safe(row){return {id:row.id,kind:row.kind,status:row.status,code:row.code,ssid:row.ssid,createdAt:row.created_at,expiresAt:row.expires_at,acknowledgedAt:row.acknowledged_at};}
 status(deviceId,user,now=Date.now()){
  owner(user);const device=this.battery.row(deviceId);this.expire(now);const health=JSON.parse(device.health_json);
  const m=this.release();return {deviceId,revision:device.revision,controlCapabilityVersion:health.controlCapabilityVersion??0,wifiSsid:health.wifiSsid??null,commands:this.db.prepare('SELECT * FROM battery_commands WHERE device_id=? ORDER BY created_at DESC LIMIT 20').all(deviceId).map(r=>this.safe(r)),firmware:m?{release:m.release,version:m.version,size:m.size,sha256:m.sha256,recoveryAvailable:m.recoveryAvailable}:null};
 }
 manage(body,user,origin,now=Date.now()){
  owner(user);if(!object(body)||!id(body.deviceId)||!id(body.requestId)||body.requestId.length<16)fail('Неверный запрос управления.');
  if(!['wifi-config','firmware-update','cancel'].includes(body.action))fail('Неизвестная команда.');
  const fingerprint=createHmac('sha256',this.key).update(canonical(body)).digest('hex');
  return this.battery.tx(()=>{
   this.expire(now);const device=this.battery.row(body.deviceId),previous=this.db.prepare('SELECT * FROM battery_control_requests WHERE device_id=? AND request_id=?').get(body.deviceId,body.requestId);
   if(previous){if(previous.fingerprint!==fingerprint||previous.actor_id!==user.id)fail('Ключ запроса уже использован.',409);return {command:this.safe(this.db.prepare('SELECT * FROM battery_commands WHERE id=?').get(previous.command_id)),duplicate:true};}
   if(!Number.isSafeInteger(body.revision)||body.revision!==device.revision)fail('Настройки изменились. Откройте управление ещё раз.',409);
   if(body.action==='cancel'){
    const row=this.db.prepare('SELECT * FROM battery_commands WHERE id=? AND device_id=?').get(body.commandId,body.deviceId);
    if(!row)fail('Команда не найдена.',404);
    if(row.status==='delivered')fail('Команда уже передана ESP32. Дождитесь результата.',409);
    if(row.status==='queued')this.db.prepare("UPDATE battery_commands SET status='cancelled',encrypted_payload='',acknowledged_at=?,code='CANCELLED_BY_ADMIN' WHERE id=?").run(now,row.id);
    this.db.prepare('INSERT INTO battery_control_requests(device_id,request_id,fingerprint,command_id,actor_id,created_at) VALUES(?,?,?,?,?,?)').run(body.deviceId,body.requestId,fingerprint,row.id,user.id,now);
    return {command:this.safe(this.db.prepare('SELECT * FROM battery_commands WHERE id=?').get(row.id))};
   }
   if(!device.enabled)fail('Модуль выключен.',409);
   if(!origin.startsWith('https://')||!this.secureOrigin)fail('Для управления Wi-Fi и прошивкой требуется HTTPS.',403);
   const health=JSON.parse(device.health_json);
   if((health.controlCapabilityVersion??0)<1)fail('Сначала установите прошивку управления ESP32 по USB.',409);
   if(this.db.prepare("SELECT id FROM battery_commands WHERE device_id=? AND status IN ('queued','delivered')").get(body.deviceId))fail('Дождитесь выполнения предыдущей команды.',409);
   let payload,ssid=null;
   if(body.action==='wifi-config'){
    if(typeof body.ssid!=='string'||Buffer.byteLength(body.ssid)>32||!body.ssid.trim()||/[\x00-\x1f\x7f]/.test(body.ssid)||typeof body.password!=='string'||(body.password.length!==0&&(Buffer.byteLength(body.password)<8||Buffer.byteLength(body.password)>63))||/[\x00-\x1f\x7f]/.test(body.password))fail('Укажите имя Wi-Fi до 32 байт и пароль из 8–63 байт (или пустой для открытой сети).');
    ssid=body.ssid;payload={ssid,password:body.password};
   }else{
    const m=this.release();if(!m||body.release!==m.release)fail('Проверенная прошивка недоступна.',409);
    payload={version:m.version,url:origin+'/api/devices/battery-firmware?deviceId='+encodeURIComponent(body.deviceId)+'&release='+encodeURIComponent(m.release),sha256:m.sha256,size:m.size,signature:m.signature};
   }
   const commandId=randomUUID();this.db.prepare('INSERT INTO battery_commands(id,device_id,request_id,fingerprint,kind,encrypted_payload,ssid,created_at,expires_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(commandId,body.deviceId,body.requestId,fingerprint,body.action,this.encode(payload,body.deviceId+'\0'+commandId+'\0'+body.action),ssid,now,now+15*60000,user.id);
   this.db.prepare('INSERT INTO battery_control_requests(device_id,request_id,fingerprint,command_id,actor_id,created_at) VALUES(?,?,?,?,?,?)').run(body.deviceId,body.requestId,fingerprint,commandId,user.id,now);
   this.db.prepare('INSERT INTO battery_device_events(device_id,actor_id,action,created_at) VALUES(?,?,?,?)').run(body.deviceId,user.id,body.action,now);
   return {command:this.safe(this.db.prepare('SELECT * FROM battery_commands WHERE id=?').get(commandId))};
  });
 }
 exchange(deviceId,body,now){
  this.expire(now);let ackAccepted=null;
  if(body.commandAck!=null){
   const ack=body.commandAck;
   if(!object(ack)||typeof ack.id!=='string'||ack.id.length>80||!['applied','failed','rolled-back'].includes(ack.status)||typeof ack.code!=='string'||!/^[A-Z0-9_]{1,60}$/.test(ack.code))fail('Неверный результат команды.');
   const row=this.db.prepare('SELECT * FROM battery_commands WHERE id=? AND device_id=?').get(ack.id,deviceId);
   if(row){
    if(row.status==='delivered')this.db.prepare('UPDATE battery_commands SET status=?,code=?,encrypted_payload=?,acknowledged_at=? WHERE id=?').run(ack.status,ack.code,'',now,row.id);
    else if(!terminal.has(row.status))fail('Команда ещё не была передана.',409);
    ackAccepted=ack.id;
   }
  }
  const row=this.db.prepare("SELECT * FROM battery_commands WHERE device_id=? AND status IN ('queued','delivered') ORDER BY created_at LIMIT 1").get(deviceId);
  if(!row||!this.secureOrigin)return {command:null,ackAccepted};
  if((body.controlCapabilityVersion??0)<1)return {command:null,ackAccepted};
  this.db.prepare("UPDATE battery_commands SET status='delivered',delivered_at=coalesce(delivered_at,?) WHERE id=?").run(now,row.id);
  return {command:{id:row.id,kind:row.kind,expiresAt:row.expires_at,payload:this.decode(row.encrypted_payload,row.device_id+'\0'+row.id+'\0'+row.kind)},ackAccepted};
 }
 file(part){
  const m=this.release();if(!m)fail('Прошивка ещё не подготовлена.',503);
  const names={application:'application.bin',recovery:'recovery.bin',instructions:'Восстановление-ESP32.txt'};
  if(!names[part])fail('Файл не найден.',404);const file=join(this.firmwareDir,names[part]);if(!existsSync(file))fail('Файл не найден.',404);
  return {bytes:readFileSync(file),name:part==='instructions'?'ESP32-recovery-instructions.txt':'START-ESP32-'+m.version+'-'+part+'.bin',mime:part==='instructions'?'text/plain; charset=utf-8':'application/octet-stream'};
 }
}

export function batteryControlHandler(control,battery,admin,origin){return async(req,res,url)=>{
 const commands=url.pathname==='/api/admin/battery-state/commands',adminFile=url.pathname==='/api/admin/battery-firmware',deviceFile=url.pathname==='/api/devices/battery-firmware';
 if(!commands&&!adminFile&&!deviceFile)return false;
 const reply=(status,body)=>{const encoded=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(encoded),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:encoded);return true;};
 try{
  if(!control||!battery||!admin)return reply(503,{error:'Управление ESP32 не настроено.'});
  let user;
  if(deviceFile){const token=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];battery.authenticateDevice(url.searchParams.get('deviceId'),token);}
  else{const sid=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.slice(21);user=admin.user(sid);if(!user)return reply(401,{error:'Войдите в админку.'});owner(user);}
  if(adminFile||deviceFile){
   if(!['GET','HEAD'].includes(req.method))return reply(405,{error:'Метод не поддерживается.'});
   if(deviceFile&&url.searchParams.get('release')!==control.release()?.release)return reply(404,{error:'Прошивка не найдена.'});
   const part=deviceFile?'application':url.searchParams.get('part')||'recovery',f=control.file(part);
   res.writeHead(200,{'Content-Type':f.mime,'Content-Length':f.bytes.length,'Content-Disposition':'attachment; filename="'+f.name+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:f.bytes);return true;
  }
  if(['GET','HEAD'].includes(req.method))return reply(200,control.status(url.searchParams.get('deviceId'),user));
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});
  if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return reply(403,{error:'Недопустимый источник запроса.'});
  let length=0,chunks=[];for await(const c of req){length+=c.length;if(length>8192){req.resume();return reply(413,{error:'Запрос слишком большой.'});}chunks.push(c);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'Неверный JSON.'});}
  return reply(200,control.manage(body,user,origin));
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось выполнить управление ESP32.'});}
};}
