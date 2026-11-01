/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Authentication and User Management Service.
 * Runs in main process / backend.
 * Enforces Role-Based Access Control (RBAC): Owner vs Seller.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { User, UserRole, UserSession } from '../../shared/types.ts';
import { generateSalt, hashPin, isValidPin, verifyPin } from '../../shared/auth.ts';
import { BackupService } from './backupService.ts';
import crypto from 'node:crypto';

// In-memory active sessions map: token -> User
const activeSessions = new Map<string, User>();

export function getActiveSession(token: string): User | null {
  if (!token) return null;
  return activeSessions.get(token) || null;
}

export function createSession(user: User): UserSession {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, user);
  return { user, token };
}

export function revokeSession(token: string): void {
  activeSessions.delete(token);
}

export class AuthService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  /**
   * Checks if an owner account exists (for first run setup).
   */
  hasOwner(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'owner'").get() as { count: number };
    return row.count > 0;
  }

  /**
   * Returns list of all active users (without hashes/salts) for user selection screen.
   */
  getActiveUsers(): User[] {
    return this.db.prepare(
      "SELECT id, name, role, is_active, created_at FROM users WHERE is_active = 1 ORDER BY role DESC, id ASC"
    ).all() as unknown as User[];
  }

  /**
   * Returns all users (for owner staff management).
   */
  getAllUsers(requester: User): User[] {
    if (requester.role !== 'owner') {
      throw new Error('თანამშრომლების სიის ნახვა მხოლოდ მფლობელს შეუძლია');
    }
    return this.db.prepare(
      "SELECT id, name, role, is_active, created_at FROM users ORDER BY id ASC"
    ).all() as unknown as User[];
  }

  /**
   * First-run onboarding: registers the store owner with initial PIN.
   */
  setupInitialOwner(name: string, pin: string): UserSession {
    if (this.hasOwner()) {
      throw new Error('მფლობელის ანგარიში უკვე შექმნილია. გთხოვთ გაიაროთ ავტორიზაცია.');
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('მფლობელის სახელი სავალდებულოა');
    }

    if (!isValidPin(pin)) {
      throw new Error('PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
    }

    const salt = generateSalt();
    const hash = hashPin(pin, salt);
    const now = new Date().toISOString();

    const insertResult = this.db.prepare(
      "INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES (?, 'owner', ?, ?, 1, ?)"
    ).run(trimmedName, hash, salt, now);

    const newOwnerId = Number(insertResult.lastInsertRowid);
    const user: User = {
      id: newOwnerId,
      name: trimmedName,
      role: 'owner',
      is_active: 1,
      created_at: now
    };

    // Audit log
    this.db.prepare(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'OWNER_SETUP', 'users', ?, 'Initial owner created', ?)"
    ).run(newOwnerId, String(newOwnerId), now);

    return createSession(user);
  }

  /**
   * Logs in a user by ID and PIN.
   */
  login(userId: number, pin: string): UserSession {
    if (!isValidPin(pin)) {
      throw new Error('PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
    }

    const userRow = this.db.prepare(
      "SELECT id, name, role, pin_hash, pin_salt, is_active, created_at FROM users WHERE id = ?"
    ).get(userId) as {
      id: number;
      name: string;
      role: UserRole;
      pin_hash: string;
      pin_salt: string;
      is_active: number;
      created_at: string;
    } | undefined;

    if (!userRow) {
      throw new Error('მომხმარებელი ვერ მოიძებნა');
    }

    if (userRow.is_active === 0) {
      throw new Error('ეს ანგარიში დაბლოკილია');
    }

    const isMatch = verifyPin(pin, userRow.pin_hash, userRow.pin_salt);
    if (!isMatch) {
      throw new Error('არასწორი PIN კოდი');
    }

    const user: User = {
      id: userRow.id,
      name: userRow.name,
      role: userRow.role,
      is_active: userRow.is_active,
      created_at: userRow.created_at
    };

    return createSession(user);
  }

  /**
   * Adds a new employee/seller (Owner only).
   */
  addUser(requester: User, name: string, pin: string, role: UserRole = 'seller'): User {
    if (requester.role !== 'owner') {
      throw new Error('თანამშრომლის დამატება შეუძლია მხოლოდ მფლობელს');
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('თანამშრომლის სახელი სავალდებულოა');
    }

    if (!isValidPin(pin)) {
      throw new Error('PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
    }

    const salt = generateSalt();
    const hash = hashPin(pin, salt);
    const now = new Date().toISOString();

    const result = this.db.prepare(
      "INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run(trimmedName, role, hash, salt, now);

    const newId = Number(result.lastInsertRowid);

    this.db.prepare(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'USER_CREATE', 'users', ?, ?, ?)"
    ).run(requester.id, String(newId), `Created user ${trimmedName} (${role})`, now);

    return {
      id: newId,
      name: trimmedName,
      role,
      is_active: 1,
      created_at: now
    };
  }

  /**
   * Toggles employee active state (Owner only).
   */
  setUserActive(requester: User, targetUserId: number, isActive: boolean): void {
    if (requester.role !== 'owner') {
      throw new Error('მხოლოდ მფლობელს შეუძლია მომხმარებლის სტატუსის შეცვლა');
    }

    if (requester.id === targetUserId && !isActive) {
      throw new Error('საკუთარი თავის დაბლოკვა შეუძლებელია');
    }

    const now = new Date().toISOString();
    this.db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(isActive ? 1 : 0, targetUserId);

    this.db.prepare(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'USER_STATUS_CHANGE', 'users', ?, ?, ?)"
    ).run(requester.id, String(targetUserId), `Active set to ${isActive}`, now);
  }

  /**
   * Resets an employee's PIN (Owner only or self).
   */
  resetPin(requester: User, targetUserId: number, newPin: string): void {
    if (requester.role !== 'owner' && requester.id !== targetUserId) {
      throw new Error('PIN-ის შეცვლის უფლება არ გაქვთ');
    }

    if (!isValidPin(newPin)) {
      throw new Error('ახალი PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
    }

    const salt = generateSalt();
    const hash = hashPin(newPin, salt);
    const now = new Date().toISOString();

    this.db.prepare("UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?").run(hash, salt, targetUserId);

    this.db.prepare(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'PIN_RESET', 'users', ?, 'PIN reset', ?)"
    ).run(requester.id, String(targetUserId), now);
  }

  /**
   * Validates if a PIN matches the store owner's PIN.
   */
  verifyOwnerPin(userId: number, pin: string): boolean {
    if (!isValidPin(pin)) return false;
    const userRow = this.db.prepare(
      "SELECT pin_hash, pin_salt, role FROM users WHERE id = ?"
    ).get(userId) as { pin_hash: string; pin_salt: string; role: string } | undefined;

    if (!userRow || userRow.role !== 'owner') return false;
    return verifyPin(pin, userRow.pin_hash, userRow.pin_salt);
  }

  /**
   * Resets the entire store database (Owner only, strictly requiring valid Owner PIN).
   */
  resetStoreDatabase(requester: User, pin: string, backupServiceInstance?: BackupService): void {
    if (requester.role !== 'owner') {
      throw new Error('მონაცემთა ბაზის გასუფთავების უფლება აქვს მხოლოდ მფლობელს (Owner)');
    }

    if (!pin || !this.verifyOwnerPin(requester.id, pin)) {
      throw new Error('არასწორი PIN კოდი. ბაზის გასუფთავება უარყოფილია');
    }

    // Mandatory Production Safeguard: Automatic emergency backup snapshot before reset.
    // If backup creation or verification fails, abort immediately preserving all store data!
    const backupService = backupServiceInstance || new BackupService(this.db);
    backupService.createEmergencyPreResetBackup(requester);

    runInTransaction(() => {
      this.db.exec(`
        DELETE FROM sale_items;
        DELETE FROM sales;
        DELETE FROM debt_repayments;
        DELETE FROM return_items;
        DELETE FROM returns;
        DELETE FROM inventory_lots;
        DELETE FROM inventory_movements;
        DELETE FROM product_codes;
        DELETE FROM product_images;
        DELETE FROM product_variants;
        DELETE FROM products;
        DELETE FROM categories;
        DELETE FROM customers;
        DELETE FROM expenses;
        DELETE FROM audit_logs;
        DELETE FROM system_error_logs;
        DELETE FROM users;
      `);
    });
  }
}

