import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
function fixture(){
 const node={textContent:''},timers=new Map();let next=0;
 const context={$:()=>node,setTimeout(fn,delay){timers.set(++next,{fn,delay});return next;},clearTimeout(id){timers.delete(id);}};
 runInNewContext(source.slice(source.indexOf('let noticeTimer;'),source.indexOf('const cafeToday='))+'globalThis.notice=notice;',context);
 return {node,timers,notice:context.notice};
}
test('Sale success notice disappears after four seconds',()=>{
 const f=fixture();f.notice('Продажа сохранена · №005',true);
 assert.equal(f.node.textContent,'Продажа сохранена · №005');assert.equal(f.timers.size,1);
 const timer=[...f.timers.values()][0];assert.equal(timer.delay,4000);timer.fn();assert.equal(f.node.textContent,'');
});
test('A new error cancels the previous success timer and remains visible',()=>{
 const f=fixture();f.notice('Сохранено.',true);f.notice('Нет подтверждения оплаты.');
 assert.equal(f.timers.size,0);assert.equal(f.node.textContent,'Нет подтверждения оплаты.');
});
test('Replacing or clearing a notice cancels its previous timer',()=>{
 const f=fixture();f.notice('Первая продажа',true);f.notice('Вторая продажа',true);
 assert.equal(f.timers.size,1);assert.equal(f.node.textContent,'Вторая продажа');
 f.notice('');assert.equal(f.timers.size,0);assert.equal(f.node.textContent,'');
});
