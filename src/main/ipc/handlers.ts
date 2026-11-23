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
import { userCan } from '../../shared/permissions.ts';
import { isLang } from '../../shared/i18n/index.ts';
import { getDeviceLanguage, installerLanguage, setDeviceLanguage } from '../deviceLanguage.ts';

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
  /** Needed by a seller (owners always pass). A list means any one of them. */
  permission?: string | readonly string[];
}

/** Product data is read by the POS, the products and inventory screens and the exchange dialog. */
const PRODUCT_READ = ['products.view', 'pos.access', 'inventory.view', 'inventory.receive', 'inventory.adjust', 'returns.exchange'] as const;
/** Customers (with balances) are needed to sell on debt and to collect repayments. */
const CUSTOMER_READ = ['debts.view', 'debts.collect', 'sales.debt', 'sales.mixed'] as const;

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
  'auth:setupOwner': {
    access: 'public',
    handler: (c) => auth().setupInitialOwner(p(c).name, p(c).pin, { language: p(c).language, currency: p(c).currency, timezone: p(c).timezone }),
  },
  'auth:getActiveUsers': { access: 'public', handler: () => auth().getActiveUsers() },
  'auth:login': { access: 'public', handler: (c) => auth().login(p(c).userId, p(c).pin) },
  'settings:getPublic': {
    access: 'public',
    handler: () => {
      const all = backup().getSettings();
      return Object.fromEntries(PUBLIC_SETTING_KEYS.filter((k) => k in all).map((k) => [k, all[k]]));
    }
  },

  // Language of this computer's screens before sign-in (no data, no money: open to the sign-in screen).
  'app:getDeviceLanguage': { access: 'public', handler: () => ({ language: getDeviceLanguage(), installer: installerLanguage() }) },
  'app:setDeviceLanguage': { access: 'public', handler: (c) => ({ language: setDeviceLanguage(p(c).language) }) },

  // 2. Session & own account
  'auth:logout': { access: 'user', handler: (c) => { auth().logout(c.token); return { logged_out: true }; } },
  'auth:setLanguage': { access: 'user', handler: (c) => auth().setOwnLanguage(c.user, p(c).language) },
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
    permission: PRODUCT_READ,
    handler: (c) => {
      const q = { ...p(c) };
      // Archived products are seen by whoever may archive/restore them.
      if (!userCan(c.user, 'products.archive')) { delete q.includeArchived; delete q.archivedOnly; }
      return products().listProducts(q);
    }
  },
  'products:getById': {
    access: 'user',
    permission: PRODUCT_READ,
    handler: (c) => products().getProductById(p(c).productId, { includeArchived: userCan(c.user, 'products.archive') && !!p(c).includeArchived })
  },
  'products:lookupCode': { access: 'user', permission: PRODUCT_READ, handler: (c) => products().lookupByCode(String(p(c).code ?? '')) },
  'products:create': { access: 'user', permission: 'products.create', handler: (c) => products().createProduct(c.user, c.payload) },
  'products:addImage': { access: 'user', permission: ['products.create', 'products.edit'], handler: (c) => products().addImage(c.user, p(c).productId, p(c).filePath, p(c).isPrimary) },
  'products:deleteImage': { access: 'user', permission: 'products.edit', handler: (c) => { products().deleteImage(c.user, p(c).imageId); return { deleted: true }; } },
  'products:setPrimaryImage': { access: 'user', permission: 'products.edit', handler: (c) => { products().setPrimaryImage(c.user, p(c).imageId); return { updated: true }; } },
  'products:update': { access: 'user', permission: ['products.edit', 'products.prices', 'reports.profit'], handler: (c) => products().updateProduct(c.user, c.payload) },
  'products:setActive': { access: 'user', permission: 'products.archive', handler: (c) => products().setProductActive(c.user, p(c).productId, !!p(c).isActive) },
  'products:addVariant': { access: 'user', permission: 'products.variants', handler: (c) => products().addVariant(c.user, p(c).productId, p(c).variant) },
  'products:updateVariant': { access: 'user', permission: ['products.variants', 'products.prices', 'reports.profit'], handler: (c) => products().updateVariant(c.user, c.payload) },
  'products:setVariantActive': { access: 'user', permission: 'products.variants', handler: (c) => products().setVariantActive(c.user, p(c).variantId, !!p(c).isActive) },

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
  'inventory:restock': { access: 'user', permission: 'inventory.receive', handler: (c) => inventory().restockVariant(c.user, c.payload) },
  'inventory:correct': { access: 'user', permission: 'inventory.adjust', handler: (c) => inventory().correctStock(c.user, c.payload) },
  'inventory:getMovements': { access: 'user', permission: 'inventory.view', handler: (c) => inventory().getMovements(p(c).variantId, p(c).limit) },

  // 7. POS & Checkout
  'pos:checkout': { access: 'user', permission: 'pos.access', handler: (c) => pos().checkout(c.user, c.payload) },
  'pos:searchSales': { access: 'user', permission: 'sales.history', handler: (c) => pos().searchSales(c.payload) },
  'pos:getSale': { access: 'user', permission: 'sales.history', handler: (c) => pos().getSaleById(p(c).saleId) },

  // 8. Customers & Debts
  'customers:list': { access: 'user', permission: CUSTOMER_READ, handler: (c) => customers().listCustomers(p(c).searchTerm) },
  'customers:get': { access: 'user', permission: CUSTOMER_READ, handler: (c) => customers().getCustomerById(p(c).customerId) },
  'customers:create': { access: 'user', permission: 'customers.create', handler: (c) => customers().createCustomer(c.user, c.payload) },
  'customers:repay': { access: 'user', permission: 'debts.collect', handler: (c) => customers().recordRepayment(c.user, c.payload) },
  'customers:getRepayments': { access: 'user', permission: 'debts.history', handler: (c) => customers().getRepayments(p(c).customerId) },
  'customers:getLedger': { access: 'user', permission: 'debts.history', handler: (c) => customers().getCustomerLedger(p(c).customerId) },
  'customers:getActiveSales': { access: 'user', permission: CUSTOMER_READ, handler: (c) => customers().getCustomerActiveSales(p(c).customerId) },
  'debts:voidRepayment': { access: 'user', permission: 'debts.correct', handler: (c) => customers().voidRepayment(c.user, c.payload) },
  'debts:writeOff': { access: 'user', permission: 'debts.correct', handler: (c) => customers().writeOffDebt(c.user, c.payload) },
  'debts:getCorrections': { access: 'user', permission: 'debts.history', handler: (c) => customers().getDebtCorrections(c.user, p(c).customerId) },

  // 9. Returns & Exchanges
  'returns:process': { access: 'user', permission: 'returns.process', handler: (c) => returns().processReturn(c.user, c.payload) },
  'returns:exchange': { access: 'user', permission: 'returns.exchange', handler: (c) => returns().processExchange(c.user, c.payload) },
  'returns:list': { access: 'user', permission: 'sales.history', handler: (c) => returns().listReturns(c.payload) },

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
    permission: 'reports.financial',
    handler: (c) => finance().listDiscounts(c.user, { preset: p(c).preset, from: p(c).from, to: p(c).to }, p(c).limit)
  },
  'finance:createExpense': { access: 'user', permission: 'expenses.manage', handler: (c) => finance().createExpense(c.user, c.payload) },
  'finance:listExpenses': { access: 'user', permission: 'reports.financial', handler: (c) => finance().listExpenses(c.user, p(c).limit) },
  'finance:exportSalesCSV': { access: 'user', permission: 'reports.export', handler: (c) => finance().exportSalesCSV(c.user, isLang(p(c).lang) ? p(c).lang : 'ka') },

  // 11. Backup, Settings & Logs (owner; making a backup and its list can be given to a seller)
  'backup:create': { access: 'user', permission: 'backups.create', handler: (c) => backup().createBackupWithMirror(c.user) },
  'backup:list': { access: 'user', permission: 'backups.create', handler: (c) => backup().listBackups(c.user) },
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
  'backup:canChangeCurrency': { access: 'owner', handler: (c) => ({ allowed: backup().canChangeCurrency(c.user) }) },
  'system:getErrorLogs': { access: 'owner', handler: (c) => backup().getErrorLogs(p(c).limit) },
  'system:clearErrorLogs': { access: 'owner', handler: (c) => { backup().clearErrorLogs(c.user); return { cleared: true }; } },
};

