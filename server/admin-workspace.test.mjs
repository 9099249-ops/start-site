import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {serveWorkspace,workspacePages} from './admin-workspace.mjs';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
process.env.START_WORKSPACE_SHELL='1';
function response(){return {writeHead(code,headers){this.code=code;this.headers=headers;},end(body){this.body=body;}};}
test('All known admin entry pages use the shell; API, assets and public menu do not',async()=>{
 for(const pathname of workspacePages.keys()){const r=response();assert.equal(await serveWorkspace({method:'GET',headers:{}},r,new URL('https://example.org'+pathname),root),true);assert.match(r.body,/id="workspace-frames"/);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.headers['X-Frame-Options'],'DENY');}
 for(const pathname of ['/api/admin/session','/cafe/','/admin/app.js','/admin/preview'])assert.equal(await serveWorkspace({method:'GET',headers:{}},response(),new URL('https://example.org'+pathname),root),false);
 assert.equal(await serveWorkspace({method:'POST',headers:{}},response(),new URL('https://example.org/admin/'),root),false);
});
test('Embedded pages keep original forms and allow only same-origin framing; standalone is recoverable',async()=>{
 const url=new URL('https://example.org/admin/cafe/'),r=response();await serveWorkspace({method:'GET',headers:{'sec-fetch-dest':'iframe'}},r,url,root);assert.match(r.body,/workspace-frame.js/);assert.match(r.body,/id="order-dialog"/);assert.doesNotMatch(r.body,/id="workspace-frames"/);assert.equal(r.headers['X-Frame-Options'],'SAMEORIGIN');assert.match(r.headers['Content-Security-Policy'],/frame-ancestors 'self'/);
 url.search='?standalone=1';const fallback=response();await serveWorkspace({method:'GET',headers:{}},fallback,url,root);assert.match(fallback.body,/id="order-dialog"/);assert.doesNotMatch(fallback.body,/workspace-frame.js/);assert.equal(fallback.headers['X-Frame-Options'],'DENY');
 const head=response();await serveWorkspace({method:'HEAD',headers:{}},head,url,root);assert.equal(head.body,undefined);
});
test('Inactive sections pause visibility-driven refreshes; only parent from same origin can activate',async()=>{
 const listeners={},sent=[],events=[];class Doc{get hidden(){return false;}addEventListener(name,fn){listeners['doc:'+name]=fn;}dispatchEvent(e){events.push(e.type);}}
 const document=new Doc();document.body={classList:{toggle(){}}};const parent={postMessage:d=>sent.push(d)};let requests=0;
 const window={fetch:async()=>{requests++;return new Response('{}');}};
 vm.runInNewContext(await readFile(new URL('../dist/admin/workspace-frame.js',import.meta.url),'utf8'),{window,parent,document,Document:Doc,history:{pushState(){},replaceState(){}},location:{origin:'https://example.org',href:'https://example.org/admin/',pathname:'/admin/',search:'',hash:''},URL,Event,addEventListener:(name,fn)=>listeners[name]=fn});
 assert.equal(document.hidden,true);
 listeners.message({source:parent,origin:'https://evil.example',data:{startWorkspace:'activate',active:true}});assert.equal(document.hidden,true);
 listeners.message({source:parent,origin:'https://example.org',data:{startWorkspace:'activate',active:true}});assert.equal(document.hidden,false);assert.deepEqual(events,['visibilitychange']);
 await window.fetch('/api/admin/cafe/create',{method:'POST'});assert.equal(requests,1);assert.deepEqual(sent.map(x=>x.startWorkspace),['changed']);
 listeners.message({source:parent,origin:'https://example.org',data:{startWorkspace:'activate',active:false}});assert.equal(document.hidden,true);
});
