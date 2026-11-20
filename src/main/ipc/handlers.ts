/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Central IPC Handlers & Dispatcher.
 * Validates session tokens, enforces backend permissions, and invokes domain services.
 * Renderer NEVER has raw database or file system access.
 *
 * Every channel declares who may call it (public, any logged-in user, owner only). Responses
 * to sellers are filtered here as well: purchase costs, COGS and profit never leave the main
 * process for a seller session, whatever a service returns. PIN hashes never leave it at all.
 */

import { AuthService } from '../domain/authService.ts';
import { ProductsService } from '../domain/productsService.ts';
import { PosService } from '../domain/posService.ts';
import { InventoryService } from '../domain/inventoryService.ts';
import { CustomerService } from '../domain/customerService.ts';
import { ReturnsService } from '../domain/returnsService.ts';
import { FinanceService } from '../domain/financeService.ts';
import { BackupService } from '../domain/backupService.ts';
import { OcrService } from '../domain/ocrService.ts';
import { saveOcrSample } from '../ocr/samples.ts';
import { noteActivity } from '../activity.ts';
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

type Access = 'public' | 'user' | 'owner';

interface Ctx {
  user: User;
  payload: any;
  token?: string;
}

interface Route {
  access: Access;
  handler: (ctx: Ctx) => any;
  permission?: string;
}

/** Desktop-only capabilities (native dialogs) registered by the Electron main process. */
export interface NativeHost {
  chooseDirectory?: (title: string) => Promise<string | null>;
  chooseBackupFile?: () => Promise<string | null>;
  openFolder?: (dir: string) => Promise<void>;
}
let nativeHost: NativeHost = {};
export function setNativeHost(host: NativeHost): void {
  nativeHost = host;
}

const auth = () => new AuthService();
const products = () => new ProductsService();
const pos = () => new PosService();
const inventory = () => new InventoryService();
const customers = () => new CustomerService();
const returns = () => new ReturnsService();
const finance = () => new FinanceService();
const backup = () => new BackupService();

const p = (ctx: Ctx) => (ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {});

const PUBLIC_SETTING_KEYS = ['store_name', 'inactivity_lock_minutes', 'currency', 'timezone'];

