import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dist/admin/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../dist/admin/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../dist/admin/rental-mockup.css', import.meta.url), 'utf8');

test('rental workspace loads its scoped refreshed assets and keeps primary navigation', () => {
  assert.match(html, /rental-mockup\.css\?v=rental-controls-20261010-6/);
  assert.match(html, /app\.js\?v=rental-controls-20261010-3/);
  assert.match(html, /rental-batteries\.css\?v=battery-controls-20261010-4[\s\S]*rental-mockup\.css\?v=rental-controls-20261010-6[\s\S]*rental-batteries\.js\?v=battery-controls-20261010-3/);
  assert.match(html, /id="rental-battery-panel"[\s\S]*?id="desk-actions"|id="rental-battery-panel"[\s\S]*?class="desk-actions"/);
  assert.doesNotMatch(html, /class="rental-columns"|id="desk-cafe"|id="purchase-home"|rental-battery-admin-link/);
  for (const id of ['active-search', 'new-rental', 'manual-sale', 'active-list']) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  assert.match(app, /panel\.id='rental-payments'/);
  for (const stage of ['all', 'waiting', 'onwater']) assert.ok(html.includes(`data-rental-stage="${stage}"`));
  for (const view of ['bookings', 'clients', 'availability', 'history']) assert.ok(html.includes(`data-desk-view="${view}"`));
  assert.match(html, /id="payroll-panel"/);
  assert.match(html, /id="issue-catamaran-wrap" hidden[\s\S]*?name="catamaranLabel" id="issue-catamaran-label" disabled/);
});

