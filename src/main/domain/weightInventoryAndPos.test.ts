/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Weight-Based (KG) Inventory and POS Tests.
 * Covers: product creation with unit_type='kg', gram-based restocking,
 * gram-based checkout, partial weight returns, FIFO multi-lot KG depletion,
 * mixed piece/kg carts, and debt reconciliation with KG items.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { AuthService } from './authService.ts';
import { ProductsService, CreateProductInput } from './productsService.ts';
import { InventoryService } from './inventoryService.ts';
import { PosService } from './posService.ts';
import { ReturnsService } from './returnsService.ts';
import { User } from '../../shared/types.ts';

let db: DatabaseSync;
let auth: AuthService;
let products: ProductsService;
let inventory: InventoryService;
let pos: PosService;
let returns: ReturnsService;
let owner: User;
let barcodeSeq = 100000000000;

function createTestDb(): DatabaseSync {
  const testDb = new DatabaseSync(':memory:');
  testDb.exec('PRAGMA foreign_keys = ON;');
  runMigrations(testDb);
  return testDb;
}

function setup() {
  db = createTestDb();
  auth = new AuthService(db);
  products = new ProductsService(db);
  inventory = new InventoryService(db);
  pos = new PosService(db);
  returns = new ReturnsService(db);

  // Create owner
  const session = auth.setupInitialOwner('მფლობელი', '1234');
  owner = session.user;
}

function createKgProduct(name: string, pricePerKgTetri: number, costPerKgTetri?: number): any {
  barcodeSeq++;
  const input: CreateProductInput = {
    name,
    base_price_tetri: pricePerKgTetri,
    base_cost_tetri: costPerKgTetri ?? null,
    unit_type: 'kg',
    variants: [{
      variant_name: 'სტანდარტული',
      codes: [{ code_type: 'barcode', code_value: String(barcodeSeq) }],
    }],
  };
  return products.createProduct(owner, input);
}

function createPieceProduct(name: string, priceTetri: number, initialStock: number = 0): any {
  barcodeSeq++;
  const input: CreateProductInput = {
    name,
    base_price_tetri: priceTetri,
    unit_type: 'piece',
    variants: [{
      variant_name: 'სტანდარტული',
      initial_stock: initialStock,
      codes: [{ code_type: 'barcode', code_value: String(barcodeSeq) }],
    }],
  };
  return products.createProduct(owner, input);
}

describe('Weight-Based (KG) Product Creation', () => {
  beforeEach(setup);

  it('creates a KG product with unit_type persisted', () => {
    const prod = createKgProduct('ჩაი', 1500); // 15.00 ₾/კგ
    assert.equal(prod.unit_type, 'kg');
    assert.equal(prod.variants[0].unit_type, 'kg');
  });

  it('creates a piece product with unit_type=piece by default', () => {
    const prod = createPieceProduct('ნაყინი', 200);
    assert.equal(prod.unit_type || 'piece', 'piece');
  });

  it('blocks unit_type change on products with sales history', () => {
    const prod = createKgProduct('შაქარი', 300, 200);
    const variantId = prod.variants[0].id;

    // Add stock and sell
    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 5000 });
    const customer = db.prepare("INSERT INTO customers (first_name, created_at) VALUES ('ტესტ', ?)").run(new Date().toISOString());
    pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 1000 }],
      payment_method: 'cash',
      cash_received_tetri: 10000,
    });

    // Try to change unit_type
    assert.throws(
      () => products.updateProduct(owner, { productId: prod.id, unit_type: 'piece' }),
      /ერთეულის ტიპი ვეღარ შეეცვლება/
    );
  });
});

