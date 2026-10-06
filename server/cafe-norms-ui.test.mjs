import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../dist/admin/cafe-norms.js', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.checked = false;
    this.isConnected = true;
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentNode = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  dispatchEvent(event) { this.dispatched = event; return true; }
  querySelector(selector) {
    if (selector === 'tbody') return this.walk().find(node => node.tagName === 'tbody') || null;
    return null;
  }
  walk() { return this.children.flatMap(node => [node, ...node.walk()]); }
}

function fixture(fetchImpl = async () => { throw new Error('Unexpected fetch'); }) {
  const section = new Element('section');
  const context = {
    window: {},
    document: { querySelector: selector => selector === '#cafe-norms' ? section : null, createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    fetch: fetchImpl
  };
  runInNewContext(source, context);
  return { ui: context.window.STARTCafeNorms, section };
}

const baseRows = [
  { id: 'r-existing', itemId: 'dish-1', itemName: 'Борщ', variantName: null, component: 'base', stockItemId: 4, stockName: 'Свёкла', unit: 'г', quantity: '80', purchaseQuantity: null, basis: 'portion', source: 'existing', status: 'existing', reason: '' },
  { id: 'r-review', itemId: 'dish-1', itemName: 'Борщ', variantName: 'Большой', component: 'variant:large', stockItemId: null, stockName: 'Контейнер', unit: null, quantity: null, purchaseQuantity: null, basis: 'portion', source: 'assumed', status: 'needs_mapping', reason: 'Нужно проверить сопоставление.' },
  { id: 'r-portion-unknown', itemId: 'dish-1', itemName: 'Борщ', variantName: null, component: 'variant:large', stockItemId: 9, stockName: 'Контейнер', unit: null, quantity: null, purchaseQuantity: null, basis: 'portion', source: 'unknown', status: 'needs_quantity', reason: 'Количество на порцию неизвестно; проверьте единицу.' },
  { id: 'r-order', itemId: 'dish-2', itemName: 'Пирог', variantName: null, component: 'base', stockItemId: 7, stockName: 'Пакет', unit: 'шт', quantity: null, purchaseQuantity: null, basis: 'order', source: 'unknown', status: 'needs_quantity', reason: 'Количество на заказ неизвестно.' },
  { id: 'r-shift', itemId: null, itemName: 'Расход за смену', variantName: null, component: 'shift', stockItemId: 8, stockName: 'Салфетки', unit: 'упаковка', quantity: '2', purchaseQuantity: null, basis: 'shift', source: 'confirmed', status: 'needs_stock', reason: 'Остаток неизвестен.' }
];
const config = rows => ({ consumablesPlan: { rows, summary: { total: rows.length } } });
const all = root => root.walk();
const find = (root, selector) => all(root).find(node => selector(node)) || null;
const byTag = tag => node => node.tagName === tag;
const tbody = root => find(root, byTag('tbody'));

test('renders truthful values, defaults to review rows, and preserves stable row IDs and edit dispatch', () => {
  const { ui, section } = fixture();
  ui.render(config(baseRows));
  assert.equal(section.hidden, false);
  assert.deepEqual(tbody(section).children.map(row => row.dataset.id), ['r-review', 'r-portion-unknown', 'r-order', 'r-shift']);
  const reviewCells = tbody(section).children[0].children;
  assert.equal(reviewCells[2].textContent, '');
  assert.equal(reviewCells[3].textContent, '');
  assert.match(find(reviewCells[4], node => node.tagName === 'span').textContent, /Нужно проверить сопоставление/);
  assert.equal(find(section, node => node.tagName === 'th' && node.textContent === 'В закупочной упаковке'), null);
  const menu = find(section, node => node.className === 'cafe-norms-menu');
  assert.equal(menu.textContent, 'Борщ · Большой');
  const checkbox = find(section, node => node.type === 'checkbox');
  checkbox.checked = false;
  checkbox.listeners.change();
  const existing = tbody(section).children.find(row => row.dataset.id === 'r-existing');
  assert.ok(existing);
  const button = find(existing, node => node.tagName === 'button');
  assert.equal(button.textContent, 'Править расход');
  button.listeners.click();
  assert.equal(section.dispatched.type, 'cafe-norm-edit');
  assert.deepEqual(JSON.parse(JSON.stringify(section.dispatched.detail)), { itemId: 'dish-1', component: 'base' });
  const pending = tbody(section).children.find(row => row.dataset.id === 'r-order');
  assert.equal(find(pending, node => node.tagName === 'button'), null);
  const unknownPortion = tbody(section).children.find(row => row.dataset.id === 'r-portion-unknown');
  assert.match(find(unknownPortion.children[4], node => node.tagName === 'span').textContent, /Количество на порцию неизвестно/);
  const unknownEdit = find(unknownPortion, node => node.tagName === 'button');
  assert.equal(unknownEdit.textContent, 'Править расход');
  unknownEdit.listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(section.dispatched.detail)), { itemId: 'dish-1', component: 'variant:large' });
  assert.equal(tbody(section).children.find(row => row.dataset.id === 'r-shift').children[3].textContent, '2 за смену');
  const stockPending = tbody(section).children.find(row => row.dataset.id === 'r-shift');
  const stockLink = find(stockPending, node => node.tagName === 'a');
  assert.equal(stockLink.href, '/admin/purchase/');
});

test('search and review filter respond to text and preserve dataset keys across repaint', () => {
  const { ui, section } = fixture();
  ui.render(config(baseRows));
  const search = find(section, node => node.type === 'search');
  search.value = 'Салфетки';
  search.listeners.input();
  assert.deepEqual(tbody(section).children.map(row => row.dataset.id), ['r-shift']);
  search.value = 'не найдено';
  search.listeners.input();
  assert.equal(tbody(section).children.length, 0);
  ui.render({});
  assert.equal(section.hidden, true);
  assert.equal(tbody(section).children.length, 0);
});

test('refresh makes a single GET, renders its response, and exposes role failures locally', async () => {
  const requests = [];
  const { ui, section } = fixture(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => config(baseRows) };
  });
  await ui.refresh();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/admin/cafe/stock');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(section.hidden, false);
  assert.equal(find(section, node => node.className === 'cafe-norms-status').textContent, '');

  const denied = fixture(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Доступно только admin.' }) }));
  await denied.ui.refresh();
  const status = find(denied.section, node => node.className === 'cafe-norms-status');
  assert.equal(status.textContent, 'Доступно только admin.');
  assert.equal(status.dataset.kind, 'error');
});

test('no plan values are inferred and refresh never sends a write or numeric payload', async () => {
  const requests = [];
  const { ui, section } = fixture(async (url, options) => {
    requests.push(options);
    return { ok: true, json: async () => ({ consumablesPlan: { rows: [baseRows[1]] } }) };
  });
  ui.render(config([baseRows[1]]));
  const before = JSON.stringify(tbody(section).children[0].children.map(node => node.textContent));
  await ui.refresh();
  const after = JSON.stringify(tbody(section).children[0].children.map(node => node.textContent));
  assert.equal(after, before);
  assert.deepEqual(requests.map(request => request.method), ['GET']);
  assert.equal(requests[0].body, undefined);
});
