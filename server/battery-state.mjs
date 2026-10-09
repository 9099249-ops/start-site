import {readFileSync} from 'node:fs';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {estimateChargeMinutes} from './battery-charge-estimate.mjs';
import {batteryPresence} from './battery-presence.mjs';

const DAY=86400000,RETENTION=30*DAY;
const CATAMARANS=['Сашин','Наташин','С серой крышей'];
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>createHash('sha256').update(v).digest('hex');
const owner=u=>{if(u?.role!=='admin'||u.scheduleOnly)fail('Раздел доступен администратору.',403);};
const text=(v,name,max=120,empty=true)=>{if(typeof v!=='string'||v.length>max||/[\x00-\x1f\x7f]/.test(v)||(!empty&&!v.trim()))fail('Проверьте поле «'+name+'».');return v.trim();};
const number=(v,name,min,max,integer=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isSafeInteger(v)))fail('Проверьте значение «'+name+'».');return v;};
const optionalNumber=(v,name,min,max,integer=false)=>v===undefined||v===null?null:number(v,name,min,max,integer);
const mac=v=>{v=text(v,'BMS',17,false).toLowerCase();if(!/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(v))fail('Укажите Bluetooth-адрес BMS.');return v;};
const bool=(v,name)=>{if(typeof v!=='boolean')fail('Проверьте поле «'+name+'».');return v;};
const optionalBool=(v,name)=>v===undefined||v===null?null:bool(v,name);
const listNumbers=(v,name,count,min,max)=>{if(v===undefined||v===null)return null;if(!Array.isArray(v)||v.length>count)fail('Проверьте список «'+name+'».');return v.map(x=>optionalNumber(x,name,min,max));};
const ttl=v=>v===undefined?90:number(v,'Срок актуальности',30,3600,true);

export function normalizeBatteryTelemetry(value,age){
 if(!object(value))fail('Неверный формат показаний.');
 const t={socPercent:optionalNumber(value.socPercent,'Заряд',0,100),voltageV:optionalNumber(value.voltageV,'Напряжение',0,200),currentA:optionalNumber(value.currentA,'Ток',-2000,2000),powerW:optionalNumber(value.powerW,'Мощность',0,400000),remainingCapacityAh:optionalNumber(value.remainingCapacityAh,'Остаточная ёмкость',0,10000),cellCount:optionalNumber(value.cellCount,'Число ячеек',1,32,true),temperatureSensorCount:optionalNumber(value.temperatureSensorCount,'Число датчиков',0,16,true),state:value.state??'unknown',chargingEnabled:optionalBool(value.chargingEnabled,'Зарядный MOS'),dischargingEnabled:optionalBool(value.dischargingEnabled,'Разрядный MOS'),cellVoltagesV:listNumbers(value.cellVoltagesV,'Ячейки',32,0,10),temperaturesC:listNumbers(value.temperaturesC,'Температуры',16,-60,150),bmsName:value.bmsName==null?null:text(value.bmsName,'Имя BMS',120),alarmMaskHex:null,fieldAgesMs:{summary:age},rawFrames:{}};
 if(!['charging','discharging','idle','unknown'].includes(t.state))fail('Неверное состояние батареи.');
 if(t.voltageV!==null&&t.currentA!==null)t.powerW=Math.round(t.voltageV*Math.abs(t.currentA)*100)/100;
 if(t.cellCount!==null&&t.cellVoltagesV?.length>t.cellCount)fail('Ячеек больше указанного количества.');
 if(t.temperatureSensorCount!==null&&t.temperaturesC?.length>t.temperatureSensorCount)fail('Датчиков больше указанного количества.');
 if(t.cellCount!==null&&t.cellVoltagesV)t.cellVoltagesV=Array.from({length:t.cellCount},(_,i)=>t.cellVoltagesV[i]??null);
 if(t.temperatureSensorCount!==null&&t.temperaturesC)t.temperaturesC=Array.from({length:t.temperatureSensorCount},(_,i)=>t.temperaturesC[i]??null);
 if(value.alarmMaskHex!=null){if(typeof value.alarmMaskHex!=='string'||!/^[a-fA-F0-9]{16}$/.test(value.alarmMaskHex))fail('Неверные флаги BMS.');t.alarmMaskHex=value.alarmMaskHex.toUpperCase();}
 if(value.fieldAgesMs!=null){if(!object(value.fieldAgesMs))fail('Неверное время измерений.');for(const [key,v] of Object.entries(value.fieldAgesMs)){if(!['summary','status','cells','temperatures','alarms','name'].includes(key))fail('Неизвестная группа измерений.');t.fieldAgesMs[key]=optionalNumber(v,'Возраст измерения',0,DAY,true);}}
 if(value.rawFrames!=null){if(!object(value.rawFrames))fail('Неверные исходные пакеты.');for(const [cmd,v] of Object.entries(value.rawFrames)){if(!['90','93','94','95','96','98','56'].includes(cmd))fail('Неизвестная команда BMS.');if(v===null)continue;const frames=Array.isArray(v)?v:[v];if(frames.length>16)fail('Слишком много исходных кадров.');for(const hex of frames){if(typeof hex!=='string'||!/^[a-fA-F0-9]{26}$/.test(hex))fail('Неверный исходный кадр.');const b=Buffer.from(hex,'hex');if(b[0]!==0xfa||b[2]!==parseInt(cmd,16)||b[3]!==8||(b.subarray(0,12).reduce((n,x)=>n+x,0)&255)!==b[12])fail('Неверная контрольная сумма кадра BMS.');}t.rawFrames[cmd]=Array.isArray(v)?frames.map(s=>s.toUpperCase()):v.toUpperCase();}}
 return t;
}

