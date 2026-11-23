/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * V1.2: a shop set up in Spanish with euros in Madrid; each user's language; the currency lock
 * (amounts are never converted); the shop time zone for calendar days; Spanish CSV export;
 * main-process messages in the shop currency; the computer's screen language; a database from a
 * newer StorePOS is refused.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

process.env.STORE_DB_PATH = ':memory:';
process.env.STORE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-shoplocale-'));

const { handleIpcMessage } = await import('../ipc/handlers.ts');
const { getDb, hasMoneyRecords } = await import('../db/database.ts');
const { runMigrations } = await import('../db/migrations.ts');
const { getCurrency } = await import('../../shared/currency.ts');
const { getStoreTimeZone, localDate, resolvePeriod, startOfLocalDayUtc } = await import('../../shared/time.ts');
const { trServer } = await import('../../shared/i18n/index.ts');
const { configureDeviceLanguage, getDeviceLanguage, setDeviceLanguage } = await import('../deviceLanguage.ts');

const ipc = (channel: string, payload?: any, token?: string) => handleIpcMessage({ channel, payload, token });
async function must(channel: string, payload?: any, token?: string) {
  const r = await ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
}
async function refused(channel: string, payload: any, token: string | undefined, re: RegExp) {
  const r = await ipc(channel, payload, token);
  assert.equal(r.success, false, `${channel} should be refused`);
  assert.match(r.error!, re, channel);
  return r.error!;
}

test('first run: invalid choices are refused and nothing is created', async () => {
  await refused('auth:setupOwner', { name: 'Ana', pin: '482913', currency: 'XYZ' }, undefined, /ვალუტა არასწორია/);
  await refused('auth:setupOwner', { name: 'Ana', pin: '482913', timezone: 'Mars/Base' }, undefined, /დროის სარტყელი არასწორია/);
  await refused('auth:setupOwner', { name: 'Ana', pin: '482913', language: 'de' }, undefined, /ენა არასწორია/);
  assert.equal(await must('auth:hasOwner'), false);
});

let OT = '';
let ownerId = 0;
test('first run in Spanish, euros, Madrid: the owner, the settings and this process all follow', async () => {
  const s = await must('auth:setupOwner', { name: 'Ana', pin: '482913', language: 'es', currency: 'EUR', timezone: 'Europe/Madrid' });
  OT = s.token;
  ownerId = s.user.id;
  assert.equal(s.user.language, 'es');
  const pub = await must('settings:getPublic');
  assert.equal(pub.currency, 'EUR');
  assert.equal(pub.timezone, 'Europe/Madrid');
  assert.equal(getCurrency(), 'EUR');
  assert.equal(getStoreTimeZone(), 'Europe/Madrid');
  const me = await must('auth:me', {}, OT);
  assert.equal(me.language, 'es');
  const users = await must('auth:getActiveUsers');
  assert.equal(users.find((u: any) => u.id === ownerId).language, 'es');
});

let ST = '';
test('each user keeps their own language; only their own; invalid values refused', async () => {
  const seller = await must('auth:addUser', { name: 'Pablo', pin: '730284', role: 'seller' }, OT);
  ST = (await must('auth:login', { userId: seller.id, pin: '730284' })).token;
  assert.equal((await must('auth:me', {}, ST)).language, null, 'a new user follows the computer language');
  const me = await must('auth:setLanguage', { language: 'ru' }, ST);
  assert.equal(me.language, 'ru');
  assert.equal((await must('auth:me', {}, ST)).language, 'ru');
  assert.equal((await must('auth:me', {}, OT)).language, 'es', 'the owner is unchanged');
  await refused('auth:setLanguage', { language: 'fr' }, ST, /ენა არასწორია/);
  await refused('auth:setLanguage', { language: 'en' }, undefined, /ავტორიზაცია/);
  // the language survives signing in again
  const again = await must('auth:login', { userId: seller.id, pin: '730284' });
  assert.equal(again.user.language, 'ru');
});

