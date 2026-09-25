import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeSmsUrl,getSmsSegments,prepareSmsText} from './sms.mjs';

test('SMS URL sanitizing preserves paths and query',()=>{
 assert.equal(sanitizeSmsUrl(' https://spotsup.ru/booking/123?utm_source=sms '),'spotsup.ru/booking/123?utm_source=sms');
 assert.equal(sanitizeSmsUrl('HTTP://yandex.ru/maps/?rtext=test'),'yandex.ru/maps/?rtext=test');
});
test('SMS text requires Cyrillic and reports Unicode segments',()=>{
 const info=getSmsSegments('СТАРТ: ваш код 1234');
 assert.equal(info.encoding,'UCS-2'); assert.equal(info.segments,1);
 assert.throws(()=>prepareSmsText('START 1234'),/кириллиц/);
});
test('promo template is protocol-free and uses АЭЛИТА',()=>{
 const info=prepareSmsText('СТАРТ: промокод АЭЛИТА на водные развлечения. https://spotsup.ru','promo');
 assert.match(info.text,/СТАРТ: промокод АЭЛИТА/); assert.doesNotMatch(info.text,/https?:\/\//i); assert.equal(info.encoding,'UCS-2');
});
test('long Unicode SMS is counted as multipart',()=>{
 const info=getSmsSegments('СТАРТ: '+('бронь '.repeat(20)));
 assert.ok(info.characters>70); assert.ok(info.segments>=2);
});
