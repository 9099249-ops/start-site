import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';

const owner = {id: 1, login: 'admin', role: 'admin'};
const staff = {id: 2, login: 'station', role: 'staff'};
const now = Date.parse('2026-09-22T14:00:00+03:00');
// All recipes and balances below are isolated test data, not live norms.
function fixture() {
  const admin = new AdminStore(':memory:');
  admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");
  const sms = new SmsStore(admin, null, {});
  const cafe = new CafeStore(admin, sms, {env: {}});
  const stock = cafe.stock, inventory = stock.inventory;
  const goods = inventory.catalog(owner).items;
  const coffee = goods.find(i => i.name === 'Кофе');
  const milk = goods.find(i => i.name === 'Молоко обычное');
  const oat = goods.find(i => i.name === 'Молоко овсяное');
  const coconut = goods.find(i => i.name === 'Молоко кокосовое');
  const item = cafe.catalog().items.find(i => i.name === 'Капучино');
  const option = name => cafe.catalog().groups.flatMap(g => g.options).find(o => o.name === name);
  const oatOption = option('Овсяное');
  const editMenu = fn => { const menu = cafe.catalog(); fn(menu); cafe.saveCatalog(menu, owner); };
  editMenu(menu => {
    menu.groups.push({id: 'test-extras', name: 'Тестовые добавки', active: true, min: 0, max: 2, options: [
      {id: 'test-extra-milk', name: 'Дополнительное обычное молоко', priceCents: 0, active: true, soldOut: false},
      {id: 'test-second-swap', name: 'Другая замена', priceCents: 0, active: true, soldOut: false},
    ]});
    menu.items.find(i => i.id === item.id).groupIds.push('test-extras');
  });
  const save = (component, ingredients) => stock.save({itemId: item.id, component, ingredients, revision: stock.recipe(item.id, component)?.revision ?? -1}, owner);
  const base = () => save('base', [{id: coffee.id, amount: '0.018'}, {id: milk.id, amount: '0.25'}]);
  const replacement = () => save('option:' + oatOption.id, [{id: oat.id, amount: '0.25', replacesId: milk.id}]);
  const balance = (good, amount) => {
    const row = inventory.row(good.id);
    inventory.move({id: row.id, revision: row.revision, kind: 'SET', reason:'Проверочный пересчёт', amount, requestId: randomUUID()}, owner);
  };
  const order = (options = [], quantity = 1, variantId) => {
    const line = {itemId: item.id, quantity, optionIds: options, ...(variantId ? {variantId} : {})};
    return {requestId: randomUUID(), name: '', phone: '', consent: false, fulfillment: 'pickup', payment: 'unspecified',
      items: [line], expectedTotalCents: cafe.calculate([line], 'pickup').totalCents};
  };
  const line = (options = [], variant) => ({itemId: item.id, name: item.name, quantity: 1, modifiers: options.map(optionId => ({optionId})), ...(variant ? {variant: {id: variant}} : {})});
  const rows = table => admin.db.prepare('SELECT * FROM ' + table).all();
  const balances = () => [coffee, milk, oat, coconut].map(i => [i.id, inventory.row(i.id).current_milli]);
  const saleState = () => Object.fromEntries(['inventory_items', 'inventory_transactions', 'cafe_orders', 'cafe_order_events', 'cafe_stock_usage', 'cafe_notifications'].map(t => [t, rows(t)]));
  return {admin, sms, cafe, stock, inventory, coffee, milk, oat, coconut, item, option, oatOption, editMenu, save, base, replacement, balance, order, line, rows, balances, saleState};
}

function check(name, fn) {
  test(name, () => { const f = fixture(); try { fn(f); } finally { f.admin.close(); } });
}

