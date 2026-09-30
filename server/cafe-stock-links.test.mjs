import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AdminStore} from './admin.mjs';
import {CafeStore} from './cafe.mjs';
import {linkReadyMadePizzas} from './cafe-stock-links.mjs';
import {repairAccessStock} from '../deploy/repair-access-stock.mjs';

const owner = {id: 1, login: 'admin', role: 'admin'};
function fixture() {
  const admin = new AdminStore(':memory:');
  admin.db.exec("INSERT INTO admin_users VALUES(1,'admin','admin','unused'),(2,'matt','staff','unused'),(3,'station','staff','unused')");
  const cafe = new CafeStore(admin, null, {env: {}});
  const dish = cafe.catalog().items.find(i => i.name === '4 сыра');
  const item = cafe.stock.inventory.catalog(owner).items.find(i => i.name === dish.name);
  const amount = value => { const i = cafe.stock.inventory.row(item.id); cafe.stock.inventory.move({id: i.id, revision: i.revision, kind: 'SET', reason:'Проверочный пересчёт', amount: value, requestId: randomUUID()}, owner); };
  return {admin, cafe, dish, item, amount};
}
test('Ready-made pizza stock becomes available after restocking and unavailable at zero, never guesses unknown stock', () => {
  const f = fixture();
  try {
    assert.equal(f.cafe.publicMenu().items.find(i => i.id === f.dish.id).stock.configured, false);
    assert.equal(linkReadyMadePizzas(f.cafe, owner).filter(r => r.status === 'linked').length, 6);
    assert.equal(f.cafe.publicMenu().items.find(i => i.id === f.dish.id).stock.available, 0);
    f.amount('0'); const before = f.cafe.publicMenu().stockRevision;
    f.amount('3'); const menu = f.cafe.publicMenu();
    assert.notEqual(before, menu.stockRevision);
    assert.equal(menu.items.find(i => i.id === f.dish.id).stock.available, 3);
    const line = {itemId: f.dish.id, name: f.dish.name, quantity: 3};
    assert.equal(f.cafe.stock.check([line]).get(f.item.id).amount, 3000);
    assert.throws(() => f.cafe.stock.check([{...line, quantity: 4}]), e => e.available === 3);
    f.amount('0'); assert.equal(f.cafe.publicMenu().items.find(i => i.id === f.dish.id).stock.available, 0);
    const cafeItem = f.cafe.catalog().items.find(i => i.name === 'Капучино');
    assert.equal(f.cafe.stock.recipe(cafeItem.id, 'base'), null);
  } finally { f.admin.close(); }
});
test('Pizza linking preserves recipes, menu stop flags, stock and history; skips incompatible units and variants', () => {
  const f = fixture();
  try {
    assert.throws(() => linkReadyMadePizzas(f.cafe, {role: 'staff'}), e => e.status === 403);
    f.cafe.stock.save({itemId: f.dish.id, component: 'base', revision: -1, ingredients: [{id: f.item.id, amount: '2'}]}, owner);
    const cat = f.cafe.catalog(); cat.items.find(i => i.id === f.dish.id).soldOut = true; f.cafe.saveCatalog(cat, owner);
    const before = f.admin.db.prepare('SELECT * FROM inventory_items').all();
    linkReadyMadePizzas(f.cafe, owner); linkReadyMadePizzas(f.cafe, owner);
    assert.deepEqual(f.admin.db.prepare('SELECT * FROM inventory_items').all(), before);
    assert.equal(f.cafe.stock.recipe(f.dish.id, 'base').ingredients[0].amount, 2000);
    assert.equal(f.cafe.publicMenu().items.find(i => i.id === f.dish.id).soldOut, true);
    assert.equal(f.admin.db.prepare("SELECT count(*) n FROM cafe_audit WHERE action='recipe'").get().n, 6);
    f.admin.db.prepare('DELETE FROM cafe_recipes WHERE item_id=?').run(f.dish.id);
    const liter = f.cafe.stock.inventory.dictionary('inventory_units', 'л');
    f.admin.db.prepare('UPDATE inventory_items SET unit_id=? WHERE id=?').run(liter, f.item.id);
    assert.equal(linkReadyMadePizzas(f.cafe, owner).find(r => r.name === f.dish.name).status, 'needs_review');
  } finally { f.admin.close(); }
});
test('One-time repair grants matt full admin only, keeps passwords and orders, and is idempotent', () => {
  const f = fixture();
  try {
    const old = f.admin.db.prepare('SELECT id,password FROM admin_users').all();
    const result = repairAccessStock(f.admin, f.cafe, 'matt');
    assert.equal(result.account.role, 'admin');
    assert.equal(f.admin.workforce.people().find(p => p.login === 'station').role, 'staff');
    assert.deepEqual(f.admin.db.prepare('SELECT id,password FROM admin_users').all(), old);
    const changes = f.admin.db.prepare('SELECT total_changes() n').get().n;
    repairAccessStock(f.admin, f.cafe, 'matt');
    assert.equal(f.admin.db.prepare('SELECT total_changes() n').get().n, changes);
    assert.equal(f.admin.db.prepare('SELECT count(*) n FROM cafe_orders').get().n, 0);
  } finally { f.admin.close(); }
});

test('Access repair requires the exact explicitly supplied login and never guesses or creates accounts', () => {
  const f = fixture();
  try {
    f.admin.db.prepare("UPDATE admin_users SET login='matthew' WHERE login='matt'").run();
    assert.throws(() => repairAccessStock(f.admin, f.cafe), /Explicit target/);
    assert.throws(() => repairAccessStock(f.admin, f.cafe, 'matt'), /must already exist/);
    assert.equal(f.admin.workforce.people().find(p => p.login === 'matthew').role, 'staff');
    assert.equal(repairAccessStock(f.admin, f.cafe, 'matthew').account.login, 'matthew');
    assert.equal(f.admin.workforce.people().find(p => p.login === 'matthew').role, 'admin');
    assert.equal(f.admin.workforce.people().find(p => p.login === 'station').role, 'staff');
  } finally { f.admin.close(); }
});
