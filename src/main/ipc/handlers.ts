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
  'auth:addUser': { access: 'owner', handler: (c) => auth().addUser(c.user, p(c).name, p(c).pin, p(c).role) },
  'auth:setUserActive': { access: 'owner', handler: (c) => { auth().setUserActive(c.user, p(c).userId, !!p(c).isActive); return { updated: true }; } },
  'auth:resetPin': { access: 'owner', handler: (c) => { auth().resetPin(c.user, p(c).userId, p(c).newPin); return { reset: true }; } },
  'auth:unlockUser': { access: 'owner', handler: (c) => { auth().unlockUser(c.user, p(c).userId); return { unlocked: true }; } },
  'auth:resetStoreDatabase': { access: 'owner', handler: (c) => { auth().resetStoreDatabase(c.user, p(c).pin); return { reset: true }; } },

  // 4. Products & Categories
  'products:getCategories': { access: 'user', handler: () => products().getCategories() },
  'products:createCategory': { access: 'owner', handler: (c) => products().createCategory(c.user, p(c).name) },
  'products:deleteCategory': { access: 'owner', handler: (c) => { products().deleteCategory(c.user, p(c).categoryId); return { deleted: true }; } },
  'products:list': { access: 'user', handler: (c) => products().listProducts(c.payload) },
  'products:getById': { access: 'user', handler: (c) => products().getProductById(p(c).productId) },
  'products:lookupCode': { access: 'user', handler: (c) => products().lookupByCode(String(p(c).code ?? '')) },
  'products:create': { access: 'owner', handler: (c) => products().createProduct(c.user, c.payload) },
  'products:addImage': { access: 'owner', handler: (c) => products().addImage(c.user, p(c).productId, p(c).filePath, p(c).isPrimary) },
  'products:deleteImage': { access: 'owner', handler: (c) => { products().deleteImage(c.user, p(c).imageId); return { deleted: true }; } },

  // 5. OCR (offline ONNX)
  'ocr:isModelReady': {
    access: 'user',
    handler: async () => ({ ready: !!(await OcrService.getSession()), model: 'mnist.onnx' })
  },
  'ocr:recognize': {
    access: 'user',
    handler: (c) => new OcrService().recognize5Digits(p(c).pixels, p(c).width, p(c).height)
  },

  // 6. Inventory
  'inventory:restock': { access: 'owner', handler: (c) => inventory().restockVariant(c.user, c.payload) },
  'inventory:correct': { access: 'owner', handler: (c) => inventory().correctStock(c.user, c.payload) },
  'inventory:getMovements': { access: 'user', handler: (c) => inventory().getMovements(p(c).variantId, p(c).limit) },

  // 7. POS & Checkout
  'pos:checkout': { access: 'user', handler: (c) => pos().checkout(c.user, c.payload) },
  'pos:searchSales': { access: 'user', handler: (c) => pos().searchSales(c.payload) },
  'pos:getSale': { access: 'user', handler: (c) => pos().getSaleById(p(c).saleId) },

  // 8. Customers & Debts
  'customers:list': { access: 'user', handler: (c) => customers().listCustomers(p(c).searchTerm) },
  'customers:get': { access: 'user', handler: (c) => customers().getCustomerById(p(c).customerId) },
  'customers:create': { access: 'user', handler: (c) => customers().createCustomer(c.user, c.payload) },
  'customers:repay': { access: 'user', handler: (c) => customers().recordRepayment(c.user, c.payload) },
  'customers:getRepayments': { access: 'user', handler: (c) => customers().getRepayments(p(c).customerId) },
  'customers:getLedger': { access: 'user', handler: (c) => customers().getCustomerLedger(p(c).customerId) },
  'customers:getActiveSales': { access: 'user', handler: (c) => customers().getCustomerActiveSales(p(c).customerId) },
  'debts:voidRepayment': { access: 'owner', handler: (c) => customers().voidRepayment(c.user, c.payload) },
  'debts:writeOff': { access: 'owner', handler: (c) => customers().writeOffDebt(c.user, c.payload) },
  'debts:getCorrections': { access: 'owner', handler: (c) => customers().getDebtCorrections(c.user, p(c).customerId) },

  // 9. Returns & Exchanges
  'returns:process': { access: 'user', handler: (c) => returns().processReturn(c.user, c.payload) },
  'returns:exchange': { access: 'user', handler: (c) => returns().processExchange(c.user, c.payload) },
  'returns:list': { access: 'user', handler: (c) => returns().listReturns(c.payload) },

  // 10. Finance & Expenses
  'finance:summary': {
    access: 'owner',
    handler: (c) => {
      const q = p(c);
      return q.preset || q.from || q.to
        ? finance().getFinancialSummary(c.user, { preset: q.preset, from: q.from, to: q.to })
        : finance().getFinancialSummary(c.user, q.startDate, q.endDate);
    }
  },
  'finance:listDiscounts': {
    access: 'owner',
    handler: (c) => finance().listDiscounts(c.user, { preset: p(c).preset, from: p(c).from, to: p(c).to }, p(c).limit)
  },
  'finance:createExpense': { access: 'owner', handler: (c) => finance().createExpense(c.user, c.payload) },
  'finance:listExpenses': { access: 'owner', handler: (c) => finance().listExpenses(c.user, p(c).limit) },
  'finance:exportSalesCSV': { access: 'owner', handler: (c) => finance().exportSalesCSV(c.user) },

  // 11. Backup, Settings & Logs (owner)
  'backup:create': { access: 'owner', handler: (c) => backup().createBackup(c.user) },
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
  if (Array.isArray(value)) return value.map((v) => filterResponse(v, user, depth + 1));
  const isOwner = user?.role === 'owner';
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (NEVER_SENT_FIELD.test(k)) continue;
    if (!isOwner && OWNER_ONLY_FIELD.test(k)) continue;
    out[k] = filterResponse(v, user, depth + 1);
  }
  return out;
}

const VALIDATION_HINTS = ['PIN', 'მარაგი', 'ფორმატი', 'ნაკლებია', 'სავალდებულოა', 'არასწორია', 'უფლება', 'მხოლოდ მფლობელს', 'აღემატება', 'მთელი რიცხვი', 'ვერ მოიძებნა', 'უკვე'];

export async function handleIpcMessage(req: IpcRequest): Promise<IpcResponse> {
  const channel = req && typeof req.channel === 'string' ? req.channel : '';
  let currentUser: User | null = null;
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
