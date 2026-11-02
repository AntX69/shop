import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isValidPin, generateSalt, hashPin, verifyPin, pinHashNeedsUpgrade, PIN_HASH_ITERATIONS } from './auth.ts';

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
  const [scheme, iterations, hex] = hash.split('$');
  assert.equal(scheme, 'pbkdf2-sha256');
  assert.equal(Number(iterations), PIN_HASH_ITERATIONS);
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(pinHashNeedsUpgrade(hash), false);

  assert.equal(verifyPin('4567', hash, salt), true);
  assert.equal(verifyPin('0000', hash, salt), false);
  assert.equal(verifyPin('4568', hash, salt), false);
  assert.equal(verifyPin('', hash, salt), false);
});

test('legacy 10k-iteration hashes still verify and are flagged for upgrade', () => {
  const salt = generateSalt();
  const legacy = crypto.pbkdf2Sync('2468', salt, 10000, 32, 'sha256').toString('hex');
  assert.equal(verifyPin('2468', legacy, salt), true);
  assert.equal(verifyPin('2469', legacy, salt), false);
  assert.equal(pinHashNeedsUpgrade(legacy), true);
});
