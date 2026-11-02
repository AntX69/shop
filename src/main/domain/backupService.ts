/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Production-Grade Backup, Restore, and Data Protection Service.
 * Features:
 * - Consistent online snapshot of the live SQLite database (VACUUM INTO), never a raw file copy
 * - Product photos bundled with the database in one .posbackup file, with SHA-256 checksums
 * - PRAGMA integrity_check before backup and on the candidate before restore
 * - Atomic writes (temporary file + rename) so a power cut never leaves a half-written backup;
 *   free space is checked first and a failed write leaves no partial file behind
 * - Configurable backup folder plus an optional mirror folder (e.g. a USB drive); the mirror copy
 *   of daily and manual backups is written in the background, so a slow or missing USB drive
 *   never holds up the till
 * - SHA-256 of the database and of every photo inside the backup (damaged photos are detected
 *   and skipped on restore; a damaged database refuses the restore)
 * - Automatic daily backup run by the main-process scheduler, with retention of old auto backups
 * - Restore: verified candidate, emergency backup of the current state, the live database moved
 *   aside (not overwritten), automatic roll-back if anything fails, photos written only into the
 *   app's own photo folder under sanitized names
 * - Log sanitization (never logs PINs or session tokens)
 */

import { DatabaseSync } from 'node:sqlite';
import {
  getDb, getDatabasePath, closeDatabase, initDatabase, runInTransaction, databaseFileOf, dataDirectoryFor,
} from '../db/database.ts';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../db/migrations.ts';
import { AuditLog, SystemErrorLog, User, BackupInfo } from '../../shared/types.ts';
import { localDate, STORE_TIME_ZONE } from '../../shared/time.ts';
import { revokeAllSessions } from './sessions.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type BackupKind = 'manual' | 'auto' | 'prereset' | 'prerestore';

export interface PosBackupBundle {
  format: 'StorePOS-Unified-Backup';
  version: '1.0' | '1.1' | '1.2';
  kind?: BackupKind;
  created_at: string;
  schema_version?: number;
  created_by_user_id: number | null;
  stats: {
    products_count: number;
    sales_count: number;
    customers_count: number;
    total_debt_tetri: number;
    images_count?: number;
  };
  db_checksum_sha256: string;
  db_size_bytes: number;
  settings: Record<string, string>;
  db_base64: string;
  images: Array<{
    product_id: number;
    file_path: string;
    is_primary: number;
    data_base64?: string; // Real binary image content (data URL)
    sha256?: string; // of the image bytes (format 1.2+)
  }>;
}

const SAFE_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const IMAGE_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const SETTINGS_RULES: Record<string, (v: string) => string> = {
  store_name: (v) => {
    const t = v.trim();
    if (!t || t.length > 80) throw new Error('მაღაზიის სახელი უნდა იყოს 1–80 სიმბოლო');
    return t;
  },
  inactivity_lock_minutes: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 240) throw new Error('ავტომატური ჩაკეტვის დრო უნდა იყოს 1–240 წუთი');
    return String(n);
  },
  auto_backup_enabled: (v) => {
    if (v !== '0' && v !== '1') throw new Error('ავტომატური სარეზერვო ასლის პარამეტრი არასწორია');
    return v;
  },
  backup_retention_count: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 3 || n > 365) throw new Error('შესანახი ავტომატური ასლების რაოდენობა უნდა იყოს 3–365');
    return String(n);
  },
  backup_directory: (v) => validateFolderSetting(v),
  backup_mirror_directory: (v) => validateFolderSetting(v),
};

