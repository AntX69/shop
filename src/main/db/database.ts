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

export function getDatabasePath(): string {
  if (process.env.STORE_DB_PATH) {
    return process.env.STORE_DB_PATH;
  }
  // In development or local server, save inside ./data directory
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'store.db');
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

  // Set performance and integrity PRAGMAs
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  // Run schema migrations
  runMigrations(db);

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
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Executes a function inside an immediate transaction.
 * Rolls back automatically if an error is thrown.
 */
export function runInTransaction<T>(fn: (db: DatabaseSync) => T, db: DatabaseSync = getDb()): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}
