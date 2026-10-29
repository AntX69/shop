/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Products, Categories, Variants, and Codes Domain Service.
 * Runs in main process / backend with SQLite transactions.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { Category, Product, ProductVariant, ProductCode, ProductImage, User } from '../../shared/types.ts';

export interface CreateProductInput {
  name: string;
  category_id?: number | null;
  description?: string;
  base_price_tetri: number;
  base_cost_tetri?: number | null;
  variants: Array<{
    variant_name: string;
    size?: string;
    color?: string;
    price_override_tetri?: number | null;
    cost_override_tetri?: number | null;
    initial_stock: number;
    codes: Array<{
      code_type: 'barcode' | 'manual_5digit';
      code_value: string;
    }>;
  }>;
  image_paths?: string[];
}

export class ProductsService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  // --- Category Management (Owner only) ---

  getCategories(): Category[] {
    return this.db.prepare(
      "SELECT id, name, created_at FROM categories ORDER BY name ASC"
    ).all() as unknown as Category[];
  }

  createCategory(requester: User, name: string): Category {
    if (requester.role !== 'owner') {
      throw new Error('კატეგორიის დამატება შეუძლია მხოლოდ მფლობელს');
    }
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('კატეგორიის სახელი სავალდებულოა');
    }

    const now = new Date().toISOString();
    try {
      const res = this.db.prepare(
        "INSERT INTO categories (name, created_at) VALUES (?, ?)"
      ).run(trimmed, now);
      return { id: Number(res.lastInsertRowid), name: trimmed, created_at: now };
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE')) {
        throw new Error(`კატეგორია სახელით "${trimmed}" უკვე არსებობს`);
      }
      throw err;
    }
  }

  deleteCategory(requester: User, categoryId: number): void {
    if (requester.role !== 'owner') {
      throw new Error('კატეგორიის წაშლა შეუძლია მხოლოდ მფლობელს');
    }
    this.db.prepare("DELETE FROM categories WHERE id = ?").run(categoryId);
  }

  // --- Code Validation Helpers ---

  validateManualCode(code: string): string {
    const trimmed = code.trim();
    if (!/^\d{5}$/.test(trimmed)) {
      throw new Error(`ხელით შესაყვანი კოდი უნდა იყოს ზუსტად 5-ნიშნა რიცხვი (10000-99999). მიღებულია: "${code}"`);
    }
    return trimmed;
  }

  validateBarcode(barcode: string): string {
    const trimmed = barcode.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
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

  // --- Product Creation (Owner only) ---

  createProduct(requester: User, input: CreateProductInput): Product {
    if (requester.role !== 'owner') {
      throw new Error('პროდუქტის დამატება შეუძლია მხოლოდ მფლობელს');
    }

    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error('პროდუქტის დასახელება სავალდებულოა');
    }

    if (input.base_price_tetri <= 0) {
      throw new Error('გასაყიდი ფასი უნდა იყოს 0-ზე მეტი');
    }

    if (!input.variants || input.variants.length === 0) {
      throw new Error('პროდუქტს უნდა ჰქონდეს მინიმუმ ერთი ვარიანტი');
    }

    // Validate all codes before inserting anything
    for (const v of input.variants) {
      if (!v.codes || v.codes.length === 0) {
        throw new Error(`ვარიანტისთვის "${v.variant_name}" სავალდებულოა მინიმუმ 1 კოდი (შტრიხკოდი ან 5-ნიშნა კოდი)`);
      }
      for (const c of v.codes) {
        let cleanValue = c.code_value.trim();
        if (c.code_type === 'manual_5digit') {
          cleanValue = this.validateManualCode(cleanValue);
        } else {
          cleanValue = this.validateBarcode(cleanValue);
        }
        this.checkCodeUniqueness(cleanValue);
      }
    }

    return runInTransaction((db) => {
      const now = new Date().toISOString();

      // 1. Insert product
      const productRes = db.prepare(
        "INSERT INTO products (name, category_id, description, base_price_tetri, base_cost_tetri, is_active, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
      ).run(
        trimmedName,
        input.category_id || null,
        input.description || null,
        input.base_price_tetri,
        input.base_cost_tetri || null,
        now,
        now
      );
      const productId = Number(productRes.lastInsertRowid);

      // 2. Insert variants and their codes
      for (const v of input.variants) {
        const initialStock = Math.max(0, Math.floor(v.initial_stock || 0));
        const varRes = db.prepare(
          "INSERT INTO product_variants (product_id, variant_name, size, color, price_override_tetri, cost_override_tetri, stock_quantity, is_active) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
        ).run(
          productId,
          v.variant_name.trim() || 'სტანდარტული',
          v.size?.trim() || null,
          v.color?.trim() || null,
          v.price_override_tetri ?? null,
          v.cost_override_tetri ?? null,
          initialStock
        );
        const variantId = Number(varRes.lastInsertRowid);

        // Insert codes
        for (const c of v.codes) {
          const cleanVal = c.code_type === 'manual_5digit' 
            ? this.validateManualCode(c.code_value) 
            : this.validateBarcode(c.code_value);

          db.prepare(
            "INSERT INTO product_codes (variant_id, code_type, code_value) VALUES (?, ?, ?)"
          ).run(variantId, c.code_type, cleanVal);
        }

        // If initial stock > 0, record initial inventory movement and lot
        if (initialStock > 0) {
          const unitCost = v.cost_override_tetri ?? input.base_cost_tetri ?? null;
          const moveRes = db.prepare(
            "INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, reason, user_id, created_at) " +
            "VALUES (?, 'initial', ?, ?, ?, 'საწყისი ინვენტარიზაცია', ?, ?)"
          ).run(variantId, initialStock, initialStock, unitCost, requester.id, now);

          const movementId = Number(moveRes.lastInsertRowid);

          db.prepare(
            "INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)"
          ).run(variantId, initialStock, initialStock, unitCost, movementId, now);
        }
      }

      // 3. Insert images if any
      if (input.image_paths && input.image_paths.length > 0) {
        input.image_paths.forEach((path, idx) => {
          db.prepare(
            "INSERT INTO product_images (product_id, file_path, is_primary, created_at) VALUES (?, ?, ?, ?)"
          ).run(productId, path, idx === 0 ? 1 : 0, now);
        });
      }

      // Audit log
      db.prepare(
        "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'PRODUCT_CREATE', 'products', ?, ?, ?)"
      ).run(requester.id, String(productId), `Created product ${trimmedName}`, now);

      return this.getProductById(productId)!;
    }, this.db);
  }

  // --- Product Querying ---

  getProductById(productId: number): Product | null {
    const product = this.db.prepare(`
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?
    `).get(productId) as any;

    if (!product) return null;

    const variants = this.db.prepare(`
      SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1
    `).all(productId) as any[];

    for (const v of variants) {
      v.codes = this.db.prepare(`
        SELECT * FROM product_codes WHERE variant_id = ?
      `).all(v.id) as unknown as ProductCode[];
      v.effective_price_tetri = v.price_override_tetri ?? product.base_price_tetri;
    }

    const images = this.db.prepare(`
      SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, id ASC
    `).all(productId) as any[];

    return {
      ...product,
      variants,
      images
    };
  }

  /**
   * Search / Filter Products for inventory & management lists.
   */
  listProducts(params?: {
    searchTerm?: string;
    categoryId?: number;
    stockFilter?: 'all' | 'in_stock' | 'zero' | 'low';
    lowStockThreshold?: number;
  }): Product[] {
    let sql = `
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.is_active = 1
    `;
    const args: any[] = [];

    if (params?.categoryId) {
      sql += " AND p.category_id = ?";
      args.push(params.categoryId);
    }

    if (params?.searchTerm) {
      const term = `%${params.searchTerm.trim()}%`;
      sql += ` AND (
        p.name LIKE ? OR 
        p.id IN (
          SELECT pv.product_id FROM product_variants pv 
          JOIN product_codes pc ON pc.variant_id = pv.id 
          WHERE pc.code_value LIKE ?
        )
      )`;
      args.push(term, term);
    }

    sql += " ORDER BY p.id DESC";

    const products = this.db.prepare(sql).all(...args) as any[];

    const result: Product[] = [];
    const threshold = params?.lowStockThreshold ?? 5;

    for (const p of products) {
      const variants = this.db.prepare(`
        SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1
      `).all(p.id) as any[];

      for (const v of variants) {
        v.codes = this.db.prepare(`
          SELECT * FROM product_codes WHERE variant_id = ?
        `).all(v.id) as unknown as ProductCode[];
        v.effective_price_tetri = v.price_override_tetri ?? p.base_price_tetri;
      }

      const totalStock = variants.reduce((acc, v) => acc + (v.stock_quantity || 0), 0);

      // Apply stock filter
      if (params?.stockFilter === 'in_stock' && totalStock <= 0) continue;
      if (params?.stockFilter === 'zero' && totalStock > 0) continue;
      if (params?.stockFilter === 'low' && (totalStock > threshold || totalStock === 0)) continue;

      const images = this.db.prepare(`
        SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, id ASC
      `).all(p.id) as any[];

      result.push({
        ...p,
        variants,
        images
      });
    }

    return result;
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
    const code = rawCode.trim();
    if (!code) return null;

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
   * Add image to existing product.
   */
  addImage(requester: User, productId: number, filePath: string, isPrimary: boolean = false): ProductImage {
    if (requester.role !== 'owner') {
      throw new Error('სურათის დამატება შეუძლია მხოლოდ მფლობელს');
    }
    const cleanPath = filePath.trim();
    if (!cleanPath) {
      throw new Error('სურათის მისამართი სავალდებულოა');
    }
    const now = new Date().toISOString();
    if (isPrimary) {
      this.db.prepare("UPDATE product_images SET is_primary = 0 WHERE product_id = ?").run(productId);
    }
    const res = this.db.prepare(`
      INSERT INTO product_images (product_id, file_path, is_primary, created_at)
      VALUES (?, ?, ?, ?)
    `).run(productId, cleanPath, isPrimary ? 1 : 0, now);

    return {
      id: Number(res.lastInsertRowid),
      product_id: productId,
      file_path: cleanPath,
      is_primary: isPrimary ? 1 : 0,
      created_at: now
    };
  }

  /**
   * Delete product image.
   */
  deleteImage(requester: User, imageId: number): void {
    if (requester.role !== 'owner') {
      throw new Error('სურათის წაშლა შეუძლია მხოლოდ მფლობელს');
    }
    this.db.prepare("DELETE FROM product_images WHERE id = ?").run(imageId);
  }
}
