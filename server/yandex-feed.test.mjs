import test from 'node:test';
import assert from 'node:assert/strict';
import {renderYandexFeed} from './yandex-feed.mjs';
const content={inventory:[{id:'sup',name:'САП & лодка',price:1000,unit:'час',quantity:2,image:'/assets/sup.webp'}],plans:{day:5000,season:20000,takeaway:5000,deposit:5000}};
test('export exact units, safe XML and no security deposit',()=>{
 const xml=renderYandexFeed(content);
 assert.match(xml,/САП &amp; лодка/);assert.match(xml,/Стоимость за 1 час/);assert.match(xml,/<price>1000<\/price>/);
 assert.equal((xml.match(/<offer /g)||[]).length,4);assert.doesNotMatch(xml,/deposit/);assert.match(xml,/https:\/\/spotsup.ru\/assets\/sup.webp/);
});
test('cafe catalog is excluded even if supplied by an older caller',()=>{
 const xml=renderYandexFeed(content,{categories:[{id:'drinks',name:'Напитки',active:true}],items:[{id:'coffee',name:'Кофе',categoryId:'drinks',priceCents:30000,active:true}]});
 assert.doesNotMatch(xml,/cafe-|Кафе|Кофе|Напитки/);assert.equal((xml.match(/<offer /g)||[]).length,4);
});
