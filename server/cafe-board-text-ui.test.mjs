import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

const require=createRequire(import.meta.url);
const text=require('../dist/cafe-board-text.js');
const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('board text defaults and resolves only bounded, control-free whitelist strings',()=>{
 const defaults=text.resolve();
 assert.equal(text.fields.length,17);
 assert.equal(defaults.brandName,'СТАРТ.');
 assert.equal(defaults.emptyReadyTitle,'Пока готовим — устраивайтесь поудобнее');
 assert.equal(text.resolve({brandName:'<img src=x>',readyTitle:'   ',shoreNote:''}).brandName,'<img src=x>');
 assert.equal(text.resolve({brandName:'   '}).brandName,defaults.brandName);
 assert.equal(text.resolve({readyTitle:'   '}).readyTitle,defaults.readyTitle);
 assert.equal(text.resolve({shoreNote:''}).shoreNote,'');
 assert.equal(text.resolve({brandName:'x'.repeat(25)}).brandName,defaults.brandName);
 assert.equal(text.resolve({footerNote:'ok\n<script>'}).footerNote,defaults.footerNote);
 assert.deepEqual(Object.keys(text.resolve({brandName:'Name',extra:'ignored'})),text.fields.map(field=>field.key));
 assert.equal(text.resolve({brandName:'<b>Hi</b>'}).brandName,'<b>Hi</b>');
});

test('editor follows shared field definitions and submits only board text while preserving cafe settings',async()=>{
 const [html,admin]=await Promise.all([read('../dist/admin/cafe.html'),read('../dist/admin/cafe.js')]);
 assert.match(html,/\/cafe-board-text\.js\?v=board-text-/);
 assert.match(html,/href="\/cafe\/board"/);
 assert.match(html,/id="board-text-form"/);
 assert.match(admin,/function renderBoardTextForm\(value\)/);
 assert.match(admin,/make\('div',undefined,'two'\)/);
 assert.match(admin,/input\.maxLength=definition\.max;input\.required=definition\.required/);
 assert.match(admin,/fillBoardTextForm\(s\.boardText\)/);
 assert.match(admin,/d\.settings\.boardText=boardText/);
 assert.ok(admin.includes("querySelectorAll('input,button')"));
 assert.ok(admin.includes('control.disabled=true;'));
 assert.ok(admin.includes('control.disabled=disabled[index];'));
 assert.match(admin,/d\.settings=\{\.\.\.d\.settings,/);
 assert.match(admin,/board-text-reset/);
 assert.doesNotMatch(admin,/d\.settings=\{enabled:/);
});

test('board editor freezes all controls during saving, ignores repeats and preserves drafts on errors',async()=>{
 const source=await read('../dist/admin/cafe.js');
 const handler=source.split(/\r?\n/).find(line=>line.startsWith("$('#board-text-form').onsubmit="));
 assert.ok(handler);
 for(const failure of [false,true]){
  const fields=Object.fromEntries(text.fields.map(field=>[field.key,{value:field.value,disabled:false}]));
  fields.tagline.value='Unsaved draft';
  const submit={disabled:false},reset={disabled:false},controls=[...Object.values(fields),submit,reset];
  const form={elements:fields,querySelector:()=>submit,querySelectorAll:()=>controls};
  let resolve,reject,saves=0,fills=0;
  const pending=new Promise((ok,bad)=>{resolve=ok;reject=bad;});
  const context={safe:fn=>fn,$:()=>form,window:{CafeBoardText:text},catalog:{settings:{}},notice:()=>{},
   save:async change=>{saves++;await pending;change(context.catalog);},fillBoardTextForm:()=>{fills++;}};
  runInNewContext(handler,context);
  const event={preventDefault:()=>{},currentTarget:form},result=form.onsubmit(event);
  assert.ok(controls.every(control=>control.disabled));
  await form.onsubmit(event);assert.equal(saves,1);
  if(failure){reject(Error('offline'));await assert.rejects(result,/offline/);assert.equal(fills,0);assert.equal(fields.tagline.value,'Unsaved draft');}
  else{resolve();await result;assert.equal(fills,1);assert.equal(context.catalog.settings.boardText.tagline,'Unsaved draft');}
  assert.ok(controls.every(control=>!control.disabled));
 }
});

test('board binds copy as text, updates pickup and empty states, and rebuilds on text changes',async()=>{
 const [html,board]=await Promise.all([read('../dist/cafe-board.html'),read('../dist/cafe-board.js')]);
 assert.match(html,/data-board-text="cookingTitle"/);
 assert.match(html,/data-board-text="readyTitle"/);
 assert.match(html,/cafe-board\.js\?v=board-text-20261006-1/);
 assert.match(html,/cafe-board\.css\?v=board-text-20261006-1/);
 assert.match(html,/cafe-board-core\.js\?v=warm-green-20261003-1/);
 assert.match(html,/cafe-board-demo\.js\?v=warm-green-20261003-1/);
 assert.match(board,/el\.textContent=value/);
 assert.doesNotMatch(board,/innerHTML|insertAdjacentHTML/);
 assert.match(board,/pickup\?settings\.pickupLabel/);
 assert.match(board,/if\(hint\)el\.append\(text\('p',hint\)\)/);
 assert.match(board,/configChanged=JSON\.stringify\(snapshot\?\.boardText\)!==JSON\.stringify\(data\.boardText\)/);
 assert.match(board,/copySignature=JSON\.stringify\(boardText\(\)\)/);
 assert.match(board,/staffChanged\|\|configChanged\)layoutStaff/);
 assert.ok(board.includes('if(next!==signature||configChanged){signature=next;rebuild(arrivals);}'));
});

test('UMD helper can resolve old snapshots and strips unknown keys',()=>{
 const source=require('node:fs').readFileSync(new URL('../dist/cafe-board-text.js',import.meta.url),'utf8');
 const sandbox={globalThis:{}};
 runInNewContext(source,sandbox);
 assert.equal(sandbox.globalThis.CafeBoardText.resolve(undefined).pickupLabel,'Выдача у бара');
 assert.equal(sandbox.globalThis.CafeBoardText.resolve({other:'value'}).other,undefined);
});
