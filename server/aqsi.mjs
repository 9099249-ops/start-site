import {readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const root='https://api.aqsi.ru/pub';
const requireAdmin=user=>{if(!user)fail('Войдите в админку.',401);if(user.role!=='admin')fail('Только администратор.',403);};

// Connection setup only. No payment or fiscalization commands are exposed here.
export class AqsiConnection {
 constructor(file,{request=fetch}={}){this.file=file;this.request=request;this.checking=null;}
 read(){try{return JSON.parse(readFileSync(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return {revision:0,apiKey:'',deviceId:null};throw e;}}
 info(user){requireAdmin(user);const c=this.read();return {configured:Boolean(c.apiKey),deviceId:c.deviceId,revision:c.revision,paymentsEnabled:process.env.AQSI_CAFE_ENABLED==='1',rentalPaymentsEnabled:process.env.AQSI_RENTAL_ENABLED==='1'};}
 save(body,user){requireAdmin(user);const old=this.read();if(!Number.isSafeInteger(body.revision)||body.revision!==old.revision)fail('Настройки изменились. Обновите страницу.',409);
  const deviceId=Number(body.deviceId);if(!Number.isSafeInteger(deviceId)||deviceId<=0||deviceId>2147483647)fail('Укажите числовой ID кассы из aQsi.');
  if(body.apiKey!==undefined&&typeof body.apiKey!=='string')fail('Проверьте ключ API.');
  const apiKey=(body.apiKey||'').trim().replace(/^Application\s+/i,'')||old.apiKey;
  if(!apiKey||apiKey.length<8||apiKey.length>2048||/[^\x21-\x7e]/.test(apiKey))fail('Проверьте ключ API.');
  const next={revision:old.revision+1,apiKey,deviceId},temp=this.file+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temp,JSON.stringify(next),{mode:0o600,flag:'wx'});renameSync(temp,this.file);}finally{try{unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return this.info(user);
 }
 async check(user){requireAdmin(user);if(this.checking)return this.checking;const c=this.read();if(!c.apiKey||!c.deviceId)fail('Сначала сохраните ключ API и ID кассы.');
  this.checking=this.checkDevice(c);try{return await this.checking;}finally{this.checking=null;}
 }
 async checkDevice(c){
  let response,device;
  try{response=await this.request(root+'/v4/Devices/'+c.deviceId,{method:'GET',redirect:'error',headers:{'x-client-key':'Application '+c.apiKey,Accept:'application/json'},signal:AbortSignal.timeout(12000)});}catch{fail('Нет ответа aQsi. Проверьте подключение и повторите проверку.',502);}
  if([401,403].includes(response.status))fail('aQsi отклонил ключ API или доступ к кассе.',502);
  if(response.status===404)fail('Касса с таким ID не найдена в aQsi.',502);
  if(!response.ok)fail('aQsi временно не выполнил проверку (HTTP '+response.status+').',502);
  try{device=await response.json();}catch{fail('Некорректный ответ aQsi.',502);}
  if(device.id!==c.deviceId)fail('aQsi вернул другую кассу. Проверьте ID.',502);
  if(this.read().revision!==c.revision)fail('Настройки изменились во время проверки. Проверьте подключение ещё раз.',409);
  const safe=v=>typeof v==='string'?v.slice(0,150):'';
  return {ok:true,checkedAt:new Date().toISOString(),device:{id:device.id,model:safe(device.model),serialNumber:safe(device.serialNumber)},paymentsEnabled:process.env.AQSI_CAFE_ENABLED==='1',rentalPaymentsEnabled:process.env.AQSI_RENTAL_ENABLED==='1'};
 }
}

export function aqsiHandler(store,admin,origin,pilot=null){return async(req,res,url)=>{
 if(!url.pathname.startsWith('/api/admin/aqsi/'))return false;
 const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));return true;};
 try{
  if(!store)fail('Админка не настроена.',503);
  const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-start_session='))?.slice(21),user=admin.user(token);requireAdmin(user);
  if(req.method==='GET'&&url.pathname==='/api/admin/aqsi/settings')return reply(200,store.info(user));
  if(req.method==='GET'&&url.pathname==='/api/admin/aqsi/pilot'&&pilot)return reply(200,pilot.info(user));
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});
  if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))fail('Недопустимый источник запроса.',403);
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)fail('Запрос слишком большой.',413);chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{fail('Неверный запрос.');}if(!body||typeof body!=='object'||Array.isArray(body))fail('Неверный запрос.');
  if(url.pathname==='/api/admin/aqsi/settings')return reply(200,store.save(body,user));
  if(url.pathname==='/api/admin/aqsi/check')return reply(200,await store.check(user));
  if(url.pathname==='/api/admin/aqsi/pilot'&&pilot)return reply(200,await pilot.begin(body,user));
  return reply(404,{error:'Не найдено.'});
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось выполнить настройку aQsi.'});}
};}