test('currency: free to change while there are no money records, locked after the first one', async () => {
  assert.equal(hasMoneyRecords(getDb()), false);
  assert.equal((await must('backup:canChangeCurrency', {}, OT)).allowed, true);
  await must('backup:updateSettings', { settings: { currency: 'USD' } }, OT);
  assert.equal(getCurrency(), 'USD');
  await must('backup:updateSettings', { settings: { currency: 'EUR' } }, OT);
  assert.equal(getCurrency(), 'EUR');
  await refused('backup:updateSettings', { settings: { currency: 'JPY' } }, OT, /ვალუტა არასწორია/);
  await refused('backup:canChangeCurrency', {}, ST, /მხოლოდ მფლობელს/);

  // A product with opening stock is a money record (the stock has a cost).
  await must('products:create', {
    name: 'Camiseta', base_price_tetri: 1250, base_cost_tetri: 700,
    variants: [{ variant_name: 'M', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '42001' }] }],
  }, OT);
  assert.equal(hasMoneyRecords(getDb()), true);
  assert.equal((await must('backup:canChangeCurrency', {}, OT)).allowed, false);
  await refused('backup:updateSettings', { settings: { currency: 'GEL' } }, OT, /ფულადი ჩანაწერები/);
  assert.equal(getCurrency(), 'EUR', 'nothing changed');
  // Saving the same currency again (with other settings) is fine.
  await must('backup:updateSettings', { settings: { currency: 'EUR', store_name: 'Tienda de Ana' } }, OT);
});

test('a sale: amounts in euros in the main-process message, receipt day and periods in Madrid time', async () => {
  const products = await must('products:list', {}, OT);
  const v = products.find((p: any) => p.name === 'Camiseta').variants[0];
  const err = await refused('pos:checkout', {
    items: [{ variant_id: v.id, quantity: 2, unit_price_tetri: 1250 }],
    payment_method: 'cash',
    cash_received_tetri: 1000,
  }, OT, /€/);
  assert.ok(!err.includes('₾'), err);
  assert.equal(trServer(err, 'es'), 'El efectivo recibido (10.00 €) es inferior al total (25.00 €)');

  const before = localDate(new Date(), 'Europe/Madrid');
  const sale = await must('pos:checkout', {
    items: [{ variant_id: v.id, quantity: 2, unit_price_tetri: 1250 }],
    payment_method: 'cash',
    cash_received_tetri: 3000,
  }, OT);
  const after = localDate(new Date(), 'Europe/Madrid');
  const day = sale.receipt_number.slice(4, 12);
  assert.ok([before, after].map((d) => d.replace(/-/g, '')).includes(day), `${sale.receipt_number} is dated in Madrid`);

  const today = resolvePeriod({ preset: 'today' });
  assert.equal(today.startUtc, startOfLocalDayUtc(localDate(new Date(), 'Europe/Madrid'), 'Europe/Madrid').toISOString());
});

test('sales CSV in the language of the user who exports, amounts in the shop currency', async () => {
  const es = await must('finance:exportSalesCSV', { lang: 'es' }, OT);
  const header = es.replace(/^﻿/, '').split('\n')[0];
  assert.match(header, /Ticket n\.º/);
  assert.match(header, /Total \(€\)/);
  assert.ok(!/[Ⴀ-ჿ]/.test(header), header);
  assert.match(es.split('\n')[1], /Efectivo/);
  const ka = await must('finance:exportSalesCSV', {}, OT);
  assert.match(ka.split('\n')[0], /ჯამი \(€\)/);
});

test('the computer language: last choice, else the installer, else Georgian', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-uilang-'));
  const exeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-exe-'));
  configureDeviceLanguage({ userData: profile, exeDir });
  assert.equal(getDeviceLanguage(), 'ka');
  fs.writeFileSync(path.join(exeDir, 'install-language.txt'), '3082');
  assert.equal(getDeviceLanguage(), 'es');
  fs.writeFileSync(path.join(exeDir, 'install-language.txt'), '1049\r\n');
  assert.equal(getDeviceLanguage(), 'ru');
  setDeviceLanguage('en');
  assert.equal(getDeviceLanguage(), 'en');
  configureDeviceLanguage({ userData: profile, exeDir }); // a restart reads the saved file
  assert.equal(getDeviceLanguage(), 'en');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'ui-language.json'), 'utf8')), { language: 'en' });
  assert.throws(() => setDeviceLanguage('xx'), /ენა არასწორია/);
  // through the sign-in screen's channels
  assert.equal((await must('app:setDeviceLanguage', { language: 'es' })).language, 'es');
  assert.equal((await must('app:getDeviceLanguage')).language, 'es');
  assert.equal((await ipc('app:setDeviceLanguage', { language: 'zz' })).success, false);
});

test('a database written by a newer StorePOS is never changed by this one', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const v = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v;
  db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future', ?)").run(v + 1, new Date().toISOString());
  assert.throws(() => runMigrations(db), /უფრო ახალი ვერსიით \(სქემა v13\)/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n, 0);
});
