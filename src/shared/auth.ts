/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Secure salted PIN hashing for StorePOS offline desktop application.
 * Plaintext PINs are NEVER stored in the database or logs.
 *
 * Stored format: "pbkdf2-sha256$<iterations>$<hex>". Hashes written by earlier versions are
 * plain hex with 10 000 iterations; they still verify and are upgraded on the next login.
 * A 4–6 digit PIN cannot resist an offline attack on a copied database whatever the hash;
 * the real protection is the login lockout in AuthService plus Windows account security.
 */

import crypto from 'node:crypto';

export const PIN_HASH_ITERATIONS = 120_000;
const LEGACY_ITERATIONS = 10_000;
const PREFIX = 'pbkdf2-sha256';

/**
 * Validates PIN format: 4 to 6 digits.
 */
export function isValidPin(pin: string): boolean {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin.trim());
}

/**
 * Generates a random cryptographic salt.
 */
export function generateSalt(length: number = 16): string {
  return crypto.randomBytes(length).toString('hex');
}

function derive(pin: string, salt: string, iterations: number): string {
  return crypto.pbkdf2Sync(pin.trim(), salt, iterations, 32, 'sha256').toString('hex');
}

/**
 * Hashes a PIN with a salt using PBKDF2-HMAC-SHA256.
 */
export function hashPin(pin: string, salt: string, iterations: number = PIN_HASH_ITERATIONS): string {
  return `${PREFIX}$${iterations}$${derive(pin, salt, iterations)}`;
}

function parseStoredHash(storedHash: string): { iterations: number; hex: string } {
  const parts = storedHash.split('$');
  if (parts.length === 3 && parts[0] === PREFIX) {
    const iterations = Number(parts[1]);
    if (Number.isInteger(iterations) && iterations > 0) return { iterations, hex: parts[2] };
  }
  return { iterations: LEGACY_ITERATIONS, hex: storedHash };
}

/** True when the stored hash was made with fewer iterations than the current policy. */
export function pinHashNeedsUpgrade(storedHash: string): boolean {
  return parseStoredHash(storedHash).iterations < PIN_HASH_ITERATIONS;
}

/**
 * Verifies if an entered PIN matches the stored hash and salt (constant-time comparison).
 */
export function verifyPin(enteredPin: string, storedHash: string, storedSalt: string): boolean {
  if (!enteredPin || !storedHash || !storedSalt) {
    return false;
  }
  const { iterations, hex } = parseStoredHash(storedHash);
  const calculated = derive(enteredPin, storedSalt, iterations);
  try {
    const a = Buffer.from(calculated, 'hex');
    const b = Buffer.from(hex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
