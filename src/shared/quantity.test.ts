import test from 'node:test';
import assert from 'node:assert/strict';
import { kgToGrams, gramsToKg, safeParseGrams, formatUnitQuantity, lineTotalTetri } from './quantity.ts';

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

test('lineTotalTetri: kg price rounds to the nearest tetri, halves up (documented rule)', () => {
  assert.equal(lineTotalTetri(1250, 375, 'kg'), 469, '12.50 ₾/kg × 0.375 kg = 4.6875 ₾ -> 4.69 ₾');
  assert.equal(lineTotalTetri(100, 5, 'kg'), 1, '1.00 ₾/kg × 0.005 kg = 0.5 tetri -> 1 tetri (half up)');
  assert.equal(lineTotalTetri(100, 4, 'kg'), 0, '0.4 tetri -> 0');
  assert.equal(lineTotalTetri(899, 1000, 'kg'), 899, 'exactly 1 kg = the kg price');
  assert.equal(lineTotalTetri(1999, 2500, 'kg'), 4998, '19.99 × 2.5 = 49.975 -> 49.98');
  assert.equal(lineTotalTetri(10_000_000_000, 10_000_000, 'kg'), 100_000_000_000_000, 'large values without precision loss');
});

test('lineTotalTetri: pieces are price × quantity', () => {
  assert.equal(lineTotalTetri(2550, 3), 7650);
  assert.equal(lineTotalTetri(2550, 3, 'piece'), 7650);
  assert.equal(lineTotalTetri(2550, 0, 'piece'), 0);
});

test('lineTotalTetri: rejects fractional or negative input', () => {
  assert.throws(() => lineTotalTetri(12.5, 1, 'piece'));
  assert.throws(() => lineTotalTetri(1250, 0.5, 'kg'));
  assert.throws(() => lineTotalTetri(-1, 1, 'piece'));
});