export class BatteryStateStore{
 constructor(admin){this.admin=admin;this.db=admin.db;this.tokens=new Map();this.lastCleanup=0;this.rate=new Map();this.db.exec(readFileSync(new URL('./migrations/battery-state.sql',import.meta.url),'utf8'));}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 row(id){const r=this.db.prepare('SELECT * FROM battery_devices WHERE device_id=?').get(id);if(!r)fail('Модуль не найден.',404);return r;}
 cleanup(now){if(now-this.lastCleanup<3600000)return;this.db.prepare('DELETE FROM battery_history WHERE measured_at<?').run(now-RETENTION);this.db.prepare('DELETE FROM battery_boots WHERE received_at<?').run(now-RETENTION);this.db.prepare('DELETE FROM battery_requests WHERE created_at<?').run(now-RETENTION);this.db.prepare('DELETE FROM battery_device_events WHERE created_at<?').run(now-RETENTION);for(const [k,v] of this.tokens)if(v.until<now)this.tokens.delete(k);this.lastCleanup=now;}
 projection(row,now){
  const current=this.db.prepare('SELECT * FROM battery_current WHERE device_id=?').get(row.device_id),health=JSON.parse(row.health_json),telemetry=current?JSON.parse(current.telemetry_json):null;
  const online=!!row.enabled&&row.last_seen_at!==null&&now-row.last_seen_at<=row.stale_after_seconds*1000;
  const stale=!row.enabled||!current||now-current.measured_at>row.stale_after_seconds*1000;
  if(telemetry){const elapsed=Math.max(0,now-current.received_at);telemetry.fieldAgesMs=Object.fromEntries(Object.entries(telemetry.fieldAgesMs).map(([k,v])=>[k,v===null?null:v+elapsed]));telemetry.alarms=telemetry.alarmMaskHex?Array.from(Buffer.from(telemetry.alarmMaskHex,'hex')).flatMap((byte,i)=>Array.from({length:8},(_,bit)=>byte&(1<<bit)?'BMS_BIT_'+(i*8+bit):null).filter(Boolean)):null;}
  const data={deviceId:row.device_id,name:row.name,catamaranLabel:row.catamaran_label,bmsId:row.bms_id,serialNumber:row.serial_number,capacityAh:row.capacity_ah,enabled:!!row.enabled,revision:row.revision,staleAfterSeconds:row.stale_after_seconds,bindingLocked:!!current||!!this.db.prepare('SELECT 1 FROM battery_history WHERE device_id=? LIMIT 1').get(row.device_id),lastSeenAt:row.last_seen_at,lastMeasuredAt:current?.measured_at??null,receivedAt:current?.received_at??null,online,stale,bmsConnected:health.bmsConnected??false,firmwareVersion:health.firmwareVersion??null,wifiRssi:health.wifiRssi??null,bleRssi:health.bleRssi??null,uptimeSeconds:health.uptimeSeconds??null,localIp:health.localIp??null,wifiSsid:health.wifiSsid??null,controlCapabilityVersion:health.controlCapabilityVersion??0,bmsLastSeenAt:health.bmsLastSeenAt??null,telemetry,estimate:null};
  if(!stale&&online&&data.bmsConnected&&telemetry){
   const t=telemetry,capacity=row.capacity_ah??(t.socPercent>=5&&t.remainingCapacityAh>0?t.remainingCapacityAh/(t.socPercent/100):null);
   let minutes=null,kind=null;
   if(t.state==='charging'&&t.currentA>0&&capacity>0&&t.remainingCapacityAh!==null){
    const recent=this.db.prepare('SELECT measured_at,telemetry_json FROM battery_history WHERE device_id=? AND measured_at>=? AND measured_at<? ORDER BY measured_at DESC LIMIT 6').all(row.device_id,current.measured_at-300000,current.measured_at);
    const samples=[];let previous=current.measured_at;
    for(const sample of recent){if(previous-sample.measured_at>Math.max(90000,row.stale_after_seconds*1000))break;const value=JSON.parse(sample.telemetry_json);if((value.fieldAgesMs?.status??Infinity)>row.stale_after_seconds*1000)break;samples.push(value);previous=sample.measured_at;}
    minutes=estimateChargeMinutes(t,capacity,samples);kind='charge';
   }else if(t.state==='discharging'&&t.currentA<0&&t.remainingCapacityAh>0){minutes=t.remainingCapacityAh/Math.abs(t.currentA)*60;kind='discharge';}
   if(minutes!==null&&minutes>=0&&minutes<=10080&&(t.fieldAgesMs.status??Infinity)<=row.stale_after_seconds*1000)data.estimate={kind,minutes:Math.round(minutes),estimated:true,basis:row.capacity_ah!==null?'configured':'derived'};
  }
  return data;
 }
 list(user,now=Date.now()){owner(user);return {now,catamarans:[...CATAMARANS],devices:this.db.prepare('SELECT * FROM battery_devices ORDER BY name,device_id').all().map(r=>this.projection(r,now))};}
 manage(body,user,now=Date.now()){
  owner(user);if(!object(body))fail('Неверный запрос.');if(!['create','update','rotate-token'].includes(body.action))fail('Неизвестное действие.');const requestId=text(body.requestId,'Ключ запроса',80,false);if(!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))fail('Неверный ключ запроса.');
  const fingerprint=hash(JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(k=>[k,body[k]]))));
  return this.tx(()=>{
   const previous=this.db.prepare('SELECT * FROM battery_requests WHERE request_id=?').get(requestId);
   if(previous){if(previous.fingerprint!==fingerprint)fail('Ключ уже использован для другого запроса.',409);const cached=this.tokens.get(requestId);return {device:this.projection(this.row(previous.device_id),now),token:cached&&cached.until>=now?cached.token:null,duplicate:true};}
   let row,raw=null,id;
   if(body.action==='create'){
    if(this.db.prepare('SELECT count(*) n FROM battery_devices').get().n>=100)fail('Достигнут лимит модулей.');
    const name=text(body.name,'Название',120,false),label=text(body.catamaranLabel??'','Катамаран',80),bmsId=mac(body.bmsId),serial=text(body.serialNumber??'','Серийный номер',80),capacity=optionalNumber(body.capacityAh,'Ёмкость',0.1,10000),stale=ttl(body.staleAfterSeconds);
    if(this.db.prepare('SELECT 1 FROM battery_devices WHERE bms_id=?').get(bmsId))fail('Этот аккумулятор уже добавлен. Можно изменить его название и катамаран в настройках.',409);
    id='bms-'+randomBytes(6).toString('hex');raw=randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO battery_devices(device_id,name,catamaran_label,bms_id,serial_number,capacity_ah,stale_after_seconds,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,name,label,bmsId,serial,capacity,stale,hash(raw),now,now);
   }else{
    id=text(body.deviceId,'Модуль',64,false);row=this.row(id);if(number(body.revision,'Версия',0,2147483647,true)!==row.revision)fail('Настройки изменились. Обновите страницу.',409);
    if(body.action==='rotate-token'){raw=randomBytes(32).toString('base64url');this.db.prepare('UPDATE battery_devices SET token_hash=?,revision=revision+1,updated_at=? WHERE device_id=?').run(hash(raw),now,id);}
    else{const name=text(body.name??row.name,'Название',120,false),label=text(body.catamaranLabel??row.catamaran_label,'Катамаран',80),bmsId=body.bmsId===undefined?row.bms_id:mac(body.bmsId),serial=text(body.serialNumber??row.serial_number,'Серийный номер',80),enabled=body.enabled===undefined?!!row.enabled:bool(body.enabled,'Включён'),capacity=body.capacityAh===undefined?row.capacity_ah:optionalNumber(body.capacityAh,'Ёмкость',0.1,10000),stale=body.staleAfterSeconds===undefined?row.stale_after_seconds:ttl(body.staleAfterSeconds);
     if(bmsId!==row.bms_id&&this.projection(row,now).bindingLocked)fail('Для нового аккумулятора создайте отдельный профиль: история прежнего должна сохраниться.',409);
     if(bmsId!==row.bms_id&&this.db.prepare('SELECT 1 FROM battery_devices WHERE bms_id=? AND device_id<>?').get(bmsId,id))fail('Этот аккумулятор уже добавлен в другой профиль.',409);
     this.db.prepare('UPDATE battery_devices SET name=?,catamaran_label=?,bms_id=?,serial_number=?,enabled=?,capacity_ah=?,stale_after_seconds=?,revision=revision+1,updated_at=? WHERE device_id=?').run(name,label,bmsId,serial,enabled?1:0,capacity,stale,now,id);
     if(bmsId!==row.bms_id){this.db.prepare('DELETE FROM battery_current WHERE device_id=?').run(id);this.db.prepare('UPDATE battery_devices SET last_seen_at=NULL,health_json=? WHERE device_id=?').run('{}',id);}
    }
   }
   this.db.prepare('INSERT INTO battery_requests(request_id,action,fingerprint,device_id,created_at) VALUES(?,?,?,?,?)').run(requestId,body.action,fingerprint,id,now);
   this.db.prepare('INSERT INTO battery_device_events(device_id,actor_id,action,created_at) VALUES(?,?,?,?)').run(id,user.id,body.action,now);
   if(raw)this.tokens.set(requestId,{token:raw,until:now+300000});
   return {device:this.projection(this.row(id),now),token:raw};
  });
 }
 authenticateDevice(id,token){
  const row=typeof id==='string'?this.db.prepare('SELECT * FROM battery_devices WHERE device_id=?').get(id):null;
  if(typeof token!=='string'||token.length>160||!row||!row.enabled||!timingSafeEqual(Buffer.from(hash(token),'hex'),Buffer.from(row.token_hash,'hex')))fail('Модуль не авторизован.',401);
  return row;
 }
 ingest(body,token,now=Date.now()){
  if(!object(body))fail('Неверный запрос.');const id=text(body.deviceId,'Модуль',64,false),row=this.authenticateDevice(id,token);
  if(mac(body.bmsId)!==row.bms_id)fail('BMS не соответствует привязке модуля.',403);
  const bootId=text(body.bootId,'Запуск модуля',32,false);if(!/^[a-fA-F0-9]{8,32}$/.test(bootId))fail('Неверный идентификатор запуска.');
  const sequence=number(body.sequence,'Номер измерения',0,4294967295,true),age=number(body.measurementAgeMs??0,'Возраст измерения',0,DAY,true),bmsConnected=bool(body.bmsConnected,'Соединение BMS');
  const health={bmsConnected,firmwareVersion:body.firmwareVersion==null?null:text(body.firmwareVersion,'Версия прошивки',64),wifiRssi:optionalNumber(body.wifiRssi,'Wi-Fi RSSI',-127,0,true),bleRssi:optionalNumber(body.bleRssi,'BLE RSSI',-127,20,true),uptimeSeconds:optionalNumber(body.uptimeSeconds,'Время работы',0,4294967295,true),localIp:body.localIp??null};
  health.controlCapabilityVersion=body.controlCapabilityVersion==null?0:number(body.controlCapabilityVersion,'Версия управления',0,1,true);
  health.wifiSsid=body.wifiSsid==null?null:text(body.wifiSsid,'Сеть Wi-Fi',32);
  const seenAge=optionalNumber(body.bmsLastSeenAgeMs,'Последний сигнал BMS',0,DAY,true);
  const disconnectAge=optionalNumber(body.bmsDisconnectedAgeMs,'Возраст разрыва BMS',0,DAY,true);
  const uptimeMs=optionalNumber(body.uptimeMs,'Монотонное время модуля',0,Number.MAX_SAFE_INTEGER,true);
  health.bmsLastSeenAt=seenAge===null?(bmsConnected?now:null):now-seenAge;
  if(health.localIp!==null&&(typeof health.localIp!=='string'||!isIP(health.localIp)))fail('Неверный IP-адрес.');
  const telemetry=body.telemetry==null?null:normalizeBatteryTelemetry(body.telemetry,age);
  if(telemetry)telemetry.bmsId=row.bms_id;
  if(telemetry&&(typeof body.measurementAgeMs!=='number'||sequence===0))fail('Укажите возраст и номер измерения.');
  const rate=this.rate.get(id);if(rate&&now-rate.since<60000&&rate.count>=60)fail('Слишком частые сообщения.',429);this.rate.set(id,rate&&now-rate.since<60000?{since:rate.since,count:rate.count+1}:{since:now,count:1});
  return this.tx(()=>{
   const previousHealth=JSON.parse(this.row(id).health_json);
   const presence=batteryPresence(previousHealth,{bootId,uptimeMs,uptimeSeconds:health.uptimeSeconds,bmsConnected,bmsDisconnectedAgeMs:disconnectAge},now);
   if(!presence)return {ok:true,accepted:false,duplicate:true,receivedAt:now};
   Object.assign(health,presence);
   this.db.prepare('UPDATE battery_devices SET last_seen_at=?,health_json=? WHERE device_id=?').run(now,JSON.stringify(health),id);
   let accepted=false,duplicate=false;
   if(telemetry){
    const seen=this.db.prepare('SELECT highest_sequence FROM battery_boots WHERE device_id=? AND boot_id=?').get(id,bootId);
    duplicate=!!seen&&sequence<=seen.highest_sequence;
    if(!duplicate){
     this.db.prepare('INSERT INTO battery_boots(device_id,boot_id,highest_sequence,received_at) VALUES(?,?,?,?) ON CONFLICT(device_id,boot_id) DO UPDATE SET highest_sequence=excluded.highest_sequence,received_at=excluded.received_at').run(id,bootId,sequence,now);
     const measuredAt=now-age,current=this.db.prepare('SELECT measured_at FROM battery_current WHERE device_id=?').get(id);
     if(age<=3600000&&(!current||measuredAt>=current.measured_at)){
      const encoded=JSON.stringify(telemetry);this.db.prepare('INSERT INTO battery_current(device_id,boot_id,sequence,measured_at,received_at,telemetry_json) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET boot_id=excluded.boot_id,sequence=excluded.sequence,measured_at=excluded.measured_at,received_at=excluded.received_at,telemetry_json=excluded.telemetry_json').run(id,bootId,sequence,measuredAt,now,encoded);
      this.db.prepare('INSERT INTO battery_history(device_id,bucket_at,measured_at,received_at,telemetry_json) VALUES(?,?,?,?,?) ON CONFLICT(device_id,bucket_at) DO UPDATE SET measured_at=excluded.measured_at,received_at=excluded.received_at,telemetry_json=excluded.telemetry_json').run(id,Math.floor(measuredAt/60000)*60000,measuredAt,now,encoded);accepted=true;
     }
    }
   }
   const control=this.control?.exchange(id,body,now)??{};
   this.cleanup(now);return {ok:true,accepted,duplicate,receivedAt:now,...control};
  });
 }
 history(id,user,now=Date.now(),limit=60){owner(user);const device=this.row(id);limit=number(Number(limit),'Размер истории',1,500,true);return {now,history:this.db.prepare("SELECT measured_at,received_at,telemetry_json FROM battery_history WHERE device_id=? AND measured_at>=? AND json_extract(telemetry_json,'$.bmsId')=? ORDER BY measured_at DESC LIMIT ?").all(id,now-RETENTION,device.bms_id,limit).map(r=>({measuredAt:r.measured_at,receivedAt:r.received_at,telemetry:JSON.parse(r.telemetry_json)}))};}
}

