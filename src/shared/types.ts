/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Shared Domain Types and Interfaces for StorePOS.
 * Used identically across main process (SQLite/service layer), preload, and renderer.
 */

export type UserRole = 'owner' | 'seller';

export interface User {
  id: number;
  name: string;
  role: UserRole;
  is_active: number; // 1 or 0
  created_at: string;
}

export interface UserSession {
  user: User;
  token: string;
}

export interface Category {
  id: number;
  name: string;
  created_at: string;
}

export type CodeType = 'barcode' | 'manual_5digit';

export interface ProductCode {
  id: number;
  variant_id: number;
  code_type: CodeType;
  code_value: string;
}

export interface ProductVariant {
  id: number;
  product_id: number;
  variant_name: string; // e.g. "შავი / 42"
  size?: string;
  color?: string;
  price_override_tetri?: number | null; // In tetri, if null uses product.base_price_tetri
  cost_override_tetri?: number | null;  // In tetri, purchase cost if known
  stock_quantity: number;
  is_active: number;
  effective_price_tetri?: number; // Calculated helper
  codes?: ProductCode[];
}

export interface ProductImage {
  id: number;
  product_id: number;
  file_path: string;  // stored file name (legacy rows: data: URL)
  url?: string;       // what the renderer puts in <img src>
  is_primary: number;
  created_at: string;
}

export interface Product {
  id: number;
  name: string;
  category_id?: number | null;
  category_name?: string | null;
  description?: string | null;
  base_price_tetri: number;
  base_cost_tetri?: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  variants?: ProductVariant[];
  images?: ProductImage[];
}

export interface Customer {
  id: number;
  first_name: string;
  last_name?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  created_at: string;
  total_debt_tetri?: number; // Dynamically aggregated
}

export type PaymentMethod = 'cash' | 'debt' | 'mixed';

export interface CartItem {
  variant_id: number;
  product_id: number;
  product_name: string;
  variant_name: string;
  code_used: string;
  unit_price_tetri: number;
  unit_cost_tetri?: number | null;
  quantity: number;
  available_stock: number;
  /** Owner only: discount on the whole line, in tetri. */
  line_discount_tetri?: number;
}

export interface CheckoutPayload {
  items: Array<{
    variant_id: number;
    quantity: number;
    unit_price_tetri?: number;
    /** Owner only: discount on the whole line, in tetri. */
    line_discount_tetri?: number;
  }>;
  payment_method: PaymentMethod;
  customer_id?: number | null;
  cash_received_tetri?: number;
  notes?: string;
  idempotency_key?: string;
  /** Owner only: discount on the whole cart, in tetri, spread over the lines. */
  cart_discount_tetri?: number;
  discount_reason?: string;
}

export interface SaleItem {
  id: number;
  sale_id: number;
  variant_id: number;
  product_name_snap: string;
  variant_name_snap?: string;
  code_snap?: string;
  quantity: number;
  unit_price_tetri: number;          // List price at the time of sale
  unit_cost_tetri?: number | null;   // Owner only (stripped for sellers)
  discount_tetri?: number;           // Line + cart discount share
  total_price_tetri: number;         // Net amount paid for the line
  returned_quantity: number;
}

export interface Sale {
  id: number;
  receipt_number: string;
  user_id: number;
  user_name?: string;
  customer_id?: number | null;
  customer_name?: string | null;
  payment_method: PaymentMethod;
  subtotal_tetri?: number;
  discount_tetri?: number;
  exchange_credit_tetri?: number;
  total_tetri: number;
  final_total_tetri?: number;
  paid_cash_tetri?: number;
  cash_received_tetri: number;
  change_given_tetri: number;
  debt_amount_tetri: number;
  debt_remaining_tetri?: number;
  status: 'completed' | 'returned' | 'partially_returned';
  sale_type?: 'standard' | 'exchange';
  related_return_id?: number | null;
  exchange_diff_tetri?: number;
  discount_authorized_by?: number | null;
  discount_reason?: string | null;
  notes?: string;
  idempotency_key?: string;
  created_at: string;
  items?: SaleItem[];
}

export interface ReturnItemRecord {
  id: number;
  return_id: number;
  sale_item_id: number;
  variant_id: number;
  product_name?: string;
  variant_name?: string;
  code?: string;
  quantity: number;
  unit_price_tetri: number;
  total_tetri: number;
}

export interface ReturnRecord {
  id: number;
  sale_id: number;
  receipt_number?: string;
  user_id: number;
  user_name?: string;
  customer_id?: number | null;
  customer_name?: string | null;
  return_type: 'refund' | 'exchange';
  total_refund_tetri: number;
  debt_deduction_tetri: number;
  cash_refund_tetri: number;
  exchange_credit_tetri?: number;
  related_receipt_number?: string | null;
  condition: 'resellable' | 'damaged';
  reason?: string | null;
  related_sale_id?: number | null;
  idempotency_key?: string | null;
  created_at: string;
  items?: ReturnItemRecord[];
  refund_cash_tetri?: number;
  refund_debt_reduction_tetri?: number;
}

export interface CustomerLedgerEntry {
  id: string; // unique identifier (e.g. "sale-1", "repay-2", "return-3")
  type: 'sale_debt' | 'repayment' | 'repayment_void' | 'return_deduction' | 'return_credit' | 'write_off';
  voided?: boolean;
  title?: string;
  date: string;
  receipt_number?: string;
  reference_id?: number;
  user_name?: string;
  debit_tetri: number;   // increases debt (e.g. new debt on sale)
  credit_tetri: number;  // decreases debt (e.g. cash repayment or return debt reduction)
  change_tetri?: number;
  running_balance_tetri: number;
  description: string;
  notes?: string;
}

