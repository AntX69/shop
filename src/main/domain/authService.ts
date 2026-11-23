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
import { ALL_PERMISSION_IDS, DEFAULT_SELLER_PERMISSIONS, userCan } from '../../shared/permissions.ts';
import { BackupService } from './backupService.ts';
import { oneOf, requireId, requireString } from './validation.ts';
import { applyShopSettings, hasMoneyRecords } from '../db/database.ts';
import { isLang, Lang } from '../../shared/i18n/index.ts';
import { Currency, isCurrency } from '../../shared/currency.ts';
import { isValidTimeZone } from '../../shared/time.ts';

/** First-run choices: interface language of the owner, shop currency and time zone. */
export interface ShopSetup {
  language?: Lang | null;
  currency?: Currency;
  timezone?: string;
}
import {
  createSession, getActiveSession, refreshSessionUser, revokeAllSessions, revokeSession, revokeUserSessions,
  SESSION_IDLE_MS, SESSION_MAX_AGE_MS,
} from './sessions.ts';

export { createSession, getActiveSession, revokeAllSessions, revokeSession, revokeUserSessions, SESSION_IDLE_MS, SESSION_MAX_AGE_MS };

/** Failures allowed before the first temporary lock. */
export const PIN_FREE_ATTEMPTS = 4;
const LOCK_STEPS_SECONDS = [30, 60, 120, 300, 900];

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
  ui_language: string | null;
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
      "SELECT id, name, role, pin_hash, pin_salt, is_active, created_at, failed_pin_attempts, locked_until, ui_language FROM users WHERE id = ?"
    ).get(userId) as UserRow | undefined;
  }

  private toUser(row: UserRow): User {
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      is_active: row.is_active,
      permissions: this.getUserPermissions(row.id),
      created_at: row.created_at,
      language: isLang(row.ui_language) ? row.ui_language : null,
    };
  }

  getUserById(userId: number): User | null {
    const row = this.loadUser(userId);
    return row ? this.toUser(row) : null;
  }

  getUserPermissions(userId: number): string[] {
    const row = this.loadUser(userId);
    if (!row) return [];
    if (row.role === 'owner') {
      return [...ALL_PERMISSION_IDS];
    }
    const rows = this.db.prepare(
      "SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission ASC"
    ).all(userId) as Array<{ permission: string }>;
    // Only IDs of the current list count (an unknown stored ID never grants anything).
    const known = new Set(ALL_PERMISSION_IDS);
    return rows.map(r => r.permission).filter((p) => known.has(p));
  }

  /**
   * Permission check against SQLite (not the session copy), so a change by the owner applies to
   * the seller's very next request. `permission` may be a list: any one of them is enough.
   */
  hasPermission(user: User, permission?: string | readonly string[]): boolean {
    if (!permission) return true;
    const row = this.loadUser(user.id);
    if (!row || row.is_active !== 1) return false;
    if (row.role === 'owner') return true;
    return userCan({ role: row.role, permissions: this.getUserPermissions(row.id) }, permission);
  }

  setUserPermissions(requester: User, targetUserId: number, permissions: string[]): string[] {
    this.requireOwner(requester, 'უფლებების მართვა შეუძლია მხოლოდ მფლობელს');
    const targetId = requireId(targetUserId, 'მომხმარებელი');
    const target = this.loadUser(targetId);
    if (!target) {
      throw new Error('მომხმარებელი ვერ მოიძებნა');
    }
    if (target.role === 'owner') {
      throw new Error('მფლობელის უფლებების შეზღუდვა შეუძლებელია');
    }

    if (!Array.isArray(permissions)) throw new Error('უფლებების სია არასწორია');
    const validSet = new Set(ALL_PERMISSION_IDS);
    const unknown = permissions.filter((p) => typeof p !== 'string' || !validSet.has(p));
    if (unknown.length > 0) {
      // Never stored silently: an owner-only or misspelled ID is an error, not a no-op.
      throw new Error(`უცნობი ან გადაუცემადი უფლება: ${unknown.map((u) => String(u)).join(', ')}`);
    }
    const sanitized = Array.from(new Set(permissions as string[])).sort();
    const before = this.getUserPermissions(targetId);

    runInTransaction((db) => {
      db.prepare("DELETE FROM user_permissions WHERE user_id = ?").run(targetId);
      const insertStmt = db.prepare("INSERT INTO user_permissions (user_id, permission, created_at) VALUES (?, ?, ?)");
      const now = new Date().toISOString();
      for (const perm of sanitized) {
        insertStmt.run(targetId, perm, now);
      }
      const added = sanitized.filter((p) => !before.includes(p));
      const removed = before.filter((p) => !sanitized.includes(p));
      this.audit(requester.id, 'PERMISSIONS_UPDATE', String(targetId), JSON.stringify({ user: target.name, added, removed, after: sanitized }));
    }, this.db);

    return sanitized;
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
    refreshSessionUser(token, user);
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
      "SELECT id, name, role, is_active, created_at, ui_language AS language FROM users WHERE is_active = 1 ORDER BY role DESC, id ASC"
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
  setupInitialOwner(name: string, pin: string, shop: ShopSetup = {}): UserSession {
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

    // Language, currency and time zone of the new shop (chosen on the first screen).
    const language = shop.language === undefined || shop.language === null ? null : shop.language;
    if (language !== null && !isLang(language)) throw new Error('ენა არასწორია');
    if (shop.currency !== undefined && !isCurrency(shop.currency)) throw new Error('ვალუტა არასწორია');
    if (shop.timezone !== undefined && !isValidTimeZone(shop.timezone)) throw new Error('დროის სარტყელი არასწორია');

    const salt = generateSalt();
    const hash = hashPin(pin, salt);
    const now = new Date().toISOString();

    const newOwnerId = runInTransaction((db) => {
      const insertResult = db.prepare(
        "INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at, ui_language) VALUES (?, 'owner', ?, ?, 1, ?, ?)"
      ).run(trimmedName, hash, salt, now, language);
      const id = Number(insertResult.lastInsertRowid);
      const setting = db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");
      // The currency can only be chosen here while the shop has no money records yet.
      if (shop.currency !== undefined) {
        if (shop.currency !== this.currentSetting('currency', 'GEL') && hasMoneyRecords(db)) {
          throw new Error('მაღაზიას უკვე აქვს ფულადი ჩანაწერები: ვალუტის შეცვლა შეუძლებელია');
        }
        setting.run('currency', shop.currency);
      }
      if (shop.timezone !== undefined) setting.run('timezone', shop.timezone);
      db.prepare(
        "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'OWNER_SETUP', 'users', ?, ?, ?)"
      ).run(id, String(id), `Initial owner created (language ${language ?? 'device'}, currency ${shop.currency ?? 'unchanged'}, time zone ${shop.timezone ?? 'unchanged'})`, now);
      return id;
    }, this.db);
    applyShopSettings(this.db);

    const user: User = {
      id: newOwnerId,
      name: trimmedName,
      role: 'owner',
      is_active: 1,
      created_at: now,
      language,
    };

    return createSession(user);
  }

  private currentSetting(key: string, fallback: string): string {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  }

  /** Any user chooses their own interface language (it follows them to every computer screen). */
  setOwnLanguage(requester: User, language: unknown): User {
    if (!isLang(language)) throw new Error('ენა არასწორია');
    this.db.prepare('UPDATE users SET ui_language = ? WHERE id = ?').run(language, requester.id);
    const row = this.loadUser(requester.id);
    if (!row) throw new Error('მომხმარებელი ვერ მოიძებნა');
    return this.toUser(row);
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
  addUser(requester: User, name: string, pin: string, role: UserRole = 'seller', initialPermissions?: string[]): User {
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

    let grantedPerms: string[] = [];
    if (safeRole === 'seller') {
      const validSet = new Set(ALL_PERMISSION_IDS);
      grantedPerms = initialPermissions && Array.isArray(initialPermissions)
        ? Array.from(new Set(initialPermissions.filter((p) => typeof p === 'string' && validSet.has(p))))
        : [...DEFAULT_SELLER_PERMISSIONS];
      const insertStmt = this.db.prepare("INSERT INTO user_permissions (user_id, permission, created_at) VALUES (?, ?, ?)");
      for (const p of grantedPerms) {
        insertStmt.run(newId, p, now);
      }
    } else {
      grantedPerms = [...ALL_PERMISSION_IDS];
    }

    this.audit(requester.id, 'USER_CREATE', String(newId), `Created user ${trimmedName} (${safeRole})`);

    return {
      id: newId,
      name: trimmedName,
      role: safeRole,
      is_active: 1,
      permissions: grantedPerms,
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
