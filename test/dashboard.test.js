import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../src/dashboard.js';

let d;
const post = (path, body, token = d.token) =>
  fetch(`${d.url}api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Mini-Tallo': token } : {}) }, body: JSON.stringify(body ?? {}) });

before(async () => {
  d = await startDashboard({ demo: true, port: 0, open: false, env: { MINI_TALLO_DATA_DIR: mkdtempSync(join(tmpdir(), 'minitallo-dash-')) } });
});
after(async () => { await d.close(); });

test('the page is served with its token and a strict content policy', async () => {
  const res = await fetch(d.url);
  const html = await res.text();
  assert.ok(html.includes(`content="${d.token}"`));
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${d.url}app.js`)).status, 200);
  assert.equal((await fetch(`${d.url}style.css`)).status, 200);
  assert.equal((await fetch(`${d.url}../package.json`)).status, 404);
});

test('the books are not handed out without the page token', async () => {
  assert.equal((await post('call', { tool: 'list_companies' }, null)).status, 403);
  assert.equal((await post('call', { tool: 'list_companies' }, 'guess')).status, 403);
});

test('terms are accepted on the page before any report answers', async () => {
  assert.equal((await (await post('info')).json()).terms_accepted, false);
  assert.equal((await (await post('call', { tool: 'list_companies' })).json()).error, 'terms_not_accepted');
  await post('accept-terms');
  const info = await (await post('info')).json();
  assert.equal(info.terms_accepted, true);
  assert.equal(info.demo, true);
});

test('reports answer, and tools that write are not on the dashboard', async () => {
  const q = { company: 'Demo Traders', from: '2025-04-01', to: '2025-06-30' };
  const tb = await (await post('call', { tool: 'trial_balance', args: q })).json();
  assert.equal(tb.checks.closing_balances_sum_to_zero, true);
  assert.equal((await (await post('call', { tool: 'profit_and_loss', args: q })).json()).net_profit, -20000);
  for (const tool of ['build_import_xml', 'post_import', 'parse_bank_statement']) {
    assert.equal((await (await post('call', { tool, args: q })).json()).error, 'not_on_dashboard');
  }
});

test('the home tiles get month-wise trends and totals that agree with the reports', async () => {
  const r = await (await post('call', { tool: 'dashboard_summary', args: { company: 'Demo Traders', from: '2025-04-01', to: '2025-06-30' } })).json();
  assert.deepEqual(r.months, [
    { month: '2025-04', sales: 10000, purchases: 5000, profit: -20000 },
    { month: '2025-05', sales: 0, purchases: 0, profit: 0 },
    { month: '2025-06', sales: 0, purchases: 0, profit: 0 },
  ]);
  assert.deepEqual(r.trading, { sales: 10000, purchases: 5000, gross_profit: 5000, net_profit: -20000 });
  assert.deepEqual(r.cash, { net: -19100, inflow: 21800, outflow: 40900 });
  assert.deepEqual(r.outstanding, { receivables: 4000, receivables_over_30_days: 0, payables: 2500, payables_over_30_days: 2500 });
  assert.deepEqual(r.cash_and_bank.map((l) => [l.ledger, l.closing]), [['HDFC Bank', 170900], ['Cash', 60000]]);
  assert.deepEqual(r.balances.find((b) => b.group === 'Current Assets'), { group: 'Current Assets', closing: 230900 });
});

const C = 'Demo Traders';
const run = async (tool, args) => (await post('call', { tool, args: { company: C, ...args } })).json();
const names = async (kind) => (await run('edit_list_masters', { kind })).masters.map((m) => m.name);

test('nothing is written while editing is off', async () => {
  assert.equal((await run('save_master', { kind: 'group', action: 'create', name: 'Branches' })).error, 'editing_off');
  assert.equal((await run('delete_master', { kind: 'ledger', name: 'Rent' })).error, 'editing_off');
  assert.equal((await run('delete_voucher', { guid: 'vch-Payment-1', date: '2025-04-05' })).error, 'editing_off');
  assert.ok(!(await names('group')).includes('Branches'));
  assert.equal((await (await post('editing', { on: true })).json()).editing, true);
});

