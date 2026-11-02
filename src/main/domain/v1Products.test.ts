/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Product management regression suite: owner-only editing, code rules, archiving,
 * photos stored as files, catalogue performance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { AuthService } from './authService.ts';
import { ProductsService } from './productsService.ts';
import { PosService } from './posService.ts';
import { migrateInlineImagesToFiles } from './productImages.ts';

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function env(onDisk = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-products-'));
  const db = new DatabaseSync(onDisk ? path.join(dir, 'store.db') : ':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const auth = new AuthService(db);
  const owner = auth.setupInitialOwner('მფლობელი', '1111').user;
  const seller = auth.addUser(owner, 'გამყიდველი', '2222', 'seller');
  return { dir, db, owner, seller, products: new ProductsService(db), pos: new PosService(db) };
}

const variant = (code: string, extra: object = {}) => ({ variant_name: 'სტ', initial_stock: 5, codes: [{ code_type: 'manual_5digit' as const, code_value: code }], ...extra });

test('owner edits name, category, price and cost; sellers cannot; history keeps the old price', () => {
  const e = env();
  const cat = e.products.createCategory(e.owner, 'სათამაშოები');
  const p = e.products.createProduct(e.owner, { name: 'მანქანა', base_price_tetri: 2000, base_cost_tetri: 900, variants: [variant('10001')] });
  const sale = e.pos.checkout(e.seller, { items: [{ variant_id: p.variants![0].id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 2000 });

  assert.throws(() => e.products.updateProduct(e.seller, { productId: p.id, base_price_tetri: 1 }), /მხოლოდ მფლობელს/);
  const updated = e.products.updateProduct(e.owner, { productId: p.id, name: 'რბოლის მანქანა', category_id: cat.id, base_price_tetri: 2500, base_cost_tetri: 1100 });
  assert.equal(updated.name, 'რბოლის მანქანა');
  assert.equal(updated.category_name, 'სათამაშოები');
  assert.equal(updated.variants![0].effective_price_tetri, 2500);

  const old = e.pos.getSaleById(sale.id)!;
  assert.equal(old.items![0].unit_price_tetri, 2000, 'sold line keeps its price');
  assert.equal(old.items![0].product_name_snap, 'მანქანა', 'sold line keeps its name');
  const lot = e.db.prepare('SELECT unit_cost_tetri FROM inventory_lots WHERE variant_id = ?').get(p.variants![0].id) as any;
  assert.equal(lot.unit_cost_tetri, 900, 'existing stock keeps the cost it was bought at');

  const audit = e.db.prepare("SELECT details FROM audit_logs WHERE action = 'PRODUCT_UPDATE'").get() as any;
  const d = JSON.parse(audit.details);
  assert.equal(d.before.base_price_tetri, 2000);
  assert.equal(d.after.base_price_tetri, 2500);
});

test('internal codes are 5 digits 10000-99999, unique; barcodes keep leading zeros', () => {
  const e = env();
  for (const bad of ['00001', '09999', '1234', '123456', '12a45']) {
    assert.throws(() => e.products.createProduct(e.owner, { name: 'x', base_price_tetri: 100, variants: [variant(bad)] }), /ზუსტად 5-ნიშნა/, bad);
  }
  const a = e.products.createProduct(e.owner, { name: 'A', base_price_tetri: 100, variants: [variant('10000'), variant('99999')] });
  assert.equal(a.variants!.length, 2);
  assert.throws(() => e.products.createProduct(e.owner, { name: 'B', base_price_tetri: 100, variants: [variant('10000')] }), /უკვე გამოყენებულია/);
  assert.throws(() => e.products.createProduct(e.owner, { name: 'C', base_price_tetri: 100, variants: [variant('20000'), variant('20000')] }), /ორჯერ/);
  const b = e.products.createProduct(e.owner, {
    name: 'D', base_price_tetri: 100,
    variants: [{ variant_name: 'სტ', codes: [{ code_type: 'barcode', code_value: '0004006381333' }] }],
  });
  assert.equal(e.products.lookupByCode('0004006381333')!.product.id, b.id);
  assert.equal(e.products.lookupByCode('4006381333'), null, 'leading zeros are significant');
});

test('variant editing: codes, size/colour, price override; at least one code remains', () => {
  const e = env();
  const p = e.products.createProduct(e.owner, { name: 'ფეხსაცმელი', base_price_tetri: 5000, variants: [variant('30001', { size: '41', color: 'შავი' })] });
  const v = p.variants![0];
  const after = e.products.updateVariant(e.owner, { variantId: v.id, manual_code: '30002', barcode: '4860000000017', size: '42', price_override_tetri: 5500 });
  const nv = after.variants![0];
  assert.equal(nv.size, '42');
  assert.equal(nv.effective_price_tetri, 5500);
  assert.equal(e.products.lookupByCode('30001'), null);
  assert.equal(e.products.lookupByCode('30002')!.variant.id, v.id);
  assert.equal(e.products.lookupByCode('4860000000017')!.variant.id, v.id);
  e.products.updateVariant(e.owner, { variantId: v.id, barcode: '' });
  assert.throws(() => e.products.updateVariant(e.owner, { variantId: v.id, manual_code: '' }), /მინიმუმ ერთი კოდი/);
  assert.equal(e.products.lookupByCode('30002')!.variant.id, v.id, 'failed edit was rolled back');
  assert.throws(() => e.products.updateVariant(e.seller, { variantId: v.id, size: '43' }), /მხოლოდ მფლობელს/);

  const withNew = e.products.addVariant(e.owner, p.id, variant('30003', { size: '43', initial_stock: 4, cost_override_tetri: 2600 }));
  const v43 = withNew.variants!.find((x) => x.size === '43')!;
  assert.equal(v43.stock_quantity, 4);
  const lot = e.db.prepare('SELECT remaining_quantity, unit_cost_tetri FROM inventory_lots WHERE variant_id = ?').get(v43.id) as any;
  assert.deepEqual([lot.remaining_quantity, lot.unit_cost_tetri], [4, 2600]);
});

test('archived products and variants are hidden from sale but kept in history', () => {
  const e = env();
  const p = e.products.createProduct(e.owner, { name: 'ჩანთა', base_price_tetri: 3000, variants: [variant('40001'), variant('40002')] });
  const [v1, v2] = p.variants!;
  const sale = e.pos.checkout(e.seller, { items: [{ variant_id: v1.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 3000 });

  e.products.setVariantActive(e.owner, v2.id, false);
  assert.throws(() => e.products.setVariantActive(e.owner, v1.id, false), /ბოლო აქტიური ვარიანტის/);
  assert.equal(e.products.lookupByCode('40002'), null);
  assert.throws(() => e.pos.checkout(e.seller, { items: [{ variant_id: v2.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 3000 }), /დაარქივებულია/);

  e.products.setProductActive(e.owner, p.id, false);
  assert.equal(e.products.listProducts().length, 0);
  assert.equal(e.products.listProducts({ archivedOnly: true }).length, 1);
  assert.equal(e.products.lookupByCode('40001'), null);
  assert.throws(() => e.pos.checkout(e.seller, { items: [{ variant_id: v1.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 3000 }), /დაარქივებულია/);
  assert.equal(e.pos.getSaleById(sale.id)!.items![0].product_name_snap, 'ჩანთა');

  e.products.setProductActive(e.owner, p.id, true);
  assert.equal(e.products.lookupByCode('40001')!.variant.id, v1.id);
});

test('photos are stored as files in the photo folder and served by URL', () => {
  const e = env(true);
  const p = e.products.createProduct(e.owner, { name: 'კაბა', base_price_tetri: 9000, variants: [variant('50001')], image_paths: [PNG_1PX] });
  const img = p.images![0];
  assert.match(img.file_path, /^p_[a-z0-9]+_[0-9a-f]+\.png$/);
  assert.equal(img.url, `storepos-img://photo/${img.file_path}`);
  assert.ok(fs.existsSync(path.join(e.dir, 'images', img.file_path)));

  assert.throws(() => e.products.addImage(e.owner, p.id, 'C:\\Windows\\win.ini'), /გარე ფაილის მისამართი/);
  assert.throws(() => e.products.addImage(e.owner, p.id, 'data:text/html;base64,PHNjcmlwdD4='), /ფორმატი/);
  assert.throws(() => e.products.addImage(e.seller, p.id, PNG_1PX), /მხოლოდ მფლობელს/);

  const second = e.products.addImage(e.owner, p.id, PNG_1PX);
  e.products.setPrimaryImage(e.owner, second.id);
  assert.equal(e.products.getProductById(p.id)!.images![0].id, second.id);
  e.products.deleteImage(e.owner, img.id);
  assert.equal(fs.existsSync(path.join(e.dir, 'images', img.file_path)), false, 'deleted photo file removed');

  // Photos saved inline by older versions are moved to files without loss.
  e.db.prepare("INSERT INTO product_images (product_id, file_path, is_primary, created_at) VALUES (?, ?, 0, ?)").run(p.id, PNG_1PX, new Date().toISOString());
  assert.equal(migrateInlineImagesToFiles(e.db), 1);
  assert.equal(migrateInlineImagesToFiles(e.db), 0, 'idempotent');
  const rows = e.db.prepare("SELECT file_path FROM product_images WHERE product_id = ?").all(p.id) as any[];
  assert.ok(rows.every((r) => !r.file_path.startsWith('data:') && fs.existsSync(path.join(e.dir, 'images', r.file_path))));
  e.db.close();
});

test('catalogue of 300 products x 3 variants lists and searches quickly', () => {
  const e = env();
  const cat = e.products.createCategory(e.owner, 'ტანსაცმელი');
  let code = 60000;
  for (let i = 0; i < 300; i++) {
    e.products.createProduct(e.owner, {
      name: `პროდუქტი ${i}`, category_id: i % 2 ? cat.id : null, base_price_tetri: 1000 + i, base_cost_tetri: 500,
      variants: ['S', 'M', 'L'].map((size) => ({ variant_name: size, size, color: i % 3 ? 'შავი' : 'წითელი', initial_stock: i % 4, codes: [{ code_type: 'manual_5digit' as const, code_value: String(code++) }] })),
    });
  }
  const t0 = performance.now();
  const all = e.products.listProducts();
  const t1 = performance.now();
  assert.equal(all.length, 300);
  assert.ok(all.every((p) => p.variants!.length === 3 && p.variants!.every((v) => v.codes!.length === 1)));
  assert.ok(t1 - t0 < 1500, `listProducts took ${Math.round(t1 - t0)} ms`);
  assert.equal(e.products.listProducts({ searchTerm: 'წითელი' }).length, 100);
  assert.equal(e.products.listProducts({ searchTerm: 'ტანსაცმელი' }).length, 150);
  assert.equal(e.products.listProducts({ stockFilter: 'zero' }).length, 75);
  assert.equal(e.products.lookupByCode('60899')!.product.name, 'პროდუქტი 299');
});
