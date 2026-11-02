/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Authentication and User Management Service.
 * Runs in main process / backend.
 * Enforces Role-Based Access Control (RBAC): Owner vs Seller.
 *
 * Sessions live in memory only (a restart logs everyone out), expire after inactivity and
 * after a maximum age, are revoked on lock/logout, PIN reset and deactivation, and are
 * re-checked against the users table on every request. Wrong PINs lock the account for an
 * increasing time; the counter is stored in SQLite so restarting the app does not reset it.
 * Nobody can read a PIN: only salted PBKDF2 hashes are stored and they never leave this service.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { User, UserRole, UserSession } from '../../shared/types.ts';
import { generateSalt, hashPin, isValidPin, pinHashNeedsUpgrade, verifyPin } from '../../shared/auth.ts';
import { BackupService } from './backupService.ts';
import { oneOf, requireId, requireString } from './validation.ts';
import crypto from 'node:crypto';

interface SessionRecord {
  user: User;
  createdAt: number;
  lastSeenAt: number;
}

/** A session unused for this long is dropped (the UI locks itself much earlier). */
export const SESSION_IDLE_MS = 60 * 60 * 1000;
/** No session outlives a working day. */
export const SESSION_MAX_AGE_MS = 16 * 60 * 60 * 1000;
/** Failures allowed before the first temporary lock. */
export const PIN_FREE_ATTEMPTS = 4;
const LOCK_STEPS_SECONDS = [30, 60, 120, 300, 900];

// In-memory active sessions map: token -> session
const activeSessions = new Map<string, SessionRecord>();

export function getActiveSession(token: string, now: number = Date.now()): User | null {
  if (!token || typeof token !== 'string') return null;
  const s = activeSessions.get(token);
  if (!s) return null;
  if (now - s.lastSeenAt > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_AGE_MS) {
    activeSessions.delete(token);
    return null;
  }
  s.lastSeenAt = now;
  return s.user;
}

export function createSession(user: User): UserSession {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  activeSessions.set(token, { user, createdAt: now, lastSeenAt: now });
  return { user, token };
}

export function revokeSession(token: string): void {
  activeSessions.delete(token);
}

export function revokeUserSessions(userId: number, exceptToken?: string): number {
  let n = 0;
  for (const [token, s] of activeSessions) {
    if (s.user.id === userId && token !== exceptToken) {
      activeSessions.delete(token);
      n++;
    }
  }
  return n;
}

export function revokeAllSessions(): void {
  activeSessions.clear();
}

function lockDurationMs(failures: number): number {
  if (failures <= PIN_FREE_ATTEMPTS) return 0;
  return LOCK_STEPS_SECONDS[Math.min(failures - PIN_FREE_ATTEMPTS - 1, LOCK_STEPS_SECONDS.length - 1)] * 1000;
}

function formatWait(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  return secs < 60 ? `${secs} წამში` : `${Math.ceil(secs / 60)} წუთში`;
}

interface UserRow {
  id: number;
  name: string;
  role: UserRole;
  pin_hash: string;
  pin_salt: string;
  is_active: number;
  created_at: string;
  failed_pin_attempts: number;
  locked_until: string | null;
}

