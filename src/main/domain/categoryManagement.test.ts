/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Category management: create, rename, colour, archive, duplicates (ignoring letter case),
 * safe deletion (mandatory target when products exist, one transaction, real rollback), sales
 * history untouched, and sellers refused both in the service and through IPC.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { ProductsService, normalizeCategoryColor, normalizeCategoryName, categoryNameKey } from './productsService.ts';
import { AuthService } from './authService.ts';
import { PosService } from './posService.ts';
import { handleIpcMessage } from '../ipc/handlers.ts';
import { initDatabase, closeDatabase } from '../db/database.ts';

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

function setup() {
  const db = createTestDb();
  const auth = new AuthService(db);
  const products = new ProductsService(db);
  const owner = auth.setupInitialOwner('მფლობელი', '1234').user;
  return { db, auth, products, owner };
}

let codeSeq = 30000;
function addProduct(products: ProductsService, owner: any, categoryId: number | null, name = 'პროდუქტი') {
  return products.createProduct(owner, {
    name,
    category_id: categoryId,
    base_price_tetri: 1500,
    base_cost_tetri: 800,
    variants: [{ variant_name: 'სტანდარტული', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: String(++codeSeq) }] }],
  });
}
const count = (db: DatabaseSync, sql: string, ...args: any[]) => Number((db.prepare(sql).get(...args) as any).n);

test('create: name and colour stored, default colour, list with counts', () => {
  const { products, owner } = setup();
  const drinks = products.createCategory(owner, 'სასმელები', '#3B82F6');
  assert.equal(drinks.name, 'სასმელები');
  assert.equal(drinks.color, '#3b82f6', 'stored in lower case');
  const sweets = products.createCategory(owner, '  ტკბილეული  ');
  assert.equal(sweets.name, 'ტკბილეული', 'trimmed');
  assert.equal(sweets.color, '#10b981', 'default colour when none is given');
  addProduct(products, owner, drinks.id);
  const list = products.getCategories();
  assert.equal(list.length, 2);
  assert.equal(list.find((c) => c.id === drinks.id)?.products_count, 1);
});

test('names: empty, too long and control characters are refused', () => {
  const { products, owner } = setup();
  assert.throws(() => products.createCategory(owner, ''), /სავალდებულოა/);
  assert.throws(() => products.createCategory(owner, '    '), /სავალდებულოა/);
  assert.throws(() => products.createCategory(owner, 'ა'.repeat(61)), /ძალიან გრძელია/);
  assert.equal(products.createCategory(owner, 'ა'.repeat(60)).name.length, 60);
  assert.throws(() => products.createCategory(owner, 'ა\u0000ბ'), /დაუშვებელ/);
  assert.throws(() => products.createCategory(owner, 42 as any), /სავალდებულოა/);
  assert.equal(normalizeCategoryName('ხილი   და   ბოსტნეული'), 'ხილი და ბოსტნეული', 'inner spaces collapsed');
});

test('duplicates are refused ignoring letter case and spacing (also Georgian Mtavruli)', () => {
  const { products, owner } = setup();
  const toys = products.createCategory(owner, 'Toys');
  assert.throws(() => products.createCategory(owner, 'toys'), /უკვე არსებობს/);
  assert.throws(() => products.createCategory(owner, '  TOYS '), /უკვე არსებობს/);
  products.createCategory(owner, 'სასმელები');
  assert.throws(() => products.createCategory(owner, 'ᲡᲐᲡᲛᲔᲚᲔᲑᲘ'), /უკვე არსებობს/, 'Mtavruli capitals = the same name');
  const other = products.createCategory(owner, 'Shoes');
  assert.throws(() => products.updateCategory(owner, other.id, { name: 'TOYS' }), /უკვე არსებობს/, 'rename into another name');
  const renamed = products.updateCategory(owner, toys.id, { name: 'TOYS' });
  assert.equal(renamed.name, 'TOYS', 'changing the case of its own name is allowed');
  // An archived category still owns its name.
  products.setCategoryArchived(owner, other.id, true);
  assert.throws(() => products.createCategory(owner, 'shoes'), /უკვე არსებობს/);
  assert.equal(categoryNameKey(' Ab  C '), 'ab c');
});

test('colours: invalid colours are refused (never silently replaced), short form expanded', () => {
  const { products, owner } = setup();
  for (const bad of ['red', '#12345', '#ggg', '10b981', '#10b9811', ' ', 12]) {
    assert.throws(() => products.createCategory(owner, `კატ ${String(bad)}`, bad as any), /ფერი არასწორია/, String(bad));
  }
  const cat = products.createCategory(owner, 'ხილი', '#ABC');
  assert.equal(cat.color, '#aabbcc');
  assert.throws(() => products.updateCategory(owner, cat.id, { color: 'blue' }), /ფერი არასწორია/);
  assert.throws(() => products.updateCategory(owner, cat.id, { color: '' }), /ფერი არასწორია/);
  assert.equal(products.getCategories().find((c) => c.id === cat.id)?.color, '#aabbcc', 'unchanged after refused update');
  assert.equal(normalizeCategoryColor('#F59E0B'), '#f59e0b');
});

