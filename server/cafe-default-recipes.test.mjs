import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {SmsStore} from './sms.mjs';
import {fillDefaultCafeRecipes} from './cafe-default-recipes.mjs';

const owner = {id: 1, login: 'admin', role: 'admin'};
const staff = {id: 2, login: 'station', role: 'staff'};
const now = Date.parse('2026-09-22T14:00:00+03:00');
const kitName = 'Чайный набор «У самовара» — готовый комплект';

function fixture() {
  const admin = new AdminStore(':memory:');
  admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'station','staff','unused')");
  const sms = new SmsStore(admin, null, {});
  const cafe = new CafeStore(admin, sms, {env: {}});
  const stock = cafe.stock, inventory = stock.inventory;
  const good = name => inventory.catalog(owner).items.find(i => i.name === name);
  const dish = name => cafe.catalog().items.find(i => i.name === name);
  const option = name => cafe.catalog().groups.flatMap(g => g.options).find(o => o.name === name);
  const rows = table => admin.db.prepare('SELECT * FROM ' + table).all();
  const changes = () => admin.db.prepare('SELECT total_changes() n').get().n;
  const editMenu = fn => { const menu = cafe.catalog(); fn(menu); cafe.saveCatalog(menu, owner); };
  const save = (name, component, ingredients) => {
    const item = dish(name);
    return stock.save({itemId: item.id, component, ingredients, revision: stock.recipe(item.id, component)?.revision ?? -1}, owner);
  };
  const balance = (name, amount) => {
    const item = good(name);
    inventory.move({id: item.id, revision: item.revision, kind: 'SET', amount, requestId: randomUUID()}, owner);
  };
  const order = (name, quantity = 1, optionNames = [], variantId) => {
    const line = {itemId: dish(name).id, quantity, optionIds: optionNames.map(name => option(name).id), ...(variantId ? {variantId} : {})};
    return {requestId: randomUUID(), name: '', phone: '', consent: false, fulfillment: 'pickup', payment: 'unspecified',
      items: [line], expectedTotalCents: cafe.calculate([line], 'pickup').totalCents};
  };
  const primaryComponents = () => cafe.catalog().items.filter(i => i.active && !i.restricted).flatMap(item =>
    (item.variants.length ? item.variants.filter(v => v.active).map(v => 'variant:' + v.id) : ['base']).map(component => ({item, component})));
  return {admin, sms, cafe, stock, inventory, good, dish, option, rows, changes, editMenu, save, balance, order, primaryComponents};
}

function check(name, fn) {
  test(name, () => { const f = fixture(); try { fn(f); } finally { f.admin.close(); } });
}

check('Default recipes: initialization is explicit and staff cannot write recipes, stock, or menu', f => {
  assert.equal(f.rows('cafe_recipes').length, 0);
  const before = {changes: f.changes(), menu: f.cafe.catalog(), inventory: f.rows('inventory_items'), audit: f.rows('cafe_audit')};
  assert.throws(() => fillDefaultCafeRecipes(f.cafe, staff), e => e.status === 403);
  assert.equal(f.changes(), before.changes);
  assert.deepEqual(f.cafe.catalog(), before.menu);
  assert.deepEqual(f.rows('inventory_items'), before.inventory);
  assert.deepEqual(f.rows('cafe_audit'), before.audit);
  assert.equal(f.good(kitName), undefined);
});

check('Default recipes: every primary component of all 42 active dishes is configured without invented balances', f => {
  const existingInventory = f.rows('inventory_items');
  const result = fillDefaultCafeRecipes(f.cafe, owner);
  const active = f.cafe.catalog().items.filter(i => i.active && !i.restricted);
  assert.equal(active.length, 42);
  for (const {item, component} of f.primaryComponents()) {
    const recipe = f.stock.recipe(item.id, component);
    assert.ok(recipe, item.name + ' / ' + component);
    assert.ok(recipe.ingredients.length > 0, item.name + ' must consume configured ingredients');
    assert.ok(recipe.ingredients.every(i => Number.isSafeInteger(i.amount) && i.amount > 0));
  }
  for (const row of existingInventory) assert.deepEqual(f.rows('inventory_items').find(i => i.id === row.id), row);
  const kit = f.good(kitName);
  assert.ok(kit);
  assert.equal(kit.unit, 'комплекты');
  assert.equal(kit.current_milli, null);
  assert.equal(kit.minimum_milli, null);
  assert.equal(kit.target_milli, null);
  assert.equal(f.rows('inventory_items').length, existingInventory.length + 1);
  const review = result.filter(r => r.status === 'needs_review');
  assert.ok(review.every(r => r.name === 'Липтон' && r.reason === 'variant_missing'), JSON.stringify(review));
});