export function batteryStateHandler(store,admin,origin){return async(req,res,url)=>{
 const machine=url.pathname==='/api/devices/battery-telemetry',read=url.pathname==='/api/admin/battery-state',history=url.pathname==='/api/admin/battery-state/history',manage=url.pathname==='/api/admin/battery-state/devices';
 if(!machine&&!read&&!history&&!manage)return false;
 const reply=(status,body)=>{const encoded=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(encoded),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:encoded);return true;};
 try{
  if(!store||!admin)return reply(503,{error:'Мониторинг аккумуляторов не настроен.'});
  if(machine&&!req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/))return reply(401,{error:'Модуль не авторизован.'});
  const expected=machine||manage?['POST']:['GET','HEAD'];if(!expected.includes(req.method))return reply(405,{error:'Метод не поддерживается.'});
  let user=null;if(!machine){const sid=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.slice(21);user=admin.user(sid);if(!user)return reply(401,{error:'Войдите в админку.'});owner(user);}
  if(read)return reply(200,store.list(user));if(history)return reply(200,store.history(url.searchParams.get('deviceId'),user,Date.now(),url.searchParams.get('limit')??60));
  if(!req.headers['content-type']?.startsWith('application/json')||(!machine&&req.headers.origin!==origin))return reply(403,{error:'Недопустимый источник или формат запроса.'});
  const cap=machine?16384:8192;let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>cap){req.resume();return reply(413,{error:'Запрос слишком большой.'});}chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'Неверный JSON.'});}
  return reply(200,machine?store.ingest(body,req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1]):store.manage(body,user));
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось обработать данные аккумулятора.'});}
};}
