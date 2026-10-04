import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const str=(v,max=160,multiline=false)=>{if(typeof v!=='string'||v.length>max||(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f]/:/[\x00-\x1f]/).test(v))fail('Проверьте текстовые поля.');return v.trim();};
const required=(v,max)=>{const s=str(v,max);if(!s)fail('Заполните название, категорию и единицу.');return s;};
const int=(v,min=0)=>{if(!Number.isSafeInteger(v)||v<min)fail('Неверный идентификатор или версия.');return v;};
const staff=u=>{if(!['admin','staff','waiter'].includes(u?.role))fail('Войдите в админку.',401);};
const owner=u=>{staff(u);if(u.role!=='admin')fail('Изменение склада доступно только admin.',403);};
const canAdjust=u=>['admin','staff','waiter'].includes(u?.role);
const stockOperator=u=>{staff(u);if(!canAdjust(u))fail('Нет доступа к изменению остатков.',403);};
const MAX=999999999999;
export function quantity(v,nullable=false){
 if(nullable&&(v===null||v===''))return null;
 if(typeof v!=='string'||!/^\d{1,9}([.,]\d{1,3})?$/.test(v.trim()))fail('Количество: неотрицательное число, до 3 знаков после запятой.');
 const [whole,part='']=v.trim().replace(',','.').split('.');const n=Number(whole)*1000+Number(part.padEnd(3,'0'));if(n>MAX)fail('Слишком большое количество.');return n;
}
export const quantityText=n=>n===null?null:n<0?'-'+quantityText(-n):String(Math.trunc(n/1000))+(n%1000?'.'+String(n%1000).padStart(3,'0').replace(/0+$/,''):'');
export function normalizeInventoryName(value){
 const s=required(value).normalize('NFKC').toLowerCase().replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
 return ({'фанта':'fanta','корона':'corona extra','corona':'corona extra','корона экстра':'corona extra','кока кола':'coca cola','салфетка':'салфетки','мундштук':'мундштуки'})[s]||s;
}
const stable=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
const fingerprint=b=>createHash('sha256').update(stable(b)).digest('hex');
export function purchaseState(row){
 const configured=row.current_milli!==null&&row.minimum_milli!==null&&row.target_milli!==null;
 const buy=configured&&row.current_milli<=row.minimum_milli?Math.max(0,row.target_milli-row.current_milli):0;
 const manual=!!row.manual_buy&&(row.target_milli===null||row.current_milli===null||row.target_milli>row.current_milli);
 return {needsPurchase:!!row.active&&(buy>0||manual),buyQuantity:buy>0?quantityText(buy):manual&&row.current_milli!==null&&row.target_milli!==null?quantityText(row.target_milli-row.current_milli):null,urgent:row.current_milli===0,configured};
}

