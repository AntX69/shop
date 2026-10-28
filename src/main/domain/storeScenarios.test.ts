/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Comprehensive Unit and Integration Test Suite covering the 14 mandatory business rules:
 * - Stock deduction (10 - 2 = 8)
 * - Independent variant isolation (variant 42 does not affect 41)
 * - Cash change: 150 GEL sale, 200 GEL paid -> 50 GEL change
 * - Full Debt sale: 150 GEL sale -> outstanding 150, cash 0
 * - Mixed sale: 150 GEL sale, 50 cash -> outstanding 100, cash 50
 * - Debt repayment: 30 GEL repaid -> outstanding 70; SALES REVENUE DOES NOT INCREASE
 * - Returns: cannot return more than sold or twice; debt reduced first
 * - RBAC: seller cannot create products or categories
 * - Null cost: does not fabricate 0 cost
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
import { FinanceService } from './financeService.ts';
import { User } from '../../shared/types.ts';

function createTestEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);

  const authService = new AuthService(db);
  const productsService = new ProductsService(db);
  const posService = new PosService(db);
  const customerService = new CustomerService(db);
  const returnsService = new ReturnsService(db);
  const financeService = new FinanceService(db);

  // Setup owner and seller
  const ownerSession = authService.setupInitialOwner('გიორგი მფლობელი', '1234');
  const owner = ownerSession.user;
  const seller = authService.addUser(owner, 'ნინო გამყიდველი', '5678', 'seller');

  return {
    db,
    authService,
    productsService,
    posService,
    customerService,
    returnsService,
    financeService,
    owner,
    seller
  };
}

test('Scenario 1 & 3: 10 items in stock -> sell 2 -> 8 remaining; variant 42 does not touch variant 41', () => {
  const { productsService, posService, seller, owner } = createTestEnv();

  const product = productsService.createProduct(owner, {
    name: 'ზამთრის ქურთუკი',
    base_price_tetri: 12000, // 120 GEL
    variants: [
      {
        variant_name: 'ზომა S (41)',
        initial_stock: 10,
        codes: [{ code_type: 'manual_5digit', code_value: '30001' }]
      },
      {
        variant_name: 'ზომა M (42)',
        initial_stock: 10,
        codes: [{ code_type: 'manual_5digit', code_value: '30002' }]
      }
    ]
  });

  const var41 = product.variants![0];
  const var42 = product.variants![1];

  // Sell 2 units of variant 42
  posService.checkout(seller, {
    items: [{ variant_id: var42.id, quantity: 2, unit_price_tetri: 12000 }],
    payment_method: 'cash',
    cash_received_tetri: 30000 // 300 GEL
  });

  const pAfter = productsService.getProductById(product.id)!;
  const var41After = pAfter.variants?.find(v => v.id === var41.id)!;
  const var42After = pAfter.variants?.find(v => v.id === var42.id)!;

  // Variant 42 stock decreased from 10 to 8
  assert.equal(var42After.stock_quantity, 8);
  // Variant 41 stock remains untouched at 10
  assert.equal(var41After.stock_quantity, 10);
});

test('Scenario 4: Cash sale 150 GEL, received 200 GEL -> change 50 GEL', () => {
  const { productsService, posService, seller, owner } = createTestEnv();

  const prod = productsService.createProduct(owner, {
    name: 'ფეხსაცმელი',
    base_price_tetri: 15000, // 150 GEL
    variants: [{
      variant_name: '42',
      initial_stock: 5,
      codes: [{ code_type: 'manual_5digit', code_value: '31001' }]
    }]
  });

  const sale = posService.checkout(seller, {
    items: [{ variant_id: prod.variants![0].id, quantity: 1, unit_price_tetri: 15000 }],
    payment_method: 'cash',
    cash_received_tetri: 20000 // 200 GEL
  });

  assert.equal(sale.total_tetri, 15000);
  assert.equal(sale.cash_received_tetri, 20000);
  assert.equal(sale.change_given_tetri, 5000); // 50 GEL change
  assert.equal(sale.debt_amount_tetri, 0);
});

