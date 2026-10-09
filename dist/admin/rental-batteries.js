(()=>{'use strict';
const $=selector=>document.querySelector(selector),el=(tag,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};
const names=['Сашин','Наташин','С серой крышей'],panel=$('#rental-battery-panel'),list=$('#rental-battery-list'),status=$('#rental-battery-status'),pageLink=$('#rental-battery-admin-link');
if(!panel||!list)return;
const api=async path=>{const response=await fetch('/api/admin/'+path,{cache:'no-store',credentials:'same-origin'});let data;try{data=await response.json();}catch{throw Object.assign(Error('Не удалось обновить данные.'),{status:response.status});}if(!response.ok)throw Object.assign(Error(data.error||'Не удалось обновить данные.'),{status:response.status});return data;};
const cards=new Map();let timer=null,loading=false,user=null,lastPollAt=0,overview=null;
const number=value=>Number.isFinite(value)?Number(value).toLocaleString('ru-RU',{maximumFractionDigits:0})+'%':'—';
const duration=value=>{const minutes=Math.round(value),hours=Math.floor(minutes/60),rest=minutes%60;return hours?`${hours} ч ${rest} мин`:`${rest} мин`;};
const valid=device=>device.online===true&&device.stale===false&&device.bmsConnected===true&&Number.isFinite(device.socPercent);
function makeCard(label){
 const article=el('article');article.className='rental-battery-card';article.dataset.catamaran=label;
 const summary=el('div');summary.className='rental-battery-summary';summary.dataset.fresh='false';summary.dataset.mode='unknown';
 const ring=el('span');ring.className='rental-battery-ring';ring.style.setProperty('--soc','0%');const charge=el('b','—');ring.append(charge);
 const copy=el('span');copy.className='rental-battery-summary-copy';const title=el('strong',label),runtime=el('b','—');runtime.className='rental-battery-runtime';const caption=el('small','Нет данных'),perDevice=el('small','');perDevice.className='rental-battery-summary-soc';copy.append(title,runtime,caption,perDevice);summary.append(ring,copy);article.append(summary);list.append(article);
 const view={article,summary,ring,charge,runtime,caption,perDevice};cards.set(label,view);return view;
}
function fleetSummary(devices){
 const allKnown=devices.length>0&&devices.every(device=>Number.isFinite(device.socPercent));
 const allFresh=allKnown&&devices.every(valid);
 const soc=allKnown?Math.min(...devices.map(device=>device.socPercent)):null;
 const states=devices.map(device=>device.state);let mode='unknown',runtime='—',caption='Нет данных';
 if(devices.some(device=>device.online===false||device.stale===true))caption='Нет связи';
 else if(allFresh&&states.every(state=>state==='charging')){mode='charging';const estimates=devices.map(device=>device.estimatedChargeMinutes);runtime=estimates.every(value=>Number.isFinite(value)&&value>=0)?duration(Math.max(...estimates)):'—';caption='Заряжается';}
 else if(allFresh&&states.every(state=>state==='discharging')){mode='discharging';const estimates=devices.map(device=>device.estimatedMinutes);runtime=estimates.every(value=>Number.isFinite(value)&&value>=0)?duration(Math.min(...estimates)):'—';caption='Работа';}
 else if(allFresh&&states.every(state=>state==='idle')){mode='idle';caption='Ожидание';}
 else if(!devices.length)caption='Нет данных';
 else if(!allKnown)caption='Нет данных';
 else if(!allFresh)caption='Нет связи';
 else caption='Разное состояние';
 return {allKnown,allFresh,soc,mode,runtime,caption};
}
function updateCard(view,devices){
 const summary=fleetSummary(devices);view.article.dataset.state=summary.allFresh?'fresh':summary.caption==='Нет связи'?'stale':'unknown';
 view.summary.dataset.fresh=String(summary.allFresh);view.summary.dataset.mode=summary.mode;
 view.summary.dataset.charge=summary.soc===null?'unknown':summary.soc>=50?'high':summary.soc>=20?'medium':'low';
 view.charge.textContent=number(summary.soc);view.ring.style.setProperty('--soc',summary.soc===null?'0%':`${Math.max(0,Math.min(100,summary.soc))}%`);
 view.runtime.textContent=summary.allFresh&&summary.runtime!=='—'?`≈ ${summary.runtime}`:'—';view.runtime.hidden=!summary.allFresh||summary.runtime==='—';view.caption.textContent=summary.caption;
 view.perDevice.textContent=devices.length>1?devices.map(device=>`${device.name||'Аккумулятор'}: ${number(device.socPercent)}`).join(' · '):'';
}
function render(data){
 overview=data;const boats=new Map((Array.isArray(data.catamarans)?data.catamarans:[]).map(boat=>[boat.label,boat]));
 for(const label of names)if(!cards.has(label))makeCard(label);
 for(const boat of data.catamarans||[])if(boat.label&&!cards.has(boat.label))makeCard(boat.label);
 for(const [label,view] of cards){const boat=boats.get(label),devices=Array.isArray(boat?.devices)?boat.devices:[];view.article.hidden=!boat;updateCard(view,devices);}
 if(status)status.textContent='';
}
function publishOverview(data){window.STARTBatteryOverview=data;document.dispatchEvent(new CustomEvent('start:battery-overview',{detail:data}));}
function clearOverview(){overview=null;window.STARTBatteryOverview=null;document.dispatchEvent(new CustomEvent('start:battery-overview',{detail:{catamarans:[]}}));if(list)list.replaceChildren();cards.clear();if(status)status.textContent='';}
function deny(){stop();clearOverview();panel.hidden=true;}
async function refresh(){
 if(loading||document.hidden||!user)return;loading=true;lastPollAt=Date.now();
 try{const data=await api('battery-overview');render(data);publishOverview(data);panel.hidden=false;}
 catch(error){publishOverview(null);if(error.status===401||error.status===403){deny();return;}panel.hidden=false;if(status)status.textContent='';for(const view of cards.values()){view.article.dataset.state='stale';view.summary.dataset.fresh='false';view.summary.dataset.mode='unknown';view.runtime.textContent='—';view.runtime.hidden=true;view.caption.textContent='Нет связи';}}
 finally{loading=false;}
}
function stop(){if(timer){clearInterval(timer);timer=null;}}
function start(){stop();if(!document.hidden&&user)timer=setInterval(()=>{const pending=(overview?.catamarans||[]).some(boat=>boat.trip?.departurePending===true&&Number.isSafeInteger(boat.trip.rentalId)&&boat.trip.rentalId>0);if(Date.now()-lastPollAt>=(pending?5000:15000))refresh();},5000);}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else{refresh();start();}});
(async()=>{try{const session=await api('session');user=session.user;if(!user||!['admin','staff'].includes(user.role)||user.scheduleOnly){deny();return;}if(pageLink)pageLink.hidden=user.role!=='admin';for(const label of names)if(!cards.has(label))makeCard(label);await refresh();if(!panel.hidden)start();}catch(error){deny();}})();
})();
