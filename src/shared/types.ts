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
  file_path: string;
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
}

export interface CheckoutPayload {
  items: Array<{
    variant_id: number;
    quantity: number;
    unit_price_tetri: number;
  }>;
  payment_method: PaymentMethod;
  customer_id?: number | null;
  cash_received_tetri: number;
  notes?: string;
  idempotency_key?: string;
}

export interface SaleItem {
  id: number;
  sale_id: number;
  variant_id: number;
  product_name_snap: string;
  variant_name_snap?: string;
  code_snap?: string;
  quantity: number;
  unit_price_tetri: number;
  unit_cost_tetri?: number | null;
  total_price_tetri: number;
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
  total_tetri: number;
  cash_received_tetri: number;
  change_given_tetri: number;
  debt_amount_tetri: number;
  debt_remaining_tetri?: number;
  status: 'completed' | 'returned' | 'partially_returned';
  notes?: string;
  idempotency_key?: string;
  created_at: string;
  items?: SaleItem[];
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
}

export interface BackupInfo {
  filename: string;
  filepath: string;
  size_bytes: number;
  created_at: string;
  checksum_sha256: string;
  is_valid: boolean;
  integrity_status: string;
  stats?: {
    products_count: number;
    sales_count: number;
    customers_count: number;
    total_debt_tetri?: number;
  };
}

export interface ReturnItemPayload {
  sale_item_id: number;
  variant_id: number;
  quantity: number;
  condition: 'resellable' | 'damaged';
}

export interface ReturnPayload {
  sale_id: number;
  items: ReturnItemPayload[];
  reason?: string;
}

export interface ExchangePayload {
  original_sale_id: number;
  return_items: ReturnItemPayload[];
  new_items: Array<{
    variant_id: number;
    quantity: number;
    unit_price_tetri: number;
  }>;
  cash_adjusted_tetri: number; // positive = customer paid extra cash; negative = store refunded cash
  notes?: string;
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
  period_start: string;
  period_end: string;
  total_sales_count: number;
  total_sales_revenue_tetri: number;    // Gross sales volume
  cash_collected_direct_tetri: number;  // Cash paid in checkout
  cash_collected_debts_tetri: number;   // Cash paid towards past debts (NOT double-counted in sales)
  total_cash_inflow_tetri: number;      // direct + debt repayments - cash refunds
  total_new_debt_tetri: number;         // Debts created during this period
  total_returns_amount_tetri: number;   // Value of returned goods
  total_expenses_tetri: number;         // Shop expenses (rent, utilities, etc.)
  cost_of_goods_sold_tetri: number;     // Known COGS via FIFO lot attribution
  has_unknown_costs: boolean;           // True if some sold items had unknown/null purchase cost
  unknown_cost_items_count: number;
  estimated_gross_profit_tetri: number | null; // Null or partial if unknown costs exist
  net_cash_flow_tetri: number;
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