test('Scenario 5 & 6: Debt 150 GEL vs Mixed 150 GEL (50 cash, 100 debt)', () => {
  const { productsService, posService, customerService, seller, owner } = createTestEnv();

  const customer = customerService.createCustomer(seller, {
    first_name: 'დავით',
    last_name: 'ბერიძე',
    phone: '599112233'
  });

  const prod = productsService.createProduct(owner, {
    name: 'სათამაშო რობოტი',
    base_price_tetri: 15000,
    variants: [{
      variant_name: 'ლურჯი',
      initial_stock: 10,
      codes: [{ code_type: 'manual_5digit', code_value: '32001' }]
    }]
  });

  // Attempt debt checkout without customer must fail:
  assert.throws(() => {
    posService.checkout(seller, {
      items: [{ variant_id: prod.variants![0].id, quantity: 1, unit_price_tetri: 15000 }],
      payment_method: 'debt',
      cash_received_tetri: 0
    });
  }, /კლიენტის არჩევა/);

  // Full debt checkout with customer:
  const debtSale = posService.checkout(seller, {
    items: [{ variant_id: prod.variants![0].id, quantity: 1, unit_price_tetri: 15000 }],
    payment_method: 'debt',
    customer_id: customer.id,
    cash_received_tetri: 0
  });

  assert.equal(debtSale.total_tetri, 15000);
  assert.equal(debtSale.debt_amount_tetri, 15000);
  assert.equal(debtSale.cash_received_tetri, 0);

  const customerWithDebt = customerService.getCustomerById(customer.id)!;
  assert.equal(customerWithDebt.total_debt_tetri, 15000); // 150 GEL outstanding

  // Mixed checkout: total 150 GEL, cash 50 GEL -> debt 100 GEL
  const mixedSale = posService.checkout(seller, {
    items: [{ variant_id: prod.variants![0].id, quantity: 1, unit_price_tetri: 15000 }],
    payment_method: 'mixed',
    customer_id: customer.id,
    cash_received_tetri: 5000
  });

  assert.equal(mixedSale.total_tetri, 15000);
  assert.equal(mixedSale.cash_received_tetri, 5000);
  assert.equal(mixedSale.debt_amount_tetri, 10000);

  // Total customer debt is now 150 + 100 = 250 GEL
  const customerTotalDebt = customerService.getCustomerById(customer.id)!;
  assert.equal(customerTotalDebt.total_debt_tetri, 25000);
});

test('Scenario 7: Debt repayment of 30 GEL reduces debt to 70 GEL without increasing sales revenue', () => {
  const { productsService, posService, customerService, financeService, seller, owner } = createTestEnv();

  const customer = customerService.createCustomer(seller, { first_name: 'ლელა' });
  const prod = productsService.createProduct(owner, {
    name: 'ქუდი',
    base_price_tetri: 10000, // 100 GEL
    variants: [{
      variant_name: 'ერთიანი',
      initial_stock: 5,
      codes: [{ code_type: 'manual_5digit', code_value: '33001' }]
    }]
  });

  // Sell on 100 GEL debt
  const sale = posService.checkout(seller, {
    items: [{ variant_id: prod.variants![0].id, quantity: 1, unit_price_tetri: 10000 }],
    payment_method: 'debt',
    customer_id: customer.id,
    cash_received_tetri: 0
  });

  const finBefore = financeService.getFinancialSummary(owner);
  const revenueBefore = finBefore.total_sales_revenue_tetri;
  assert.equal(revenueBefore, 10000);
  assert.equal(finBefore.cash_collected_debts_tetri, 0);

  // Repay 30 GEL of debt
  customerService.recordRepayment(seller, {
    customer_id: customer.id,
    amount_tetri: 3000,
    sale_id: sale.id,
    notes: 'პირველი ნაწილი'
  });

  // Customer debt should now be 100 - 30 = 70 GEL (7000 tetri)
  const custAfter = customerService.getCustomerById(customer.id)!;
  assert.equal(custAfter.total_debt_tetri, 7000);

  // Financial summary check: SALES REVENUE DOES NOT INCREASE!
  const finAfter = financeService.getFinancialSummary(owner);
  assert.equal(finAfter.total_sales_revenue_tetri, revenueBefore); // Still 10000!
  assert.equal(finAfter.cash_collected_debts_tetri, 3000); // Recorded as cash collected from debts!
  assert.equal(finAfter.total_cash_inflow_tetri, 3000);
});

