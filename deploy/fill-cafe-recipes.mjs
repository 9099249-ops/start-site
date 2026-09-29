import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {AdminStore} from '../server/admin.mjs';
import {CafeStore} from '../server/cafe.mjs';
import {fillDefaultCafeRecipes} from '../server/cafe-default-recipes.mjs';

// Run on a backup copy first. Production application is performed during a brief
// maintenance pause with a consistent SQLite backup, by the deployment wrapper.
const file=process.argv[2];
if(!file||process.argv[3]!=='--apply')throw new Error('Usage: node deploy/fill-cafe-recipes.mjs <database> --apply');
const admin=new AdminStore(file);admin.env={};admin.workforce.env={};
try {
 const cafe=new CafeStore(admin,null,{env:{}}),db=admin.db;
 const owner=db.prepare("SELECT id,login,role FROM admin_users WHERE login='admin' AND role='admin'").get();
 assert.ok(owner,'Existing administrator required');
 const sensitive=['admin_users','admin_sessions','clients','rentals','payments','shifts','employee_work_sessions','cafe_orders','cafe_order_events','cafe_notifications','cafe_stock_usage'];
 const digest=table=>createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM "'+table+'" ORDER BY rowid').all())).digest('hex');
 const before=Object.fromEntries(sensitive.filter(t=>db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(t)).map(t=>[t,digest(t)]));
 const inventory=db.prepare('SELECT * FROM inventory_items ORDER BY id').all(),recipes=db.prepare('SELECT * FROM cafe_recipes').all();
 const results=fillDefaultCafeRecipes(cafe,owner);
 for(const [table,hash] of Object.entries(before))assert.equal(digest(table),hash,'Unexpected change: '+table);
 for(const item of inventory)assert.deepEqual(db.prepare('SELECT * FROM inventory_items WHERE id=?').get(item.id),item,'Inventory changed: '+item.id);
 for(const recipe of recipes)assert.deepEqual(db.prepare('SELECT * FROM cafe_recipes WHERE item_id=? AND component=?').get(recipe.item_id,recipe.component),recipe,'Existing recipe changed');
 const missing=cafe.catalog().items.filter(i=>i.active&&!i.restricted).flatMap(i=>(i.variants.length?i.variants.filter(v=>v.active).map(v=>'variant:'+v.id):['base']).filter(c=>!cafe.stock.recipe(i.id,c)).map(c=>({name:i.name,component:c})));
 assert.deepEqual(missing,[],'Some active menu items still have no recipe');
 assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 const menu=cafe.publicMenu();
 console.log(JSON.stringify({results,recipeCount:db.prepare('SELECT count(*) n FROM cafe_recipes').get().n,existingInventoryPreserved:inventory.length,businessTablesPreserved:Object.keys(before),menu:menu.items.map(i=>({name:i.name,available:i.stock.available,configured:i.stock.configured,soldOut:i.soldOut})),missing},null,2));
} finally {admin.close();}
