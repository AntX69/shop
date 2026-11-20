/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Central Permission Registry for StorePOS V1.1.
 * Defines granular staff permissions grouped by business area.
 * Owner has full access to everything. Sellers can be granted specific permissions.
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
    title: 'გაყიდვები და სალარო',
    description: 'სალაროს ოპერაციები, გაყიდვების ისტორია, დაბრუნება და გაცვლა',
    permissions: [
      { id: 'sales.create', name: 'გაყიდვის შესრულება', description: 'კალათის შევსება და სალაროში გაყიდვის გატარება' },
      { id: 'sales.view_history', name: 'გაყიდვების ისტორიის ნახვა', description: 'ადრე შესრულებული ჩეკების და გაყიდვების სიის დათვალიერება' },
      { id: 'sales.return', name: 'პროდუქტის დაბრუნება', description: 'გაყიდული პროდუქტის დაბრუნების ოპერაციის შესრულება' },
      { id: 'sales.exchange', name: 'პროდუქტის გაცვლა', description: 'პროდუქტის სხვა ნივთში გაცვლის გაფორმება' },
      { id: 'sales.discount', name: 'ფასდაკლების გაკეთება', description: 'კალათაზე ან პოზიციაზე ფასდაკლების მინიჭება' }
    ]
  },
  {
    id: 'customers',
    title: 'კლიენტები და ნისიები',
    description: 'მომხმარებელთა ბაზა, ნისიით გაყიდვა და ვალების დაფარვა',
    permissions: [
      { id: 'customers.view', name: 'კლიენტების სიის ნახვა', description: 'კლიენტების და მათი დავალიანების დათვალიერება' },
      { id: 'customers.create', name: 'ახალი კლიენტის დამატება', description: 'ახალი კლიენტის პროფილის რეგისტრაცია' },
      { id: 'customers.edit', name: 'კლიენტის რედაქტირება', description: 'კლიენტის მონაცემების (სახელი, ტელეფონი) შეცვლა' },
      { id: 'debts.create', name: 'ნისიის გაფორმება', description: 'ნისიით ან შერეული გადახდით გაყიდვის შესრულება' },
      { id: 'debts.view', name: 'ნისიების ისტორიის ნახვა', description: 'დავალიანებების ბარათის და გადახდების ისტორიის ნახვა' },
      { id: 'debts.repayment', name: 'ნისიის თანხის მიღება', description: 'კლიენტისგან ვალის დაფარვის თანხის მიღება' },
      { id: 'debts.correction', name: 'ვალის კორექტირება', description: 'დაფარვის გაუქმება ან დავალიანების ჩამოწერა' }
    ]
  },
  {
    id: 'products',
    title: 'პროდუქტები და კატალოგი',
    description: 'პროდუქციის კატალოგის დათვალიერება, შექმნა და რედაქტირება',
    permissions: [
      { id: 'products.view', name: 'პროდუქტების ნახვა', description: 'პროდუქციის კატალოგის და ფასების დათვალიერება' },
      { id: 'products.create', name: 'პროდუქტის დამატება', description: 'ახალი პროდუქტის და ვარიანტების შექმნა' },
      { id: 'products.edit', name: 'პროდუქტის რედაქტირება', description: 'პროდუქტის სახელის, აღწერის და კოდების შეცვლა' },
      { id: 'products.archive', name: 'პროდუქტის დაარქივება', description: 'პროდუქტის ან ვარიანტის არქივში გადატანა/აღდგენა' },
      { id: 'products.change_price', name: 'გასაყიდი ფასის შეცვლა', description: 'პროდუქტის გასაყიდი ფასის შეცვლა' },
      { id: 'products.change_cost', name: 'თვითღირებულების შეცვლა', description: 'შესასყიდი ფასის (თვითღირებულების) რედაქტირება' }
    ]
  },
  {
    id: 'inventory',
    title: 'მარაგი და საწყობი',
    description: 'მარაგების ნაშთები, შევსება და კორექტირება',
    permissions: [
      { id: 'inventory.view', name: 'მარაგების ნახვა', description: 'საწყობში არსებული ნაშთების დათვალიერება' },
      { id: 'inventory.restock', name: 'მარაგის შევსება', description: 'ახალი პარტიის მიღება და მარაგის შევსება' },
      { id: 'inventory.adjust', name: 'მარაგის კორექცია', description: 'ფაქტობრივი მარაგის გადათვლა და კორექტირება' },
      { id: 'inventory.view_movements', name: 'მოძრაობის ისტორია', description: 'მარაგების მოძრაობის ჟურნალის ნახვა' }
    ]
  },
  {
    id: 'categories',
    title: 'კატეგორიები',
    description: 'კატეგორიების სია, ფერები, შექმნა და მართვა',
    permissions: [
      { id: 'categories.view', name: 'კატეგორიების ნახვა', description: 'კატეგორიების სიის დათვალიერება' },
      { id: 'categories.create', name: 'კატეგორიის შექმნა', description: 'ახალი კატეგორიის დამატება' },
      { id: 'categories.edit', name: 'კატეგორიის შეცვლა', description: 'კატეგორიის სახელის, ფერის ან არქივის შეცვლა' },
      { id: 'categories.delete', name: 'კატეგორიის წაშლა', description: 'კატეგორიის უსაფრთხო წაშლა' }
    ]
  },
  {
    id: 'reports',
    title: 'ფინანსები და ანგარიშგება',
    description: 'ფინანსური მაჩვენებლები, მოგება და ხარჯები',
    permissions: [
      { id: 'reports.sales', name: 'გაყიდვების ანგარიში', description: 'პერიოდის გაყიდვების ჯამური რეპორტის ნახვა' },
      { id: 'reports.financial', name: 'ფინანსური ანგარიშგება (მოგება)', description: 'შემოსავლების, მოგების და COGS-ის ნახვა' },
      { id: 'expenses.view', name: 'ხარჯების ნახვა', description: 'მაღაზიის ხარჯების სიის დათვალიერება' },
      { id: 'expenses.manage', name: 'ხარჯების მართვა', description: 'ახალი ხარჯის დამატება და რედაქტირება' }
    ]
  }
];

export const ALL_PERMISSION_IDS: string[] = PERMISSION_GROUPS.flatMap(g => g.permissions.map(p => p.id));

/**
 * Permissions automatically assigned to a newly created Seller or migrated legacy Seller.
 */
export const DEFAULT_SELLER_PERMISSIONS: string[] = [
  'sales.create',
  'sales.view_history',
  'sales.return',
  'sales.exchange',
  'customers.view',
  'customers.create',
  'customers.edit',
  'debts.create',
  'debts.view',
  'debts.repayment',
  'products.view',
  'inventory.view',
  'inventory.view_movements',
  'categories.view'
];

/** Operations that can NEVER be delegated to a seller under any circumstances */
export const OWNER_ONLY_OPERATIONS: string[] = [
  'auth:addUser',
  'auth:setUserActive',
  'auth:resetPin',
  'auth:unlockUser',
  'auth:resetStoreDatabase',
  'backup:create',
  'backup:restore',
  'backup:restoreFromFile',
  'backup:restoreFromList',
  'backup:updateSettings'
];
