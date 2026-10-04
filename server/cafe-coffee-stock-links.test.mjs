import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {linkCoffeeStock} from './cafe-coffee-stock-links.mjs';

const owner = {id: 1, login: 'admin', role: 'admin'};
const staff = {id: 2, login: 'station', role: 'staff'};
const now = Date.parse('2026-09-22T14:00:00+03:00');
// These doses are isolated test inputs, never approved production recipes.
const cappuccinoPlan = () => [{name: 'Капучино', coffeeGrams: 18, milkMl: 250}];
const blackPlan = () => [{name: 'Американо', coffeeGrams: 18}];

function fixture() {
  const admin = new AdminStore(':memory:');
  admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");
  const sms = new SmsStore(admin, null, {});
  const cafe = new CafeStore(admin, sms, {env: {}});
  const inventory = cafe.stock.inventory;
  const goods = inventory.catalog(owner).items;
  const coffee = goods.find(i => i.name === 'Кофе');
  const milk = goods.find(i => i.name === 'Молоко обычное');
  const dish = name => cafe.catalog().items.find(i => i.name === name);
  const option = name => cafe.catalog().groups.flatMap(g => g.options).find(o => o.name === name);
  const balance = (item, amount) => {
    const row = inventory.row(item.id);
    inventory.move({id: row.id, revision: row.revision, kind: 'SET', reason:'Проверочный пересчёт', amount, requestId: randomUUID()}, owner);
  };
  const unit = (item, name) => {
    const id = inventory.dictionary('inventory_units', name);
    admin.db.prepare('UPDATE inventory_items SET unit_id=? WHERE id=?').run(id, item.id);
    return id;
  };
  const editMenu = edit => { const menu = cafe.catalog(); edit(menu); cafe.saveCatalog(menu, owner); };
  const order = (name = 'Капучино', quantity = 1, optionNames = []) => {
    const item = dish(name), options = optionNames.map(option);
    return {requestId: randomUUID(), name: '', phone: '', consent: false, fulfillment: 'pickup', payment: 'unspecified',
      items: [{itemId: item.id, quantity, optionIds: options.map(o => o.id)}],
      expectedTotalCents: quantity * (item.priceCents + options.reduce((sum, o) => sum + o.priceCents, 0))};
  };
  const rows = table => admin.db.prepare('SELECT * FROM ' + table).all();
  const changes = () => admin.db.prepare('SELECT total_changes() n').get().n;
  return {admin, sms, cafe, inventory, coffee, milk, dish, option, balance, unit, editMenu, order, rows, changes};
}

function check(name, fn) {
  test(name, () => { const f = fixture(); try { fn(f); } finally { f.admin.close(); } });
}

check('Coffee plan: two staff cappuccinos consume exactly the supplied 18 g and 250 ml per cup', f => {
  f.balance(f.coffee, '1');
  f.balance(f.milk, '2');
  const beforeInventory = f.rows('inventory_items'), beforeMenu = f.cafe.catalog();
  assert.equal(linkCoffeeStock(f.cafe, owner, cappuccinoPlan())[0].status, 'linked');
  assert.deepEqual(f.rows('inventory_items'), beforeInventory);
  assert.deepEqual(f.cafe.catalog(), beforeMenu);
  for (const name of ['Без сахара', 'Обычное']) {
    assert.deepEqual(f.cafe.stock.recipe(f.dish('Капучино').id, 'option:' + f.option(name).id).ingredients, []);
  }
  const created = f.cafe.create(f.order('Капучино', 2, ['Без сахара', 'Обычное']), staff, 'test', now);
  assert.equal(created.status, 'NEW');
  assert.equal(f.inventory.row(f.coffee.id).current_milli, 964);
  assert.equal(f.inventory.row(f.milk.id).current_milli, 1500);
  assert.deepEqual(f.rows('cafe_stock_usage').map(r => [r.item_id, r.amount_milli]).sort((a, b) => a[0] - b[0]), [[f.coffee.id, 36], [f.milk.id, 500]]);
});

check('Coffee plan: insufficient milk rejects an order without consuming coffee or saving any order', f => {
  f.balance(f.coffee, '1');
  f.balance(f.milk, '0.25');
  linkCoffeeStock(f.cafe, owner, cappuccinoPlan());
  const before = Object.fromEntries(['inventory_items', 'inventory_transactions', 'cafe_orders', 'cafe_order_events', 'cafe_stock_usage', 'cafe_notifications'].map(t => [t, f.rows(t)]));
  assert.throws(() => f.cafe.create(f.order('Капучино', 2, ['Без сахара', 'Обычное']), staff, 'test', now), e => e.stockCode === 'INSUFFICIENT' && e.available === 1);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(f.rows(table), rows, table);
});

