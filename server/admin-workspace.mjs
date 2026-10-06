import {readFile} from 'node:fs/promises';
import path from 'node:path';

export const workspacePages=new Map(['index','cafe','purchase','tasks','settings','workforce','schedule','accounts','aqsi','cafe-stock'].map(name=>[name==='index'?'/admin/':`/admin/${name}/`,name]));
export async function serveWorkspace(req,res,url,root,decorate=html=>html){
 if(process.env.START_WORKSPACE_SHELL==='0'||!workspacePages.has(url.pathname)||!['GET','HEAD'].includes(req.method))return false;
 const embedded=req.headers['sec-fetch-dest']==='iframe'||url.searchParams.get('embedded')==='1';
 const standalone=url.searchParams.get('standalone')==='1';
 let html=await readFile(path.join(root,'admin',embedded||standalone?workspacePages.get(url.pathname)+'.html':'workspace.html'),'utf8');
 if(embedded)html=html.replace('<head>','<head><script src="/admin/workspace-frame.js?v=workspace-3"></script><link rel="stylesheet" href="/admin/workspace-frame.css?v=workspace-3">');
 if(embedded||standalone)html=decorate(html);
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':embedded?'SAMEORIGIN':'DENY','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'; frame-ancestors ${embedded?"'self'":"'none'"}; base-uri 'none'; form-action 'self'`});
 res.end(req.method==='HEAD'?undefined:html);return true;
}
