import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../dist/admin/rental-mockup.css', import.meta.url), 'utf8');
const finalCascade = css.slice(css.lastIndexOf('/* Final cascade wins'));
const compact = finalCascade;

test('compact rental row styling supports photos, stacked contacts, and status badges', () => {
  assert.match(compact, /\.rental-equipment-image,body\.theme-rental #waiting-departures \.rental-equipment-image\{display:block!important;flex:0 0 46px!important;width:46px!important;height:50px!important;object-fit:contain!important/);
  assert.match(compact, /\.rental-equipment:before,body\.theme-rental #waiting-departures \.departure-equipment:before\{content:none!important;display:none!important/);
  assert.match(compact, /\.rental-client\{grid-column:3!important;grid-row:1!important/);
  assert.match(compact, /\.rental-phone\{grid-column:3!important;grid-row:2!important/);
  assert.match(compact, /\.departure-client\{grid-column:3!important;grid-row:1\/span 2!important;display:grid!important/);
  assert.match(compact, /\.departure-phone\{font-size:12px!important;font-weight:400!important/);
  assert.match(compact, /\.departure-status \.rental-status\{[\s\S]*?background:#fff2cf!important;[\s\S]*?color:#815700!important/);
  assert.match(compact, /\.rental-timer-value\{display:block!important/);
});

test('compact rental actions remain touch sized and sensor departure stays red', () => {
  assert.match(compact, /\.rental-actions button,[\s\S]*?\.departure-actions button,[\s\S]*?min-height:44px!important/);
  assert.match(compact, /\.departure-actions \.sensor-departure-candidate\{background:#c62828!important;border-color:#c62828!important;color:#fff!important/);
  assert.match(compact, /@media\(max-width:600px\)[\s\S]*?\.rental-actions\{grid-column:1\/-1!important;grid-row:2!important/);
  assert.match(compact, /@media\(max-width:600px\)[\s\S]*?\.departure-actions\{grid-column:1\/-1!important;grid-row:3!important/);
});

test('final desktop cascade keeps six aligned columns and stacks cleanly at narrower widths', () => {
  const columns = 'grid-template-columns:46px minmax(130px,1.15fr) minmax(150px,1.25fr) minmax(120px,.8fr) minmax(120px,.8fr) minmax(250px,1.5fr)!important';
  assert.equal(finalCascade.indexOf('/* Final cascade wins'), 0);
  assert.equal(finalCascade.split(columns).length - 1, 2);
  assert.match(finalCascade, /\.rental-main\{display:grid!important;grid-column:1\/6!important;grid-row:1\/span 2!important;grid-template-columns:46px[^}]*grid-template-columns:subgrid!important/);
  assert.doesNotMatch(css, /\.rental-main\s*\{[^}]*display:\s*contents/);
  assert.match(finalCascade, /\.departure-status \.rental-status\{[\s\S]*?background:#fff2cf!important/);
  assert.doesNotMatch(finalCascade, /\.departure-row>\.departure-status\{[^}]*background:/);
  assert.match(finalCascade, /@media\(max-width:1100px\)[\s\S]*?\.rental-actions\{grid-column:1\/-1!important;grid-row:2!important/);
  assert.match(finalCascade, /\.rental-actions\{grid-column:6!important;grid-row:1\/span 2!important;display:flex!important;flex-wrap:nowrap!important/);
  assert.match(css, /\.rental-actions>\.quick-return\{[^}]*width:auto!important/);
  assert.match(css, /\.rental-actions>\.quick-return\{min-width:112px!important/);
  assert.match(css, /\.rental-actions>\.rental-more\{[^}]*flex:0 0 44px!important;[^}]*min-height:44px!important/);
});
