(function(root){
 'use strict';
 const normalize=v=>String(v||'').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]/gu,'');
 const phone=v=>{const n=String(v||'').replace(/\D/g,'');return n.length===11&&/^[78]/.test(n)?n.slice(1):n;};
 function matches(row,query,fleet=[]){const q=String(query||'').trim();if(!q)return true;const b=row.details||row,n=normalize(q),p=phone(q),label=fleet.find(f=>f.id===b.equipment)?.label||'';return normalize([b.name,b.equipment,label].join(' ')).includes(n)||String(row.id)===q.replace(/^№\s*/,'')||/^[+\d\s()-]+$/.test(q)&&p.length>=4&&phone(b.phone).includes(p);}
 function state(end,now){return end<now?'overdue':end-now<=600000?'soon':'normal';}
 function duration(ms){const abs=Math.abs(ms);if(abs<60000)return '<1 мин';const n=Math.floor(abs/60000);return n<60?n+' мин':Math.floor(n/60)+' ч'+(n%60?' '+n%60+' мин':'');}
 function active(rows,query,filter,now,fleet){return rows.filter(r=>matches(r,query,fleet)&&(filter==='all'||state(r.expected_return,now)===filter)).sort((a,b)=>a.expected_return-b.expected_return||a.id-b.id);}
 const api={normalize,phone,matches,state,duration,active};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Desk=api;
})(typeof window==='undefined'?globalThis:window);
