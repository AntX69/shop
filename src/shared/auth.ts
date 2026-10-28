/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Secure salted PIN hashing for StorePOS offline desktop application.
 * Plaintext PINs are NEVER stored in the database or logs.
 */

import crypto from 'node:crypto';

/**
 * Validates PIN format: 4 to 6 digits.
 */
export function isValidPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin.trim());
}

/**
 * Generates a random cryptographic salt.
 */
export function generateSalt(length: number = 16): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hashes a PIN with a salt using SHA-256 with multiple rounds / HMAC.
 */
export function hashPin(pin: string, salt: string): string {
  const normalizedPin = pin.trim();
  return crypto.pbkdf2Sync(normalizedPin, salt, 10000, 32, 'sha256').toString('hex');
}

/**
 * Verifies if an entered PIN matches the stored hash and salt.
 */
export function verifyPin(enteredPin: string, storedHash: string, storedSalt: string): boolean {
  if (!enteredPin || !storedHash || !storedSalt) {
    return false;
  }
  const calculatedHash = hashPin(enteredPin, storedSalt);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(calculatedHash, 'hex'),
      Buffer.from(storedHash, 'hex')
    );
  } catch {
    return false;
  }
}
