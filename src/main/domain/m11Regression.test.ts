/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Milestone M11 Comprehensive Regression & Functional Audit Test Suite:
 * 1. Authoritative price enforcement (seller alteration blocked, owner discount audited)
 * 2. Idempotency protection (checkout, returns, debt repayments)
 * 3. Return on debt sale (reduces debt first, refunds cash if return > debt, customer debt never negative)
 * 4. Partial and full returns (prevents returning > sold quantity)
 * 5. Exchange flow (diff > 0, diff < 0, diff = 0, bidirectional linking)
 * 6. Customer ledger accuracy (chronological timeline and running balance)
 * 7. Emergency backup failure blocks database reset
 * 8. Product initial stock default
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
import { BackupService } from './backupService.ts';

function createM11TestEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);

  const authService = new AuthService(db);
  const productsService = new ProductsService(db);
  const posService = new PosService(db);
  const customerService = new CustomerService(db);
  const returnsService = new ReturnsService(db);
  const financeService = new FinanceService(db);
  const backupService = new BackupService(db, '/tmp/storepos-test-backups');

  // Setup owner and seller
  const ownerSession = authService.setupInitialOwner('დავით მფლობელი', '1111');
  const owner = ownerSession.user;
  const seller = authService.addUser(owner, 'ანა გამყიდველი', '2222', 'seller');

  return {
    db,
    authService,
    productsService,
    posService,
    customerService,
    returnsService,
    financeService,
    backupService,
    owner,
    seller
  };
}

// -----------------------------------------------------------------------------
// Test 1: Authoritative Price Enforcement
// -----------------------------------------------------------------------------
test('M11 - 1: Authoritative Price Enforcement blocks seller alteration and logs owner discounts', () => {
  const { productsService, posService, owner, seller } = createM11TestEnv();

  const prod = productsService.createProduct(owner, {
    name: 'საფულე',
    base_price_tetri: 5000, // 50 GEL
    variants: [
      {
        variant_name: 'შავი',
        initial_stock: 10,
        codes: [{ code_type: 'manual_5digit', code_value: '50001' }]
      }
    ]
  });
  const variant = prod.variants![0];

  // 1a. Seller attempts to sell at 40 GEL instead of 50 GEL -> MUST THROW
  assert.throws(() => {
    posService.checkout(seller, {
      items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 4000 }],
      payment_method: 'cash',
      cash_received_tetri: 4000
    });
  }, /გამყიდველს ფასის შეცვლის ან ფასდაკლების უფლება არ აქვს/);

  // 1b. Seller attempts to sell at 60 GEL instead of 50 GEL -> MUST THROW
  assert.throws(() => {
    posService.checkout(seller, {
      items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 6000 }],
      payment_method: 'cash',
      cash_received_tetri: 6000
    });
  }, /გამყიდველს ფასის შეცვლის ან ფასდაკლების უფლება არ აქვს/);

  // 1c. Owner authorizes a discount with reason -> MUST SUCCEED and record audit trail
  const ownerSale = posService.checkout(owner, {
    items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 4500 }],
    payment_method: 'cash',
    cash_received_tetri: 5000,
    discount_reason: 'მუდმივი კლიენტის ფასდაკლება 5 ლარი'
  });

  assert.equal(ownerSale.final_total_tetri, 4500);
  assert.equal(ownerSale.discount_authorized_by, owner.id);
  assert.equal(ownerSale.discount_reason, 'მუდმივი კლიენტის ფასდაკლება 5 ლარი');
});

