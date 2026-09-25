// Isolated test databases only. Never invoked by the application or deployment migration.
export function fillTestCafeStock(cafe){
 const stock=cafe.stock.inventory.db.prepare('SELECT id,unit_id FROM inventory_items ORDER BY id LIMIT 1').get();
 cafe.db.prepare('UPDATE inventory_items SET current_milli=100000000 WHERE id=?').run(stock.id);
 const catalog=cafe.catalog();
 for(const i of catalog.items){for(const key of i.variants.length?i.variants.map(v=>'variant:'+v.id):['base'])cafe.db.prepare('INSERT OR REPLACE INTO cafe_recipes VALUES(?,?,?,0)').run(i.id,key,JSON.stringify([{id:stock.id,unitId:stock.unit_id,amount:1000}]));for(const g of catalog.groups.filter(g=>i.groupIds.includes(g.id)))for(const o of g.options)cafe.db.prepare('INSERT OR REPLACE INTO cafe_recipes VALUES(?,?,?,0)').run(i.id,'option:'+o.id,'[]');}
 return stock;
}
