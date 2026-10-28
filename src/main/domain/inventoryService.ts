/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Inventory Management Domain Service.
 * Handles Restock, Stock Corrections, and Movement Ledgers.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { RestockPayload, StockCorrectionPayload, User } from '../../shared/types.ts';

export class InventoryService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  /**
   * Restocks an existing variant (Owner only).
   * Creates an inventory lot for FIFO cost attribution and an inventory movement.
   */
  restockVariant(requester: User, payload: RestockPayload): { new_stock: number } {
    if (requester.role !== 'owner') {
      throw new Error('მარაგის შევსება შეუძლია მხოლოდ მფლობელს');
    }

    if (payload.added_quantity <= 0) {
      throw new Error('დამატებული რაოდენობა უნდა იყოს 1 ან მეტი');
    }

    return runInTransaction((db) => {
      const variant = db.prepare(
        "SELECT id, product_id, variant_name, stock_quantity FROM product_variants WHERE id = ?"
      ).get(payload.variant_id) as any;

      if (!variant) {
        throw new Error('პროდუქტის ვარიანტი ვერ მოიძებნა');
      }

      const now = new Date().toISOString();
      const newStock = variant.stock_quantity + payload.added_quantity;

      // Update variant stock
      db.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(newStock, variant.id);

      // Record movement
      const moveRes = db.prepare(
        "INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, reason, user_id, created_at) " +
        "VALUES (?, 'restock', ?, ?, ?, ?, ?, ?)"
      ).run(
        variant.id,
        payload.added_quantity,
        newStock,
        payload.unit_cost_tetri ?? null,
        payload.notes?.trim() || 'მარაგის შევსება',
        requester.id,
        now
      );
      const movementId = Number(moveRes.lastInsertRowid);

      // Create FIFO lot
      db.prepare(
        "INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        variant.id,
        payload.added_quantity,
        payload.added_quantity,
        payload.unit_cost_tetri ?? null,
        movementId,
        now
      );

      // Audit log
      db.prepare(
        "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'INVENTORY_RESTOCK', 'product_variants', ?, ?, ?)"
      ).run(requester.id, String(variant.id), `Restocked +${payload.added_quantity} to stock ${newStock}`, now);

      return { new_stock: newStock };
    }, this.db);
  }

  /**
   * Corrects physical stock count (Owner only).
   * Records difference and reason in audit and movement ledger.
   */
  correctStock(requester: User, payload: StockCorrectionPayload): { new_stock: number; diff: number } {
    if (requester.role !== 'owner') {
      throw new Error('მარაგის კორექტირება შეუძლია მხოლოდ მფლობელს');
    }

    const reason = payload.reason?.trim();
    if (!reason) {
      throw new Error('მარაგის კორექტირებისთვის მიზეზის მითითება სავალდებულოა');
    }

    if (payload.counted_quantity < 0) {
      throw new Error('დათვლილი მარაგი არ შეიძლება იყოს უარყოფითი');
    }

    return runInTransaction((db) => {
      const variant = db.prepare(
        "SELECT id, product_id, variant_name, stock_quantity FROM product_variants WHERE id = ?"
      ).get(payload.variant_id) as any;

      if (!variant) {
        throw new Error('პროდუქტის ვარიანტი ვერ მოიძებნა');
      }

      const diff = payload.counted_quantity - variant.stock_quantity;
      if (diff === 0) {
        return { new_stock: variant.stock_quantity, diff: 0 };
      }

      const now = new Date().toISOString();

      // Update variant stock
      db.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(payload.counted_quantity, variant.id);

      // Record movement
      db.prepare(
        "INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, reason, user_id, created_at) " +
        "VALUES (?, 'correction', ?, ?, NULL, ?, ?, ?)"
      ).run(
        variant.id,
        diff,
        payload.counted_quantity,
        `კორექცია: ${reason}`,
        requester.id,
        now
      );

      // Audit log
      db.prepare(
        "INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'INVENTORY_CORRECTION', 'product_variants', ?, ?, ?)"
      ).run(requester.id, String(variant.id), `Stock corrected from ${variant.stock_quantity} to ${payload.counted_quantity} (${diff >= 0 ? '+' : ''}${diff}). Reason: ${reason}`, now);

      return { new_stock: payload.counted_quantity, diff };
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
    params.push(limit);

    return this.db.prepare(sql).all(...params);
  }
}
