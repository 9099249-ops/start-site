import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import cafeNumber from '../dist/cafe-number.js';
test('Customer number cycles 001..999 identically on server and browser',()=>{
 const ctx=vm.createContext({});vm.runInContext(readFileSync(new URL('../dist/cafe-number.js',import.meta.url),'utf8'),ctx);
 for(const [id,expected] of [[1,'001'],[127,'127'],[998,'998'],[999,'999'],[1000,'001'],[1001,'002'],[1998,'999'],[1999,'001']]){
  assert.equal(cafeNumber(id),expected);assert.equal(ctx.STARTCafeNumber(id),expected);
 }
 for(const id of [0,-1,1.5,null,'1000',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>cafeNumber(id));
});