test('rental battery cards show a compact non-expandable status summary', () => {
  const batteries = readFileSync(new URL('../dist/admin/rental-batteries.js', import.meta.url), 'utf8');
  assert.match(batteries, /const summary=el\('div'\);summary\.className='rental-battery-summary'/);
  assert.match(batteries, /summary\.append\(ring,copy\);article\.append\(summary\);/);
  assert.doesNotMatch(batteries, /aria-expanded|rental-battery-details|<select|battery-trips|function mutate\(/);
  assert.match(batteries, /view\.caption\.textContent=summary\.caption/);
});

test('shared purchase summary is omitted on rental while settings-page classification remains active', () => {
  const nav = readFileSync(new URL('../dist/admin/ops-nav.js', import.meta.url), 'utf8');
  assert.match(nav, /document\.body\.classList\.toggle\('settings-context',settingsPage\)/);
  assert.doesNotMatch(nav, /settings-back|Все настройки/);
  assert.match(nav, /if\(!workspace\|\|active==='rental'\)return/);
  assert.match(nav, /className='purchase-summary'/);
});

test('rental rows retain separate controls, payment labels, diagnostics and guarded server actions', () => {
  assert.match(app, /r\.guestBillId&&Number\(r\.paid\)<=0\?'В счёт гостя'/);
  assert.match(app, /function paymentDiagnostic\(p\)/);
  assert.match(app, /const rows=waitingRows\(\)\.filter\(r=>Desk\.matches\(r,activeQuery,data\.fleet\)\)/);
  assert.match(app, /text\('b','Ожидает отплытия','rental-status'\),text\('small',planned,'departure-duration'\)/);
  assert.match(app, /actions\.append\(mobile,back,more\);card\.append\(main,actions,extra\)/);
  assert.match(app, /trip\.state==='departure-candidate'&&trip\.departurePending===true&&trip\.departureSuggested===true/);
  assert.match(app, /document\.addEventListener\('start:battery-overview',event=>updateBatteryOverview\(event\.detail\)\)/);
  assert.match(app, /async function startRentalDeparture\(r,button,batteryTrip=null\)[\s\S]*?const body=\{id:r\.id,revision:r\.revision\};if\(batteryTrip\)\{body\.batteryTripId=batteryTrip\.id;body\.batteryTripRevision=batteryTrip\.revision;\}await api\('rental-depart',body\)/);
  assert.doesNotMatch(app.match(/async function startRentalDeparture\([\s\S]*?\n\}/)?.[0]||'', /Date\.now|detectedDepartureAt/);
  assert.match(app, /rentalEquipmentLabel\(r,data\.fleet\.find/);
  assert.match(app, /function setRentalEquipment\(node,r,label\)/);
  assert.match(app, /text\('img','','rental-equipment-image'\)[\s\S]*text\('span',label\+\(r\.quantity>1\?/);
  assert.match(app, /b\.equipment!=='catamaran'\|\|b\.quantity!==1\|\|!String\(b\.catamaranLabel\|\|''\)\.trim\(\)\)delete b\.catamaranLabel/);
  assert.match(app, /f\.elements\.equipment\.value!=='catamaran'\|\|Number\(f\.elements\.quantity\.value\)!==1\|\|!String\(fields\.catamaranLabel\|\|''\)\.trim\(\)\)delete fields\.catamaranLabel/);
  assert.match(app, /for\(const name of \['equipment','quantity','people','departed','expectedReturn','catamaranLabel'\]\)\$\('#issue-form'\)\.elements\[name\]\.addEventListener\('change'/);
  assert.match(app, /selectedOptions\?\.\[0\]\?\.dataset\.catamaranLabel/);
  assert.match(app, /async function returnRental\(id,button,cash=false,manualCard=false\)[\s\S]*?revision:current\?\.revision/);
  assert.match(app, /async function extend\(id,minutes,button\)[\s\S]*?revision:row\.revision,minutes/);
  assert.match(app, /setReturnButton\(returnButton,r\)/);
  assert.match(app, /main\.append\(text\('strong','','rental-number'\)/);
  assert.match(app, /\.rental-timer'\)\.replaceChildren\(text\('b',status==='overdue'\?'Просрочено':'На воде','rental-status'\),text\('span',\(status==='overdue'\?/);
  assert.match(app, /mobile\.onclick=more\.onclick/);
  assert.doesNotMatch(app, /mobile\.onclick=\(\)=>\{const minutes=.*?extend\(r\.id,minutes,mobile\)/);
  assert.match(app, /Number\(r\.initial_due\)>0\?'Ожидает оплаты':Number\(r\.paid\)>0\?'Оплачено · '/);
  assert.match(app, /cashButton\.textContent='Наличные · '\+money\(r\.extension_due\)/);
  assert.match(css, /\.rental-actions/);
  assert.match(css, /@media\(max-width:1100px\)/);
  assert.match(css, /min-height:44px/);
  assert.match(css, /#workspace\[hidden\].*display:none!important/);
  assert.match(css, /#workspace:has\(\[data-desk-pane=work\]:not\(\[hidden\]\)\)>\.desk-tabs\{display:none!important\}/);
  assert.match(css, /#workspace:not\(:has\(\[data-desk-pane=work\]:not\(\[hidden\]\)\)\)>\.desk-tabs\{display:flex!important/);
  assert.match(css, /\.page-heading\{display:none!important\}/);
  assert.match(css, /#rental-payments:not\(\[hidden\]\)\{display:block!important/);
  assert.match(app, /text\('button','Вернулись','quick-return primary'\)/);
  assert.match(css, /#active-list \.mobile-extend\{display:inline-flex!important/);
  assert.match(css, /#waiting-departures \.departure-row>\.departure-bill,body\.theme-rental #waiting-departures \.departure-row>b\{grid-column:5!important;grid-row:1!important/);
  assert.match(css, /#waiting-departures \.departure-actions>\.primary\{flex:0 0 96px!important;width:auto!important/);
  assert.match(css, /body\.theme-rental>header\{display:flex!important;flex-wrap:nowrap!important;gap:6px!important;overflow-x:auto!important/);
  assert.match(css, /#workspace \.rental-battery-list\{grid-template-columns:1fr!important;gap:6px!important/);
  assert.match(css, /body\.theme-rental>header\{display:grid!important;grid-template-columns:minmax\(0,1fr\) auto!important;gap:6px 10px!important;overflow:visible!important/);
  assert.match(css, /departure-equipment\{grid-column:2!important;grid-row:1!important;gap:5px!important;white-space:nowrap!important;font-size:13px!important/);
  assert.match(css, /departure-actions:has\(\.departure-details\[open\]\)\{grid-column:1\/-1!important;grid-row:2!important;flex-wrap:wrap!important/);
  assert.match(css, /#waiting-departures \.sensor-departure-candidate\{background:#c62828!important/);
  assert.doesNotMatch(css, /\.rental-main\s*\{[^}]*display:\s*contents/);
});
