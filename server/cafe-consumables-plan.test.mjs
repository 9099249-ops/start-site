import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConsumablesPlan } from './cafe-consumables-plan.mjs';

const stock = (id, name, unit = 'шт', current_milli = 12000) => ({ id, name, unit, unit_id: id, active: true, current_milli, category: 'Расходники' });
const item = (id, name, categoryId = 'food', extra = {}) => ({ id, name, categoryId, active: true, size: '', variants: [], groupIds: [], ...extra });
const rowFor = (plan, itemId, stockName) => plan.rows.find(row => row.itemId === itemId && row.stockName === stockName);

test('Existing pieces and package fractions are displayed in their unit, never as raw milli quantities',()=>{
 const plan=buildConsumablesPlan({items:[item('pizza','Пицца')],recipes:[{item_id:'pizza',component:'base',ingredients:[{id:1,unitId:1,amount:1000},{id:2,unitId:2,amount:200}]}],inventory:[stock(1,'Пицца','шт.'),stock(2,'Соус','упаковки')]});
 assert.equal(rowFor(plan,'pizza','Пицца').quantity,'1');assert.equal(rowFor(plan,'pizza','Соус').quantity,'0.2');
});

test('generates every pizza box and 30 cm parchment proposal without changing config', () => {
  const config = {
    categories: [{ id: 'pizza', name: 'Пицца' }],
    items: Array.from({ length: 7 }, (_, i) => item(`p${i}`, `Пицца ${i}`, 'pizza')),
    groups: [], recipes: Array.from({ length: 7 }, (_, i) => ({ item_id: `p${i}`, component: 'base', ingredients: [{ id: 3, unitId: 3, amount: 1000 }] })),
    inventory: [stock(1, 'Коробки для пиццы'), stock(2, 'Пергамент', 'см'), stock(3, 'Мука', 'кг')]
  };
  const before = structuredClone(config), plan = buildConsumablesPlan(config);
  assert.deepEqual(config, before);
  for (const pizza of config.items) {
    assert.equal(rowFor(plan, pizza.id, 'Коробки для пиццы').quantity, '1');
    const paper = rowFor(plan, pizza.id, 'Пергамент');
    assert.equal(paper.quantity, '30');
    assert.equal(paper.purchaseQuantity, '2000');
    assert.equal(paper.status, 'ready');
  }
  assert.equal(plan.rows.filter(row => row.stockName === 'Коробки для пиццы').length, 7);
});

test('retains recipe milli amounts and merges proposal for a recipe matched by stock id', () => {
  const config = {
    categories: [{ id: 'drinks', name: 'Напитки' }], items: [item('orange', 'Апельсиновый фреш 0,5 л', 'drinks')], groups: [],
    recipes: [{ item_id: 'orange', component: 'base', ingredients: [{ id: 1, unitId: 1, amount: 18 }] }],
    inventory: [stock(1, 'Апельсины', 'кг'), stock(2, 'Стаканы матовые'), stock(3, 'Крышки большие'), stock(4, 'Трубочки')]
  };
  const plan = buildConsumablesPlan(config);
  const orange = plan.rows.filter(row => row.itemId === 'orange' && row.stockItemId === 1);
  assert.equal(orange.length, 1);
  assert.equal(orange[0].quantity, '18');
  assert.equal(orange[0].unit, 'г');
  assert.equal(orange[0].source, 'existing');
  assert.equal(rowFor(plan, 'orange', 'Стаканы матовые').source, 'confirmed');
  assert.equal(rowFor(plan, 'orange', 'Крышки большие').quantity, '1');
  assert.equal(rowFor(plan, 'orange', 'Трубочки').quantity, '1');
});

test('keeps different active variants distinct and maps packaging and unknown stock conservatively', () => {
  const config = {
    categories: [{ id: 'drink', name: 'Напитки' }],
    items: [item('latte', 'Латте 350 мл', 'drink', { variants: [{ id: 'small', name: 'Малый', active: true }, { id: 'large', name: 'Большой', active: true }] })],
    groups: [], recipes: [{ item_id: 'latte', component: 'variant:small', ingredients: [{ id: 4, amount: 1000 }] }, { item_id: 'latte', component: 'variant:large', ingredients: [{ id: 4, amount: 1000 }] }],
    inventory: [stock(1, 'Стаканы 350 мл', 'упаковка'), stock(2, 'Крышки большие', 'шт', null), stock(3, 'Мешалки'), stock(4, 'Кофе', 'кг')]
  };
  const plan = buildConsumablesPlan(config), cups = plan.rows.filter(row => row.itemId === 'latte' && row.stockName === 'Стаканы 350 мл');
  assert.deepEqual(cups.map(row => row.component), ['variant:small', 'variant:large']);
  assert.ok(cups.every(row => row.quantity === '1' && row.status === 'needs_package'));
  assert.equal(rowFor(plan, 'latte', 'Крышки большие').status, 'needs_stock');
  assert.equal(rowFor(plan, 'latte', 'Мешалки').status, 'ready');
});

test('does not replace recipe caps, invent food grams, or add service cups to packaged items', () => {
  const config = {
    categories: [{ id: 'drinks', name: 'Напитки' }],
    items: [item('coffee', 'Американо 350 мл', 'drinks'), item('can', 'Квас 500 мл, банка', 'drinks')], groups: [],
    recipes: [{ item_id: 'coffee', component: 'base', ingredients: [{ id: 1, unitId: 1, amount: 12 }] }],
    inventory: [stock(1, 'Крышки большие'), stock(2, 'Кофе', 'кг'), stock(3, 'Стаканы 350 мл'), stock(4, 'Мешалки'), stock(5, 'Стаканы для пива 500 мл'), stock(6, 'Трубочки')]
  };
  const plan = buildConsumablesPlan(config);
  assert.equal(plan.rows.filter(row => row.itemId === 'coffee' && row.stockItemId === 1).length, 1);
  assert.equal(plan.rows.find(row => row.itemId === 'coffee' && row.stockItemId === 1).source, 'existing');
  assert.equal(plan.rows.some(row => row.itemId === 'coffee' && row.stockItemId === 2), false);
  assert.equal(plan.rows.some(row => row.itemId === 'can' && /Стакан|Крышк|Трубочк/.test(row.stockName)), false);
});

test('does not invent assumed package counts and leaves unresolved active items visible', () => {
  const config = { categories: [{ id: 'food', name: 'Супы' }], items: [item('soup', 'Суп дня')], groups: [], recipes: [], inventory: [stock(1, 'WOK контейнеры', 'упаковка')] };
  const plan = buildConsumablesPlan(config);
  const container = rowFor(plan, 'soup', 'WOK контейнеры');
  assert.equal(container.quantity, null);
  assert.equal(container.status, 'needs_quantity');
  assert.ok(plan.rows.some(row => row.itemId === 'soup' && row.stockName === 'Основной ингредиент' && row.status === 'needs_mapping'));
  assert.equal(plan.summary.distinctActiveItems, 1);
});
