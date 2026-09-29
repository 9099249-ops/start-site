import {quantityText} from './inventory.mjs';

// Opt-in preparation only. The caller must supply an explicitly approved plan;
// this module supplies no portion sizes and is never run by startup/migrations.
const drinks = new Map([
  ['Двойной эспрессо', false],
  ['Американо', false],
  ['Капучино', true],
  ['Латте', true],
  ['Флэт уайт', true],
]);
const fields = new Set(['name', 'coffeeGrams', 'milkMl']);
const fail = message => { throw Object.assign(new Error(message), {status: 400}); };
const dose = value => Number.isSafeInteger(value) && value > 0 && value <= 999999999;

function validatePlan(plan) {
  if (!Array.isArray(plan) || !plan.length || plan.length > drinks.size) fail('Передайте явный непустой план кофейных рецептур.');
  const seen = new Set();
  for (const row of plan) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !fields.has(key))) fail('План содержит неизвестные поля.');
    if (typeof row.name !== 'string' || !row.name || row.name !== row.name.trim() || row.name.length > 120 || seen.has(row.name)) fail('Укажите точные неповторяющиеся названия напитков.');
    if (!dose(row.coffeeGrams) || (Object.hasOwn(row, 'milkMl') && !dose(row.milkMl))) fail('Нормы кофе в граммах и молока в миллилитрах должны быть положительными целыми числами.');
    if (drinks.has(row.name) && drinks.get(row.name) !== Object.hasOwn(row, 'milkMl')) fail('План молочного напитка должен содержать milkMl; для чёрного кофе поле milkMl не задаётся.');
    seen.add(row.name);
  }
}

function ingredient(item, amount, largeUnits, smallUnits) {
  if (!item || ![...largeUnits, ...smallUnits].includes(item.unit)) return null;
  // Inventory recipes store thousandths of the declared stock unit.
  const milli = largeUnits.includes(item.unit) ? amount : amount * 1000;
  return {id: item.id, amount: quantityText(milli)};
}

export function linkCoffeeStock(cafe, user, plan) {
  const stock = cafe.stock, config = stock.config(user); // Existing admin check.
  validatePlan(plan); // Validate the entire plan before the first recipe write.
  const exactStock = name => {
    const matches = config.inventory.filter(item => item.active && item.name === name);
    return matches.length === 1 ? matches[0] : null;
  };
  const coffee = exactStock('Кофе'), milk = exactStock('Молоко обычное');
  const result = [];
  for (const row of plan) {
    const matches = config.items.filter(item => item.active && item.name === row.name);
    if (!drinks.has(row.name) || matches.length !== 1 || matches[0].variants.length) {
      result.push({name: row.name, status: 'needs_review', reason: 'dish_or_variant'});
      continue;
    }
    const dish = matches[0], existing = stock.recipe(dish.id, 'base');
    const coffeeIngredient = ingredient(coffee, row.coffeeGrams, ['кг', 'kg'], ['г', 'g']);
    const milkIngredient = row.milkMl === undefined ? null : ingredient(milk, row.milkMl, ['л', 'l'], ['мл', 'ml']);
    if (!existing && (!coffeeIngredient || (row.milkMl !== undefined && !milkIngredient))) {
      result.push({name: row.name, itemId: dish.id, status: 'needs_review', reason: 'stock_or_unit'});
      continue;
    }
    const base = existing || stock.save({itemId: dish.id, component: 'base', revision: -1, ingredients: [coffeeIngredient, milkIngredient].filter(Boolean)}, user);
    const contains = item => item && base.ingredients.some(entry => entry.id === item.id && entry.unitId === item.unit_id && entry.amount > 0);
    const linkedModifiers = [];
    // Missing sugar/alternative milk recipes remain missing. A zero recipe is
    // valid only for no sugar or milk already included in the actual base.
    for (const group of config.groups.filter(group => group.active && dish.groupIds.includes(group.id))) {
      for (const option of group.options.filter(option => option.active)) {
        const allowed = contains(coffee) && (option.name === 'Без сахара' || (option.name === 'Обычное' && contains(milk)));
        const component = 'option:' + option.id;
        if (!allowed || stock.recipe(dish.id, component)) continue;
        stock.save({itemId: dish.id, component, revision: -1, ingredients: []}, user);
        linkedModifiers.push(option.id);
      }
    }
    result.push({name: row.name, itemId: dish.id, status: existing ? 'kept_existing' : 'linked', linkedModifiers});
  }
  return result;
}
