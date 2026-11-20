/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Products, Categories, Variants, and Codes Domain Service.
 * Runs in main process / backend with SQLite transactions.
 *
 * Product data is edited only by the owner. Edits never touch history: every sale line keeps
 * its own name, code and price snapshot, and FIFO cost layers keep the cost they were bought at.
 * Products and variants are archived (hidden from sale), never deleted, once they have history.
 * Internal codes are exactly 5 digits (10000–99999), assigned by the owner, unique; factory
 * barcodes are independent and stored as text so leading zeros survive.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { Category, Product, ProductVariant, ProductCode, ProductImage, User } from '../../shared/types.ts';
import { AuthService } from './authService.ts';
import { deleteImageFileIfUnused, imageUrl, storeProductImage } from './productImages.ts';
import { optionalAmount, optionalId, optionalString, requireAmount, requireCount, requireGramCount, requireId, requireObject, requireString } from './validation.ts';
import { UnitType } from '../../shared/types.ts';

export interface CreateProductInput {
  name: string;
  category_id?: number | null;
  description?: string;
  base_price_tetri: number;
  base_cost_tetri?: number | null;
  unit_type?: 'piece' | 'kg';
  variants: Array<VariantInput>;
  image_paths?: string[];
}

export interface VariantInput {
  variant_name: string;
  size?: string;
  color?: string;
  price_override_tetri?: number | null;
  cost_override_tetri?: number | null;
  initial_stock?: number;
  codes: Array<{
    code_type: 'barcode' | 'manual_5digit';
    code_value: string;
  }>;
}

export interface UpdateProductInput {
  productId: number;
  name?: string;
  category_id?: number | null;
  description?: string | null;
  base_price_tetri?: number;
  base_cost_tetri?: number | null;
  unit_type?: 'piece' | 'kg';
}

export interface UpdateVariantInput {
  variantId: number;
  variant_name?: string;
  size?: string | null;
  color?: string | null;
  price_override_tetri?: number | null;
  cost_override_tetri?: number | null;
  /** New internal 5-digit code; '' removes it (a barcode must then remain). */
  manual_code?: string | null;
  /** New factory barcode; '' removes it (an internal code must then remain). */
  barcode?: string | null;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const CATEGORY_MANAGE_PERMISSION = 'categories.manage';
export const DEFAULT_CATEGORY_COLOR = '#10b981';

/** Category name: NFC, spaces collapsed, 1–60 characters, no control characters. */
export function normalizeCategoryName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('კატეგორიის სახელი სავალდებულოა');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name)) throw new Error('კატეგორიის სახელი შეიცავს დაუშვებელ სიმბოლოს');
  const clean = name.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('კატეგორიის სახელი სავალდებულოა');
  if ([...clean].length > 60) throw new Error('კატეგორიის სახელი ძალიან გრძელია (მაქსიმუმ 60 სიმბოლო)');
  return clean;
}

/** Key for duplicate checks: "Toys", "toys" and " TOYS " are the same; Georgian Mtavruli = Mkhedruli. */
export function categoryNameKey(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Colour as #rrggbb (lower case). "#ABC" becomes "#aabbcc"; anything else is refused. */
export function normalizeCategoryColor(color: unknown): string {
  const text = typeof color === 'string' ? color.trim() : '';
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text);
  if (!m) throw new Error(`კატეგორიის ფერი არასწორია: "${String(color ?? '')}" (სწორია მაგ. #10b981)`);
  const hex = m[1].toLowerCase();
  return `#${hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex}`;
}