check('Stock replacements: optional target survives save, reload, config, and recipe audit', f => {
  const saved = f.replacement();
  const expected = [{id: f.oat.id, unitId: f.oat.unit_id, amount: 250, replacesId: f.milk.id}];
  assert.deepEqual(saved.ingredients, expected);
  assert.deepEqual(JSON.parse(saved.body), expected);
  const reloaded = new CafeStore(f.admin, f.sms, {env: {}});
  assert.deepEqual(reloaded.stock.recipe(f.item.id, 'option:' + f.oatOption.id).ingredients, expected);
  assert.deepEqual(reloaded.stock.config(owner).recipes.find(r => r.component === 'option:' + f.oatOption.id).ingredients, expected);
  const firstAudit = JSON.parse(f.rows('cafe_audit').filter(r => r.action === 'recipe').at(-1).body);
  assert.equal(firstAudit.before, null);
  assert.deepEqual(firstAudit.after.ingredients, expected);
  f.save('option:' + f.oatOption.id, [{id: f.oat.id, amount: '0.2', replacesId: f.milk.id}]);
  const updateAudit = JSON.parse(f.rows('cafe_audit').filter(r => r.action === 'recipe').at(-1).body);
  assert.deepEqual(updateAudit.before.ingredients, expected);
  assert.equal(updateAudit.after.ingredients[0].replacesId, f.milk.id);
  assert.equal(updateAudit.after.ingredients[0].amount, 200);
});

check('Stock replacements: invalid target IDs, self replacement, and nonpositive doses do not save or audit', f => {
  const component = 'option:' + f.oatOption.id;
  const before = {recipes: f.rows('cafe_recipes'), audit: f.rows('cafe_audit')};
  const ingredients = [
    ...[null, undefined, 0, -1, 1.5, String(f.milk.id), Number.MAX_SAFE_INTEGER + 1, 999999999].map(replacesId => [{id: f.oat.id, amount: '0.25', replacesId}]),
    [{id: f.oat.id, amount: '0.25', replacesId: f.oat.id}],
    [{id: f.oat.id, amount: '0', replacesId: f.milk.id}],
    [{id: f.oat.id, amount: '-0.25', replacesId: f.milk.id}],
  ];
  for (const recipe of ingredients) {
    assert.throws(() => f.save(component, recipe));
    assert.deepEqual(f.rows('cafe_recipes'), before.recipes);
    assert.deepEqual(f.rows('cafe_audit'), before.audit);
  }
  assert.throws(() => f.stock.save({itemId: f.item.id, component, revision: -1, ingredients: [{id: f.oat.id, amount: '0.25', replacesId: f.milk.id}]}, staff), e => e.status === 403);
});

check('Stock replacements: base and variant recipes cannot declare a replacement', f => {
  f.editMenu(menu => { menu.items.find(i => i.id === f.item.id).variants = [{id: 'test-large', name: 'Большой', priceCents: 0, active: true}]; });
  for (const component of ['base', 'variant:test-large']) {
    assert.throws(() => f.save(component, [{id: f.oat.id, amount: '0.25', replacesId: f.milk.id}]));
    assert.equal(f.stock.recipe(f.item.id, component), null);
  }
  assert.equal(f.rows('cafe_audit').filter(r => r.action === 'recipe').length, 0);
});

check('Stock replacements: duplicate targets within one option are rejected atomically', f => {
  assert.throws(() => f.save('option:' + f.oatOption.id, [
    {id: f.oat.id, amount: '0.15', replacesId: f.milk.id},
    {id: f.coconut.id, amount: '0.1', replacesId: f.milk.id},
  ]));
  assert.equal(f.rows('cafe_recipes').length, 0);
  assert.equal(f.rows('cafe_audit').filter(r => r.action === 'recipe').length, 0);
});

check('Stock replacements: an archived original is valid but an inactive new ingredient is rejected', f => {
  f.base();
  f.balance(f.coffee, '1'); f.balance(f.milk, '0'); f.balance(f.oat, '2');
  f.admin.db.prepare('UPDATE inventory_items SET active=0 WHERE id=?').run(f.milk.id);
  f.replacement();
  assert.equal(f.cafe.create(f.order([f.oatOption.id]), staff, 'test', now).status, 'NEW');
  assert.equal(f.inventory.row(f.milk.id).current_milli, 0);
  f.admin.db.prepare('UPDATE inventory_items SET active=0 WHERE id=?').run(f.oat.id);
  const before = f.rows('cafe_recipes');
  assert.throws(() => f.save('option:test-second-swap', [{id: f.oat.id, amount: '0.25', replacesId: f.milk.id}]));
  assert.deepEqual(f.rows('cafe_recipes'), before);
});