const routes: Record<string, Route> = {
  // 1. Public channels that do not require an active user session
  'auth:hasOwner': { access: 'public', handler: () => auth().hasOwner() },
  'auth:setupOwner': { access: 'public', handler: (c) => auth().setupInitialOwner(p(c).name, p(c).pin) },
  'auth:getActiveUsers': { access: 'public', handler: () => auth().getActiveUsers() },
  'auth:login': { access: 'public', handler: (c) => auth().login(p(c).userId, p(c).pin) },
  'settings:getPublic': {
    access: 'public',
    handler: () => {
      const all = backup().getSettings();
      return Object.fromEntries(PUBLIC_SETTING_KEYS.filter((k) => k in all).map((k) => [k, all[k]]));
    }
  },

  // 2. Session & own account
  'auth:logout': { access: 'user', handler: (c) => { auth().logout(c.token); return { logged_out: true }; } },
  'auth:me': { access: 'user', handler: (c) => c.user },
  'auth:changeOwnPin': { access: 'user', handler: (c) => { auth().changeOwnPin(c.user, p(c).currentPin, p(c).newPin, c.token); return { changed: true }; } },

  // 3. User & Staff Management (owner)
  'auth:getAllUsers': { access: 'owner', handler: (c) => auth().getAllUsers(c.user) },
  'auth:addUser': { access: 'owner', handler: (c) => auth().addUser(c.user, p(c).name, p(c).pin, p(c).role, p(c).permissions) },
  'auth:setUserActive': { access: 'owner', handler: (c) => { auth().setUserActive(c.user, p(c).userId, !!p(c).isActive); return { updated: true }; } },
  'auth:resetPin': { access: 'owner', handler: (c) => { auth().resetPin(c.user, p(c).userId, p(c).newPin); return { reset: true }; } },
  'auth:unlockUser': { access: 'owner', handler: (c) => { auth().unlockUser(c.user, p(c).userId); return { unlocked: true }; } },
  'auth:getUserPermissions': { access: 'owner', handler: (c) => auth().getUserPermissions(p(c).userId) },
  'auth:setUserPermissions': { access: 'owner', handler: (c) => { auth().setUserPermissions(c.user, p(c).userId, p(c).permissions); return { updated: true }; } },
  'auth:resetStoreDatabase': { access: 'owner', handler: (c) => { auth().resetStoreDatabase(c.user, p(c).pin); return { reset: true }; } },

  // 4. Products & Categories
  // Category names and colours are not sensitive: every signed-in user may list them (POS filter).
  'products:getCategories': { access: 'user', handler: (c) => products().getCategories({ includeArchived: !!p(c).includeArchived }) },
  'products:createCategory': { access: 'user', permission: 'categories.manage', handler: (c) => products().createCategory(c.user, p(c).name, p(c).color) },
  'products:updateCategory': { access: 'user', permission: 'categories.manage', handler: (c) => products().updateCategory(c.user, p(c).categoryId, { name: p(c).name, color: p(c).color }) },
  'products:renameCategory': { access: 'user', permission: 'categories.manage', handler: (c) => products().renameCategory(c.user, p(c).categoryId, p(c).name) },
  'products:setCategoryArchived': { access: 'user', permission: 'categories.manage', handler: (c) => products().setCategoryArchived(c.user, p(c).categoryId, !!p(c).isArchived) },
  'products:getCategoryUsage': { access: 'user', permission: 'categories.manage', handler: (c) => products().getCategoryUsage(p(c).categoryId) },
  'products:deleteCategory': { access: 'user', permission: 'categories.manage', handler: (c) => products().deleteCategory(c.user, p(c).categoryId, p(c).reassignToCategoryId) },
  'products:list': {
    access: 'user',
    permission: 'products.view',
    handler: (c) => {
      const q = { ...p(c) };
      if (c.user.role !== 'owner') { delete q.includeArchived; delete q.archivedOnly; }
      return products().listProducts(q);
    }
  },
  'products:getById': {
    access: 'user',
    permission: 'products.view',
    handler: (c) => products().getProductById(p(c).productId, { includeArchived: c.user.role === 'owner' && !!p(c).includeArchived })
  },
  'products:lookupCode': { access: 'user', permission: 'products.view', handler: (c) => products().lookupByCode(String(p(c).code ?? '')) },
  'products:create': { access: 'user', permission: 'products.create', handler: (c) => products().createProduct(c.user, c.payload) },
  'products:addImage': { access: 'user', permission: 'products.create', handler: (c) => products().addImage(c.user, p(c).productId, p(c).filePath, p(c).isPrimary) },
  'products:deleteImage': { access: 'user', permission: 'products.edit', handler: (c) => { products().deleteImage(c.user, p(c).imageId); return { deleted: true }; } },
  'products:setPrimaryImage': { access: 'user', permission: 'products.edit', handler: (c) => { products().setPrimaryImage(c.user, p(c).imageId); return { updated: true }; } },
  'products:update': { access: 'user', permission: 'products.edit', handler: (c) => products().updateProduct(c.user, c.payload) },
  'products:setActive': { access: 'user', permission: 'products.archive', handler: (c) => products().setProductActive(c.user, p(c).productId, !!p(c).isActive) },
  'products:addVariant': { access: 'user', permission: 'products.edit', handler: (c) => products().addVariant(c.user, p(c).productId, p(c).variant) },
  'products:updateVariant': { access: 'user', permission: 'products.edit', handler: (c) => products().updateVariant(c.user, c.payload) },
  'products:setVariantActive': { access: 'user', permission: 'products.edit', handler: (c) => products().setVariantActive(c.user, p(c).variantId, !!p(c).isActive) },

  // 5. OCR (offline ONNX, on the OCR worker thread)
  'ocr:isModelReady': {
    access: 'user',
    handler: async () => ({ ready: await OcrService.warmup(), model: OcrService.modelName })
  },
  'ocr:recognize': {
    access: 'user',
    handler: (c) => {
      const img = OcrService.validateImage(p(c).pixels, p(c).width, p(c).height);
      return OcrService.recognize(img.pixels, img.width, img.height, { diagnostics: p(c).diagnostics === true });
    }
  },
  // Test sample from the diagnostics panel, saved only on request into a folder the seller picks.
  'ocr:saveSample': {
    access: 'user',
    handler: (c) => saveOcrSample(p(c), nativeHost.chooseDirectory)
  },

  // 6. Inventory
  'inventory:restock': { access: 'user', permission: 'inventory.restock', handler: (c) => inventory().restockVariant(c.user, c.payload) },
  'inventory:correct': { access: 'user', permission: 'inventory.adjust', handler: (c) => inventory().correctStock(c.user, c.payload) },
  'inventory:getMovements': { access: 'user', permission: 'inventory.view_movements', handler: (c) => inventory().getMovements(p(c).variantId, p(c).limit) },

  // 7. POS & Checkout
  'pos:checkout': { access: 'user', permission: 'sales.create', handler: (c) => pos().checkout(c.user, c.payload) },
  'pos:searchSales': { access: 'user', permission: 'sales.view_history', handler: (c) => pos().searchSales(c.payload) },
  'pos:getSale': { access: 'user', permission: 'sales.view_history', handler: (c) => pos().getSaleById(p(c).saleId) },

  // 8. Customers & Debts
  'customers:list': { access: 'user', permission: 'customers.view', handler: (c) => customers().listCustomers(p(c).searchTerm) },
  'customers:get': { access: 'user', permission: 'customers.view', handler: (c) => customers().getCustomerById(p(c).customerId) },
  'customers:create': { access: 'user', permission: 'customers.create', handler: (c) => customers().createCustomer(c.user, c.payload) },
  'customers:repay': { access: 'user', permission: 'debts.repayment', handler: (c) => customers().recordRepayment(c.user, c.payload) },
  'customers:getRepayments': { access: 'user', permission: 'debts.view', handler: (c) => customers().getRepayments(p(c).customerId) },
  'customers:getLedger': { access: 'user', permission: 'debts.view', handler: (c) => customers().getCustomerLedger(p(c).customerId) },
  'customers:getActiveSales': { access: 'user', permission: 'customers.view', handler: (c) => customers().getCustomerActiveSales(p(c).customerId) },
  'debts:voidRepayment': { access: 'user', permission: 'debts.correction', handler: (c) => customers().voidRepayment(c.user, c.payload) },
  'debts:writeOff': { access: 'user', permission: 'debts.correction', handler: (c) => customers().writeOffDebt(c.user, c.payload) },
  'debts:getCorrections': { access: 'user', permission: 'debts.view', handler: (c) => customers().getDebtCorrections(c.user, p(c).customerId) },

  // 9. Returns & Exchanges
  'returns:process': { access: 'user', permission: 'sales.return', handler: (c) => returns().processReturn(c.user, c.payload) },
  'returns:exchange': { access: 'user', permission: 'sales.exchange', handler: (c) => returns().processExchange(c.user, c.payload) },
  'returns:list': { access: 'user', permission: 'sales.view_history', handler: (c) => returns().listReturns(c.payload) },

  // 10. Finance & Expenses
  'finance:summary': {
    access: 'user',
    permission: 'reports.financial',
    handler: (c) => {
      const q = p(c);
      return q.preset || q.from || q.to
        ? finance().getFinancialSummary(c.user, { preset: q.preset, from: q.from, to: q.to })
        : finance().getFinancialSummary(c.user, q.startDate, q.endDate);
    }
  },
  'finance:listDiscounts': {
    access: 'user',
    permission: 'reports.sales',
    handler: (c) => finance().listDiscounts(c.user, { preset: p(c).preset, from: p(c).from, to: p(c).to }, p(c).limit)
  },
  'finance:createExpense': { access: 'user', permission: 'expenses.manage', handler: (c) => finance().createExpense(c.user, c.payload) },
  'finance:listExpenses': { access: 'user', permission: 'expenses.view', handler: (c) => finance().listExpenses(c.user, p(c).limit) },
  'finance:exportSalesCSV': { access: 'user', permission: 'reports.sales', handler: (c) => finance().exportSalesCSV(c.user) },

  // 11. Backup, Settings & Logs (owner)
  'backup:create': { access: 'owner', handler: (c) => backup().createBackupWithMirror(c.user) },
  'backup:list': { access: 'owner', handler: (c) => backup().listBackups(c.user) },
  'backup:verify': { access: 'owner', handler: (c) => backup().verifyBackup(c.user, p(c).dataString, p(c).filename) },
  'backup:runDaily': { access: 'owner', handler: () => backup().checkAndRunDailyBackup() },
  'backup:restore': { access: 'owner', handler: (c) => backup().restoreBackup(c.user, p(c).base64Data, p(c).expectedChecksum) },
  'backup:restoreFromList': { access: 'owner', handler: (c) => backup().restoreFromList(c.user, p(c).filename) },
  'backup:restoreFromFile': {
    access: 'owner',
    handler: async (c) => {
      if (!nativeHost.chooseBackupFile) throw new Error('ფაილის არჩევა ხელმისაწვდომია მხოლოდ დესკტოპ პროგრამაში');
      const file = await nativeHost.chooseBackupFile();
      if (!file) return { cancelled: true };
      return backup().restoreFromFile(c.user, file);
    }
  },
  'backup:chooseDirectory': {
    access: 'owner',
    handler: async (c) => {
      if (!nativeHost.chooseDirectory) throw new Error('საქაღალდის არჩევა ხელმისაწვდომია მხოლოდ დესკტოპ პროგრამაში');
      const title = p(c).purpose === 'mirror' ? 'აირჩიეთ სარეზერვო ასლის დამატებითი საქაღალდე (მაგ. USB დისკი)' : 'აირჩიეთ სარეზერვო ასლების საქაღალდე';
      const dir = await nativeHost.chooseDirectory(title);
      return { path: dir };
    }
  },
  'backup:openFolder': {
    access: 'owner',
    handler: async () => {
      if (!nativeHost.openFolder) throw new Error('ხელმისაწვდომია მხოლოდ დესკტოპ პროგრამაში');
      await nativeHost.openFolder(backup().getEffectiveBackupDirectory());
      return { opened: true };
    }
  },
  'backup:getLogs': { access: 'owner', handler: (c) => backup().getAuditLogs(p(c).limit) },
  'backup:getSettings': { access: 'owner', handler: () => backup().getSettings() },
  'backup:updateSettings': { access: 'owner', handler: (c) => { backup().updateSettings(c.user, p(c).settings); return { updated: true }; } },
  'system:getErrorLogs': { access: 'owner', handler: (c) => backup().getErrorLogs(p(c).limit) },
  'system:clearErrorLogs': { access: 'owner', handler: (c) => { backup().clearErrorLogs(c.user); return { cleared: true }; } },
};

