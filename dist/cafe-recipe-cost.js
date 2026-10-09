(function(root){'use strict';
const MAX_SAFE=Number.MAX_SAFE_INTEGER;
function positiveSafeInteger(value){return Number.isSafeInteger(value)&&value>0;}
function gcd(a,b){while(b)[a,b]=[b,a%b];return a;}
function addFraction(left,right){
 const divisor=gcd(left.denominator,right.denominator);
 const numerator=left.numerator*(right.denominator/divisor)+right.numerator*(left.denominator/divisor);
 const denominator=left.denominator*(right.denominator/divisor),reduction=gcd(numerator,denominator);
 return {numerator:numerator/reduction,denominator:denominator/reduction};
}
function validateIngredient(ingredient){
 if(!ingredient||typeof ingredient!=='object'||Array.isArray(ingredient)||!positiveSafeInteger(ingredient.id)||!positiveSafeInteger(ingredient.unitId)||!positiveSafeInteger(ingredient.amount)){
  throw new TypeError('Ingredient id, unitId, and amount must be positive safe integers.');
 }
}
function combineRecipeIngredients(base,optionIngredientArrays){
 if(!Array.isArray(base)||!Array.isArray(optionIngredientArrays)||optionIngredientArrays.some(option=>!Array.isArray(option)))return null;
 const options=optionIngredientArrays.flat(),all=[...base,...options],units=new Map(),baseIds=new Set();
 for(const ingredient of all){
  if(!ingredient||typeof ingredient!=='object'||Array.isArray(ingredient)||!positiveSafeInteger(ingredient.id)||!positiveSafeInteger(ingredient.unitId))return null;
  if(units.has(ingredient.id)&&units.get(ingredient.id)!==ingredient.unitId)return null;
  units.set(ingredient.id,ingredient.unitId);
 }
 for(const ingredient of base)baseIds.add(ingredient.id);
 const replacements=new Set();
 for(const option of optionIngredientArrays)for(const ingredient of option){
  if(!Object.hasOwn(ingredient,'replacesId'))continue;
  const target=ingredient.replacesId;
  if(!positiveSafeInteger(target)||!baseIds.has(target)||replacements.has(target))return null;
  replacements.add(target);
 }
 return [...base.filter(ingredient=>!replacements.has(ingredient.id)),...options];
}
function calculateRecipeCost(ingredients,prices,{allowEmpty=false,missing=[]}={}){
 if(!Array.isArray(ingredients))throw new TypeError('Ingredients must be an array.');
 if(!(prices instanceof Map))throw new TypeError('Prices must be a Map.');
 if(!Array.isArray(missing)||missing.some(value=>typeof value!=='string'))throw new TypeError('Missing norm names must be strings.');
 for(const ingredient of ingredients)validateIngredient(ingredient);
 const missingPrices=[],missingPriceIds=new Set(),missingNorms=[...new Set(missing)];
 let total={numerator:0n,denominator:1n},estimated=false;
 for(const ingredient of ingredients){
  const price=prices.get(ingredient.id);
  if(!price||!positiveSafeInteger(price.unitId)||!positiveSafeInteger(price.quantityMilli)||!Number.isSafeInteger(price.totalCents)||price.totalCents<0||price.unitId!==ingredient.unitId){
   if(!missingPriceIds.has(ingredient.id)){missingPriceIds.add(ingredient.id);missingPrices.push(ingredient.id);}
   continue;
  }
  if(price.estimated===true)estimated=true;
  total=addFraction(total,{numerator:BigInt(price.totalCents)*BigInt(ingredient.amount),denominator:BigInt(price.quantityMilli)});
 }
 if(missingPrices.length||missingNorms.length||(ingredients.length===0&&!allowEmpty))return {portionCents:null,estimated,missingPrices,missingNorms};
 const rounded=(total.numerator*2n+total.denominator)/(2n*total.denominator);
 if(rounded>BigInt(MAX_SAFE))throw new RangeError('Recipe cost exceeds the maximum safe integer.');
 return {portionCents:Number(rounded),estimated,missingPrices,missingNorms};
}
const api={combineRecipeIngredients,calculateRecipeCost};
if(typeof module==='object'&&module.exports)module.exports=api;else root.STARTCafeRecipeCost=api;
})(globalThis);
