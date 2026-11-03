/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Merges benchmark reports (report-*.json written by benchmark.ts with --out) of parallel runs
 * and prints one table per condition and overall, as Markdown.
 * Usage: node scripts/ocr/merge-reports.mjs <report.json>... [--title "..."]
 */

import fs from 'node:fs';

const args = process.argv.slice(2);
const ti = args.indexOf('--title');
const title = ti >= 0 ? args.splice(ti, 2)[1] : 'OCR benchmark';
const rows = args.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).rows);

function summarise(list) {
  const n = list.length || 1;
  const pct = (k) => (Math.round((1000 * k) / n) / 10).toFixed(1);
  const accepted = list.filter((r) => r.accepted);
  const ms = list.map((r) => r.ms).sort((a, b) => a - b);
  return {
    n: list.length,
    exact: pct(list.filter((r) => r.exact).length),
    digits: (Math.round((1000 * list.reduce((a, r) => a + r.digitsRight, 0)) / (5 * n)) / 10).toFixed(1),
    seg: pct(list.filter((r) => r.segmented).length),
    accepted: pct(accepted.length),
    falseHigh: pct(accepted.filter((r) => !r.exact).length),
    rejected: pct(list.filter((r) => r.status === 'rejected' || (!r.status && !r.fiveDigits)).length),
    p50: Math.round(ms[Math.floor(ms.length * 0.5)] || 0),
    p95: Math.round(ms[Math.floor(ms.length * 0.95)] || 0),
  };
}

const conditions = [...new Set(rows.map((r) => r.condition))];
console.log(`### ${title}\n`);
console.log('| პირობა | n | კოდი ზუსტად % | ციფრი % | სეგმენტაცია % | მონიშვნის გარეშე % | არასწორი მონიშვნის გარეშე % | უარყოფილი % | p50 მს | p95 მს |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const c of conditions) {
  const s = summarise(rows.filter((r) => r.condition === c));
  console.log(`| ${c} | ${s.n} | ${s.exact} | ${s.digits} | ${s.seg} | ${s.accepted} | ${s.falseHigh} | ${s.rejected} | ${s.p50} | ${s.p95} |`);
}
const all = summarise(rows);
console.log(`| **სულ** | ${all.n} | **${all.exact}** | ${all.digits} | ${all.seg} | ${all.accepted} | **${all.falseHigh}** | ${all.rejected} | ${all.p50} | ${all.p95} |`);
