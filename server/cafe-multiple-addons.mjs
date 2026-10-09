const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[-\s]+/g, ' ').trim();
const groupName = value => normalize(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const parseBody = recipe => {
  try {
    const body = typeof recipe.body === 'string' ? JSON.parse(recipe.body) : recipe.body;
    if (!Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new Error(`Invalid recipe body for ${recipe.item_id}/${recipe.component}`);
  }
};

export function buildMultipleAddonsPlan(catalog, recipes, inventory) {
  const nextCatalog = structuredClone(catalog);
  const nextRecipes = structuredClone(recipes);
  const stock = new Map(inventory.map(row => [row.id, row]));
  const recipeByKey = new Map();
  for (const recipe of nextRecipes) {
    const key = `${recipe.item_id}\0${recipe.component}`;
    if (recipeByKey.has(key)) throw new Error(`Duplicate recipe ${recipe.item_id}/${recipe.component}`);
    parseBody(recipe);
    recipeByKey.set(key, recipe);
  }
  const changes = { groups: [], items: [], recipes: [], warnings: [] };
  const upsert = (itemId, component, ingredients) => {
    const key = `${itemId}\0${component}`;
    const current = recipeByKey.get(key);
    if (current) {
      const body = parseBody(current);
      if (!same(body, ingredients)) throw new Error(`Incompatible existing recipe ${itemId}/${component}`);
      return;
    }
    const recipe = { item_id: itemId, component, body: JSON.stringify(ingredients), revision: -1 };
    nextRecipes.push(recipe);
    recipeByKey.set(key, recipe);
    changes.recipes.push(recipe);
  };
  const replaceExisting = (recipe, ingredients) => {
    if (same(parseBody(recipe), ingredients)) return;
    const replacement = { ...recipe, body: JSON.stringify(ingredients), revision: recipe.revision };
    const index = nextRecipes.indexOf(recipe);
    nextRecipes[index] = replacement;
    recipeByKey.set(`${recipe.item_id}\0${recipe.component}`, replacement);
    changes.recipes.push(replacement);
  };
  const groupById = new Map(nextCatalog.groups.map(group => [group.id, group]));

  for (const group of nextCatalog.groups) {
    const name = groupName(group.name);
    if (!group.active || !(['соусы', 'сироп', 'сиропы'].includes(name) || /^добавки(?: |$)/.test(name))) continue;
    const max = Math.min(20, group.options.length);
    if (group.max !== max) {
      group.max = max;
      changes.groups.push(group.id);
    }
  }

  for (const item of nextCatalog.items) {
    if (item.active === false) continue;
    const keyName = normalize(item.name);
    const tea = normalize(nextCatalog.categories.find(row => row.id === item.categoryId)?.name) === 'чай';
    const activeVariants = (item.variants || []).filter(variant => variant.active);
    if (tea && activeVariants.length) {
      const groupId = `multi-${item.id}`;
      const existingGroup = groupById.get(groupId);
      if (existingGroup) {
        if (item.legacyVariantOptions) continue;
        throw new Error(`Conflicting generated group ${groupId}`);
      }
      const variantRecipes = activeVariants.map(variant => {
        const recipe = recipeByKey.get(`${item.id}\0variant:${variant.id}`);
        if (!recipe) throw new Error(`Missing active variant recipe ${item.id}/variant:${variant.id}`);
        return { variant, recipe, ingredients: parseBody(recipe) };
      });
      const shared = variantRecipes[0].ingredients.filter(ingredient => variantRecipes.every(row => row.ingredients.some(other => same(other, ingredient))));
      const sharedIds = new Set(shared.map(ingredient => `${ingredient.id}\0${ingredient.unitId}\0${ingredient.amount}`));
      const baseKey = `${item.id}\0base`;
      const base = recipeByKey.get(baseKey);
      if (base && !same(parseBody(base), shared)) throw new Error(`Incompatible existing base recipe ${item.id}/base`);
      if (!base && !shared.length) throw new Error(`Cannot infer base recipe for tea item ${item.id}: no common ingredients`);
      if (!base && shared.length) upsert(item.id, 'base', shared);

      const options = activeVariants.map(variant => {
        const id = `multi-${item.id}-${variant.id}`;
        if (id.length > 64) throw new Error(`Generated option id exceeds 64 characters: ${id}`);
        const collision = nextCatalog.groups.some(group => group.options?.some(option => option.id === id));
        if (collision) throw new Error(`Generated option id collision: ${id}`);
        return { id, name: variant.name, priceCents: variant.priceCents, active: variant.active, soldOut: variant.soldOut ?? false };
      });
      const group = { id: groupId, name: 'Состав чая', active: true, min: 1, max: Math.min(20, options.length), options };
      nextCatalog.groups.push(group);
      groupById.set(groupId, group);
      item.groupIds = [...(item.groupIds || []), groupId];
      item.legacyVariantOptions = Object.fromEntries(activeVariants.map((variant, index) => [variant.id, options[index].id]));
      for (const [index, row] of variantRecipes.entries()) {
        const option = options[index];
        upsert(item.id, `option:${option.id}`, row.ingredients.filter(ingredient => !sharedIds.has(`${ingredient.id}\0${ingredient.unitId}\0${ingredient.amount}`)));
        row.variant.active = false;
      }
      changes.groups.push(groupId);
      changes.items.push(item.id);
    }

    if (!/хот дог/.test(keyName)) continue;
    const groupId = `multi-${item.id}`;
    if (groupById.has(groupId)) continue;
    const base = recipeByKey.get(`${item.id}\0base`);
    if (!base) continue;
    const ingredients = parseBody(base);
    const sauceIngredients = ingredients.filter(ingredient => /кетчуп|горчиц|сырный соус|майонез|сметан|соус/.test(normalize(stock.get(ingredient.id)?.name)));
    if (!sauceIngredients.length) {
      changes.warnings.push({ itemId: item.id, message: 'Для хот-дога не найдены известные соусы.' });
      continue;
    }
    replaceExisting(base, ingredients.filter(ingredient => !sauceIngredients.includes(ingredient)));
    const options = sauceIngredients.map(ingredient => {
      const row = stock.get(ingredient.id);
      const name = String(row.name).replace(/(?:,\s*|\s+)(?:\d+(?:[.,]\d+)?\s+)?(?:мл|л|г|кг|шт\.?|уп\.?|порц\.?)\s*$/iu, '').trim();
      return { id: `${groupId}-${ingredient.id}`, name, priceCents: 0, active: true, soldOut: false };
    });
    const group = { id: groupId, name: 'Соусы', active: true, min: 0, max: Math.min(20, options.length), promptSelection: true, options };
    nextCatalog.groups.push(group);
    groupById.set(groupId, group);
    item.groupIds = [...new Set([...(item.groupIds || []), groupId])];
    for (let i = 0; i < sauceIngredients.length; i++) upsert(item.id, `option:${options[i].id}`, [sauceIngredients[i]]);
    changes.groups.push(groupId);
    changes.items.push(item.id);
  }
  return { catalog: nextCatalog, recipes: nextRecipes, changes };
}
