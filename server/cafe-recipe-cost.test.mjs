import test from 'node:test';
import assert from 'node:assert/strict';
import {combineRecipeIngredients, calculateRecipeCost} from './cafe-recipe-cost.mjs';

test('combines base and options by removing exact replacement targets without mutating snapshots', () => {
  const base = [{id: 1, unitId: 2, amount: 400}, {id: 2, unitId: 3, amount: 250}];
  const option = [{id: 3, unitId: 3, amount: 300, replacesId: 2}, {id: 4, unitId: 3, amount: 50}];
  const baseSnapshot = structuredClone(base), optionSnapshot = structuredClone(option);
  assert.deepEqual(combineRecipeIngredients(base, [option]), [base[0], ...option]);
  assert.deepEqual(base, baseSnapshot);
  assert.deepEqual(option, optionSnapshot);
  assert.equal(combineRecipeIngredients(base, [[{id: 3, unitId: 3, amount: 1, replacesId: 9}]]), null);
  assert.equal(combineRecipeIngredients(base, [
    [{id: 3, unitId: 3, amount: 1, replacesId: 2}],
    [{id: 4, unitId: 3, amount: 1, replacesId: 2}],
  ]), null);
  assert.equal(combineRecipeIngredients(base, [[{id: 1, unitId: 9, amount: 10}]]), null);
});

test('converts thousandths of a liter to exact portion cost', () => {
  const ingredients = [{id: 1, unitId: 4, amount: 1000}];
  const prices = new Map([[1, {unitId: 4, quantityMilli: 1_000_000, totalCents: 250_000}]]);
  assert.deepEqual(calculateRecipeCost(ingredients, prices), {
    portionCents: 250, estimated: false, missingPrices: [], missingNorms: [],
  });
});

test('replacement reduces the cost using only the surviving ingredient quantities', () => {
  const combined = combineRecipeIngredients(
    [{id: 1, unitId: 2, amount: 1000}],
    [[{id: 2, unitId: 2, amount: 500, replacesId: 1}]],
  );
  const prices = new Map([
    [1, {unitId: 2, quantityMilli: 1000, totalCents: 400}],
    [2, {unitId: 2, quantityMilli: 1000, totalCents: 120}],
  ]);
  assert.equal(calculateRecipeCost(combined, prices).portionCents, 60);
});

test('adds exact fractions and rounds once at half a cent', () => {
  const ingredients = [{id: 1, unitId: 1, amount: 1}, {id: 2, unitId: 1, amount: 1}];
  const prices = new Map([
    [1, {unitId: 1, quantityMilli: 2, totalCents: 1}],
    [2, {unitId: 1, quantityMilli: 2, totalCents: 1}],
  ]);
  assert.equal(calculateRecipeCost(ingredients, prices).portionCents, 1);
});

test('unknown and unit-mismatched prices make a portion incomplete, with unique missing ids', () => {
  const ingredients = [
    {id: 1, unitId: 1, amount: 2}, {id: 1, unitId: 1, amount: 3}, {id: 2, unitId: 1, amount: 1},
  ];
  const prices = new Map([[1, {unitId: 2, quantityMilli: 10, totalCents: 3}]]);
  assert.deepEqual(calculateRecipeCost(ingredients, prices, {missing: ['milk', 'milk']}), {
    portionCents: null, estimated: false, missingPrices: [1, 2], missingNorms: ['milk'],
  });
});

test('preserves an actual zero price and marks estimates only when used', () => {
  const ingredients = [{id: 1, unitId: 1, amount: 1}, {id: 2, unitId: 1, amount: 1}];
  const prices = new Map([
    [1, {unitId: 1, quantityMilli: 10, totalCents: 0}],
    [2, {unitId: 1, quantityMilli: 10, totalCents: 5, estimated: true}],
  ]);
  assert.deepEqual(calculateRecipeCost(ingredients.slice(0, 1), prices), {
    portionCents: 0, estimated: false, missingPrices: [], missingNorms: [],
  });
  assert.equal(calculateRecipeCost(ingredients, prices).estimated, true);
});

test('empty recipes are unknown unless explicitly allowed, and missing norms stay incomplete', () => {
  assert.equal(calculateRecipeCost([], new Map()).portionCents, null);
  assert.equal(calculateRecipeCost([], new Map(), {allowEmpty: true}).portionCents, 0);
  assert.equal(calculateRecipeCost([], new Map(), {allowEmpty: true, missing: ['unknown']} ).portionCents, null);
});

test('rejects unsafe identifiers, units, quantities, and costs', () => {
  const prices = new Map();
  for (const ingredient of [
    {id: 0, unitId: 1, amount: 1},
    {id: 1, unitId: Number.MAX_SAFE_INTEGER + 1, amount: 1},
    {id: 1, unitId: 1, amount: Number.MAX_SAFE_INTEGER + 1},
  ]) assert.throws(() => calculateRecipeCost([ingredient], prices), TypeError);
  assert.deepEqual(calculateRecipeCost([{id: 1, unitId: 1, amount: 1}], new Map([
    [1, {unitId: 1, quantityMilli: 1, totalCents: Number.MAX_SAFE_INTEGER + 1}],
  ])), {portionCents: null, estimated: false, missingPrices: [1], missingNorms: []});
  assert.throws(() => calculateRecipeCost([{id: 1, unitId: 1, amount: Number.MAX_SAFE_INTEGER}], new Map([
    [1, {unitId: 1, quantityMilli: 1, totalCents: Number.MAX_SAFE_INTEGER}],
  ])), {name: 'RangeError'});
});
