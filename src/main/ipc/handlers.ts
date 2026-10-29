/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Central IPC Handlers & Dispatcher.
 * Validates session tokens, enforces backend permissions, and invokes domain services.
 * Renderer NEVER has raw database or file system access.
 */

import { AuthService, getActiveSession } from '../domain/authService.ts';
import { ProductsService } from '../domain/productsService.ts';
import { PosService } from '../domain/posService.ts';
import { InventoryService } from '../domain/inventoryService.ts';
import { CustomerService } from '../domain/customerService.ts';
import { ReturnsService } from '../domain/returnsService.ts';
import { FinanceService } from '../domain/financeService.ts';
import { BackupService } from '../domain/backupService.ts';
import { OcrService } from '../domain/ocrService.ts';
import { getDb } from '../db/database.ts';
import { User } from '../../shared/types.ts';

export interface IpcRequest {
  channel: string;
  payload?: any;
  token?: string;
}

export interface IpcResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export async function handleIpcMessage(req: IpcRequest): Promise<IpcResponse> {
  try {
    const { channel, payload, token } = req;
    const authService = new AuthService();
    const productsService = new ProductsService();
    const posService = new PosService();
    const inventoryService = new InventoryService();
    const customerService = new CustomerService();
    const returnsService = new ReturnsService();
    const financeService = new FinanceService();
    const backupService = new BackupService();

    // 1. Public channels that do not require an active user session:
    if (channel === 'auth:hasOwner') {
      return { success: true, data: authService.hasOwner() };
    }
    if (channel === 'auth:setupOwner') {
      const session = authService.setupInitialOwner(payload.name, payload.pin);
      return { success: true, data: session };
    }
    if (channel === 'auth:getActiveUsers') {
      return { success: true, data: authService.getActiveUsers() };
    }
    if (channel === 'auth:login') {
      const session = authService.login(payload.userId, payload.pin);
      return { success: true, data: session };
    }

    // 2. All subsequent channels REQUIRE a valid session token
    if (!token) {
      return { success: false, error: 'ავტორიზაცია არ არის გავლილი (No token)' };
    }

    const currentUser: User | null = getActiveSession(token);
    if (!currentUser) {
      return { success: false, error: 'სესია ვადაგასულია, გთხოვთ ხელახლა შეიყვანოთ PIN კოდი' };
    }

    // 3. User & Staff Management
    if (channel === 'auth:getAllUsers') {
      return { success: true, data: authService.getAllUsers(currentUser) };
    }
    if (channel === 'auth:addUser') {
      return { success: true, data: authService.addUser(currentUser, payload.name, payload.pin, payload.role) };
    }
    if (channel === 'auth:setUserActive') {
      authService.setUserActive(currentUser, payload.userId, payload.isActive);
      return { success: true };
    }
    if (channel === 'auth:resetPin') {
      authService.resetPin(currentUser, payload.userId, payload.newPin);
      return { success: true };
    }

    // 4. Products & Categories
    if (channel === 'products:getCategories') {
      return { success: true, data: productsService.getCategories() };
    }
    if (channel === 'products:createCategory') {
      return { success: true, data: productsService.createCategory(currentUser, payload.name) };
    }
    if (channel === 'products:deleteCategory') {
      productsService.deleteCategory(currentUser, payload.categoryId);
      return { success: true };
    }
    if (channel === 'products:list') {
      return { success: true, data: productsService.listProducts(payload) };
    }
    if (channel === 'products:getById') {
      return { success: true, data: productsService.getProductById(payload.productId) };
    }
    if (channel === 'products:lookupCode') {
      return { success: true, data: productsService.lookupByCode(payload.code) };
    }
    if (channel === 'ocr:isModelReady') {
      const session = await OcrService.getSession();
      return { success: true, data: { ready: !!session, model: 'mnist.onnx' } };
    }
    if (channel === 'ocr:recognize') {
      const ocrService = new OcrService();
      const res = await ocrService.recognize5Digits(payload.pixels, payload.width, payload.height);
      return { success: true, data: res };
    }
    if (channel === 'products:create') {
      return { success: true, data: productsService.createProduct(currentUser, payload) };
    }
    if (channel === 'products:addImage') {
      return { success: true, data: productsService.addImage(currentUser, payload.productId, payload.filePath, payload.isPrimary) };
    }
    if (channel === 'products:deleteImage') {
      productsService.deleteImage(currentUser, payload.imageId);
      return { success: true, data: { deleted: true } };
    }

    // 5. Inventory
    if (channel === 'inventory:restock') {
      return { success: true, data: inventoryService.restockVariant(currentUser, payload) };
    }
    if (channel === 'inventory:correct') {
      return { success: true, data: inventoryService.correctStock(currentUser, payload) };
    }
    if (channel === 'inventory:getMovements') {
      return { success: true, data: inventoryService.getMovements(payload?.variantId, payload?.limit) };
    }

    // 6. POS & Checkout
    if (channel === 'pos:checkout') {
      return { success: true, data: posService.checkout(currentUser, payload) };
    }
    if (channel === 'pos:searchSales') {
      return { success: true, data: posService.searchSales(payload) };
    }
    if (channel === 'pos:getSale') {
      return { success: true, data: posService.getSaleById(payload.saleId) };
    }

    // 7. Customers & Debts
    if (channel === 'customers:list') {
      return { success: true, data: customerService.listCustomers(payload?.searchTerm) };
    }
    if (channel === 'customers:get') {
      return { success: true, data: customerService.getCustomerById(payload.customerId) };
    }
    if (channel === 'customers:create') {
      return { success: true, data: customerService.createCustomer(currentUser, payload) };
    }
    if (channel === 'customers:repay') {
      return { success: true, data: customerService.recordRepayment(currentUser, payload) };
    }
    if (channel === 'customers:getRepayments') {
      return { success: true, data: customerService.getRepayments(payload.customerId) };
    }

    // 8. Returns & Exchanges
    if (channel === 'returns:process') {
      return { success: true, data: returnsService.processReturn(currentUser, payload) };
    }
    if (channel === 'returns:exchange') {
      return { success: true, data: returnsService.processExchange(currentUser, payload) };
    }

    // 9. Finance & Expenses (Owner Only)
    if (channel === 'finance:summary') {
      return { success: true, data: financeService.getFinancialSummary(currentUser, payload?.startDate, payload?.endDate) };
    }
    if (channel === 'finance:createExpense') {
      return { success: true, data: financeService.createExpense(currentUser, payload) };
    }
    if (channel === 'finance:listExpenses') {
      return { success: true, data: financeService.listExpenses(currentUser, payload?.limit) };
    }
    if (channel === 'finance:exportSalesCSV') {
      return { success: true, data: financeService.exportSalesCSV(currentUser) };
    }

    // 10. Backup & Settings
    if (channel === 'backup:create') {
      return { success: true, data: backupService.createBackup(currentUser, payload?.targetDir) };
    }
    if (channel === 'backup:list') {
      return { success: true, data: backupService.listBackups(currentUser) };
    }
    if (channel === 'backup:verify') {
      return { success: true, data: backupService.verifyBackup(currentUser, payload?.dataString, payload?.filename) };
    }
    if (channel === 'backup:runDaily') {
      return { success: true, data: backupService.checkAndRunDailyBackup(currentUser) };
    }
    if (channel === 'backup:restore') {
      return { success: true, data: backupService.restoreBackup(currentUser, payload.base64Data, payload.expectedChecksum) };
    }
    if (channel === 'backup:getLogs') {
      return { success: true, data: backupService.getAuditLogs(payload?.limit) };
    }
    if (channel === 'backup:getSettings') {
      return { success: true, data: backupService.getSettings() };
    }
    if (channel === 'backup:updateSettings') {
      backupService.updateSettings(currentUser, payload.settings);
      return { success: true };
    }
    if (channel === 'system:getErrorLogs') {
      return { success: true, data: backupService.getErrorLogs(payload?.limit) };
    }
    if (channel === 'system:clearErrorLogs') {
      backupService.clearErrorLogs(currentUser);
      return { success: true };
    }

    if (channel === 'auth:resetStoreDatabase') {
      authService.resetStoreDatabase(currentUser, payload?.pin);
      return { success: true };
    }

    return { success: false, error: `უცნობი IPC არხი: "${channel}"` };
  } catch (err: any) {
    const isValidationErr = err.message && (
      err.message.includes('PIN') || 
      err.message.includes('მარაგი') || 
      err.message.includes('ფორმატი') ||
      err.message.includes('ნაკლებია') ||
      err.message.includes('სავალდებულოა')
    );
    if (isValidationErr) {
      console.log(`[IPC Validation in ${req.channel}]: ${err.message}`);
    } else {
      console.error(`[IPC Error in ${req.channel}]:`, err);
      try {
        new BackupService().logSystemError(req.channel, err.message, err.stack, 'error');
      } catch {}
    }
    return {
      success: false,
      error: err.message || 'დაფიქსირდა სისტემური შეცდომა'
    };
  }
}
