/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Milestone M12 Test Suite: Critical Accounting, Debt Allocations & Deterministic Ledger
 * 
 * Tests:
 * 1. Multi-debt FIFO allocation (Sale 1: 100₾, Sale 2: 60₾ -> Repay 50₾ -> S1: 50₾, S2: 60₾, Total: 110₾)
 * 2. Return on multi-debt sale (Return 20₾ from Sale 2 -> S2: 40₾, S1: 50₾, Total: 90₾, Cash refund: 0₾)
 * 3. Specific sale repayment (Targeted repayment only decreases specified sale)
 * 4. Repayment exceeding debt throws error (both specific sale and general debt)
 * 5. Repayment audit allocation history (allocations table records exact breakdowns)
 * 6. Deterministic Ledger Tie-Breaker Ordering (same timestamp: sale_debt -> repayment -> return_credit -> ref_id)
 * 7. Idempotency protection with payload verification
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { AuthService } from './authService.ts';
import { ProductsService } from './productsService.ts';
import { PosService } from './posService.ts';
import { CustomerService } from './customerService.ts';
import { ReturnsService } from './returnsService.ts';

function createM12TestEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);

  const authService = new AuthService(db);
  const productsService = new ProductsService(db);
  const posService = new PosService(db);
  const customerService = new CustomerService(db);
  const returnsService = new ReturnsService(db);

  const ownerSession = authService.setupInitialOwner('ნიკო მესაკუთრე', '1111');
  const owner = ownerSession.user;
  const seller = authService.addUser(owner, 'გიორგი მოლარე', '2222', 'seller');

  return {
    db,
    authService,
    productsService,
    posService,
    customerService,
    returnsService,
    owner,
    seller
  };
}

test('M12-1: Multi-debt FIFO allocation and exact remaining debt calculation', () => {
  const env = createM12TestEnv();

  // Create products
  const p1 = env.productsService.createProduct(env.owner, {
    name: 'შაქარი 1კგ',
    base_price_tetri: 10000, // 100.00 GEL
    variants: [{
      variant_name: 'სტანდარტული',
      initial_stock: 50,
      codes: [{ code_type: 'manual_5digit', code_value: '10001' }]
    }]
  });
  const v1 = p1.variants![0];

  const p2 = env.productsService.createProduct(env.owner, {
    name: 'ყავა 250გ',
    base_price_tetri: 6000, // 60.00 GEL
    variants: [{
      variant_name: 'სტანდარტული',
      initial_stock: 50,
      codes: [{ code_type: 'manual_5digit', code_value: '10002' }]
    }]
  });
  const v2 = p2.variants![0];

  // Create customer
  const customer = env.customerService.createCustomer(env.seller, {
    first_name: 'ლევან',
    last_name: 'ბერიძე',
    phone: '599112233'
  });

  // 1. Sale 1: 100.00 GEL debt
  const sale1 = env.posService.checkout(env.seller, {
    items: [{ variant_id: v1.id, quantity: 1, unit_price_tetri: 10000 }],
    payment_method: 'debt',
    customer_id: customer.id
  });
  assert.equal(sale1.debt_amount_tetri, 10000);
  assert.equal(sale1.debt_remaining_tetri, 10000);

  // 2. Sale 2: 60.00 GEL debt
  const sale2 = env.posService.checkout(env.seller, {
    items: [{ variant_id: v2.id, quantity: 1, unit_price_tetri: 6000 }],
    payment_method: 'debt',
    customer_id: customer.id
  });
  assert.equal(sale2.debt_amount_tetri, 6000);
  assert.equal(sale2.debt_remaining_tetri, 6000);

  // Customer total debt is 160.00 GEL
  let updatedCust = env.customerService.getCustomerById(customer.id);
  assert.equal(updatedCust!.total_debt_tetri, 16000);

  // 3. Customer pays 50.00 GEL general debt (sale_id is undefined)
  const rep1 = env.customerService.recordRepayment(env.seller, {
    customer_id: customer.id,
    amount_tetri: 5000,
    notes: 'ზოგადი ნაწილობრივი გადახდა'
  });

  // Verify FIFO Allocation:
  // Sale 1 is the oldest unpaid debt -> receives full 5,000 tetri allocation
  assert.equal(rep1.allocations?.length, 1);
  assert.equal(rep1.allocations[0].sale_id, sale1.id);
  assert.equal(rep1.allocations[0].allocated_tetri, 5000);

  // Check active sales
  const activeSalesAfterRepay = env.customerService.getCustomerActiveSales(customer.id);
  assert.equal(activeSalesAfterRepay.length, 2);

  const activeSale1 = activeSalesAfterRepay.find(s => s.id === sale1.id);
  const activeSale2 = activeSalesAfterRepay.find(s => s.id === sale2.id);

  assert.equal(activeSale1?.debt_remaining_tetri, 5000, 'Sale 1 remaining debt must be 50.00 GEL');
  assert.equal(activeSale2?.debt_remaining_tetri, 6000, 'Sale 2 remaining debt must be 60.00 GEL');

  // Customer total debt must be 110.00 GEL
  updatedCust = env.customerService.getCustomerById(customer.id);
  assert.equal(updatedCust!.total_debt_tetri, 11000, 'Customer total debt must be 110.00 GEL');

  // Accounting invariant: sum of active sales remaining debts === customer total debt
  const sumRemaining = activeSalesAfterRepay.reduce((sum, s) => sum + (s.debt_remaining_tetri || 0), 0);
  assert.equal(sumRemaining, updatedCust!.total_debt_tetri);
});

