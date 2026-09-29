import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../dist/admin/cafe.js',import.meta.url),'utf8');
function fixture(){
 let now=Date.parse('2026-09-28T23:59:59+03:00');const input={value:'2026-09-28'};
 class Clock extends Date {static now(){return now;}}
 const c=vm.createContext({Date:Clock,$:()=>input});
 vm.runInContext(source.slice(source.indexOf('const cafeToday='),source.indexOf('async function request(')),c);
 return {run:s=>vm.runInContext(s,c),input,next:()=>{now+=2000;}};
}
test('Cafe date follows Moscow midnight, not UTC midnight',()=>{const f=fixture();assert.equal(f.run('cafeToday()'),'2026-09-28');f.next();f.run('syncOrderDay()');assert.equal(f.input.value,'2026-09-29');assert.match(f.run('orderDayLabel(cafeToday())'),/сегодня/);});
test('Explicit history date stays selected while page is open',()=>{const f=fixture();f.input.value='2026-09-20';f.next();f.run('syncOrderDay()');assert.equal(f.input.value,'2026-09-20');assert.match(f.run("orderDayLabel('2026-09-20')"),/20 сентября 2026/);});
test('Old sessions and yesterday saved filters reset; same-day history restores',()=>{const f=fixture();assert.equal(f.run("restoreOrderDay({date:'2026-09-20',savedDay:'2026-09-28'})"),'2026-09-20');assert.equal(f.run("restoreOrderDay({date:'2026-09-27'})"),'2026-09-28');f.next();assert.equal(f.run("restoreOrderDay({date:'2026-09-28',savedDay:'2026-09-28'})"),'2026-09-29');});
