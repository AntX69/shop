/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fiscal register boundary (DATECS DP-150 through the vendor's KasaGE SDK).
 *
 * NOT INTEGRATED. No fiscal command is sent anywhere in this version: compatibility of the
 * KasaGE SDK / DP-25 protocol documentation with the DP-150, the cable (RS-232 or USB-serial)
 * and the command set have not been verified on the device. The rest of StorePOS works without
 * a fiscal register; this file only fixes the contract a real driver will have to implement.
 *
 * Rules for the future driver (see docs/HARDWARE_STATUS.md):
 * - Fiscal printing happens after the SQLite transaction of the sale/return has committed, never
 *   inside it: a printer error must not roll back or duplicate a recorded sale.
 * - One fiscal document per sale or return, enforced by a UNIQUE (kind, reference_id) record;
 *   retries reuse that record, so a crash or double click cannot print twice.
 * - A failed print leaves the document "pending" for an explicit, logged retry by the user.
 * - Amounts are integer tetri; conversion to the device format happens inside the driver only.
 */

export interface FiscalLine {
  name: string;
  quantity: number;
  /** Net amount for the whole line in tetri (discounts applied). */
  totalTetri: number;
}

export interface FiscalDocumentRequest {
  kind: 'sale' | 'refund';
  /** sales.id or returns.id — the idempotency key of the fiscal document. */
  referenceId: number;
  receiptNumber: string;
  lines: FiscalLine[];
  totalTetri: number;
  cashTetri: number;
  /** Paid otherwise than cash (customer debt or exchange credit). */
  otherTetri: number;
}

export type FiscalResult =
  | { status: 'printed'; fiscalNumber: string }
  | { status: 'not_configured' }
  | { status: 'failed'; error: string; retryable: boolean };

export interface FiscalPrinter {
  readonly name: string;
  getStatus(): Promise<{ connected: boolean; detail: string }>;
  printDocument(request: FiscalDocumentRequest): Promise<FiscalResult>;
}

/** The only implementation in V1.0: reports that no fiscal register is configured. */
export class DisabledFiscalPrinter implements FiscalPrinter {
  readonly name = 'disabled';

  async getStatus() {
    return { connected: false, detail: 'ფისკალური აპარატი არ არის დაკავშირებული (DATECS DP-150 ინტეგრაცია მოლოდინშია)' };
  }

  async printDocument(_request: FiscalDocumentRequest): Promise<FiscalResult> {
    return { status: 'not_configured' };
  }
}