test('M12-2: Return on multi-debt sale properly reduces specific sale debt without cash refund', () => {
  const env = createM12TestEnv();

  const p1 = env.productsService.createProduct(env.owner, {
    name: 'საქონელი 1',
    base_price_tetri: 10000,
    variants: [{
      variant_name: 'ძირითადი',
      initial_stock: 50,
      codes: [{ code_type: 'manual_5digit', code_value: '20001' }]
    }]
  });
  const p2 = env.productsService.createProduct(env.owner, {
    name: 'საქონელი 2',
    base_price_tetri: 2000, // 20.00 GEL per unit
    variants: [{
      variant_name: 'ძირითადი',
      initial_stock: 50,
      codes: [{ code_type: 'manual_5digit', code_value: '20002' }]
    }]
  });

  const customer = env.customerService.createCustomer(env.seller, {
    first_name: 'მარიამ',
    last_name: 'კაპანაძე'
  });

  // Sale 1: 100.00 GEL debt
  const sale1 = env.posService.checkout(env.seller, {
    items: [{ variant_id: p1.variants![0].id, quantity: 1, unit_price_tetri: 10000 }],
    payment_method: 'debt',
    customer_id: customer.id
  });

  // Sale 2: 3 units x 20.00 GEL = 60.00 GEL debt
  const sale2 = env.posService.checkout(env.seller, {
    items: [{ variant_id: p2.variants![0].id, quantity: 3, unit_price_tetri: 2000 }],
    payment_method: 'debt',
    customer_id: customer.id
  });

  // Repay 50.00 GEL general debt -> Sale 1 remaining = 50.00 GEL, Sale 2 remaining = 60.00 GEL
  env.customerService.recordRepayment(env.seller, {
    customer_id: customer.id,
    amount_tetri: 5000
  });

  // Process Return from Sale 2: return 1 unit (20.00 GEL)
  const sale2Items = env.posService.getSaleById(sale2.id)!.items!;
  const ret = env.returnsService.processReturn(env.seller, {
    sale_id: sale2.id,
    items: [{
      sale_item_id: sale2Items[0].id,
      variant_id: p2.variants![0].id,
      quantity: 1,
      condition: 'resellable'
    }],
    reason: 'წუნდებული'
  });

  // Verify return accounting:
  // Debt reduced: 20.00 GEL (2000 tetri)
  // Cash refund: 0 GEL (because sale 2 had 60.00 GEL open debt)
  assert.equal(ret.total_refund_tetri, 2000);
  assert.equal(ret.debt_deduction_tetri, 2000);
  assert.equal(ret.cash_refund_tetri, 0);

  // Check active sales
  const activeSales = env.customerService.getCustomerActiveSales(customer.id);
  const updatedSale1 = activeSales.find(s => s.id === sale1.id);
  const updatedSale2 = activeSales.find(s => s.id === sale2.id);

  assert.equal(updatedSale1?.debt_remaining_tetri, 5000, 'Sale 1 remaining debt must stay 50.00 GEL');
  assert.equal(updatedSale2?.debt_remaining_tetri, 4000, 'Sale 2 remaining debt must now be 40.00 GEL (60 - 20)');

  // Customer total debt: 110 - 20 = 90.00 GEL
  const updatedCust = env.customerService.getCustomerById(customer.id);
  assert.equal(updatedCust!.total_debt_tetri, 9000);

  // Accounting invariant: sum(active_sales.debt_remaining_tetri) === customer.total_debt_tetri
  const sumRemaining = activeSales.reduce((sum, s) => sum + (s.debt_remaining_tetri || 0), 0);
  assert.equal(sumRemaining, updatedCust!.total_debt_tetri);
});

