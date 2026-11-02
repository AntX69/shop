/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds a store profile with the M12 code (commit 1bfb98d, schema v5) so that the V1.0
 * upgrade path can be tested on realistic old data: inline base64 photos, a resellable return
 * that left a NULL-cost lot, a stock correction that left lots out of step, a debt exchange,
 * repayments and an expense.
 *
 *   git archive 1bfb98d src | tar -x -C <m12dir>      (and give <m12dir> a node_modules)
 *   tsx e2e/upgrade/make-m12-profile.mts <m12dir> <profileDir>
 *
 * Writes <profileDir>/data/store.db and <profileDir>/m12-expected.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [m12Dir, profileDir] = process.argv.slice(2);
if (!m12Dir || !profileDir) throw new Error('usage: make-m12-profile.mts <m12dir> <profileDir>');
const dataDir = path.join(path.resolve(profileDir), 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.STORE_DATA_DIR = dataDir;
process.env.STORE_DB_PATH = path.join(dataDir, 'store.db');

const load = (p: string) => import(pathToFileURL(path.join(path.resolve(m12Dir), p)).href);
const { handleIpcMessage } = await load('src/main/ipc/handlers.ts');
const { closeDatabase, getDb } = await load('src/main/db/database.ts');

async function call(channel: string, payload?: any, token?: string) {
  const r = await handleIpcMessage({ channel, payload, token });
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const owner = await call('auth:setupOwner', { name: 'M12 მფლობელი', pin: '5555' });
const OT = owner.token;
await call('auth:addUser', { name: 'M12 გამყიდველი', pin: '6666', role: 'seller' }, OT);
const cat = await call('products:createCategory', { name: 'ძველი კატეგორია' }, OT);
const a = await call('products:create', {
  name: 'ძველი სათამაშო', category_id: cat.id, base_price_tetri: 3000, base_cost_tetri: 1200, image_paths: [PNG],
  variants: [{ variant_name: 'სტ', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '41001' }] }],
}, OT);
const b = await call('products:create', {
  name: 'ფასუცნობი ნივთი', base_price_tetri: 2000,
  variants: [{ variant_name: 'სტ', initial_stock: 5, codes: [{ code_type: 'manual_5digit', code_value: '41002' }] }],
}, OT);
const c = await call('products:create', {
  name: 'ძველი ფეხსაცმელი', base_price_tetri: 5000, base_cost_tetri: 2500,
  variants: [
    { variant_name: '40', size: '40', initial_stock: 3, codes: [{ code_type: 'manual_5digit', code_value: '41003' }] },
    { variant_name: '41', size: '41', initial_stock: 3, codes: [{ code_type: 'barcode', code_value: '0001234500017' }] },
  ],
}, OT);
const va = a.variants[0].id, vb = b.variants[0].id, vc40 = c.variants[0].id, vc41 = c.variants[1].id;
const cust = await call('customers:create', { first_name: 'ძველი კლიენტი' }, OT);

const s1 = await call('pos:checkout', { items: [{ variant_id: va, quantity: 2, unit_price_tetri: 3000 }], payment_method: 'cash', cash_received_tetri: 6000 }, OT);
const s2 = await call('pos:checkout', { items: [{ variant_id: vb, quantity: 1, unit_price_tetri: 2000 }], payment_method: 'debt', customer_id: cust.id }, OT);
const s3 = await call('pos:checkout', { items: [{ variant_id: vc40, quantity: 1, unit_price_tetri: 5000 }], payment_method: 'mixed', customer_id: cust.id, cash_received_tetri: 1000 }, OT);
await call('customers:repay', { customer_id: cust.id, amount_tetri: 1500 }, OT);
await call('returns:process', { sale_id: s1.id, items: [{ sale_item_id: s1.items[0].id, variant_id: va, quantity: 1, condition: 'resellable' }] }, OT);
await call('inventory:correct', { variant_id: vc41, counted_quantity: 2, reason: 'დათვლა' }, OT);
await call('finance:createExpense', { category: 'ქირა', description: 'M12 ხარჯი', amount_tetri: 5000 }, OT);
void s2; void s3;

const db = getDb();
const expected = {
  schema: (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v,
  products: (db.prepare('SELECT COUNT(*) AS n FROM products').get() as any).n,
  sales: (db.prepare('SELECT COUNT(*) AS n FROM sales').get() as any).n,
  returns: (db.prepare('SELECT COUNT(*) AS n FROM returns').get() as any).n,
  inlineImages: (db.prepare("SELECT COUNT(*) AS n FROM product_images WHERE file_path LIKE 'data:%'").get() as any).n,
  nullCostLots: (db.prepare('SELECT COUNT(*) AS n FROM inventory_lots WHERE unit_cost_tetri IS NULL AND remaining_quantity > 0').get() as any).n,
  stock: Object.fromEntries((db.prepare('SELECT id, stock_quantity FROM product_variants ORDER BY id').all() as any[]).map((r) => [r.id, r.stock_quantity])),
  lotDrift: (db.prepare(`SELECT COUNT(*) AS n FROM product_variants pv WHERE pv.stock_quantity != COALESCE((SELECT SUM(remaining_quantity) FROM inventory_lots l WHERE l.variant_id = pv.id), 0)`).get() as any).n,
  customerDebt: (await call('customers:get', { customerId: cust.id }, OT)).total_debt_tetri,
  customerId: cust.id,
  ownerPin: '5555',
};
closeDatabase();
fs.writeFileSync(path.join(path.resolve(profileDir), 'm12-expected.json'), JSON.stringify(expected, null, 2));
console.log(JSON.stringify(expected, null, 2));
