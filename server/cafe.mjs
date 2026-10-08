import {CafeList} from './cafe-list.mjs';
import cafeNumber from '../dist/cafe-number.js';
import boardText from '../dist/cafe-board-text.js';
import {CafeStock} from './cafe-stock.mjs';
import {readFileSync} from 'node:fs';
import {randomBytes,createHash,scryptSync} from 'node:crypto';
import {phone} from './sms.mjs';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const token=()=>randomBytes(24).toString('hex');
const hash=s=>createHash('sha256').update(s).digest('hex');
const copy=v=>JSON.parse(JSON.stringify(v));
const stable=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
const str=(v,max=120,required=true)=>{if(typeof v!=='string'||v.length>max||/[\x00-\x08\x0b-\x1f]/.test(v)||required&&!v.trim())fail('Проверьте текстовые поля.');return v.trim();};
const integer=(v,min=0,max=10000000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail('Проверьте числовые поля.');return v;};
const day=now=>new Date(now+10800000).toISOString().slice(0,10);
const rub=n=>(n/100).toLocaleString('ru-RU')+' ₽';
export const cafeStatuses={NEW:'Новый',ACCEPTED:'Принят',COOKING:'Готовится',READY:'Готов',DELIVERED:'Выдан / доставлен',CANCELLED:'Отменён'};
 const transitions={NEW:['ACCEPTED','COOKING','READY','DELIVERED','CANCELLED'],ACCEPTED:['COOKING','READY','DELIVERED','CANCELLED'],COOKING:['READY','DELIVERED','CANCELLED'],READY:['DELIVERED','CANCELLED'],DELIVERED:['CANCELLED'],CANCELLED:[]};
const requireStaff=u=>{if(!['admin','staff','waiter'].includes(u?.role))fail('Войдите в кабинет кафе.',401);};
const requireAdmin=u=>{requireStaff(u);if(u.role!=='admin')fail('Доступно администратору.',403);};