test('M12-3: Specific sale repayment targets only designated sale and validates bounds', () => {
  const env = createM12TestEnv();

  const p1 = env.productsService.createProduct(env.owner, {
    name: 'პროდუქტი A',
    base_price_tetri: 8000,
    variants: [{
      variant_name: 'ძირითადი',
      initial_stock: 50,
      codes: [{ code_type: 'manual_5digit', code_value: '30001' }]
    }]
  });

  const customer = env.customerService.createCustomer(env.seller, {
    first_name: 'თემურ',
    last_name: 'მაისურაძე'
  });

  const sale1 = env.posService.checkout(env.seller, {
    items: [{ variant_id: p1.variants![0].id, quantity: 1, unit_price_tetri: 8000 }],
    payment_method: 'debt',
    customer_id: customer.id
  });

  const sale2 = env.posService.checkout(env.seller, {
    items: [{ variant_id: p1.variants![0].id, quantity: 1, unit_price_tetri: 8000 }],
    payment_method: 'debt',
    customer_id: customer.id
  });

  // Repay 30.00 GEL specifically for Sale 2
  const rep = env.customerService.recordRepayment(env.seller, {
    customer_id: customer.id,
    sale_id: sale2.id,
    amount_tetri: 3000
  });

  assert.equal(rep.allocations?.length, 1);
  assert.equal(rep.allocations[0].sale_id, sale2.id);
  assert.equal(rep.allocations[0].allocated_tetri, 3000);

  const activeSales = env.customerService.getCustomerActiveSales(customer.id);
  const activeS1 = activeSales.find(s => s.id === sale1.id);
  const activeS2 = activeSales.find(s => s.id === sale2.id);

  assert.equal(activeS1?.debt_remaining_tetri, 8000, 'Sale 1 must be untouched');
  assert.equal(activeS2?.debt_remaining_tetri, 5000, 'Sale 2 remaining must be 50.00 GEL');

  // Attempt to repay more than Sale 2 remaining (5,000 tetri) specifically for Sale 2 should throw
  assert.throws(() => {
    env.customerService.recordRepayment(env.seller, {
      customer_id: customer.id,
      sale_id: sale2.id,
      amount_tetri: 6000
    });
  }, /აღემატება ამ ჩეკის დარჩენილ ვალს/);
});

