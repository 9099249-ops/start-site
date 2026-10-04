(function(root){'use strict';
// A part is measured with the real browser typography. Oversized text is broken
// at word boundaries; every continuation retains the dish heading and identity.
function splitOrder(order,maxHeight,measure){
 const parts=[];let current={items:[],comment:''};
 const fits=p=>measure(p)<=maxHeight;
 const emit=()=>{if(current.items.length||current.comment){parts.push(current);current={items:[],comment:''};}};
 const splitText=(text,make,accept)=>{let rest=String(text||'');while(rest){let low=1,high=rest.length,best=0;while(low<=high){const mid=(low+high)>>1;if(fits(make(rest.slice(0,mid)))){best=mid;low=mid+1;}else high=mid-1;}if(!best)throw Error('Экран слишком мал для читаемого табло.');if(best<rest.length){const space=rest.lastIndexOf(' ',best);if(space>best/2)best=space+1;}accept(rest.slice(0,best));rest=rest.slice(best);}};
 order.items.forEach((item,index)=>{
  const full={...item,index};if(fits({...current,items:[...current.items,full]})){current.items.push(full);return;}
  emit();if(fits({items:[full],comment:''})){current.items.push(full);return;}
  // First split an unusually long name; then repeat its heading for each note.
  const names=[];splitText(item.name,name=>({items:[{...item,index,name,variant:'',modifiers:['Продолжение'],comment:''}],comment:''}),name=>names.push(name));
  const heading=names[0];for(const name of names)parts.push({items:[{...item,index,name,variant:'',modifiers:[],comment:''}],comment:''});
  for(const note of [item.variant,...(item.modifiers||[]),item.comment].filter(Boolean))splitText(note,text=>({items:[{...item,index,name:heading,variant:'',modifiers:[text],comment:''}],comment:''}),text=>parts.push({items:[{...item,index,name:heading,variant:'',modifiers:[text],comment:''}],comment:''}));
 });emit();
 if(order.comment){if(parts.length&&parts.every(p=>fits({...p,comment:order.comment})))parts.forEach(p=>p.comment=order.comment);else splitText(order.comment,text=>({items:[],comment:text}),text=>parts.push({items:[],comment:text}));}
 if(!parts.length)parts.push({items:[],comment:''});return parts;
}
function pack(entries,height,gap=12){const pages=[];let page=[],used=0;for(const e of entries){if(page.length&&used+gap+e.height>height){pages.push(page);page=[];used=0;}page.push(e);used+=(page.length>1?gap:0)+e.height;}if(page.length)pages.push(page);return pages;}
class Rotation{
 constructor(){this.pages=[];this.page=0;this.phase=0;this.at=0;}
 replace(pages,now){const old=this.pages[this.page],anchor=old?.[0]?.order.id;const index=pages.findIndex(p=>p.some(e=>e.order.id===anchor));const next=index>=0?index:0;const same=JSON.stringify(old)===JSON.stringify(pages[next]);this.pages=pages;this.page=next;if(!same){this.phase=0;this.at=now;}}
 advance(now,seconds){const p=this.pages[this.page];if(!p)return false;const elapsed=Math.floor((now-this.at)/(seconds*1000));if(elapsed<1)return false;for(let i=0;i<elapsed;i++){this.phase++;if(this.phase>=Math.max(...this.pages[this.page].map(e=>e.parts.length))){this.phase=0;this.page=(this.page+1)%this.pages.length;}}this.at+=elapsed*seconds*1000;return true;}
 visible(){return (this.pages[this.page]||[]).map(e=>({...e,part:Math.min(this.phase,e.parts.length-1)}));}
}
function readyArrivals(previous,next){if(!previous)return [];const ready=new Set(previous.filter(o=>o.status==='ready').map(o=>o.id));return next.filter(o=>o.status==='ready'&&!ready.has(o.id)).map(o=>o.id);}
function scrollPlan(distance,speed=22){if(distance<=1)return {duration:0,pauseFraction:0};const duration=5000+distance/speed*1000;return {duration,pauseFraction:2500/duration};}
function threeLines(texts,width,measure){
 const rows=[];
 for(const value of texts){let rest=String(value).trim(),first=true;while(rest){let low=1,high=rest.length,best=1;while(low<=high){const mid=(low+high)>>1;if(measure(rest.slice(0,mid))<=width){best=mid;low=mid+1;}else high=mid-1;}if(best<rest.length){const space=rest.lastIndexOf(' ',best);if(space>0)best=space;}rows.push({text:rest.slice(0,best).trim(),first});first=false;rest=rest.slice(best).trim();}}
 return rows.length<=3?rows.map(r=>r.text):[rows[0].text,rows[1].text,rows.slice(2).map((r,i)=>(i&&r.first?' • ':i?' ':'')+r.text).join('')];
}
const readyMelody=[{frequency:523.25,at:0,duration:.38},{frequency:659.25,at:.3,duration:.38},{frequency:783.99,at:.6,duration:.4},{frequency:1046.5,at:.92,duration:.46},{frequency:783.99,at:1.28,duration:.72}];

function boardPages(entries,height,gap=12){const pages=[];let page=[],used=0;for(const entry of entries){if(page.length&&(page.length>=6||used+gap+entry.height>height)){pages.push(page);page=[];used=0;}page.push(entry);used+=(page.length>1?gap:0)+entry.height;}if(page.length)pages.push(page);return pages;}
function pageSeconds(page){const chars=page.reduce((n,e)=>n+JSON.stringify(e.content).length,0);return Math.max(12,Math.min(45,Math.ceil(chars/24)));}
function staffText(names){return names.length<2?names.join(''):names.slice(0,-1).join(', ')+' и '+names[names.length-1];}
function receiving(location){return location==='Самовывоз'?'Выдача у бара':location||'В кафе';}
function readyHint(location){return location==='Самовывоз'?'Заберите заказ у бара':/^Стол|^\d+\s*стол/i.test(location)?receiving(location)+' · Подадим к вашему столу':location==='На яхту'?'Выдача на яхту':location==='Домик'?'Доставка в домик':'Способ получения: '+receiving(location);}
root.CafeBoardCore={boardPages,pageSeconds,staffText,receiving,readyHint,splitOrder,pack,Rotation,readyArrivals,scrollPlan,threeLines,readyMelody};
})(globalThis);
