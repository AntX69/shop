import test from 'node:test';
import assert from 'node:assert/strict';

test('Numeric input formatting logic: integer formatting', () => {
  // Clearing empty string
  const rawEmpty = '';
  assert.equal(rawEmpty === '' ? '' : parseInt(rawEmpty, 10), '');

  // Numbers with leading zeros cleaned
  const raw1 = '05';
  assert.equal(parseInt(raw1, 10), 5);

  // Max bound
  const max = 10;
  const num = 15;
  assert.equal(Math.min(max, num), 10);
});

test('Numeric input formatting logic: money formatting with dot or comma', () => {
  const parseMoney = (raw: string) => {
    const clean = raw.replace(',', '.');
    if (!/^\d*\.?\d{0,2}$/.test(clean)) return null;
    return clean;
  };

  assert.equal(parseMoney('12,50'), '12.50');
  assert.equal(parseMoney('12.5'), '12.5');
  assert.equal(parseMoney('0.50'), '0.50');
  assert.equal(parseMoney(''), '');
  assert.equal(parseMoney('12.345'), null); // max 2 decimals
});

test('Numeric input formatting logic: weight formatting with 3 decimals', () => {
  const parseWeight = (raw: string) => {
    const clean = raw.replace(',', '.');
    if (!/^\d*\.?\d{0,3}$/.test(clean)) return null;
    return clean;
  };

  assert.equal(parseWeight('1,250'), '1.250');
  assert.equal(parseWeight('0.075'), '0.075');
  assert.equal(parseWeight('0.5'), '0.5');
  assert.equal(parseWeight(''), '');
  assert.equal(parseWeight('1.2345'), null); // max 3 decimals
});
