/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Staff permissions (V1.1). The owner always has every permission. A seller has exactly the
 * permissions the owner ticked for that seller; they are checked in the main process on every
 * IPC call (handlers.ts + the domain services), never only by hiding buttons.
 *
 * A few operations can never be given to a seller (OWNER_ONLY): managing staff and their
 * permissions, restoring backups and backup settings, store settings and resetting the store.
 * Each of them would let the seller raise their own rights or lock the owner out (e.g. restore an
 * old backup with other PINs, change their own permissions, deactivate the owner).
 */

export interface PermissionDefinition {
  id: string;
  name: string;
  description: string;
}

export interface PermissionGroup {
  id: string;
  title: string;
  description: string;
  permissions: PermissionDefinition[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: 'sales',
    title: 'გაყიდვები',
    description: 'სალარო და გადახდის მეთოდები',
    permissions: [
      { id: 'pos.access', name: 'სალაროს გამოყენება', description: 'სალაროს ეკრანი, პროდუქტის ძებნა კოდით და კალათა' },
      { id: 'sales.cash', name: 'ნაღდი გაყიდვა', description: 'გაყიდვა სრულად ნაღდი ფულით' },
      { id: 'sales.debt', name: 'ნისიით გაყიდვა', description: 'გაყიდვა მთლიანად ნისიაზე (კლიენტზე)' },
      { id: 'sales.mixed', name: 'შერეული გადახდა', description: 'ნაწილი ნაღდით, დანარჩენი ნისიაზე' },
      { id: 'customers.create', name: 'ახალი კლიენტის დამატება', description: 'კლიენტის რეგისტრაცია (სახელი, ტელეფონი)' },
      { id: 'sales.discount', name: 'ფასდაკლება', description: 'ფასდაკლება პოზიციაზე ან მთელ კალათაზე' },
    ],
  },
  {
    id: 'debts',
    title: 'ნისიები',
    description: 'კლიენტების დავალიანება და დაფარვა',
    permissions: [
      { id: 'debts.view', name: 'ნისიების ნახვა', description: 'კლიენტების სია და მიმდინარე დავალიანება' },
      { id: 'debts.history', name: 'ნისიის ისტორია', description: 'კლიენტის ამონაწერი: გაყიდვები, დაფარვები, კორექციები' },
      { id: 'debts.collect', name: 'დაფარვის მიღება', description: 'კლიენტისგან ვალის თანხის მიღება (ძველი ჩეკები პირველ რიგში)' },
      { id: 'debts.select_receipt', name: 'კონკრეტული ჩეკის დაფარვა', description: 'დაფარვისას კონკრეტული ჩეკის არჩევა' },
      { id: 'debts.correct', name: 'ვალის კორექცია', description: 'დაფარვის გაუქმება და ვალის ჩამოწერა' },
    ],
  },
  {
    id: 'returns',
    title: 'დაბრუნება და გაცვლა',
    description: 'გაყიდვების ისტორია, დაბრუნება, გაცვლა',
    permissions: [
      { id: 'sales.history', name: 'გაყიდვების ისტორია', description: 'ჩეკების და დაბრუნებების სიის ნახვა' },
      { id: 'returns.process', name: 'დაბრუნება', description: 'გაყიდული პროდუქტის დაბრუნება (ნაღდის დაბრუნება ან ვალის შემცირება)' },
      { id: 'returns.exchange', name: 'გაცვლა', description: 'პროდუქტის სხვა პროდუქტში გაცვლა' },
    ],
  },
  {
    id: 'inventory',
    title: 'მარაგი',
    description: 'ნაშთები, მიღება და კორექცია',
    permissions: [
      { id: 'inventory.view', name: 'მარაგების ეკრანი', description: 'მარაგების ეკრანი და მოძრაობის ისტორია' },
      { id: 'inventory.quantities', name: 'ნაშთის რაოდენობები', description: 'რამდენი ცალი / კგ არის მარაგში (გამორთვისას რიცხვები არ ჩანს)' },
      { id: 'inventory.receive', name: 'მარაგის მიღება', description: 'ახალი პარტიის მიღება (შესყიდვის ფასის შეყვანით)' },
      { id: 'inventory.adjust', name: 'მარაგის კორექცია', description: 'დათვლილი ნაშთის შეყვანა (აუდიტით)' },
    ],
  },
  {
    id: 'products',
    title: 'პროდუქტები',
    description: 'კატალოგი',
    permissions: [
      { id: 'products.view', name: 'პროდუქტების ეკრანი', description: 'პროდუქტების სია და ბარათი' },
      { id: 'products.create', name: 'პროდუქტის დამატება', description: 'ახალი პროდუქტი ვარიანტებით და კოდებით' },
      { id: 'products.edit', name: 'პროდუქტის რედაქტირება', description: 'სახელი, აღწერა, კატეგორია, ფოტოები' },
      { id: 'products.prices', name: 'ფასის შეცვლა', description: 'გასაყიდი ფასი (პროდუქტის და ვარიანტის)' },
      { id: 'products.variants', name: 'ვარიანტების მართვა', description: 'ვარიანტის დამატება, ზომა/ფერი, კოდები, დაარქივება' },
      { id: 'products.archive', name: 'დაარქივება / აღდგენა', description: 'პროდუქტის არქივში გადატანა და დაბრუნება' },
    ],
  },
  {
    id: 'admin',
    title: 'ადმინისტრირება',
    description: 'ფინანსები, ანგარიშები, კატეგორიები, სარეზერვო ასლი',
    permissions: [
      { id: 'reports.financial', name: 'ფინანსური ანგარიში', description: 'ბრუნვა, დაბრუნებები, წმინდა გაყიდვები, ნაღდის მოძრაობა, ნისიები, ხარჯები' },
      { id: 'reports.profit', name: 'მოგება და თვითღირებულება', description: 'შესყიდვის ფასები, COGS, მთლიანი მოგება, მარაგის ღირებულება; თვითღირებულების შეცვლა' },
      { id: 'reports.export', name: 'ანგარიშის ექსპორტი', description: 'გაყიდვების CSV ფაილი' },
      { id: 'expenses.manage', name: 'ხარჯის დამატება', description: 'ხარჯის ჩაწერა (მაგ. ტრანსპორტი სალაროდან)' },
      { id: 'categories.manage', name: 'კატეგორიების მართვა', description: 'შექმნა, სახელი, ფერი, დაარქივება, წაშლა (პროდუქტების გადატანით)' },
      { id: 'backups.create', name: 'სარეზერვო ასლის შექმნა', description: 'ასლის გაკეთება და სიის ნახვა (აღდგენა მხოლოდ მფლობელს)' },
    ],
  },
];

