import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/finance-expenses.js',import.meta.url),'utf8');
const loadLine=source.split(/\r?\n/).find(line=>line.trim().startsWith('async function load('));
const eventsLine=source.split(/\r?\n/).find(line=>line.includes("window.addEventListener('operations-analytics-report'"));
const eventCode=eventsLine.slice(eventsLine.indexOf("window.addEventListener('operations-analytics-report'"));
function fixture({dirty=false,pending=null}={}){
 const handlers={},form={from:'2026-10-01',to:'2026-10-31',name:dirty?'Ремонт Наташин':''};
 const period={from:'2026-10-09',to:'2026-10-09'};
 const context={pending,period:{from:form.from,to:form.to},formDirty:dirty,catalogGeneration:0,catalog:null,canEdit:false,
  range:()=>period,formDraft:()=>({...form}),say:()=>{},render:()=>{},request:async()=>({canEdit:true}),
  window:{addEventListener:(name,handler)=>handlers[name]=handler}};
 context.setForm=()=>Object.assign(form,{from:context.period.from,to:context.period.to,name:''});
 context.applyDraft=draft=>Object.assign(form,draft);
 runInNewContext(loadLine+'\n'+eventCode+'\nconst realLoad=load;load=(options)=>{globalThis.lastLoad=realLoad(options);return globalThis.lastLoad;};',context);
 return {form,context,handlers,period};
}
test('blank expense form follows the report period instead of preserving the previous month',async()=>{
 const f=fixture();f.handlers['operations-analytics-report']({detail:{data:{period:f.period}}});await f.context.lastLoad;
 assert.equal(f.form.from,'2026-10-09');assert.equal(f.form.to,'2026-10-09');
});
test('edited expense draft retains its dates and name when the report period changes',async()=>{
 const f=fixture({dirty:true});f.handlers['operations-analytics-report']({detail:{data:{period:f.period}}});await f.context.lastLoad;
 assert.equal(f.form.from,'2026-10-01');assert.equal(f.form.to,'2026-10-31');assert.equal(f.form.name,'Ремонт Наташин');
});
test('opening expenses uses the chosen period for a clean form and does not alter a pending request',async()=>{
 const f=fixture();f.handlers['operations-analytics-expenses-open']({detail:f.period});await f.context.lastLoad;assert.equal(f.form.from,'2026-10-09');
 const locked=fixture({pending:{requestId:'test-request'}});locked.handlers['operations-analytics-expenses-open']({detail:locked.period});await locked.context.lastLoad;
 assert.equal(locked.form.from,'2026-10-01');assert.equal(locked.context.pending.requestId,'test-request');
});
