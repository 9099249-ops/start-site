import {withSiteChrome} from './site-shell.mjs';
import {renderStorage} from './storage.mjs';
import {optimizeImages,imageOptions} from './images.mjs';
import {renderEvent,eventPaths} from './events.mjs';
import {analyticsTag} from './analytics.mjs';
import {withServiceSeo,serviceLinks,renderService,servicePath} from './services.mjs';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const defaults=JSON.parse(readFileSync(new URL('./content-defaults.json',import.meta.url),'utf8'));
const error=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=x=>JSON.parse(JSON.stringify(x));
const text=(v,max=2000)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x08\x0b-\x1f]/.test(v))error('Проверьте текстовые поля.');return v.trim();};
const image=v=>{if(typeof v!=='string'||!/^\/(assets\/[a-zA-Z0-9_.-]+|media\/[a-f0-9-]+)\.(jpg|jpeg|png|webp)$/.test(v))error('Выберите изображение из библиотеки.');return v;};
export function validateContent(input){
 if(!input||typeof input!=='object')error('Неверное содержимое.');const d=clone(defaults);
 for(const k of Object.keys(d.texts))d.texts[k].value=text(input.texts?.[k]?.value);
 d.phone=text(input.phone,32);if(!/^\+?[\d ()-]+$/.test(d.phone)||d.phone.replace(/\D/g,'').length<10)error('Проверьте телефон.');
 d.telegram=text(input.telegram,32);if(!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(d.telegram))error('Укажите имя Telegram без @.');
 for(const k of ['open','close']){if(!/^(0\d|1\d|2[0-3]):(00|30)$/.test(input[k]||''))error('Время — в формате ЧЧ:00 или ЧЧ:30.');d[k]=input[k];}if(d.open>=d.close)error('Закрытие должно быть позже открытия.');
 for(const k of ['heroImage','cameraImage'])d[k]=image(input[k]);d.heroAlt=text(input.heroAlt,250);
 for(const k of Object.keys(d.plans)){const n=input.plans?.[k];if(!Number.isInteger(n)||n<0||n>1000000)error('Цена должна быть целым числом от 0 до 1000000 рублей.');d.plans[k]=n;}
 for(const item of d.inventory){const x=input.inventory?.find(x=>x.id===item.id);if(!x)error('Не хватает категории техники.');item.name=text(x.name,80);item.label=text(x.label,80);item.price=x.price;if(!Number.isInteger(item.price)||item.price<0||item.price>1000000)error('Проверьте цены техники.');if(item.description!==undefined)item.description=text(x.description,500);if(item.image){item.image=image(x.image?.startsWith('/')?x.image:'/assets/'+x.image);}}
 const seo=input.seo||{};for(const k of ['title','description','socialTitle','socialDescription'])d.seo[k]=text(seo[k],k.includes('escription')?500:180);
 if(typeof seo.indexable!=='boolean')error('Проверьте настройку индексации.');d.seo.indexable=seo.indexable;d.seo.socialImage=image(seo.socialImage);
 for(const k of ['yandexVerification','googleVerification']){if(typeof seo[k]!=='string'||!/^[a-zA-Z0-9_-]{0,150}$/.test(seo[k]))error('Код подтверждения — только буквы, цифры, дефис и подчёркивание.');d.seo[k]=seo[k];}
 d.seo.services={};for(const i of d.inventory){const v=seo.services?.[i.id];if(v)d.seo.services[i.id]={title:text(v.title,180),description:text(v.description,500)};}return withServiceSeo(d);
}
export class ContentStore{
 constructor(db,media){this.db=db;this.media=media;mkdirSync(media,{recursive:true,mode:0o700});db.exec(`CREATE TABLE IF NOT EXISTS site_content(id INTEGER PRIMARY KEY CHECK(id=1),draft TEXT NOT NULL,published TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS content_versions(id INTEGER PRIMARY KEY,body TEXT NOT NULL,actor INTEGER NOT NULL,created INTEGER NOT NULL);`);db.prepare('INSERT OR IGNORE INTO site_content VALUES(1,?,?,0,?)').run(JSON.stringify(defaults),JSON.stringify(defaults),Date.now());}
 state(){const r=this.db.prepare('SELECT * FROM site_content WHERE id=1').get();return {draft:withServiceSeo(JSON.parse(r.draft)),published:withServiceSeo(JSON.parse(r.published)),revision:r.revision,updated:r.updated,versions:this.db.prepare('SELECT v.id,v.created,u.login actor FROM content_versions v JOIN admin_users u ON u.id=v.actor ORDER BY v.id DESC LIMIT 20').all()};}
 live(){return withServiceSeo(JSON.parse(this.db.prepare('SELECT published FROM site_content WHERE id=1').get().published));}
 mutate(action,b,user){if(user?.role!=='admin')error('Доступ только администратору.',403);this.db.exec('BEGIN IMMEDIATE');try{const r=this.db.prepare('SELECT * FROM site_content WHERE id=1').get();if(b.revision!==r.revision)error('Черновик уже изменён. Обновите редактор перед сохранением.',409);let draft=r.draft,published=r.published;if(action==='save')draft=JSON.stringify(validateContent(b.content));else if(action==='publish'){validateContent(JSON.parse(draft));this.db.prepare('INSERT INTO content_versions(body,actor,created) VALUES(?,?,?)').run(published,user.id,Date.now());published=draft;}else if(action==='restore'){const v=this.db.prepare('SELECT body FROM content_versions WHERE id=?').get(b.version);if(!v)error('Версия не найдена.',404);draft=v.body;}else error('Неизвестное действие.');this.db.prepare('UPDATE site_content SET draft=?,published=?,revision=revision+1,updated=? WHERE id=1').run(draft,published,Date.now());this.db.prepare('INSERT INTO admin_audit(actor,action,created) VALUES(?,?,?)').run(user.id,'content_'+action,Date.now());this.db.exec('COMMIT');return this.state();}catch(e){this.db.exec('ROLLBACK');throw e;}}
 upload(bytes,type){let ext;if(type==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)ext='jpg';if(type==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))ext='png';if(type==='image/webp'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')ext='webp';if(!ext)error('Разрешены фотографии JPEG, PNG и WebP.');const name=randomUUID()+'.'+ext;writeFileSync(path.join(this.media,name),bytes,{mode:0o600,flag:'wx'});return '/media/'+name;}
}
export function renderContent(template,d,preview=false){
 d=withServiceSeo(d);let html=template.replace('<head>','<head><base href="/"><script defer src="/water.js"></script>'+analyticsTag(preview));
 for(const [key,base] of Object.entries(defaults.texts)){const value=d.texts[key].value;if(value!==base.value)html=html.split(base.original).join(esc(value).replace(/\n/g,'<br>'));}
 html=html.replace(/<title>.*?<\/title>/,()=>'<title>'+esc(d.seo.title)+'</title>').replace(/<meta name="description" content="[^"]*">/,()=>'<meta name="description" content="'+esc(d.seo.description)+'">').replace(/<meta name="robots" content="[^"]*">/,'<meta name="robots" content="'+(!preview&&d.seo.indexable?'index,follow':'noindex,nofollow')+'">');
 html=html.replace('src="assets/start-pier-20260731.jpg"','src="'+esc(d.heroImage)+'"').replace('alt="'+defaults.heroAlt+'"','alt="'+esc(d.heroAlt)+'"').replace('src="assets/harbor.webp"','src="'+esc(d.cameraImage)+'"');
 html=html.split(defaults.phone).join(esc(d.phone)).split('tel:+79039633135').join('tel:'+d.phone.replace(/[^+\d]/g,''));html=html.split('https://t.me/Alexandrem2').join('https://t.me/'+d.telegram);
 html=html.split('09:00–22:00').join(d.open+'–'+d.close).split('с 09:00 до 22:00').join('с '+d.open+' до '+d.close);
 let planIndex=0;html=html.replace(/<div class="price">[\s\S]*?<\/div>/g,()=>{const k=['day','season','takeaway'][planIndex++];return '<div class="price">'+d.plans[k].toLocaleString('ru-RU')+' ₽ <span>/ '+(k==='season'?'сезон':'день')+'</span></div>';});html=html.replace('Залог — 5 000 ₽','Залог — '+d.plans.deposit.toLocaleString('ru-RU')+' ₽');
 const absolute=p=>'https://spotsup.ru'+p;
 const meta='<link rel="canonical" href="https://spotsup.ru/"><meta property="og:type" content="website"><meta property="og:url" content="https://spotsup.ru/"><meta property="og:title" content="'+esc(d.seo.socialTitle)+'"><meta property="og:description" content="'+esc(d.seo.socialDescription)+'"><meta property="og:image" content="'+esc(absolute(d.seo.socialImage))+'"><meta name="twitter:card" content="summary_large_image">'+['yandexVerification','googleVerification'].map((k,i)=>d.seo[k]?'<meta name="'+(i?'google-site-verification':'yandex-verification')+'" content="'+esc(d.seo[k])+'">':'').join('');
 const config={inventory:d.inventory.map(i=>{const v=imageOptions(i.image);return v?{...i,image:v.src,imageSrcSet:v.srcset,imageFull:i.image.replace(/-w960\.webp$/,'-w1600.webp')}:i;}),plans:d.plans,open:d.open,close:d.close,preview};
 html=html.replace('</head>',meta+'<script type="application/json" id="site-content">'+JSON.stringify(config).replace(/</g,'\\u003c')+'</script></head>');
 const business={'@context':'https://schema.org','@type':'LocalBusiness','@id':'https://spotsup.ru/#station',name:'СТАРТ',url:'https://spotsup.ru/',telephone:d.phone,image:absolute(d.heroImage),address:{'@type':'PostalAddress',streetAddress:'Ореховая ул, д.5',addressLocality:'Мытищи, Болтино',addressRegion:'Московская область',addressCountry:'RU'},sameAs:['https://t.me/STARTpirogovo','https://www.instagram.com/stancijstart/']};
 html=html.replace('</head>','<script type="application/ld+json">'+JSON.stringify(business).replace(/</g,'\\u003c')+'</script></head>');
 html=html.replace('</main>','<section class="section wrap"><h2>Подробнее о прокате</h2>'+serviceLinks(d)+'</section></main>').replace('</head>','<link rel="stylesheet" href="/service-links.css"></head>');
 if(preview)html=html.replace('<body>','<body><p style="position:sticky;top:0;z-index:100;background:#ffe342;padding:12px;color:#102238">Предпросмотр черновика. Изменения ещё не опубликованы. Отправка заявок отключена.</p>');return withSiteChrome(optimizeImages(html),d,true);
}
export function contentHandler(store,admin,origin,template){return async(req,res,url)=>{
 const managed=url.pathname.startsWith('/afisha/')||url.pathname.startsWith('/prokat/')||url.pathname.startsWith('/api/admin/content')||url.pathname==='/admin/preview'||url.pathname.startsWith('/media/')||['/storage','/storage/','/robots.txt','/sitemap.xml','/'].includes(url.pathname);if(!managed||!store)return false;
 const send=(code,body,type='application/json; charset=utf-8',extra={})=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});res.end(req.method==='HEAD'?undefined:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));return true;};
 try{
 if(url.pathname==='/storage'||url.pathname==='/storage/'){if(!['GET','HEAD'].includes(req.method))return send(405,{});if(url.pathname==='/storage')return send(301,'','text/plain',{Location:'/storage/'});return send(200,renderStorage(store.live()),'text/html; charset=utf-8');}
 if(url.pathname.startsWith('/afisha/')){if(!['GET','HEAD'].includes(req.method))return send(405,{});const match=/^\/afisha\/([a-z]+)\/$/.exec(url.pathname),html=match&&renderEvent(store.live(),match[1]);return html?send(200,html,'text/html; charset=utf-8'):send(404,{error:'Страница не найдена.'});}
 if(url.pathname.startsWith('/prokat/')){if(!['GET','HEAD'].includes(req.method))return send(405,{});const match=/^\/prokat\/([a-z0-9]+)\/$/.exec(url.pathname),html=match&&renderService(store.live(),match[1]);return html?send(200,html,'text/html; charset=utf-8'):send(404,{error:'Страница не найдена.'});}
 if(url.pathname.startsWith('/media/')){if(!['GET','HEAD'].includes(req.method))return send(405,{error:'Метод недоступен'});if(!/^\/media\/[a-f0-9-]+\.(jpg|png|webp)$/.test(url.pathname))return send(404,{});const file=path.join(store.media,path.basename(url.pathname));if(!existsSync(file))return send(404,{});return send(200,await readFile(file),'image/'+(file.endsWith('.jpg')?'jpeg':path.extname(file).slice(1)),{'Cache-Control':'public, max-age=31536000, immutable'});}
 if(['GET','HEAD'].includes(req.method)&&url.pathname==='/')return send(200,renderContent(await readFile(template,'utf8'),store.live()),'text/html; charset=utf-8');
 if(url.pathname==='/robots.txt')return send(200,store.live().seo.indexable?'User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nDisallow: /game/\nDisallow: /cafe/t/\nSitemap: https://spotsup.ru/sitemap.xml\n':'User-agent: *\nDisallow: /\n','text/plain; charset=utf-8');
 if(url.pathname==='/sitemap.xml')return send(200,'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+(store.live().seo.indexable?['/','/storage/','/cafe/',...eventPaths(),...store.live().inventory.map(i=>servicePath(i.id))].map(p=>'<url><loc>https://spotsup.ru'+p+'</loc></url>').join(''):'')+'</urlset>','application/xml');
 const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.split('=')[1],user=admin.user(token);if(!user)return send(401,{error:'Войдите в админку.'});if(user.role!=='admin')return send(403,{error:'Редактор доступен только администратору.'});
 if(req.method==='GET'&&url.pathname==='/admin/preview')return send(200,renderContent(await readFile(template,'utf8'),store.state().draft,true),'text/html; charset=utf-8',{'X-Robots-Tag':'noindex, nofollow','X-Frame-Options':'SAMEORIGIN'});
 if(req.method==='GET'&&url.pathname==='/api/admin/content')return send(200,store.state());
 if(req.method!=='POST')return send(405,{error:'Метод недоступен.'});if(req.headers.origin!==origin)return send(403,{error:'Недопустимый источник.'});
 const upload=url.pathname==='/api/admin/content-upload';let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>(upload?8*1024*1024:256*1024))return send(413,{error:'Слишком большой файл или документ.'});chunks.push(c);}const bytes=Buffer.concat(chunks);
 if(upload)return send(200,{url:store.upload(bytes,req.headers['content-type'])});
 if(!req.headers['content-type']?.startsWith('application/json'))return send(400,{error:'Неверный формат.'});let b;try{b=JSON.parse(bytes.toString());}catch{return send(400,{error:'Неверный документ.'});}if(!b||typeof b!=='object')return send(400,{});
 const action=url.pathname.split('/').pop();return send(200,store.mutate(action,b,user));
 }catch(e){return send(e.status||500,{error:e.status?e.message:'Не удалось сохранить изменения. Попробуйте ещё раз.'});}
};}
