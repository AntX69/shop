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
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { RestockPayload, StockCorrectionPayload, User } from '../../shared/types.ts';
import { optionalAmount, optionalString, requireCount, requireId, requireObject, requireQuantity, requireString } from './validation.ts';

export class InventoryService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  /**
   * Restocks an existing variant (Owner only).
   * Creates an inventory lot for FIFO cost attribution and an inventory movement.
   * Without an explicit unit cost the variant's configured purchase cost is used; if none is
   * configured the lot cost stays unknown (never 0).
   */
  restockVariant(requester: User, rawPayload: RestockPayload): { new_stock: number } {
    if (requester.role !== 'owner') {
      throw new Error('მარაგის შევსება შეუძლია მხოლოდ მფლობელს');
    }
    const payload = requireObject<any>(rawPayload, 'მარაგის შევსება');
    const variantId = requireId(payload.variant_id, 'პროდუქტის ვარიანტი');
    if (typeof payload.added_quantity === 'number' && payload.added_quantity <= 0) {
      throw new Error('დამატებული რაოდენობა უნდა იყოს 1 ან მეტი');
    }
    const added = requireQuantity(payload.added_quantity, 'დამატებული რაოდენობა');
    const explicitCost = optionalAmount(payload.unit_cost_tetri, 'ერთეულის თვითღირებულება');
    const notes = optionalString(payload.notes, 300, 'შენიშვნა');

    return runInTransaction((db) => {
      const variant = db.prepare(`
        SELECT pv.id, pv.stock_quantity, pv.cost_override_tetri, p.base_cost_tetri
        FROM product_variants pv JOIN products p ON p.id = pv.product_id
        WHERE pv.id = ?
      `).get(variantId) as any;

      if (!variant) {
        throw new Error('პროდუქტის ვარიანტი ვერ მოიძებნა');
      }

      const now = new Date().toISOString();
      const newStock = variant.stock_quantity + added;
      const unitCost = explicitCost ?? variant.cost_override_tetri ?? variant.base_cost_tetri ?? null;

      db.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(newStock, variant.id);

      const moveRes = db.prepare(
        "INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, reason, user_id, created_at) " +
        "VALUES (?, 'restock', ?, ?, ?, ?, ?, ?)"
      ).run(variant.id, added, newStock, unitCost, notes || 'მარაგის შევსება', requester.id, now);
      const movementId = Number(moveRes.lastInsertRowid);

      db.prepare(
        "INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
      ).run(variant.id, added, added, unitCost, movementId, now);

      db.prepare(
        "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'INVENTORY_RESTOCK', 'product_variants', ?, ?, ?)"
      ).run(requester.id, String(variant.id), `Restocked +${added} to stock ${newStock}, unit cost ${unitCost ?? 'unknown'}`, now);

      return { new_stock: newStock };
    }, this.db);
  }

  /**
   * Corrects physical stock count (Owner only).
   * Records difference and reason in audit and movement ledger. A shortfall consumes the
   * oldest cost layers; a surplus is added as a layer at the configured purchase cost (or unknown).
   * A correction is never a sale.
   */
  correctStock(requester: User, rawPayload: StockCorrectionPayload): { new_stock: number; diff: number } {
    if (requester.role !== 'owner') {
      throw new Error('მარაგის კორექტირება შეუძლია მხოლოდ მფლობელს');
    }
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
    const counted = requireCount(payload.counted_quantity, 'დათვლილი მარაგი');

    return runInTransaction((db) => {
      const variant = db.prepare(`
        SELECT pv.id, pv.stock_quantity, pv.cost_override_tetri, p.base_cost_tetri
        FROM product_variants pv JOIN products p ON p.id = pv.product_id
        WHERE pv.id = ?
      `).get(variantId) as any;

      if (!variant) {
        throw new Error('პროდუქტის ვარიანტი ვერ მოიძებნა');
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
        "INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, reason, user_id, created_at) " +
        "VALUES (?, 'correction', ?, ?, ?, ?, ?, ?)"
      ).run(variant.id, diff, counted, movementCost, `კორექცია: ${reason}`, requester.id, now);

      if (lotToCreate) {
        db.prepare(
          "INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(variant.id, lotToCreate.qty, lotToCreate.qty, lotToCreate.cost, Number(moveRes.lastInsertRowid), now);
      }

      db.prepare(
        "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'INVENTORY_CORRECTION', 'product_variants', ?, ?, ?)"
      ).run(requester.id, String(variant.id), `Stock corrected from ${variant.stock_quantity} to ${counted} (${diff >= 0 ? '+' : ''}${diff}). Reason: ${reason}`, now);

      return { new_stock: counted, diff };
    }, this.db);
  }

  /**
   * Retrieves movement history for a variant or all variants.
   */
  getMovements(variantId?: number, limit: number = 50): any[] {
    let sql = `
      SELECT im.*, pv.variant_name, p.name as product_name, u.name as user_name
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