for (const [coffeeUnit, milkUnit, factor] of [['г', 'мл', 1000], ['g', 'ml', 1000], ['kg', 'l', 1]])
check('Coffee plan: ' + coffeeUnit + '/' + milkUnit + ' units preserve exact quantities through a staff sale', f => {
  f.unit(f.coffee, coffeeUnit);
  f.unit(f.milk, milkUnit);
  f.balance(f.coffee, String(factor));
  f.balance(f.milk, String(2 * factor));
  linkCoffeeStock(f.cafe, owner, cappuccinoPlan());
  const recipe = f.cafe.stock.recipe(f.dish('Капучино').id, 'base');
  assert.deepEqual(recipe.ingredients.map(i => [i.id, i.amount]), [[f.coffee.id, 18 * factor], [f.milk.id, 250 * factor]]);
  f.cafe.create(f.order('Капучино', 2, ['Без сахара', 'Обычное']), staff, 'test', now);
  assert.equal(f.inventory.row(f.coffee.id).current_milli, 964 * factor);
  assert.equal(f.inventory.row(f.milk.id).current_milli, 1500 * factor);
});

check('Coffee plan: staff and absent or malformed plans cause no writes', f => {
  const before = f.changes();
  assert.throws(() => linkCoffeeStock(f.cafe, staff, cappuccinoPlan()), e => e.status === 403);
  const invalid = [undefined, null, [], {}, '18/250', [null], [{}],
    [{name: 'Капучино', coffeeGrams: '18', milkMl: 250}],
    [{name: 'Капучино', coffeeGrams: 18.5, milkMl: 250}],
    [{name: 'Капучино', coffeeGrams: 0, milkMl: 250}],
    [{name: 'Капучино', coffeeGrams: -1, milkMl: 250}],
    [{name: 'Капучино', coffeeGrams: Number.MAX_SAFE_INTEGER + 1, milkMl: 250}],
    [{name: 'Капучино', coffeeGrams: 18, milkMl: '250'}],
    [{name: 'Капучино', coffeeGrams: 18, milkMl: 0}],
    [{name: 'Капучино', coffeeGrams: 18, milkMl: 250.5}],
    [{name: 'Капучино', coffeeGrams: 18}],
    [{name: 'Американо', coffeeGrams: 18, milkMl: 250}],
    [{...cappuccinoPlan()[0], guessed: true}],
    [...blackPlan(), ...blackPlan()],
    [...blackPlan(), {name: 'Капучино', coffeeGrams: '18', milkMl: 250}]];
  for (const plan of invalid) {
    assert.throws(() => linkCoffeeStock(f.cafe, owner, plan), 'plan: ' + JSON.stringify(plan));
    assert.equal(f.changes(), before, 'validation must precede every recipe or audit write');
  }
});

check('Coffee plan: all five exact supported names link only supplied doses', f => {
  const plan = [{name: 'Двойной эспрессо', coffeeGrams: 18}, ...blackPlan(), ...cappuccinoPlan(),
    {name: 'Латте', coffeeGrams: 19, milkMl: 260}, {name: 'Флэт уайт', coffeeGrams: 20, milkMl: 180}];
  assert.deepEqual(linkCoffeeStock(f.cafe, owner, plan).map(r => r.status), Array(5).fill('linked'));
  for (const row of plan) {
    const ingredients = f.cafe.stock.recipe(f.dish(row.name).id, 'base').ingredients;
    assert.equal(ingredients.find(i => i.id === f.coffee.id).amount, row.coffeeGrams);
    assert.equal(ingredients.find(i => i.id === f.milk.id)?.amount, row.milkMl);
  }
  for (const item of f.cafe.catalog().items.filter(item => !plan.some(row => row.name === item.name))) {
    assert.equal(f.cafe.stock.recipe(item.id, 'base'), null, 'unplanned dish: ' + item.name);
  }
});

