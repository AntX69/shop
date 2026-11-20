/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * FIFO cost layers, the one place where purchase cost is attached to stock.
 *
 * Every layer (inventory_lots row) knows its quantity (pieces or grams) and its cost in integer
 * tetri: initial_cost_tetri when it was received and remaining_cost_tetri for what is still on the
 * shelf. Taking q units from a layer that still has R units worth C costs round(C × q / R) (nearest
 * tetri, halves up), and the last units of a layer take exactly what is left of C. So the parts of a
 * layer always add up to exactly what was paid for it, without drift, for pieces and for grams
 * alike; for pieces C = unit × R and the result is exactly unit × q (identical to RC3).
 *
 * An unknown cost (NULL) stays unknown: it is never treated as 0 and never guessed.
 */

import { DatabaseSync } from 'node:sqlite';
import { lineTotalTetri, UnitType } from '../../shared/quantity.ts';

/** round(a × b / c) for non-negative integers, halves up, without precision loss. */
function mulDivRound(a: number, b: number, c: number): number {
  const A = BigInt(a), B = BigInt(b), C = BigInt(c);
  return Number((A * B * 2n + C) / (2n * C));
}

/**
 * Cost of taking `qty` units from a layer that still has `remainingQty` units worth
 * `remainingCost` tetri. The last units take the exact remainder. null = unknown cost.
 */
export function allocateLayerCost(remainingCost: number | null, remainingQty: number, qty: number): number | null {
  if (remainingCost === null || remainingCost === undefined) return null;
  if (qty <= 0) return 0;
  if (qty >= remainingQty) return remainingCost;
  return mulDivRound(remainingCost, qty, remainingQty);
}

/**
 * Cost to put back when `qty` more units of a consumed part (`consumedQty` units that cost
 * `consumedCost`) are returned, after `alreadyReturnedQty` units worth `alreadyReturnedCost` came
 * back earlier. Cumulative, so all returns of a part add up exactly to its cost.
 */
export function returnedPartCost(
  consumedCost: number | null, consumedQty: number, alreadyReturnedQty: number, alreadyReturnedCost: number, qty: number
): number | null {
  if (consumedCost === null || consumedCost === undefined) return null;
  const totalReturned = alreadyReturnedQty + qty;
  const target = totalReturned >= consumedQty ? consumedCost : mulDivRound(consumedCost, totalReturned, consumedQty);
  return target - alreadyReturnedCost;
}

/** Total cost of a new layer: unit cost × pieces, or cost per kg × grams / 1000 (nearest tetri). */
export function layerCost(unitCost: number | null | undefined, quantity: number, unit: UnitType): number | null {
  if (unitCost === null || unitCost === undefined) return null;
  return lineTotalTetri(unitCost, quantity, unit);
}

export interface ConsumedPart {
  lot_id: number | null;
  quantity: number;
  /** Cost rate of the layer (per piece or per kg), for display only. */
  unit_cost_tetri: number | null;
  /** Exact cost of this part in tetri; null = unknown. */
  cost_tetri: number | null;
}

/**
 * Takes `quantity` units of a variant from its oldest layers and lowers each layer's remaining
 * quantity and cost. Units beyond the layers (inconsistent legacy data) get an unknown cost.
 */
export function consumeLayers(db: DatabaseSync, variantId: number, quantity: number): ConsumedPart[] {
  const lots = db.prepare(`
    SELECT id, remaining_quantity, remaining_cost_tetri, unit_cost_tetri
    FROM inventory_lots WHERE variant_id = ? AND remaining_quantity > 0 ORDER BY id ASC
  `).all(variantId) as Array<{ id: number; remaining_quantity: number; remaining_cost_tetri: number | null; unit_cost_tetri: number | null }>;
  const parts: ConsumedPart[] = [];
  let needed = quantity;
  const update = db.prepare('UPDATE inventory_lots SET remaining_quantity = remaining_quantity - ?, remaining_cost_tetri = ? WHERE id = ?');
  for (const lot of lots) {
    if (needed <= 0) break;
    const take = Math.min(needed, lot.remaining_quantity);
    const cost = allocateLayerCost(lot.remaining_cost_tetri, lot.remaining_quantity, take);
    const leftCost = lot.remaining_cost_tetri === null ? null : lot.remaining_cost_tetri - (cost as number);
    update.run(take, leftCost, lot.id);
    parts.push({ lot_id: lot.id, quantity: take, unit_cost_tetri: lot.unit_cost_tetri, cost_tetri: cost });
    needed -= take;
  }
  if (needed > 0) parts.push({ lot_id: null, quantity: needed, unit_cost_tetri: null, cost_tetri: null });
  return parts;
}

/** Sum of known part costs, or null when any part's cost is unknown. */
export function totalCost(parts: Array<{ cost_tetri: number | null }>): number | null {
  let sum = 0;
  for (const p of parts) {
    if (p.cost_tetri === null) return null;
    sum += p.cost_tetri;
  }
  return sum;
}

/** Inserts a new layer with its exact total cost; returns its id. */
export function insertLayer(
  db: DatabaseSync,
  layer: { variantId: number; quantity: number; unitCost: number | null; unitType: UnitType; movementId: number | null; now: string; cost?: number | null }
): number {
  const cost = layer.cost !== undefined ? layer.cost : layerCost(layer.unitCost, layer.quantity, layer.unitType);
  const res = db.prepare(`
    INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, unit_type, movement_id, created_at, initial_cost_tetri, remaining_cost_tetri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(layer.variantId, layer.quantity, layer.quantity, layer.unitCost, layer.unitType, layer.movementId, layer.now, cost, cost);
  return Number(res.lastInsertRowid);
}

/** Puts returned units back into their original layer at the cost they left it with. */
export function restoreToLayer(db: DatabaseSync, lotId: number, quantity: number, cost: number | null): void {
  db.prepare(`
    UPDATE inventory_lots
    SET remaining_quantity = remaining_quantity + ?,
        remaining_cost_tetri = CASE WHEN remaining_cost_tetri IS NULL OR ? IS NULL THEN NULL ELSE remaining_cost_tetri + ? END
    WHERE id = ?
  `).run(quantity, cost, cost, lotId);
}

/**
 * Average cost per piece, or per kg for weight products (display only; accounting uses the exact
 * part costs).
 */
export function averageUnitCost(total: number | null, quantity: number, unit: UnitType): number | null {
  if (total === null || quantity <= 0) return null;
  return unit === 'kg' ? mulDivRound(total, 1000, quantity) : mulDivRound(total, 1, quantity);
}