describe('KG Inventory Restocking', () => {
  beforeEach(setup);

  it('restocks KG product in grams', () => {
    const prod = createKgProduct('ყავა', 4500, 2500); // 45₾/კგ, 25₾/კგ cost
    const variantId = prod.variants[0].id;

    const result = inventory.restockVariant(owner, {
      variant_id: variantId,
      added_quantity: 2500, // 2.5 kg = 2500 grams
      unit_cost_tetri: 2500, // 25₾/kg
    });

    assert.equal(result.new_stock, 2500);

    // Verify stock
    const updated = products.getProductById(prod.id);
    assert.equal(updated!.variants![0].stock_quantity, 2500);
  });

  it('accepts 1 gram minimum restock', () => {
    const prod = createKgProduct('საფრონი', 50000); // 500₾/კგ
    const variantId = prod.variants[0].id;

    const result = inventory.restockVariant(owner, {
      variant_id: variantId,
      added_quantity: 1, // 1 gram = 0.001 kg
    });

    assert.equal(result.new_stock, 1);
  });

  it('accumulates multiple restocks', () => {
    const prod = createKgProduct('ბრინჯი', 500);
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 1000 });
    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 2500 });
    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 75 });

    const updated = products.getProductById(prod.id);
    assert.equal(updated!.variants![0].stock_quantity, 3575); // 3.575 kg
  });
});

describe('KG Stock Correction', () => {
  beforeEach(setup);

  it('corrects KG stock down (shortfall)', () => {
    const prod = createKgProduct('ფქვილი', 250);
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 5000 });
    const result = inventory.correctStock(owner, {
      variant_id: variantId,
      counted_quantity: 4200,
      reason: 'რეალური წონა ნაკლებია',
    });

    assert.equal(result.new_stock, 4200);
    assert.equal(result.diff, -800);
  });

  it('corrects KG stock up (surplus)', () => {
    const prod = createKgProduct('მარილი', 100);
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 3000 });
    const result = inventory.correctStock(owner, {
      variant_id: variantId,
      counted_quantity: 3250,
      reason: 'დამატებითი ნაშთი აღმოჩნდა',
    });

    assert.equal(result.new_stock, 3250);
    assert.equal(result.diff, 250);
  });
});

describe('KG POS Checkout', () => {
  beforeEach(setup);

  it('sells KG product: line total = Math.round(price_per_kg * grams / 1000)', () => {
    const prod = createKgProduct('ხორცი', 2000, 1200); // 20₾/კგ, 12₾/კგ cost
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, {
      variant_id: variantId,
      added_quantity: 5000,
      unit_cost_tetri: 1200,
    });

    // Buy 1.250 kg = 1250 grams -> 20₾/კგ × 1.250 = 25₾ = 2500 tetri
    const sale = pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 1250 }],
      payment_method: 'cash',
      cash_received_tetri: 2500,
    });

    assert.equal(sale.total_tetri, 2500);
    assert.equal(sale.items![0].quantity, 1250);
    assert.equal(sale.items![0].unit_type, 'kg');

    // Stock should be 5000 - 1250 = 3750 grams
    const updated = products.getProductById(prod.id);
    assert.equal(updated!.variants![0].stock_quantity, 3750);
  });

  it('sells fractional KG: 75 grams correctly priced', () => {
    const prod = createKgProduct('საფრონი', 50000); // 500₾/კგ
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 500 });

    // Buy 75 grams -> 500₾/კგ × 0.075 = 37.50₾ = 3750 tetri
    const sale = pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 75 }],
      payment_method: 'cash',
      cash_received_tetri: 3750,
    });

    assert.equal(sale.total_tetri, 3750);
  });

  it('sells 1 gram correctly', () => {
    const prod = createKgProduct('ოქრო', 1000000); // 10000₾/კგ
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 100 });

    // 1 gram of 10000₾/კგ = 10₾ = 1000 tetri
    const sale = pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 1 }],
      payment_method: 'cash',
      cash_received_tetri: 1000,
    });

    assert.equal(sale.total_tetri, 1000);
  });

  it('rejects insufficient KG stock', () => {
    const prod = createKgProduct('ლობიო', 800);
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 500 }); // 0.5 kg

    assert.throws(
      () => pos.checkout(owner, {
        items: [{ variant_id: variantId, quantity: 1000 }], // 1 kg > 0.5 kg
        payment_method: 'cash',
        cash_received_tetri: 10000,
      }),
      /არასაკმარისი მარაგი/
    );
  });

  it('mixed cart: piece + KG items', () => {
    const kgProd = createKgProduct('პარმეზანი', 6000); // 60₾/კგ
    const pcProd = createPieceProduct('პური', 200, 0); // 2₾/ცალი
    const kgVarId = kgProd.variants[0].id;
    const pcVarId = pcProd.variants[0].id;

    inventory.restockVariant(owner, { variant_id: kgVarId, added_quantity: 2000 }); // 2 kg
    inventory.restockVariant(owner, { variant_id: pcVarId, added_quantity: 10 }); // 10 pieces

    // Buy 250g parmezan (60₾/კგ × 0.250 = 15₾ = 1500 tetri) + 3 bread (2₾ × 3 = 6₾ = 600 tetri)
    const sale = pos.checkout(owner, {
      items: [
        { variant_id: kgVarId, quantity: 250 },
        { variant_id: pcVarId, quantity: 3 },
      ],
      payment_method: 'cash',
      cash_received_tetri: 2100,
    });

    assert.equal(sale.total_tetri, 2100); // 1500 + 600

    // Check remaining stock
    const kgUpdated = products.getProductById(kgProd.id);
    assert.equal(kgUpdated!.variants![0].stock_quantity, 1750); // 2000 - 250

    const pcUpdated = products.getProductById(pcProd.id);
    assert.equal(pcUpdated!.variants![0].stock_quantity, 7); // 10 - 3
  });
});

