import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('Cafe guest bills keep the shared footer action and guest screen without a top tab', async () => {
  const [html, chrome, cafe, guestBills] = await Promise.all([
    read('dist/admin/cafe.html'),
    read('dist/admin/pos-chrome.js'),
    read('dist/admin/cafe.js'),
    read('dist/admin/guest-bills.js'),
  ]);

  assert.doesNotMatch(html, /<button\b[^>]*data-tab="guests"[^>]*>\s*Счета гостей\s*<\/button>/);
  assert.match(html, /<section id="guests" class="screen" hidden><\/section>/);
  assert.match(chrome, /action\('Счета гостей','guests',\(\)=>window\.STARTGuests\.show\(\)\)/);
  assert.match(chrome, /guestCount\.className='station-guest-count'/);
  assert.match(cafe, /\['orders','compose','guests'/);
  assert.match(cafe, /STARTGuests\.show\(null,\$\('#guests'\)\)/);
  assert.match(cafe, /async addToBill\(b\).*STARTGuests\.selectCafe\(b\)/);
  assert.match(cafe, /async showBill\(id\).*STARTGuests\.show\(id,\$\('#guests'\)\)/);
  assert.match(guestBills, /selectCafe/);
});
