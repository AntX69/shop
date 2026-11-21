/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared by the RC3 upgrade and downgrade tests: builds a shop with real history through the
 * RC3 program's own IPC, and takes a fingerprint of a shop that RC3 and V1.1 can both produce.
 */

export const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};

let seed = 20261121;
export const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
export const PINS = { owner: '7351', s1: '2468', s2: '1357' };
export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function fingerprint(cdp, T) {
  const products = (await must(cdp, 'products:list', { stockFilter: 'all' }, T)).map((p) => ({
    name: p.name, price: p.base_price_tetri, cost: p.base_cost_tetri, category: p.category_id, images: (p.images || []).length,
    variants: (p.variants || []).map((v) => `${v.variant_name}:${v.stock_quantity}:${(v.codes || []).map((c) => c.code_value).sort().join('/')}`),
  }));
  const customers = await must(cdp, 'customers:list', {}, T);
  const debts = [];
  for (const c of customers) debts.push(`${c.first_name}:${(await must(cdp, 'customers:get', { customerId: c.id }, T)).total_debt_tetri}`);
  const users = (await must(cdp, 'auth:getActiveUsers', {})).map((u) => `${u.name}/${u.role}`).sort();
  const sales = (await must(cdp, 'pos:searchSales', { limit: 5000 }, T)).map((s) => `${s.id}:${s.total_tetri}:${s.payment_method}`).sort();
  const finance = await must(cdp, 'finance:summary', { preset: 'all' }, T);
  return { users, products, debts, sales, finance };
}
/** Same data; V1.1's finance report may add figures, but every RC3 figure must be unchanged. */
export function sameAsRc3(rc3, now) {
  const changedFinance = Object.keys(rc3.finance).filter((k) => JSON.stringify(rc3.finance[k]) !== JSON.stringify(now.finance[k]));
  const parts = ['users', 'products', 'debts', 'sales'].filter((k) => JSON.stringify(rc3[k]) !== JSON.stringify(now[k]));
  return { ok: changedFinance.length === 0 && parts.length === 0, detail: [...parts, ...changedFinance.map((k) => `finance.${k}: ${JSON.stringify(rc3.finance[k])} -> ${JSON.stringify(now.finance[k])}`)].join(', ') };
}