export interface DebtRepaymentAllocation {
  id: number;
  repayment_id: number;
  sale_id: number;
  customer_id: number;
  allocated_tetri: number;
  created_at: string;
  receipt_number?: string;
}

export interface DebtRepayment {
  id: number;
  customer_id: number;
  sale_id?: number | null;
  amount_tetri: number;
  user_id: number;
  user_name?: string;
  payment_method: 'cash';
  notes?: string;
  idempotency_key?: string;
  created_at: string;
  voided_at?: string | null;
  voided_by_name?: string | null;
  void_reason?: string | null;
  allocations?: DebtRepaymentAllocation[];
}

export interface BackupInfo {
  filename: string;
  filepath: string;
  size_bytes: number;
  created_at: string;
  checksum_sha256: string;
  is_valid: boolean;
  integrity_status: string;
  kind?: 'manual' | 'auto' | 'prereset' | 'prerestore';
  schema_version?: number;
  stats?: {
    products_count: number;
    sales_count: number;
    customers_count: number;
    total_debt_tetri?: number;
  };
}

export interface ReturnItemPayload {
  sale_item_id?: number;
  variant_id: number;
  quantity: number;
  condition?: 'resellable' | 'damaged';
  reason?: string;
}

export interface ReturnPayload {
  sale_id: number;
  items: ReturnItemPayload[];
  reason?: string;
  idempotency_key?: string;
}

export interface ExchangePayload {
  original_sale_id: number;
  return_items: ReturnItemPayload[];
  new_items: Array<{
    variant_id: number;
    quantity: number;
    unit_price_tetri?: number; // ignored: new goods are priced from the database
  }>;
  cash_adjusted_tetri?: number; // optional client hint, authoritative difference calculated server-side
  cash_received_tetri?: number;
  payment_method?: 'cash' | 'debt' | 'mixed';
  notes?: string;
  idempotency_key?: string;
}

export interface Expense {
  id: number;
  category: string;
  description: string;
  amount_tetri: number;
  user_id: number;
  user_name?: string;
  expense_date: string;
  created_at: string;
}

export interface FinancialSummary {
  period_preset?: string;
  period_start: string;                 // First local (Tbilisi) day, or 'დასაწყისიდან'
  period_end: string;                   // Last local day, or 'დღემდე'
  period_start_utc?: string | null;
  period_end_utc?: string | null;       // Exclusive

  total_sales_count: number;
  exchange_sales_count?: number;
  sales_before_discount_tetri?: number; // List-price value of goods sold
  total_discounts_tetri?: number;       // Owner discounts
  total_sales_revenue_tetri: number;    // Gross sales: charged on sales in the period (after discounts)
  total_returns_count?: number;
  total_returns_amount_tetri: number;   // Value of goods returned in the period (price paid)
  net_sales_tetri?: number;             // Gross sales - returns

  cost_of_goods_sold_tetri: number;     // FIFO cost of units sold in the period (known costs)
  cogs_reversed_by_returns_tetri?: number; // Original FIFO cost of units returned in the period
  net_cogs_tetri?: number;
  has_unknown_costs: boolean;           // Some units sold/returned have unknown purchase cost
  unknown_cost_items_count: number;     // Units sold with unknown cost
  unknown_cost_returned_items_count?: number;
  estimated_gross_profit_tetri: number | null; // Net sales - net COGS; null when any cost is unknown
  gross_profit_partial_tetri?: number;  // Same, computed from known costs only (incomplete)
  damaged_goods_writeoff_tetri?: number; // Cost of damaged returned goods (real loss)
  damaged_goods_units?: number;
  debt_written_off_tetri?: number;      // Debt forgiven by the owner
  total_expenses_tetri: number;         // Shop expenses (rent, utilities, etc.)
  operating_result_tetri?: number | null; // Gross profit - damaged write-off - debt write-off - expenses
  operating_result_partial_tetri?: number;

  cash_collected_direct_tetri: number;  // Cash kept from sales (received - change)
  cash_collected_debts_tetri: number;   // Cash paid towards debts (NOT a sale)
  repayments_count?: number;
  cash_refunded_tetri?: number;         // Cash actually paid back on returns/exchanges
  total_cash_inflow_tetri: number;      // direct + debt repayments - cash refunds
  net_cash_flow_tetri: number;          // Same as total_cash_inflow_tetri (till flow)
  net_cash_after_expenses_tetri?: number;
  exchange_credit_used_tetri?: number;  // Non-cash exchange credit applied to new sales
  returns_debt_reduction_tetri?: number;

  total_new_debt_tetri: number;         // Debts created during this period
  outstanding_debt_tetri?: number;      // All customers' open debt right now
  customers_with_debt_count?: number;
}

export interface StockCorrectionPayload {
  variant_id: number;
  counted_quantity: number;
  reason: string;
}

export interface RestockPayload {
  variant_id: number;
  added_quantity: number;
  unit_cost_tetri?: number | null;
  notes?: string;
}

export interface AuditLog {
  id: number;
  user_id?: number | null;
  user_name?: string | null;
  action: string;
  entity: string;
  entity_id?: string | null;
  details?: string | null;
  created_at: string;
}

export interface SystemErrorLog {
  id: number;
  user_id?: number | null;
  user_name?: string | null;
  error_source: string;
  error_message: string;
  stack_trace?: string | null;
  severity: 'error' | 'warning' | 'critical';
  created_at: string;
}