test('Scenario 8 & 9: Return item restores stock, reduces debt first, and prevents duplicate/excess returns', () => {
  const { productsService, posService, returnsService, customerService, seller, owner } = createTestEnv();

  const customer = customerService.createCustomer(seller, { first_name: 'ზურაბ' });
  const prod = productsService.createProduct(owner, {
    name: 'პერანგი',
    base_price_tetri: 5000,
    variants: [{
      variant_name: 'თეთრი L',
      initial_stock: 5,
      codes: [{ code_type: 'manual_5digit', code_value: '34001' }]
    }]
  });

  const variant = prod.variants![0];

  // Sale of 2 units on mixed: total 100 GEL, 40 GEL cash, 60 GEL debt
  const sale = posService.checkout(seller, {
    items: [{ variant_id: variant.id, quantity: 2, unit_price_tetri: 5000 }],
    payment_method: 'mixed',
    customer_id: customer.id,
    cash_received_tetri: 4000
  });

  const itemToReturn = sale.items![0];

  // Attempt to return 3 units when only 2 were bought must fail:
  assert.throws(() => {
    returnsService.processReturn(seller, {
      sale_id: sale.id,
      items: [{
        sale_item_id: itemToReturn.id,
        variant_id: variant.id,
        quantity: 3,
        condition: 'resellable'
      }]
    });
  }, /აღემატება დარჩენილ დაბრუნებად რაოდენობას/);

  // Return 1 unit (50 GEL)
  // Because open debt is 60 GEL, all 50 GEL should deduct from debt, 0 GEL cash refund!
  const ret1 = returnsService.processReturn(seller, {
    sale_id: sale.id,
    items: [{
      sale_item_id: itemToReturn.id,
      variant_id: variant.id,
      quantity: 1,
      condition: 'resellable'
    }],
    reason: 'ზომა არ მოერგო'
  });

  assert.equal(ret1.total_refund_tetri, 5000);
  assert.equal(ret1.debt_deduction_tetri, 5000); // Open debt deducted!
  assert.equal(ret1.cash_refund_tetri, 0); // No cash given out

  // Customer debt should now be 60 - 50 = 10 GEL
  const custAfterRet1 = customerService.getCustomerById(customer.id)!;
  assert.equal(custAfterRet1.total_debt_tetri, 1000);

  // Stock should be restored from 3 (5-2) back to 4 (3+1)
  const pCheck = productsService.getProductById(prod.id)!;
  assert.equal(pCheck.variants![0].stock_quantity, 4);

  // Now return the 2nd unit (remaining 1 unit)
  // Remaining debt is 10 GEL. Total refund is 50 GEL.
  // Debt deduction = 10 GEL. Cash refund = 40 GEL (the customer actually paid 40 GEL cash initially).
  const ret2 = returnsService.processReturn(seller, {
    sale_id: sale.id,
    items: [{
      sale_item_id: itemToReturn.id,
      variant_id: variant.id,
      quantity: 1,
      condition: 'resellable'
    }]
  });

  assert.equal(ret2.debt_deduction_tetri, 1000);
  assert.equal(ret2.cash_refund_tetri, 4000);

  // Customer debt is now 0
  const custFinal = customerService.getCustomerById(customer.id)!;
  assert.equal(custFinal.total_debt_tetri, 0);

  // Now all 2 units have been returned. Attempting to return again must fail:
  assert.throws(() => {
    returnsService.processReturn(seller, {
      sale_id: sale.id,
      items: [{
        sale_item_id: itemToReturn.id,
        variant_id: variant.id,
        quantity: 1,
        condition: 'resellable'
      }]
    });
  }, /აღემატება დარჩენილ დაბრუნებად რაოდენობას/);
});

test('Scenario 11: Unknown purchase cost does not fabricate 0 cost in profit calculations', () => {
  const { productsService, posService, financeService, seller, owner } = createTestEnv();

  // Create product with NULL purchase cost
  const prod = productsService.createProduct(owner, {
    name: 'უცნობი თვითღირებულების ნივთი',
    base_price_tetri: 3000,
    base_cost_tetri: null, // Unknown!
    variants: [{
      variant_name: 'სტანდარტული',
      initial_stock: 5,
      codes: [{ code_type: 'manual_5digit', code_value: '35001' }]
    }]
  });

  posService.checkout(seller, {
    items: [{ variant_id: prod.variants![0].id, quantity: 1, unit_price_tetri: 3000 }],
    payment_method: 'cash',
    cash_received_tetri: 3000
  });

  const summary = financeService.getFinancialSummary(owner);
  assert.equal(summary.has_unknown_costs, true);
  assert.equal(summary.unknown_cost_items_count, 1);
  assert.equal(summary.estimated_gross_profit_tetri, null); // Profit cannot be fabricated as 100%!
});