check('Coffee plan: preserves existing base and option recipes, menu flags, inventory, and audit on repeated use', f => {
  const itemId = f.dish('Капучино').id;
  f.cafe.stock.save({itemId, component: 'base', revision: -1, ingredients: [{id: f.coffee.id, amount: '0.02'}, {id: f.milk.id, amount: '0.3'}]}, owner);
  f.cafe.db.prepare('INSERT INTO cafe_recipes(item_id,component,body,revision) VALUES(?,?,?,0)').run(itemId, 'option:' + f.option('Без сахара').id, JSON.stringify([{id: f.coffee.id, unitId: f.inventory.row(f.coffee.id).unit_id, amount: '0.001'}]));
  f.cafe.db.prepare('INSERT INTO cafe_recipes(item_id,component,body,revision) VALUES(?,?,?,0)').run(itemId, 'option:' + f.option('Обычное').id, JSON.stringify([{id: f.milk.id, unitId: f.inventory.row(f.milk.id).unit_id, amount: '0.01'}]));
  f.editMenu(menu => { menu.items.find(i => i.id === itemId).soldOut = true; menu.groups.find(g => g.id === 'coffee_milk').options[0].soldOut = true; });
  const before = {recipes: f.rows('cafe_recipes'), menu: f.cafe.catalog(), inventory: f.rows('inventory_items'), audit: f.rows('cafe_audit'), changes: f.changes()};
  for (let i = 0; i < 2; i++) assert.equal(linkCoffeeStock(f.cafe, owner, cappuccinoPlan())[0].status, 'kept_existing');
  assert.deepEqual(f.rows('cafe_recipes'), before.recipes);
  assert.deepEqual(f.cafe.catalog(), before.menu);
  assert.deepEqual(f.rows('inventory_items'), before.inventory);
  assert.deepEqual(f.rows('cafe_audit'), before.audit);
  assert.equal(f.changes(), before.changes);
});

check('Coffee plan: newly linked recipes and their zero options are idempotent without extra audit', f => {
  linkCoffeeStock(f.cafe, owner, cappuccinoPlan());
  const before = {changes: f.changes(), recipes: f.rows('cafe_recipes'), audit: f.rows('cafe_audit')};
  assert.equal(linkCoffeeStock(f.cafe, owner, cappuccinoPlan())[0].status, 'kept_existing');
  assert.equal(f.changes(), before.changes);
  assert.deepEqual(f.rows('cafe_recipes'), before.recipes);
  assert.deepEqual(f.rows('cafe_audit'), before.audit);
});

check('Coffee plan: sugar and alternative milk remain UNCONFIGURED and cannot consume stock', f => {
  f.balance(f.coffee, '1'); f.balance(f.milk, '2');
  linkCoffeeStock(f.cafe, owner, cappuccinoPlan());
  const inventory = f.rows('inventory_items');
  for (const optionName of ['1 пакетик', '2 пакетика', 'Овсяное', 'Кокосовое', 'Безлактозное']) {
    assert.equal(f.cafe.stock.recipe(f.dish('Капучино').id, 'option:' + f.option(optionName).id), null);
    assert.throws(() => f.cafe.create(f.order('Капучино', 1, [optionName]), staff, 'test', now), e => e.stockCode === 'UNCONFIGURED');
    assert.deepEqual(f.rows('inventory_items'), inventory);
  }
  assert.equal(f.rows('cafe_orders').length, 0);
});

for (const [label, mutate] of [
  ['inactive dish', f => f.editMenu(m => { m.items.find(i => i.name === 'Капучино').active = false; })],
  ['ambiguous dish', f => f.editMenu(m => { const item = m.items.find(i => i.name === 'Капучино'); m.items.push({...item, id: 'duplicate-cappuccino'}); })],
  ['dish with variants', f => f.editMenu(m => { m.items.find(i => i.name === 'Капучино').variants = [{id: 'large-test', name: 'Большой', priceCents: 0, active: true}]; })],
  ['missing coffee', f => f.admin.db.prepare("UPDATE inventory_items SET name='Другой кофе' WHERE id=?").run(f.coffee.id)],
  ['inactive coffee', f => f.admin.db.prepare('UPDATE inventory_items SET active=0 WHERE id=?').run(f.coffee.id)],
  ['missing milk', f => f.admin.db.prepare("UPDATE inventory_items SET name='Другое молоко' WHERE id=?").run(f.milk.id)],
  ['inactive milk', f => f.admin.db.prepare('UPDATE inventory_items SET active=0 WHERE id=?').run(f.milk.id)],
  ['ambiguous coffee', f => f.admin.db.prepare("UPDATE inventory_items SET name='Кофе' WHERE id=?").run(f.rows('inventory_items').find(i => ![f.coffee.id, f.milk.id].includes(i.id)).id)],
  ['ambiguous milk', f => f.admin.db.prepare("UPDATE inventory_items SET name='Молоко обычное' WHERE id=?").run(f.rows('inventory_items').find(i => ![f.coffee.id, f.milk.id].includes(i.id)).id)],
  ['incompatible coffee unit', f => f.unit(f.coffee, 'шт')],
  ['non-exact coffee unit', f => f.unit(f.coffee, 'килограмм')],
  ['incompatible milk unit', f => f.unit(f.milk, 'шт')],
]) check('Coffee plan: ' + label + ' needs review without recipe changes', f => {
  mutate(f);
  const before = f.changes();
  assert.equal(linkCoffeeStock(f.cafe, owner, cappuccinoPlan())[0].status, 'needs_review');
  assert.equal(f.changes(), before);
  assert.equal(f.rows('cafe_recipes').length, 0);
});

