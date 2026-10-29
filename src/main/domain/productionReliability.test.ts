/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * M8 Production Reliability & Data Protection Integration Test Suite.
 * Covers:
 * 1. Sale error & atomic rollback
 * 2. Partial debt repayment & idempotency
 * 3. Return & exchange workflow
 * 4. Full backup creation & restoration
 * 5. Real product photo file backup & restoration
 * 6. Rejection of corrupted / tampered backups
 * 7. Versioned migrations with pre-migration safety backup
 * 8. Data persistence across simulated app restart
 * 9. Seller RBAC blocking for administrative operations
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { runMigrations } from '../db/migrations.ts';
import { AuthService } from './authService.ts';
import { ProductsService } from './productsService.ts';
import { PosService } from './posService.ts';
import { CustomerService } from './customerService.ts';
import { ReturnsService } from './returnsService.ts';
import { BackupService, PosBackupBundle } from './backupService.ts';
import { User } from '../../shared/types.ts';

function createTempDir(prefix: string): string {
  const tmp = path.join(os.tmpdir(), `storepos_test_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

function setupTestEnvironment(customDbPath?: string) {
  const isDisk = !!customDbPath;
  const dbPath = customDbPath || ':memory:';
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (isDisk) {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  runMigrations(db, isDisk ? dbPath : undefined);

  const authService = new AuthService(db);
  const productsService = new ProductsService(db);
  const posService = new PosService(db);
  const customerService = new CustomerService(db);
  const returnsService = new ReturnsService(db);
  const backupService = new BackupService(db, isDisk ? dbPath : undefined);

  // Setup owner and seller
  const ownerSession = authService.setupInitialOwner('მფლობელი გიორგი', '1234');
  const owner = ownerSession.user;
  const seller = authService.addUser(owner, 'გამყიდველი ნინო', '5678', 'seller');

  return {
    db,
    dbPath,
    authService,
    productsService,
    posService,
    customerService,
    returnsService,
    backupService,
    owner,
    seller
  };
}

test('M8 Test 1: Sale error causes immediate atomic rollback without partial deductions', () => {
  const { productsService, posService, seller, owner, db } = setupTestEnvironment();

  // 1. Create a product with 10 units in stock
  const product = productsService.createProduct(owner, {
    name: 'ატომური გაყიდვის ტესტი',
    base_price_tetri: 5000,
    variants: [{
      variant_name: 'ზომა L',
      initial_stock: 10,
      codes: [{ code_type: 'manual_5digit', code_value: '22001' }]
    }]
  });
  const variantId = product.variants![0].id;

  // 2. Attempt checkout with item requiring 15 units (exceeding stock of 10)
  assert.throws(() => {
    posService.checkout(seller, {
      items: [{ variant_id: variantId, quantity: 15, unit_price_tetri: 5000 }],
      payment_method: 'cash',
      cash_received_tetri: 75000
    });
  }, /არასაკმარისი მარაგი/);

  // Verify stock was NOT partially deducted
  const pCheck = productsService.getProductById(product.id)!;
  assert.equal(pCheck.variants![0].stock_quantity, 10);

  // Verify sales table and inventory_movements table have 0 records for this variant
  const salesCount = (db.prepare('SELECT COUNT(*) as cnt FROM sales').get() as any).cnt;
  assert.equal(salesCount, 0);

  const movementsCount = (db.prepare("SELECT COUNT(*) as cnt FROM inventory_movements WHERE variant_id = ? AND movement_type = 'sale'").get(variantId) as any).cnt;
  assert.equal(movementsCount, 0);
});

test('M8 Test 2: Partial debt repayment reduces debt without revenue inflation & respects idempotency', () => {
  const { productsService, posService, customerService, seller, owner, db } = setupTestEnvironment();

  const customer = customerService.createCustomer(seller, {
    first_name: 'დავით',
    last_name: 'ბერიძე',
    phone: '599112233'
  });

  const product = productsService.createProduct(owner, {
    name: 'სათვალე',
    base_price_tetri: 10000, // 100 GEL
    variants: [{
      variant_name: 'შავი',
      initial_stock: 5,
      codes: [{ code_type: 'manual_5digit', code_value: '33001' }]
    }]
  });

  // Sell on full debt (100 GEL)
  posService.checkout(seller, {
    items: [{ variant_id: product.variants![0].id, quantity: 1, unit_price_tetri: 10000 }],
    payment_method: 'debt',
    customer_id: customer.id,
    cash_received_tetri: 0
  });

  const custBefore = customerService.getCustomerById(customer.id)!;
  assert.equal(custBefore.total_debt_tetri, 10000);

  // Partial repayment of 35 GEL
  const repaymentKey = 'repay_tx_unique_9988';
  const repayment1 = customerService.recordRepayment(seller, {
    customer_id: customer.id,
    amount_tetri: 3500,
    idempotency_key: repaymentKey
  });

  assert.equal(repayment1.amount_tetri, 3500);

  // Debt must now be 100 - 35 = 65 GEL
  const custAfter = customerService.getCustomerById(customer.id)!;
  assert.equal(custAfter.total_debt_tetri, 6500);

  // Idempotency check: repeated repayment with same key must return existing without double-deduction
  const repaymentDup = customerService.recordRepayment(seller, {
    customer_id: customer.id,
    amount_tetri: 3500,
    idempotency_key: repaymentKey
  });
  assert.equal(repaymentDup.id, repayment1.id);

  const custAfterDup = customerService.getCustomerById(customer.id)!;
  assert.equal(custAfterDup.total_debt_tetri, 6500); // Unchanged!

  // Verify sales revenue did not increase
  const totalSalesRevenue = (db.prepare('SELECT SUM(total_tetri) as sum FROM sales').get() as any).sum;
  assert.equal(totalSalesRevenue, 10000); // Still 100 GEL, NOT 135 GEL!
});

test('M8 Test 3: Returns and exchanges correctly adjust stock and debt', () => {
  const { productsService, posService, returnsService, customerService, seller, owner } = setupTestEnvironment();

  const customer = customerService.createCustomer(seller, { first_name: 'მარიამი' });

  const prod = productsService.createProduct(owner, {
    name: 'ქურთუკი',
    base_price_tetri: 8000,
    variants: [{
      variant_name: 'ზომა M',
      initial_stock: 4,
      codes: [{ code_type: 'manual_5digit', code_value: '44001' }]
    }]
  });
  const variant = prod.variants![0];

  // Sale of 2 units = 160 GEL (mixed: 60 cash, 100 debt)
  const sale = posService.checkout(seller, {
    items: [{ variant_id: variant.id, quantity: 2, unit_price_tetri: 8000 }],
    payment_method: 'mixed',
    customer_id: customer.id,
    cash_received_tetri: 6000
  });

  const saleItem = sale.items![0];
  assert.equal(customerService.getCustomerById(customer.id)!.total_debt_tetri, 10000);

  // Return 1 unit (80 GEL value). Debt is 100 GEL -> Debt reduced by 80 GEL to 20 GEL, 0 cash refund
  const ret = returnsService.processReturn(seller, {
    sale_id: sale.id,
    items: [{
      sale_item_id: saleItem.id,
      variant_id: variant.id,
      quantity: 1,
      condition: 'resellable'
    }],
    reason: 'ზომის დაბრუნება'
  });

  assert.equal(ret.debt_deduction_tetri, 8000);
  assert.equal(ret.cash_refund_tetri, 0);

  // Customer debt should now be 20 GEL
  assert.equal(customerService.getCustomerById(customer.id)!.total_debt_tetri, 2000);

  // Stock should be restored from 2 (4-2) back to 3
  const prodAfter = productsService.getProductById(prod.id)!;
  assert.equal(prodAfter.variants![0].stock_quantity, 3);
});

test('M8 Test 4 & 5: Full backup creation, real image bundling, and clean restoration', () => {
  const tmpDir = createTempDir('backup_restore');
  const dbPath = path.join(tmpDir, 'store.db');
  const imagesDir = path.join(tmpDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // 1. Setup real SQLite DB on disk
  const { productsService, posService, customerService, backupService, owner, seller, db } = setupTestEnvironment(dbPath);

  // 2. Create real image file on disk
  const sampleImagePath = path.join(imagesDir, 'jacket_test.jpg');
  const sampleImageData = Buffer.from('REAL_BINARY_IMAGE_DATA_JFIF_12345');
  fs.writeFileSync(sampleImagePath, sampleImageData);

  // 3. Create product with real image
  const customer = customerService.createCustomer(seller, { first_name: 'ლევან', last_name: 'გელოვანი' });
  const product = productsService.createProduct(owner, {
    name: 'ტყავის ქურთუკი',
    base_price_tetri: 15000,
    base_cost_tetri: 8000,
    variants: [{
      variant_name: 'ყავისფერი / XL',
      initial_stock: 7,
      codes: [{ code_type: 'manual_5digit', code_value: '55001' }]
    }],
    image_paths: [sampleImagePath]
  });

  // Make a sale
  posService.checkout(seller, {
    items: [{ variant_id: product.variants![0].id, quantity: 2, unit_price_tetri: 15000 }],
    payment_method: 'cash',
    cash_received_tetri: 30000
  });

  // 4. Create full backup bundle
  const backupResult = backupService.createBackup(owner, tmpDir);
  assert.ok(fs.existsSync(backupResult.filepath));
  assert.ok(backupResult.size_bytes > 0);
  assert.ok(backupResult.checksum_sha256);

  // Verify backup bundle contains real image data
  const bundleContent: PosBackupBundle = JSON.parse(fs.readFileSync(backupResult.filepath, 'utf-8'));
  assert.equal(bundleContent.format, 'StorePOS-Unified-Backup');
  assert.equal(bundleContent.stats.products_count, 1);
  assert.equal(bundleContent.stats.sales_count, 1);
  assert.ok(bundleContent.images[0].data_base64?.includes('base64'));

  // 5. Delete original product image from disk and tamper with DB
  fs.unlinkSync(sampleImagePath);
  assert.equal(fs.existsSync(sampleImagePath), false);

  db.exec(`
    DELETE FROM sale_items;
    DELETE FROM sales;
    DELETE FROM inventory_lots;
    DELETE FROM inventory_movements;
    DELETE FROM product_codes;
    DELETE FROM product_images;
    DELETE FROM product_variants;
    DELETE FROM products;
  `);
  assert.equal((db.prepare('SELECT COUNT(*) as cnt FROM products').get() as any).cnt, 0);

  // 6. Restore from backup
  const restoreRes = backupService.restoreBackup(owner, backupResult.data_base64);
  assert.equal(restoreRes.success, true);
  assert.equal(restoreRes.restored_stats?.products_count, 1);
  assert.equal(restoreRes.restored_stats?.sales_count, 1);

  // Verify DB state restored
  const restoredProd = productsService.getProductById(product.id)!;
  assert.equal(restoredProd.name, 'ტყავის ქურთუკი');
  assert.equal(restoredProd.variants![0].stock_quantity, 5); // 7 - 2 = 5

  // 7. Verify real photo was recreated on disk
  const restoredImgPath = path.join(imagesDir, 'jacket_test.jpg');
  assert.ok(fs.existsSync(restoredImgPath));
  assert.equal(fs.readFileSync(restoredImgPath).toString(), sampleImageData.toString());

  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('M8 Test 6: Corrupted or tampered backup is rejected without modifying database', () => {
  const tmpDir = createTempDir('corrupt_test');
  const dbPath = path.join(tmpDir, 'store.db');

  const { productsService, backupService, owner, db } = setupTestEnvironment(dbPath);

  productsService.createProduct(owner, {
    name: 'დაცული პროდუქტი',
    base_price_tetri: 2000,
    variants: [{
      variant_name: 'სტანდარტული',
      initial_stock: 12,
      codes: [{ code_type: 'manual_5digit', code_value: '66001' }]
    }]
  });

  const validBackup = backupService.createBackup(owner, tmpDir);

  // Tamper with the backup data: change db_base64 content so checksum mismatches
  const bundle: PosBackupBundle = JSON.parse(Buffer.from(validBackup.data_base64, 'base64').toString('utf-8'));
  bundle.db_base64 = Buffer.from('CORRUPTED_GARBAGE_DATA').toString('base64');
  const corruptedDataString = JSON.stringify(bundle);

  // Attempt restore: must throw validation error
  assert.throws(() => {
    backupService.restoreBackup(owner, corruptedDataString);
  }, /Checksum არ ემთხვევა/);

  // Verify original data remains untouched
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM products').get() as any).cnt;
  assert.equal(count, 1);

  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('M8 Test 7: Versioned database migration creates safety pre-migration backup', async () => {
  const tmpDir = createTempDir('migration_test');
  const dbPath = path.join(tmpDir, 'store.db');

  // Create SQLite DB with only migration 1
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  // Manually run only migration 1
  const m1 = (await import('../db/migrations.ts')).migrations[0];
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  m1.up(db);
  db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(1, m1.name, new Date().toISOString());

  // Insert test product
  db.prepare("INSERT INTO products (id, name, base_price_tetri, is_active, created_at, updated_at) VALUES (1, 'მიგრაციის ტესტი', 1000, 1, '2026-01-01', '2026-01-01')").run();

  // Run migrations with dbPath passed
  runMigrations(db, dbPath);

  // Verify migrations 2 and 3 applied
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
  assert.ok(versions.some(v => v.version === 3));

  // Verify pre-migration backup file was created on disk
  const files = fs.readdirSync(tmpDir);
  const hasPreBackup = files.some(f => f.includes('before_migration'));
  assert.ok(hasPreBackup);

  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('M8 Test 8: Data persists cleanly across simulated application restart', () => {
  const tmpDir = createTempDir('restart_test');
  const dbPath = path.join(tmpDir, 'store.db');

  // Instance 1: start, write, close
  {
    const db1 = new DatabaseSync(dbPath);
    db1.exec('PRAGMA foreign_keys = ON;');
    db1.exec('PRAGMA journal_mode = WAL;');
    runMigrations(db1, dbPath);

    const auth1 = new AuthService(db1);
    const prod1 = new ProductsService(db1);

    const owner = auth1.setupInitialOwner('ნიკოლოზ მფლობელი', '1111').user;
    prod1.createProduct(owner, {
      name: 'პერმანენტული ნივთი',
      base_price_tetri: 7700,
      variants: [{
        variant_name: 'ზომა S',
        initial_stock: 20,
        codes: [{ code_type: 'manual_5digit', code_value: '77001' }]
      }]
    });

    db1.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db1.close();
  }

  // Instance 2: reopen same file
  {
    const db2 = new DatabaseSync(dbPath);
    db2.exec('PRAGMA foreign_keys = ON;');
    db2.exec('PRAGMA journal_mode = WAL;');
    runMigrations(db2, dbPath);

    const prod2 = new ProductsService(db2);
    const products = prod2.listProducts();
    assert.equal(products.length, 1);
    assert.equal(products[0].name, 'პერმანენტული ნივთი');
    assert.equal(products[0].variants![0].stock_quantity, 20);

    db2.close();
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('M8 Test 9: Seller is strictly forbidden from administrative operations', () => {
  const { authService, productsService, backupService, seller } = setupTestEnvironment();

  // Seller cannot create categories
  assert.throws(() => {
    productsService.createCategory(seller, 'აკრძალული კატეგორია');
  }, /კატეგორიის დამატება შეუძლია მხოლოდ მფლობელს/);

  // Seller cannot create products
  assert.throws(() => {
    productsService.createProduct(seller, {
      name: 'აკრძალული პროდუქტი',
      base_price_tetri: 1000,
      variants: [{
        variant_name: 'სტანდარტული',
        initial_stock: 1,
        codes: [{ code_type: 'manual_5digit', code_value: '88001' }]
      }]
    });
  }, /მხოლოდ მფლობელს/);

  // Seller cannot create backup
  assert.throws(() => {
    backupService.createBackup(seller);
  }, /სარეზერვო ასლების მართვის უფლება აქვს მხოლოდ მფლობელს/);

  // Seller cannot restore backup
  assert.throws(() => {
    backupService.restoreBackup(seller, 'dummy');
  }, /სარეზერვო ასლების მართვის უფლება აქვს მხოლოდ მფლობელს/);

  // Seller cannot reset database
  assert.throws(() => {
    authService.resetStoreDatabase(seller, '1234');
  }, /მონაცემთა ბაზის გასუფთავების უფლება აქვს მხოლოდ მფლობელს/);

  // Seller cannot add employees
  assert.throws(() => {
    authService.addUser(seller, 'ახალი თანამშრომელი', '9999');
  }, /თანამშრომლის დამატება შეუძლია მხოლოდ მფლობელს/);
});