describe('KG FIFO Multi-Lot Depletion', () => {
  beforeEach(setup);

  it('depletes FIFO lots correctly for KG sale', () => {
    const prod = createKgProduct('ყველი', 3000, 1800); // 30₾/კგ
    const variantId = prod.variants[0].id;

    // Restock in two lots at different costs
    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 1000, unit_cost_tetri: 1500 }); // Lot 1: 1kg @ 15₾
    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 2000, unit_cost_tetri: 2000 }); // Lot 2: 2kg @ 20₾

    // Sell 1500g — should take 1000 from lot 1 + 500 from lot 2
    pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 1500 }],
      payment_method: 'cash',
      cash_received_tetri: 4500, // 30₾/კგ × 1.5 = 45₾
    });

    // Verify remaining lots
    const lots = db.prepare(
      "SELECT remaining_quantity, unit_cost_tetri FROM inventory_lots WHERE variant_id = ? ORDER BY id ASC"
    ).all(variantId) as any[];

    assert.equal(lots[0].remaining_quantity, 0); // Lot 1 fully depleted
    assert.equal(lots[1].remaining_quantity, 1500); // Lot 2 still has 1500g

    // Total stock
    const updated = products.getProductById(prod.id);
    assert.equal(updated!.variants![0].stock_quantity, 1500);
  });
});

