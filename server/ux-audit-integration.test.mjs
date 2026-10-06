import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {AdminStore,adminHandler} from './admin.mjs';
import {startUxAudit} from './ux-audit.mjs';
import {configureUxAudit,withUxAudit} from './ux-audit-integration.mjs';

test('analytics opt-in refuses public storage and does not inject without an active window',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ux-integration-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'dist'),html='<head></head>';
 assert.equal(withUxAudit(html,configureUxAudit({},root)),html);
 for(const bad of [undefined,'relative',root,path.join(root,'events')])assert.throws(()=>configureUxAudit({UX_AUDIT_ENABLED:'1',UX_AUDIT_DIR:bad},root));
 const privateDir=path.join(dir,'private');await startUxAudit(privateDir);
 assert.match(withUxAudit(html,configureUxAudit({UX_AUDIT_ENABLED:'1',UX_AUDIT_DIR:privateDir},root)),/src="\/admin\/ux-audit.js/);
});

test('analytics HTTP requires current authentication and same origin and rejects private fields',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ux-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));await startUxAudit(dir);
 const s=new AdminStore(':memory:');s.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'waiter','waiter','unused')");t.after(()=>s.close());
 for(const id of [1,2])s.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?)').run(createHash('sha256').update('test-'+id).digest('hex'),id,Date.now()+60000);
 s.uxAudit=configureUxAudit({UX_AUDIT_ENABLED:'1',UX_AUDIT_DIR:dir},path.join(dir,'public'));
 const origin='http://localhost',handler=adminHandler(s,origin),server=http.createServer((req,res)=>handler(req,res,new URL(req.url,origin)));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port+'/api/admin/',headers={Cookie:'__Host-start_session=test-2',Origin:origin,'Content-Type':'application/json'};
 const post=(body,h=headers)=>fetch(base+'ux-audit/events',{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await fetch(base+'ux-audit/config')).status,401);
 assert.equal((await fetch(base+'ux-audit/config',{headers})).status,200);
 assert.equal((await post({events:[]},{...headers,Origin:'http://wrong'})).status,403);
 assert.equal((await post({events:[],phone:'private'})).status,400);
 const event={id:randomUUID(),employee_session_id:randomUUID(),scenario_id:randomUUID(),event:'cafe_started',screen:'cafe_pos',action:'start',result:'success',error_code:null,seq:1,elapsed_ms:0};
 assert.equal((await post({events:[{...event,phone:'private'}]})).status,400);
 assert.equal((await post({events:[event]})).status,200);
 const window=JSON.parse(await readFile(path.join(dir,'window.json'),'utf8')),log=await readFile(path.join(dir,'events',window.id+'.jsonl'),'utf8');
 assert.equal(log.includes('test-2'),false);assert.equal(log.includes('phone'),false);
 assert.equal((await fetch(base+'rental-request?requestId='+randomUUID(),{headers})).status,403);
});