export class InventoryStore{
 constructor(admin,{seed=true}={}){
  this.admin=admin;this.db=admin.db;
  // Additive migration. No rental, customer or cafe order tables are modified.
  this.db.exec(readFileSync(new URL('./migrations/001-inventory.sql',import.meta.url),'utf8'));
  if(seed)this.seed(JSON.parse(readFileSync(new URL('./inventory-seed.json',import.meta.url),'utf8')));
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 dictionary(table,name){const normalized=normalizeInventoryName(name);this.db.prepare(`INSERT OR IGNORE INTO ${table}(name,normalized_name) VALUES(?,?)`).run(name,normalized);return this.db.prepare(`SELECT id FROM ${table} WHERE normalized_name=?`).get(normalized).id;}
 seed(data){this.transaction(()=>{
  if(this.db.prepare('SELECT version FROM inventory_migrations WHERE version=?').get('seed-v1'))return;
  for(const unit of data.units)this.dictionary('inventory_units',unit);
  for(const c of data.categories){const category=this.dictionary('inventory_categories',c.name);for(const item of c.items){
   const key=normalizeInventoryName(item.name);if(this.db.prepare('SELECT id FROM inventory_items WHERE normalized_name=?').get(key))continue;
   const now=Date.now(),unit=this.dictionary('inventory_units',item.unit),current=quantity(item.current??null,true);
   const id=Number(this.db.prepare('INSERT INTO inventory_items(name,normalized_name,category_id,unit_id,current_milli,comment,manual_buy,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(item.name,key,category,unit,current,item.comment||'',item.manualBuy?1:0,now).lastInsertRowid);
   const after=this.row(id);this.event(null,'SEED',null,after,'Исходный список владельца',null,null,now);
  }}
  this.db.prepare('INSERT INTO inventory_migrations VALUES(?,?)').run('seed-v1',Date.now());
 });}
 row(id){const r=this.db.prepare('SELECT i.*,c.name category,u.name unit,a.login updated_by_login FROM inventory_items i JOIN inventory_categories c ON c.id=i.category_id JOIN inventory_units u ON u.id=i.unit_id LEFT JOIN admin_users a ON a.id=i.updated_by WHERE i.id=?').get(int(id,1));if(!r)fail('Товар не найден.',404);return r;}
 serialize(r){return {...r,...purchaseState(r),current:quantityText(r.current_milli),minimum:quantityText(r.minimum_milli),target:quantityText(r.target_milli)};}
 catalog(u){staff(u);return {canEdit:u.role==='admin',canCreate:canAdjust(u),canAdjust:canAdjust(u),items:this.db.prepare('SELECT i.*,c.name category,u.name unit,a.login updated_by_login FROM inventory_items i JOIN inventory_categories c ON c.id=i.category_id JOIN inventory_units u ON u.id=i.unit_id LEFT JOIN admin_users a ON a.id=i.updated_by ORDER BY c.id,i.name').all().map(r=>this.serialize(r)),categories:this.db.prepare('SELECT id,name FROM inventory_categories ORDER BY id').all(),units:this.db.prepare('SELECT id,name FROM inventory_units ORDER BY id').all()};}
 summary(u,compact=false){staff(u);if(!compact)return {items:this.catalog(u).items.filter(i=>i.needsPurchase)};
  const where="i.active=1 AND ((i.current_milli IS NOT NULL AND i.minimum_milli IS NOT NULL AND i.target_milli IS NOT NULL AND i.current_milli<=i.minimum_milli AND i.target_milli>i.current_milli) OR (i.manual_buy<>0 AND (i.target_milli IS NULL OR i.current_milli IS NULL OR i.target_milli>i.current_milli)))";
  const count=this.db.prepare('SELECT count(*) n FROM inventory_items i WHERE '+where).get().n;
  const items=this.db.prepare('SELECT i.id,i.name,i.active,i.current_milli,i.minimum_milli,i.target_milli,i.manual_buy,u.name unit FROM inventory_items i JOIN inventory_units u ON u.id=i.unit_id WHERE '+where+' ORDER BY i.category_id,i.name LIMIT 4').all().map(r=>{const state=purchaseState(r);return {id:r.id,name:r.name,unit:r.unit,buyQuantity:state.buyQuantity,urgent:state.urgent};});return {count,items};
 }
 event(u,type,before,after,reason,requestId,hash,now=Date.now(),explicitDelta){
  const delta=explicitDelta!==undefined?explicitDelta:before?.current_milli!==null&&before?.current_milli!==undefined&&after.current_milli!==null&&before.unit_id===after.unit_id?after.current_milli-before.current_milli:null;
  this.db.prepare('INSERT INTO inventory_transactions(item_id,category_id,kind,delta_milli,before_json,after_json,reason,actor,actor_login,created_at,request_id,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(after.id,after.category_id,type,delta,JSON.stringify(before),JSON.stringify(after),reason,u?.id??null,u?.login||'Первичное заполнение',now,requestId,hash);
 }
 write(b,u,type,fn){if(type==='move'||type==='save'&&!b?.id)stockOperator(u);else owner(u);if(!b||typeof b!=='object'||Array.isArray(b))fail('Неверный запрос.');const requestId=required(b.requestId,80);if(!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))fail('Неверный ключ операции.');const hash=fingerprint({...b,type,actor:u.id});return this.transaction(()=>{const old=this.db.prepare('SELECT item_id,payload_hash FROM inventory_transactions WHERE request_id=?').get(requestId);if(old){if(old.payload_hash!==hash)fail('Ключ уже использован для другой операции.',409);return {item:this.serialize(this.row(old.item_id)),duplicate:true};}return fn(hash,requestId);});}
 validate(b){if(typeof b.unit==='string'&&/^[0-9\s.,+-]+$/.test(b.unit.trim()))fail('В поле единицы укажите шт., кг или л. Количество вводится в остаток.');const current=quantity(b.current,true),minimum=quantity(b.minimum,true),target=quantity(b.target,true);if(minimum!==null&&target!==null&&target<minimum)fail('Желаемый запас должен быть не меньше минимального.');if(typeof b.manualBuy!=='boolean')fail('Проверьте флаг закупки.');return {name:required(b.name),category:required(b.category,100),unit:required(b.unit,40),current,minimum,target,comment:str(b.comment||'',700,true),manual:b.manualBuy?1:0};}
 save(b,u){return this.write(b,u,'save',(hash,key)=>{
  const v=this.validate(b),before=b.id?this.row(b.id):null;if(before&&int(b.revision)!==before.revision)fail('Товар уже изменён. Обновите карточку.',409);
  const normalized=normalizeInventoryName(v.name),duplicate=this.db.prepare('SELECT id FROM inventory_items WHERE normalized_name=?').get(normalized);if(duplicate&&duplicate.id!==before?.id)fail('Такой товар уже существует, включая архив. Найдите его в списке.',409);
  const category=this.dictionary('inventory_categories',v.category),unit=this.dictionary('inventory_units',v.unit),now=Date.now();let id=before?.id;
  if(before){if(unit!==before.unit_id&&this.db.prepare("SELECT name FROM sqlite_master WHERE name='cafe_stock_usage'").get()&&this.db.prepare('SELECT id FROM cafe_stock_usage WHERE item_id=? LIMIT 1').get(before.id))fail('Единица используется в заказах кафе. Создайте отдельный товар для другой единицы.',409);if(!before.active)fail('Сначала восстановите товар из архива.',409);this.db.prepare('UPDATE inventory_items SET name=?,normalized_name=?,category_id=?,unit_id=?,current_milli=?,minimum_milli=?,target_milli=?,comment=?,manual_buy=?,updated_at=?,updated_by=?,revision=revision+1 WHERE id=?').run(v.name,normalized,category,unit,v.current,v.minimum,v.target,v.comment,v.manual,now,u.id,id);}
  else id=Number(this.db.prepare('INSERT INTO inventory_items(name,normalized_name,category_id,unit_id,current_milli,minimum_milli,target_milli,comment,manual_buy,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(v.name,normalized,category,unit,v.current,v.minimum,v.target,v.comment,v.manual,now,u.id).lastInsertRowid);
  const after=this.row(id);this.event(u,before?'EDIT':'CREATE',before,after,b.reason?str(b.reason,300):before?'Редактирование карточки':'Новый товар',key,hash,now);return {item:this.serialize(after)};
 });}
 move(b,u){return this.write(b,u,'move',(hash,key)=>{
  const before=this.row(b.id);if(!before.active)fail('Товар в архиве.',409);if(int(b.revision)!==before.revision)fail('Остаток уже изменён. Обновите карточку.',409);
  if(!['PURCHASE','RECEIPT','WRITE_OFF','SET'].includes(b.kind))fail('Выберите тип операции.');if(b.kind==='SET'&&(!b.reason||!b.reason.trim()))fail('Укажите причину уточнения остатка.');const amount=quantity(b.amount);if(b.kind!=='SET'&&amount===0)fail('Укажите количество больше нуля.');
  let base=before.current_milli;if(base===null&&b.kind!=='SET'){if(b.baseline===undefined||b.baseline===null||b.baseline==='')fail('Сначала укажите фактический остаток до операции.');base=quantity(b.baseline);}
  const next=b.kind==='SET'?amount:base+(b.kind==='WRITE_OFF'?-amount:amount);if(next<0)fail('Нельзя списать больше текущего остатка.');if(next>MAX)fail('Слишком большое количество.');
  const now=Date.now();this.db.prepare('UPDATE inventory_items SET current_milli=?,manual_buy=?,updated_at=?,updated_by=?,revision=revision+1 WHERE id=?').run(next,b.kind==='PURCHASE'?0:before.manual_buy,now,u.id,b.id);
  const after=this.row(b.id);this.event(u,b.kind,before,after,str(b.reason||({PURCHASE:'Закупка',RECEIPT:'Приход',WRITE_OFF:'Списание',SET:'Уточнение остатка'}[b.kind]),300)+(before.current_milli===null&&b.kind!=='SET'?'; остаток до операции: '+quantityText(base)+' '+before.unit:''),key,hash,now,b.kind==='SET'?undefined:b.kind==='WRITE_OFF'?-amount:amount);return {item:this.serialize(after)};
 });}
 archive(b,u){return this.write(b,u,'archive',(hash,key)=>{const before=this.row(b.id);if(int(b.revision)!==before.revision)fail('Товар уже изменён. Обновите карточку.',409);if(typeof b.active!=='boolean')fail('Проверьте статус товара.');this.db.prepare('UPDATE inventory_items SET active=?,updated_at=?,updated_by=?,revision=revision+1 WHERE id=?').run(b.active?1:0,Date.now(),u.id,b.id);const after=this.row(b.id);this.event(u,b.active?'RESTORE':'ARCHIVE',before,after,b.active?'Возврат из архива':'Архивирование',key,hash);return {item:this.serialize(after)};});}
 history(params,u){staff(u);const clauses=[],args=[];for(const [key,col] of [['item','item_id'],['category','category_id']])if(params.get(key)){clauses.push(col+'=?');args.push(int(Number(params.get(key)),1));}
  if(params.get('type')){if(!['PURCHASE','RECEIPT','WRITE_OFF','SET','EDIT','CREATE','SEED','ARCHIVE','RESTORE','SALE','RETURN'].includes(params.get('type')))fail('Неверный тип операции.');clauses.push('kind=?');args.push(params.get('type'));}
  if(params.get('date')){const d=params.get('date');if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d+'T00:00:00+03:00')))fail('Неверная дата.');const t=Date.parse(d+'T00:00:00+03:00');if(new Date(t+10800000).toISOString().slice(0,10)!==d)fail('Неверная дата.');clauses.push('created_at>=? AND created_at<?');args.push(t,t+86400000);}
  if(params.get('before')){clauses.push('id<?');args.push(int(Number(params.get('before')),1));}
  const rows=this.db.prepare('SELECT * FROM inventory_transactions'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' ORDER BY id DESC LIMIT 51').all(...args);return {next:rows.length>50?rows[49].id:null,items:rows.slice(0,50).map(r=>{const {payload_hash,request_id,...out}=r;return {...out,before:JSON.parse(r.before_json),after:JSON.parse(r.after_json),delta:quantityText(r.delta_milli)};})};
 }
}
export function inventoryHandler(store,admin,origin){return async(req,res,url)=>{
 if(!url.pathname.startsWith('/api/admin/inventory/'))return false;
 const reply=(status,b)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(b));return true;};
 try{if(!store)fail('Склад временно недоступен.',503);const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-start_session='))?.slice(21),u=admin.user(token);staff(u);const route=url.pathname.slice('/api/admin/inventory/'.length);
  if(req.method==='GET'){if(route==='catalog')return reply(200,store.catalog(u));if(route==='summary')return reply(200,store.summary(u,url.searchParams.get('compact')==='1'));if(route==='history')return reply(200,store.history(url.searchParams,u));return reply(404,{error:'Не найдено.'});}
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается.'});stockOperator(u);if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))fail('Недопустимый источник запроса.',403);
  let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>4096)fail('Слишком большой запрос.',413);chunks.push(c);}let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Неверный запрос.');}
  if(route==='items')return reply(200,store.save(b,u));if(route==='move')return reply(200,store.move(b,u));if(route==='archive')return reply(200,store.archive(b,u));return reply(404,{error:'Не найдено.'});
 }catch(e){return reply(e.status||500,{error:e.status?e.message:'Не удалось сохранить склад. Повторите запрос.'});}
};}