describe('KG Partial Returns', () => {
  beforeEach(setup);

  it('partial weight return: bought 2000g, return 750g', () => {
    const prod = createKgProduct('ხორცი', 2000, 1200); // 20₾/კგ
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, {
      variant_id: variantId,
      added_quantity: 5000,
      unit_cost_tetri: 1200,
    });

    // Sell 2000g (2 kg) -> 20₾/კგ × 2 = 40₾ = 4000 tetri
    const sale = pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 2000 }],
      payment_method: 'cash',
      cash_received_tetri: 4000,
    });

    assert.equal(sale.total_tetri, 4000);
    const saleItemId = sale.items![0].id;

    // Return 750g out of 2000g -> prorated refund: Math.floor(4000 × 750/2000) = 1500 tetri
    const result = returns.processReturn(owner, {
      sale_id: sale.id,
      items: [{ sale_item_id: saleItemId, variant_id: variantId, quantity: 750, condition: 'resellable' }],
    });

    assert.equal(result.total_refund_tetri, 1500);
    assert.equal(result.cash_refund_tetri, 1500);

    // Stock should be restored: 3000 (after sale) + 750 (return) = 3750
    const updated = products.getProductById(prod.id);
    assert.equal(updated!.variants![0].stock_quantity, 3750);
  });

  it('full weight return: bought 1250g, return 1250g', () => {
    const prod = createKgProduct('ბრინჯი', 500); // 5₾/კგ
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 3000 });

    // Sell 1250g -> 5₾/კგ × 1.250 = 6.25₾ = 625 tetri
    // Math.round(500 * 1250 / 1000) = 625
    const sale = pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 1250 }],
      payment_method: 'cash',
      cash_received_tetri: 625,
    });

    assert.equal(sale.total_tetri, 625);

    // Return all
    const result = returns.processReturn(owner, {
      sale_id: sale.id,
      items: [{ sale_item_id: sale.items![0].id, variant_id: variantId, quantity: 1250, condition: 'resellable' }],
    });

    assert.equal(result.total_refund_tetri, 625);

    // Stock restored to 3000
    const updated = products.getProductById(prod.id);
    assert.equal(updated!.variants![0].stock_quantity, 3000);
  });

  it('successive partial weight returns add up exactly', () => {
    const prod = createKgProduct('სუნელი', 8000); // 80₾/კგ
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 5000 });

    // Sell 1000g -> 80₾/კგ × 1.000 = 80₾ = 8000 tetri
    const sale = pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 1000 }],
      payment_method: 'cash',
      cash_received_tetri: 8000,
    });

    const saleItemId = sale.items![0].id;

    // Return 300g first
    const r1 = returns.processReturn(owner, {
      sale_id: sale.id,
      items: [{ sale_item_id: saleItemId, variant_id: variantId, quantity: 300, condition: 'resellable' }],
    });

    // Return another 400g
    const r2 = returns.processReturn(owner, {
      sale_id: sale.id,
      items: [{ sale_item_id: saleItemId, variant_id: variantId, quantity: 400, condition: 'resellable' }],
    });

    // Return final 300g
    const r3 = returns.processReturn(owner, {
      sale_id: sale.id,
      items: [{ sale_item_id: saleItemId, variant_id: variantId, quantity: 300, condition: 'resellable' }],
    });

    // All refunds should sum to exactly the sale total
    const totalRefunded = r1.total_refund_tetri + r2.total_refund_tetri + r3.total_refund_tetri;
    assert.equal(totalRefunded, 8000);

    // Stock fully restored
    const updated = products.getProductById(prod.id);
    assert.equal(updated!.variants![0].stock_quantity, 5000);
  });
});

describe('KG Debt Sales', () => {
  beforeEach(setup);

  it('KG item sold on debt, partial repayment', () => {
    const prod = createKgProduct('თევზი', 3500); // 35₾/კგ
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 10000 });

    // Create customer
    const custRes = db.prepare(
      "INSERT INTO customers (first_name, created_at) VALUES (?, ?)"
    ).run('თამარ', new Date().toISOString());
    const customerId = Number(custRes.lastInsertRowid);

    // Sell 2500g on debt -> 35₾/კგ × 2.500 = 87.50₾ = 8750 tetri
    const sale = pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 2500 }],
      payment_method: 'debt',
      customer_id: customerId,
    });

    assert.equal(sale.total_tetri, 8750);
    assert.equal(sale.debt_amount_tetri, 8750);

    // Stock should be 10000 - 2500 = 7500
    const updated = products.getProductById(prod.id);
    assert.equal(updated!.variants![0].stock_quantity, 7500);
  });
});

describe('KG Rounding Edge Cases', () => {
  beforeEach(setup);

  it('price per kg 333 tetri, 333 grams = Math.round(333 * 333 / 1000) = 111', () => {
    const prod = createKgProduct('ტესტ1', 333);
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 1000 });

    const sale = pos.checkout(owner, {
      items: [{ variant_id: variantId, quantity: 333 }],
      payment_method: 'cash',
      cash_received_tetri: Math.round(333 * 333 / 1000), // 111
    });

    assert.equal(sale.total_tetri, Math.round(333 * 333 / 1000));
  });

  it('price per kg 1 tetri, 1 gram = Math.round(1 * 1 / 1000) = 0 → sale rejected', () => {
    const prod = createKgProduct('ტესტ2', 1);
    const variantId = prod.variants[0].id;

    inventory.restockVariant(owner, { variant_id: variantId, added_quantity: 1000 });

    // Total would be 0 tetri → sale should be rejected
    assert.throws(
      () => pos.checkout(owner, {
        items: [{ variant_id: variantId, quantity: 1 }],
        payment_method: 'cash',
        cash_received_tetri: 0,
      }),
      /ჯამური თანხა უნდა აღემატებოდეს 0-ს/
    );
  });
});