export function seedCafe(seed){
 let sequence=0;
 const categories=seed.categories.map((c,i)=>({id:'cat-'+i,name:c.name,sort:c.sort,active:true}));
 const groups=(seed.modifier_group_templates||[]).map(g=>({id:g.key,name:g.name,active:true,min:g.min_select,max:g.max_select,options:g.options.map((o,i)=>({id:g.key+'-'+i,name:o.name,priceCents:o.price_delta===null?(g.key==='coffee_milk'?10000:5000):o.price_delta*100,active:true,soldOut:false}))}));
 const items=seed.categories.flatMap((c,i)=>c.items.map(x=>({id:'item-'+(++sequence),categoryId:categories[i].id,name:x.name,description:x.description||'',priceCents:x.price*100,size:x.weight||x.volume||x.unit||'',image:x.image||'',tags:x.tags||[],active:x.active,soldOut:false,yacht:x.yacht_delivery,station:x.production_station,restricted:x.production_station==='hookah',sort:sequence,variants:(x.variants||[]).map((name,j)=>({id:'v-'+j,name,priceCents:0,active:true})),groupIds:(seed.modifier_group_templates||[]).filter(g=>g.suggested_items?.includes(x.name)||g.suggested_categories?.includes(c.name)).map(g=>g.key)})));
 return {categories,items,groups,settings:{enabled:true,open:'09:00',close:'22:00',prepMinutes:20,busyMessage:'',fulfillments:['pickup','lounge','yacht','place','house'],payments:['cash','card_on_delivery']}};
}
export function validateCatalog(input,previous){
 const d=copy(input);if(!Array.isArray(d.categories)||!d.categories.length||d.categories.length>60||!Array.isArray(d.items)||d.items.length>500||!Array.isArray(d.groups)||d.groups.length>80)fail('Проверьте структуру меню.');
 const ids=rows=>{const set=new Set();for(const r of rows){if(!/^[a-zA-Z0-9_-]{1,64}$/.test(r.id)||set.has(r.id))fail('Идентификаторы должны быть уникальны.');set.add(r.id);}return set;};
 const bool=(o,k)=>{if(typeof o[k]!=='boolean')fail('Проверьте переключатели меню.');};
 const catIds=ids(d.categories),groupIds=ids(d.groups);ids(d.items);
 for(const x of d.items){
  if(x.blockQuickSale===undefined)x.blockQuickSale=previous?.items.find(p=>p.id===x.id)?.blockQuickSale===true;
  bool(x,'blockQuickSale');
 }
 for(const c of d.categories){c.name=str(c.name,80);integer(c.sort,0,10000);bool(c,'active');}
 const allOptionIds=new Set();
 for(const g of d.groups){g.name=str(g.name,80);bool(g,'active');integer(g.min,0,20);integer(g.max,g.min,20);if(!Array.isArray(g.options)||g.options.length>40)fail('Проверьте варианты добавок.');ids(g.options);for(const o of g.options){if(allOptionIds.has(o.id))fail('Идентификаторы добавок должны быть уникальны.');allOptionIds.add(o.id);o.name=str(o.name,80);integer(o.priceCents);bool(o,'active');bool(o,'soldOut');}}
 for(const x of d.items){if(!catIds.has(x.categoryId))fail('Категория не найдена.');x.name=str(x.name);x.description=str(x.description,600,false);x.size=str(x.size,40,false);x.image=str(x.image,200,false);if(x.image&&!/^\/(assets|media)\/[a-zA-Z0-9_.-]+\.(webp|jpg|png)$/.test(x.image))fail('Фото должно быть загружено на сайт.');integer(x.priceCents);integer(x.sort,0,10000);for(const k of ['active','soldOut','yacht','restricted'])bool(x,k);if(!['kitchen','bar','tea_hookah','hookah','none'].includes(x.station))fail('Проверьте цех.');if(previous?.items.find(p=>p.id===x.id)?.restricted||x.station==='hookah')x.restricted=true;if(!Array.isArray(x.tags)||x.tags.length>5)fail('Проверьте метки.');x.tags=x.tags.map(t=>str(t,30));if(!Array.isArray(x.groupIds)||x.groupIds.length>10||new Set(x.groupIds).size!==x.groupIds.length||x.groupIds.some(id=>!groupIds.has(id)))fail('Проверьте группы добавок.');if(!Array.isArray(x.variants)||x.variants.length>40)fail('Проверьте варианты блюда.');ids(x.variants);for(const v of x.variants){v.name=str(v.name,80);integer(v.priceCents);bool(v,'active');}}
 const s=d.settings;bool(s,'enabled');for(const k of ['open','close'])if(!/^(0\d|1\d|2[0-3]):[0-5]\d$/.test(s[k]))fail('Проверьте часы работы.');if(s.open>=s.close)fail('Закрытие должно быть позже открытия.');integer(s.prepMinutes,0,240);s.busyMessage=str(s.busyMessage,240,false);for(const [k,allowed] of [['fulfillments',['pickup','lounge','yacht','place','house']],['payments',['cash','card_on_delivery']]])if(!Array.isArray(s[k])||!s[k].length||s[k].some(v=>!allowed.includes(v)))fail('Проверьте способы получения и оплаты.');
 const texts=s.boardText===undefined?previous?.settings.boardText:s.boardText;
 if(texts!==undefined&&(texts===null||typeof texts!=='object'||Array.isArray(texts)))fail('Проверьте тексты табло.');
 const allowed=new Set(boardText.fields.map(f=>f.key));
 if(texts&&Object.keys(texts).some(key=>!allowed.has(key)))fail('Неизвестное поле текста табло.');
 const merged={...boardText.resolve(previous?.settings.boardText),...texts};
 s.boardText=Object.fromEntries(boardText.fields.map(f=>{
  const value=merged[f.key];
  if(typeof value!=='string'||/[\x00-\x1f\x7f-\x9f]/.test(value))fail('Проверьте тексты табло.');
  return [f.key,str(value,f.max,f.required)];
 }));
 return {categories:d.categories,items:d.items,groups:d.groups,settings:s};
}
export class CafeStore{
 constructor(admin,sms,{env=process.env,request=fetch,seed}={}){
  this.admin=admin;this.db=admin.db;this.sms=sms;this.env=env;this.request=request;this.busy=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS cafe_catalog(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS cafe_places(id INTEGER PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,token TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS cafe_orders(id INTEGER PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,public_token TEXT NOT NULL UNIQUE,client_id INTEGER REFERENCES clients(id),actor INTEGER REFERENCES admin_users(id),source TEXT NOT NULL,place_id INTEGER REFERENCES cafe_places(id),details TEXT NOT NULL,total_cents INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'NEW',created INTEGER NOT NULL,updated INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS cafe_order_queue ON cafe_orders(status,created);
   CREATE INDEX IF NOT EXISTS cafe_order_created ON cafe_orders(created DESC,id DESC);
   CREATE TABLE IF NOT EXISTS cafe_order_events(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES cafe_orders(id),request_id TEXT UNIQUE,kind TEXT NOT NULL,actor INTEGER REFERENCES admin_users(id),body TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cafe_notifications(id INTEGER PRIMARY KEY,event_id INTEGER NOT NULL UNIQUE REFERENCES cafe_order_events(id),status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL,claimed INTEGER,last_error TEXT NOT NULL DEFAULT '');
   CREATE TABLE IF NOT EXISTS cafe_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cafe_audit(id INTEGER PRIMARY KEY,actor INTEGER NOT NULL REFERENCES admin_users(id),action TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);`);
  this.db.exec('CREATE INDEX IF NOT EXISTS cafe_event_order ON cafe_order_events(order_id,id); CREATE INDEX IF NOT EXISTS refund_source_lookup ON customer_refunds(kind,source_id);');
  if(!this.db.prepare('SELECT id FROM cafe_catalog').get()){const initial=seedCafe(seed||JSON.parse(readFileSync(new URL('./cafe-seed.json',import.meta.url),'utf8')));this.db.prepare('INSERT INTO cafe_catalog(id,body) VALUES(1,?)').run(JSON.stringify(initial));}
  if(!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cafe_house_delivery_v1'").get()){
   this.transaction(()=>{const row=this.db.prepare('SELECT body FROM cafe_catalog WHERE id=1').get(),body=JSON.parse(row.body);if(!body.settings.fulfillments.includes('house'))body.settings.fulfillments.push('house');this.db.prepare('UPDATE cafe_catalog SET body=?,revision=revision+1 WHERE id=1').run(JSON.stringify(body));this.db.exec('CREATE TABLE cafe_house_delivery_v1(id INTEGER PRIMARY KEY)');});
  }
  this.stock=new CafeStock(this);
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 audit(user,action,body){this.db.prepare('INSERT INTO cafe_audit(actor,action,body,created) VALUES(?,?,?,?)').run(user.id,action,JSON.stringify(body),Date.now());}
 catalog(){const r=this.db.prepare('SELECT * FROM cafe_catalog WHERE id=1').get(),d=JSON.parse(r.body);return {...d,settings:{...d.settings,boardText:boardText.resolve(d.settings.boardText)},revision:r.revision};}
 saveCatalog(b,u){requireAdmin(u);return this.transaction(()=>{const old=this.catalog();if(b.revision!==old.revision)fail('Меню уже изменено. Обновите редактор.',409);const d=validateCatalog(b,old);this.db.prepare('UPDATE cafe_catalog SET body=?,revision=revision+1 WHERE id=1').run(JSON.stringify(d));this.audit(u,'catalog',{revision:old.revision+1});return this.catalog();});}
  publicAvailability(now=Date.now()){
   const s=this.catalog().settings,clock=new Date(now+10800000).toISOString().slice(11,16),active=this.db.prepare("SELECT w.id FROM employee_work_sessions w JOIN admin_users u ON u.id=w.user_id WHERE u.login<>'admin' AND w.started_at<=? AND (w.ended_at IS NULL OR w.ended_at>?) LIMIT 1").get(now,now);
   const reason=!s.enabled?'paused':clock<s.open||clock>=s.close?'outside_hours':!active?'not_open':null;
   const messages={paused:'Приём заказов кафе временно приостановлен.',outside_hours:`Заказы принимаем с ${s.open} до ${s.close} (Москва).`,not_open:'Кафе ещё не открыло приём заказов.'};
   return {accepting:reason===null,reason,message:reason?messages[reason]+' Уточнить можно по телефону 8(903) 963-31-35':''};
  }
 publicMenu(){const version=this.db.prepare('SELECT total_changes() n').get().n+':'+this.db.prepare('PRAGMA data_version').get().data_version;if(this.menuCache?.version===version)return {...structuredClone(this.menuCache.menu),ordering:this.publicAvailability()};const d=this.catalog();d.categories=d.categories.filter(c=>c.active).sort((a,b)=>a.sort-b.sort);d.items=d.items.filter(i=>i.active&&d.categories.some(c=>c.id===i.categoryId)).sort((a,b)=>a.sort-b.sort);d.groups=d.groups.filter(g=>g.active);const menu=this.stock.menu(d);this.menuCache={version,menu:structuredClone(menu)};return {...menu,ordering:this.publicAvailability()};}
 places(u){requireStaff(u);return this.db.prepare('SELECT * FROM cafe_places ORDER BY id').all();}
 placeForToken(value){if(!/^[a-f0-9]{48}$/.test(value||''))fail('Ссылка места недействительна.',404);const p=this.db.prepare('SELECT id,name,type FROM cafe_places WHERE token=? AND active=1').get(value);if(!p)fail('Ссылка места выключена или заменена. Откройте новое меню на столе.',404);return p;}
 savePlace(b,u){requireAdmin(u);return this.transaction(()=>{const name=str(b.name,80);if(!['table','lounge','other'].includes(b.type)||typeof b.active!=='boolean')fail('Проверьте место.');let id=b.id;if(id){const old=this.db.prepare('SELECT * FROM cafe_places WHERE id=?').get(integer(id,1));if(!old||b.revision!==old.revision)fail('Место изменено. Обновите список.',409);this.db.prepare('UPDATE cafe_places SET name=?,type=?,active=?,token=?,revision=revision+1 WHERE id=?').run(name,b.type,b.active?1:0,b.rotate?token():old.token,id);}else{id=Number(this.db.prepare('INSERT INTO cafe_places(name,type,token,active) VALUES(?,?,?,?)').run(name,b.type,token(),b.active?1:0).lastInsertRowid);}this.audit(u,'place',{id,rotate:!!b.rotate});return this.places(u);});}
 complimentaryOptions(u){requireStaff(u);return {people:this.admin.workforce.people().filter(p=>u.role==='admin'||p.id===u.id).map(p=>({id:p.id,name:p.name})),canGift:u.role==='admin'};}
 complimentary(b,u){
  if(b.complimentary===undefined||b.complimentary===null)return null;
  requireStaff(u);const c=b.complimentary;
  if(!c||typeof c!=='object'||!['employee','owner','guest'].includes(c.reason))fail('Укажите причину бесплатной выдачи.');
  if(u.role!=='admin'&&(c.reason!=='employee'||c.recipientId!==u.id))fail('Сотрудник может оформить бесплатно только на себя.',403);
  let recipient=null;
  if(c.reason==='employee'){recipient=this.admin.workforce.people().find(p=>p.id===c.recipientId);if(!recipient)fail('Выберите сотрудника.');}
  const comment=str(c.comment||'',200,c.reason==='guest');
  return {reason:c.reason,recipientId:recipient?.id||null,recipientName:recipient?.name||(c.reason==='owner'?'Владелец':'Гость'),comment,authorizedBy:u.id};
 }
 authorizeComplimentaryAppend(r,u){if(r.details.complimentary&&u.role!=='admin'&&(r.details.complimentary.reason!=='employee'||r.details.complimentary.recipientId!==u.id))fail('Нельзя дополнять чужой бесплатный заказ.',403);}
  authorizeAppend(r){if(this.stock.prepared(r))fail('Заказ уже начали готовить. Добавьте позиции отдельным заказом.',409);}
 resolve(b,u,now){
  if(u)requireStaff(u);const complimentary=this.complimentary(b,u);
  if(b.quickSale===true){requireStaff(u);if(b.fulfillment!=='pickup'||b.requestedAt||b.appendId)fail('Быстрая продажа доступна только у стойки.');}
  const s=this.catalog().settings;if(!s.enabled)fail('Приём заказов временно приостановлен.',409);
  const local=new Date(now+10800000).toISOString(),clock=local.slice(11,16);if(!u&&(clock<s.open||clock>=s.close))fail(`Заказы принимаем с ${s.open} до ${s.close} (Москва).`,409);
  if(!s.fulfillments.includes(b.fulfillment)||!(u&&b.payment==='unspecified')&&!s.payments.includes(b.payment))fail('Выберите способ получения и оплаты.');
  let place=null;if(u){requireStaff(u);if(b.placeId){place=this.db.prepare('SELECT id,name,type FROM cafe_places WHERE id=? AND active=1').get(integer(b.placeId,1));if(!place)fail('Место недоступно.');}}else{if(b.placeId)fail('Используйте ссылку на столе.');if(b.placeToken)place=this.placeForToken(b.placeToken);}
  if(b.fulfillment==='place'&&!place)fail('Откройте ссылку на столе или выберите место.');if(place&&b.fulfillment!=='place')fail('Сбросьте место, чтобы выбрать другой способ получения.');
  if(!u&&b.consent!==true)fail('Подтвердите согласие на обработку заказа.');
  const name=str(b.name|| (u?'Гость':''),80),p=b.phone?phone(b.phone):u?'':phone('');
  const details={name,phone:p,fulfillment:b.fulfillment,payment:b.payment,place:place?{id:place.id,name:place.name}:null,yacht:'',location:'',comment:str(b.comment||'',400,false),requestedAt:null,prepMinutes:s.prepMinutes,consent:!u,consentVersion:!u?'cafe-2026-09-22':null};
  if(complimentary)details.complimentary=complimentary;
  if(b.fulfillment==='house'){details.house=str(String(b.house??''),120);details.location='Домик: '+details.house;}
  if(b.fulfillment==='yacht'){details.yacht=str(b.yacht,100);details.location=str(b.location,160);}else if(b.fulfillment!=='house')details.location=str(b.location||'',160,false);
  if(b.requestedAt){const t=Date.parse(b.requestedAt+':00+03:00');if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.requestedAt)||!Number.isFinite(t)||t<now+s.prepMinutes*60000||!u&&(b.requestedAt.slice(0,10)!==day(now)||b.requestedAt.slice(11)<s.open||b.requestedAt.slice(11)>=s.close))fail(u?'Выберите будущее время с учётом приготовления.':'Выберите время сегодня в часы работы с учётом приготовления.');details.requestedAt=b.requestedAt;}
  return {details,place};
 }
 calculate(lines,fulfillment,u=null){
  if(!Array.isArray(lines)||!lines.length||lines.length>40)fail('В корзине должно быть от 1 до 40 позиций.');const c=this.catalog();
  const items=lines.map(l=>{if(l.custom===true){requireStaff(u);const name=str(l.name,120),quantity=integer(l.quantity,1,20),unitCents=integer(l.unitCents,1,10000000);if(!/^manual-[a-f0-9-]{36}$/.test(l.itemId||''))fail('Обновите свободную позицию.');return {custom:true,itemId:l.itemId,name,quantity,unitCents,totalCents:unitCents*quantity,basePriceCents:unitCents,variant:null,modifiers:[],comment:str(l.comment||'',200,false),station:'none'};}const x=c.items.find(x=>x.id===l.itemId);if(!x||!x.active||x.soldOut||!c.categories.some(k=>k.id===x.categoryId&&k.active))fail('Позиция недоступна. Обновите корзину.',409);if(x.restricted||x.station==='hookah')fail('Эта позиция доступна только для просмотра.',400);if(fulfillment==='yacht'&&!x.yacht)fail(`«${x.name}» недоступно для доставки на яхту.`,409);const quantity=integer(l.quantity,1,20);let price=x.priceCents,variant=null;
   if(x.variants.some(v=>v.active)){variant=x.variants.find(v=>v.id===l.variantId&&v.active);if(!variant)fail('Выберите доступный вариант для «'+x.name+'».');price+=variant.priceCents;}else if(l.variantId)fail('Вариант не найден.');
   const selected=l.optionIds||[];if(!Array.isArray(selected)||selected.length>60||new Set(selected).size!==selected.length)fail('Проверьте добавки.');const modifiers=[];
   for(const id of selected){let found=false;for(const g of c.groups.filter(g=>g.active&&x.groupIds.includes(g.id))){const o=g.options.find(o=>o.id===id&&o.active&&!o.soldOut);if(o){modifiers.push({groupId:g.id,groupName:g.name,optionId:o.id,name:o.name,priceCents:o.priceCents});price+=o.priceCents;found=true;break;}}if(!found)fail('Добавка недоступна. Обновите корзину.',409);}
   for(const g of c.groups.filter(g=>g.active&&x.groupIds.includes(g.id))){const count=modifiers.filter(m=>m.groupId===g.id).length;if(count<g.min||count>g.max)fail(`«${g.name}»: выберите от ${g.min} до ${g.max}.`);}
   return {itemId:x.id,name:x.name,basePriceCents:x.priceCents,variant:variant?copy(variant):null,modifiers,quantity,unitCents:price,totalCents:price*quantity,comment:str(l.comment||'',200,false),station:x.station,...(x.blockQuickSale===true?{blockQuickSale:true}:{})};
  });const totalCents=items.reduce((n,i)=>n+i.totalCents,0);integer(totalCents,0,100000000);return {items,totalCents};
 }
 priced(lines,details,existing=null,u=null){const q=this.calculate(lines,details.fulfillment,u);if(details.complimentary)return {...q,menuValueCents:q.totalCents,totalCents:0,...(details.fulfillment==='house'?{deliveryCents:0,subtotalCents:q.totalCents}:{})};if(details.fulfillment!=='house')return q;const subtotal=q.totalCents+(existing?.details.items.reduce((n,i)=>n+i.totalCents,0)||0),deliveryCents=subtotal>=100000?0:30000;return {...q,subtotalCents:subtotal,deliveryCents,totalCents:q.totalCents+deliveryCents-(existing?.details.deliveryCents||0)};}
 assertQuickSale(b,items){
  if(b.quickSale!==true)return;
  const catalog=this.catalog(),blocked=items.filter(line=>!line.custom&&catalog.items.find(item=>item.id===line.itemId)?.blockQuickSale===true);
  if(blocked.length)fail('Нельзя сразу выдать: '+[...new Set(blocked.map(item=>item.name))].join(', ')+'. Выберите «В работу».',409);
 }
  quote(b,u,now=Date.now()){const {details}=this.resolve(b,u,now);let existing=null;if(b.appendId){requireStaff(u);existing=this.order(integer(b.appendId,1),u);this.authorizeComplimentaryAppend(existing,u);if(b.complimentary)fail('Для дозаказа используется исходный вид оплаты.');if(existing.revision!==b.appendRevision||['CANCELLED','DELIVERED'].includes(existing.status))fail('Заказ закрыт или изменён.',409);this.authorizeAppend(existing);}const q=this.priced(b.items,existing?.details||details,existing,u);this.assertQuickSale(b,q.items);this.stock.check(q.items);return {...q,prepMinutes:details.prepMinutes};}
 limit(key,now,max){const k=hash(key);const row=this.db.prepare('SELECT * FROM cafe_limits WHERE key=?').get(k);if(row&&row.expires>now&&row.count>=max)fail('Слишком много заказов. Повторите немного позже.',429);this.db.prepare('INSERT INTO cafe_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END').run(k,now+600000,now,now);}
 event(orderId,kind,u,body,now,requestId=null){const id=Number(this.db.prepare('INSERT INTO cafe_order_events(order_id,kind,actor,body,created,request_id) VALUES(?,?,?,?,?,?)').run(orderId,kind,u?.id||null,JSON.stringify(body),now,requestId).lastInsertRowid);const pending=JSON.parse(this.db.prepare('SELECT details FROM cafe_orders WHERE id=?').get(orderId).details).pendingKitchen;if(!pending)this.admin.printStore?.cafeEvent(id,u,now);return id;}
 create(b,u=null,ip='local',now=Date.now()){
  if(b.complimentary!==undefined)this.complimentary(b,u);
  if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))fail('Обновите форму заказа.');const fingerprint=hash(stable(b));
  return this.transaction(()=>{const old=this.db.prepare('SELECT * FROM cafe_orders WHERE request_id=?').get(b.requestId);if(old){if(old.fingerprint!==fingerprint)fail('Этот запрос уже использован. Обновите заказ.',409);return {...this.receipt(old),duplicate:true};}
   const {details,place}=this.resolve(b,u,now),q=this.priced(b.items,details,null,u);this.assertQuickSale(b,q.items);if(b.expectedTotalCents!==q.totalCents)fail('Цена изменилась. Проверьте обновлённый итог.',409);
   if(b.guestBillId!==undefined){if(!u||!this.admin.guestBills||details.complimentary)fail('Нельзя добавить заказ в счёт.',403);const bill=this.admin.guestBills.editable(b.guestBillId,u);details.guestBillId=bill.id;details.guestDeferred=!!bill.deferred;details.terminalPaymentRequired=true;details.pendingKitchen=!bill.deferred;details.terminalQuickSale=!bill.deferred&&b.quickSale===true;}
   if(!u&&this.admin.cashLedger?.enabled){details.terminalPaymentRequired=true;details.manualPaymentRequired=true;}
    if(!u){this.limit('ip:'+ip,now,8);this.limit('phone:'+details.phone,now,5);}else this.limit('staff:'+u.id,now,120);let clientId=null;if(details.phone)clientId=this.sms.client(details.name,details.phone,now,false).id;
   if(u&&!details.guestBillId&&(this.terminal?.enabled||this.terminal&&(b.cashRequested===true||b.manualPaidRequested===true))&&!details.complimentary&&q.totalCents>0){details.terminalPaymentRequired=true;details.terminalQuickSale=b.quickSale===true;details.pendingKitchen=!!u;}if(details.complimentary)details.complimentary.menuValueCents=q.menuValueCents;details.items=q.items;if(q.deliveryCents!==undefined){details.deliveryCents=q.deliveryCents;details.subtotalCents=q.subtotalCents;}const access=token(),source=u?u.role==='admin'?'admin':'waiter':place?'customer_nfc':'customer_web';
   const id=Number(this.db.prepare('INSERT INTO cafe_orders(request_id,fingerprint,public_token,client_id,actor,source,place_id,details,total_cents,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(b.requestId,fingerprint,access,clientId,u?.id||null,source,place?.id||null,JSON.stringify(details),q.totalCents,now,now).lastInsertRowid);
   if(details.guestBillId)this.admin.guestBills.attach(details.guestBillId,'cafe',id,q.totalCents,u);this.stock.consume(id,q.items,u,now);if(b.quickSale===true&&!details.terminalPaymentRequired){this.db.prepare("UPDATE cafe_orders SET status='DELIVERED',revision=1 WHERE id=?").run(id);this.event(id,'DELIVERED',u,{quickSale:true},now);}if(!details.pendingKitchen){const e=this.event(id,'NEW',u,{items:q.items,totalCents:q.totalCents,...(q.deliveryCents!==undefined?{deliveryCents:q.deliveryCents}:{})},now);this.db.prepare('INSERT INTO cafe_notifications(event_id,due) VALUES(?,?)').run(e,now);}return this.receipt(this.db.prepare('SELECT * FROM cafe_orders WHERE id=?').get(id));
  });
 }
 receipt(r){return {id:r.id,displayNumber:cafeNumber(r.id),token:r.public_token,status:r.status,totalCents:r.total_cents,details:JSON.parse(r.details),created:r.created,revision:r.revision};}
 publicOrder(t){if(!/^[a-f0-9]{48}$/.test(t||''))fail('Заказ не найден.',404);const r=this.db.prepare('SELECT * FROM cafe_orders WHERE public_token=?').get(t);if(!r)fail('Заказ не найден.',404);const result=this.receipt(r);delete result.details.phone;delete result.details.name;return result;}
  order(id,u){
   requireStaff(u);const r=this.db.prepare('SELECT * FROM cafe_orders WHERE id=?').get(integer(id,1));if(!r)fail('Заказ не найден.',404);
   const events=this.db.prepare('SELECT e.id,e.kind,e.created,e.body,u.login actor FROM cafe_order_events e LEFT JOIN admin_users u ON u.id=e.actor WHERE e.order_id=? ORDER BY e.id').all(id).map(e=>{const {body,...event}=e;if(e.kind==='CANCELLED'){const d=JSON.parse(body);event.comment=d.comment||'';event.stock=d.stock||null;}return event;});
   return {...r,displayNumber:cafeNumber(r.id),terminalPayment:this.terminal?.payment(r.id)||null,refundedCents:this.db.prepare("SELECT coalesce(sum(amount_cents),0) n FROM customer_refunds WHERE kind='cafe' AND source_id=?").get(r.id).n,details:JSON.parse(r.details),stock:this.stock.summary(r.id),events,notifications:this.db.prepare('SELECT n.id,n.status,n.attempts,n.last_error FROM cafe_notifications n JOIN cafe_order_events e ON e.id=n.event_id WHERE e.order_id=?').all(id)};
  }
 orders(params,u){requireStaff(u);const date=params.get('date')||day(Date.now()),status=params.get('status')||'',source=params.get('source')||'',q=(params.get('q')||'').toLowerCase().slice(0,100);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('Проверьте дату.');const start=Date.parse(date+'T00:00:00+03:00');const compact=params.get('compact')==='1';const rows=this.db.prepare('SELECT * FROM cafe_orders WHERE (created>=? AND created<?) OR status NOT IN (\'DELIVERED\',\'CANCELLED\') OR (status<>\'CANCELLED\' AND json_extract(details,\'$.terminalPaymentRequired\')=1 AND json_extract(details,\'$.terminalPaidAt\') IS NULL) ORDER BY created DESC,id DESC LIMIT 500').all(start,start+86400000).map(r=>({...r,displayNumber:cafeNumber(r.id),details:JSON.parse(r.details)}));const payments=this.terminal?.payments?.(rows),refunds=new Map(this.db.prepare("SELECT source_id,sum(amount_cents) n FROM customer_refunds WHERE kind='cafe' GROUP BY source_id").all().map(r=>[r.source_id,r.n]));for(let i=0;i<rows.length;i++){const r=rows[i];rows[i]=compact?{...r,terminalPayment:payments?payments.get(r.id)||null:this.terminal?.payment(r.id)||null,refundedCents:refunds.get(r.id)||0}:this.order(r.id,u);}return {refundsCents:this.admin.refunds.total(date,Date.now(),'cafe'),rows:rows.filter(r=>(!status||r.status===status)&&(!source||r.source===source)&&(!params.get('place')||String(r.place_id)===params.get('place'))&&(!q||String(r.id)===q||r.details.name.toLowerCase().includes(q)||q.replace(/\D/g,'').length>=4&&r.details.phone.includes(q.replace(/\D/g,'')))),complimentaryCents:rows.filter(r=>r.created>=start&&r.created<start+86400000&&r.status!=='CANCELLED').reduce((n,r)=>n+(r.details.complimentary?.menuValueCents||0),0),totalCents:rows.filter(r=>r.created>=start&&r.created<start+86400000&&(r.status!=='CANCELLED'||r.details.terminalPaidAt)).reduce((n,r)=>n+r.total_cents,0)};}
  status(b,u,now=Date.now()){
   requireStaff(u);return this.transaction(()=>{
    const r=this.order(b.id,u);if(r.status===b.status)return r;
    if(r.details.guestBillId&&b.status==='CANCELLED')fail('Отмените неоплаченный счёт целиком в «Счета гостей»; для оплаченного оформите возврат.');
    if(r.details.terminalPaymentRequired&&!r.details.terminalPaidAt&&!r.details.manualPaymentRequired&&!r.details.guestDeferred&&b.status!=='CANCELLED')fail('Сначала примите оплату на кассе.',409);
    if(r.revision!==b.revision)fail('Заказ уже изменён. Обновите список.',409);
    if(b.status==='CANCELLED'&&this.terminal?.locked(r.id)&&!['done','cash_done','cancelled'].includes(r.terminalPayment?.state))fail('Оплата требует проверки. Проверьте статус оплаты и выберите подтверждённый результат; повторное списание заблокировано.',409);
    const paid=!!r.details.terminalPaidAt||r.status==='DELIVERED'&&!r.details.terminalPaymentRequired;
    if(b.status==='CANCELLED'&&paid&&!r.details.complimentary&&r.total_cents>r.refundedCents)fail('Заказ оплачен. Оформите возврат в карточке заказа — он сохранит правильный учёт денег.',409);
    if(b.status==='CANCELLED'&&paid&&!r.details.complimentary&&r.status==='DELIVERED')fail('Выданный оплаченный заказ остаётся выполненным. Денежный возврат хранится отдельно.',409);
    if(this.terminal?.locked(r.id)&&!(r.details.terminalPaidAt&&(b.status!=='CANCELLED'||r.refundedCents===r.total_cents&&['done','cash_done'].includes(r.terminalPayment?.state))))fail('Оплата требует проверки. Проверьте статус оплаты и выберите подтверждённый результат; повторное списание заблокировано.',409);
    if(!transitions[r.status]?.includes(b.status))fail('Недопустимый переход статуса.');
    if(b.status==='DELIVERED'&&r.status!=='READY'&&r.details.items.some(item=>item.blockQuickSale===true))fail('Сначала отметьте «Готов к выдаче», затем выдайте заказ.',409);
    if(b.status==='CANCELLED'&&b.prepared!==undefined&&typeof b.prepared!=='boolean')fail('Укажите, начали ли готовить заказ.');
    const comment=str(b.comment||'',200,false);
    if(b.status==='CANCELLED'&&b.prepared===true&&!this.stock.prepared(r)){this.event(r.id,'COOKING',u,{manualPreparationConfirmation:true},now);r.events.push({kind:'COOKING'});}
    const stock=b.status==='CANCELLED'?this.stock.cancel(r,u,now):null;
    this.db.prepare('UPDATE cafe_orders SET status=?,updated=?,revision=revision+1 WHERE id=?').run(b.status,now,r.id);this.event(r.id,b.status,u,{comment,stock},now);return this.order(r.id,u);
   });
  }
  append(b,u,now=Date.now()){requireStaff(u);if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))fail('Обновите форму.');return this.transaction(()=>{const old=this.db.prepare('SELECT * FROM cafe_order_events WHERE request_id=?').get(b.requestId);if(old){if(old.order_id!==b.id||JSON.parse(old.body).fingerprint!==hash(stable(b)))fail('Запрос уже использован.',409);return this.order(b.id,u);}const r=this.order(b.id,u);if(r.details.guestBillId)fail('Добавьте новый заказ в тот же счёт гостя.');if(this.terminal?.locked(r.id))fail('Оплата уже запущена. Дозаказ оформите отдельно.',409);this.authorizeComplimentaryAppend(r,u);if(b.complimentary)fail('Нельзя изменить вид оплаты дозаказом.');if(r.revision!==b.revision||['CANCELLED','DELIVERED'].includes(r.status))fail('Заказ закрыт или изменён.',409);this.authorizeAppend(r);const q=this.priced(b.items,r.details,r,u);if(q.totalCents!==b.expectedTotalCents)fail('Проверьте новую сумму.',409);if(r.details.items.length+q.items.length>100)fail('Слишком много позиций. Создайте отдельный заказ.');this.stock.consume(r.id,q.items,u,now);r.details.items.push(...q.items);if(r.details.complimentary)r.details.complimentary.menuValueCents+=q.menuValueCents;if(q.deliveryCents!==undefined){r.details.deliveryCents=q.deliveryCents;r.details.subtotalCents=q.subtotalCents;}this.db.prepare("UPDATE cafe_orders SET details=?,total_cents=total_cents+?,revision=revision+1,updated=?,status='ACCEPTED' WHERE id=?").run(JSON.stringify(r.details),q.totalCents,now,r.id);const e=this.event(r.id,'ADD',u,{...q,fingerprint:hash(stable(b))},now,b.requestId);if(!r.details.pendingKitchen)this.db.prepare('INSERT INTO cafe_notifications(event_id,due) VALUES(?,?)').run(e,now);return this.order(r.id,u);});}
 location(b,u,now=Date.now()){
  requireStaff(u);if(!/^[a-f0-9-]{36}$/.test(b.requestId||''))fail('Обновите форму.');
  return this.transaction(()=>{const fingerprint=hash(stable(b)),old=this.db.prepare('SELECT * FROM cafe_order_events WHERE request_id=?').get(b.requestId);if(old){if(old.order_id!==b.id||old.kind!=='LOCATION'||JSON.parse(old.body).fingerprint!==fingerprint)fail('Запрос уже использован.',409);return this.order(b.id,u);}
   const r=this.order(b.id,u);if(['CANCELLED','DELIVERED'].includes(r.status)||r.revision!==b.revision)fail('Заказ закрыт или изменён. Обновите карточку.',409);if(!['lounge','place'].includes(r.details.fulfillment))fail('Место уточняется для заказа к столу / в лаунж.');
   const location=str(b.location,160);if(location===(r.details.place?.name||r.details.location||'').trim())return r;const before={place:r.details.place,location:r.details.location,fulfillment:r.details.fulfillment};r.details.location=location;r.details.place=null;r.details.fulfillment='lounge';
   this.db.prepare('UPDATE cafe_orders SET details=?,place_id=NULL,revision=revision+1,updated=? WHERE id=?').run(JSON.stringify(r.details),now,r.id);
   const event=this.event(r.id,'LOCATION',u,{fingerprint,before,location,items:[],totalCents:0},now,b.requestId);if(!r.details.pendingKitchen)this.db.prepare('INSERT INTO cafe_notifications(event_id,due) VALUES(?,?)').run(event,now);this.audit(u,'order_location',{orderId:r.id,before,location});return this.order(r.id,u);
  });
 }
 staff(u){requireAdmin(u);return this.db.prepare("SELECT id,login,role FROM admin_users WHERE role='waiter' AND NOT EXISTS(SELECT 1 FROM archived_accounts aa WHERE aa.user_id=admin_users.id) ORDER BY login").all();}
 saveStaff(b,u){requireAdmin(u);if(!/^[a-z][a-z0-9_-]{2,30}$/.test(b.login)||['admin','station'].includes(b.login)||typeof b.password!=='string'||b.password.length<4||b.password.length>128)fail('Логин: 3–31 латинских символов. Пароль: 4–128 символов.');const salt=randomBytes(16).toString('hex'),pw=salt+':'+scryptSync(b.password,salt,64).toString('hex');return this.transaction(()=>{const r=this.db.prepare('SELECT * FROM admin_users WHERE login=?').get(b.login);if(r&&this.admin.accounts.archived(r.id))fail('Этот логин архивирован. Используйте другой логин.');if(r&&r.role!=='waiter')fail('Этот логин занят.');if(r){this.db.prepare('UPDATE admin_users SET password=? WHERE id=?').run(pw,r.id);this.db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(r.id);}else this.db.prepare("INSERT INTO admin_users(login,role,password) VALUES(?,'waiter',?)").run(b.login,pw);this.audit(u,'waiter',{login:b.login});return this.staff(u);});}
 retryNotification(id,u){requireAdmin(u);this.db.prepare("UPDATE cafe_notifications SET status='queued',due=?,attempts=0 WHERE id=? AND status IN ('error','unknown')").run(Date.now(),integer(id,1));this.audit(u,'notification_retry',{id});}
 async tick(now=Date.now()){
  if(this.busy)return;this.busy=true;try{
   this.db.prepare("UPDATE cafe_notifications SET status='unknown',last_error='Отправка прервалась. Проверьте Telegram перед повтором.' WHERE status='sending' AND claimed<?").run(now-60000);
   for(const job of this.db.prepare("SELECT n.*,e.order_id,e.kind,e.body FROM cafe_notifications n JOIN cafe_order_events e ON e.id=n.event_id WHERE n.status='queued' AND n.due<=? ORDER BY n.id LIMIT 10").all(now)){
    const env=this.env;if(!env.TELEGRAM_BOT_TOKEN||!/^\d+$/.test(env.TELEGRAM_CHAT_ID||'')){this.db.prepare("UPDATE cafe_notifications SET status='error',last_error='Telegram владельца не настроен.' WHERE id=?").run(job.id);continue;}
    if(!this.db.prepare("UPDATE cafe_notifications SET status='sending',claimed=?,attempts=attempts+1 WHERE id=? AND status='queued'").run(now,job.id).changes)continue;
    const order=this.db.prepare('SELECT * FROM cafe_orders WHERE id=?').get(job.order_id),d=JSON.parse(order.details),batch=JSON.parse(job.body),place=d.place?.name||({house:'Домик в яхт клубе: '+d.house,pickup:'Заберут в кафе',lounge:'Лаунж-зона',yacht:'На яхту / катер'}[d.fulfillment]);
    const text=[`СТАРТ — ${job.kind==='LOCATION'?'уточнение места заказа':job.kind==='ADD'?'дозаказ к':'новый заказ'} №${order.id}`,d.complimentary?'БЕСПЛАТНО · '+d.complimentary.recipientName:'',place,d.yacht,d.location,`${d.name}${d.phone?' · +'+d.phone:''}`,d.requestedAt?'К '+d.requestedAt.replace('T',' '):'Как можно скорее',...batch.items.map(i=>`${i.quantity} × ${i.name}${i.variant?' ('+i.variant.name+')':''}${i.modifiers.length?'\n  + '+i.modifiers.map(m=>m.name).join(', '):''}${i.comment?'\n  '+i.comment:''}`),batch.deliveryCents!==undefined?'Доставка официантом: '+rub(batch.deliveryCents):'',`Сумма ${job.kind==='ADD'?'дозаказа':'заказа'}: ${rub(batch.totalCents)}`,d.complimentary?'К оплате: 0 ₽':d.payment==='unspecified'?'Оплата без разделения на способы':d.payment==='cash'?'Наличными при получении':'Картой при получении',d.comment].filter(Boolean).join('\n');
    try{const origin=this.env.SITE_ORIGIN||'https://spotsup.ru';const response=await this.request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:(job.kind==='LOCATION'?[`СТАРТ — место заказа №${order.id}`,batch.location,'Это уточнение места, не новый заказ.'].join('\n'):text).slice(0,3900),protect_content:true,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:'Открыть заказ',url:origin+'/admin/cafe/#order-'+order.id}]]}}),signal:AbortSignal.timeout(10000)});const body=await response.json();if(response.ok&&body.ok===true)this.db.prepare("UPDATE cafe_notifications SET status='sent',last_error='' WHERE id=?").run(job.id);else if(body.ok===false){this.db.prepare('UPDATE cafe_notifications SET status=?,due=?,last_error=? WHERE id=?').run(job.attempts<3?'queued':'error',now+Math.min(900000,30000*2**job.attempts),'Telegram отклонил отправку.',job.id);}else throw Error('unknown');}
    catch{this.db.prepare("UPDATE cafe_notifications SET status='unknown',last_error='Результат отправки неизвестен. Проверьте Telegram перед повтором.' WHERE id=?").run(job.id);}
   }
  }finally{this.busy=false;}
 }
}

export function cafeHandler(store,admin,origin){return async(req,res,url)=>{
 const internal=url.pathname.startsWith('/api/admin/cafe/'),external=url.pathname.startsWith('/api/cafe/');if(!internal&&!external)return false;
 const reply=(status,data,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});res.end(typeof data==='string'?data:JSON.stringify(data));return true;};
 try{if(!store)fail('Кафе временно недоступно.',503);let user=null;if(internal){const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-start_session='))?.slice(21);user=admin.user(cookie);requireStaff(user);}
  const p=url.pathname.replace(/^\/api\/(admin\/)?cafe\//,'');
  if(req.method==='GET'){
   if(internal&&p==='stock')return reply(200,store.stock.config(user));
   if(p==='menu')return reply(200,internal?store.catalog():store.publicMenu());
   if(!internal&&p==='place')return reply(200,store.placeForToken(url.searchParams.get('token')));
   if(!internal&&p==='order')return reply(200,store.publicOrder(url.searchParams.get('token')));
   if(internal&&p==='places')return reply(200,{items:store.places(user)});
   if(internal&&p==='complimentary-options')return reply(200,store.complimentaryOptions(user));
   if(internal&&p==='staff')return reply(200,{items:store.staff(user)});
   if(internal&&p==='badge')return reply(200,{count:store.db.prepare("SELECT count(*) n FROM cafe_orders WHERE status IN ('NEW','ACCEPTED','COOKING','READY')").get().n});
   if(internal&&p==='orders'){if(url.searchParams.get('list')==='1'){requireStaff(user);store.listView??=new CafeList(store);return reply(200,store.listView.read(url.searchParams));}return reply(200,{...store.orders(url.searchParams,user),terminalIssues:store.terminal?.terminalIssues()||[]});}
   if(internal&&p==='order')return reply(200,store.order(Number(url.searchParams.get('id')),user));
    if(internal&&p==='export'){
     requireAdmin(user);const esc=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"',stockNames={retained:'Ингредиенты не восстановлены',restored:'Ингредиенты восстановлены',mixed:'Ингредиенты восстановлены частично',none:'Без складского расхода'};
     const rows=store.orders(url.searchParams,user).rows;
     return reply(200,'\ufeff'+[['Номер','Дата','Статус','Клиент','Телефон','Место','Сумма, руб.','За счёт заведения','Получатель','Стоимость по меню, руб.','Возвращено денег, руб.','Склад при отмене','Не восстановлено','Причина отмены'],...rows.map(r=>[r.id,new Date(r.created).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}),cafeStatuses[r.status],r.details.name,r.details.phone,r.details.place?.name||r.details.fulfillment,(r.total_cents/100).toFixed(2),r.details.complimentary?.reason||'',r.details.complimentary?.recipientName||'',r.details.complimentary?(r.details.complimentary.menuValueCents/100).toFixed(2):'',(r.refundedCents/100).toFixed(2),r.status==='CANCELLED'?stockNames[r.stock.state]:'',r.status==='CANCELLED'?r.stock.items.filter(i=>i.retainedMilli>0).map(i=>i.name+': '+i.retained+' '+i.unit).join(', '):'',r.events.filter(e=>e.kind==='CANCELLED').map(e=>e.comment).join('; ')])].map(r=>r.map(esc).join(';')).join('\r\n'),{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="cafe-orders.csv"'});
    }
   return reply(404,{error:'Не найдено.'});
  }
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))fail('Недопустимый источник запроса.',403);
  let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>(internal?262144:32768))fail('Слишком большой запрос.',413);chunks.push(c);}let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Неверный запрос.');}if(!b||typeof b!=='object'||Array.isArray(b))fail('Неверный запрос.');
  if(!internal&&['quote','orders'].includes(p)){const availability=store.publicAvailability();const existing=p==='orders'&&typeof b.requestId==='string'&&store.db.prepare('SELECT id FROM cafe_orders WHERE request_id=?').get(b.requestId);if(!availability.accepting&&!existing)throw Object.assign(Error(availability.message),{status:409,cafeClosed:true});}
  if(internal&&(['quote','orders','append'].includes(p)||p==='status'&&b.status==='DELIVERED'))admin.workforce.requireOnDuty(Date.now(),user);
  if(internal&&p==='manual-paid'){if(!store.terminal)fail('Касса не подключена.',503);return reply(200,store.terminal.manualPaid(b,user));}
  if(internal&&p==='confirm-receipt'){if(!store.terminal)fail('Касса не подключена.',503);return reply(200,store.terminal.confirmReceipt(b,user));}
  if(internal&&p==='reconcile-payment'){if(!store.terminal)fail('Касса не подключена.',503);return reply(200,await store.terminal.reconcile(b,user));}
  if(internal&&p==='pay'){if(!store.terminal)fail('Касса не подключена.',503);return reply(200,await store.terminal.begin(b,user));}
  if(internal&&p==='stock')return reply(200,store.stock.save(b,user));
  if(p==='stock-check'){const q=store.calculate(b.items,'pickup',user);store.stock.check(q.items);return reply(200,{ok:true});}
  if(p==='quote')return reply(200,store.quote(b,user));
  if(p==='orders'){const result=store.create(b,user,req.headers['x-real-ip']||req.socket.remoteAddress);void store.tick().catch(()=>console.error('Cafe notification worker failed'));return reply(200,result);}
  if(internal&&p==='menu')return reply(200,store.saveCatalog(b,user));
  if(internal&&p==='places')return reply(200,{items:store.savePlace(b,user)});
  if(internal&&p==='status')return reply(200,store.status(b,user));
  if(internal&&p==='location'){const result=store.location(b,user);void store.tick().catch(()=>console.error('Cafe notification worker failed'));return reply(200,result);}
  if(internal&&p==='append'){const result=store.append(b,user);void store.tick().catch(()=>console.error('Cafe notification worker failed'));return reply(200,result);}
  if(internal&&p==='staff')return reply(200,{items:store.saveStaff(b,user)});
  if(internal&&p==='notify'){store.retryNotification(b.id,user);void store.tick().catch(()=>console.error('Cafe notification worker failed'));return reply(200,{ok:true});}
  return reply(404,{error:'Не найдено.'});
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось выполнить операцию кафе.',...(e.cafeClosed?{cafeClosed:true}:{}),...(e.stockCode?{stockCode:e.stockCode,available:e.available,itemId:e.itemId}:{})});}
};}