export class ProductsService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  private requireOwner(requester: User, message: string): void {
    if (requester.role !== 'owner') {
      throw new Error(message);
    }
  }

  private requirePermission(requester: User, permission: string, message: string): void {
    if (requester.role === 'owner') return;
    const auth = new AuthService(this.db);
    if (!auth.hasPermission(requester, permission)) {
      if (message.includes('მხოლოდ მფლობელს')) {
        throw new Error(message);
      }
      throw new Error(`${message} (შეუძლია მხოლოდ მფლობელს ან უფლებამოსილ თანამშრომელს)`);
    }
  }

  private audit(userId: number, action: string, entity: string, entityId: number, details: unknown): void {
    this.db.prepare(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(userId, action, entity, String(entityId), typeof details === 'string' ? details : JSON.stringify(details), new Date().toISOString());
  }

  // --- Category Management (owner, or a seller the owner gave "categories.manage") ---

  /** `action`: e.g. "კატეგორიის დამატება" (the RC3 wording of the refusal is kept). */
  private requireCategoryManager(requester: User, action: string): void {
    this.requirePermission(requester, CATEGORY_MANAGE_PERMISSION, `${action} შეუძლია მხოლოდ მფლობელს ან უფლებამოსილ თანამშრომელს`);
  }

  /** Throws when another category already has this name (ignoring letter case and extra spaces). */
  private assertCategoryNameFree(db: DatabaseSync, name: string, exceptId?: number): void {
    const key = categoryNameKey(name);
    const rows = db.prepare("SELECT id, name FROM categories").all() as Array<{ id: number; name: string }>;
    const clash = rows.find((r) => r.id !== exceptId && categoryNameKey(r.name) === key);
    if (clash) {
      throw new Error(`კატეგორია "${clash.name}" უკვე არსებობს (დიდი და პატარა ასოები ერთნაირად ითვლება)`);
    }
  }

  /** A product can be put only into an existing, non-archived category. */
  private assertCategoryAssignable(db: DatabaseSync, categoryId: number): void {
    const cat = db.prepare("SELECT name, is_archived FROM categories WHERE id = ?").get(categoryId) as any;
    if (!cat) throw new Error('კატეგორია ვერ მოიძებნა');
    if (cat.is_archived) throw new Error(`კატეგორია "${cat.name}" დაარქივებულია: აირჩიეთ სხვა ან ჯერ აღადგინეთ`);
  }

  getCategories(options?: { includeArchived?: boolean }): Category[] {
    let sql = `
      SELECT c.id, c.name, COALESCE(c.color, '#10b981') as color, COALESCE(c.is_archived, 0) as is_archived, c.created_at,
             (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) as products_count,
             (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 0) as archived_products_count
      FROM categories c
    `;
    if (!options?.includeArchived) {
      sql += " WHERE COALESCE(c.is_archived, 0) = 0";
    }
    sql += " ORDER BY c.name ASC";
    return this.db.prepare(sql).all() as unknown as Category[];
  }

  getCategoryUsage(categoryId: number): { active_products_count: number; archived_products_count: number; total: number } {
    const id = requireId(categoryId, 'კატეგორია');
    const counts = this.db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM products WHERE category_id = ? AND is_active = 1) as active_count,
        (SELECT COUNT(*) FROM products WHERE category_id = ? AND is_active = 0) as archived_count
    `).get(id, id) as { active_count: number; archived_count: number };

    return {
      active_products_count: counts?.active_count || 0,
      archived_products_count: counts?.archived_count || 0,
      total: (counts?.active_count || 0) + (counts?.archived_count || 0)
    };
  }

  createCategory(requester: User, name: unknown, color?: unknown): Category {
    this.requireCategoryManager(requester, 'კატეგორიის დამატება');
    const cleanName = normalizeCategoryName(name);
    const cleanColor = color === undefined || color === null || color === '' ? DEFAULT_CATEGORY_COLOR : normalizeCategoryColor(color);
    const now = new Date().toISOString();
    return runInTransaction((db) => {
      this.assertCategoryNameFree(db, cleanName);
      const res = db.prepare(
        "INSERT INTO categories (name, color, is_archived, created_at) VALUES (?, ?, 0, ?)"
      ).run(cleanName, cleanColor, now);
      const newId = Number(res.lastInsertRowid);
      this.audit(requester.id, 'CATEGORY_CREATE', 'categories', newId, { name: cleanName, color: cleanColor });
      return { id: newId, name: cleanName, color: cleanColor, is_archived: 0, created_at: now, products_count: 0, archived_products_count: 0 };
    }, this.db);
  }

  updateCategory(requester: User, categoryId: number, data: { name?: unknown; color?: unknown }): Category {
    this.requireCategoryManager(requester, 'კატეგორიის შეცვლა');
    const id = requireId(categoryId, 'კატეგორია');
    const input = data && typeof data === 'object' ? data : {};
    return runInTransaction((db) => {
      const old = db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as any;
      if (!old) throw new Error('კატეგორია ვერ მოიძებნა');

      const nextName = input.name !== undefined ? normalizeCategoryName(input.name) : old.name;
      // An invalid colour is refused, never silently replaced.
      const nextColor = input.color !== undefined ? normalizeCategoryColor(input.color) : (old.color || DEFAULT_CATEGORY_COLOR);
      if (nextName !== old.name) this.assertCategoryNameFree(db, nextName, id);

      db.prepare("UPDATE categories SET name = ?, color = ? WHERE id = ?").run(nextName, nextColor, id);
      this.audit(requester.id, 'CATEGORY_UPDATE', 'categories', id, {
        before: { name: old.name, color: old.color },
        after: { name: nextName, color: nextColor }
      });
      return {
        id,
        name: nextName,
        color: nextColor,
        is_archived: old.is_archived || 0,
        created_at: old.created_at
      };
    }, this.db);
  }

  renameCategory(requester: User, categoryId: number, name: string): Category {
    return this.updateCategory(requester, categoryId, { name });
  }

  setCategoryArchived(requester: User, categoryId: number, isArchived: boolean): Category {
    this.requireCategoryManager(requester, 'კატეგორიის დაარქივება');
    const id = requireId(categoryId, 'კატეგორია');
    const cat = this.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as any;
    if (!cat) throw new Error('კატეგორია ვერ მოიძებნა');

    const status = isArchived ? 1 : 0;
    this.db.prepare("UPDATE categories SET is_archived = ? WHERE id = ?").run(status, id);
    this.audit(requester.id, isArchived ? 'CATEGORY_ARCHIVE' : 'CATEGORY_RESTORE', 'categories', id, { before: cat.is_archived, after: status });

    return {
      id,
      name: cat.name,
      color: cat.color || '#10b981',
      is_archived: status,
      created_at: cat.created_at
    };
  }

  /**
   * Deletes a category. If any product (active or archived) belongs to it, the owner must name
   * another, non-archived category: the products move there and the category is deleted in one
   * transaction, so either both happen or neither. Products, variants and sales are never deleted
   * (sale lines keep their own name snapshots and do not reference categories).
   */
  deleteCategory(requester: User, categoryId: number, reassignToCategoryId?: number | null): { deleted: true; moved_products: number; reassigned_to_category_id: number | null } {
    this.requireCategoryManager(requester, 'კატეგორიის წაშლა');
    const id = requireId(categoryId, 'კატეგორია');

    return runInTransaction((db) => {
      const cat = db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as any;
      if (!cat) throw new Error('კატეგორია ვერ მოიძებნა');
      const productCount = Number((db.prepare("SELECT COUNT(*) AS n FROM products WHERE category_id = ?").get(id) as any).n);

      let targetId: number | null = null;
      if (productCount > 0) {
        if (reassignToCategoryId === undefined || reassignToCategoryId === null || (reassignToCategoryId as unknown) === '') {
          throw new Error(
            `კატეგორიაში "${cat.name}" არის ${productCount} პროდუქტი (დაარქივებულების ჩათვლით). ` +
            `წაშლამდე აირჩიეთ კატეგორია, სადაც ისინი გადავა.`
          );
        }
        targetId = requireId(reassignToCategoryId, 'სამიზნე კატეგორია');
        if (targetId === id) throw new Error('პროდუქტების იმავე კატეგორიაში გადატანა შეუძლებელია');
        const target = db.prepare("SELECT id, name, is_archived FROM categories WHERE id = ?").get(targetId) as any;
        if (!target) throw new Error('სამიზნე კატეგორია ვერ მოიძებნა');
        if (target.is_archived) throw new Error(`სამიზნე კატეგორია "${target.name}" დაარქივებულია: ჯერ აღადგინეთ ან აირჩიეთ სხვა`);

        const moved = db.prepare("UPDATE products SET category_id = ?, updated_at = ? WHERE category_id = ?").run(targetId, new Date().toISOString(), id);
        if (Number(moved.changes) !== productCount) throw new Error('პროდუქტების გადატანა ბოლომდე ვერ შესრულდა: არაფერი შეცვლილა');
      }

      const left = Number((db.prepare("SELECT COUNT(*) AS n FROM products WHERE category_id = ?").get(id) as any).n);
      if (left !== 0) throw new Error('კატეგორიას ჯერ კიდევ აქვს პროდუქტები: არაფერი შეცვლილა');
      db.prepare("DELETE FROM categories WHERE id = ?").run(id);

      this.audit(requester.id, 'CATEGORY_DELETE', 'categories', id, {
        category_name: cat.name,
        products_reassigned: productCount,
        reassigned_to_category_id: targetId
      });
      return { deleted: true as const, moved_products: productCount, reassigned_to_category_id: targetId };
    }, this.db);
  }

  // --- Code Validation Helpers ---

  validateManualCode(code: string): string {
    const trimmed = String(code ?? '').trim();
    if (!/^[1-9]\d{4}$/.test(trimmed)) {
      throw new Error(`ხელით შესაყვანი კოდი უნდა იყოს ზუსტად 5-ნიშნა რიცხვი (10000-99999). მიღებულია: "${code}"`);
    }
    return trimmed;
  }

  validateBarcode(barcode: string): string {
    const trimmed = String(barcode ?? '').trim();
    if (!trimmed || !/^\d+$/.test(trimmed) || trimmed.length > 32) {
      throw new Error(`შტრიხკოდი უნდა შეიცავდეს მხოლოდ ციფრებს (წამყვანი ნულების ჩათვლით). მიღებულია: "${barcode}"`);
    }
    return trimmed;
  }

  checkCodeUniqueness(codeValue: string, excludeVariantId?: number): void {
    let query = "SELECT pc.id, pc.code_type, pc.code_value, pv.variant_name, p.name as product_name " +
                "FROM product_codes pc " +
                "JOIN product_variants pv ON pc.variant_id = pv.id " +
                "JOIN products p ON pv.product_id = p.id " +
                "WHERE pc.code_value = ?";
    const params: any[] = [codeValue];
    if (excludeVariantId) {
      query += " AND pc.variant_id != ?";
      params.push(excludeVariantId);
    }

    const existing = this.db.prepare(query).get(...params) as any;
    if (existing) {
      throw new Error(`კოდი "${codeValue}" უკვე გამოყენებულია პროდუქტზე: "${existing.product_name}" (${existing.variant_name})`);
    }
  }

  private normalizeVariantCodes(v: VariantInput, seen: Set<string>): Array<{ code_type: 'barcode' | 'manual_5digit'; code_value: string }> {
    if (!v.codes || v.codes.length === 0) {
      throw new Error(`ვარიანტისთვის "${v.variant_name}" სავალდებულოა მინიმუმ 1 კოდი (შტრიხკოდი ან 5-ნიშნა კოდი)`);
    }
    return v.codes.map((c) => {
      const clean = c.code_type === 'manual_5digit' ? this.validateManualCode(c.code_value) : this.validateBarcode(c.code_value);
      if (seen.has(clean)) throw new Error(`კოდი "${clean}" ორჯერ არის მითითებული`);
      seen.add(clean);
      this.checkCodeUniqueness(clean);
      return { code_type: c.code_type === 'manual_5digit' ? 'manual_5digit' as const : 'barcode' as const, code_value: clean };
    });
  }

  private insertVariant(db: DatabaseSync, requester: User, productId: number, v: VariantInput, codes: Array<{ code_type: string; code_value: string }>, baseCost: number | null, unitType: UnitType, now: string): number {
    // Weight products keep stock in integer grams (up to MAX_GRAMS), piece products in whole pieces.
    const initialStock = v.initial_stock == null
      ? 0
      : unitType === 'kg'
        ? requireGramCount(v.initial_stock, 'საწყისი მარაგი (გ)')
        : requireCount(v.initial_stock, 'საწყისი მარაგი');
    const priceOverride = optionalAmount(v.price_override_tetri, 'ვარიანტის ფასი');
    const costOverride = optionalAmount(v.cost_override_tetri, 'ვარიანტის თვითღირებულება');
    const varRes = db.prepare(
      "INSERT INTO product_variants (product_id, variant_name, size, color, price_override_tetri, cost_override_tetri, stock_quantity, unit_type, is_active) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(
      productId,
      optionalString(v.variant_name, 80, 'ვარიანტის დასახელება') || 'სტანდარტული',
      optionalString(v.size, 40, 'ზომა'),
      optionalString(v.color, 40, 'ფერი'),
      priceOverride,
      costOverride,
      initialStock,
      unitType
    );
    const variantId = Number(varRes.lastInsertRowid);

    for (const c of codes) {
      db.prepare("INSERT INTO product_codes (variant_id, code_type, code_value) VALUES (?, ?, ?)").run(variantId, c.code_type, c.code_value);
    }

    // Initial stock becomes the first FIFO layer, costed at the known purchase cost (or unknown).
    if (initialStock > 0) {
      const unitCost = costOverride ?? baseCost ?? null;
      const moveRes = db.prepare(
        "INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, unit_type, reason, user_id, created_at) " +
        "VALUES (?, 'initial', ?, ?, ?, ?, 'საწყისი ინვენტარიზაცია', ?, ?)"
      ).run(variantId, initialStock, initialStock, unitCost, unitType, requester.id, now);
      db.prepare(
        "INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, unit_type, movement_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(variantId, initialStock, initialStock, unitCost, unitType, Number(moveRes.lastInsertRowid), now);
    }
    return variantId;
  }

  // --- Product Creation ---

  createProduct(requester: User, rawInput: CreateProductInput): Product {
    this.requirePermission(requester, 'products.create', 'პროდუქტის დამატების უფლება არ გაქვთ');
    const input = requireObject<CreateProductInput>(rawInput, 'პროდუქტი');
    if (input.base_cost_tetri != null && input.base_cost_tetri > 0) {
      this.requirePermission(requester, 'products.change_cost', 'თვითღირებულების შეცვლის უფლება არ გაქვთ');
    }

    const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
    if (!trimmedName) {
      throw new Error('პროდუქტის დასახელება სავალდებულოა');
    }
    requireString(trimmedName, 120, 'პროდუქტის დასახელება');

    if (typeof input.base_price_tetri !== 'number' || input.base_price_tetri <= 0) {
      throw new Error('გასაყიდი ფასი უნდა იყოს 0-ზე მეტი');
    }
    const basePrice = requireAmount(input.base_price_tetri, 'გასაყიდი ფასი');
    const baseCost = optionalAmount(input.base_cost_tetri, 'თვითღირებულება');
    const categoryId = optionalId(input.category_id || null, 'კატეგორია');
    const unitType: UnitType = (input.unit_type === 'kg') ? 'kg' : 'piece';

    if (!input.variants || input.variants.length === 0) {
      throw new Error('პროდუქტს უნდა ჰქონდეს მინიმუმ ერთი ვარიანტი');
    }

    // Validate all codes before inserting anything
    const seen = new Set<string>();
    const codesPerVariant = input.variants.map((v) => this.normalizeVariantCodes(v, seen));

    return runInTransaction((db) => {
      const now = new Date().toISOString();
      if (categoryId !== null) this.assertCategoryAssignable(db, categoryId);

      const productRes = db.prepare(
        "INSERT INTO products (name, category_id, description, base_price_tetri, base_cost_tetri, unit_type, is_active, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)"
      ).run(
        trimmedName,
        categoryId,
        optionalString(input.description, 1000, 'აღწერა'),
        basePrice,
        baseCost,
        unitType,
        now,
        now
      );
      const productId = Number(productRes.lastInsertRowid);

      input.variants.forEach((v, i) => this.insertVariant(db, requester, productId, v, codesPerVariant[i], baseCost, unitType, now));

      (input.image_paths || []).forEach((img, idx) => {
        const fileName = storeProductImage(db, img);
        db.prepare(
          "INSERT INTO product_images (product_id, file_path, is_primary, created_at) VALUES (?, ?, ?, ?)"
        ).run(productId, fileName, idx === 0 ? 1 : 0, now);
      });

      this.audit(requester.id, 'PRODUCT_CREATE', 'products', productId, `Created product ${trimmedName}`);
      return this.getProductById(productId, { includeArchived: true })!;
    }, this.db);
  }

  // --- Product Editing ---

  /** Changes name, category, description, price or purchase cost. History is not touched. */
  updateProduct(requester: User, rawInput: UpdateProductInput): Product {
    this.requirePermission(requester, 'products.edit', 'პროდუქტის რედაქტირების უფლება არ გაქვთ');
    const input = requireObject<UpdateProductInput>(rawInput, 'პროდუქტი');
    const productId = requireId(input.productId, 'პროდუქტი');

    if (has(input, 'base_price_tetri')) {
      this.requirePermission(requester, 'products.change_price', 'ფასის შეცვლის უფლება არ გაქვთ');
    }
    if (has(input, 'base_cost_tetri')) {
      this.requirePermission(requester, 'products.change_cost', 'თვითღირებულების შეცვლის უფლება არ გაქვთ');
    }

    return runInTransaction((db) => {
      const before = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as any;
      if (!before) throw new Error('პროდუქტი ვერ მოიძებნა');

      const next = { ...before };
      if (has(input, 'name')) next.name = requireString(input.name, 120, 'პროდუქტის დასახელება');
      if (has(input, 'category_id')) {
        next.category_id = optionalId(input.category_id || null, 'კატეგორია');
        if (next.category_id && next.category_id !== before.category_id) this.assertCategoryAssignable(db, next.category_id);
      }
      if (has(input, 'description')) next.description = optionalString(input.description, 1000, 'აღწერა');
      if (has(input, 'base_price_tetri')) {
        next.base_price_tetri = requireAmount(input.base_price_tetri, 'გასაყიდი ფასი');
        if (next.base_price_tetri <= 0) throw new Error('გასაყიდი ფასი უნდა იყოს 0-ზე მეტი');
      }
      if (has(input, 'base_cost_tetri')) next.base_cost_tetri = optionalAmount(input.base_cost_tetri, 'თვითღირებულება');
      if (has(input, 'unit_type') && input.unit_type !== undefined) {
        const newUnitType = input.unit_type === 'kg' ? 'kg' : 'piece';
        if (newUnitType !== (before.unit_type || 'piece')) {
          // Block unit_type change if product has sales history
          const hasSales = (db.prepare(
            "SELECT COUNT(*) AS n FROM sale_items si JOIN product_variants pv ON si.variant_id = pv.id WHERE pv.product_id = ?"
          ).get(productId) as any).n > 0;
          if (hasSales) {
            throw new Error('გაყიდვების ისტორიის მქონე პროდუქტს ერთეულის ტიპი ვეღარ შეეცვლება');
          }
          next.unit_type = newUnitType;
        }
      }

      const changed = ['name', 'category_id', 'description', 'base_price_tetri', 'base_cost_tetri', 'unit_type'].filter((k) => before[k] !== next[k]);
      if (changed.length === 0) return this.getProductById(productId, { includeArchived: true })!;

      const now = new Date().toISOString();
      db.prepare(
        "UPDATE products SET name = ?, category_id = ?, description = ?, base_price_tetri = ?, base_cost_tetri = ?, unit_type = ?, updated_at = ? WHERE id = ?"
      ).run(next.name, next.category_id, next.description, next.base_price_tetri, next.base_cost_tetri, next.unit_type || 'piece', now, productId);

      // Sync unit_type to all variants of this product
      if (changed.includes('unit_type')) {
        db.prepare("UPDATE product_variants SET unit_type = ? WHERE product_id = ?").run(next.unit_type || 'piece', productId);
      }

      this.audit(requester.id, 'PRODUCT_UPDATE', 'products', productId, {
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, next[k]])),
      });
      return this.getProductById(productId, { includeArchived: true })!;
    }, this.db);
  }

  /** Archives (hides from sale) or restores a product. Sales history is unaffected. */
  setProductActive(requester: User, productId: number, isActive: boolean): Product {
    this.requirePermission(requester, 'products.archive', 'პროდუქტის დაარქივების უფლება არ გაქვთ');
    const id = requireId(productId, 'პროდუქტი');
    const row = this.db.prepare("SELECT id, is_active FROM products WHERE id = ?").get(id) as any;
    if (!row) throw new Error('პროდუქტი ვერ მოიძებნა');
    this.db.prepare("UPDATE products SET is_active = ?, updated_at = ? WHERE id = ?").run(isActive ? 1 : 0, new Date().toISOString(), id);
    this.audit(requester.id, isActive ? 'PRODUCT_RESTORE' : 'PRODUCT_ARCHIVE', 'products', id, { before: row.is_active, after: isActive ? 1 : 0 });
    return this.getProductById(id, { includeArchived: true })!;
  }

  addVariant(requester: User, productId: number, rawVariant: VariantInput): Product {
    this.requirePermission(requester, 'products.edit', 'ვარიანტის დამატების უფლება არ გაქვთ');
    const id = requireId(productId, 'პროდუქტი');
    const v = requireObject<VariantInput>(rawVariant, 'ვარიანტი');
    const product = this.db.prepare("SELECT id, base_cost_tetri, unit_type FROM products WHERE id = ?").get(id) as any;
    if (!product) throw new Error('პროდუქტი ვერ მოიძებნა');
    const codes = this.normalizeVariantCodes(v, new Set());
    return runInTransaction((db) => {
      const variantId = this.insertVariant(db, requester, id, v, codes, product.base_cost_tetri, product.unit_type || 'piece', new Date().toISOString());
      this.audit(requester.id, 'VARIANT_CREATE', 'product_variants', variantId, `Variant added to product ${id}`);
      return this.getProductById(id, { includeArchived: true })!;
    }, this.db);
  }

  /**
   * Changes a variant's name, size, colour, price, cost or codes. Stock is changed only through
   * restock/correction so that every change has a movement and FIFO layer.
   */
  updateVariant(requester: User, rawInput: UpdateVariantInput): Product {
    this.requirePermission(requester, 'products.edit', 'ვარიანტის რედაქტირების უფლება არ გაქვთ');
    const input = requireObject<UpdateVariantInput>(rawInput, 'ვარიანტი');
    const variantId = requireId(input.variantId, 'ვარიანტი');

    if (has(input, 'price_override_tetri')) {
      this.requirePermission(requester, 'products.change_price', 'ფასის შეცვლის უფლება არ გაქვთ');
    }
    if (has(input, 'cost_override_tetri')) {
      this.requirePermission(requester, 'products.change_cost', 'თვითღირებულების შეცვლის უფლება არ გაქვთ');
    }

    return runInTransaction((db) => {
      const before = db.prepare("SELECT * FROM product_variants WHERE id = ?").get(variantId) as any;
      if (!before) throw new Error('ვარიანტი ვერ მოიძებნა');
      const next = { ...before };
      if (has(input, 'variant_name')) next.variant_name = optionalString(input.variant_name, 80, 'ვარიანტის დასახელება') || 'სტანდარტული';
      if (has(input, 'size')) next.size = optionalString(input.size, 40, 'ზომა');
      if (has(input, 'color')) next.color = optionalString(input.color, 40, 'ფერი');
      if (has(input, 'price_override_tetri')) {
        next.price_override_tetri = optionalAmount(input.price_override_tetri, 'ვარიანტის ფასი');
        if (next.price_override_tetri === 0) throw new Error('ვარიანტის ფასი უნდა იყოს 0-ზე მეტი');
      }
      if (has(input, 'cost_override_tetri')) next.cost_override_tetri = optionalAmount(input.cost_override_tetri, 'ვარიანტის თვითღირებულება');

      const fields = ['variant_name', 'size', 'color', 'price_override_tetri', 'cost_override_tetri'];
      const changed = fields.filter((k) => before[k] !== next[k]);
      db.prepare(
        "UPDATE product_variants SET variant_name = ?, size = ?, color = ?, price_override_tetri = ?, cost_override_tetri = ? WHERE id = ?"
      ).run(next.variant_name, next.size, next.color, next.price_override_tetri, next.cost_override_tetri, variantId);

      const codeChanges: Record<string, { before: string | null; after: string | null }> = {};
      const replaceCode = (type: 'manual_5digit' | 'barcode', raw: string | null | undefined) => {
        const current = db.prepare("SELECT id, code_value FROM product_codes WHERE variant_id = ? AND code_type = ? ORDER BY id LIMIT 1").get(variantId, type) as any;
        const value = raw == null || String(raw).trim() === '' ? null
          : type === 'manual_5digit' ? this.validateManualCode(String(raw)) : this.validateBarcode(String(raw));
        if ((current?.code_value ?? null) === value) return;
        if (value) this.checkCodeUniqueness(value, variantId);
        if (current) db.prepare("DELETE FROM product_codes WHERE id = ?").run(current.id);
        if (value) db.prepare("INSERT INTO product_codes (variant_id, code_type, code_value) VALUES (?, ?, ?)").run(variantId, type, value);
        codeChanges[type] = { before: current?.code_value ?? null, after: value };
      };
      if (has(input, 'manual_code')) replaceCode('manual_5digit', input.manual_code);
      if (has(input, 'barcode')) replaceCode('barcode', input.barcode);
      const codeCount = (db.prepare("SELECT COUNT(*) AS n FROM product_codes WHERE variant_id = ?").get(variantId) as any).n;
      if (codeCount === 0) throw new Error('ვარიანტს უნდა დარჩეს მინიმუმ ერთი კოდი (5-ნიშნა კოდი ან შტრიხკოდი)');

      if (changed.length > 0 || Object.keys(codeChanges).length > 0) {
        db.prepare("UPDATE products SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), before.product_id);
        this.audit(requester.id, 'VARIANT_UPDATE', 'product_variants', variantId, {
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, next[k]])),
          codes: codeChanges,
        });
      }
      return this.getProductById(before.product_id, { includeArchived: true })!;
    }, this.db);
  }

  setVariantActive(requester: User, variantId: number, isActive: boolean): Product {
    this.requirePermission(requester, 'products.archive', 'ვარიანტის დაარქივების უფლება არ გაქვთ');
    const id = requireId(variantId, 'ვარიანტი');
    const row = this.db.prepare("SELECT id, product_id, is_active FROM product_variants WHERE id = ?").get(id) as any;
    if (!row) throw new Error('ვარიანტი ვერ მოიძებნა');
    if (!isActive) {
      const active = (this.db.prepare("SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ? AND is_active = 1").get(row.product_id) as any).n;
      if (active <= 1 && row.is_active === 1) {
        throw new Error('პროდუქტის ბოლო აქტიური ვარიანტის დაარქივება შეუძლებელია — დაარქივეთ მთლიანი პროდუქტი');
      }
    }
    this.db.prepare("UPDATE product_variants SET is_active = ? WHERE id = ?").run(isActive ? 1 : 0, id);
    this.audit(requester.id, isActive ? 'VARIANT_RESTORE' : 'VARIANT_ARCHIVE', 'product_variants', id, { before: row.is_active, after: isActive ? 1 : 0 });
    return this.getProductById(row.product_id, { includeArchived: true })!;
  }

  // --- Product Querying ---

  private decorateImages(images: any[]): ProductImage[] {
    return images.map((img) => ({ ...img, url: imageUrl(img.file_path) }));
  }

  /** Variants (with codes) and images for many products in three queries instead of N+1. */
  private attachDetails(products: any[], includeArchived: boolean): void {
    if (products.length === 0) return;
    const ids = products.map((p) => p.id);
    const byProduct = new Map<number, any>(products.map((p) => [p.id, p]));
    for (const p of products) {
      p.variants = [];
      p.images = [];
    }
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));

    for (const chunk of chunks) {
      const marks = chunk.map(() => '?').join(',');
      const variants = this.db.prepare(
        `SELECT * FROM product_variants WHERE product_id IN (${marks}) ${includeArchived ? '' : 'AND is_active = 1'} ORDER BY id ASC`
      ).all(...chunk) as any[];
      const variantById = new Map<number, any>();
      for (const v of variants) {
        const p = byProduct.get(v.product_id);
        v.codes = [];
        v.effective_price_tetri = v.price_override_tetri ?? p.base_price_tetri;
        p.variants.push(v);
        variantById.set(v.id, v);
      }
      if (variants.length > 0) {
        const vids = variants.map((v) => v.id);
        for (let i = 0; i < vids.length; i += 500) {
          const part = vids.slice(i, i + 500);
          const codes = this.db.prepare(
            `SELECT * FROM product_codes WHERE variant_id IN (${part.map(() => '?').join(',')}) ORDER BY id ASC`
          ).all(...part) as unknown as ProductCode[];
          for (const c of codes) variantById.get(c.variant_id)?.codes.push(c);
        }
      }
      const images = this.db.prepare(
        `SELECT * FROM product_images WHERE product_id IN (${marks}) ORDER BY is_primary DESC, id ASC`
      ).all(...chunk) as any[];
      for (const img of this.decorateImages(images)) byProduct.get(img.product_id)?.images.push(img);
    }
  }

  getProductById(productId: number, options: { includeArchived?: boolean } = {}): Product | null {
    const product = this.db.prepare(`
      SELECT p.*, c.name as category_name, c.color as category_color
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?
    `).get(productId) as any;

    if (!product) return null;
    this.attachDetails([product], !!options.includeArchived);
    return product;
  }

  /**
   * Search / Filter Products for inventory & management lists.
   */
  listProducts(params?: {
    searchTerm?: string;
    categoryId?: number;
    stockFilter?: 'all' | 'in_stock' | 'zero' | 'low';
    lowStockThreshold?: number;
    includeArchived?: boolean;
    archivedOnly?: boolean;
  }): Product[] {
    let sql = `
      SELECT p.*, c.name as category_name, c.color as category_color
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;
    const args: any[] = [];
    if (params?.archivedOnly) {
      sql += " AND p.is_active = 0";
    } else if (!params?.includeArchived) {
      sql += " AND p.is_active = 1";
    }

    if (params?.categoryId) {
      sql += " AND p.category_id = ?";
      args.push(params.categoryId);
    }

    if (params?.searchTerm && params.searchTerm.trim()) {
      const term = `%${params.searchTerm.trim()}%`;
      sql += ` AND (
        p.name LIKE ? OR
        p.id IN (
          SELECT pv.product_id FROM product_variants pv
          JOIN product_codes pc ON pc.variant_id = pv.id
          WHERE pc.code_value LIKE ?
        ) OR
        p.id IN (SELECT pv.product_id FROM product_variants pv WHERE pv.variant_name LIKE ? OR pv.size LIKE ? OR pv.color LIKE ?) OR
        c.name LIKE ?
      )`;
      args.push(term, term, term, term, term, term);
    }

    sql += " ORDER BY p.id DESC";

    const products = this.db.prepare(sql).all(...args) as any[];
    this.attachDetails(products, !!(params?.includeArchived || params?.archivedOnly));

    const threshold = params?.lowStockThreshold ?? 5;
    return products.filter((p) => {
      const totalStock = p.variants.filter((v: any) => v.is_active === 1).reduce((acc: number, v: any) => acc + (v.stock_quantity || 0), 0);
      if (params?.stockFilter === 'in_stock' && totalStock <= 0) return false;
      if (params?.stockFilter === 'zero' && totalStock > 0) return false;
      if (params?.stockFilter === 'low' && (totalStock > threshold || totalStock === 0)) return false;
      return true;
    });
  }

  /**
   * Fast Code Lookup for Barcode Scanner or Manual 5-Digit input.
   * Returns exact matched variant, parent product, and image.
   */
  lookupByCode(rawCode: string): {
    variant: ProductVariant;
    product: Product;
    code_used: string;
    code_type: string;
  } | null {
    const code = String(rawCode ?? '').trim();
    if (!code || code.length > 64) return null;

    const codeRow = this.db.prepare(`
      SELECT pc.code_type, pc.code_value, pv.id as variant_id, pv.product_id
      FROM product_codes pc
      JOIN product_variants pv ON pc.variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      WHERE pc.code_value = ? AND pv.is_active = 1 AND p.is_active = 1
    `).get(code) as any;

    if (!codeRow) return null;

    const product = this.getProductById(codeRow.product_id);
    if (!product) return null;

    const variant = product.variants?.find(v => v.id === codeRow.variant_id);
    if (!variant) return null;

    return {
      variant,
      product,
      code_used: codeRow.code_value,
      code_type: codeRow.code_type
    };
  }

  /**
   * Add image to existing product (a data: URL from the renderer; stored as a file).
   */
  addImage(requester: User, productId: number, image: string, isPrimary: boolean = false): ProductImage {
    this.requirePermission(requester, 'products.edit', 'სურათის მართვის უფლება არ გაქვთ');
    const id = requireId(productId, 'პროდუქტი');
    if (!this.db.prepare("SELECT 1 FROM products WHERE id = ?").get(id)) throw new Error('პროდუქტი ვერ მოიძებნა');
    if (typeof image !== 'string' || !image.trim()) {
      throw new Error('სურათის მისამართი სავალდებულოა');
    }
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?").get(id) as any).n;
    if (count >= 12) throw new Error('ერთ პროდუქტზე მაქსიმუმ 12 ფოტოა დასაშვები');

    return runInTransaction((db) => {
      const fileName = storeProductImage(db, image);
      const primary = isPrimary || count === 0;
      const now = new Date().toISOString();
      if (primary) {
        db.prepare("UPDATE product_images SET is_primary = 0 WHERE product_id = ?").run(id);
      }
      const res = db.prepare(`
        INSERT INTO product_images (product_id, file_path, is_primary, created_at)
        VALUES (?, ?, ?, ?)
      `).run(id, fileName, primary ? 1 : 0, now);
      this.audit(requester.id, 'PRODUCT_IMAGE_ADD', 'products', id, `Photo ${fileName} added`);
      return this.decorateImages([{ id: Number(res.lastInsertRowid), product_id: id, file_path: fileName, is_primary: primary ? 1 : 0, created_at: now }])[0];
    }, this.db);
  }

  setPrimaryImage(requester: User, imageId: number): void {
    this.requirePermission(requester, 'products.edit', 'სურათის მართვის უფლება არ გაქვთ');
    const id = requireId(imageId, 'ფოტო');
    const img = this.db.prepare("SELECT id, product_id FROM product_images WHERE id = ?").get(id) as any;
    if (!img) throw new Error('ფოტო ვერ მოიძებნა');
    runInTransaction((db) => {
      db.prepare("UPDATE product_images SET is_primary = 0 WHERE product_id = ?").run(img.product_id);
      db.prepare("UPDATE product_images SET is_primary = 1 WHERE id = ?").run(id);
    }, this.db);
  }

  /**
   * Delete product image (the file is removed when nothing refers to it any more).
   */
  deleteImage(requester: User, imageId: number): void {
    this.requirePermission(requester, 'products.edit', 'სურათის მართვის უფლება არ გაქვთ');
    const id = requireId(imageId, 'ფოტო');
    const img = this.db.prepare("SELECT * FROM product_images WHERE id = ?").get(id) as any;
    if (!img) return;
    this.db.prepare("DELETE FROM product_images WHERE id = ?").run(id);
    if (img.is_primary) {
      const next = this.db.prepare("SELECT id FROM product_images WHERE product_id = ? ORDER BY id LIMIT 1").get(img.product_id) as any;
      if (next) this.db.prepare("UPDATE product_images SET is_primary = 1 WHERE id = ?").run(next.id);
    }
    deleteImageFileIfUnused(this.db, img.file_path);
    this.audit(requester.id, 'PRODUCT_IMAGE_DELETE', 'products', img.product_id, `Photo ${img.file_path.startsWith('data:') ? '(inline)' : img.file_path} deleted`);
  }
}