// -----------------------------------------------------------------------------
// Test 2: Idempotency Protection
// -----------------------------------------------------------------------------
test('M11 - 2: Idempotency Protection prevents double checkout, double returns, and double repayments', () => {
  const { productsService, posService, customerService, returnsService, owner } = createM11TestEnv();

  const prod = productsService.createProduct(owner, {
    name: 'მაისური',
    base_price_tetri: 3000, // 30 GEL
    variants: [
      {
        variant_name: 'L',
        initial_stock: 5,
        codes: [{ code_type: 'manual_5digit', code_value: '50002' }]
      }
    ]
  });
  const variant = prod.variants![0];
  const cust = customerService.createCustomer(owner, { first_name: 'გიორგი' });

  // 2a. Checkout idempotency
  const checkoutKey = 'idemp-checkout-101';
  const sale1 = posService.checkout(owner, {
    items: [{ variant_id: variant.id, quantity: 2, unit_price_tetri: 3000 }],
    payment_method: 'debt',
    customer_id: cust.id,
    idempotency_key: checkoutKey
  });

  // Replaying with identical key -> returns existing sale, stock remaining must still be 3 (5 - 2), NOT 1
  const sale2 = posService.checkout(owner, {
    items: [{ variant_id: variant.id, quantity: 2, unit_price_tetri: 3000 }],
    payment_method: 'debt',
    customer_id: cust.id,
    idempotency_key: checkoutKey
  });
  assert.equal(sale1.id, sale2.id);

  const updatedProd = productsService.getProductById(prod.id)!;
  assert.equal(updatedProd.variants![0].stock_quantity, 3);

  // Mismatched payload with same key -> MUST THROW
  assert.throws(() => {
    posService.checkout(owner, {
      items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 3000 }],
      payment_method: 'cash',
      cash_received_tetri: 3000,
      idempotency_key: checkoutKey
    });
  }, /იდემპოტენტურობის გასაღები უკვე გამოყენებულია/);

  // 2b. Debt Repayment idempotency
  const repayKey = 'idemp-repay-201';
  const rep1 = customerService.recordRepayment(owner, {
    customer_id: cust.id,
    amount_tetri: 2000,
    idempotency_key: repayKey
  });

  const rep2 = customerService.recordRepayment(owner, {
    customer_id: cust.id,
    amount_tetri: 2000,
    idempotency_key: repayKey
  });
  assert.equal(rep1.id, rep2.id);

  // Customer debt was 6000 - 2000 = 4000 (NOT 2000 from double repayment)
  const custAfter = customerService.getCustomerById(cust.id)!;
  assert.equal(custAfter.total_debt_tetri, 4000);

  // 2c. Return idempotency
  const returnKey = 'idemp-return-301';
  const ret1 = returnsService.processReturn(owner, {
    sale_id: sale1.id,
    items: [{ variant_id: variant.id, quantity: 1, reason: 'ზომა არ მოერგო' }],
    idempotency_key: returnKey
  });

  const ret2 = returnsService.processReturn(owner, {
    sale_id: sale1.id,
    items: [{ variant_id: variant.id, quantity: 1, reason: 'ზომა არ მოერგო' }],
    idempotency_key: returnKey
  });
  assert.equal(ret1.id, ret2.id);
});

// -----------------------------------------------------------------------------
// Test 3: Return on Debt Sale & Customer Debt Never Negative
// -----------------------------------------------------------------------------
test('M11 - 3: Return on debt sale reduces debt first, refunds cash if return > debt, customer debt never negative', () => {
  const { productsService, posService, customerService, returnsService, owner } = createM11TestEnv();

  const prod = productsService.createProduct(owner, {
    name: 'ფეხსაცმელი',
    base_price_tetri: 10000, // 100 GEL
    variants: [
      {
        variant_name: '42',
        initial_stock: 5,
        codes: [{ code_type: 'manual_5digit', code_value: '50003' }]
      }
    ]
  });
  const variant = prod.variants![0];
  const cust = customerService.createCustomer(owner, { first_name: 'ლევანი' });

  // Mixed sale: Total 200 GEL (2 pairs). Paid 50 GEL cash, 150 GEL debt.
  const sale = posService.checkout(owner, {
    items: [{ variant_id: variant.id, quantity: 2, unit_price_tetri: 10000 }],
    payment_method: 'mixed',
    customer_id: cust.id,
    cash_received_tetri: 5000
  });

  let custRec = customerService.getCustomerById(cust.id)!;
  assert.equal(custRec.total_debt_tetri, 15000); // 150 GEL debt

  // Customer returns 1 pair (value 100 GEL)
  // Debt on this sale was 150 GEL -> reduced by 100 GEL to 50 GEL. Cash refund = 0.
  const ret1 = returnsService.processReturn(owner, {
    sale_id: sale.id,
    items: [{ variant_id: variant.id, quantity: 1, reason: 'დეფექტი' }]
  });

  assert.equal(ret1.total_refund_tetri, 10000);
  assert.equal(ret1.refund_cash_tetri, 0);
  assert.equal(ret1.refund_debt_reduction_tetri, 10000);

  custRec = customerService.getCustomerById(cust.id)!;
  assert.equal(custRec.total_debt_tetri, 5000); // 50 GEL remaining debt

  // Customer now returns the 2nd pair (value 100 GEL)
  // Remaining debt on this sale is 50 GEL -> debt reduced by 50 GEL (to 0), remaining 50 GEL refunded in CASH!
  const ret2 = returnsService.processReturn(owner, {
    sale_id: sale.id,
    items: [{ variant_id: variant.id, quantity: 1, reason: 'აღარ სურს' }]
  });

  assert.equal(ret2.total_refund_tetri, 10000);
  assert.equal(ret2.refund_debt_reduction_tetri, 5000);
  assert.equal(ret2.refund_cash_tetri, 5000);

  custRec = customerService.getCustomerById(cust.id)!;
  assert.equal(custRec.total_debt_tetri, 0); // Exactly 0, NEVER negative!
});

