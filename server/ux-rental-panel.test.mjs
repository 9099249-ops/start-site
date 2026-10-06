import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const app=await readFile(new URL('../dist/admin/app.js',import.meta.url),'utf8');

test('active rental refund panel mounts inside expanded details only',()=>{
 const active=app.match(/function renderList\(target,rows,active\)\{([\s\S]*?)\n\}/)?.[1];
 assert.ok(active,'active/returned rental list renderer exists');
 const activeBranch=active.slice(active.indexOf('counts();'));
 assert.match(activeBranch,/if\(!details\.hidden&&!details\.querySelector\('\.refund-panel\[open\]'\)\)[\s\S]*?STARTRefunds\?\.mount\(details,'rental'/);
 assert.doesNotMatch(activeBranch,/STARTRefunds\?\.mount\(card,'rental'/);
});
