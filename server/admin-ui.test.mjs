import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Script,runInNewContext} from 'node:vm';
const folder=new URL('../dist/admin/',import.meta.url);

test('Every shipped admin script parses before publication',()=>{
  for(const name of readdirSync(folder).filter(n=>n.endsWith('.js'))){
    assert.doesNotThrow(()=>new Script(readFileSync(new URL(name,folder),'utf8'),{filename:name}),name);
  }
});

function bootFixture(){
  const panels=Object.fromEntries(['workspace','login-panel','setup-panel','admin-load-error'].map(id=>[id,{hidden:true}]));
  const listeners={},timers=[];let reloads=0,changed;
  const button={addEventListener:(name,fn)=>{listeners['button:'+name]=fn;}};
  runInNewContext(readFileSync(new URL('boot.js',folder),'utf8'),{
    document:{querySelector:s=>s==='#admin-reload'?button:panels[s.slice(1)],getElementById:id=>panels[id]},
    window:{addEventListener:(name,fn)=>{listeners[name]=fn;}},
    location:{reload:()=>reloads++},setTimeout:fn=>timers.push(fn),
    MutationObserver:class{constructor(fn){changed=fn;}observe(){}}
  });
  return {panels,listeners,timers,changed:()=>changed(),reloads:()=>reloads};
}

test('A failed admin script reveals recovery instead of a blank station screen',()=>{
  const f=bootFixture();f.listeners.error({filename:'https://spotsup.ru/admin/app.js'});
  assert.equal(f.panels['admin-load-error'].hidden,false);
  f.listeners['button:click']();assert.equal(f.reloads(),1);
  f.panels['login-panel'].hidden=false;f.changed();
  assert.equal(f.panels['admin-load-error'].hidden,true);
});

test('Slow startup has recovery, but a loaded login or workspace never shows it',()=>{
  const f=bootFixture();f.timers[0]();assert.equal(f.panels['admin-load-error'].hidden,false);
  f.panels.workspace.hidden=false;f.changed();f.listeners.unhandledrejection({});
  assert.equal(f.panels['admin-load-error'].hidden,true);
});