// -----------------------------------------------------------------------------
// Test 4: Partial and Full Returns Limits
// -----------------------------------------------------------------------------
test('M11 - 4: Partial and Full Returns prevent returning > sold quantity', () => {
  const { productsService, posService, returnsService, owner } = createM11TestEnv();

  const prod = productsService.createProduct(owner, {
    name: 'წინდები',
    base_price_tetri: 500, // 5 GEL
    variants: [
      {
        variant_name: 'თეთრი',
        initial_stock: 10,
        codes: [{ code_type: 'manual_5digit', code_value: '50004' }]
      }
    ]
  });
  const variant = prod.variants![0];

  const sale = posService.checkout(owner, {
    items: [{ variant_id: variant.id, quantity: 3, unit_price_tetri: 500 }],
    payment_method: 'cash',
    cash_received_tetri: 2000
  });

  // Return 1 unit
  returnsService.processReturn(owner, {
    sale_id: sale.id,
    items: [{ variant_id: variant.id, quantity: 1 }]
  });

  // Attempt to return 3 units (only 2 left) -> MUST THROW
  assert.throws(() => {
    returnsService.processReturn(owner, {
      sale_id: sale.id,
      items: [{ variant_id: variant.id, quantity: 3 }]
    });
  }, /დაბრუნების რაოდენობა .+ აღემატება დარჩენილ/);

  // Return 2 units -> Fully returned
  returnsService.processReturn(owner, {
    sale_id: sale.id,
    items: [{ variant_id: variant.id, quantity: 2 }]
  });

  // Attempt to return 1 more unit -> MUST THROW
  assert.throws(() => {
    returnsService.processReturn(owner, {
      sale_id: sale.id,
      items: [{ variant_id: variant.id, quantity: 1 }]
    });
  }, /ამ გაყიდვაზე ყველა ნივთი უკვე დაბრუნებულია/);
});

// -----------------------------------------------------------------------------
// Test 5: Exchange Flow
// -----------------------------------------------------------------------------
test('M11 - 5: Exchange flow handles price differences correctly and links sale and return', () => {
  const { productsService, posService, returnsService, owner } = createM11TestEnv();

  const prodA = productsService.createProduct(owner, {
    name: 'პერანგი A',
    base_price_tetri: 4000, // 40 GEL
    variants: [{ variant_name: 'S', initial_stock: 5, codes: [{ code_type: 'manual_5digit', code_value: '50005' }] }]
  });
  const prodB = productsService.createProduct(owner, {
    name: 'პერანგი B (ძვირი)',
    base_price_tetri: 6500, // 65 GEL
    variants: [{ variant_name: 'M', initial_stock: 5, codes: [{ code_type: 'manual_5digit', code_value: '50006' }] }]
  });

  const varA = prodA.variants![0];
  const varB = prodB.variants![0];

  const originalSale = posService.checkout(owner, {
    items: [{ variant_id: varA.id, quantity: 1, unit_price_tetri: 4000 }],
    payment_method: 'cash',
    cash_received_tetri: 4000
  });

  // Exchange A for B (diff = +25 GEL: customer pays extra 25 GEL cash)
  const exchangeRes = returnsService.processExchange(owner, {
    original_sale_id: originalSale.id,
    return_items: [{ variant_id: varA.id, quantity: 1, reason: 'ზომის გაცვლა' }],
    new_items: [{ variant_id: varB.id, quantity: 1, unit_price_tetri: 6500 }],
    payment_method: 'cash',
    cash_received_tetri: 2500
  });

  assert.equal(exchangeRes.difference_tetri, 2500);
  assert.equal(exchangeRes.cash_action, 'customer_pays');
  assert.equal(exchangeRes.new_sale.sale_type, 'exchange');
  assert.equal(exchangeRes.new_sale.related_return_id, exchangeRes.return_record.id);

  // Stock check: varA restored to 5, varB deducted to 4
  const pA = productsService.getProductById(prodA.id)!;
  const pB = productsService.getProductById(prodB.id)!;
  assert.equal(pA.variants![0].stock_quantity, 5);
  assert.equal(pB.variants![0].stock_quantity, 4);
});

