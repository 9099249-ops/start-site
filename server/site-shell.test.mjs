import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {renderContent,defaults} from './content.mjs';import {renderService} from './services.mjs';import {renderEvent} from './events.mjs';import {renderStorage} from './storage.mjs';
test('All public page types share logo, favicon, navigation and footer without duplicate chrome',()=>{
 const pages=[renderContent(readFileSync(new URL('../dist/index.html',import.meta.url),'utf8'),structuredClone(defaults)),renderService(structuredClone(defaults),'sup'),renderEvent(structuredClone(defaults),'concerts'),renderStorage(structuredClone(defaults))];
 for(const h of pages){assert.equal((h.match(/<header\b/g)||[]).length,1);assert.equal((h.match(/<footer\b/g)||[]).length,1);assert.equal((h.match(/id="navigation"/g)||[]).length,1);assert.ok(h.includes('/assets/start-logo-horizontal.webp'));assert.ok(h.includes('/assets/start-favicon-v2-32.png'));assert.ok(!h.includes('favicon.svg'));assert.ok(h.includes('href="/storage/"'));assert.ok(h.includes('href="tel:+79039633135"'));}
 assert.ok(pages[0].includes('data-book'));assert.ok(!pages[0].includes('/site-shell.js'));for(const h of pages.slice(1))assert.ok(h.includes('/site-shell.js'));
});