/** Who may call each channel (for the permission tests; handlers are not exposed). */
export function routeTable(): Array<{ channel: string; access: Access; permission?: string | readonly string[] }> {
  return Object.entries(routes).map(([channel, r]) => ({ channel, access: r.access, permission: r.permission }));
}

/** Registers additional routes (used by features that live outside this file). */
export function registerRoute(channel: string, route: Route): void {
  routes[channel] = route;
}

/** Purchase costs, COGS, profit, margins, stock valuation: only with "reports.profit". */
const COST_FIELD = /cost|profit|cogs|margin|valuation|inventory_value|operating_result|damaged_goods_writeoff/i;
/** Stock on hand and its movements: only with "inventory.quantities". */
const STOCK_FIELD = /^(stock_quantity|available_stock|total_stock|resulting_stock|remaining_quantity|initial_quantity|quantity_change|stock_after|stock_before|units_in_stock|grams_in_stock)$/;
/** Never sent to anyone, whatever a service returns. */
const NEVER_SENT_FIELD = /^(pin_hash|pin_salt|pin)$/;

interface Viewer {
  costs: boolean;
  stock: boolean;
}

/** What this session may see; decided once per response from the request's fresh user record. */
export function viewerOf(user: User | null): Viewer {
  return {
    costs: userCan(user, 'reports.profit'),
    stock: userCan(user, 'inventory.quantities'),
  };
}

function filterValue(value: any, viewer: Viewer, depth: number): any {
  if (value === null || typeof value !== 'object' || depth > 25) return value;
  // Binary data (OCR diagnostics images) has no named fields to filter and must stay binary.
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map((v) => filterValue(v, viewer, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (NEVER_SENT_FIELD.test(k)) continue;
    if (!viewer.costs && COST_FIELD.test(k)) continue;
    if (!viewer.stock && STOCK_FIELD.test(k)) continue;
    out[k] = filterValue(v, viewer, depth + 1);
  }
  return out;
}

/**
 * Removes fields a session must not see: PIN hashes for everyone; purchase costs/profit without
 * "reports.profit"; stock quantities without "inventory.quantities". The user's permissions are
 * evaluated once for the whole response (no database query per object).
 */
export function filterResponse(value: any, user: User | null): any {
  return filterValue(value, viewerOf(user), 0);
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
    // currentUser was just re-read from SQLite by resolveSession (role, active flag and
    // permissions), so a change by the owner applies to the very next request.
    if (route.permission && !userCan(currentUser, route.permission)) {
      return { success: false, error: 'თქვენ არ გაქვთ ამ მოქმედების შესრულების უფლება (მხოლოდ მფლობელს ან უფლებამოსილ თანამშრომელს)' };
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
