import {stat,readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const cache=new Map();
// Only public code/style assets. Never cache HTML, API data or session responses.
export async function serveAdminAsset(req,res,file,url,type){
 if(!url.pathname.startsWith('/admin/')||!/[.](js|css)$/.test(file))return false;
 const info=await stat(file);let entry=cache.get(file);
 if(!entry||entry.mtime!==info.mtimeMs||entry.size!==info.size){const data=await readFile(file);entry={mtime:info.mtimeMs,size:info.size,data,gzip:gzipSync(data),etag:'W/"'+createHash('sha256').update(data).digest('hex')+'"'};if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(file,entry);}
 const headers={'Content-Type':type,'Cache-Control':url.searchParams.has('v')?'public, max-age=86400':'public, max-age=0, must-revalidate',ETag:entry.etag,Vary:'Accept-Encoding','X-Content-Type-Options':'nosniff'};
 if(req.headers['if-none-match']===entry.etag){res.writeHead(304,headers);res.end();return true;}
 const zipped=/(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers['accept-encoding']||'');const data=zipped?entry.gzip:entry.data;if(zipped)headers['Content-Encoding']='gzip';headers['Content-Length']=data.length;res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:data);return true;
}
