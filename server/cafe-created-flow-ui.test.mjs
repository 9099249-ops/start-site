import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
function fixture({fail=false,settled=true,inWork=false,paymentState}={}){
 const calls=[],tabs=[],opened=[],notices=[],events=[];
 const notice={replaceChildren(...nodes){this.nodes=nodes;},append(node){this.nodes.push(node);}};
 let paid=false;
 const context={api:async(path,body)=>{calls.push({path,body});if((path==='pay'||path==='manual-paid')&&fail)throw Error('Нет связи');if(path==='pay')paid=true;if(path.startsWith('order?'))return {id:31,revision:2,status:paid&&settled&&!inWork?'DELIVERED':'NEW',details:{terminalPaidAt:paid&&settled?123:null},...(paymentState?{terminalPayment:{state:paymentState,label:'Проверка чека'}}:{})};},selectCafeTab:async t=>tabs.push(t),openOrder:async id=>opened.push(id),loadOrders:async()=>{},notice:t=>notices.push(t),noticeTimer:null,clearTimeout(){},safe:fn=>()=>fn().catch(()=>{}),make:(tag,label)=>({tag,textContent:label,setAttribute(){}}),$:()=>notice,window:{STARTCafeNumber:id=>String(id),STARTCafeDesk:{showBill:async id=>events.push(['bill',id])}},document:{dispatchEvent:e=>events.push(e.type),createTextNode:text=>text},Event};
 runInNewContext(source.slice(source.indexOf('async function createdCafeOrder('),source.indexOf("document.addEventListener('cafe-order-created'")),context);
 return {context,calls,tabs,opened,notices,notice,events};
}
test('Any payment choice completes in the composer without opening order detail',async()=>{
 for(const cashRequested of [false,true]){
  const f=fixture();await f.context.createdCafeOrder({detail:{id:31,payNow:true,cashRequested,stayComposer:true}});
  assert.deepEqual(f.tabs,['compose']);assert.deepEqual(f.opened,[]);assert.equal(f.calls.filter(x=>x.path==='pay').length,1);assert.equal(f.calls.find(x=>x.path==='pay').body.cash,cashRequested);assert.match(f.notices[0],cashRequested?/Продажа сохранена/:/Оплата подтверждена/);
 }
});
test('Uncertain payment stays visible and offers order reconciliation without retry',async()=>{
 const f=fixture({fail:true});await f.context.createdCafeOrder({detail:{id:31,payNow:true,cashRequested:false,stayComposer:true}});
 assert.deepEqual(f.tabs,['compose']);assert.deepEqual(f.opened,[]);assert.equal(f.calls.filter(x=>x.path==='pay').length,1);assert.match(f.notice.nodes[0],/Повторно не оплачивайте/);assert.equal(f.notice.nodes[1].textContent,'Открыть заказ');
 await f.notice.nodes[1].onclick();assert.deepEqual(f.opened,[31]);
});
test('Unsettled payment response remains actionable instead of showing success',async()=>{
 const f=fixture({settled:false});await f.context.createdCafeOrder({detail:{id:31,payNow:true,cashRequested:false,stayComposer:true}});
 assert.deepEqual(f.tabs,['compose']);assert.equal(f.calls.filter(x=>x.path==='pay').length,1);assert.match(f.notice.nodes[0],/ожидает подтверждения оплаты/);assert.equal(f.notice.nodes[1].textContent,'Открыть заказ');
});
test('Confirmed cash in-work is successful without forcing delivered status',async()=>{
 const f=fixture({inWork:true,paymentState:'cash_done'});await f.context.createdCafeOrder({detail:{id:31,payNow:true,cashRequested:true}});
 assert.deepEqual(f.tabs,['compose']);assert.deepEqual(f.opened,[]);assert.match(f.notices[0],/Продажа сохранена/);assert.equal(f.calls.filter(x=>x.path==='pay').length,1);
});
test('Paid money with an uncertain receipt retains an actionable warning',async()=>{
 const f=fixture({paymentState:'receipt_unknown'});await f.context.createdCafeOrder({detail:{id:31,payNow:true}});
 assert.deepEqual(f.notices,[]);assert.match(f.notice.nodes[0],/Проверка чека/);assert.equal(f.notice.nodes[1].textContent,'Открыть заказ');
});
test('Manual acquiring remains in composer and only records the existing audit confirmation',async()=>{
 const f=fixture();await f.context.createdCafeOrder({detail:{id:31,manualPaidRequested:true,stayComposer:true}});
 assert.deepEqual(f.tabs,['compose']);assert.deepEqual(f.opened,[]);assert.equal(f.calls.some(x=>x.path==='pay'),false);const b=f.calls.find(x=>x.path==='manual-paid').body;assert.equal(b.method,'card');assert.equal(b.receiptExists,true);assert.equal(b.confirmed,true);assert.equal(b.terminalIdle,true);
});
test('Manual acquiring failure stays visible with an order action',async()=>{
 const f=fixture({fail:true});await f.context.createdCafeOrder({detail:{id:31,manualPaidRequested:true,stayComposer:true}});
 assert.deepEqual(f.tabs,['compose']);assert.deepEqual(f.opened,[]);assert.equal(f.calls.some(x=>x.path==='pay'),false);assert.match(f.notice.nodes[0],/Не удалось подтвердить оплату/);assert.equal(f.notice.nodes[1].textContent,'Открыть заказ');
});
test('Guest bill order stays in composer with an explicit bill action',async()=>{
 const f=fixture();await f.context.createdCafeOrder({detail:{id:31,guestBillId:8,stayComposer:true}});
 assert.deepEqual(f.tabs,['compose']);assert.equal(f.notice.nodes[1].textContent,'Открыть счёт');assert.deepEqual(f.events,['station-updated']);
 await f.notice.nodes[1].onclick();assert.deepEqual(f.events,['station-updated',['bill',8]]);
});