check('Coffee plan: unsupported and non-exact dish names are not inferred from the menu', f => {
  const before = f.changes();
  for (const name of ['Раф', 'капучино', 'Капучино большой']) {
    assert.equal(linkCoffeeStock(f.cafe, owner, [{name, coffeeGrams: 18, milkMl: 250}])[0].status, 'needs_review');
  }
  assert.equal(f.changes(), before);
});

for (const [label, mutate] of [
  ['disconnected groups', m => { m.items.find(i => i.name === 'Капучино').groupIds = []; }],
  ['inactive groups', m => { for (const g of m.groups.filter(g => g.id.startsWith('coffee_'))) g.active = false; }],
  ['inactive options', m => { for (const g of m.groups.filter(g => g.id.startsWith('coffee_'))) g.options[0].active = false; }],
  ['non-exact option names', m => { m.groups.find(g => g.id === 'coffee_sugar').options[0].name = 'без сахара'; m.groups.find(g => g.id === 'coffee_milk').options[0].name = 'Обычное молоко'; }],
]) check('Coffee plan: ' + label + ' receive no automatic zero recipes', f => {
  f.editMenu(mutate);
  linkCoffeeStock(f.cafe, owner, cappuccinoPlan());
  assert.deepEqual(f.rows('cafe_recipes').map(r => r.component), ['base']);
});

check('Coffee plan: zero options follow preserved ingredients, not the replacement plan', f => {
  const itemId = f.dish('Капучино').id;
  f.cafe.stock.save({itemId, component: 'base', revision: -1, ingredients: [{id: f.coffee.id, amount: '0.02'}]}, owner);
  const before = f.cafe.stock.recipe(itemId, 'base');
  assert.equal(linkCoffeeStock(f.cafe, owner, cappuccinoPlan())[0].status, 'kept_existing');
  assert.deepEqual(f.cafe.stock.recipe(itemId, 'base'), before);
  assert.deepEqual(f.cafe.stock.recipe(itemId, 'option:' + f.option('Без сахара').id).ingredients, []);
  assert.equal(f.cafe.stock.recipe(itemId, 'option:' + f.option('Обычное').id), null);
});

check('Coffee plan: a preserved base without coffee does not authorize a no-sugar recipe', f => {
  const itemId = f.dish('Капучино').id;
  f.cafe.stock.save({itemId, component: 'base', revision: -1, ingredients: [{id: f.milk.id, amount: '0.25'}]}, owner);
  linkCoffeeStock(f.cafe, owner, cappuccinoPlan());
  assert.equal(f.cafe.stock.recipe(itemId, 'option:' + f.option('Без сахара').id), null);
});

check('Coffee plan: changing the milk unit makes a preserved milk recipe unsafe for an ordinary-milk zero option', f => {
  const itemId = f.dish('Капучино').id;
  f.cafe.stock.save({itemId, component: 'base', revision: -1, ingredients: [{id: f.coffee.id, amount: '0.018'}, {id: f.milk.id, amount: '0.25'}]}, owner);
  f.unit(f.milk, 'мл');
  const before = f.cafe.stock.recipe(itemId, 'base');
  linkCoffeeStock(f.cafe, owner, cappuccinoPlan());
  assert.deepEqual(f.cafe.stock.recipe(itemId, 'base'), before);
  assert.equal(f.cafe.stock.recipe(itemId, 'option:' + f.option('Обычное').id), null);
});
