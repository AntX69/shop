import test from 'node:test';
import assert from 'node:assert/strict';
import { gelToTetri, formatTetri, safeParseTetri } from './money.ts';

test('gelToTetri converts floating strings and numbers to exact integer tetri', () => {
  assert.equal(gelToTetri('25.50'), 2550);
  assert.equal(gelToTetri('25.5'), 2550);
  assert.equal(gelToTetri('25'), 2500);
  assert.equal(gelToTetri('0.05'), 5);
  assert.equal(gelToTetri('0.5'), 50);
  assert.equal(gelToTetri('0'), 0);
  assert.equal(gelToTetri(19.99), 1999);
  assert.equal(gelToTetri('150'), 15000);
  assert.equal(gelToTetri('200'), 20000);
});

test('gelToTetri rejects invalid currency input', () => {
  assert.throws(() => gelToTetri('abc'), /არასწორი თანხის ფორმატი/);
  assert.throws(() => gelToTetri('12.345'), /არასწორი თანხის ფორმატი/);
});

test('formatTetri formats integer tetri to Georgian Lari string', () => {
  assert.equal(formatTetri(2550), '25.50 ₾');
  assert.equal(formatTetri(2500), '25.00 ₾');
  assert.equal(formatTetri(5), '0.05 ₾');
  assert.equal(formatTetri(0), '0.00 ₾');
  assert.equal(formatTetri(-500), '-5.00 ₾');
  assert.equal(formatTetri(15000, false), '150.00');
});

test('cash calculation: 150 GEL sale, 200 GEL received -> 50 GEL change', () => {
  const saleTetri = gelToTetri('150.00'); // 15000
  const receivedTetri = gelToTetri('200.00'); // 20000
  const changeTetri = receivedTetri - saleTetri;
  assert.equal(changeTetri, 5000);
  assert.equal(formatTetri(changeTetri), '50.00 ₾');
});

test('safeParseTetri handles empty and invalid inputs gracefully', () => {
  assert.equal(safeParseTetri(''), null);
  assert.equal(safeParseTetri(null), null);
  assert.equal(safeParseTetri('not-a-number'), null);
  assert.equal(safeParseTetri('12.30'), 1230);
});
