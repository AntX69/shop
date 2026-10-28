import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidPin, generateSalt, hashPin, verifyPin } from './auth.ts';

test('isValidPin requires 4 to 6 numeric digits', () => {
  assert.equal(isValidPin('1234'), true);
  assert.equal(isValidPin('999999'), true);
  assert.equal(isValidPin('12345'), true);
  assert.equal(isValidPin('123'), false); // Too short
  assert.equal(isValidPin('1234567'), false); // Too long
  assert.equal(isValidPin('abcd'), false); // Non-numeric
  assert.equal(isValidPin('12a4'), false);
});

test('hashPin and verifyPin securely hash and verify PIN with salt', () => {
  const pin = '4567';
  const salt = generateSalt();
  const hash = hashPin(pin, salt);

  assert.notEqual(hash, pin);
  assert.equal(hash.length, 64);

  assert.equal(verifyPin('4567', hash, salt), true);
  assert.equal(verifyPin('0000', hash, salt), false);
  assert.equal(verifyPin('4568', hash, salt), false);
  assert.equal(verifyPin('', hash, salt), false);
});
