import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/terminal-voice.js',import.meta.url),'utf8');
const payment=(overrides={})=>({id:'op-1',state:'payment_waiting',paymentOperationId:'request-1',...overrides});
test('Every voice-enabled admin page remains intact and loads the current voice and navigation assets',()=>{
 for(const name of ['accounts','aqsi','cafe-stock','cafe','index','purchase','schedule','settings','tasks','workforce','workspace']){
  const html=readFileSync(new URL('../dist/admin/'+name+'.html',import.meta.url),'utf8');
  assert.ok(html.startsWith('<!doctype html><html lang="ru"><head>'),name);
  assert.ok(html.trimEnd().endsWith('</body></html>'),name);
  assert.ok(!html.includes('\0'),name);
  assert.match(html,/<script defer src="\/admin\/terminal-voice\.js\?v=voice-alerts-20261006-1"><\/script>/);
  assert.match(html,/\/admin\/ops-nav\.js\?v=tasks-badge-20261006-1/);
 }
});
function fixture({storage,voices=[],speakError=false,unsupported=false,parentHelper=null}={}){
 const data=new Map(),calls=[];
 const session=storage===false?null:storage||{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const synth=unsupported?null:{getVoices:()=>voices,speak:u=>{calls.push(u);if(speakError)throw Error('speech failed');}};
 const win={speechSynthesis:synth,SpeechSynthesisUtterance:unsupported?undefined:class{}};
 const context={window:win,parent:parentHelper?{STARTTerminalVoice:parentHelper}:win,sessionStorage:session};
 runInNewContext(source,context);
 return {helper:win.STARTTerminalVoice,calls,data};
}

test('Speaks the Russian prompt with stress on И and prefers a local Russian voice',()=>{
 const f=fixture({voices:[{name:'Russian remote',lang:'ru-RU',localService:false},{name:'Russian local',lang:'ru-RU',localService:true}]});
 assert.equal(f.helper.prompt(payment()),true);
 assert.equal(f.calls[0].text,'Приложи\u0301те карту');assert.equal(f.calls[0].text.replaceAll('\u0301',''),'Приложите карту');assert.equal(f.calls[0].lang,'ru-RU');assert.equal(f.calls[0].voice.name,'Russian local');
});

test('Falls back to any Russian voice when no local Russian voice exists',()=>{
 const f=fixture({voices:[{name:'English',lang:'en-US',localService:true},{name:'Russian remote',lang:'ru',localService:false}]});
 assert.equal(f.helper.prompt(payment()),true);assert.equal(f.calls[0].voice.name,'Russian remote');
});

test('Deduplicates an operation in memory and after reload through session storage',()=>{
 const f=fixture();assert.equal(f.helper.prompt(payment()),true);assert.equal(f.helper.prompt(payment()),false);
 const again=fixture({storage:{getItem:k=>f.data.get(k)??null,setItem:(k,v)=>f.data.set(k,v)}});
 assert.equal(again.helper.prompt(payment()),false);assert.equal(again.calls.length,0);
});

test('Only a new accepted card operation can speak',()=>{
 const f=fixture();
 for(const p of [payment({state:'payment_sending'}),payment({state:'done'}),payment({state:'payment_waiting',paymentOperationId:null}),payment({paid:true}),payment({diagnostic:{paymentNotStarted:true}}),payment({id:''}),payment({id:'prior'})])assert.equal(f.helper.prompt(p,{previousId:p.id==='prior'?'prior':null}),false);
 assert.equal(f.helper.prompt(payment(),{cash:true}),false);assert.equal(f.calls.length,0);
});

test('Bounds persisted deduplication history to the newest 64 IDs',()=>{
 const f=fixture();
 for(let i=0;i<66;i++)assert.equal(f.helper.prompt(payment({id:'op-'+i})),true);
 const ids=JSON.parse(f.data.get('start-terminal-voice-v1'));
 assert.equal(ids.length,64);assert.equal(ids[0],'op-2');assert.equal(ids.at(-1),'op-65');
});

test('Unsupported speech, storage failures, and provider exceptions never throw',()=>{
 const unsupported=fixture({unsupported:true});assert.equal(unsupported.helper.prompt(payment()),false);
 assert.equal(unsupported.helper.prompt(payment(),null),false);
 const blocked=fixture({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}});assert.equal(blocked.helper.prompt(payment()),true);
 const failed=fixture({speakError:true});assert.equal(failed.helper.prompt(payment()),false);
 assert.equal(failed.helper.prompt(payment()),false);assert.equal(failed.calls.length,1);
});

test('Embedded page aliases the parent helper when one is available',()=>{
 const parentHelper={prompt(){return true;}},f=fixture({parentHelper});
 assert.equal(f.helper,parentHelper);assert.equal(f.helper.prompt(payment()),true);assert.equal(f.calls.length,0);
});

const alertScope='0123456789abcdef01234567';
test('New website orders, one-off tasks and bookings speak exactly the requested phrases',()=>{
 const f=fixture();
 for(const kind of ['cafe_order','task','booking'])assert.equal(f.helper.notify({kind,id:1},alertScope),true);
 assert.deepEqual(f.calls.map(s=>s.text),['Поступил заказ с сайта','Новое дело','Новая бронь']);
 assert.ok(f.calls.every(s=>s.lang==='ru-RU'));
});

test('News never cancel or replace the card prompt; repeated queued kinds are coalesced',()=>{
 const f=fixture();assert.equal(f.helper.prompt(payment()),true);
 assert.equal(f.helper.notify({kind:'task',id:1},alertScope),true);
 assert.equal(f.helper.notify({kind:'task',id:2},alertScope),false);
 assert.equal(f.calls[0].text,'Приложи\u0301те карту');assert.equal(f.calls[1].text,'Новое дело');
 f.calls[1].onend();
 assert.equal(f.helper.notify({kind:'task',id:2},alertScope),true);
 assert.equal(f.helper.prompt(payment()),false);
});

test('Alert deduplication survives reload and remains separate from payment history',()=>{
 const f=fixture(),event={kind:'booking',id:1};
 assert.equal(f.helper.notify(event,alertScope),true);f.calls[0].onend();
 assert.equal(f.helper.notify(event,alertScope),false);
 const again=fixture({storage:{getItem:k=>f.data.get(k)??null,setItem:(k,v)=>f.data.set(k,v)}});
 assert.equal(again.helper.notify(event,alertScope),false);
 assert.equal(again.helper.notify(event,'abcdef0123456789abcdef01'),true);
 assert.equal(again.helper.prompt(payment()),true);
});

test('Invalid or unsupported announcements and synthesis errors do not throw or affect payments',()=>{
 const f=fixture();
 for(const event of [null,{kind:'unknown',id:1},{kind:'toString',id:1},{kind:'task',id:0},{kind:'task',id:1.5}])assert.equal(f.helper.notify(event,alertScope),false);
 assert.equal(f.helper.notify({kind:'task',id:1},'bad'),false);assert.equal(f.calls.length,0);
 assert.equal(fixture({unsupported:true}).helper.notify({kind:'task',id:1},alertScope),false);
 const failed=fixture({speakError:true});assert.equal(failed.helper.notify({kind:'task',id:1},alertScope),false);
 assert.equal(failed.helper.notify({kind:'task',id:2},alertScope),false);assert.equal(failed.calls.length,2);
 assert.equal(f.helper.prompt(payment()),true);
});
