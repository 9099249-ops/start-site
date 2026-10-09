import {normalizeInventoryName} from './inventory.mjs';

// Only explicit finished products with one sale consuming one discrete stock unit.
// Ingredient quantities, serving sizes and unlisted variants are never inferred.
const soups=[
  'Том Ям с креветками и грибами',
  'Гороховый суп с копчёностями',
  'Лапша с курицей',
  'Уха янтарная',
  'Лапша с фрикадельками',
  'Солянка по-домашнему',
  'Суп с грибами и сыром',
  'Лагман с говядиной',
];
const drinkUnits=['шт','бутылки','банки'];
const drink=(menu,inventory,variants)=>({menu:Array.isArray(menu)?menu:[menu],inventory:[inventory],menuCategory:'Холодные напитки',inventoryCategory:'Холодные напитки и пиво',units:drinkUnits,...(variants?{variants}:{})});
const mappings=[
  ...soups.map(name=>({menu:[name],inventory:[name],menuCategory:'Супы',inventoryCategory:'Супы',units:['шт']})),
  {menu:['Борщ оригинальный с говядиной'],inventory:['Борщ с говядиной'],menuCategory:'Супы',inventoryCategory:'Супы',units:['шт']},
  drink(['Фанта','Fanta'],'Fanta'),
  drink(['Кока-Кола','Coca-Cola'],'Coca-Cola'),
  {...drink('Безалкогольное пиво','Пиво безалкогольное'),menuCategory:'Безалкогольное пиво'},
  drink('Квас в банке','Квас баночный'),
  drink('Сок RICH','Сок Rich'),
  drink('Вода JEVEA','Вода с газом',['С газом']),
  drink('Вода JEVEA','Вода без газа',['Без газа']),
  drink(['Липтон','Lipton'],'Lipton чёрный',['Чёрный']),
  drink(['Липтон','Lipton'],'Lipton зелёный',['Зелёный']),
  drink(['Липтон','Lipton'],'Lipton лимон',['С лимоном','Лимон']),
];
const key=normalizeInventoryName;
const named=(name,aliases)=>aliases.some(alias=>key(name)===key(alias));

export function linkReadyMadeProducts(cafe,user){
  if(user?.role!=='admin')throw Object.assign(new Error('Автозаполнение доступно только администратору.'),{status:403});
  const stock=cafe.stock,config=stock.config(user),catalog=cafe.catalog();
  return mappings.map(mapping=>{
    const result={name:mapping.menu[0],...(mapping.variants?{variant:mapping.variants[0]}:{})};
    const skip=(reason,details={})=>({...result,...details,status:'needs_review',reason});
    const categories=catalog.categories.filter(c=>key(c.name)===key(mapping.menuCategory));
    const dishes=config.items.filter(i=>named(i.name,mapping.menu)&&categories.some(c=>c.id===i.categoryId));
    if(dishes.length!==1)return skip(dishes.length?'ambiguous_menu_item':'menu_item_missing');
    const dish=dishes[0];result.itemId=dish.id;
    let component='base';
    if(mapping.variants){
      const variants=dish.variants.filter(v=>named(v.name,mapping.variants));
      if(variants.length!==1)return skip(variants.length?'ambiguous_variant':'variant_missing');
      component='variant:'+variants[0].id;
      if(!variants[0].active)return skip('variant_inactive',{component});
    }else if(dish.variants.length)return skip('unexpected_variants');
    result.component=component;
    if(stock.recipe(dish.id,component))return {...result,status:'kept_existing',reason:'recipe_already_configured'};
    if(!dish.active||!categories.find(c=>c.id===dish.categoryId)?.active)return skip('menu_item_inactive');
    if(dish.restricted||dish.station==='hookah')return skip('restricted_menu_item');
    if(dish.groupIds.length)return skip('modifiers_require_review');
    const goods=config.inventory.filter(i=>key(i.category)===key(mapping.inventoryCategory)&&named(i.name,mapping.inventory));
    if(goods.length!==1)return skip(goods.length?'ambiguous_stock_item':'stock_item_missing');
    const item=goods[0];result.stockItemId=item.id;
    if(!item.active)return skip('stock_item_inactive');
    if(!mapping.units.includes(key(item.unit)))return skip('incompatible_stock_unit',{unit:item.unit,expectedUnits:mapping.units});
    // Existing save handles admin access, recipe revisions, validation and audit.
    // This does not alter current inventory, menu visibility or stop-list flags.
    stock.save({itemId:dish.id,component,revision:-1,ingredients:[{id:item.id,amount:'1'}]},user);
    return {...result,status:'linked',reason:'one_finished_unit_per_sale'};
  });
}