/** Shown in the permission editor as fixed "owner only" lines, never stored for a seller. */
export const OWNER_ONLY_CAPABILITIES: PermissionDefinition[] = [
  { id: 'owner.staff', name: 'პერსონალის მართვა', description: 'თანამშრომლის დამატება, დაბლოკვა, PIN-ის აღდგენა, უფლებების შეცვლა' },
  { id: 'owner.backup_restore', name: 'სარეზერვო ასლის აღდგენა', description: 'ბაზის აღდგენა ასლიდან და ასლების პარამეტრები' },
  { id: 'owner.settings', name: 'პარამეტრები', description: 'მაღაზიის პარამეტრები, ჟურნალები, ბაზის გასუფთავება' },
];

export const ALL_PERMISSION_IDS: string[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.id));

/**
 * Permissions of a new seller, and of sellers upgraded from RC3: exactly what an RC3 seller could
 * do (sell with any payment method, customers, debts and repayments, history, returns, exchanges,
 * see products and stock). Discounts, product management, receiving/adjusting stock, finance and
 * categories stay off until the owner turns them on.
 */
export const DEFAULT_SELLER_PERMISSIONS: string[] = [
  'pos.access',
  'sales.cash',
  'sales.debt',
  'sales.mixed',
  'customers.create',
  'debts.view',
  'debts.history',
  'debts.collect',
  'debts.select_receipt',
  'sales.history',
  'returns.process',
  'returns.exchange',
  'inventory.view',
  'inventory.quantities',
  'products.view',
];

/** IPC channels that only an owner session may call (also declared with access 'owner'). */
export const OWNER_ONLY_OPERATIONS: string[] = [
  'auth:getAllUsers',
  'auth:addUser',
  'auth:setUserActive',
  'auth:resetPin',
  'auth:unlockUser',
  'auth:getUserPermissions',
  'auth:setUserPermissions',
  'auth:resetStoreDatabase',
  'backup:verify',
  'backup:runDaily',
  'backup:restore',
  'backup:restoreFromList',
  'backup:restoreFromFile',
  'backup:chooseDirectory',
  'backup:openFolder',
  'backup:getLogs',
  'backup:getSettings',
  'backup:updateSettings',
  'system:getErrorLogs',
  'system:clearErrorLogs',
];

const NAMES: Record<string, string> = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => [p.id, p.name]))
);

/** Georgian name of a permission (for messages), or the ID itself if unknown. */
export function permissionName(id: string): string {
  return NAMES[id] || id;
}

/**
 * True when the user may do something that needs `required` (one ID, or a list = any of them).
 * Owners always may. Works on the User object the main process attaches to each request (its
 * `permissions` are read from SQLite for that request) and on the renderer's copy for the UI.
 */
export function userCan(
  user: { role?: string; permissions?: string[] | null } | null | undefined,
  required?: string | readonly string[]
): boolean {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (!required || (Array.isArray(required) && required.length === 0)) return true;
  const have = Array.isArray(user.permissions) ? user.permissions : [];
  const list = typeof required === 'string' ? [required] : required;
  return list.some((p) => have.includes(p));
}
