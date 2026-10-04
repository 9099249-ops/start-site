import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/app.js',import.meta.url),'utf8');
function fixture({ready=true,open=false,bill='1',hash='#issue'}={}){
 const dialog={open},form={dataset:{}},events={};let opened=0,switched=0;
 const location={search:'?guestBill='+bill,hash,pathname:'/admin/'};
 const context={URLSearchParams,Number,location,user:ready?{}:null,data:ready?{}:null,$:s=>s==='#issue-dialog'?dialog:form,switchDesk(){switched++;},openIssue(){opened++;dialog.open=true;},history:{replaceState(a,b,url){location.hash=url.slice(url.indexOf('#'));}},addEventListener:(name,fn)=>events[name]=fn};
 runInNewContext(source.slice(source.indexOf('function openGuestBillRental()'),source.indexOf('function openIssue(')),context);
 return {context,location,dialog,form,events,counts:()=>({opened,switched})};
}
test('Adding rental to a bill opens the form, binds the bill and consumes the route once',()=>{
 const f=fixture();f.context.openGuestBillRental();assert.equal(f.dialog.open,true);assert.equal(f.form.dataset.guestBill,'1');assert.equal(f.location.hash,'#work');assert.equal(f.counts().opened,1);
 f.context.openGuestBillRental();assert.equal(f.counts().opened,1);
});
test('Reusing the loaded guest bill route reopens a closed form without reloading the page',()=>{
 const f=fixture();f.context.openGuestBillRental();f.dialog.open=false;f.location.hash='#issue';f.events.hashchange();assert.equal(f.counts().opened,2);assert.equal(f.form.dataset.guestBill,'1');
});
test('An already open rental form is not reset; loading and ordinary navigation do not open it',()=>{
 const existing=fixture({open:true});existing.context.openGuestBillRental();assert.equal(existing.counts().opened,0);
 const loading=fixture({ready:false});loading.context.openGuestBillRental();assert.equal(loading.counts().opened,0);assert.equal(loading.location.hash,'#issue');loading.context.user={};loading.context.data={};loading.context.openGuestBillRental();assert.equal(loading.counts().opened,1);
 for(const options of [{bill:'0'},{bill:'invalid'},{bill:'1.5'},{hash:'#work'}]){const f=fixture(options);f.context.openGuestBillRental();assert.equal(f.counts().opened,0);}
});
test('Guest bill rental link requests the form and dashboard readiness handles the request',()=>{
 const guests=readFileSync(new URL('../dist/admin/guest-bills.js',import.meta.url),'utf8');
 assert.ok(guests.includes("rental.href='/admin/?guestBill='+b.id+'#issue';"));assert.ok(source.includes("$('#workspace').hidden=false;openGuestBillRental();"));
});