check('Stock replacements: oat staff order succeeds at zero ordinary milk and records only actual usage', f => {
  f.base(); f.replacement();
  f.balance(f.coffee, '1'); f.balance(f.milk, '0'); f.balance(f.oat, '2');
  const before = f.saleState();
  assert.throws(() => f.cafe.create(f.order(), staff, 'test', now), e => e.stockCode === 'INSUFFICIENT');
  assert.deepEqual(f.saleState(), before);
  const created = f.cafe.create(f.order([f.oatOption.id], 2), staff, 'test', now);
  assert.equal(created.status, 'NEW');
  assert.equal(f.inventory.row(f.coffee.id).current_milli, 964);
  assert.equal(f.inventory.row(f.milk.id).current_milli, 0);
  assert.equal(f.inventory.row(f.oat.id).current_milli, 1500);
  const usage = f.rows('cafe_stock_usage').filter(r => r.order_id === created.id);
  assert.equal(usage.length, 2);
  assert.deepEqual(new Map(usage.map(r => [r.item_id, r.amount_milli])), new Map([[f.coffee.id, 36], [f.oat.id, 500]]));
});

check('Stock replacements: additive recipes without replacesId remain additive', f => {
  f.base();
  const component = 'option:' + f.oatOption.id;
  f.save(component, [{id: f.oat.id, amount: '0.05'}]);
  assert.equal(Object.hasOwn(f.stock.recipe(f.item.id, component).ingredients[0], 'replacesId'), false);
  f.balance(f.coffee, '1'); f.balance(f.milk, '2'); f.balance(f.oat, '2');
  f.cafe.create(f.order([f.oatOption.id], 2), staff, 'test', now);
  assert.equal(f.inventory.row(f.coffee.id).current_milli, 964);
  assert.equal(f.inventory.row(f.milk.id).current_milli, 1500);
  assert.equal(f.inventory.row(f.oat.id).current_milli, 1900);
});

check('Stock replacements: swapping the base preserves ordinary milk supplied by other selected options', f => {
  f.base(); f.replacement();
  f.save('option:test-extra-milk', [{id: f.milk.id, amount: '0.05'}]);
  f.balance(f.coffee, '1'); f.balance(f.milk, '1'); f.balance(f.oat, '2');
  const selections = [[f.oatOption.id, 'test-extra-milk'], ['test-extra-milk', f.oatOption.id]];
  for (const selected of selections) {
    const requirements = f.stock.requirements(f.line(selected));
    assert.equal(requirements.filter(i => i.id === f.milk.id).reduce((n, i) => n + i.amount, 0), 50);
    f.cafe.create(f.order(selected, 2), staff, 'test', now);
  }
  assert.equal(f.inventory.row(f.coffee.id).current_milli, 928);
  assert.equal(f.inventory.row(f.milk.id).current_milli, 800);
  assert.equal(f.inventory.row(f.oat.id).current_milli, 1000);
});

check('Stock replacements: every ingredient in a replacement option is still added', f => {
  f.base();
  f.save('option:' + f.oatOption.id, [{id: f.oat.id, amount: '0.25', replacesId: f.milk.id}, {id: f.coffee.id, amount: '0.005'}]);
  f.balance(f.coffee, '1'); f.balance(f.milk, '0'); f.balance(f.oat, '2');
  f.cafe.create(f.order([f.oatOption.id], 2), staff, 'test', now);
  assert.equal(f.inventory.row(f.coffee.id).current_milli, 954);
  assert.equal(f.inventory.row(f.milk.id).current_milli, 0);
  assert.equal(f.inventory.row(f.oat.id).current_milli, 1500);
});