/** Registers additional routes (used by features that live outside this file). */
export function registerRoute(channel: string, route: Route): void {
  routes[channel] = route;
}

const OWNER_ONLY_FIELD = /cost|profit|cogs/i;
const NEVER_SENT_FIELD = /^(pin_hash|pin_salt)$/;

/** Removes fields a session must not see: PIN hashes for everyone, costs/profit for sellers. */
export function filterResponse(value: any, user: User | null, depth = 0): any {
  if (value === null || typeof value !== 'object' || depth > 25) return value;
  // Binary data (OCR diagnostics images) has no named fields to filter and must stay binary.
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map((v) => filterResponse(v, user, depth + 1));
  const isOwner = user?.role === 'owner';
  const canSeeFinancials = isOwner || (user ? new AuthService().hasPermission(user, 'reports.financial') : false);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (NEVER_SENT_FIELD.test(k)) continue;
    if (!canSeeFinancials && OWNER_ONLY_FIELD.test(k)) continue;
    out[k] = filterResponse(v, user, depth + 1);
  }
  return out;
}

const VALIDATION_HINTS = ['PIN', 'მარაგი', 'ფორმატი', 'ნაკლებია', 'სავალდებულოა', 'არასწორია', 'უფლება', 'მხოლოდ მფლობელს', 'აღემატება', 'მთელი რიცხვი', 'ვერ მოიძებნა', 'უკვე'];

