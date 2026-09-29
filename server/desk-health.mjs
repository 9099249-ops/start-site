export function deskHealthHandler(admin,printer,aqsi){
 let cached=null,running=null,checkedAt=0;
 async function terminal(){if(cached&&Date.now()-checkedAt<60000)return cached;if(running)return running;
  running=(async()=>{try{const config=aqsi?.read();if(!config?.apiKey||!config.deviceId)return {state:'unconfigured',message:'Касса не настроена'};await aqsi.checkDevice(config);return {state:'ok',message:'Касса: API доступен'};}catch{return {state:'error',message:'Нет связи с aQsi. Проверьте кассу и интернет.'};}})();
  try{cached=await running;checkedAt=Date.now();return cached;}finally{running=null;}
 }
 return async(req,res,url)=>{if(url.pathname!=='/api/admin/desk-health')return false;
  const reply=(code,d)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(d));return true;};
  if(req.method!=='GET')return reply(405,{error:'Метод не поддерживается.'});
  const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.slice(21),user=admin?.user(token);
  if(!user)return reply(401,{error:'Войдите в админку.'});if(!['admin','staff','waiter'].includes(user.role))return reply(403,{error:'Нет доступа.'});
  const device=printer?.device(),health=device?.health;
  const print=!device?.configured||!device?.enabled?{state:'unconfigured',message:'Принтер не настроен'}:!device.online?{state:'error',message:'Принтер недоступен. Проверьте Raspberry Pi и подключение.'}:!health?.cups||!health?.printer_configured||!health?.printing_enabled?{state:'error',message:'Печать недоступна. Проверьте принтер.'}:{state:'ok',message:'Принтер: агент на связи'};
  return reply(200,{printer:print,terminal:await terminal(),checkedAt:Date.now(),note:'Связь с API не подтверждает готовность самой CS50; статус оплаты проверяется отдельно.'});
 };
}
