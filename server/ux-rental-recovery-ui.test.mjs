import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../dist/admin/app.js',import.meta.url),'utf8');
function fn(name){const lines=source.split(/\r?\n/),start=lines.findIndex(l=>new RegExp('^(async )?function '+name+'\\(').test(l));assert.ok(start>=0);const end=lines[start].endsWith('}')?start:lines.findIndex((l,i)=>i>start&&l==='}');return lines.slice(start,end+1).join('\n');}
class Node{
 constructor(){this.children=[];this.dataset={};this.disabled=false;this.open=false;this.textContent='';}
 append(...nodes){this.children.push(...nodes);}
 closest(){return null;}
 showModal(){this.open=true;}
 close(){this.open=false;}
 remove(){this.removed=true;}
 querySelectorAll(){return this.controls||[];}
}
function fixture(){
 const store=new Map(),controls=[new Node(),new Node()],form=new Node(),dialog=new Node(),status=new Node();form.controls=controls;controls[1].disabled=true;
 const nodes={'#issue-form':form,'#issue-dialog':dialog,'#issue-status':status,'#close-issue':new Node()};
 const posts=[],body={requestId:'same-request',quantity:1,method:'cash',amount:'500'},context={pendingRentalMemory:null,user:{id:7},encodeURIComponent,sessionStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},$:key=>key==='#rental-recovery'?form.children.find(n=>n.id==='rental-recovery'&&!n.removed):nodes[key],text:(tag,value)=>Object.assign(new Node(),{tag,textContent:value||''}),api:async(path,payload)=>{posts.push({path,payload});return {found:false};},finishRental:async(...args)=>{context.finished=args;}};
 vm.runInNewContext(['pendingRental','rememberRental','lockRentalForm','showRentalRecovery'].map(fn).join('\n'),context);
 return {context,body,form,dialog,controls,posts,store};
}
test('lost response offers only lookup first; explicit retry keeps the original frozen request',async()=>{
 const f=fixture();f.context.rememberRental(f.body);f.context.showRentalRecovery();assert.equal(f.dialog.open,true);assert.equal(f.posts.length,0);assert.equal(f.form.dataset.pendingRequest,'1');assert.ok(f.controls.every(c=>c.disabled));
 const [,check,retry]=f.form.children[0].children;assert.equal(retry.hidden,true);await check.onclick();assert.equal(f.posts[0].path,'rental-request?requestId=same-request');assert.equal(f.posts[0].payload,undefined);assert.equal(retry.hidden,false);
 await retry.onclick();assert.equal(f.posts.length,2);assert.strictEqual(f.posts[1].payload,f.body);assert.equal(f.context.finished[2],true);
});
test('found rental is recovered without POST, another UUID or automatic payment',async()=>{
 const f=fixture();f.context.rememberRental(f.body);f.context.api=async(path,payload)=>{f.posts.push({path,payload});return {found:true,id:42,initialDue:50000};};f.context.showRentalRecovery();await f.form.children[0].children[1].onclick();assert.equal(f.posts.length,1);assert.equal(f.posts[0].payload,undefined);assert.equal(f.context.finished[1].id,42);assert.equal(f.context.finished[2],true);
 assert.doesNotMatch(fn('showRentalRecovery'),/startRentalPayment|randomUUID/);
});
test('recovered guest-linked rental opens its bill without starting individual rental payment',async()=>{
 const shownBills=[],rentalPayments=[],notices=[],body={requestId:'same-request',guestBillId:73},created={id:42,initialDue:50000};
 const context={
  window:{STARTUx:{complete(){}},STARTGuests:{show:async id=>shownBills.push(id)}},
  user:{id:7},data:{pendingRentals:[{id:42}]},sessionStorage:{removeItem(){}},
  $:selector=>selector==='#rental-recovery'?null:{remove(){},close(){}},
  rememberRental(){},lockRentalForm(){},refresh:async()=>{},notice:value=>notices.push(value),
  startRentalPayment:async(...args)=>rentalPayments.push(args),openSearchRental:async()=>{},
  document:{dispatchEvent(){}},Event,
 };
 vm.runInNewContext(fn('finishRental'),context);
 await context.finishRental(body,created,true);
 assert.deepEqual(shownBills,[73]);
 assert.deepEqual(rentalPayments,[]);
 assert.match(notices[0],/сохранена в счёте гостя/);
});
test('failed lookup keeps context frozen and unlocking restores originally disabled controls',async()=>{
 const f=fixture();f.context.rememberRental(f.body);f.context.api=async()=>{throw Error('offline');};f.context.showRentalRecovery();await f.form.children[0].children[1].onclick();assert.equal(f.form.children[0].children[0].textContent,'offline');assert.equal(f.form.children[0].children[2].hidden,true);assert.equal(f.context.pendingRental().requestId,'same-request');
 f.context.lockRentalForm(false);assert.equal(f.controls[0].disabled,false);assert.equal(f.controls[1].disabled,true);
});
test('pending request persists across reload and prevents draft reset or request ID replacement',()=>{
 const f=fixture();f.context.rememberRental(f.body);f.context.pendingRentalMemory=null;assert.equal(f.context.pendingRental().requestId,'same-request');
 f.context.showRentalRecovery=()=>{f.context.recovered=true;};vm.runInNewContext(fn('openIssue'),f.context);assert.equal(f.context.openIssue(false),false);assert.equal(f.context.recovered,true);
 f.context.rememberRental(null);assert.equal(f.context.pendingRental(),null);
});

test('definite rejection of an explicit retry unlocks the draft; timeout keeps it frozen',async()=>{
 for(const status of [400,409,408,500]){
  const f=fixture();f.context.rememberRental(f.body);f.context.showRentalRecovery();
  f.context.api=async()=>{throw Object.assign(Error('rejected'),{status});};
  await f.form.children[0].children[2].onclick();
  assert.equal(Boolean(f.context.pendingRental()),status===408||status===500);
  assert.equal(f.form.dataset.saving,undefined);
  assert.equal(f.controls[0].disabled,status===408||status===500);
 }
});