export async function handleIpcMessage(req: IpcRequest): Promise<IpcResponse> {
  const channel = req && typeof req.channel === 'string' ? req.channel : '';
  let currentUser: User | null = null;
  noteActivity();
  try {
    if (!req || typeof req !== 'object' || !channel) {
      return { success: false, error: 'არასწორი მოთხოვნა' };
    }
    if (req.payload !== undefined && req.payload !== null && typeof req.payload !== 'object') {
      return { success: false, error: 'არასწორი მოთხოვნის მონაცემები' };
    }

    const route = Object.prototype.hasOwnProperty.call(routes, channel) ? routes[channel] : undefined;
    if (!route) {
      return { success: false, error: `უცნობი IPC არხი: "${channel}"` };
    }

    const token = typeof req.token === 'string' ? req.token : undefined;
    if (route.access === 'public') {
      const data = await route.handler({ user: null as any, payload: req.payload, token });
      return { success: true, data: filterResponse(data, null) };
    }

    // All other channels REQUIRE a valid session token
    if (!token) {
      return { success: false, error: 'ავტორიზაცია არ არის გავლილი (No token)' };
    }
    currentUser = new AuthService().resolveSession(token);
    if (!currentUser) {
      return { success: false, error: 'სესია ვადაგასულია, გთხოვთ ხელახლა შეიყვანოთ PIN კოდი' };
    }
    if (route.access === 'owner' && currentUser.role !== 'owner') {
      return { success: false, error: 'ამ მოქმედების უფლება აქვს მხოლოდ მფლობელს' };
    }
    if (route.permission && currentUser.role !== 'owner') {
      if (!new AuthService().hasPermission(currentUser, route.permission)) {
        return { success: false, error: 'თქვენ არ გაქვთ ამ მოქმედების შესრულების უფლება (მხოლოდ მფლობელს ან უფლებამოსილ თანამშრომელს)' };
      }
    }

    const data = await route.handler({ user: currentUser, payload: req.payload, token });
    return { success: true, data: filterResponse(data, currentUser) };
  } catch (err: any) {
    const message = String(err?.message || '');
    const isValidationErr = VALIDATION_HINTS.some((h) => message.includes(h));
    if (isValidationErr) {
      console.log(`[IPC Validation in ${channel}]: ${message}`);
    } else {
      console.error(`[IPC Error in ${channel}]:`, err);
      try {
        new BackupService().logSystemError(channel, message, err?.stack, 'error', currentUser?.id);
      } catch {}
    }
    return {
      success: false,
      error: message || 'დაფიქსირდა სისტემური შეცდომა'
    };
  }
}

export function getNativeHost(): NativeHost {
  return nativeHost;
}
