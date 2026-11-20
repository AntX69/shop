/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Comprehensive Granular Staff Permissions Integration Test Suite.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AuthService } from './authService.ts';
import { ProductsService } from './productsService.ts';
import { handleIpcMessage } from '../ipc/handlers.ts';
import { initDatabase, closeDatabase, getDb } from '../db/database.ts';
import { DEFAULT_SELLER_PERMISSIONS } from '../../shared/permissions.ts';

describe('Feature A: Granular Staff Permissions', () => {
  let db: DatabaseSync;
  let authService: AuthService;

  before(() => {
    closeDatabase();
    process.env.STORE_DB_PATH = ':memory:';
    db = initDatabase(':memory:');
    authService = new AuthService(db);
  });

  after(() => {
    closeDatabase();
    delete process.env.STORE_DB_PATH;
  });

  it('initializes owner with full access', () => {
    const ownerSession = authService.setupInitialOwner('Owner User', '1234');
    const owner = ownerSession.user;
    assert.equal(owner.role, 'owner');

    // Owner has any arbitrary permission
    assert.equal(authService.hasPermission(owner, 'sales.create'), true);
    assert.equal(authService.hasPermission(owner, 'reports.financial'), true);
    assert.equal(authService.hasPermission(owner, 'any.custom.perm'), true);
  });

  it('creates new seller with DEFAULT_SELLER_PERMISSIONS', () => {
    const owner = authService.getUserById(1)!;
    const seller = authService.addUser(owner, 'Seller Default', '4321', 'seller');
    assert.equal(seller.role, 'seller');

    const perms = authService.getUserPermissions(seller.id);
    assert.deepEqual(perms.sort(), [...DEFAULT_SELLER_PERMISSIONS].sort());
    assert.equal(authService.hasPermission(seller, 'sales.create'), true);
    assert.equal(authService.hasPermission(seller, 'reports.financial'), false);
    assert.equal(authService.hasPermission(seller, 'products.create'), false);
  });

  it('allows owner to configure different permissions for Seller A and Seller B', () => {
    const owner = authService.getUserById(1)!;
    const sellerA = authService.addUser(owner, 'Seller A', '1111', 'seller');
    const sellerB = authService.addUser(owner, 'Seller B', '2222', 'seller');

    // Seller A: sales, debts, repayments. NO products, NO reports.
    authService.setUserPermissions(owner, sellerA.id, [
      'sales.create',
      'debts.create',
      'debts.repayment'
    ]);

    // Seller B: sales, returns, products.create. NO debts.create.
    authService.setUserPermissions(owner, sellerB.id, [
      'sales.create',
      'sales.return',
      'products.create'
    ]);

    assert.equal(authService.hasPermission(sellerA, 'debts.create'), true);
    assert.equal(authService.hasPermission(sellerA, 'products.create'), false);

    assert.equal(authService.hasPermission(sellerB, 'debts.create'), false);
    assert.equal(authService.hasPermission(sellerB, 'products.create'), true);
    assert.equal(authService.hasPermission(sellerB, 'sales.return'), true);
  });

  it('enforces permission checks at domain layer (e.g. ProductsService)', () => {
    const owner = authService.getUserById(1)!;
    const seller = authService.addUser(owner, 'Seller Restricted', '3333', 'seller');
    authService.setUserPermissions(owner, seller.id, ['sales.create']);

    const prodService = new ProductsService(db);

    // Creating product requires products.create
    assert.throws(
      () => prodService.createProduct(seller, {
        name: 'Test Product',
        base_price_tetri: 100,
        variants: [{ variant_name: 'სტანდარტული', codes: [{ code_type: 'barcode', code_value: '1234567890123' }] }]
      }),
      /უფლება არ გაქვთ/
    );

    // Grant products.create
    authService.setUserPermissions(owner, seller.id, ['sales.create', 'products.create']);
    const refreshedSeller = authService.getUserById(seller.id)!;
    const prod = prodService.createProduct(refreshedSeller, {
      name: 'Test Product',
      base_price_tetri: 100,
      variants: [{ variant_name: 'სტანდარტული', codes: [{ code_type: 'barcode', code_value: '1234567890123' }] }]
    });
    assert.equal(prod.name, 'Test Product');
  });

  it('enforces permission checks at IPC routing layer', async () => {
    const ownerLogin = authService.login(1, '1234');
    const ownerToken = ownerLogin.token;

    // Create seller
    const owner = authService.getUserById(1)!;
    const seller = authService.addUser(owner, 'IPC Seller', '5555', 'seller');
    authService.setUserPermissions(owner, seller.id, ['sales.create', 'products.view']);

    const sellerLogin = authService.login(seller.id, '5555');
    const sellerToken = sellerLogin.token;

    // 1. Seller calling owner-only route (e.g. auth:addUser) must be rejected
    const resAddUser = await handleIpcMessage({
      channel: 'auth:addUser',
      token: sellerToken,
      payload: { name: 'Hacker', pin: '9999', role: 'seller' }
    });
    assert.equal(resAddUser.success, false);
    assert.match(resAddUser.error!, /მხოლოდ მფლობელს/);

    // 2. Seller calling route requiring ungranted permission (e.g. finance:summary)
    const resFinance = await handleIpcMessage({
      channel: 'finance:summary',
      token: sellerToken,
      payload: { preset: 'today' }
    });
    assert.equal(resFinance.success, false);
    assert.match(resFinance.error!, /არ გაქვთ ამ მოქმედების შესრულების უფლება/);

    // 3. Seller calling route with granted permission (e.g. products:list)
    const resProducts = await handleIpcMessage({
      channel: 'products:list',
      token: sellerToken,
      payload: {}
    });
    assert.equal(resProducts.success, true);
  });

  it('immediate enforcement on active sessions without application restart', async () => {
    const owner = authService.getUserById(1)!;
    const seller = authService.addUser(owner, 'Live Seller', '6666', 'seller');
    authService.setUserPermissions(owner, seller.id, ['sales.create', 'expenses.manage']);

    // Seller logs in
    const sellerLogin = authService.login(seller.id, '6666');
    const sellerToken = sellerLogin.token;

    // Can create expense
    const resExpense1 = await handleIpcMessage({
      channel: 'finance:createExpense',
      token: sellerToken,
      payload: { description: 'Office paper', amount_tetri: 1500, category: 'საკანცელარიო' }
    });
    assert.equal(resExpense1.success, true);

    // Owner revokes expenses.manage in real time
    authService.setUserPermissions(owner, seller.id, ['sales.create']);

    // Next request from already-active session is immediately rejected!
    const resExpense2 = await handleIpcMessage({
      channel: 'finance:createExpense',
      token: sellerToken,
      payload: { description: 'Coffee beans', amount_tetri: 2000, category: 'საკვები' }
    });
    assert.equal(resExpense2.success, false);
    assert.match(resExpense2.error!, /არ გაქვთ ამ მოქმედების შესრულების უფლება/);
  });

  it('prevents seller from granting permissions to self or others', async () => {
    const owner = authService.getUserById(1)!;
    const seller = authService.addUser(owner, 'Self Grant Seller', '7777', 'seller');
    const sellerLogin = authService.login(seller.id, '7777');
    const sellerToken = sellerLogin.token;

    // Direct domain call throws
    assert.throws(
      () => authService.setUserPermissions(seller, seller.id, ['reports.financial']),
      /მხოლოდ მფლობელს/
    );

    // IPC call rejects
    const res = await handleIpcMessage({
      channel: 'auth:setUserPermissions',
      token: sellerToken,
      payload: { userId: seller.id, permissions: ['reports.financial'] }
    });
    assert.equal(res.success, false);
    assert.match(res.error!, /მხოლოდ მფლობელს/);
  });
});
