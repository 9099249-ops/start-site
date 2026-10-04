import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {runInNewContext} from 'node:vm';
import {AdminStore} from './admin.mjs';
import {ContentStore,defaults,esc,renderContent,validateContent} from './content.mjs';
import {renderService} from './services.mjs';

const template=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const reviewsScript=readFileSync(new URL('../dist/reviews.js',import.meta.url),'utf8');
const clone=()=>structuredClone(defaults);
const withoutScripts=html=>html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'start-public-seo-'));
 const admin=new AdminStore(join(directory,'db'));
 admin.db.prepare('INSERT INTO admin_users(login,role,password) VALUES(?,?,?)').run('admin','admin','dummy');
 const store=new ContentStore(admin.db,join(directory,'media'));
 return {admin,store,user:{id:1,role:'admin'},close(){
  admin.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));
  rmSync(directory,{recursive:true,force:true});
 }};
}

test('Homepage exposes every rental name, description and its own price without executing JavaScript',()=>{
 const content=clone();
 content.inventory.forEach((item,index)=>{
  item.price=1100+index*137;
  item.description='Описание услуги '+item.id+' до запуска JavaScript.';
 });
 const html=withoutScripts(renderContent(template,validateContent(content)));
 const cards=[...html.matchAll(/<article class="(?:fleet-card|extra-item)">[\s\S]*?<\/article>/g)].map(match=>match[0]);
 assert.equal(cards.length,12);
 assert.equal(content.inventory.length,12);
 for(const item of content.inventory){
  const card=cards.find(value=>value.includes('href="/prokat/'+item.id+'/"'));
  assert.ok(card,'Missing rendered card for '+item.id);
  assert.ok(card.includes('>'+esc(item.name)+'</a></h3>'),item.id+' has a visible name');
  assert.ok(card.includes(esc(item.description)),item.id+' has a visible description');
  assert.ok(card.includes(item.price.toLocaleString('ru-RU')+' ₽'),item.id+' has its own visible price');
  assert.ok(card.includes('/ '+esc(item.unit)),item.id+' has the correct price unit');
  assert.ok(card.includes('data-equipment="'+item.id+'"'),item.id+' remains selectable');
 }
 assert.match(html,/id="fleet-grid" data-server-rendered/);
 assert.match(html,/id="extra-fleet"[^>]*data-server-rendered/);
});

test('Reading legacy content fills missing descriptions while preserving custom copy and stored records',()=>{
 const f=fixture();
 try{
  const legacy=clone();
  for(const item of legacy.inventory)delete item.description;
  legacy.inventory.find(item=>item.id==='sup').description='Авторское описание владельца.';
  const original=JSON.stringify(legacy);
  f.admin.db.prepare('UPDATE site_content SET draft=?,published=? WHERE id=1').run(original,original);
  const state=f.store.state();
  const live=f.store.live();
  for(const content of [state.draft,state.published,live]){
   assert.equal(content.inventory.find(item=>item.id==='sup').description,'Авторское описание владельца.');
   for(const item of content.inventory)assert.ok(item.description?.trim(),'Description missing for '+item.id);
  }
  const html=withoutScripts(renderContent(template,live));
  assert.ok(html.includes('Авторское описание владельца.'));
  assert.ok(html.includes(esc(defaults.inventory.find(item=>item.id==='kayak').description)));
  const stored=f.admin.db.prepare('SELECT draft,published,revision FROM site_content WHERE id=1').get();
  assert.equal(stored.draft,original);
  assert.equal(stored.published,original);
  assert.equal(stored.revision,0);
 }finally{f.close();}
});

test('CMS accepts a legacy document and saves editable descriptions for all twelve rental categories',()=>{
 const f=fixture();
 try{
  const legacy=clone();
  for(const item of legacy.inventory)delete item.description;
  legacy.inventory.find(item=>item.id==='boat').description='Описание катера от владельца.';
  const saved=f.store.mutate('save',{revision:0,content:legacy},f.user);
  assert.equal(saved.draft.inventory.find(item=>item.id==='boat').description,'Описание катера от владельца.');
  assert.ok(saved.draft.inventory.every(item=>typeof item.description==='string'&&item.description.length>0));
  for(const item of saved.draft.inventory)item.description='Исправленное описание: '+item.id;
  f.store.mutate('save',{revision:1,content:saved.draft},f.user);
  f.store.mutate('publish',{revision:2},f.user);
  const published=f.store.live();
  for(const item of published.inventory){
   assert.equal(item.description,'Исправленное описание: '+item.id);
   assert.ok(withoutScripts(renderService(published,item.id)).includes(esc(item.description)));
  }
 }finally{f.close();}
});

