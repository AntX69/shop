/**
 * Independent verification of audit findings against the StorePOS code at
 * the GitHub HEAD (read-only; runs on a throwaway in-memory database).
 * Usage: tsx verify-findings.ts <path-to-repo-root>
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
if (!repo) throw new Error('usage: verify-findings.ts <repo-root>');
const mod = (p: string) => import(pathToFileURL(path.join(repo, p)).href);

const { handleIpcMessage } = await mod('src/main/ipc/handlers.ts');
const { getDb } = await mod('src/main/db/database.ts');

type Res = { success: boolean; data?: any; error?: string };
const ipc = (channel: string, payload?: any, token?: string): Promise<Res> =>
  handleIpcMessage({ channel, payload, token });
const must = async (channel: string, payload?: any, token?: string) => {
  const r = await ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`);
  return r.data;
};

const results: Array<{ id: string; title: string; confirmed: boolean; evidence: string }> = [];
const record = (id: string, title: string, confirmed: boolean, evidence: string) => {
  results.push({ id, title, confirmed, evidence });
  console.log(`${confirmed ? 'CONFIRMED' : 'NOT REPRODUCED'}  [${id}] ${title}\n    ${evidence}`);
};

// ---------- setup ----------
const ownerSession = await must('auth:setupOwner', { name: 'Owner', pin: '1111' });
const OT = ownerSession.token;
const sellerUser = await must('auth:addUser', { name: 'Seller', pin: '2222', role: 'seller' }, OT);
const ST = (await must('auth:login', { userId: sellerUser.id, pin: '2222' })).token;

let codeSeq = 30000;
async function product(name: string, priceTetri: number, costTetri: number | null, stock: number) {
  const p = await must('products:create', {
    name, base_price_tetri: priceTetri, base_cost_tetri: costTetri,
    variants: [{ variant_name: 'სტანდარტული', initial_stock: stock, codes: [{ code_type: 'manual_5digit', code_value: String(++codeSeq) }] }]
  }, OT);
  return { product: p, variant: p.variants[0], code: String(codeSeq) };
}
const db = getDb();
const lotsRemaining = (variantId: number) =>
  (db.prepare('SELECT COALESCE(SUM(remaining_quantity),0) n FROM inventory_lots WHERE variant_id = ?').get(variantId) as any).n;
const stockOf = (variantId: number) =>
  (db.prepare('SELECT stock_quantity n FROM product_variants WHERE id = ?').get(variantId) as any).n;

// ---------- F1: seller receives purchase costs through IPC ----------
{
  const { variant, code } = await product('ქურთუკი', 4500, 2500, 10);
  const list = await must('products:list', {}, ST);
  const look = await must('products:lookupCode', { code }, ST);
  const sale = await must('pos:checkout', { items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 4500 }], payment_method: 'cash', cash_received_tetri: 4500 }, ST);
  const history = await must('pos:searchSales', {}, ST);
  const moves = await must('inventory:getMovements', { variantId: variant.id }, ST);
  const audit = await ipc('backup:getLogs', { limit: 5 }, ST);
  const leaks = [
    list[0]?.base_cost_tetri != null && `products:list.base_cost_tetri=${list[0].base_cost_tetri}`,
    look?.product?.base_cost_tetri != null && `products:lookupCode.base_cost_tetri=${look.product.base_cost_tetri}`,
    sale.items?.[0]?.unit_cost_tetri != null && `pos:checkout→items[0].unit_cost_tetri=${sale.items[0].unit_cost_tetri}`,
    history[0]?.items?.[0]?.unit_cost_tetri != null && `pos:searchSales→unit_cost_tetri=${history[0].items[0].unit_cost_tetri}`,
    moves[0]?.unit_cost_tetri != null && `inventory:getMovements.unit_cost_tetri=${moves[0].unit_cost_tetri}`,
    audit.success && `backup:getLogs returned ${audit.data.length} audit rows to seller`,
  ].filter(Boolean);
  record('F1', 'Seller session receives purchase cost / audit data via IPC', leaks.length > 0, leaks.join('; '));
}

// ---------- F2: seller can inject exchange_credit_tetri into a normal checkout ----------
{
  const { variant } = await product('სათამაშო მანქანა', 6000, 3000, 5);
  const r = await ipc('pos:checkout', {
    items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 6000 }],
    payment_method: 'cash', cash_received_tetri: 0, exchange_credit_tetri: 6000
  }, ST);
  record('F2', 'Seller checkout with client-supplied exchange_credit_tetri pays 0 cash',
    r.success && r.data.cash_received_tetri === 0 && r.data.total_tetri === 6000,
    r.success ? `sale ${r.data.receipt_number}: total=${r.data.total_tetri}, cash_received=${r.data.cash_received_tetri}, debt=${r.data.debt_amount_tetri}` : `rejected: ${r.error}`);
}

// ---------- F3: fractional quantity accepted ----------
{
  const { variant } = await product('წინდა', 500, 200, 5);
  const r = await ipc('pos:checkout', { items: [{ variant_id: variant.id, quantity: 0.5, unit_price_tetri: 500 }], payment_method: 'cash', cash_received_tetri: 500 }, ST);
  record('F3', 'Fractional quantity (0.5) accepted by checkout', r.success,
    r.success ? `total_tetri=${r.data.total_tetri}, stock now ${stockOf(variant.id)}` : `rejected: ${r.error}`);
}

// ---------- F4: exchange on an unpaid debt sale double-counts the credit ----------
{
  const a = await product('პერანგი A', 4500, 2000, 5);
  const b = await product('პერანგი B', 4500, 2000, 5);
  const cust = await must('customers:create', { first_name: 'კლიენტი' }, ST);
  const sale = await must('pos:checkout', { items: [{ variant_id: a.variant.id, quantity: 1, unit_price_tetri: 4500 }], payment_method: 'debt', customer_id: cust.id }, ST);
  const before = (await must('customers:get', { customerId: cust.id }, ST)).total_debt_tetri;
  const ex = await must('returns:exchange', {
    original_sale_id: sale.id,
    return_items: [{ sale_item_id: sale.items[0].id, variant_id: a.variant.id, quantity: 1, condition: 'resellable' }],
    new_items: [{ variant_id: b.variant.id, quantity: 1, unit_price_tetri: 4500 }],
    payment_method: 'cash'
  }, ST);
  const after = (await must('customers:get', { customerId: cust.id }, ST)).total_debt_tetri;
  record('F4', 'Even exchange of an UNPAID debt sale wipes the debt (customer keeps new item for free)',
    before === 4500 && after === 0 && ex.new_sale.cash_received_tetri === 0,
    `debt before=${before}, after=${after} (expected 4500); new sale cash_received=${ex.new_sale.cash_received_tetri}, debt=${ex.new_sale.debt_amount_tetri}`);
}

// ---------- F5: full sale + resellable return produces a fictitious loss; returned lot loses cost ----------
{
  const { variant } = await product('თოჯინა', 4500, 2500, 3);
  const before = await must('finance:summary', {}, OT);
  const sale = await must('pos:checkout', { items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 4500 }], payment_method: 'cash', cash_received_tetri: 4500 }, OT);
  await must('returns:process', { sale_id: sale.id, items: [{ sale_item_id: sale.items[0].id, variant_id: variant.id, quantity: 1, condition: 'resellable' }] }, OT);
  const after = await must('finance:summary', {}, OT);
  const dProfit = (after.estimated_gross_profit_tetri ?? NaN) - (before.estimated_gross_profit_tetri ?? NaN);
  const netCogs = (s: any) => s.net_cogs_tetri ?? s.cost_of_goods_sold_tetri;
  const dCogs = netCogs(after) - netCogs(before);
  const lot = db.prepare("SELECT l.unit_cost_tetri AS unit_cost_tetri, l.id AS lot_id FROM inventory_lots l WHERE l.variant_id = ? AND l.remaining_quantity > 0 ORDER BY (l.unit_cost_tetri IS NULL) DESC, l.id DESC LIMIT 1").get(variant.id) as any;
  record('F5', 'Sale + resellable return of the same item changes profit (COGS not reversed; returned lot cost = NULL)',
    dProfit !== 0 || lot?.unit_cost_tetri == null,
    `Δprofit=${dProfit} (expected 0), ΔCOGS=${dCogs} (expected 0), returned lot #${lot?.lot_id} unit_cost_tetri=${lot?.unit_cost_tetri}`);
}

// ---------- F6: reproduce the field report (turnover 45, returns 135, COGS 25, profit -115, cash -135) ----------
{
  // Fresh isolation: measure deltas of a "today" window computed exactly like FinanceView ("today" = UTC midnight).
  const a = await product('ბურთი A', 4500, 2500, 5);
  const b = await product('ბურთი B', 4500, 2500, 5);
  const c = await product('ბურთი C', 4500, 2500, 5);
  const saleA = await must('pos:checkout', { items: [{ variant_id: a.variant.id, quantity: 1, unit_price_tetri: 4500 }], payment_method: 'cash', cash_received_tetri: 4500 }, ST);
  const saleC = await must('pos:checkout', { items: [{ variant_id: c.variant.id, quantity: 1, unit_price_tetri: 4500 }], payment_method: 'cash', cash_received_tetri: 4500 }, ST);
  // Move the two original sales into an earlier period (yesterday).
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  db.prepare('UPDATE sales SET created_at = ? WHERE id IN (?, ?)').run(yesterday, saleA.id, saleC.id);
  // Remove every other row from "today" so the window only contains this scenario.
  const todayStart = `${new Date().toISOString().split('T')[0]}T00:00:00.000Z`;
  db.prepare('UPDATE sales SET created_at = ? WHERE created_at >= ? AND id NOT IN (?, ?)').run(yesterday, todayStart, saleA.id, saleC.id);
  db.prepare('UPDATE returns SET created_at = ? WHERE created_at >= ?').run(yesterday, todayStart);
  db.prepare('UPDATE debt_repayments SET created_at = ? WHERE created_at >= ?').run(yesterday, todayStart);
  // Today: even exchange A→B, then return B, then return C (all resellable).
  const ex = await must('returns:exchange', {
    original_sale_id: saleA.id,
    return_items: [{ sale_item_id: saleA.items[0].id, variant_id: a.variant.id, quantity: 1, condition: 'resellable' }],
    new_items: [{ variant_id: b.variant.id, quantity: 1, unit_price_tetri: 4500 }],
    payment_method: 'cash'
  }, ST);
  await must('returns:process', { sale_id: ex.new_sale_id, items: [{ sale_item_id: ex.new_sale.items[0].id, variant_id: b.variant.id, quantity: 1, condition: 'resellable' }] }, ST);
  await must('returns:process', { sale_id: saleC.id, items: [{ sale_item_id: saleC.items[0].id, variant_id: c.variant.id, quantity: 1, condition: 'resellable' }] }, ST);
  const s = await must('finance:summary', { startDate: todayStart }, OT);
  const shown = `turnover=${s.total_sales_revenue_tetri / 100}, returns=${s.total_returns_amount_tetri / 100}, COGS=${s.cost_of_goods_sold_tetri / 100}, profit=${(s.estimated_gross_profit_tetri ?? NaN) / 100}, cash=${s.total_cash_inflow_tetri / 100}`;
  record('F6', 'Field report numbers reproduced by: 2 earlier cash sales → even exchange + 2 returns today',
    s.total_sales_revenue_tetri === 4500 && s.total_returns_amount_tetri === 13500 && s.cost_of_goods_sold_tetri === 2500 &&
    s.estimated_gross_profit_tetri === -11500 && s.total_cash_inflow_tetri === -13500,
    `${shown}  | correct for this scenario: net sales=-90, COGS=-50 (reversals), gross profit=-40, cash=-90`);
}

// ---------- F7: duplicate sale_item lines in one return exceed sold quantity ----------
{
  const { variant } = await product('ქუდი', 3000, 1000, 5);
  const sale = await must('pos:checkout', { items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 3000 }], payment_method: 'cash', cash_received_tetri: 3000 }, ST);
  const r = await ipc('returns:process', { sale_id: sale.id, items: [
    { sale_item_id: sale.items[0].id, variant_id: variant.id, quantity: 1, condition: 'resellable' },
    { sale_item_id: sale.items[0].id, variant_id: variant.id, quantity: 1, condition: 'resellable' },
  ] }, ST);
  const si = db.prepare('SELECT quantity, returned_quantity FROM sale_items WHERE id = ?').get(sale.items[0].id) as any;
  record('F7', 'Same sale line listed twice in one return → returns more than sold',
    r.success && si.returned_quantity > si.quantity,
    r.success ? `sold=${si.quantity}, returned=${si.returned_quantity}, refund=${r.data.total_refund_tetri}, stock=${stockOf(variant.id)} (started 5, sold 1)` : `rejected: ${r.error}`);
}

// ---------- F8: stock correction leaves FIFO lots untouched ----------
{
  const { variant } = await product('ფეხსაცმელი', 9000, 5000, 5);
  await must('inventory:correct', { variant_id: variant.id, counted_quantity: 2, reason: 'ინვენტარიზაცია' }, OT);
  record('F8', 'Stock correction does not adjust FIFO lots (stock vs lot quantity diverge)',
    stockOf(variant.id) !== lotsRemaining(variant.id),
    `stock_quantity=${stockOf(variant.id)}, sum(lot.remaining)=${lotsRemaining(variant.id)}`);
}

// ---------- F9: "today" finance window excludes today's expenses ----------
{
  await must('finance:createExpense', { category: 'ქირა', description: 'ტესტი', amount_tetri: 1000 }, OT);
  const todayStart = `${new Date().toISOString().split('T')[0]}T00:00:00.000Z`;
  const s = await must('finance:summary', { startDate: todayStart }, OT);
  record('F9', '"Today" finance view drops expenses created today (date vs timestamp string compare)',
    s.total_expenses_tetri === 0, `total_expenses_tetri in today window=${s.total_expenses_tetri} (expected ≥1000)`);
}

// ---------- F10: no PIN attempt limiting ----------
{
  let failures = 0;
  for (let i = 0; i < 30; i++) { const r = await ipc('auth:login', { userId: ownerSession.user.id, pin: String(9000 + i) }); if (!r.success) failures++; }
  const ok = await ipc('auth:login', { userId: ownerSession.user.id, pin: '1111' });
  record('F10', 'Owner PIN: 30 wrong attempts, no lockout, correct PIN still accepted immediately',
    failures === 30 && ok.success, `wrong attempts rejected=${failures}, then correct PIN success=${ok.success}`);
}

// ---------- F11: deactivated seller keeps a working session ----------
{
  const s2 = await must('auth:addUser', { name: 'Seller2', pin: '3333', role: 'seller' }, OT);
  const t2 = (await must('auth:login', { userId: s2.id, pin: '3333' })).token;
  await must('auth:setUserActive', { userId: s2.id, isActive: false }, OT);
  const r = await ipc('customers:list', {}, t2);
  record('F11', 'Deactivated user session token keeps working', r.success, `customers:list with deactivated seller token success=${r.success}`);
}

// ---------- F12: repayment can be attached to another customer's sale ----------
{
  const { variant } = await product('ჩანთა', 5000, 2000, 5);
  const c1 = await must('customers:create', { first_name: 'C1' }, ST);
  const c2 = await must('customers:create', { first_name: 'C2' }, ST);
  await must('pos:checkout', { items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 5000 }], payment_method: 'debt', customer_id: c1.id }, ST);
  const saleC2 = await must('pos:checkout', { items: [{ variant_id: variant.id, quantity: 1, unit_price_tetri: 5000 }], payment_method: 'debt', customer_id: c2.id }, ST);
  const r = await ipc('customers:repay', { customer_id: c1.id, amount_tetri: 5000, sale_id: saleC2.id }, ST);
  const c2Sales = await must('customers:getActiveSales', { customerId: c2.id }, ST);
  const c2Debt = (await must('customers:get', { customerId: c2.id }, ST)).total_debt_tetri;
  record('F12', "C1's repayment accepted against C2's sale (per-sale balance corrupted)",
    r.success && c2Sales[0].debt_remaining_tetri === 0 && c2Debt === 5000,
    `C2 sale remaining=${c2Sales[0]?.debt_remaining_tetri} while C2 total debt=${c2Debt}`);
}

// F10 above locks the owner account (the new lockout works); clear it so F13 tests the reset itself.
try { db.prepare('UPDATE users SET failed_pin_attempts = 0, locked_until = NULL').run(); } catch {}
// ---------- F13: database reset fails once returns exist (FK order) ----------
{
  const r = await ipc('auth:resetStoreDatabase', { pin: '1111' }, OT);
  record('F13', 'Owner "reset database" fails when returns/repayments exist', !r.success, r.success ? 'reset succeeded' : `error: ${r.error}`);
}

const confirmed = results.filter(r => r.confirmed).length;
console.log(`\n${confirmed}/${results.length} findings confirmed`);