/** Builds the RC3 shop through the RC3 program's own IPC. */
export async function buildRc3Shop(cdp) {
  const OT = (await must(cdp, 'auth:setupOwner', { name: 'RC3 მფლობელი', pin: PINS.owner })).token;
  const s1 = await must(cdp, 'auth:addUser', { name: 'RC3 გამყიდველი ანა', pin: PINS.s1, role: 'seller' }, OT);
  const s2 = await must(cdp, 'auth:addUser', { name: 'RC3 გამყიდველი გიორგი', pin: PINS.s2, role: 'seller' }, OT);
  const S1 = (await must(cdp, 'auth:login', { userId: s1.id, pin: PINS.s1 })).token;
  const S2 = (await must(cdp, 'auth:login', { userId: s2.id, pin: PINS.s2 })).token;
  const cats = [];
  for (const n of ['სათამაშოები', 'ტანსაცმელი', 'საკანცელარიო', 'სამზარეულო', 'კოსმეტიკა']) cats.push(await must(cdp, 'products:createCategory', { name: n }, OT));
  const variants = [];
  for (let i = 0; i < 60; i++) {
    const cost = 300 + rnd(2700);
    const price = Math.round(cost * (1.5 + rnd(70) / 100));
    const nv = 1 + rnd(3);
    const p = await must(cdp, 'products:create', {
      name: `RC3 ნივთი ${i + 1}`, base_price_tetri: price, base_cost_tetri: cost, category_id: cats[i % cats.length].id,
      image_paths: i % 6 === 0 ? [PNG] : [],
      variants: Array.from({ length: nv }, (_, k) => ({ variant_name: `ვ${k + 1}`, initial_stock: 20 + rnd(40), codes: [{ code_type: 'manual_5digit', code_value: String(30000 + i * 5 + k) }] })),
    }, OT);
    for (const v of p.variants) variants.push({ id: v.id, price, cost });
  }
  // several purchase batches at different costs
  let restocks = 0;
  for (let i = 0; i < 70; i++) {
    const v = variants[rnd(variants.length)];
    await must(cdp, 'inventory:restock', { variant_id: v.id, added_quantity: 5 + rnd(30), unit_cost_tetri: Math.max(50, Math.round(v.cost * (0.7 + rnd(60) / 100))) }, OT);
    restocks++;
  }
  const customers = [];
  for (let i = 0; i < 15; i++) customers.push(await must(cdp, 'customers:create', { first_name: `კლიენტი${i + 1}` }, OT));
  const tokens = [OT, S1, S2];
  const sales = [];
  for (let i = 0; i < 160; i++) {
    const lines = [...new Map(Array.from({ length: 1 + rnd(4) }, () => { const v = variants[rnd(variants.length)]; return [v.id, { variant_id: v.id, quantity: 1 + rnd(3) }]; })).values()];
    const T = tokens[rnd(3)];
    const r = rnd(100);
    const method = r < 60 ? 'cash' : r < 85 ? 'debt' : 'mixed';
    const total = lines.reduce((s, l) => s + l.quantity * variants.find((v) => v.id === l.variant_id).price, 0);
    const payload = { items: lines, payment_method: method, idempotency_key: `rc3-${i}` };
    if (T === OT && rnd(8) === 0) payload.cart_discount_tetri = Math.min(total - 1, 100 + rnd(300));
    const due = total - (payload.cart_discount_tetri || 0);
    if (method !== 'cash') payload.customer_id = customers[rnd(customers.length)].id;
    if (method === 'cash') payload.cash_received_tetri = due + rnd(500);
    if (method === 'mixed') payload.cash_received_tetri = Math.max(1, Math.floor(due / 2));
    const res = await cdp.ipc('pos:checkout', payload, T);
    if (res.success) sales.push({ sale: res.data, method, token: T });
    else if (/მარაგ/.test(res.error || '')) {
      for (const l of lines) await must(cdp, 'inventory:restock', { variant_id: l.variant_id, added_quantity: 40, unit_cost_tetri: variants.find((v) => v.id === l.variant_id).cost }, OT);
      restocks++;
    } else throw new Error(`checkout: ${res.error}`);
  }
  const backup1 = await must(cdp, 'backup:create', {}, OT);
  // repayments: general (oldest first) and for a specific receipt
  let repayments = 0;
  const debtSales = sales.filter((s) => s.method !== 'cash');
  for (let i = 0; i < 30; i++) {
    const s = debtSales[rnd(debtSales.length)];
    const c = await must(cdp, 'customers:get', { customerId: s.sale.customer_id }, OT);
    if (c.total_debt_tetri < 2) continue;
    const amount = 1 + rnd(Math.min(c.total_debt_tetri - 1, 3000));
    const payload = { customer_id: s.sale.customer_id, amount_tetri: amount };
    if (i % 3 === 0) {
      const open = (await must(cdp, 'customers:getActiveSales', { customerId: s.sale.customer_id }, OT)).find((x) => (x.debt_remaining_tetri ?? 0) > 0);
      if (open) { payload.sale_id = open.id; payload.amount_tetri = Math.min(amount, open.debt_remaining_tetri); }
    }
    const res = await cdp.ipc('customers:repay', payload, tokens[rnd(3)]);
    if (res.success) repayments++;
  }
  // partial returns
  let returns = 0;
  for (const s of sales.filter((x) => x.sale.items.some((it) => it.quantity >= 2)).slice(0, 25)) {
    const it = s.sale.items.find((x) => x.quantity >= 2);
    const res = await cdp.ipc('returns:process', { sale_id: s.sale.id, items: [{ sale_item_id: it.id, quantity: 1, condition: returns % 4 === 3 ? 'damaged' : 'resellable' }], reason: 'RC3 ტესტი' }, s.token);
    if (res.success) returns++;
  }
  // exchanges
  let exchanges = 0;
  for (const s of sales.filter((x) => x.method === 'cash').slice(30, 40)) {
    const it = s.sale.items[0];
    const nv = variants[rnd(variants.length)];
    const res = await cdp.ipc('returns:exchange', { original_sale_id: s.sale.id, return_items: [{ sale_item_id: it.id, quantity: 1 }], new_items: [{ variant_id: nv.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: nv.price + 1000 }, OT);
    if (res.success) exchanges++;
  }
  // stock counts
  for (let i = 0; i < 8; i++) {
    const v = variants[rnd(variants.length)];
    const prod = (await must(cdp, 'products:list', { stockFilter: 'all' }, OT)).flatMap((p) => p.variants).find((x) => x.id === v.id);
    await must(cdp, 'inventory:correct', { variant_id: v.id, counted_quantity: Math.max(0, prod.stock_quantity + (i % 2 ? 3 : -2)), reason: 'RC3 აღწერა' }, OT);
  }
  // write-offs
  let writeOffs = 0;
  for (const s of debtSales.slice(0, 12)) {
    if (writeOffs >= 3) break;
    const open = (await must(cdp, 'customers:getActiveSales', { customerId: s.sale.customer_id }, OT)).find((x) => (x.debt_remaining_tetri ?? 0) > 100);
    if (!open) continue;
    const res = await cdp.ipc('debts:writeOff', { customer_id: s.sale.customer_id, sale_id: open.id, amount_tetri: 100, reason: 'RC3 ჩამოწერა' }, OT);
    if (res.success) writeOffs++;
  }
  for (let i = 0; i < 6; i++) await must(cdp, 'finance:createExpense', { category: ['იჯარა', 'კომუნალური', 'ტრანსპორტი'][i % 3], description: `RC3 ხარჯი ${i + 1}`, amount_tetri: 2000 + rnd(30000) }, OT);
  const backup2 = await must(cdp, 'backup:create', {}, OT);
  return { OT, counts: { variants: variants.length, restocks, sales: sales.length, repayments, returns, exchanges, writeOffs }, backup1, backup2, sales, variants, customers };
}
