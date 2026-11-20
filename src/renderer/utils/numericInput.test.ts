/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rules of the numeric fields, tested on the real functions the components call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  typingInteger, typingDecimal, finishInteger, finishMoney, finishWeight,
  moneyToTetri, weightToGrams, gramsToField, sameFieldValue,
} from './numericInput.ts';

test('whole numbers: a cleared field stays empty, it is not turned back into 0', () => {
  assert.equal(typingInteger(''), '');
  assert.equal(finishInteger('', 0), '');
  assert.equal(finishInteger('', 1), '', 'a required minimum is not filled in silently');
  assert.equal(finishInteger('   ', 1), '');
});

test('whole numbers: typing replaces the old value and leading zeros go away', () => {
  // Focus selects the old "0"; the first key replaces it, so the input reports just the new digit.
  assert.equal(typingInteger('7'), '7');
  assert.equal(typingInteger('07'), '7', 'a zero left in front of the new digit is dropped');
  assert.equal(typingInteger('0'), '0', 'a typed zero is a real zero');
  assert.equal(typingInteger('120'), '120');
});

test('whole numbers: Backspace edits naturally (every intermediate text is accepted)', () => {
  assert.equal(typingInteger('12'), '12');
  assert.equal(typingInteger('1'), '1');
  assert.equal(typingInteger(''), '');
});

test('whole numbers: letters, signs and decimals are rejected (previous text kept)', () => {
  for (const bad of ['a', '1a', '-1', '1.5', '1,5', ' 1', '+3', '1e3']) {
    assert.equal(typingInteger(bad), null, bad);
  }
});

test('whole numbers: limits', () => {
  assert.equal(typingInteger('15', 10), '10', 'above the maximum while typing -> the maximum');
  assert.equal(finishInteger('0', 1), 1, 'below the minimum when leaving -> the minimum (visible in the field)');
  assert.equal(finishInteger('0', 0), 0, 'zero allowed where the minimum is 0');
  assert.equal(finishInteger('25', 0, 20), 20);
  assert.equal(finishInteger('x', 0), '', 'invalid text is not a number');
});

test('decimals: comma and point are the same separator', () => {
  assert.equal(typingDecimal('12,5', 2), '12.5');
  assert.equal(typingDecimal('12.5', 2), '12.5');
  assert.equal(typingDecimal('0,375', 3), '0.375');
  assert.equal(moneyToTetri('12,50'), 1250);
  assert.equal(moneyToTetri('12.50'), 1250);
  assert.equal(weightToGrams('1,25'), 1250);
  assert.equal(weightToGrams('1.25'), 1250);
});

test('decimals: partial text while typing is accepted', () => {
  assert.equal(typingDecimal('1.', 2), '1.');
  assert.equal(typingDecimal('.', 2), '.');
  assert.equal(typingDecimal(',5', 3), '.5');
  assert.equal(typingDecimal('0.', 3), '0.');
  assert.equal(typingDecimal('00.5', 2), '0.5');
});

test('decimals: too many places, two separators and letters are rejected', () => {
  assert.equal(typingDecimal('12.345', 2), null, 'money has at most 2 decimals');
  assert.equal(typingDecimal('1.2345', 3), null, 'weight has at most 3 decimals (1 g)');
  assert.equal(typingDecimal('1.2.3', 3), null);
  assert.equal(typingDecimal('1,2,3', 3), null);
  assert.equal(typingDecimal('-1', 2), null);
  assert.equal(typingDecimal('1a', 2), null);
  assert.equal(moneyToTetri('12.345'), null);
  assert.equal(weightToGrams('0.0001'), null);
});

test('money: empty, zero and amounts are three different things', () => {
  assert.equal(moneyToTetri(''), null, 'empty = no amount');
  assert.equal(moneyToTetri('  '), null);
  assert.equal(moneyToTetri('.'), null);
  assert.equal(moneyToTetri('0'), 0, 'zero = a real zero');
  assert.equal(moneyToTetri('0.00'), 0);
  assert.equal(moneyToTetri('.5'), 50);
  assert.equal(moneyToTetri('12.'), 1200);
  assert.equal(moneyToTetri('19.99'), 1999, 'exact tetri, no floating point (19.99 * 100 = 1998.999…)');
  assert.equal(moneyToTetri('0.07'), 7);
});

test('money: leaving the field normalises the text, empty stays empty', () => {
  assert.equal(finishMoney('12.5'), '12.50');
  assert.equal(finishMoney('12,5'), '12.50');
  assert.equal(finishMoney('12'), '12.00');
  assert.equal(finishMoney('.5'), '0.50');
  assert.equal(finishMoney('0'), '0.00');
  assert.equal(finishMoney(''), '', 'a required amount is not filled with 0.00');
  assert.equal(finishMoney('.'), '');
});

test('weight: kg text to integer grams and back', () => {
  assert.equal(weightToGrams('0.375'), 375);
  assert.equal(weightToGrams('1'), 1000);
  assert.equal(weightToGrams('0.001'), 1);
  assert.equal(weightToGrams('2.5'), 2500);
  assert.equal(weightToGrams('0'), 0, 'zero kg is a real zero (e.g. stock count)');
  assert.equal(weightToGrams(''), null, 'empty is not zero');
  assert.equal(finishWeight('1.25'), '1.250');
  assert.equal(finishWeight('0,2'), '0.200');
  assert.equal(finishWeight('3.'), '3.000');
  assert.equal(finishWeight(''), '');
  assert.equal(gramsToField(375), '0.375');
  assert.equal(gramsToField(1000), '1');
  assert.equal(gramsToField(null), '');
});

test('form submission: an emptied required field is reported as missing, not as 0', () => {
  // The forms check the converted value; these are the values they receive.
  const repayment = moneyToTetri('');
  assert.equal(repayment, null);
  const counted = weightToGrams('');
  assert.equal(counted, null, 'stock count: an emptied weight must not set the stock to 0 kg');
  const restock = finishInteger('', 1);
  assert.equal(restock, '');
});

test('focused field: its own value coming back is not a change, a scan from elsewhere is', () => {
  // Typing "0.30" on the way to "0.305": the form shows 300 g back as "0.3"; the text must stay.
  assert.equal(sameFieldValue('0.3', '0.30', 'weight'), true);
  assert.equal(sameFieldValue('', '0', 'weight'), true, 'typing "0" before ".375" is kept');
  assert.equal(sameFieldValue('', '0.', 'weight'), true);
  assert.equal(sameFieldValue('12.5', '12.50', 'money'), true);
  assert.equal(sameFieldValue('7', '07', 'integer'), true);
  // A second scan raises the quantity while the box has focus: the new value must be shown.
  assert.equal(sameFieldValue('3', '2', 'integer'), false);
  assert.equal(sameFieldValue('1.1', '1', 'weight'), false, '+100 g button');
  assert.equal(sameFieldValue('54.69', '100', 'money'), false);
});
