import path from 'node:path';
import {createUxAudit} from './ux-audit.mjs';

export function configureUxAudit(env,publicRoot){
 const enabled=env.UX_AUDIT_ENABLED==='1',directory=env.UX_AUDIT_DIR;
 if(!enabled)return createUxAudit();
 if(!directory||!path.isAbsolute(directory))throw Error('UX_AUDIT_DIR must be an absolute private directory.');
 const relative=path.relative(path.resolve(publicRoot),path.resolve(directory));
 if(!relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('UX audit data must be outside the public directory.');
 return createUxAudit({directory,enabled:true});
}

export function withUxAudit(html,audit){
 if(!audit?.config().enabled)return html;
 return html.replace('</head>','<script defer src="/admin/ux-audit.js?v=ux-audit-20261005-4"></script></head>');
}
