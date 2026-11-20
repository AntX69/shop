import test from 'node:test';
import assert from 'node:assert/strict';
import { kgToGrams, gramsToKg, safeParseGrams, formatUnitQuantity } from './quantity.ts';

test('kgToGrams converts weights correctly with dot or comma', () => {
  assert.equal(kgToGrams('1.250'), 1250);
  assert.equal(kgToGrams('1,250'), 1250);
  assert.equal(kgToGrams('0.5'), 500);
  assert.equal(kgToGrams('0.075'), 75);
  assert.equal(kgToGrams('0.001'), 1);
  assert.equal(kgToGrams('2.750'), 2750);
  assert.equal(kgToGrams('5'), 5000);
  assert.equal(kgToGrams(1.25), 1250);
  assert.equal(kgToGrams(''), 0);
});

test('kgToGrams rejects negative or invalid formats', () => {
  assert.throws(() => kgToGrams('-1.5'));
  assert.throws(() => kgToGrams('abc'));
  assert.throws(() => kgToGrams('1.2345')); // more than 3 decimal places
});

test('gramsToKg formats grams to KG string', () => {
  assert.equal(gramsToKg(1250), '1.250');
  assert.equal(gramsToKg(500), '0.500');
  assert.equal(gramsToKg(1), '0.001');
  assert.equal(gramsToKg(0), '0.000');
  assert.equal(gramsToKg(1500, false), '1.5');
});

test('safeParseGrams returns null on invalid or empty', () => {
  assert.equal(safeParseGrams(''), null);
  assert.equal(safeParseGrams(null), null);
  assert.equal(safeParseGrams('invalid'), null);
  assert.equal(safeParseGrams('1.500'), 1500);
});

test('formatUnitQuantity handles piece and kg', () => {
  assert.equal(formatUnitQuantity(5, 'piece'), '5 ცალი');
  assert.equal(formatUnitQuantity(1250, 'kg'), '1.250 კგ');
  assert.equal(formatUnitQuantity(0, 'piece'), '0 ცალი');
  assert.equal(formatUnitQuantity(0, 'kg'), '0.000 კგ');
});