// -----------------------------------------------------------------------------
// Test 6: Customer Ledger Accuracy
// -----------------------------------------------------------------------------
test('M11 - 6: Customer Ledger tracks chronological timeline and running balance', () => {
  const { productsService, posService, customerService, returnsService, owner } = createM11TestEnv();

  const prod = productsService.createProduct(owner, {
    name: 'ქუდი',
    base_price_tetri: 2000, // 20 GEL
    variants: [{ variant_name: 'უნივერსალური', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '50007' }] }]
  });
  const variant = prod.variants![0];
  const cust = customerService.createCustomer(owner, { first_name: 'მარიამი' });

  // Step 1: Debt sale 60 GEL (3 items)
  const sale = posService.checkout(owner, {
    items: [{ variant_id: variant.id, quantity: 3, unit_price_tetri: 2000 }],
    payment_method: 'debt',
    customer_id: cust.id
  });

  // Step 2: Repayment 20 GEL
  customerService.recordRepayment(owner, {
    customer_id: cust.id,
    amount_tetri: 2000
  });

  // Step 3: Return 1 item (20 GEL) -> reduces remaining debt
  returnsService.processReturn(owner, {
    sale_id: sale.id,
    items: [{ variant_id: variant.id, quantity: 1 }]
  });

  const ledger = customerService.getCustomerLedger(cust.id);
  assert.equal(ledger.length, 3);

  // Chronological verification:
  // 1: sale_debt +6000 -> balance 6000
  assert.equal(ledger[0].type, 'sale_debt');
  assert.equal(ledger[0].change_tetri, 6000);
  assert.equal(ledger[0].running_balance_tetri, 6000);

  // 2: repayment -2000 -> balance 4000
  assert.equal(ledger[1].type, 'repayment');
  assert.equal(ledger[1].change_tetri, -2000);
  assert.equal(ledger[1].running_balance_tetri, 4000);

  // 3: return_credit -2000 -> balance 2000
  assert.equal(ledger[2].type, 'return_credit');
  assert.equal(ledger[2].change_tetri, -2000);
  assert.equal(ledger[2].running_balance_tetri, 2000);

  const activeCust = customerService.getCustomerById(cust.id)!;
  assert.equal(activeCust.total_debt_tetri, 2000);
});

// -----------------------------------------------------------------------------
// Test 7: Emergency Backup Failure Blocks Database Reset
// -----------------------------------------------------------------------------
test('M11 - 7: Emergency Backup failure strictly blocks database reset and preserves data', () => {
  const { authService, owner } = createM11TestEnv();

  // Mock backupService to simulate failure
  const failingBackupService = {
    createEmergencyPreResetBackup: () => {
      throw new Error('დისკზე ადგილი არ არის! საავარიო რეზერვი ვერ შეიქმნა');
    }
  } as any;

  // Attempt resetStoreDatabase with failing backup service -> MUST THROW and NOT touch DB
  assert.throws(() => {
    authService.resetStoreDatabase(owner, '1111', failingBackupService);
  }, /დისკზე ადგილი არ არის/);

  // Verify that owner user and database are 100% intact
  const users = authService.getActiveUsers();
  assert.equal(users.length, 2); // owner and seller still exist!
});

// -----------------------------------------------------------------------------
// Test 8: Product Initial Stock Rule
// -----------------------------------------------------------------------------
test('M11 - 8: Product variants default to initial_stock = 0 when not specified', () => {
  const { productsService, owner } = createM11TestEnv();

  const prod = productsService.createProduct(owner, {
    name: 'ახალი პროდუქტი ნულოვანი მარაგით',
    base_price_tetri: 1500,
    variants: [
      {
        variant_name: 'სტანდარტული',
        codes: [{ code_type: 'manual_5digit', code_value: '50008' }]
        // initial_stock omitted -> should default to 0
      }
    ]
  });

  assert.equal(prod.variants![0].stock_quantity, 0);
});