test('rename and recolour persist; archive hides from the list and restore brings it back', () => {
  const { products, owner } = setup();
  const cat = products.createCategory(owner, 'ხილი', '#10b981');
  products.updateCategory(owner, cat.id, { name: 'ცოცხალი ხილი', color: '#f59e0b' });
  const stored = products.getCategories({ includeArchived: true }).find((c) => c.id === cat.id)!;
  assert.equal(stored.name, 'ცოცხალი ხილი');
  assert.equal(stored.color, '#f59e0b');
  products.setCategoryArchived(owner, cat.id, true);
  assert.equal(products.getCategories().length, 0);
  assert.equal(products.getCategories({ includeArchived: true })[0].is_archived, 1);
  products.setCategoryArchived(owner, cat.id, false);
  assert.equal(products.getCategories().length, 1);
});

test('a product cannot be put into an archived category', () => {
  const { products, owner } = setup();
  const live = products.createCategory(owner, 'აქტიური');
  const old = products.createCategory(owner, 'ძველი');
  products.setCategoryArchived(owner, old.id, true);
  assert.throws(() => addProduct(products, owner, old.id), /დაარქივებულია/);
  const p = addProduct(products, owner, live.id);
  assert.throws(() => products.updateProduct(owner, { productId: p.id, category_id: old.id } as any), /დაარქივებულია/);
  assert.equal(products.getProductById(p.id)?.category_id, live.id);
});

test('delete: an empty category is deleted without choosing a target', () => {
  const { db, products, owner } = setup();
  const cat = products.createCategory(owner, 'ცარიელი');
  const res = products.deleteCategory(owner, cat.id);
  assert.deepEqual(res, { deleted: true, moved_products: 0, reassigned_to_category_id: null });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM categories WHERE id = ?', cat.id), 0);
});

test('delete: with products (archived ones too) a target is mandatory; nothing changes without it', () => {
  const { db, products, owner } = setup();
  const cat = products.createCategory(owner, 'ძველი');
  const target = products.createCategory(owner, 'ახალი');
  const active = addProduct(products, owner, cat.id, 'აქტიური');
  const archived = addProduct(products, owner, cat.id, 'დაარქივებული');
  products.setProductActive(owner, archived.id, false);

  assert.throws(() => products.deleteCategory(owner, cat.id), /2 პროდუქტი/);
  assert.throws(() => products.deleteCategory(owner, cat.id, null), /აირჩიეთ კატეგორია/);
  assert.throws(() => products.deleteCategory(owner, cat.id, cat.id), /იმავე კატეგორიაში/);
  assert.throws(() => products.deleteCategory(owner, cat.id, 99999), /ვერ მოიძებნა/);
  products.setCategoryArchived(owner, target.id, true);
  assert.throws(() => products.deleteCategory(owner, cat.id, target.id), /დაარქივებულია/);
  products.setCategoryArchived(owner, target.id, false);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM categories WHERE id = ?', cat.id), 1, 'still there after refusals');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE category_id = ?', cat.id), 2);

  const res = products.deleteCategory(owner, cat.id, target.id);
  assert.equal(res.moved_products, 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM categories WHERE id = ?', cat.id), 0);
  assert.equal(products.getProductById(active.id)?.category_id, target.id);
  assert.equal(products.getProductById(archived.id, { includeArchived: true })?.category_id, target.id, 'archived products move too');
  const auditRow = db.prepare("SELECT details FROM audit_logs WHERE action = 'CATEGORY_DELETE' ORDER BY id DESC LIMIT 1").get() as any;
  assert.match(auditRow.details, /"products_reassigned":2/);
});

