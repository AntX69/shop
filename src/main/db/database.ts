/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * SQLite Database Connection and Lifecycle Management.
 * Runs in Node.js (Electron main process, server, and tests).
 * Enforces PRAGMA foreign_keys = ON and PRAGMA journal_mode = WAL.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { runMigrations } from './migrations.ts';

let dbInstance: DatabaseSync | null = null;
let currentDbPath: string = '';

export function getDataDirectory(): string {
  if (process.env.STORE_DATA_DIR) {
    const dir = path.resolve(process.env.STORE_DATA_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (process.env.STORE_DB_PATH && process.env.STORE_DB_PATH !== ':memory:') {
    const dir = path.dirname(path.resolve(process.env.STORE_DB_PATH));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  // If APPDATA is present (Windows Desktop environment)
  if (process.env.APPDATA) {
    const dir = path.join(process.env.APPDATA, 'StorePOS');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  // Default to local ./data folder
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

export function getImagesDirectory(): string {
  const dir = path.join(getDataDirectory(), 'images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getBackupsDirectory(): string {
  const dir = path.join(getDataDirectory(), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDatabasePath(): string {
  if (process.env.STORE_DB_PATH) {
    return process.env.STORE_DB_PATH;
  }
  return path.join(getDataDirectory(), 'store.db');
}

export function initDatabase(customPath?: string): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = customPath || getDatabasePath();
  currentDbPath = dbPath;

  if (dbPath !== ':memory:') {
    const parentDir = path.dirname(dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Set production reliability and integrity PRAGMAs
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
    // In desktop POS with financial transactions and cash drawers, synchronous = FULL
    // guarantees immediate fsync on WAL commit, eliminating transaction loss during sudden power outages.
    const syncMode = process.env.SQLITE_SYNCHRONOUS || 'FULL';
    db.exec(`PRAGMA synchronous = ${syncMode};`);
  }

  // Run schema migrations with safety pre-backup
  runMigrations(db, dbPath);

  dbInstance = db;
  return dbInstance;
}

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}
    dbInstance.close();
    dbInstance = null;
  }
}

let txDepth = 0;

/**
 * Executes a function inside a transaction.
 * Supports nesting via SQLite SAVEPOINTS.
 * Rolls back automatically if an error is thrown.
 */
export function runInTransaction<T>(fn: (db: DatabaseSync) => T, db: DatabaseSync = getDb()): T {
  const isTopLevel = txDepth === 0;
  txDepth++;
  const spName = `sp_${txDepth}`;
  try {
    if (isTopLevel) {
      db.exec('BEGIN IMMEDIATE;');
    } else {
      db.exec(`SAVEPOINT ${spName};`);
    }
    const result = fn(db);
    if (isTopLevel) {
      db.exec('COMMIT;');
    } else {
      db.exec(`RELEASE SAVEPOINT ${spName};`);
    }
    return result;
  } catch (error) {
    if (isTopLevel) {
      try { db.exec('ROLLBACK;'); } catch {}
    } else {
      try { db.exec(`ROLLBACK TO SAVEPOINT ${spName};`); } catch {}
    }
    throw error;
  } finally {
    txDepth--;
  }
}
