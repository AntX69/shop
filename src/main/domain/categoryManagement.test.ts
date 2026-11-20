import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { ProductsService } from './productsService.ts';
import { AuthService } from './authService.ts';
import { User } from '../../shared/types.ts';

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

test('Category Management: create with name and color, list with counts', () => {
  const db = createTestDb();
  const auth = new AuthService(db);
  const products = new ProductsService(db);

  const ownerSession = auth.setupInitialOwner('მფლობელი', '1234');
  const owner = ownerSession.user;

  // Create categories
  const cat1 = products.createCategory(owner, 'სასმელები', '#3b82f6');
  assert.equal(cat1.name, 'სასმელები');
  assert.equal(cat1.color, '#3b82f6');
  assert.equal(cat1.is_archived, 0);

  const cat2 = products.createCategory(owner, 'ტკბილეული');
  assert.equal(cat2.color, '#10b981'); // default emerald

  // Duplicate name rejected
  assert.throws(
    () => products.createCategory(owner, 'სასმელები'),
    /უკვე არსებობს/
  );

  // List categories
  const list = products.getCategories();
  assert.equal(list.length, 2);
  assert.equal(list.find(c => c.name === 'სასმელები')?.color, '#3b82f6');
});

test('Category Management: update name, change color and archive/restore', () => {
  const db = createTestDb();
  const auth = new AuthService(db);
  const products = new ProductsService(db);

  const owner = auth.setupInitialOwner('მფლობელი', '1234').user;
  const cat = products.createCategory(owner, 'ხილი', '#10b981');

  // Update name and color
  const updated = products.updateCategory(owner, cat.id, { name: 'ცოცხალი ხილი', color: '#f59e0b' });
  assert.equal(updated.name, 'ცოცხალი ხილი');
  assert.equal(updated.color, '#f59e0b');

  // Archive category
  const archived = products.setCategoryArchived(owner, cat.id, true);
  assert.equal(archived.is_archived, 1);

  // Standard getCategories excludes archived
  const activeList = products.getCategories({ includeArchived: false });
  assert.equal(activeList.length, 0);

  // With includeArchived shows it
  const fullList = products.getCategories({ includeArchived: true });
  assert.equal(fullList.length, 1);
  assert.equal(fullList[0].is_archived, 1);

  // Restore category
  const restored = products.setCategoryArchived(owner, cat.id, false);
  assert.equal(restored.is_archived, 0);
  assert.equal(products.getCategories().length, 1);
});

test('Category Management: safe deletion with product reassignment and rollback', () => {
  const db = createTestDb();
  const auth = new AuthService(db);
  const products = new ProductsService(db);

  const owner = auth.setupInitialOwner('მფლობელი', '1234').user;
  const oldCat = products.createCategory(owner, 'ძველი კატეგორია', '#64748b');
  const targetCat = products.createCategory(owner, 'ახალი კატეგორია', '#3b82f6');

  // Create product in oldCat
  const product = products.createProduct(owner, {
    name: 'სატესტო პროდუქტი',
    category_id: oldCat.id,
    base_price_tetri: 1500,
    variants: [
      {
        variant_name: 'სტანდარტული',
        codes: [{ code_type: 'manual_5digit', code_value: '20001' }],
        initial_stock: 10
      }
    ]
  });

  // Verify usage count
  const usageBefore = products.getCategoryUsage(oldCat.id);
  assert.equal(usageBefore.active_products_count, 1);
  assert.equal(usageBefore.total, 1);

  // Safe delete with reassignment to targetCat
  products.deleteCategory(owner, oldCat.id, targetCat.id);

  // oldCat deleted
  assert.equal((db.prepare('SELECT COUNT(*) as n FROM categories WHERE id = ?').get(oldCat.id) as any).n, 0);

  // Product was atomically reassigned to targetCat
  const updatedProduct = products.getProductById(product.id);
  assert.equal(updatedProduct?.category_id, targetCat.id);
  assert.equal(updatedProduct?.category_name, 'ახალი კატეგორია');
  assert.equal(updatedProduct?.category_color, '#3b82f6');

  // Safe delete with NULL (reassignToCategoryId = null)
  products.deleteCategory(owner, targetCat.id, null);
  const uncategorizedProduct = products.getProductById(product.id);
  assert.equal(uncategorizedProduct?.category_id, null);
  assert.equal(uncategorizedProduct?.category_name, null);
});

test('Category Management: unauthorized seller rejected', () => {
  const db = createTestDb();
  const auth = new AuthService(db);
  const products = new ProductsService(db);

  const owner = auth.setupInitialOwner('მფლობელი', '1234').user;
  const seller = auth.addUser(owner, 'გამყიდველი', '4321', 'seller');

  assert.throws(
    () => products.createCategory(seller, 'არალეგალური კატეგორია'),
    /მხოლოდ მფლობელს/
  );
  assert.throws(
    () => products.updateCategory(seller, 1, { name: 'შეცვლა' }),
    /მხოლოდ მფლობელს/
  );
  assert.throws(
    () => products.deleteCategory(seller, 1),
    /მხოლოდ მფლობელს/
  );
});