test('Rental descriptions and names stay plain text in visible HTML and do not escape the JSON script',()=>{
 const content=clone();
 const unsafe='</script><img src=x onerror="alert(1)"> & \'цитата\'';
 for(const item of content.inventory){item.description=unsafe;item.name='<img src=x onerror="alert(2)">';}
 const valid=validateContent(content);
 const html=renderContent(template,valid);
 const visible=withoutScripts(html);
 assert.ok(visible.includes(esc(unsafe)));
 assert.ok(visible.includes(esc(content.inventory[0].name)));
 assert.ok(!html.includes('<img src=x onerror='));
 assert.ok(!html.includes('</script><img src=x'));
 const config=JSON.parse(/<script type="application\/json" id="site-content">([\s\S]*?)<\/script>/.exec(html)[1]);
 assert.equal(config.inventory[0].description,unsafe);
 for(const item of valid.inventory){
  const service=renderService(valid,item.id);
  assert.ok(service.includes(esc(unsafe)),item.id+' escapes its description');
  assert.ok(!service.includes('<img src=x onerror='));
 }
});

test('Reviews follow amenities and precede events; iframe starts deferred with a no-JavaScript alternative',()=>{
 const html=renderContent(template,clone());
 const about=html.indexOf('id="about"');
 const reviews=html.indexOf('id="reviews"');
 const events=html.indexOf('id="events"');
 assert.ok(about>=0&&about<reviews&&reviews<events);
 const frame=/<iframe\b[^>]*data-reviews-widget[^>]*>/.exec(html)?.[0];
 assert.ok(frame);
 assert.ok(!/\ssrc=/.test(frame),'The external widget must not start loading at page open');
 assert.match(frame,/data-src="https:\/\/yandex\.ru\/maps-reviews-widget\/239145365381\?comments"/);
 assert.match(frame,/loading="lazy"/);
 assert.match(html,/<noscript><iframe src="https:\/\/yandex\.ru\/maps-reviews-widget\/239145365381\?comments"/);
 assert.match(html,/<script defer src="\/reviews\.js[^\"]*"><\/script>/);
});

function reviewsFixture(supportsObserver){
 let source=null,loads=0,observerCallback,observerOptions;
 const observed=[],unobserved=[],classes=[];
 const frame={
  dataset:{src:'https://yandex.ru/maps-reviews-widget/239145365381?comments'},
  hasAttribute:key=>key==='src'&&source!==null,
  set src(value){source=value;loads++;},
  get src(){return source;},
  closest:()=>({classList:{add:value=>classes.push(value)}})
 };
 const window={};
 const context={document:{querySelectorAll:()=>[frame]},window};
 if(supportsObserver){
  const Observer=function(callback,options){observerCallback=callback;observerOptions=options;this.observe=value=>observed.push(value);this.unobserve=value=>unobserved.push(value);};
  window.IntersectionObserver=Observer;
  context.IntersectionObserver=Observer;
 }
 runInNewContext(reviewsScript,context);
 return {frame,observed,unobserved,classes,get loads(){return loads;},get options(){return observerOptions;},intersect:isIntersecting=>observerCallback([{target:frame,isIntersecting}])};
}

test('Review widget loads only near the block, disconnects its observer and never reloads its iframe',()=>{
 const reviews=reviewsFixture(true);
 assert.equal(reviews.loads,0);
 assert.deepEqual(reviews.observed,[reviews.frame]);
 assert.equal(reviews.options.rootMargin,'300px 0px');
 reviews.intersect(false);
 assert.equal(reviews.loads,0);
 reviews.intersect(true);
 assert.equal(reviews.frame.src,reviews.frame.dataset.src);
 assert.equal(reviews.loads,1);
 assert.deepEqual(reviews.unobserved,[reviews.frame]);
 assert.deepEqual(reviews.classes,['reviews-loaded']);
 reviews.intersect(true);
 assert.equal(reviews.loads,1);
});

test('Review widget remains available when IntersectionObserver is unavailable',()=>{
 const reviews=reviewsFixture(false);
 assert.equal(reviews.frame.src,reviews.frame.dataset.src);
 assert.equal(reviews.loads,1);
 assert.deepEqual(reviews.classes,['reviews-loaded']);
});
