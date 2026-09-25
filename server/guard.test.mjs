import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BookingGuard} from './guard.mjs';
test('Pending and completed receipts survive restart; same request cannot send twice',()=>{
 const dir=mkdtempSync(join(tmpdir(),'start-guard-'));const file=join(dir,'db');
 let g=new BookingGuard(file,'test');
 try{const r=g.reserve('same booking','ip',1000);assert.equal(r.state,'new');assert.equal(g.reserve('same booking','ip',1001).state,'pending');g.close();g=new BookingGuard(file,'test');assert.equal(g.reserve('same booking','ip',1002).state,'pending');g.complete(r.id);assert.equal(g.reserve('same booking','other',1003).state,'sent');assert.equal(g.reserve('same booking','ip',86402000).state,'new');}finally{g.close();rmSync(dir,{recursive:true});}
});
test('Rate limits are per client, persist and expire',()=>{
 const dir=mkdtempSync(join(tmpdir(),'start-rate-'));let g=new BookingGuard(join(dir,'db'),'test');
 try{for(let i=0;i<5;i++)assert.equal(g.reserve('b'+i,'a',1000).state,'new');g.close();g=new BookingGuard(join(dir,'db'),'test');assert.equal(g.reserve('b6','a',1001).state,'limited');assert.equal(g.reserve('b6','b',1001).state,'new');assert.equal(g.reserve('b7','a',61001).state,'new');}finally{g.close();rmSync(dir,{recursive:true});}
});
