// A small dependency-free OOXML export. Strings are inline text, never formulas.
const xml=v=>String(v??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const phone=v=>{let p=String(v||'').replace(/\D/g,'');if(p.length===10)p='7'+p;if(p.length===11&&p[0]==='8')p='7'+p.slice(1);return /^\d{10,15}$/.test(p)?p:null;};
const day=t=>new Date(t+10800000).toISOString().slice(0,10);
export function clientRows(admin){
 const db=admin.db,people=new Map(),exists=t=>!!db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(t);
 const person=(name,number)=>{const p=phone(number);if(!p)return null;if(!people.has(p))people.set(p,{name:name||'',phone:'+'+p,days:new Set(),cents:0});return people.get(p);};
 if(exists('clients'))for(const c of db.prepare('SELECT name,phone FROM clients ORDER BY last_seen DESC').all())person(c.name,c.phone);
 for(const r of db.prepare('SELECT r.*,(SELECT coalesce(sum(amount),0) FROM payments p WHERE p.rental_id=r.id) paid FROM rentals r WHERE initial_due>=0').all()){
  const c=person(r.name,r.phone);if(!c)continue;const refund=db.prepare("SELECT coalesce(sum(amount_cents),0) n FROM customer_refunds WHERE kind='rental' AND source_id=?").get(r.id).n;
  if(r.initial_due===0)c.days.add(day(Date.parse(r.departed+':00+03:00')||r.created));c.cents+=Math.max(0,r.paid-refund);
 }
 if(exists('cafe_orders'))for(const r of db.prepare('SELECT * FROM cafe_orders').all()){
  const d=JSON.parse(r.details),c=person(d.name,d.phone);if(!c)continue;
  const paid=!!d.terminalPaidAt||r.status==='DELIVERED'&&!d.terminalPaymentRequired;
  if(r.status==='DELIVERED'||paid&&r.status!=='CANCELLED')c.days.add(day(r.created));
  if(paid&&!d.complimentary){const refund=db.prepare("SELECT coalesce(sum(amount_cents),0) n FROM customer_refunds WHERE kind='cafe' AND source_id=?").get(r.id).n;c.cents+=Math.max(0,r.total_cents-refund);}
 }
 return [...people.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru')).map(c=>[c.name,c.phone,c.days.size,c.cents/100]);
}
function crc32(b){let c=0xffffffff;for(const x of b){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function zip(files){const chunks=[],central=[];let offset=0;for(const [name,text] of Object.entries(files)){const n=Buffer.from(name),d=Buffer.from(text),crc=crc32(d),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(d.length,18);h.writeUInt32LE(d.length,22);h.writeUInt16LE(n.length,26);chunks.push(h,n,d);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(d.length,20);c.writeUInt32LE(d.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+d.length;}const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,cd,end]);}
export function clientsXlsx(admin){const rows=[['Имя','Телефон','Количество посещений','Потрачено, ₽'],...clientRows(admin)],ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';return zip({
 '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
 '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
 'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Клиенты" sheetId="1" r:id="rId1"/></sheets></workbook>`,
 'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
 'xl/worksheets/sheet1.xml':`<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="30" customWidth="1"/><col min="2" max="2" width="20" customWidth="1"/><col min="3" max="4" width="25" customWidth="1"/></cols><sheetData>${rows.map((row,i)=>`<row r="${i+1}">${row.map((v,j)=>typeof v==='number'?`<c r="${'ABCD'[j]}${i+1}"><v>${v}</v></c>`:`<c r="${'ABCD'[j]}${i+1}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:D${rows.length}"/></worksheet>`
 });}