test('masters: create, change, rename and delete, each confirmed by reading back', async () => {
  assert.equal((await run('save_master', { kind: 'group', action: 'create', name: 'Branches', parent: 'Current Assets' })).done, true);
  assert.equal((await run('save_master', { kind: 'group', action: 'create', name: 'branches' })).error, 'already_exists');
  assert.equal((await run('save_master', { kind: 'ledger', action: 'create', name: 'Pune Branch' })).error, 'parent_required');
  assert.equal((await run('save_master', { kind: 'ledger', action: 'create', name: 'Pune Branch', parent: 'Nowhere' })).error, 'unknown_parent');
  assert.equal((await run('save_master', { kind: 'ledger', action: 'create', name: 'Pune Branch', parent: 'Branches', opening: 1500.5, opening_dr_cr: 'Cr' })).done, true);
  let led = (await run('edit_list_masters', { kind: 'ledger' })).masters.find((m) => m.name === 'Pune Branch');
  assert.deepEqual([led.parent, led.opening], ['Branches', -1500.5]);

  const renamed = await run('save_master', { kind: 'ledger', action: 'update', name: 'Pune Branch', new_name: 'Pune Office', parent: 'Branches', opening: 200, opening_dr_cr: 'Dr' });
  assert.deepEqual([renamed.done, renamed.name], [true, 'Pune Office']);
  led = (await run('edit_list_masters', { kind: 'ledger' })).masters.find((m) => m.name === 'Pune Office');
  assert.equal(led.opening, 200);
  assert.ok(!(await names('ledger')).includes('Pune Branch'));

  assert.equal((await run('delete_master', { kind: 'group', name: 'Branches' })).error, 'tally_did_not_apply', 'a group with a ledger in it stays');
  assert.equal((await run('delete_master', { kind: 'ledger', name: 'Rent' })).error, 'tally_did_not_apply', 'a ledger with vouchers stays');
  assert.equal((await run('delete_master', { kind: 'ledger', name: 'Pune Office' })).done, true);
  assert.equal((await run('delete_master', { kind: 'group', name: 'Branches' })).done, true);
  assert.equal((await run('delete_master', { kind: 'group', name: 'Branches' })).error, 'not_found');
});

test('the other master kinds can be created and deleted', async () => {
  assert.equal((await run('save_master', { kind: 'unit', action: 'create', name: 'Kg', formal_name: 'Kilograms', decimals: 3 })).done, true);
  assert.equal((await run('save_master', { kind: 'stock_group', action: 'create', name: 'Raw Material' })).done, true);
  assert.equal((await run('save_master', { kind: 'stock_item', action: 'create', name: 'Steel', parent: 'Raw Material', unit: 'Kg' })).done, true);
  assert.equal((await run('save_master', { kind: 'stock_item', action: 'create', name: 'Brass', unit: 'Tonne' })).error, 'unknown_unit');
  assert.equal((await run('save_master', { kind: 'godown', action: 'create', name: 'Shed 2', parent: 'Main Location' })).done, true);
  assert.equal((await run('save_master', { kind: 'cost_category', action: 'create', name: 'Projects' })).done, true);
  assert.equal((await run('save_master', { kind: 'cost_centre', action: 'create', name: 'Project A', category: 'Projects' })).done, true);
  assert.deepEqual((await run('edit_list_masters', { kind: 'stock_item' })).masters, [{ name: 'Steel', parent: 'Raw Material', unit: 'Kg' }]);
  assert.equal((await run('delete_master', { kind: 'unit', name: 'Kg' })).error, 'tally_did_not_apply', 'a unit in use stays');
  for (const [kind, name] of [['stock_item', 'Steel'], ['stock_group', 'Raw Material'], ['unit', 'Kg'], ['godown', 'Shed 2'], ['cost_centre', 'Project A'], ['cost_category', 'Projects']]) {
    assert.equal((await run('delete_master', { kind, name })).done, true, `${kind} ${name}`);
  }
});

test('vouchers: create, change and delete, each confirmed by reading back', async () => {
  const day = { from: '2025-06-25', to: '2025-06-26' };
  const voucher = { type: 'Payment', date: '2025-06-25', narration: 'Courier', entries: [{ ledger: 'Rent', dr_cr: 'Dr', amount: 450 }, { ledger: 'Cash', dr_cr: 'Cr', amount: 450 }] };
  assert.equal((await run('save_voucher', { action: 'create', voucher: { ...voucher, entries: [voucher.entries[0], { ledger: 'Cash', dr_cr: 'Cr', amount: 400 }] } })).error, 'invalid_batch');
  const made = await run('save_voucher', { action: 'create', voucher });
  assert.equal(made.done, true);
  assert.equal((await run('vouchers', day)).matched, 1);

  const changed = await run('save_voucher', { action: 'update', guid: made.guid, date: '2025-06-25', voucher: { ...voucher, date: '2025-06-26', narration: 'Courier and post', entries: [{ ledger: 'Rent', dr_cr: 'Dr', amount: 500 }, { ledger: 'HDFC Bank', dr_cr: 'Cr', amount: 500 }] } });
  assert.equal(changed.done, true);
  const now = (await run('vouchers', day)).vouchers;
  assert.deepEqual([now.length, now[0].date, now[0].amount, now[0].narration, now[0].guid], [1, '2025-06-26', 500, 'Courier and post', made.guid]);

  assert.equal((await run('save_voucher', { action: 'update', guid: 'vch-Export Sales-S1', date: '2025-04-10', voucher: { ...voucher, type: 'Journal', date: '2025-04-10' } })).error, 'type_not_editable');
  assert.equal((await run('delete_voucher', { guid: made.guid, date: '2025-06-25' })).error, 'not_found', 'it moved to the 26th');
  assert.equal((await run('delete_voucher', { guid: made.guid, date: '2025-06-26' })).done, true);
  assert.equal((await run('vouchers', day)).matched, 0);
  assert.equal((await run('trial_balance', { from: '2025-04-01', to: '2025-06-30' })).checks.closing_balances_sum_to_zero, true);
});
