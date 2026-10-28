/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Backup & System Settings Domain Service.
 * Allows store owner to export/import verified database backups,
 * view system audit trails, and manage store metadata.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, getDatabasePath, runInTransaction } from '../db/database.ts';
import { AuditLog, SystemErrorLog, User } from '../../shared/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface PosBackupBundle {
  format: 'StorePOS-Unified-Backup';
  version: '1.0';
  created_at: string;
  created_by_user_id: number;
  db_checksum_sha256: string;
  db_size_bytes: number;
  db_base64: string;
  images: Array<{ product_id: number; file_path: string; is_primary: number }>;
  settings: Record<string, string>;
  stats: {
    products_count: number;
    sales_count: number;
    customers_count: number;
  };
}

export class BackupService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  private checkOwner(user: User): void {
    if (user.role !== 'owner') {
      throw new Error('სარეზერვო ასლების მართვის უფლება აქვს მხოლოდ მფლობელს');
    }
  }

  /**
   * Creates a unified .posbackup bundle (SQLite database + product images + settings + integrity checksum).
   */
  createBackup(user: User): {
    backup_filename: string;
    size_bytes: number;
    checksum_sha256: string;
    created_at: string;
    data_base64: string;
  } {
    this.checkOwner(user);

    const dbPath = getDatabasePath();
    if (!fs.existsSync(dbPath)) {
      throw new Error('ბაზის ფაილი ვერ მოიძებნა');
    }

    // Force SQLite checkpoint so all WAL changes are flushed into main file
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

    const fileBuffer = fs.readFileSync(dbPath);
    const dbHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const now = new Date().toISOString();
    const timestamp = now.replace(/[:.]/g, '-');
    const filename = `store_backup_${timestamp}.posbackup`;

    // Fetch images and settings for unified bundle
    const images = this.db.prepare(
      "SELECT product_id, file_path, is_primary FROM product_images"
    ).all() as any[];

    const settings = this.getSettings();

    const productsCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM products").get() as any)?.cnt || 0;
    const salesCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM sales").get() as any)?.cnt || 0;
    const customersCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM customers").get() as any)?.cnt || 0;

    const bundle: PosBackupBundle = {
      format: 'StorePOS-Unified-Backup',
      version: '1.0',
      created_at: now,
      created_by_user_id: user.id,
      db_checksum_sha256: dbHash,
      db_size_bytes: fileBuffer.length,
      db_base64: fileBuffer.toString('base64'),
      images: images.map(img => ({
        product_id: img.product_id,
        file_path: img.file_path,
        is_primary: img.is_primary
      })),
      settings,
      stats: {
        products_count: productsCount,
        sales_count: salesCount,
        customers_count: customersCount
      }
    };

    const bundleJson = JSON.stringify(bundle, null, 2);
    const bundleBuffer = Buffer.from(bundleJson, 'utf-8');
    const bundleHash = crypto.createHash('sha256').update(bundleBuffer).digest('hex');

    this.db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
      VALUES (?, 'BACKUP_CREATE', 'system', ?, ?, ?)
    `).run(
      user.id,
      filename,
      `Created unified .posbackup bundle: DB ${fileBuffer.length} bytes (SHA256: ${dbHash}), ${images.length} images, ${productsCount} products.`,
      now
    );

    return {
      backup_filename: filename,
      size_bytes: bundleBuffer.length,
      checksum_sha256: bundleHash,
      created_at: now,
      data_base64: bundleBuffer.toString('base64')
    };
  }

  /**
   * Restores database from a verified backup buffer with PRAGMA integrity_check validation.
   */
  restoreBackup(user: User, dataString: string, expectedChecksum?: string): { success: boolean; message: string } {
    this.checkOwner(user);

    let rawBuffer: Buffer;
    let dbBuffer: Buffer;
    let bundleImages: Array<{ product_id: number; file_path: string; is_primary: number }> | null = null;
    let bundleSettings: Record<string, string> | null = null;

    // Check if input is base64
    const trimmed = dataString.trim();
    if (trimmed.startsWith('{')) {
      rawBuffer = Buffer.from(trimmed, 'utf-8');
    } else {
      rawBuffer = Buffer.from(trimmed, 'base64');
    }

    const calculatedBundleHash = crypto.createHash('sha256').update(rawBuffer).digest('hex');

    // Try parsing as unified PosBackupBundle
    try {
      const decodedText = rawBuffer.toString('utf-8');
      if (decodedText.includes('StorePOS-Unified-Backup')) {
        const bundle: PosBackupBundle = JSON.parse(decodedText);
        dbBuffer = Buffer.from(bundle.db_base64, 'base64');
        const calculatedDbHash = crypto.createHash('sha256').update(dbBuffer).digest('hex');
        if (bundle.db_checksum_sha256 && bundle.db_checksum_sha256 !== calculatedDbHash) {
          throw new Error('სარეზერვო ასლის შემოწმების შეცდომა: მონაცემთა ბაზის შიდა Checksum არ ემთხვევა');
        }
        bundleImages = bundle.images || [];
        bundleSettings = bundle.settings || null;
      } else {
        // Raw sqlite buffer
        dbBuffer = rawBuffer;
      }
    } catch {
      dbBuffer = rawBuffer;
    }

    if (expectedChecksum && expectedChecksum !== calculatedBundleHash) {
      // Check if expected checksum matches dbBuffer hash
      const dbHash = crypto.createHash('sha256').update(dbBuffer).digest('hex');
      if (expectedChecksum !== dbHash) {
        throw new Error('სარეზერვო ასლის შემოწმების შეცდომა: Checksum არ ემთხვევა (დაზიანებული ფაილი)');
      }
    }

    const dbPath = getDatabasePath();
    const candidatePath = `${dbPath}.candidate_${Date.now()}.db`;
    const safetyBackupPath = `${dbPath}.before_restore_${Date.now()}`;

    // 1. Write candidate database file
    fs.writeFileSync(candidatePath, dbBuffer);

    // 2. Perform PRAGMA integrity_check on candidate database
    try {
      const candidateDb = new DatabaseSync(candidatePath);
      const row = candidateDb.prepare("PRAGMA integrity_check;").get() as any;
      candidateDb.close();

      if (!row || row.integrity_check !== 'ok') {
        if (fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath);
        throw new Error(`ბაზის ფაილი დაზიანებულია: PRAGMA integrity_check = ${row?.integrity_check || 'fail'}`);
      }
    } catch (checkErr: any) {
      if (fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath);
      throw new Error(`სარეზერვო ასლის შემოწმება ჩაიშალა: ${checkErr.message}`);
    }

    // 3. Create safety copy of current active database
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, safetyBackupPath);
    }

    // 4. Overwrite active database file
    try {
      fs.copyFileSync(candidatePath, dbPath);
      if (fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath);

      // Re-run WAL checkpoint on newly restored db
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

      // Audit log restore
      this.db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'BACKUP_RESTORE', 'system', ?, ?, ?)
      `).run(user.id, 'store.db', `Restored database snapshot successfully. Safety backup: ${safetyBackupPath}`, new Date().toISOString());

      return {
        success: true,
        message: 'ბაზა წარმატებით შემოწმდა (PRAGMA integrity_check: OK) და აღდგა ერთიანი სარეზერვო ასლიდან.'
      };
    } catch (writeErr: any) {
      if (fs.existsSync(safetyBackupPath)) {
        fs.copyFileSync(safetyBackupPath, dbPath);
      }
      throw new Error(`აღდგენის შეცდომა: ${writeErr.message}`);
    }
  }

  /**
   * Logs an internal system error or exception.
   */
  logSystemError(
    errorSource: string,
    errorMessage: string,
    stackTrace?: string,
    severity: 'error' | 'warning' | 'critical' = 'error',
    userId?: number
  ): void {
    try {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO system_error_logs (user_id, error_source, error_message, stack_trace, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId || null, errorSource, errorMessage, stackTrace || null, severity, now);
    } catch (e) {
      console.error('Failed to write to system_error_logs table:', e);
    }
  }

  /**
   * Retrieves recent system error logs.
   */
  getErrorLogs(limit: number = 100): SystemErrorLog[] {
    try {
      return this.db.prepare(`
        SELECT sel.*, u.name as user_name
        FROM system_error_logs sel
        LEFT JOIN users u ON sel.user_id = u.id
        ORDER BY sel.id DESC
        LIMIT ?
      `).all(limit) as any[];
    } catch {
      return [];
    }
  }

  /**
   * Clears error logs (Owner only).
   */
  clearErrorLogs(user: User): void {
    this.checkOwner(user);
    this.db.prepare("DELETE FROM system_error_logs").run();
  }

  /**
   * Retrieves audit log history.
   */
  getAuditLogs(limit: number = 100): AuditLog[] {
    return this.db.prepare(`
      SELECT al.*, u.name as user_name
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.id DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  /**
   * Gets app settings.
   */
  getSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  }

  /**
   * Updates store settings (Owner only).
   */
  updateSettings(user: User, settings: Record<string, string>): void {
    this.checkOwner(user);
    runInTransaction((db) => {
      const stmt = db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");
      for (const [k, v] of Object.entries(settings)) {
        stmt.run(k, String(v));
      }
    }, this.db);
  }
}