check('Default recipes: tea-blend variants are explicit and use their own stock instead of a generic base', f => {
  fillDefaultCafeRecipes(f.cafe, owner);
  const item = f.dish('Кальян на чайной смеси');
  assert.equal(item.variants.length, 14);
  assert.equal(f.stock.recipe(item.id, 'base'), null);
  for (const variant of item.variants) {
    const ingredients = f.stock.recipe(item.id, 'variant:' + variant.id).ingredients;
    const blend = f.good('Чайная смесь — ' + variant.name);
    assert.equal(ingredients.find(i => i.id === blend.id).amount, 400);
    assert.equal(ingredients.find(i => i.id === f.good('Угли').id).amount, 30);
    assert.equal(ingredients.find(i => i.id === f.good('Мундштуки').id).amount, 10);
  }
});

check('Default recipes: existing base, variant, and option recipes, menu flags, and stock stay untouched', f => {
  const coffee = f.good('Кофе'), milk = f.good('Молоко обычное'), oat = f.good('Молоко овсяное');
  f.save('Капучино', 'base', [{id: coffee.id, amount: '0.024'}, {id: milk.id, amount: '0.3'}]);
  f.save('Капучино', 'option:' + f.option('Овсяное').id, [{id: oat.id, amount: '0.31', replacesId: milk.id}]);
  const tea = f.dish('Классический чай');
  f.save(tea.name, 'variant:' + tea.variants[0].id, [{id: f.good('Чай в стиках').id, amount: '2'}]);
  // A previously configured generic blend must also be preserved, not redesigned.
  f.save('Кальян на чайной смеси', 'base', [{id: f.good('Чайная смесь — Таёжный').id, amount: '0.5'}]);
  f.editMenu(menu => {
    const item = menu.items.find(i => i.name === 'Капучино'); item.soldOut = true; item.priceCents = 54321;
    menu.groups.find(g => g.id === 'coffee_milk').options.find(o => o.name === 'Овсяное').soldOut = true;
  });
  f.balance('Кофе', '1.234'); f.balance('Молоко обычное', '2.345');
  const before = {recipes: f.rows('cafe_recipes'), menu: f.cafe.catalog(), inventory: f.rows('inventory_items'), audit: f.rows('cafe_audit')};
  const result = fillDefaultCafeRecipes(f.cafe, owner);
  for (const row of before.recipes) assert.deepEqual(f.rows('cafe_recipes').find(r => r.item_id === row.item_id && r.component === row.component), row);
  assert.deepEqual(f.cafe.catalog(), before.menu);
  for (const row of before.inventory) assert.deepEqual(f.rows('inventory_items').find(i => i.id === row.id), row);
  for (const row of before.audit) assert.deepEqual(f.rows('cafe_audit').find(i => i.id === row.id), row);
  assert.ok(result.some(r => r.name === 'Капучино' && r.component === 'base' && r.status === 'kept_existing'));
});

check('Default recipes: repeated initialization creates no recipes, inventory, catalog edits, or audit', f => {
  fillDefaultCafeRecipes(f.cafe, owner);
  const before = {changes: f.changes(), recipes: f.rows('cafe_recipes'), inventory: f.rows('inventory_items'), history: f.rows('inventory_transactions'), audit: f.rows('cafe_audit'), menu: f.cafe.catalog()};
  const result = fillDefaultCafeRecipes(f.cafe, owner);
  assert.equal(result.filter(r => r.status === 'linked').length, 0);
  assert.equal(f.changes(), before.changes);
  assert.deepEqual(f.rows('cafe_recipes'), before.recipes);
  assert.deepEqual(f.rows('inventory_items'), before.inventory);
  assert.deepEqual(f.rows('inventory_transactions'), before.history);
  assert.deepEqual(f.rows('cafe_audit'), before.audit);
  assert.deepEqual(f.cafe.catalog(), before.menu);
});

check('Default recipes: archived optional ingredients stay archived and require review without blocking primary recipes', f => {
  const archived = [f.good('Молоко овсяное'), f.good('Сгущёнка обычная')];
  for (const item of archived) f.admin.db.prepare('UPDATE inventory_items SET active=0 WHERE id=?').run(item.id);
  const before = archived.map(item => f.inventory.row(item.id));
  const result = fillDefaultCafeRecipes(f.cafe, owner);
  assert.equal(f.stock.recipe(f.dish('Капучино').id, 'option:' + f.option('Овсяное').id), null);
  assert.equal(f.stock.recipe(f.dish('Сырники').id, 'option:' + f.option('Сгущёнка').id), null);
  assert.ok(result.some(r => r.name === 'Капучино' && r.status === 'needs_review' && r.reason.includes('stock_archived: Молоко овсяное')));
  assert.ok(result.some(r => r.name === 'Сырники' && r.status === 'needs_review' && r.reason.includes('stock_archived: Сгущёнка обычная')));
  for (const row of before) assert.deepEqual(f.inventory.row(row.id), row);
  for (const {item, component} of f.primaryComponents()) assert.ok(f.stock.recipe(item.id, component), item.name + ' / ' + component);
});