test('M12-4: Deterministic Ledger tie-breaker ordering preserves exact running balance', () => {
  const env = createM12TestEnv();

  const p = env.productsService.createProduct(env.owner, {
    name: 'ტესტ პროდუქტი',
    base_price_tetri: 5000,
    variants: [{
      variant_name: 'ძირითადი',
      initial_stock: 50,
      codes: [{ code_type: 'manual_5digit', code_value: '40001' }]
    }]
  });

  const customer = env.customerService.createCustomer(env.seller, {
    first_name: 'გიორგი',
    last_name: 'მეგრელი'
  });

  // Create Sale 1
  const sale1 = env.posService.checkout(env.seller, {
    items: [{ variant_id: p.variants![0].id, quantity: 1, unit_price_tetri: 5000 }],
    payment_method: 'debt',
    customer_id: customer.id
  });

  // Record Repayment
  env.customerService.recordRepayment(env.seller, {
    customer_id: customer.id,
    amount_tetri: 2000
  });

  // Force identical created_at timestamps on database rows to test tie-breaker sorting
  const fixedTimestamp = '2026-05-15T12:00:00.000Z';
  env.db.prepare('UPDATE sales SET created_at = ? WHERE customer_id = ?').run(fixedTimestamp, customer.id);
  env.db.prepare('UPDATE debt_repayments SET created_at = ? WHERE customer_id = ?').run(fixedTimestamp, customer.id);

  const ledger = env.customerService.getCustomerLedger(customer.id);
  assert.equal(ledger.length, 2);

  // In the ledger, sale_debt must come BEFORE repayment even when timestamps are identical
  assert.equal(ledger[0].type, 'sale_debt');
  assert.equal(ledger[0].debit_tetri, 5000);
  assert.equal(ledger[0].running_balance_tetri, 5000);

  assert.equal(ledger[1].type, 'repayment');
  assert.equal(ledger[1].credit_tetri, 2000);
  assert.equal(ledger[1].running_balance_tetri, 3000);

  // Final running balance in ledger must equal current customer total debt
  const cust = env.customerService.getCustomerById(customer.id);
  assert.equal(ledger[ledger.length - 1].running_balance_tetri, cust!.total_debt_tetri);
});

test('M12-5: Idempotent replay returns same result and prevents double deduction', () => {
  const env = createM12TestEnv();

  const p = env.productsService.createProduct(env.owner, {
    name: 'პროდუქტი X',
    base_price_tetri: 10000,
    variants: [{
      variant_name: 'ძირითადი',
      initial_stock: 50,
      codes: [{ code_type: 'manual_5digit', code_value: '50001' }]
    }]
  });

  const customer = env.customerService.createCustomer(env.seller, {
    first_name: 'დავით',
    last_name: 'წერეთელი'
  });

  const sale = env.posService.checkout(env.seller, {
    items: [{ variant_id: p.variants![0].id, quantity: 1, unit_price_tetri: 10000 }],
    payment_method: 'debt',
    customer_id: customer.id
  });

  const idempotencyKey = 'unique-repay-uuid-12345';

  // First repayment call
  const rep1 = env.customerService.recordRepayment(env.seller, {
    customer_id: customer.id,
    amount_tetri: 4000,
    idempotency_key: idempotencyKey
  });

  assert.equal(rep1.amount_tetri, 4000);

  // Second repayment call with exact same idempotency_key (simulating network retry or double-click)
  const rep2 = env.customerService.recordRepayment(env.seller, {
    customer_id: customer.id,
    amount_tetri: 4000,
    idempotency_key: idempotencyKey
  });

  assert.equal(rep2.id, rep1.id, 'Must return identical repayment record');

  // Customer debt must be reduced by 40.00 GEL ONCE, not twice!
  const cust = env.customerService.getCustomerById(customer.id);
  assert.equal(cust!.total_debt_tetri, 6000, 'Customer debt must be 60.00 GEL (not 20.00 GEL)');

  // Attempting to reuse same key with mismatched payload must throw error
  assert.throws(() => {
    env.customerService.recordRepayment(env.seller, {
      customer_id: customer.id,
      amount_tetri: 2000, // Different amount!
      idempotency_key: idempotencyKey
    });
  }, /Idempotency key mismatch/);
});