export class AuthService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  private audit(userId: number | null, action: string, entityId: string, details: string): void {
    this.db.prepare(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, ?, 'users', ?, ?, ?)"
    ).run(userId, action, entityId, details, new Date().toISOString());
  }

  private requireOwner(requester: User, message: string): void {
    if (requester.role !== 'owner') {
      throw new Error(message);
    }
  }

  private loadUser(userId: number): UserRow | undefined {
    return this.db.prepare(
      "SELECT id, name, role, pin_hash, pin_salt, is_active, created_at, failed_pin_attempts, locked_until FROM users WHERE id = ?"
    ).get(userId) as UserRow | undefined;
  }

  private toUser(row: UserRow): User {
    return { id: row.id, name: row.name, role: row.role, is_active: row.is_active, created_at: row.created_at };
  }

  /**
   * Checks a PIN with brute-force protection: after PIN_FREE_ATTEMPTS failures the account is
   * locked for 30 s, then 1, 2, 5 and 15 minutes. A correct PIN resets the counter.
   */
  private verifyPinWithLockout(row: UserRow, pin: unknown): void {
    const now = Date.now();
    if (row.locked_until && Date.parse(row.locked_until) > now) {
      throw new Error(`ბევრი არასწორი PIN მცდელობა. ანგარიში დროებით დაბლოკილია — სცადეთ ხელახლა ${formatWait(Date.parse(row.locked_until) - now)}`);
    }

    const ok = typeof pin === 'string' && isValidPin(pin) && verifyPin(pin, row.pin_hash, row.pin_salt);
    if (!ok) {
      const failures = (row.failed_pin_attempts || 0) + 1;
      const lockMs = lockDurationMs(failures);
      const lockedUntil = lockMs ? new Date(now + lockMs).toISOString() : null;
      this.db.prepare("UPDATE users SET failed_pin_attempts = ?, locked_until = ? WHERE id = ?").run(failures, lockedUntil, row.id);
      if (lockMs) {
        this.audit(null, 'PIN_LOCKOUT', String(row.id), `Account locked for ${lockMs / 1000}s after ${failures} wrong PIN attempts`);
        throw new Error(`არასწორი PIN კოდი. ბევრი მცდელობის გამო ანგარიში დროებით დაიბლოკა — სცადეთ ხელახლა ${formatWait(lockMs)}`);
      }
      const left = PIN_FREE_ATTEMPTS + 1 - failures;
      throw new Error(`არასწორი PIN კოდი (დაბლოკვამდე დარჩენილი მცდელობა: ${left})`);
    }

    if (row.failed_pin_attempts || row.locked_until) {
      this.db.prepare("UPDATE users SET failed_pin_attempts = 0, locked_until = NULL WHERE id = ?").run(row.id);
    }
    if (pinHashNeedsUpgrade(row.pin_hash)) {
      const salt = generateSalt();
      this.db.prepare("UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?").run(hashPin(pin as string, salt), salt, row.id);
    }
  }

  /**
   * Validates a session token: not expired, user still exists and is active.
   * Role and name are re-read so a change by the owner applies immediately.
   */
  resolveSession(token: string | undefined): User | null {
    if (!token) return null;
    const sessionUser = getActiveSession(token);
    if (!sessionUser) return null;
    const row = this.loadUser(sessionUser.id);
    if (!row || row.is_active !== 1) {
      revokeUserSessions(sessionUser.id);
      return null;
    }
    const user = this.toUser(row);
    const record = activeSessions.get(token);
    if (record) record.user = user;
    return user;
  }

  logout(token: string | undefined): void {
    if (token) revokeSession(token);
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
   * Returns all users (for owner staff management). Never includes PIN hashes.
   */
  getAllUsers(requester: User): User[] {
    this.requireOwner(requester, 'თანამშრომლების სიის ნახვა მხოლოდ მფლობელს შეუძლია');
    return this.db.prepare(
      "SELECT id, name, role, is_active, created_at, failed_pin_attempts, locked_until FROM users ORDER BY id ASC"
    ).all() as unknown as User[];
  }

  /**
   * First-run onboarding: registers the store owner with initial PIN.
   */
  setupInitialOwner(name: string, pin: string): UserSession {
    if (this.hasOwner()) {
      throw new Error('მფლობელის ანგარიში უკვე შექმნილია. გთხოვთ გაიაროთ ავტორიზაცია.');
    }

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      throw new Error('მფლობელის სახელი სავალდებულოა');
    }
    requireString(trimmedName, 60, 'მფლობელის სახელი');

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

    this.audit(newOwnerId, 'OWNER_SETUP', String(newOwnerId), 'Initial owner created');

    return createSession(user);
  }

  /**
   * Logs in a user by ID and PIN.
   */
  login(userId: number, pin: string): UserSession {
    if (!isValidPin(pin)) {
      throw new Error('PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
    }

    const userRow = this.loadUser(requireId(userId, 'მომხმარებელი'));
    if (!userRow) {
      throw new Error('მომხმარებელი ვერ მოიძებნა');
    }

    if (userRow.is_active === 0) {
      throw new Error('ეს ანგარიში დაბლოკილია');
    }

    this.verifyPinWithLockout(userRow, pin);
    return createSession(this.toUser(userRow));
  }

  /**
   * Adds a new employee/seller (Owner only).
   */
  addUser(requester: User, name: string, pin: string, role: UserRole = 'seller'): User {
    this.requireOwner(requester, 'თანამშრომლის დამატება შეუძლია მხოლოდ მფლობელს');

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      throw new Error('თანამშრომლის სახელი სავალდებულოა');
    }
    requireString(trimmedName, 60, 'თანამშრომლის სახელი');
    const safeRole = oneOf(role || 'seller', ['owner', 'seller'] as const, 'როლი');

    if (!isValidPin(pin)) {
      throw new Error('PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
    }

    const salt = generateSalt();
    const hash = hashPin(pin, salt);
    const now = new Date().toISOString();

    const result = this.db.prepare(
      "INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run(trimmedName, safeRole, hash, salt, now);

    const newId = Number(result.lastInsertRowid);
    this.audit(requester.id, 'USER_CREATE', String(newId), `Created user ${trimmedName} (${safeRole})`);

    return {
      id: newId,
      name: trimmedName,
      role: safeRole,
      is_active: 1,
      created_at: now
    };
  }

  /**
   * Toggles employee active state (Owner only). Deactivation ends the user's sessions at once.
   */
  setUserActive(requester: User, targetUserId: number, isActive: boolean): void {
    this.requireOwner(requester, 'მხოლოდ მფლობელს შეუძლია მომხმარებლის სტატუსის შეცვლა');
    const targetId = requireId(targetUserId, 'მომხმარებელი');

    if (requester.id === targetId && !isActive) {
      throw new Error('საკუთარი თავის დაბლოკვა შეუძლებელია');
    }
    const target = this.loadUser(targetId);
    if (!target) {
      throw new Error('მომხმარებელი ვერ მოიძებნა');
    }
    if (!isActive && target.role === 'owner') {
      const activeOwners = (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1").get() as any).n;
      if (activeOwners <= 1) throw new Error('ბოლო აქტიური მფლობელის დაბლოკვა შეუძლებელია');
    }

    this.db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(isActive ? 1 : 0, targetId);
    if (!isActive) revokeUserSessions(targetId);
    this.audit(requester.id, 'USER_STATUS_CHANGE', String(targetId), `Active set to ${!!isActive}`);
  }

  /**
   * Owner sets a new PIN for another employee (the old PIN is never shown or needed).
   * The employee's open sessions end. Own PIN changes go through changeOwnPin.
   */
  resetPin(requester: User, targetUserId: number, newPin: string): void {
    const targetId = requireId(targetUserId, 'მომხმარებელი');
    if (requester.role !== 'owner') {
      throw new Error('PIN-ის შეცვლის უფლება არ გაქვთ');
    }
    if (requester.id === targetId) {
      throw new Error('საკუთარი PIN-ის შესაცვლელად საჭიროა მიმდინარე PIN-ის შეყვანა');
    }

    if (!isValidPin(newPin)) {
      throw new Error('ახალი PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
    }
    if (!this.loadUser(targetId)) {
      throw new Error('მომხმარებელი ვერ მოიძებნა');
    }

    const salt = generateSalt();
    this.db.prepare("UPDATE users SET pin_hash = ?, pin_salt = ?, failed_pin_attempts = 0, locked_until = NULL WHERE id = ?")
      .run(hashPin(newPin, salt), salt, targetId);
    revokeUserSessions(targetId);
    this.audit(requester.id, 'PIN_RESET', String(targetId), 'PIN reset by owner');
  }

  /**
   * Any user changes their own PIN; the current PIN is required (with lockout).
   */
  changeOwnPin(requester: User, currentPin: string, newPin: string, keepToken?: string): void {
    const row = this.loadUser(requester.id);
    if (!row) throw new Error('მომხმარებელი ვერ მოიძებნა');
    this.verifyPinWithLockout(row, currentPin);
    if (!isValidPin(newPin)) {
      throw new Error('ახალი PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
    }
    if (newPin.trim() === String(currentPin).trim()) {
      throw new Error('ახალი PIN უნდა განსხვავდებოდეს მიმდინარესგან');
    }
    const salt = generateSalt();
    this.db.prepare("UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?").run(hashPin(newPin, salt), salt, requester.id);
    revokeUserSessions(requester.id, keepToken);
    this.audit(requester.id, 'PIN_CHANGE', String(requester.id), 'Own PIN changed');
  }

  /** Owner clears a temporary PIN lock of an employee. */
  unlockUser(requester: User, targetUserId: number): void {
    this.requireOwner(requester, 'ანგარიშის განბლოკვა შეუძლია მხოლოდ მფლობელს');
    const targetId = requireId(targetUserId, 'მომხმარებელი');
    this.db.prepare("UPDATE users SET failed_pin_attempts = 0, locked_until = NULL WHERE id = ?").run(targetId);
    this.audit(requester.id, 'PIN_UNLOCK', String(targetId), 'PIN lock cleared by owner');
  }

  /**
   * Validates if a PIN matches the store owner's PIN (counts towards the lockout).
   */
  verifyOwnerPin(userId: number, pin: string): boolean {
    const row = this.loadUser(userId);
    if (!row || row.role !== 'owner') return false;
    try {
      this.verifyPinWithLockout(row, pin);
      return true;
    } catch (err: any) {
      if (String(err?.message || '').includes('დაბლოკილ') || String(err?.message || '').includes('დაიბლოკა')) throw err;
      return false;
    }
  }

  /**
   * Resets the entire store database (Owner only, strictly requiring valid Owner PIN).
   * An emergency backup is created and verified first; if that fails nothing is deleted.
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
      // Sales and returns reference each other (exchanges) and lots reference movements,
      // so constraints are checked at commit, when every table is empty.
      this.db.exec('PRAGMA defer_foreign_keys = ON;');
      this.db.exec(`
        DELETE FROM debt_adjustments;
        DELETE FROM debt_repayment_allocations;
        DELETE FROM debt_repayments;
        DELETE FROM return_items;
        DELETE FROM returns;
        DELETE FROM sale_item_lots;
        DELETE FROM sale_items;
        DELETE FROM sales;
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
    }, this.db);
    revokeAllSessions();
  }
}