check('Stock replacements: a missing base target cannot be supplied by another additive option', f => {
  f.save('base', [{id: f.coffee.id, amount: '0.018'}]);
  f.replacement(); f.save('option:test-extra-milk', [{id: f.milk.id, amount: '0.05'}]);
  f.balance(f.coffee, '1'); f.balance(f.milk, '1'); f.balance(f.oat, '2');
  const before = f.saleState();
  for (const selected of [[f.oatOption.id], [f.oatOption.id, 'test-extra-milk'], ['test-extra-milk', f.oatOption.id]]) {
    assert.throws(() => f.cafe.create(f.order(selected), staff, 'test', now), e => e.stockCode === 'UNCONFIGURED' && e.itemId === f.item.id);
    assert.deepEqual(f.saleState(), before);
  }
});

check('Stock replacements: two selected options replacing one base target fail atomically', f => {
  f.base(); f.replacement();
  f.save('option:test-second-swap', [{id: f.coconut.id, amount: '0.25', replacesId: f.milk.id}]);
  for (const good of [f.coffee, f.milk, f.oat, f.coconut]) f.balance(good, '2');
  const before = f.saleState();
  for (const selected of [[f.oatOption.id, 'test-second-swap'], ['test-second-swap', f.oatOption.id]]) {
    assert.throws(() => f.cafe.create(f.order(selected), staff, 'test', now), e => e.stockCode === 'UNCONFIGURED');
    assert.deepEqual(f.saleState(), before);
  }
});

check('Stock replacements: the selected variant supplies the replacement target, not the base recipe', f => {
  f.editMenu(menu => { menu.items.find(i => i.id === f.item.id).variants = [
    {id: 'test-milk', name: 'Молочный', priceCents: 0, active: true},
    {id: 'test-black', name: 'Чёрный', priceCents: 0, active: true},
  ]; });
  f.base();
  f.save('variant:test-milk', [{id: f.coffee.id, amount: '0.02'}, {id: f.milk.id, amount: '0.4'}]);
  f.save('variant:test-black', [{id: f.coffee.id, amount: '0.03'}]);
  f.replacement();
  f.balance(f.coffee, '1'); f.balance(f.milk, '0'); f.balance(f.oat, '2');
  const before = f.saleState();
  assert.throws(() => f.cafe.create(f.order([f.oatOption.id], 1, 'test-black'), staff, 'test', now), e => e.stockCode === 'UNCONFIGURED');
  assert.deepEqual(f.saleState(), before);
  f.cafe.create(f.order([f.oatOption.id], 2, 'test-milk'), staff, 'test', now);
  assert.equal(f.inventory.row(f.coffee.id).current_milli, 960);
  assert.equal(f.inventory.row(f.milk.id).current_milli, 0);
  assert.equal(f.inventory.row(f.oat.id).current_milli, 1500);
});

check('Stock replacements: separate order lines can replace the same target independently', f => {
  f.base(); f.replacement();
  f.save('option:test-second-swap', [{id: f.coconut.id, amount: '0.25', replacesId: f.milk.id}]);
  f.balance(f.coffee, '1'); f.balance(f.milk, '0'); f.balance(f.oat, '2'); f.balance(f.coconut, '2');
  const body = f.order([f.oatOption.id]);
  body.items.push(f.order(['test-second-swap']).items[0]);
  body.expectedTotalCents = f.cafe.calculate(body.items, 'pickup').totalCents;
  f.cafe.create(body, staff, 'test', now);
  assert.equal(f.inventory.row(f.coffee.id).current_milli, 964);
  assert.equal(f.inventory.row(f.milk.id).current_milli, 0);
  assert.equal(f.inventory.row(f.oat.id).current_milli, 1750);
  assert.equal(f.inventory.row(f.coconut.id).current_milli, 1750);
});

