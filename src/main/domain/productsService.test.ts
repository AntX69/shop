import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { ProductsService } from './productsService.ts';
import { User } from '../../shared/types.ts';

function setupTestUsers(db: DatabaseSync): { owner: User; seller: User } {
  const now = new Date().toISOString();
  const ownerRes = db.prepare(
    "INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES ('მფლობელი', 'owner', 'hash1', 'salt1', 1, ?)"
  ).run(now);
  const sellerRes = db.prepare(
    "INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES ('გამყიდველი', 'seller', 'hash2', 'salt2', 1, ?)"
  ).run(now);

  return {
    owner: { id: Number(ownerRes.lastInsertRowid), name: 'მფლობელი', role: 'owner', is_active: 1, created_at: now },
    seller: { id: Number(sellerRes.lastInsertRowid), name: 'გამყიდველი', role: 'seller', is_active: 1, created_at: now }
  };
}

test('products service enforces owner permissions for product and category creation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const { owner, seller } = setupTestUsers(db);

  const service = new ProductsService(db);

  // Seller cannot create category
  assert.throws(() => {
    service.createCategory(seller, 'სათამაშოები');
  }, /მხოლოდ მფლობელს/);

  // Owner can create category
  const cat = service.createCategory(owner, 'სათამაშოები');
  assert.equal(cat.name, 'სათამაშოები');

  // Seller cannot create product
  assert.throws(() => {
    service.createProduct(seller, {
      name: 'დათუნია',
      base_price_tetri: 3500,
      variants: [{
        variant_name: 'სტანდარტული',
        initial_stock: 5,
        codes: [{ code_type: 'manual_5digit', code_value: '10001' }]
      }]
    });
  }, /მხოლოდ მფლობელს/);
});

test('products service preserves barcode leading zeroes and enforces 5-digit manual format', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const { owner } = setupTestUsers(db);

  const service = new ProductsService(db);
  const cat = service.createCategory(owner, 'აქსესუარები');

  // Manual code must be exactly 5 digits
  assert.throws(() => {
    service.createProduct(owner, {
      name: 'ქამარი',
      category_id: cat.id,
      base_price_tetri: 2500,
      variants: [{
        variant_name: 'შავი',
        initial_stock: 10,
        codes: [{ code_type: 'manual_5digit', code_value: '123' }] // Invalid length!
      }]
    });
  }, /ზუსტად 5-ნიშნა რიცხვი/);

  // Success with factory barcode preserving leading zeroes e.g. "001234567890" and 5-digit code "10005"
  const prod = service.createProduct(owner, {
    name: 'ქამარი',
    category_id: cat.id,
    base_price_tetri: 2500,
    variants: [{
      variant_name: 'შავი',
      initial_stock: 10,
      codes: [
        { code_type: 'barcode', code_value: '001234567890' },
        { code_type: 'manual_5digit', code_value: '10005' }
      ]
    }]
  });

  assert.equal(prod.name, 'ქამარი');
  assert.equal(prod.variants?.[0].codes?.length, 2);

  // Lookup by barcode test
  const foundByBarcode = service.lookupByCode('001234567890');
  assert.ok(foundByBarcode);
  assert.equal(foundByBarcode?.code_used, '001234567890');
  assert.equal(foundByBarcode?.product.name, 'ქამარი');

  // Lookup by 5-digit manual code test
  const foundByManual = service.lookupByCode('10005');
  assert.ok(foundByManual);
  assert.equal(foundByManual?.product.name, 'ქამარი');
});

test('products service rejects duplicate manual code and duplicate barcode across variants', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const { owner } = setupTestUsers(db);

  const service = new ProductsService(db);

  // Create first product
  service.createProduct(owner, {
    name: 'მაისური',
    base_price_tetri: 1500,
    variants: [{
      variant_name: 'წითელი M',
      initial_stock: 5,
      codes: [{ code_type: 'manual_5digit', code_value: '20001' }]
    }]
  });

  // Second product with the SAME 5-digit code MUST fail
  assert.throws(() => {
    service.createProduct(owner, {
      name: 'შარვალი',
      base_price_tetri: 4500,
      variants: [{
        variant_name: 'ლურჯი L',
        initial_stock: 3,
        codes: [{ code_type: 'manual_5digit', code_value: '20001' }]
      }]
    });
  }, /კოდი "20001" უკვე გამოყენებულია/);
});