test('delete: a failure after the products were moved rolls everything back', () => {
  const { db, products, owner } = setup();
  const cat = products.createCategory(owner, 'ძველი');
  const target = products.createCategory(owner, 'ახალი');
  const p = addProduct(products, owner, cat.id);
  // Make the final DELETE fail inside the transaction (after the UPDATE of products ran).
  db.exec(`CREATE TRIGGER test_block_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
  assert.throws(() => products.deleteCategory(owner, cat.id, target.id), /test failure/);
  db.exec('DROP TRIGGER test_block_delete;');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM categories WHERE id = ?', cat.id), 1, 'category still exists');
  assert.equal(products.getProductById(p.id)?.category_id, cat.id, 'product move was rolled back');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'CATEGORY_DELETE'"), 0, 'no audit entry for a rolled-back delete');
});

test('delete: products, variants, stock and sales history are preserved', () => {
  const { db, products, owner } = setup();
  const pos = new PosService(db);
  const cat = products.createCategory(owner, 'სათამაშოები');
  const target = products.createCategory(owner, 'სხვა');
  const p = addProduct(products, owner, cat.id, 'მანქანა');
  const sale = pos.checkout(owner, { items: [{ variant_id: p.variants![0].id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 3000 } as any);
  const snapshot = () => ({
    products: count(db, 'SELECT COUNT(*) AS n FROM products'),
    variants: count(db, 'SELECT COUNT(*) AS n FROM product_variants'),
    sales: count(db, 'SELECT COUNT(*) AS n FROM sales'),
    items: count(db, 'SELECT COUNT(*) AS n FROM sale_items'),
    movements: count(db, 'SELECT COUNT(*) AS n FROM inventory_movements'),
    stock: count(db, 'SELECT SUM(stock_quantity) AS n FROM product_variants'),
  });
  const before = snapshot();
  products.deleteCategory(owner, cat.id, target.id);
  assert.deepEqual(snapshot(), before);
  const stored = pos.getSaleById(sale.id)!;
  assert.equal(stored.total_tetri, 3000);
  assert.equal(stored.items?.[0].product_name_snap, 'მანქანა');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('seller without the permission is refused in the service', () => {
  const { auth, products, owner } = setup();
  const cat = products.createCategory(owner, 'კატეგორია');
  const seller = auth.addUser(owner, 'გამყიდველი', '4321', 'seller');
  assert.throws(() => products.createCategory(seller, 'სხვა'), /მხოლოდ მფლობელს ან უფლებამოსილ/);
  assert.throws(() => products.updateCategory(seller, cat.id, { name: 'შეცვლა' }), /მხოლოდ მფლობელს ან უფლებამოსილ/);
  assert.throws(() => products.updateCategory(seller, cat.id, { color: '#000000' }), /მხოლოდ მფლობელს ან უფლებამოსილ/);
  assert.throws(() => products.setCategoryArchived(seller, cat.id, true), /მხოლოდ მფლობელს ან უფლებამოსილ/);
  assert.throws(() => products.deleteCategory(seller, cat.id), /მხოლოდ მფლობელს ან უფლებამოსილ/);
  assert.equal(products.getCategories()[0].name, 'კატეგორია');
});

test('IPC: a seller calling the category channels directly is refused; the list is allowed', async () => {
  closeDatabase();
  const db = initDatabase(':memory:');
  try {
    const auth = new AuthService(db);
    const ownerToken = auth.setupInitialOwner('მფლობელი', '1234').token;
    const owner = auth.getUserById(1)!;
    const seller = auth.addUser(owner, 'გამყიდველი', '4321', 'seller');
    const sellerToken = auth.login(seller.id, '4321').token;
    const cat = await handleIpcMessage({ channel: 'products:createCategory', token: ownerToken, payload: { name: 'სასმელები', color: '#3b82f6' } });
    assert.equal(cat.success, true);
    const catId = cat.data.id;

    const attempts: Array<[string, any]> = [
      ['products:createCategory', { name: 'ჰაკერი' }],
      ['products:updateCategory', { categoryId: catId, name: 'შეცვლილი', color: '#000000' }],
      ['products:renameCategory', { categoryId: catId, name: 'შეცვლილი' }],
      ['products:setCategoryArchived', { categoryId: catId, isArchived: true }],
      ['products:getCategoryUsage', { categoryId: catId }],
      ['products:deleteCategory', { categoryId: catId }],
    ];
    for (const [channel, payload] of attempts) {
      const res = await handleIpcMessage({ channel, token: sellerToken, payload });
      assert.equal(res.success, false, `${channel} must be refused for a seller`);
      const anon = await handleIpcMessage({ channel, token: '', payload });
      assert.equal(anon.success, false, `${channel} must be refused without a session`);
    }
    const list = await handleIpcMessage({ channel: 'products:getCategories', token: sellerToken, payload: {} });
    assert.equal(list.success, true);
    assert.equal(list.data[0].name, 'სასმელები', 'nothing was changed by the refused calls');
    assert.equal(list.data[0].color, '#3b82f6');

    // Owner-delegated: the same seller with "categories.manage" may manage categories.
    auth.setUserPermissions(owner, seller.id, ['categories.manage']);
    const renamed = await handleIpcMessage({ channel: 'products:updateCategory', token: sellerToken, payload: { categoryId: catId, name: 'გამაგრილებელი' } });
    assert.equal(renamed.success, true, 'granted permission applies immediately');
    auth.setUserPermissions(owner, seller.id, []);
    const revoked = await handleIpcMessage({ channel: 'products:deleteCategory', token: sellerToken, payload: { categoryId: catId } });
    assert.equal(revoked.success, false, 'revoked permission applies immediately');
  } finally {
    closeDatabase();
  }
});