check('Stock replacements: cancellation returns actual ingredients once even after recipe changes', f => {
  f.base(); f.replacement();
  f.balance(f.coffee, '1'); f.balance(f.milk, '0'); f.balance(f.oat, '2'); f.balance(f.coconut, '3');
  const before = f.balances();
  const created = f.cafe.create(f.order([f.oatOption.id], 2), staff, 'test', now);
  f.save('option:' + f.oatOption.id, [{id: f.coconut.id, amount: '0.4', replacesId: f.milk.id}]);
  const cancelled = f.cafe.status({id: created.id, revision: created.revision, status: 'CANCELLED'}, staff, now + 1000);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.deepEqual(f.balances(), before);
  const usage = f.rows('cafe_stock_usage').filter(r => r.order_id === created.id);
  assert.deepEqual(new Set(usage.map(r => r.item_id)), new Set([f.coffee.id, f.oat.id]));
  assert.ok(usage.every(r => r.restored_at === now + 1000));
  const history = f.rows('inventory_transactions');
  f.cafe.status({id: cancelled.id, revision: cancelled.revision, status: 'CANCELLED'}, staff, now + 2000);
  assert.deepEqual(f.balances(), before);
  assert.deepEqual(f.rows('inventory_transactions'), history);
});

check('Stock replacements: menu exposes the available oat choice and compatible sugar choices at zero ordinary milk', f => {
  f.base(); f.replacement();
  const ordinary = f.option('Обычное'), noSugar = f.option('Без сахара'), withSugar = f.option('1 пакетик');
  const sugar = f.inventory.catalog(owner).items.find(i => i.name === 'Сахар в стиках');
  f.save('option:' + ordinary.id, []);
  f.save('option:' + noSugar.id, []);
  f.save('option:' + withSugar.id, [{id: sugar.id, amount: '1'}]);
  f.balance(f.coffee, '1'); f.balance(f.milk, '0'); f.balance(f.oat, '1'); f.balance(sugar, '10');
  const menuStock = () => f.cafe.publicMenu().items.find(i => i.id === f.item.id).stock;
  const current = menuStock(), choice = id => current.options.find(o => o.optionId === id);
  assert.equal(current.available, 4);
  assert.equal(current.defaultAvailable, 0);
  assert.equal(choice(f.oatOption.id).available, 4);
  assert.equal(choice(f.oatOption.id).replaces, true);
  assert.equal(choice(ordinary.id).available, 0);
  assert.equal(choice(noSugar.id).available, 4);
  assert.equal(choice(withSugar.id).available, 4);
  f.balance(f.oat, '0');
  const depleted = menuStock();
  assert.equal(depleted.available, 0);
  assert.equal(depleted.options.find(o => o.optionId === noSugar.id).available, 0);
  assert.equal(depleted.options.find(o => o.optionId === withSugar.id).available, 0);
});

test('Stock replacements: missing, disconnected, inactive, or sold-out replacement choices cannot unlock a menu item', () => {
  const scenarios = [
    ['missing recipe', f => f.admin.db.prepare('DELETE FROM cafe_recipes WHERE item_id=? AND component=?').run(f.item.id, 'option:' + f.oatOption.id)],
    ['disconnected group', f => f.editMenu(m => { const item = m.items.find(i => i.id === f.item.id); item.groupIds = item.groupIds.filter(id => id !== 'coffee_milk'); })],
    ['inactive group', f => f.editMenu(m => { m.groups.find(g => g.id === 'coffee_milk').active = false; })],
    ['inactive option', f => f.editMenu(m => { m.groups.find(g => g.id === 'coffee_milk').options.find(o => o.id === f.oatOption.id).active = false; })],
    ['sold-out option', f => f.editMenu(m => { m.groups.find(g => g.id === 'coffee_milk').options.find(o => o.id === f.oatOption.id).soldOut = true; })],
  ];
  for (const [label, mutate] of scenarios) {
    const f = fixture();
    try {
      f.base(); f.replacement();
      f.balance(f.coffee, '1'); f.balance(f.milk, '0'); f.balance(f.oat, '1');
      mutate(f);
      const state = f.cafe.publicMenu().items.find(i => i.id === f.item.id).stock;
      assert.equal(state.available, 0, label);
      assert.equal(state.defaultAvailable, 0, label);
    } finally { f.admin.close(); }
  }
});
