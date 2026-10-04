import {CafeBoard,cafeBoardHandler} from './cafe-board.mjs';
import {serveWorkspace} from './admin-workspace.mjs';
import {GuestBills} from './guest-bills.mjs';
import {deskHealthHandler} from './desk-health.mjs';
import {serveAdminAsset} from './admin-assets.mjs';
import {AqsiConnection,aqsiHandler} from './aqsi.mjs';
import {AqsiRental} from './aqsi-rental.mjs';
import {AqsiCafe} from './aqsi-cafe.mjs';
import {AqsiPilot} from './aqsi-pilot.mjs';
import {workforceHandler} from './workforce.mjs';
import {PrintStore,printHandler} from './print.mjs';
import {InventoryStore,inventoryHandler} from './inventory.mjs';
import {WaterWeather} from './water.mjs';
import {CafeStore,cafeHandler} from './cafe.mjs';
import {analyticsTag} from './analytics.mjs';
import {withSiteChrome} from './site-shell.mjs';
import {SmsStore,smsHandler} from './sms.mjs';
import http from 'node:http';
import {ContentStore,contentHandler} from './content.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {bookingText,sendBooking} from './telegram.mjs';
import {BookingGuard} from './guard.mjs';
import {AdminStore,adminHandler} from './admin.mjs';

