/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inventory Management Domain Service.
 * Handles Restock, Stock Corrections, and Movement Ledgers.
 *
 * Invariant: product_variants.stock_quantity equals the sum of the variant's FIFO lot
 * remainders. Restocks add a lot, corrections consume (oldest first) or add a lot, and
 * sales/returns move units between lots, so the counter and the cost layers never drift.
 *
 * KG products: stock_quantity is stored in grams (integer). added_quantity and
 * counted_quantity for KG variants must also be integer grams.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { RestockPayload, StockCorrectionPayload, User } from '../../shared/types.ts';
import { AuthService } from './authService.ts';
import { optionalAmount, optionalString, requireCount, requireGramCount, requireGrams, requireId, requireObject, requireQuantity, requireString } from './validation.ts';

export class InventoryService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
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

  /**
   * Restocks an existing variant.
   * Creates an inventory lot for FIFO cost attribution and an inventory movement.
   * Without an explicit unit cost the variant's configured purchase cost is used; if none is
   * configured the lot cost stays unknown (never 0).
   *
   * For KG variants: added_quantity must be integer grams (≥ 1).
   * unit_cost_tetri for KG products represents the cost per 1000 g (1 kg).
   */
  restockVariant(requester: User, rawPayload: RestockPayload): { new_stock: number } {
    this.requirePermission(requester, 'inventory.receive', 'მარაგის შევსების უფლება არ გაქვთ');
    const payload = requireObject<any>(rawPayload, 'მარაგის შევსება');
    const variantId = requireId(payload.variant_id, 'პროდუქტის ვარიანტი');
    if (typeof payload.added_quantity === 'number' && payload.added_quantity <= 0) {
      throw new Error('დამატებული რაოდენობა უნდა იყოს 1 ან მეტი');
    }
    const explicitCost = optionalAmount(payload.unit_cost_tetri, 'ერთეულის თვითღირებულება');
    const notes = optionalString(payload.notes, 300, 'შენიშვნა');

    return runInTransaction((db) => {
      const variant = db.prepare(`
        SELECT pv.id, pv.stock_quantity, pv.cost_override_tetri, pv.unit_type,
               p.base_cost_tetri, p.unit_type as product_unit_type
        FROM product_variants pv JOIN products p ON p.id = pv.product_id
        WHERE pv.id = ?
      `).get(variantId) as any;

      if (!variant) {
        throw new Error('პროდუქტის ვარიანტი ვერ მოიძებნა');
      }

      const isKg = (variant.unit_type || variant.product_unit_type || 'piece') === 'kg';
      const unitType = isKg ? 'kg' : 'piece';

      // Validate quantity: grams for KG, pieces for regular
      let added: number;
      if (isKg) {
        added = requireGrams(payload.added_quantity, 'დამატებული რაოდენობა (გ)');
      } else {
        added = requireQuantity(payload.added_quantity, 'დამატებული რაოდენობა');
      }

      const now = new Date().toISOString();
      const newStock = variant.stock_quantity + added;
      const unitCost = explicitCost ?? variant.cost_override_tetri ?? variant.base_cost_tetri ?? null;

      db.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(newStock, variant.id);

      const moveRes = db.prepare(
        "INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, unit_type, reason, user_id, created_at) " +
        "VALUES (?, 'restock', ?, ?, ?, ?, ?, ?, ?)"
      ).run(variant.id, added, newStock, unitCost, unitType, notes || 'მარაგის შევსება', requester.id, now);
      const movementId = Number(moveRes.lastInsertRowid);

      db.prepare(
        "INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, unit_type, movement_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(variant.id, added, added, unitCost, unitType, movementId, now);

      db.prepare(
        "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'INVENTORY_RESTOCK', 'product_variants', ?, ?, ?)"
      ).run(requester.id, String(variant.id), `Restocked +${added}${isKg ? 'g' : ''} to stock ${newStock}, unit cost ${unitCost ?? 'unknown'}`, now);

      return { new_stock: newStock };
    }, this.db);
  }

  /**
   * Corrects physical stock count.
   * Records difference and reason in audit and movement ledger. A shortfall consumes the
   * oldest cost layers; a surplus is added as a layer at the configured purchase cost (or unknown).
   * A correction is never a sale.
   *
   * For KG variants: counted_quantity must be integer grams (≥ 0).
   */
  correctStock(requester: User, rawPayload: StockCorrectionPayload): { new_stock: number; diff: number } {
    this.requirePermission(requester, 'inventory.adjust', 'მარაგის კორექტირების უფლება არ გაქვთ');
    const payload = requireObject<any>(rawPayload, 'მარაგის კორექცია');
    const variantId = requireId(payload.variant_id, 'პროდუქტის ვარიანტი');

    const reasonRaw = typeof payload.reason === 'string' ? payload.reason.trim() : '';
    if (!reasonRaw) {
      throw new Error('მარაგის კორექტირებისთვის მიზეზის მითითება სავალდებულოა');
    }
    const reason = requireString(reasonRaw, 300, 'კორექციის მიზეზი');

    if (typeof payload.counted_quantity === 'number' && payload.counted_quantity < 0) {
      throw new Error('დათვლილი მარაგი არ შეიძლება იყოს უარყოფითი');
    }

    return runInTransaction((db) => {
      const variant = db.prepare(`
        SELECT pv.id, pv.stock_quantity, pv.cost_override_tetri, pv.unit_type,
               p.base_cost_tetri, p.unit_type as product_unit_type
        FROM product_variants pv JOIN products p ON p.id = pv.product_id
        WHERE pv.id = ?
      `).get(variantId) as any;

      if (!variant) {
        throw new Error('პროდუქტის ვარიანტი ვერ მოიძებნა');
      }

      const isKg = (variant.unit_type || variant.product_unit_type || 'piece') === 'kg';
      const unitType = isKg ? 'kg' : 'piece';

      let counted: number;
      if (isKg) {
        counted = requireGramCount(payload.counted_quantity, 'დათვლილი მარაგი (გ)');
      } else {
        counted = requireCount(payload.counted_quantity, 'დათვლილი მარაგი');
      }

      const diff = counted - variant.stock_quantity;
      if (diff === 0) {
        return { new_stock: variant.stock_quantity, diff: 0 };
      }

      const now = new Date().toISOString();
      db.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(counted, variant.id);

      let movementCost: number | null = null;
      let lotToCreate: { qty: number; cost: number | null } | null = null;

      if (diff < 0) {
        // Missing units leave the oldest cost layers first.
        let missing = -diff;
        let knownCost = 0;
        let unknown = 0;
        const lots = db.prepare(
          "SELECT id, remaining_quantity, unit_cost_tetri FROM inventory_lots WHERE variant_id = ? AND remaining_quantity > 0 ORDER BY id ASC"
        ).all(variant.id) as Array<{ id: number; remaining_quantity: number; unit_cost_tetri: number | null }>;
        for (const lot of lots) {
          if (missing <= 0) break;
          const take = Math.min(missing, lot.remaining_quantity);
          db.prepare("UPDATE inventory_lots SET remaining_quantity = remaining_quantity - ? WHERE id = ?").run(take, lot.id);
          if (lot.unit_cost_tetri === null) unknown += take; else knownCost += take * lot.unit_cost_tetri;
          missing -= take;
        }
        unknown += missing;
        movementCost = unknown === 0 ? Math.round(knownCost / -diff) : null;
      } else {
        lotToCreate = { qty: diff, cost: variant.cost_override_tetri ?? variant.base_cost_tetri ?? null };
        movementCost = lotToCreate.cost;
      }

      const moveRes = db.prepare(
        "INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, unit_type, reason, user_id, created_at) " +
        "VALUES (?, 'correction', ?, ?, ?, ?, ?, ?, ?)"
      ).run(variant.id, diff, counted, movementCost, unitType, `კორექცია: ${reason}`, requester.id, now);

      if (lotToCreate) {
        db.prepare(
          "INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, unit_type, movement_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(variant.id, lotToCreate.qty, lotToCreate.qty, lotToCreate.cost, unitType, Number(moveRes.lastInsertRowid), now);
      }

      db.prepare(
        "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'INVENTORY_CORRECTION', 'product_variants', ?, ?, ?)"
      ).run(requester.id, String(variant.id), `Stock corrected from ${variant.stock_quantity} to ${counted} (${diff >= 0 ? '+' : ''}${diff}${isKg ? 'g' : ''}). Reason: ${reason}`, now);

      return { new_stock: counted, diff };
    }, this.db);
  }

  /**
   * Retrieves movement history for a variant or all variants.
   */
  getMovements(variantId?: number, limit: number = 50): any[] {
    let sql = `
      SELECT im.*, pv.variant_name, pv.unit_type as variant_unit_type,
             p.name as product_name, p.unit_type as product_unit_type,
             u.name as user_name
      FROM inventory_movements im
      JOIN product_variants pv ON im.variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      LEFT JOIN users u ON im.user_id = u.id
    `;
    const params: any[] = [];
    if (variantId) {
      sql += " WHERE im.variant_id = ?";
      params.push(variantId);
    }
    sql += " ORDER BY im.id DESC LIMIT ?";
    params.push(Math.min(Math.max(1, Math.floor(Number(limit)) || 50), 1000));

    return this.db.prepare(sql).all(...params);
  }

  /** Variants whose stock counter disagrees with their FIFO layers (should always be empty). */
  findStockLotMismatches(): Array<{ variant_id: number; stock_quantity: number; lot_quantity: number }> {
    return this.db.prepare(`
      SELECT pv.id AS variant_id, pv.stock_quantity,
             COALESCE((SELECT SUM(l.remaining_quantity) FROM inventory_lots l WHERE l.variant_id = pv.id), 0) AS lot_quantity
      FROM product_variants pv
      WHERE pv.stock_quantity != COALESCE((SELECT SUM(l.remaining_quantity) FROM inventory_lots l WHERE l.variant_id = pv.id), 0)
    `).all() as any[];
  }
}