function validateFolderSetting(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (!path.isAbsolute(v)) throw new Error('საქაღალდის სრული მისამართი სავალდებულოა (მაგ. E:\\StorePOS-Backups)');
  try {
    fs.mkdirSync(v, { recursive: true });
    const probe = path.join(v, `.storepos-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err: any) {
    throw new Error(`საქაღალდეში ჩაწერა ვერ ხერხდება: ${v} (${err?.code || err?.message})`);
  }
  return path.resolve(v);
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Local (Tbilisi) timestamp safe for file names: 2026-11-02_20-15-30-123 */
function fileStamp(now: Date): string {
  const time = now.toLocaleTimeString('en-GB', { timeZone: STORE_TIME_ZONE, hour12: false }).replace(/:/g, '-');
  return `${localDate(now)}_${time}-${String(now.getMilliseconds()).padStart(3, '0')}`;
}

/** Plain-language reason for a failed backup write. */
export function describeWriteError(err: any): string {
  switch (err?.code) {
    case 'ENOSPC': return 'დისკზე ადგილი აღარ არის';
    case 'EACCES':
    case 'EPERM': return 'საქაღალდეში ჩაწერის უფლება არ არის';
    case 'ENOENT':
    case 'ENOTDIR': return 'საქაღალდე/დისკი ხელმისაწვდომი არ არის';
    case 'EIO': return 'დისკის შეცდომა (შესაძლოა USB დისკი გამოძვრა)';
    case 'EROFS': return 'დისკი მხოლოდ წასაკითხია';
    default: return err?.message || String(err);
  }
}

/** Free bytes for this user on the drive holding `dir`, or null when it cannot be told. */
function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Refuses a write that cannot fit (with 5% / 1 MB to spare). */
export function ensureFreeSpace(dir: string, bytes: number, free: number | null = freeBytes(dir)): void {
  const needed = Math.ceil(bytes * 1.05) + 1024 * 1024;
  if (free !== null && free < needed) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    throw Object.assign(new Error(`დისკზე ადგილი არ არის: საჭიროა ${mb(needed)} MB, თავისუფალია ${mb(free)} MB (${dir})`), { code: 'ENOSPC_PRECHECK' });
  }
}

function writeFileAtomic(target: string, data: Buffer): void {
  const partial = `${target}.partial`;
  try {
    fs.writeFileSync(partial, data);
    fs.renameSync(partial, target);
  } catch (err: any) {
    // Never leave a half-written file behind (it would only fill the disk further).
    try { fs.unlinkSync(partial); } catch {}
    throw Object.assign(new Error(`${describeWriteError(err)}: ${target}`), { code: err?.code });
  }
}

async function copyFileAtomic(source: string, target: string): Promise<void> {
  const partial = `${target}.partial`;
  try {
    await fs.promises.copyFile(source, partial);
    await fs.promises.rename(partial, target);
  } catch (err) {
    await fs.promises.unlink(partial).catch(() => {});
    throw err;
  }
}

/** Reads only the metadata at the start of a .posbackup (everything before the database blob). */
function readBundleHeader(filePath: string): Partial<PosBackupBundle> | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf-8');
    const idx = text.indexOf('"db_base64"');
    if (idx > 0) {
      const head = text.slice(0, idx).replace(/,\s*$/, '');
      return JSON.parse(`${head}}`);
    }
  } catch {
    // fall through to a full parse
  } finally {
    fs.closeSync(fd);
  }
  try {
    const full = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    delete full.db_base64;
    delete full.images;
    return full;
  } catch {
    return null;
  }
}

export class BackupService {
  private db: DatabaseSync;
  private customDbPath?: string;

  constructor(db: DatabaseSync = getDb(), customDbPath?: string) {
    this.db = db;
    this.customDbPath = customDbPath;
  }

  /** The database file this service backs up and restores (the one it is connected to). */
  public getTargetDbPath(): string {
    return this.customDbPath || databaseFileOf(this.db);
  }

  private dataDir(): string {
    return this.customDbPath ? path.dirname(this.customDbPath) : dataDirectoryFor(this.db);
  }

  private imagesDir(): string {
    const dir = path.join(this.dataDir(), 'images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private checkOwner(user: User): void {
    if (!user || user.role !== 'owner') {
      throw new Error('სარეზერვო ასლების მართვის უფლება აქვს მხოლოდ მფლობელს (Owner)');
    }
  }

  /**
   * Resolves the configured backup directory or falls back to <data>/backups.
   */
  getEffectiveBackupDirectory(): string {
    try {
      const dir = (this.getSettings().backup_directory || '').trim();
      if (dir) {
        const resolved = path.resolve(dir);
        if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
        return resolved;
      }
    } catch (err: any) {
      this.logSystemError('backup:directory', `Configured backup folder unavailable, using default: ${err?.message}`, undefined, 'warning');
    }
    const fallback = path.join(this.dataDir(), 'backups');
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }

  /** Consistent snapshot of the live database as a standalone SQLite file. */
  private snapshotDatabase(): Buffer {
    const tmp = path.join(this.dataDir(), `.snapshot-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
    try {
      this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      return fs.readFileSync(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  private collectStats(db: DatabaseSync) {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as any)?.cnt || 0;
    let totalDebt = 0;
    try {
      totalDebt = (db.prepare('SELECT COALESCE(SUM(remaining_tetri), 0) AS t FROM sale_debt_balances').get() as any).t;
    } catch {}
    return {
      products_count: count('products'),
      sales_count: count('sales'),
      customers_count: count('customers'),
      total_debt_tetri: totalDebt,
      images_count: count('product_images'),
    };
  }

  private collectImages(): PosBackupBundle['images'] {
    const rows = this.db.prepare("SELECT product_id, file_path, is_primary FROM product_images").all() as Array<{ product_id: number; file_path: string; is_primary: number }>;
    const imagesDir = this.imagesDir();
    return rows.map((img) => {
      let dataUrl: string | undefined;
      let hash: string | undefined;
      if (img.file_path.startsWith('data:')) {
        dataUrl = img.file_path;
      } else {
        const file = path.join(imagesDir, path.basename(img.file_path));
        if (fs.existsSync(file)) {
          const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
          const bytes = fs.readFileSync(file);
          dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
          hash = sha256(bytes);
        } else {
          this.logSystemError('backup:create', `Product photo missing on disk: ${path.basename(img.file_path)}`, undefined, 'warning');
        }
      }
      return { product_id: img.product_id, file_path: img.file_path, is_primary: img.is_primary, data_base64: dataUrl, sha256: hash };
    });
  }

  /**
   * Creates a complete, verified .posbackup bundle.
   * Includes SQLite DB snapshot, real product image files, store settings, and SHA-256 checksums.
   */
  createBackup(
    user: User,
    customTargetDir?: string,
    kind: BackupKind = 'manual',
    now: Date = new Date(),
    options: { mirror?: 'sync' | 'later' } = {}
  ): {
    backup_filename: string;
    filepath: string;
    size_bytes: number;
    checksum_sha256: string;
    created_at: string;
    kind: BackupKind;
    mirror_filepath?: string | null;
    mirror_error?: string | null;
  } {
    this.checkOwner(user);

    const dbPath = this.getTargetDbPath();
    if (dbPath !== ':memory:' && !fs.existsSync(dbPath)) {
      throw new Error('ბაზის ფაილი ვერ მოიძებნა');
    }

    // 1. Verify integrity of current database before backing up
    const checkRow = this.db.prepare("PRAGMA integrity_check;").get() as any;
    if (!checkRow || checkRow.integrity_check !== 'ok') {
      throw new Error(`ბაზის მთლიანობის შეცდომა: PRAGMA integrity_check = ${checkRow?.integrity_check || 'fail'}`);
    }

    const dbBuffer = this.snapshotDatabase();
    const createdAt = now.toISOString();
    const filename = `storepos_${kind}_${fileStamp(now)}.posbackup`;
    const images = this.collectImages();
    const stats = this.collectStats(this.db);

    // Metadata first: listing backups reads only this header, not the whole file.
    const bundle: PosBackupBundle = {
      format: 'StorePOS-Unified-Backup',
      version: '1.2',
      kind,
      created_at: createdAt,
      schema_version: LATEST_SCHEMA_VERSION,
      created_by_user_id: user.id ?? null,
      stats,
      db_checksum_sha256: sha256(dbBuffer),
      db_size_bytes: dbBuffer.length,
      settings: this.getSettings(),
      db_base64: dbBuffer.toString('base64'),
      images,
    };
    const bundleBuffer = Buffer.from(JSON.stringify(bundle, null, 2), 'utf-8');
    const bundleHash = sha256(bundleBuffer);

    const targetDir = customTargetDir ? path.resolve(customTargetDir) : this.getEffectiveBackupDirectory();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const savedFilePath = path.join(targetDir, filename);
    ensureFreeSpace(targetDir, bundleBuffer.length);
    writeFileAtomic(savedFilePath, bundleBuffer);

    // Mirror copy (e.g. USB drive). A missing drive never fails the main backup. With
    // mirror 'later' the caller writes it in the background (copyToMirror).
    let mirrorPath: string | null = null;
    let mirrorError: string | null = null;
    const mirrorDir = (this.getSettings().backup_mirror_directory || '').trim();
    if (mirrorDir && !customTargetDir && options.mirror !== 'later') {
      try {
        if (!fs.existsSync(mirrorDir)) throw new Error('საქაღალდე/დისკი ხელმისაწვდომი არ არის');
        ensureFreeSpace(mirrorDir, bundleBuffer.length);
        mirrorPath = path.join(mirrorDir, filename);
        writeFileAtomic(mirrorPath, bundleBuffer);
      } catch (err: any) {
        mirrorPath = null;
        mirrorError = err?.message || String(err);
        this.logSystemError('backup:mirror', `Mirror copy to ${mirrorDir} failed: ${mirrorError}`, undefined, 'warning');
      }
    }

    if (kind === 'auto') {
      this.applyRetention(targetDir);
      if (mirrorPath) this.applyRetention(mirrorDir);
    }

    try {
      const stmt = this.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");
      stmt.run('last_backup_date', createdAt);
      if (kind === 'auto') stmt.run('last_auto_backup_date', localDate(now));
    } catch {}

    this.db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
      VALUES (?, 'BACKUP_CREATE', 'system', ?, ?, ?)
    `).run(
      kind === 'auto' ? null : user.id,
      filename,
      `${kind} backup: ${bundleBuffer.length} bytes, SHA256 ${bundleHash.substring(0, 16)}…, images ${images.length}, products ${stats.products_count}` +
      (mirrorPath ? `, mirror: ${mirrorPath}` : mirrorError ? `, mirror failed: ${mirrorError}` : ''),
      createdAt
    );

    return {
      backup_filename: filename,
      filepath: savedFilePath,
      size_bytes: bundleBuffer.length,
      checksum_sha256: bundleHash,
      created_at: createdAt,
      kind,
      mirror_filepath: mirrorPath,
      mirror_error: mirrorError,
    };
  }

  /**
   * Copies a finished backup to the mirror folder (e.g. a USB drive) without blocking the main
   * process: a slow stick or a disconnected network drive never holds up sales. Never throws.
   */
  async copyToMirror(sourceFile: string, kind: BackupKind): Promise<{ path: string | null; error: string | null }> {
    const mirrorDir = (this.getSettings().backup_mirror_directory || '').trim();
    if (!mirrorDir) return { path: null, error: null };
    const target = path.join(mirrorDir, path.basename(sourceFile));
    try {
      try {
        await fs.promises.access(mirrorDir, fs.constants.W_OK);
      } catch {
        throw new Error('საქაღალდე/დისკი ხელმისაწვდომი არ არის');
      }
      const size = (await fs.promises.stat(sourceFile)).size;
      const free = await fs.promises.statfs(mirrorDir).then((s) => Number(s.bavail) * Number(s.bsize), () => null);
      ensureFreeSpace(mirrorDir, size, free);
      await copyFileAtomic(sourceFile, target);
      if (kind === 'auto') this.applyRetention(mirrorDir);
      try {
        this.db.prepare(`
          INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
          VALUES (NULL, 'BACKUP_MIRROR', 'system', ?, ?, ?)
        `).run(path.basename(sourceFile), `Mirror copy written: ${target}`, new Date().toISOString());
      } catch {}
      return { path: target, error: null };
    } catch (err: any) {
      const message = err?.code === 'ENOSPC_PRECHECK' || !err?.code ? (err?.message || String(err)) : describeWriteError(err);
      try {
        this.logSystemError('backup:mirror', `Mirror copy to ${mirrorDir} failed: ${message}`, undefined, 'warning');
      } catch {}
      return { path: null, error: message };
    }
  }

  /** Manual backup: written to the backup folder now, the mirror copy awaited without blocking. */
  async createBackupWithMirror(user: User, kind: BackupKind = 'manual', now: Date = new Date()) {
    const result = this.createBackup(user, undefined, kind, now, { mirror: 'later' });
    const mirror = await this.copyToMirror(result.filepath, kind);
    return { ...result, mirror_filepath: mirror.path, mirror_error: mirror.error };
  }

  /** Keeps the newest N automatic backups in a folder; manual and safety backups are never pruned. */
  private applyRetention(dir: string): void {
    const keep = Math.max(3, parseInt(this.getSettings().backup_retention_count || '30', 10) || 30);
    try {
      const autos = fs.readdirSync(dir).filter((f) => /^storepos_auto_.*\.posbackup$/.test(f)).sort().reverse();
      for (const old of autos.slice(keep)) {
        fs.unlinkSync(path.join(dir, old));
      }
    } catch (err: any) {
      this.logSystemError('backup:retention', `Retention cleanup failed in ${dir}: ${err?.message}`, undefined, 'warning');
    }
  }

  /**
   * Creates an emergency pre-wipe backup automatically when database reset is triggered.
   * Strictly verifies integrity and throws if backup creation or validation fails.
   */
  createEmergencyPreResetBackup(user: User): string {
    const res = this.createBackup(user, undefined, 'prereset');
    const verification = this.inspectBundle(fs.readFileSync(res.filepath));
    if (!verification.ok) {
      throw new Error(`ავარიული ასლის შექმნისას დაფიქსირდა შეცდომა: ${verification.error}`);
    }
    return res.filepath;
  }

  /**
   * Full verification of a backup: format, checksums, SQLite header, integrity_check,
   * required tables and schema version. With keepCandidate the verified database file is
   * left on disk for restore; otherwise it is deleted.
   */
  private inspectBundle(raw: Buffer, keepCandidate = false): {
    ok: boolean;
    error?: string;
    bundle?: PosBackupBundle;
    candidatePath?: string;
    stats?: any;
    /** Photo files whose bytes no longer match their SHA-256 (format 1.2+). */
    damagedImages?: string[];
  } {
    let bundle: PosBackupBundle;
    let dbBuffer: Buffer;
    try {
      const text = raw.toString('utf-8').trim();
      const parsed = text.startsWith('{') ? JSON.parse(text) : JSON.parse(Buffer.from(text, 'base64').toString('utf-8'));
      if (!parsed || parsed.format !== 'StorePOS-Unified-Backup') {
        return { ok: false, error: 'არათავსებადი სარეზერვო ასლის ფორმატი' };
      }
      bundle = parsed;
      dbBuffer = Buffer.from(bundle.db_base64 || '', 'base64');
    } catch {
      return { ok: false, error: 'ფაილი არ არის StorePOS-ის სარეზერვო ასლი ან დაზიანებულია' };
    }

    if (!bundle.db_checksum_sha256 || bundle.db_checksum_sha256 !== sha256(dbBuffer)) {
      return { ok: false, error: 'სარეზერვო ასლის შემოწმების შეცდომა: მონაცემთა ბაზის შიდა Checksum არ ემთხვევა (დაზიანებული მონაცემები)' };
    }
    if (!dbBuffer.subarray(0, 16).toString('latin1').startsWith('SQLite format 3')) {
      return { ok: false, error: 'არავალიდური SQLite ბაზა' };
    }
    if ((bundle.schema_version || 0) > LATEST_SCHEMA_VERSION) {
      return { ok: false, error: `ასლი შექმნილია StorePOS-ის უფრო ახალი ვერსიით (სქემა v${bundle.schema_version}); ჯერ განაახლეთ პროგრამა` };
    }

    const candidatePath = path.join(this.dataDir(), `.restore-candidate-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
    fs.writeFileSync(candidatePath, dbBuffer);
    let candidateDb: DatabaseSync | null = null;
    try {
      candidateDb = new DatabaseSync(candidatePath);
      const row = candidateDb.prepare("PRAGMA integrity_check;").get() as any;
      if (!row || row.integrity_check !== 'ok') {
        throw new Error(`ბაზის ფაილი დაზიანებულია: PRAGMA integrity_check = ${row?.integrity_check || 'fail'}`);
      }
      for (const t of ['users', 'products', 'product_variants', 'sales', 'customers']) {
        if (!candidateDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t)) {
          throw new Error(`სარეზერვო ასლი არათავსებადია: ცხრილი "${t}" ვერ მოიძებნა`);
        }
      }
      const stats = {
        products_count: (candidateDb.prepare('SELECT COUNT(*) AS c FROM products').get() as any).c,
        sales_count: (candidateDb.prepare('SELECT COUNT(*) AS c FROM sales').get() as any).c,
        customers_count: (candidateDb.prepare('SELECT COUNT(*) AS c FROM customers').get() as any).c,
      };
      candidateDb.close();
      candidateDb = null;
      if (!keepCandidate) fs.unlinkSync(candidatePath);
      const damagedImages = (bundle.images || [])
        .filter((img) => img.sha256 && img.data_base64 && !img.file_path.startsWith('data:'))
        .filter((img) => {
          const m = img.data_base64!.match(/^data:image\/[A-Za-z0-9.+-]+;base64,(.+)$/);
          return !m || sha256(Buffer.from(m[1], 'base64')) !== img.sha256;
        })
        .map((img) => path.basename(img.file_path));
      return { ok: true, bundle, candidatePath: keepCandidate ? candidatePath : undefined, stats, damagedImages };
    } catch (err: any) {
      try { candidateDb?.close(); } catch {}
      try { fs.unlinkSync(candidatePath); } catch {}
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /** Restores from a file chosen in a native dialog or listed in the backup folder. */
  restoreFromFile(user: User, filePath: string) {
    this.checkOwner(user);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('სარეზერვო ფაილი ვერ მოიძებნა');
    }
    return this.restoreFromBuffer(user, fs.readFileSync(filePath), path.basename(filePath));
  }

  /** Restores a backup from the configured backup folder by file name. */
  restoreFromList(user: User, filename: string) {
    this.checkOwner(user);
    const name = path.basename(String(filename || ''));
    if (!name.endsWith('.posbackup')) throw new Error('არასწორი ფაილის სახელი');
    return this.restoreFromFile(user, path.join(this.getEffectiveBackupDirectory(), name));
  }

  /**
   * Restores database from an uploaded backup (JSON text or base64 of it).
   */
  restoreBackup(user: User, dataString: string, expectedChecksum?: string) {
    this.checkOwner(user);
    if (typeof dataString !== 'string' || !dataString.trim()) {
      throw new Error('სარეზერვო ასლის მონაცემები ცარიელია');
    }
    const trimmed = dataString.trim();
    const raw = trimmed.startsWith('{') ? Buffer.from(trimmed, 'utf-8') : Buffer.from(trimmed, 'base64');
    if (expectedChecksum && expectedChecksum !== sha256(raw)) {
      throw new Error('სარეზერვო ასლის შემოწმების შეცდომა: ფაილის Checksum არ ემთხვევა (დაზიანებული ფაილი)');
    }
    return this.restoreFromBuffer(user, raw, 'uploaded file');
  }

  private restoreFromBuffer(user: User, raw: Buffer, sourceLabel: string): {
    success: boolean;
    message: string;
    safety_backup?: string;
    restored_stats?: { products_count: number; sales_count: number; customers_count: number; images_restored: number; images_damaged?: number };
  } {
    this.checkOwner(user);
    const dbPath = this.getTargetDbPath();

    // 1. Verify the candidate completely before touching anything.
    const inspection = this.inspectBundle(raw, true);
    if (!inspection.ok) {
      throw new Error(inspection.error);
    }
    const candidatePath = inspection.candidatePath!;
    if (dbPath === ':memory:') {
      fs.unlinkSync(candidatePath);
      throw new Error('აღდგენა შესაძლებელია მხოლოდ დისკზე შენახულ ბაზაზე');
    }

    // 2. Emergency backup of the current state; without it no restore happens.
    let safetyBackup: string;
    try {
      safetyBackup = this.createBackup(user, undefined, 'prerestore').filepath;
    } catch (err: any) {
      fs.unlinkSync(candidatePath);
      throw new Error(`აღდგენა შეჩერდა: მიმდინარე მონაცემების სარეზერვო ასლი ვერ შეიქმნა (${err?.message})`);
    }

    // 3. Close every connection to the live file (Windows refuses to move open files).
    const isSingleton = path.resolve(dbPath) === path.resolve(getDatabasePath());
    closeDatabase();
    try { this.db.close(); } catch {}

    // 4. Move the live files aside, put the verified candidate in place.
    const stamp = Date.now();
    const aside = (suffix: string) => `${dbPath}${suffix}.replaced-${stamp}`;
    const moved: Array<[string, string]> = [];
    let newDb: DatabaseSync | null = null;
    let imagesRestored = 0;
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(dbPath + suffix)) {
          fs.renameSync(dbPath + suffix, aside(suffix));
          moved.push([dbPath + suffix, aside(suffix)]);
        }
      }
      fs.renameSync(candidatePath, dbPath);

      // 5. Photos: only into the app's photo folder, only under plain file names; a photo whose
      //    checksum does not match is skipped (the sales and debts matter more than a picture).
      const imagesDir = this.imagesDir();
      const damaged = new Set(inspection.damagedImages || []);
      for (const img of inspection.bundle!.images || []) {
        if (!img.data_base64 || img.file_path.startsWith('data:')) continue;
        const name = path.basename(img.file_path);
        if (!SAFE_IMAGE_NAME.test(name) || damaged.has(name)) continue;
        const m = img.data_base64.match(/^data:image\/[A-Za-z0-9.+-]+;base64,(.+)$/);
        if (!m) continue;
        writeFileAtomic(path.join(imagesDir, name), Buffer.from(m[1], 'base64'));
        imagesRestored++;
      }

      // 6. Reopen (older backups are migrated forward) and verify.
      if (isSingleton) {
        newDb = initDatabase(dbPath);
      } else {
        newDb = new DatabaseSync(dbPath);
        newDb.exec('PRAGMA foreign_keys = ON;');
        newDb.exec('PRAGMA journal_mode = WAL;');
        runMigrations(newDb, dbPath);
      }
      const postRow = newDb.prepare("PRAGMA integrity_check;").get() as any;
      if (!postRow || postRow.integrity_check !== 'ok') {
        throw new Error('აღდგენის შემდგომი შემოწმება ჩაიშალა');
      }
      this.db = newDb;
      const stats = this.collectStats(newDb);

      // The restored database has its own users: everyone signs in again.
      revokeAllSessions();

      // Keep the replaced database once more next to the live one, drop the rest.
      for (const [, asideFile] of moved) {
        if (asideFile === aside('')) {
          const keepAs = `${dbPath}.before-restore.bak`;
          try { if (fs.existsSync(keepAs)) fs.unlinkSync(keepAs); fs.renameSync(asideFile, keepAs); } catch {}
        } else {
          try { fs.unlinkSync(asideFile); } catch {}
        }
      }

      newDb.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (NULL, 'BACKUP_RESTORE', 'system', ?, ?, ?)
      `).run(
        sourceLabel,
        `Restored by ${user.name} (id ${user.id}) from ${sourceLabel}. Safety backup: ${path.basename(safetyBackup)}. ` +
        `${stats.products_count} products, ${stats.sales_count} sales, ${stats.customers_count} customers, ${imagesRestored} photos` +
        (damaged.size ? `, ${damaged.size} damaged photos skipped: ${[...damaged].join(', ')}.` : '.'),
        new Date().toISOString()
      );

      return {
        success: true,
        message: 'ბაზა შემოწმდა (PRAGMA integrity_check: OK) და წარმატებით აღდგა.' +
          (damaged.size ? ` ${damaged.size} ფოტო ასლში დაზიანებული იყო და არ აღდგა (ხელახლა დაამატეთ).` : '') +
          ' გთხოვთ ხელახლა შეხვიდეთ.',
        safety_backup: safetyBackup,
        restored_stats: {
          products_count: stats.products_count,
          sales_count: stats.sales_count,
          customers_count: stats.customers_count,
          images_restored: imagesRestored,
          images_damaged: damaged.size
        }
      };
    } catch (err: any) {
      // Roll back: put the previous files back exactly as they were.
      try { newDb?.close(); } catch {}
      if (isSingleton) closeDatabase();
      try { if (fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath); } catch {}
      if (moved.length > 0) {
        try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
        for (const suffix of ['-wal', '-shm']) {
          try { if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix); } catch {}
        }
        for (const [original, asideFile] of moved) {
          try { fs.renameSync(asideFile, original); } catch {}
        }
      }
      try {
        this.db = isSingleton ? initDatabase(dbPath) : new DatabaseSync(dbPath);
      } catch {}
      this.logSystemError('backup:restore', `Restore failed and was rolled back: ${err?.message}`, err?.stack, 'critical', user.id);
      throw new Error(`აღდგენის შეცდომა (მიმდინარე მონაცემები უცვლელია): ${err?.message}`);
    }
  }

  /** Current connection (changes after a restore). */
  getConnection(): DatabaseSync {
    return this.db;
  }

  /**
   * Lists all existing .posbackup files in the configured backup directory.
   */
  listBackups(user: User): BackupInfo[] {
    this.checkOwner(user);

    const backupDir = this.getEffectiveBackupDirectory();
    if (!fs.existsSync(backupDir)) return [];

    const results: BackupInfo[] = [];
    for (const f of fs.readdirSync(backupDir).filter((name) => name.endsWith('.posbackup'))) {
      const fullPath = path.join(backupDir, f);
      try {
        const stats = fs.statSync(fullPath);
        const header = readBundleHeader(fullPath);
        const isValid = header?.format === 'StorePOS-Unified-Backup';
        results.push({
          filename: f,
          filepath: fullPath,
          size_bytes: stats.size,
          created_at: header?.created_at || stats.mtime.toISOString(),
          checksum_sha256: header?.db_checksum_sha256 || '',
          is_valid: isValid,
          integrity_status: isValid ? 'OK (სრული შემოწმება აღდგენისას)' : 'INVALID_FORMAT',
          kind: header?.kind || (f.startsWith('store_backup_') ? 'manual' : undefined),
          schema_version: header?.schema_version,
          stats: header?.stats as any
        } as BackupInfo);
      } catch {
        results.push({
          filename: f,
          filepath: fullPath,
          size_bytes: 0,
          created_at: new Date(0).toISOString(),
          checksum_sha256: '',
          is_valid: false,
          integrity_status: 'CORRUPTED'
        });
      }
    }

    return results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  /**
   * Verifies an uploaded or selected backup file without modifying current database.
   */
  verifyBackup(user: User, dataString?: string, filename?: string): { is_valid: boolean; integrity_status: string; stats?: any } {
    this.checkOwner(user);
    let raw: Buffer;
    if (filename) {
      const targetPath = path.join(this.getEffectiveBackupDirectory(), path.basename(filename));
      if (!fs.existsSync(targetPath)) {
        return { is_valid: false, integrity_status: `ფაილი "${filename}" ვერ მოიძებნა` };
      }
      raw = fs.readFileSync(targetPath);
    } else if (dataString) {
      raw = Buffer.from(dataString.trim(), 'utf-8');
    } else {
      return { is_valid: false, integrity_status: 'მონაცემები არ არის მითითებული' };
    }
    const result = this.inspectBundle(raw);
    if (!result.ok) return { is_valid: false, integrity_status: result.error || 'შეცდომა' };
    const damaged = result.damagedImages || [];
    return {
      is_valid: true,
      integrity_status: damaged.length
        ? `მონაცემთა ბაზა მთელია (SHA-256 + SQLite integrity_check), მაგრამ ${damaged.length} ფოტო დაზიანებულია და აღდგენისას გამოტოვდება`
        : 'მთლიანობა დადასტურებულია (SHA-256 + SQLite integrity_check)',
      stats: { ...result.stats, damaged_images: damaged.length }
    };
  }

  /**
   * Automatic daily backup, run by the main-process scheduler (independently of who is logged
   * in or which screen is open). One per Tbilisi calendar day.
   */
  runScheduledBackupIfDue(now: Date = new Date()): boolean {
    try {
      const settings = this.getSettings();
      if (settings.auto_backup_enabled === '0') return false;
      if ((settings.last_auto_backup_date || '') === localDate(now)) return false;

      const ownerRow = this.db.prepare("SELECT id, name, role, created_at FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY id LIMIT 1").get() as any;
      if (!ownerRow) return false; // nothing to protect before the first owner exists

      const result = this.createBackup({ id: ownerRow.id, name: ownerRow.name, role: 'owner', is_active: 1, created_at: ownerRow.created_at }, undefined, 'auto', now, { mirror: 'later' });
      console.log('[BackupService] Automated daily backup executed successfully.');
      void this.copyToMirror(result.filepath, 'auto');
      return true;
    } catch (err: any) {
      console.warn('[BackupService] Automated daily backup failed:', err);
      this.logSystemError('backup:auto', `Automatic daily backup failed: ${err?.message}`, err?.stack, 'critical');
      return false;
    }
  }

  /** Kept for the Settings screen's "run daily backup now" action. */
  checkAndRunDailyBackup(_user?: User): boolean {
    return this.runScheduledBackupIfDue();
  }

  /**
   * Logs an internal system error with strict sanitization (never logs PINs or tokens).
   */
  logSystemError(
    errorSource: string,
    errorMessage: string,
    stackTrace?: string,
    severity: 'error' | 'warning' | 'critical' = 'error',
    userId?: number
  ): void {
    try {
      const sanitizedMsg = this.sanitizeSensitiveText(String(errorMessage || ''));
      const sanitizedStack = stackTrace ? this.sanitizeSensitiveText(stackTrace) : null;
      this.db.prepare(`
        INSERT INTO system_error_logs (user_id, error_source, error_message, stack_trace, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId || null, errorSource, sanitizedMsg, sanitizedStack, severity, new Date().toISOString());
    } catch (e) {
      console.error('Failed to write to system_error_logs table:', e);
    }
  }

  private sanitizeSensitiveText(text: string): string {
    return text
      .replace(/pin["':\s]+[0-9]+/gi, 'pin: [REDACTED]')
      .replace(/token["':\s]+[a-f0-9]+/gi, 'token: [REDACTED]')
      .replace(/password["':\s]+[^\s,}]+/gi, 'password: [REDACTED]');
  }

  getErrorLogs(limit: number = 100): SystemErrorLog[] {
    try {
      return this.db.prepare(`
        SELECT sel.*, u.name as user_name
        FROM system_error_logs sel
        LEFT JOIN users u ON sel.user_id = u.id
        ORDER BY sel.id DESC
        LIMIT ?
      `).all(Math.min(Math.max(1, Math.floor(Number(limit)) || 100), 1000)) as any[];
    } catch {
      return [];
    }
  }

  clearErrorLogs(user: User): void {
    this.checkOwner(user);
    this.db.prepare("DELETE FROM system_error_logs").run();
    this.db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'ERROR_LOG_CLEAR', 'system', NULL, 'System error log cleared', ?)")
      .run(user.id, new Date().toISOString());
  }

  getAuditLogs(limit: number = 100): AuditLog[] {
    return this.db.prepare(`
      SELECT al.*, u.name as user_name
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.id DESC
      LIMIT ?
    `).all(Math.min(Math.max(1, Math.floor(Number(limit)) || 100), 1000)) as any[];
  }

  getSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  }

  /** Owner changes settings; only known keys with validated values are accepted. */
  updateSettings(user: User, settings: Record<string, string>): void {
    this.checkOwner(user);
    if (!settings || typeof settings !== 'object') throw new Error('პარამეტრები არასწორია');
    const clean: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(settings)) {
      const rule = SETTINGS_RULES[k];
      if (!rule) throw new Error(`უცნობი პარამეტრი: "${k}"`);
      clean.push([k, rule(String(v ?? ''))]);
    }
    runInTransaction((db) => {
      const stmt = db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");
      for (const [k, v] of clean) stmt.run(k, v);
      db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'SETTINGS_UPDATE', 'app_settings', NULL, ?, ?)")
        .run(user.id, `Updated: ${clean.map(([k]) => k).join(', ')}`, new Date().toISOString());
    }, this.db);
  }
}