for (const [name, ingredientName, grams, milkMl] of [['Капучино', 'Кофе', 18, 250], ['Какао', 'Какао', 25, 220]])
check('Default recipes: a staff order for two ' + name + ' consumes the configured grams and millilitres exactly', f => {
  fillDefaultCafeRecipes(f.cafe, owner);
  f.balance(ingredientName, '1'); f.balance('Молоко обычное', '2');
  const ingredient = f.good(ingredientName), milk = f.good('Молоко обычное');
  const created = f.cafe.create(f.order(name, 2, ['Без сахара', 'Обычное']), staff, 'test', now);
  assert.equal(created.status, 'NEW');
  assert.equal(f.inventory.row(ingredient.id).current_milli, 1000 - 2 * grams);
  assert.equal(f.inventory.row(milk.id).current_milli, 2000 - 2 * milkMl);
  const usage = f.rows('cafe_stock_usage').filter(r => r.order_id === created.id);
  assert.equal(usage.length, 2);
  assert.deepEqual(new Map(usage.map(r => [r.item_id, r.amount_milli])), new Map([[ingredient.id, 2 * grams], [milk.id, 2 * milkMl]]));
});

check('Default recipes: cappuccino and cocoa alternatives replace ordinary milk instead of consuming it twice', f => {
  fillDefaultCafeRecipes(f.cafe, owner);
  f.balance('Кофе', '1'); f.balance('Какао', '1'); f.balance('Молоко обычное', '0'); f.balance('Молоко овсяное', '2');
  const milk = f.good('Молоко обычное'), oat = f.good('Молоко овсяное');
  for (const [name, amount] of [['Капучино', 250], ['Какао', 220]]) {
    const recipe = f.stock.recipe(f.dish(name).id, 'option:' + f.option('Овсяное').id);
    assert.deepEqual(recipe.ingredients, [{id: oat.id, unitId: oat.unit_id, amount, replacesId: milk.id}]);
    assert.throws(() => f.cafe.create(f.order(name), staff, 'test', now), e => e.stockCode === 'INSUFFICIENT');
    f.cafe.create(f.order(name, 2, ['Овсяное', 'Без сахара']), staff, 'test', now);
  }
  assert.equal(f.inventory.row(milk.id).current_milli, 0);
  assert.equal(f.inventory.row(oat.id).current_milli, 1060);
  assert.equal(f.inventory.row(f.good('Кофе').id).current_milli, 964);
  assert.equal(f.inventory.row(f.good('Какао').id).current_milli, 950);
  assert.equal(f.rows('cafe_stock_usage').filter(r => r.item_id === milk.id).length, 0);
});

check('Default recipes: missing alternatives use the preserved custom milk dose rather than the starting dose', f => {
  const coffee = f.good('Кофе'), milk = f.good('Молоко обычное'), oat = f.good('Молоко овсяное');
  const base = f.save('Капучино', 'base', [{id: coffee.id, amount: '0.024'}, {id: milk.id, amount: '0.200'}]);
  f.balance('Кофе', '1'); f.balance('Молоко обычное', '0'); f.balance('Молоко овсяное', '1');
  const inventory = f.rows('inventory_items');
  fillDefaultCafeRecipes(f.cafe, owner);
  assert.deepEqual(f.stock.recipe(f.dish('Капучино').id, 'base'), base);
  for (const row of inventory) assert.deepEqual(f.inventory.row(row.id).current_milli, row.current_milli);
  for (const [option, stockName] of [['Овсяное', 'Молоко овсяное'], ['Кокосовое', 'Молоко кокосовое'], ['Безлактозное', 'Молоко безлактозное']]) {
    const replacement = f.good(stockName);
    assert.deepEqual(f.stock.recipe(f.dish('Капучино').id, 'option:' + f.option(option).id).ingredients,
      [{id: replacement.id, unitId: replacement.unit_id, amount: 200, replacesId: milk.id}]);
  }
  f.cafe.create(f.order('Капучино', 2, ['Овсяное', 'Без сахара']), staff, 'test', now);
  assert.equal(f.inventory.row(oat.id).current_milli, 600);
  assert.equal(f.inventory.row(milk.id).current_milli, 0);
  assert.equal(f.inventory.row(coffee.id).current_milli, 952);
});

check('Default recipes: a preserved base without ordinary milk leaves all milk choices unconfigured for review', f => {
  const base = f.save('Капучино', 'base', [{id: f.good('Кофе').id, amount: '0.024'}]);
  const result = fillDefaultCafeRecipes(f.cafe, owner), itemId = f.dish('Капучино').id;
  assert.deepEqual(f.stock.recipe(itemId, 'base'), base);
  for (const name of ['Обычное', 'Овсяное', 'Кокосовое', 'Безлактозное']) {
    const component = 'option:' + f.option(name).id;
    assert.equal(f.stock.recipe(itemId, component), null);
    assert.ok(result.some(r => r.itemId === itemId && r.component === component && r.status === 'needs_review' && r.reason === 'existing_base_has_no_ordinary_milk'));
  }
  f.balance('Кофе', '1'); f.balance('Молоко овсяное', '1');
  assert.throws(() => f.cafe.create(f.order('Капучино', 1, ['Обычное']), staff, 'test', now), e => e.stockCode === 'UNCONFIGURED');
  assert.throws(() => f.cafe.create(f.order('Капучино', 1, ['Овсяное']), staff, 'test', now), e => e.stockCode === 'UNCONFIGURED');
  assert.equal(f.rows('cafe_orders').length, 0);
});