const water=new WaterWeather();water.refresh();setInterval(()=>water.refresh(),3600000).unref();
const root = path.resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
const port = Number(process.env.PORT || 4173);
const origin = process.env.SITE_ORIGIN || `http://127.0.0.1:${port}`;
const adminStore=process.env.BOOKING_DB?new AdminStore(process.env.BOOKING_DB):null;
const aqsi=adminStore?new AqsiConnection(path.join(path.dirname(process.env.BOOKING_DB),'aqsi-connection.json')):null;
const aqsiPilot=adminStore?new AqsiPilot(adminStore,aqsi):null;
const handleAqsi=aqsiHandler(aqsi,adminStore,origin,aqsiPilot);
if(aqsiPilot){const tick=()=>aqsiPilot.tick().catch(()=>console.error('aQsi: status check unavailable'));setInterval(tick,5000).unref();setTimeout(tick,1000).unref();}
const printStore=adminStore?new PrintStore(adminStore):null;
if(adminStore)adminStore.printStore=printStore;
const handlePrint=printHandler(printStore,adminStore,origin);
const handleDeskHealth=deskHealthHandler(adminStore,printStore,aqsi);
const contentStore=adminStore?new ContentStore(adminStore.db,path.join(path.dirname(process.env.BOOKING_DB),'media')):null;
const handleContent=contentHandler(contentStore,adminStore,origin,path.join(root,'index.html'));
const handleWorkforce=workforceHandler(adminStore?.workforce,adminStore,origin);
if(adminStore){const run=()=>adminStore.workforce.tick().catch(()=>console.error('Workforce report worker failed'));setInterval(run,20000).unref();setTimeout(run,1000).unref();}
const handleAdmin=adminHandler(adminStore,origin);
const smsStore=adminStore?new SmsStore(adminStore,contentStore):null;
const handleSms=smsHandler(smsStore,adminStore,origin);
const cafeStore=adminStore?new CafeStore(adminStore,smsStore):null;
const aqsiCafe=cafeStore?new AqsiCafe(adminStore,aqsi,cafeStore,{enabled:process.env.AQSI_CAFE_ENABLED==='1'}):null;
if(cafeStore)cafeStore.terminal=aqsiCafe;
if(aqsiCafe){const tick=()=>aqsiCafe.tick().catch(()=>console.error('aQsi cafe: status check unavailable'));setInterval(tick,5000).unref();setTimeout(tick,1500).unref();}
const aqsiRental=adminStore?new AqsiRental(adminStore,aqsi,{enabled:process.env.AQSI_RENTAL_ENABLED==='1'}):null;
if(adminStore)adminStore.rentalTerminal=aqsiRental;
if(aqsiRental){const tick=()=>aqsiRental.tick().catch(()=>console.error('aQsi rental: status check unavailable'));setInterval(tick,5000).unref();setTimeout(tick,1800).unref();}
const guestBills=adminStore?new GuestBills(adminStore,aqsi,cafeStore):null;if(adminStore)adminStore.guestBills=guestBills;if(guestBills){const tick=()=>guestBills.tick().catch(()=>console.error('Guest bill payment check unavailable'));setInterval(tick,5000).unref();}
const handleCafeBoard=cafeBoardHandler(new CafeBoard(cafeStore),adminStore);
const handleCafe=cafeHandler(cafeStore,adminStore,origin);
const inventoryStore=adminStore?new InventoryStore(adminStore):null;
const handleInventory=inventoryHandler(inventoryStore,adminStore,origin);
if(cafeStore){const run=()=>cafeStore.tick().catch(()=>console.error('Cafe notification worker failed'));setInterval(run,15000).unref();run();}
if(smsStore){const run=()=>smsStore.tick().catch(()=>console.error("SMS worker failed; inspect admin SMS journal"));setInterval(run,30000).unref();run();}
const guard = process.env.BOOKING_DB && process.env.TELEGRAM_BOT_TOKEN ? new BookingGuard(process.env.BOOKING_DB,process.env.TELEGRAM_BOT_TOKEN) : null;
const json = (res,status,body) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const ready = () => Boolean(guard && process.env.TELEGRAM_BOT_TOKEN && /^\d+$/.test(process.env.TELEGRAM_CHAT_ID || ''));
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
  try {
    const url = new URL(req.url,origin);
    if(await handleDeskHealth(req,res,url))return;
    if(await handleAqsi(req,res,url))return;
    if(await handlePrint(req,res,url))return;
    if(await handleWorkforce(req,res,url))return;
    if(await handleInventory(req,res,url))return;
    if(await handleCafeBoard(req,res,url))return;
    if(await handleCafe(req,res,url))return;
    if(url.pathname==='/admin/purchase'){res.writeHead(302,{Location:'/admin/purchase/'});res.end();return;}
    if(['/cafe','/menu.html','/admin/cafe'].includes(url.pathname)){res.writeHead(302,{Location:url.pathname.startsWith('/admin')?'/admin/cafe/':'/cafe/'+url.search});res.end();return;}
    if(url.pathname==='/cafe/'&&url.searchParams.get('staff')==='1'){const append=url.searchParams.get('append');res.writeHead(302,{Location:'/admin/cafe/'+(append&&/^\d+$/.test(append)?'?append='+append:'')+'#new','Cache-Control':'no-store'});res.end();return;}
    if(await serveWorkspace(req,res,url,root))return;
    if(url.pathname==='/cafe/'||/^\/cafe\/t\/[a-f0-9]{48}$/.test(url.pathname)||url.pathname==='/admin/cafe/'){
      if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'method'});
      const staff=url.pathname.startsWith('/admin');let html=await readFile(path.join(root,staff?'admin/cafe.html':'cafe.html'),'utf8');
      if(!staff&&contentStore){html=withSiteChrome(html,contentStore.live());if(!url.searchParams.has('staff'))html=html.replace('</head>',analyticsTag()+'</head>');}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff',...(staff||url.pathname.includes('/t/')||url.searchParams.has('staff')?{'X-Robots-Tag':'noindex, nofollow'}:{})});res.end(req.method==='HEAD'?undefined:html);return;
    }
    if(url.pathname==='/api/water-temperature'){if(req.method!=='GET')return json(res,405,{error:'method'});return json(res,200,water.snapshot());}
    if(await handleSms(req,res,url))return;
    if(await handleContent(req,res,url))return;
    if(url.pathname==='/index.html'){res.writeHead(301,{Location:'/'});res.end();return;}
    if(await handleAdmin(req,res,url))return;
    if(url.pathname === '/api/booking-config' && req.method === 'GET') return json(res,200,{enabled:ready()});
    if(url.pathname === '/api/bookings') {
      if(req.method !== 'POST') return json(res,405,{error:'method'});
      if(req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) return json(res,403,{error:'origin'});
      if(!ready()) return json(res,503,{error:'not_configured'});
      const ip=req.headers['x-real-ip'] || req.socket.remoteAddress;
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)return json(res,413,{error:'size'});chunks.push(chunk);}
      const body=Buffer.concat(chunks).toString('utf8');
      let text,booking;try{booking=JSON.parse(body);text=bookingText(booking,new Date(),contentStore?.live());}catch{return json(res,400,{error:'invalid'});}
      const receipt=guard.reserve(text,ip);
      if(receipt.state==='limited')return json(res,429,{error:'rate_limit'});
      const key=receipt.id+':'+receipt.created;
      if(adminStore.received(key))return json(res,200,{ok:true,duplicate:true});
      if(receipt.state==='sent')return json(res,200,{ok:true,duplicate:true});
      if(receipt.state==='pending')return json(res,409,{error:'delivery_unconfirmed'});
      // Persist the request before notification; Telegram failure must not lose the inquiry.
      const inquiryId=adminStore.receive(key,booking,Date.now(),contentStore?.live());
      smsStore?.sync();
      try{await sendBooking(text,process.env);guard.complete(receipt.id);adminStore.notification(inquiryId,'sent');}catch{adminStore.notification(inquiryId,'unknown');}
      return json(res,200,{ok:true});
    }
    if(req.method !== 'GET' && req.method !== 'HEAD')return json(res,405,{error:'method'});
    const pathname=decodeURIComponent(url.pathname);
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':['/admin','/admin/'].includes(pathname)?'/admin/index.html':['/admin/settings','/admin/settings/'].includes(pathname)?'/admin/settings.html':pathname==='/admin/aqsi/'?'/admin/aqsi.html':pathname==='/admin/schedule/'?'/admin/schedule.html':pathname==='/admin/accounts/'?'/admin/accounts.html':pathname==='/admin/tasks/'?'/admin/tasks.html':pathname==='/admin/purchase/'?'/admin/purchase.html':pathname==='/admin/workforce/'?'/admin/workforce.html':pathname==='/admin/cafe-stock/'?'/admin/cafe-stock.html':pathname));
    if(!file.startsWith(root+path.sep) || !types[path.extname(file)] || pathname.split('/').some(p=>p.startsWith('.')))return json(res,404,{error:'not_found'});
    if(await serveAdminAsset(req,res,file,url,types[path.extname(file)]))return;
    const data=await readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)],'X-Content-Type-Options':'nosniff',...(pathname.startsWith('/assets/')?{'Cache-Control':'public, max-age=86400'}:{}),...(pathname.startsWith('/admin')?{'Cache-Control':'no-store','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}:{})});res.end(req.method==='HEAD'?undefined:data);
  }catch{if(!res.headersSent)json(res,404,{error:'not_found'});else res.end();}
}).listen(port,'127.0.0.1',()=>console.log(`START local server: ${origin}; Telegram configured: ${ready()}`));
