import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const cafe=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
const performance=readFileSync(new URL('../dist/admin/performance.js',import.meta.url),'utf8');
test('Stock checks neither show Saving nor invalidate a concurrent read',async()=>{
 let calls=0,finish;
 const banner={dataset:{},setAttribute(){}},body={append(n){n.parentNode=this;}};
 const window={fetch:async url=>{calls++;if(url.endsWith('/orders'))await new Promise(r=>finish=r);return new Response('{}');}};
 vm.runInNewContext(performance,{window,document:{createElement:()=>banner,querySelectorAll:()=>[],body},setTimeout,clearTimeout});
 const first=window.fetch('/api/admin/cafe/orders');await window.fetch('/api/admin/cafe/stock-check',{method:'POST'});
 const second=window.fetch('/api/admin/cafe/orders');assert.equal(calls,2);assert.equal(banner.hidden,true);
 finish();await Promise.all([first,second]);
});
test('A write during polling queues one fresh read and waits for it',async()=>{
 const finishes=[];let calls=0,active=0,maxActive=0;
 const ctx={readOrders:async()=>{calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(r=>finishes.push(r));active--;}};
 vm.createContext(ctx);vm.runInContext(cafe.slice(cafe.indexOf('let ordersReadAt=0'),cafe.indexOf('async function readOrders')),ctx);
 const first=ctx.loadOrders(),afterWrite=ctx.loadOrders(true),other=ctx.loadOrders(true);
 assert.equal(first,afterWrite);assert.equal(first,other);assert.equal(calls,1);
 finishes.shift()();await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(maxActive,1);
 finishes.shift()();await first;assert.equal(calls,2);
});
test('Failed order refresh releases the lock for the next attempt',async()=>{
 let calls=0;const ctx={readOrders:async()=>{if(++calls===1)throw Error('offline');}};
 vm.createContext(ctx);vm.runInContext(cafe.slice(cafe.indexOf('let ordersReadAt=0'),cafe.indexOf('async function readOrders')),ctx);
 await assert.rejects(ctx.loadOrders(),/offline/);await ctx.loadOrders();assert.equal(calls,2);
});
test('Stalled status update times out without repeating the write',async()=>{
 let deadline,calls=0,cleared=0;const ctx={AbortController,setTimeout(fn){deadline=fn;return 1;},clearTimeout(){cleared++;},fetch:async(path,options)=>{calls++;await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));}};
 vm.createContext(ctx);vm.runInContext(cafe.slice(cafe.indexOf('async function request('),cafe.indexOf('const api=')),ctx);
 const result=ctx.request('/api/admin/cafe/status',{id:1,status:'READY'});deadline();
 await assert.rejects(result,e=>e.network&&/могло сохраниться/.test(e.message));assert.equal(calls,1);assert.equal(cleared,1);
});
