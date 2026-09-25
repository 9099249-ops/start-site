import {normalizeInventoryName} from './inventory.mjs';

// Explicit ready-made products: one pizza sold consumes one pizza in stock.
// Never infer ingredient recipes, variants, or portion sizes from similar names.
const pizzas = ['Маргарита песто', '4 сыра', 'Супермясная', 'Дабл пепперони', 'Цыплёнок бешамель', 'Ветчина и грибы'];
const key = name => normalizeInventoryName(name).replace('пепперони', 'пеперони');

export function linkReadyMadePizzas(cafe, user) {
  const stock = cafe.stock;
  const config = stock.config(user); // Existing admin permission check.
  const catalog = cafe.catalog();
  const pizzaCategories = new Set(catalog.categories.filter(c => key(c.name) === 'пицца').map(c => c.id));
  const result = [];
  for (const name of pizzas) {
    const dishes = config.items.filter(i => i.active && pizzaCategories.has(i.categoryId) && key(i.name) === key(name));
    const goods = config.inventory.filter(i => i.active && key(i.category) === 'пицца' && key(i.name) === key(name));
    if (dishes.length !== 1 || goods.length !== 1) {
      result.push({name, status: 'needs_review'});
      continue;
    }
    const dish = dishes[0], item = goods[0];
    if (stock.recipe(dish.id, 'base')) {
      result.push({name, status: 'kept_existing'});
      continue;
    }
    if (dish.variants.length || dish.groupIds.length || key(item.unit) !== 'шт') {
      result.push({name, status: 'needs_review'});
      continue;
    }
    // Uses the existing recipe transaction and audit. Actual stock is untouched;
    // an unknown or zero balance still prevents ordering.
    stock.save({itemId: dish.id, component: 'base', revision: -1, ingredients: [{id: item.id, amount: '1'}]}, user);
    result.push({name, itemId: dish.id, stockItemId: item.id, status: 'linked'});
  }
  return result;
}
