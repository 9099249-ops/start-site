import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
function fixture(){
 class Element{
  constructor(tag,text){this.tag=tag;this.textContent=text??'';this.children=[];this.dataset={};this.hidden=false;this.open=false;}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}before(node){elements.set('#'+node.id,node);}
 }
 const elements=new Map([['#order-list',new Element('div')]]),make=(tag,text)=>new Element(tag,text),calls=[],fields=[];
 const context={make,$:s=>elements.get(s),window:{STARTCafeNumber:id=>String(id).padStart(3,'0')},money:n=>n+' cents',api:async(path,body)=>{calls.push({path,body});return {};},renderDetail(){},loadOrders:async()=>{},document:{dispatchEvent(){}},Event,
  select(out,label,value){const field={label,value};fields.push(field);return field;},field(out,label,value){const field={label,value};fields.push(field);return field;},editor(title,build){context.title=title;context.editorOut=new Element('div');context.submit=build(context.editorOut);}};
 const helpers=source.slice(source.indexOf('function wasPrepared('),source.indexOf('\nfunction orderTone('));
 runInNewContext('let current;'+helpers+';globalThis.apiHelpers={wasPrepared,stockNotice,renderStockReport,cancelOrder};',context);
 return {context,helpers:context.apiHelpers,make,elements,fields,calls};
}
const order=extra=>({id:12,status:'CANCELLED',details:{terminalPaymentRequired:true},refundedCents:0,events:[{kind:'CANCELLED',comment:'Ошибка гостя'}],stock:{state:'retained',items:[{name:'Молоко',unit:'л',retained:'0.2',restored:'0',retainedMilli:200,restoredMilli:0}]},...extra});
const text=node=>node.textContent+' '+node.children.map(text).join(' ');
test('Order cancellation outcome and reason render as text, not HTML',()=>{
 const f=fixture(),out=f.make('div'),r=order();r.events[0].comment='<img src=x onerror=alert(1)>';f.helpers.stockNotice(out,r);
 assert.equal(out.children[0].tag,'details');assert.match(text(out),/Ингредиенты не восстановлены/);assert.match(text(out),/Молоко: списано 0.2 л/);assert.ok(text(out).includes(r.events[0].comment));assert.ok(out.children[0].children.every(node=>node.innerHTML===undefined));
 const ordinary=f.make('div');f.helpers.stockNotice(ordinary,order({status:'COOKING'}));assert.equal(ordinary.children.length,0);
});
test('Partial refund notice explicitly refers to the whole order, not the refunded item alone',()=>{
 const f=fixture(),out=f.make('div');f.helpers.stockNotice(out,order({status:'DELIVERED',refundedCents:10000}));assert.match(text(out),/Расход всего заказа сохранён/);assert.match(text(out),/Денежный возврат не восстанавливает ингредиенты/);
});
test('Daily cancellation report stays collapsed or expanded across refresh and clears when empty',()=>{
 const f=fixture(),report={count:2,items:[{name:'Молоко',retained:'0.4',unit:'л'}]};f.helpers.renderStockReport(report);const box=f.elements.get('#stock-cancellations');assert.equal(box.hidden,false);assert.match(text(box),/Отмены со списанием за день: 2/);assert.match(text(box),/Молоко: 0.4 л/);
 box.open=true;f.helpers.renderStockReport(report);assert.equal(box.open,true);f.helpers.renderStockReport({count:0,items:[]});assert.equal(box.hidden,true);assert.equal(box.children.length,0);
});
test('Cancellation requires an explicit preparation choice and reason field, then sends a bounded request',async()=>{
 const f=fixture();f.helpers.cancelOrder(order({status:'NEW',events:[]}));assert.equal(f.fields[0].value,'');assert.equal(f.fields[0].required,true);assert.equal(f.fields[1].required,true);
 await assert.rejects(f.context.submit(),/Укажите/);assert.equal(f.calls.length,0);f.fields[0].value='no';f.fields[1].value='Передумали';await f.context.submit();
 assert.equal(f.calls[0].path,'status');assert.equal(f.calls[0].body.prepared,false);assert.equal(f.calls[0].body.comment,'Передумали');assert.equal(f.calls[0].body.status,'CANCELLED');assert.equal(f.calls[0].body.id,12);
});
for(const kind of ['COOKING','READY','DELIVERED'])test('Known '+kind+' history shows its fixed outcome without a disabled dropdown',async()=>{
 const f=fixture();f.helpers.cancelOrder(order({status:kind,events:[{kind}]}));assert.equal(f.fields.length,1);assert.equal(f.fields[0].label,'Причина отмены');assert.match(text(f.context.editorOut),/зафиксировано в истории/);assert.match(text(f.context.editorOut),/Ингредиенты останутся списанными/);
 f.fields[0].value='Ошибка';await f.context.submit();assert.equal(f.calls[0].body.prepared,true);assert.equal(f.calls[0].body.comment,'Ошибка');
});
test('Unprepared order can explicitly select preparation before cancelling',async()=>{
 const f=fixture();f.helpers.cancelOrder(order({status:'NEW',events:[]}));assert.equal(f.fields[0].disabled,undefined);f.fields[0].value='yes';f.fields[0].onchange();assert.match(text(f.context.editorOut),/Ингредиенты останутся списанными/);
 f.fields[1].value='Начали готовить';await f.context.submit();assert.equal(f.calls[0].body.prepared,true);
});
