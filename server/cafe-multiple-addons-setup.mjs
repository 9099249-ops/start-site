import {CafeStore,validateCatalog} from './cafe.mjs';
import {CafeStock} from './cafe-stock.mjs';
import {InventoryStore} from './inventory.mjs';
import {OperationsCosts} from './operations-analytics-costs.mjs';
import {buildMultipleAddonsPlan} from './cafe-multiple-addons.mjs';

// Explicit release operation, never run during server startup or a customer request.
export function applyMultipleAddonsSetup(db,expected,user,release,now=Date.now()){
 const cafe=Object.assign(Object.create(CafeStore.prototype),{db,admin:{db}});
 const inventory=Object.assign(Object.create(InventoryStore.prototype),{db});
 cafe.stock=Object.assign(Object.create(CafeStock.prototype),{db,cafe,inventory});
 return cafe.transaction(()=>{
  const previous=db.prepare("SELECT body FROM cafe_audit WHERE action='multiple_addons_setup' AND json_extract(body,'$.release')=? ORDER BY id DESC LIMIT 1").get(release);
  if(previous)return {duplicate:true,revision:JSON.parse(previous.body).previousRevision+1};
  const current=cafe.catalog();
  if(current.revision!==expected.revision)throw Error('Cafe catalog changed after release preparation');
  const recipes=db.prepare('SELECT * FROM cafe_recipes').all();
  const goods=db.prepare('SELECT id,name,unit_id unitId FROM inventory_items').all();
  const plan=buildMultipleAddonsPlan(current,recipes,goods);
  if(plan.changes.warnings.length)throw Error(JSON.stringify(plan.changes.warnings));
  const affected=new Set(plan.changes.recipes.map(r=>r.item_id));
  for(const itemId of affected){
   const before=expected.recipes.filter(r=>r.item_id===itemId).sort((a,b)=>a.component.localeCompare(b.component));
   const actual=recipes.filter(r=>r.item_id===itemId).sort((a,b)=>a.component.localeCompare(b.component));
   if(JSON.stringify(before)!==JSON.stringify(actual))throw Error('Recipe changed after preparation: '+itemId);
  }
  const validated=validateCatalog(plan.catalog,current);
  const changed=plan.changes.groups.length||plan.changes.items.length||plan.changes.recipes.length;
  if(!changed)return {duplicate:true,revision:current.revision};
  for(const row of plan.changes.recipes){
   const before=recipes.find(r=>r.item_id===row.item_id&&r.component===row.component);
   if(before)db.prepare('UPDATE cafe_recipes SET body=?,revision=revision+1 WHERE item_id=? AND component=? AND revision=?').run(row.body,row.item_id,row.component,before.revision);
   else db.prepare('INSERT INTO cafe_recipes VALUES(?,?,?,0)').run(row.item_id,row.component,row.body);
  }
  db.prepare('UPDATE cafe_catalog SET body=?,revision=revision+1 WHERE id=1').run(JSON.stringify(validated));
  cafe.audit(user,'multiple_addons_setup',{release,previousRevision:current.revision,groups:plan.changes.groups,items:plan.changes.items,recipes:plan.changes.recipes.map(after=>({before:recipes.find(r=>r.item_id===after.item_id&&r.component===after.component)||null,after}))});
  // Version only affected future recipe costs; historical orders retain their versions.
  const costCafe=Object.create(cafe);costCafe.catalog=()=>({...cafe.catalog(),items:cafe.catalog().items.filter(i=>affected.has(i.id))});
  const costs=Object.assign(Object.create(OperationsCosts.prototype),{db,admin:cafe.admin,cafe:costCafe});
  costs.syncRecipeCosts(user,now,release);
  return {revision:current.revision+1,groups:plan.changes.groups,items:plan.changes.items,recipeChanges:plan.changes.recipes.length};
 });
}
