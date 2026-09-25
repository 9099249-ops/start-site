import test from 'node:test';import assert from 'node:assert/strict';
import {renderEvent,eventPaths} from './events.mjs';import {defaults} from './content.mjs';
test('Afisha pages have unique canonical, linked artwork, contact and honest schedule',()=>{
 const d=structuredClone(defaults);d.seo.indexable=true;
 for(const p of eventPaths()){const id=p.split('/')[2],h=renderEvent(d,id);assert.ok(h.includes('https://spotsup.ru'+p));assert.ok(h.includes('/assets/event-'+id+'-w'));assert.ok(h.includes('Дата и стоимость уточняются'));assert.ok(h.includes('Мытищи, Болтино, Ореховая ул, д.5'));assert.ok(h.includes('/assets/start-favicon-v2-32.png'));assert.ok(h.includes('index,follow'));assert.ok(!h.includes('"@type":"Event"'));}
 assert.equal(renderEvent(d,'unknown'),null);d.phone='<script>';assert.ok(!renderEvent(d,'chess').includes('<script>'));
});
