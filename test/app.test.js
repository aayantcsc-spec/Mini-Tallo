import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { startMockTally, sampleBook } from './mock-tally.js';
import { loadConfig } from '../src/config.js';
import { Tally } from '../src/tally.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { askLocally } from '../src/approval.js';
import { parseStatementLines } from '../src/tools/bank.js';
import { parseXml, find } from '../src/xml.js';
import { toPaise } from '../src/util.js';

const C = 'Demo Traders';
const Q1 = { company: C, from: '2025-04-01', to: '2025-06-30' };
let mock;

before(async () => { mock = await startMockTally(); });
after(async () => { await mock.close(); });

function makeApp(env = {}, ask) {
  const dir = mkdtempSync(join(tmpdir(), 'minitallo-'));
  const config = loadConfig({ MINI_TALLO_TERMS_ACCEPTED: 'true', MINI_TALLO_PORT: String(mock.port), MINI_TALLO_DATA_DIR: dir, ...env });
  const store = new Store(dir);
  const app = createApp({ config, tally: new Tally(config), store, ask });
  const call = async (name, args) => {
    const r = await app.callTool(name, args);
    return { ...JSON.parse(r.content[0].text), isError: r.isError };
  };
  return { app, call, store, dir };
}
const approve = async () => ({ ok: true, token: randomUUID() });

test('amount text is read without floating point drift', () => {
  assert.equal(toPaise('-1,23,456.78'), -12345678);
  assert.equal(toPaise('0.10'), 10);
  assert.equal(toPaise(''), 0);
  assert.equal(toPaise('-$100.00 @ 80/$ = -8000.00'), -800000);
});

test('the XML reader drops the control character Tally puts before Primary', () => {
  const root = parseXml('<A><PARENT TYPE="String">&#4; Primary</PARENT><B X="1 &amp; 2"/></A>');
  assert.equal(find(root, 'PARENT').text.trim(), 'Primary');
  assert.equal(find(root, 'B').attrs.X, '1 & 2');
});

test('a remote Tally host is refused', () => {
  assert.throws(() => loadConfig({ MINI_TALLO_HOST: '192.168.1.20' }), /loopback/);
});

test('every tool refuses until the terms are accepted, and still leaves a receipt', async () => {
  const { call, store } = makeApp({ MINI_TALLO_TERMS_ACCEPTED: '' });
  const r = await call('list_companies', {});
  assert.equal(r.error, 'terms_not_accepted');
  assert.equal(store.readLines('egress.jsonl').at(-1).outcome, 'terms_not_accepted');
});

test('24 tools by default; posting adds two', () => {
  const names = makeApp().app.listTools().map((t) => t.name);
  assert.equal(names.length, 24);
  assert.ok(!names.includes('post_import'));
  const withPosting = makeApp({ MINI_TALLO_POSTING: 'true' }).app.listTools().map((t) => t.name);
  assert.equal(withPosting.length, 26);
  assert.ok(withPosting.includes('post_import') && withPosting.includes('acknowledge_post_review'));
});

test('list_companies and tally_status', async () => {
  const { call } = makeApp();
  assert.deepEqual((await call('list_companies', {})).companies.map((c) => c.name), [C]);
  assert.equal((await call('tally_status', {})).gateway, 'answers');
  const down = makeApp({ MINI_TALLO_PORT: '1' });
  assert.equal((await down.call('tally_status', {})).gateway, 'no_answer');
  assert.equal((await down.call('list_companies', {})).error, 'tally_unreachable');
});

test('a company that is not loaded, or misspelt, is refused', async () => {
  const { call } = makeApp();
  assert.equal((await call('trial_balance', { ...Q1, company: 'Other Co' })).error, 'company_not_loaded');
  assert.equal((await call('trial_balance', { ...Q1, company: 'demo  traders' })).error, 'company_name_mismatch');
});

test('trial_balance ties and sums to zero', async () => {
  const { call } = makeApp();
  const tb = await call('trial_balance', Q1);
  assert.equal(tb.checks.closing_balances_sum_to_zero, true);
  assert.equal(tb.checks.ledgers_where_it_does_not_or_tally_gave_no_split, 0);
  const bank = tb.ledgers.find((l) => l.ledger === 'HDFC Bank');
  assert.deepEqual([bank.opening, bank.debits, bank.credits, bank.closing], [200000, 11800, 40900, 170900]);
});

test('ledger_movement uses the opening as of the period start', async () => {
  const { call } = makeApp();
  const m = await call('ledger_movement', { company: C, ledger: 'HDFC Bank', from: '2025-05-01', to: '2025-05-31' });
  assert.deepEqual([m.opening, m.debits, m.credits, m.closing], [175000, 11800, 10000, 176800]);
  assert.equal(m.opening_plus_movement_equals_closing, true);
  const miss = await call('ledger_movement', { company: C, ledger: 'hdfc bank', from: '2025-05-01', to: '2025-05-31' });
  assert.equal(miss.error, 'unknown_ledger');
  assert.equal(miss.did_you_mean[0].ledger, 'HDFC Bank');
});

test('balance_sheet balances and profit_and_loss agrees with it', async () => {
  const { call } = makeApp();
  const bs = await call('balance_sheet', Q1);
  assert.equal(bs.total_assets, 250900);
  assert.equal(bs.total_liabilities, 250900);
  assert.equal(bs.assets.find((r) => r.group === 'Profit & Loss A/c').of_which_result_for_this_period, -20000);
  const pl = await call('profit_and_loss', Q1);
  assert.equal(pl.net_profit, -20000);
  assert.equal(pl.gross_profit, 5000);
  assert.deepEqual(pl.expenses, [{ group: 'Indirect Expenses', amount: 25000 }, { group: 'Purchase Accounts', amount: 5000 }]);
});

test('a book with stock items is refused for both statements', async () => {
  const book = sampleBook();
  book.stockItems.push({ name: 'Widget', value: 123400 });
  const m2 = await startMockTally(book);
  try {
    const { call } = makeApp({ MINI_TALLO_PORT: String(m2.port) });
    assert.equal((await call('balance_sheet', Q1)).error, 'stock_items_present');
    assert.equal((await call('profit_and_loss', Q1)).error, 'stock_items_present');
    const st = await call('stock_summary', { company: C, as_of: '2026-03-31' });
    assert.equal(st.total_closing_value, 1234);
    assert.equal((await call('stock_summary', { company: C, as_of: '2026-03-30' })).error, 'year_end_only');
  } finally { await m2.close(); }
});

test('cash_flow adds up month by month and wants whole months', async () => {
  const { call } = makeApp();
  const cf = await call('cash_flow', Q1);
  assert.deepEqual(cf.months.map((m) => m.net), [-25000, 11800, -5900]);
  assert.equal(cf.net_movement, -19100);
  assert.equal(cf.months[1].inflow, 21800);
  assert.equal((await call('cash_flow', { ...Q1, to: '2025-06-29' })).error, 'whole_months_only');
});

test('vouchers: date filter, search and summaries', async () => {
  const { call } = makeApp();
  assert.equal((await call('vouchers', { company: C, from: '2025-05-01', to: '2025-05-31' })).matched, 2);
  assert.equal((await call('vouchers', { ...Q1, search: { narration: 'RENT' } })).vouchers[0].voucher_number, '1');
  assert.equal((await call('vouchers', { ...Q1, search: { amount: 1800 } })).vouchers[0].voucher_type, 'Export Sales');
  const byMonth = await call('vouchers', { ...Q1, summary: 'month' });
  assert.deepEqual(byMonth.rows.map((r) => [r.month, r.vouchers]), [['2025-04', 3], ['2025-05', 2], ['2025-06', 1]]);
  const byPrimary = await call('vouchers', { ...Q1, summary: 'primary_group' });
  const ca = byPrimary.rows.find((r) => r.group === 'Current Assets');
  assert.deepEqual([ca.debits, ca.credits], [33600, 52700]);
});

test('registers pick up custom voucher types and tax ledgers', async () => {
  const { call } = makeApp();
  const s = await call('sales_register', Q1);
  assert.deepEqual(s.totals, { taxable_value: 10000, tax_total: 1800, voucher_total: 11800 });
  const p = await call('purchase_register', Q1);
  assert.deepEqual(p.totals, { taxable_value: 5000, tax_total: 900, voucher_total: 5900 });
});

test('outstandings splits receivable and payable and ages them', async () => {
  const { call } = makeApp();
  const o = await call('outstandings', { company: C, as_of: '2025-06-30' });
  assert.equal(o.receivable.total, 4000);
  assert.equal(o.receivable.ageing['0-30'], 4000);
  assert.equal(o.payable.total, 2500);
  assert.equal(o.payable.ageing['91-180'], 2500);
});

test('masters and ledger_masters', async () => {
  const { call } = makeApp();
  assert.ok((await call('masters', { company: C, kind: 'account_groups' })).masters.some((m) => m.name === 'Duties & Taxes' && m.parent === 'Current Liabilities'));
  const lm = await call('ledger_masters', { company: C, group: 'Current Assets' });
  assert.deepEqual(lm.ledgers.map((l) => l.ledger).sort(), ['Acme Ltd', 'Cash', 'HDFC Bank']);
});

test('the privacy setting shortens names or drops narrations, one or the other', async () => {
  const names = await makeApp({ MINI_TALLO_REDACT: 'names' }).call('vouchers', Q1);
  assert.equal(names.vouchers[0].entries[1].ledger, 'HD…nk');
  assert.equal(names.vouchers[0].entries[0].ledger, '…');
  assert.equal(names.vouchers[0].narration, 'Office rent April');
  const narr = await makeApp({ MINI_TALLO_REDACT: 'narrations' }).call('vouchers', Q1);
  assert.equal(narr.vouchers[0].narration, undefined);
  assert.equal(narr.vouchers[0].entries[1].ledger, 'HDFC Bank');
});

const batch = [
  { type: 'Payment', date: '2025-06-20', narration: 'Rent for June', entries: [{ ledger: 'Rent', dr_cr: 'Dr', amount: 25000 }, { ledger: 'HDFC Bank', dr_cr: 'Cr', amount: 25000 }] },
  { type: 'Contra', date: '2025-06-21', entries: [{ ledger: 'HDFC Bank', dr_cr: 'Dr', amount: 2000.5 }, { ledger: 'Cash', dr_cr: 'Cr', amount: 2000.5 }] },
];

test('build_import_xml refuses a bad batch and writes nothing', async () => {
  const { call, store } = makeApp();
  const unbalanced = await call('build_import_xml', { company: C, vouchers: [{ ...batch[0], entries: [batch[0].entries[0], { ledger: 'HDFC Bank', dr_cr: 'Cr', amount: 24999 }] }] });
  assert.equal(unbalanced.error, 'invalid_batch');
  const unknown = await call('build_import_xml', { company: C, vouchers: [{ ...batch[0], entries: [{ ledger: 'rent', dr_cr: 'Dr', amount: 1 }, { ledger: 'HDFC Bank', dr_cr: 'Cr', amount: 1 }] }] });
  assert.equal(unknown.error, 'book_check_failed');
  assert.match(unknown.problems[0].problems[0], /the book has "Rent"/);
  const contra = await call('build_import_xml', { company: C, vouchers: [{ ...batch[1], entries: [{ ledger: 'Rent', dr_cr: 'Dr', amount: 5 }, { ledger: 'Cash', dr_cr: 'Cr', amount: 5 }] }] });
  assert.match(contra.problems[0].problems[0], /Contra/);
  assert.equal(store.inventory().filter((f) => f.file.startsWith('batches/')).length, 0);
});

test('validate_masters and voucher_schema', async () => {
  const { call } = makeApp();
  const v = await call('validate_masters', { company: C, ledgers: ['HDFC Bank', 'acme ltd', 'Nobody'] });
  assert.equal(v.all_found, false);
  assert.deepEqual(v.results.map((r) => r.found), [true, false, false]);
  assert.equal(v.results[1].did_you_mean[0].ledger, 'Acme Ltd');
  assert.ok((await call('voucher_schema', {})).rules.length > 3);
});

test('build, post after approval, read back, and never post twice', async () => {
  const m2 = await startMockTally();
  try {
    let asked = 0, answer = { ok: false, reason: 'declined' };
    const { call, store } = makeApp({ MINI_TALLO_PORT: String(m2.port), MINI_TALLO_POSTING: 'true' }, async (q) => { asked++; assert.equal(q.kind, 'approve'); return typeof answer === 'function' ? answer() : answer; });
    const built = await call('build_import_xml', { company: C, vouchers: batch });
    assert.equal(built.voucher_count, 2);
    assert.equal(built.total_debits, 27000.5);
    const xml = readFileSync(built.file, 'utf8');
    assert.match(xml, /<LEDGERNAME>Rent<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-25000\.00<\/AMOUNT>/);
    assert.match(xml, /<AMOUNT>2000\.50<\/AMOUNT>/);

    assert.equal((await call('verify_import', { batch_id: built.batch_id })).summary.not_found, 2);
    assert.equal((await call('voucher_presence', { company: C, vouchers: batch })).present, 0);

    const before = m2.book.vouchers.length;
    assert.equal((await call('post_import', { batch_id: built.batch_id, voucher: 0 })).error, 'not_approved');
    answer = { ok: true };                                   // approval without a token does not count
    assert.equal((await call('post_import', { batch_id: built.batch_id, voucher: 0 })).error, 'not_approved');
    assert.equal(m2.book.vouchers.length, before);

    const token = randomUUID();
    answer = { ok: true, token };
    const posted = await call('post_import', { batch_id: built.batch_id, voucher: 0 });
    assert.equal(posted.posted, true);
    assert.equal(posted.read_back_matches_what_was_approved, true);
    assert.equal(posted.review_required, undefined);
    assert.equal(m2.book.vouchers.length, before + 1);

    assert.equal((await call('post_import', { batch_id: built.batch_id, voucher: 0 })).error, 'already_posted');
    assert.equal((await call('post_import', { batch_id: built.batch_id, voucher: 1 })).error, 'not_approved', 'a used token is not accepted again');
    assert.equal(m2.book.vouchers.length, before + 1);
    assert.equal(asked, 4);

    const ver = await call('verify_import', { batch_id: built.batch_id });
    assert.deepEqual(ver.summary, { found_as_built: 1, found_but_different: 0, not_found: 1 });
    assert.ok(existsSync(ver.proof_file));
    assert.deepEqual((await call('voucher_presence', { company: C, vouchers: batch })).results.map((r) => r.present), [true, false]);
    assert.equal((await call('acknowledge_post_review', { batch_id: built.batch_id, voucher: 0 })).error, 'no_review_needed');
    assert.ok(store.readLines('posts.jsonl').some((p) => p.event === 'posted'));
  } finally { await m2.close(); }
});

test('a ledger replaced after the file was built flags the post for review', async () => {
  const m2 = await startMockTally();
  try {
    const { call } = makeApp({ MINI_TALLO_PORT: String(m2.port), MINI_TALLO_POSTING: 'true' }, approve);
    const built = await call('build_import_xml', { company: C, vouchers: [batch[0]] });
    m2.book.ledgers.find((l) => l.name === 'Rent').guid = 'led-rent-replaced';
    const posted = await call('post_import', { batch_id: built.batch_id, voucher: 0 });
    assert.equal(posted.review_required, true);
    assert.deepEqual(posted.ledgers_now_pointing_to_a_different_master, [{ ledger: 'Rent' }]);
    assert.equal((await call('acknowledge_post_review', { batch_id: built.batch_id, voucher: 0 })).acknowledged, true);
  } finally { await m2.close(); }
});

test('a company swapped for another of the same name does not receive the voucher', async () => {
  const m2 = await startMockTally();
  try {
    const { call } = makeApp({ MINI_TALLO_PORT: String(m2.port), MINI_TALLO_POSTING: 'true' }, approve);
    const built = await call('build_import_xml', { company: C, vouchers: [batch[0]] });
    m2.book.company.guid = 'cmp-someone-else';
    const n = m2.book.vouchers.length;
    assert.equal((await call('post_import', { batch_id: built.batch_id, voucher: 0 })).error, 'company_changed');
    assert.equal(m2.book.vouchers.length, n);
  } finally { await m2.close(); }
});

const cell = (x, str) => ({ x, str });
const row = (date, narr, wd, dep, bal) => {
  const cells = [cell(30, date), cell(90, narr), ...(wd ? [cell(380, wd)] : []), ...(dep ? [cell(460, dep)] : []), cell(540, bal)];
  return { text: cells.map((c) => c.str).join(' '), cells };
};
const statement = [
  { text: 'HDFC BANK LTD', cells: [] },
  { text: 'Account No : 50100123456789', cells: [] },
  { text: 'Date Narration Chq./Ref.No. Value Dt Withdrawal Amt. Deposit Amt. Closing Balance', cells: [] },
  row('05/04/25', 'OFFICE RENT APRIL 0000123 05/04/25', '25,000.00', null, '1,75,000.00'),
  { text: 'LANDLORD NAME', cells: [] },
  row('03/05/25', 'NEFT ACME LTD 03/05/25', null, '11,800.00', '1,86,800.00'),
  row('15/05/25', 'ATM CASH WDL 15/05/25', '10,000.00', null, '1,76,800.00'),
  row('02/06/25', 'SUPPLIER CO 02/06/25', '5,900.00', null, '1,70,900.00'),
  { text: 'STATEMENT SUMMARY Opening Balance 2,00,000.00 Closing Bal 1,70,900.00', cells: [] },
];

test('statement rows are read; the first row is placed by its column', () => {
  const p = parseStatementLines(statement);
  assert.equal(p.bank, 'HDFC');
  assert.equal(p.account_last4, '6789');
  assert.deepEqual(p.rows.map((r) => [r.date, r.direction, r.paise]), [
    ['2025-04-05', 'withdrawal', 2500000], ['2025-05-03', 'deposit', 1180000], ['2025-05-15', 'withdrawal', 1000000], ['2025-06-02', 'withdrawal', 590000],
  ]);
  assert.equal(p.rows[0].narration, 'OFFICE RENT APRIL 0000123 LANDLORD NAME');
  assert.equal(p.opening, 20000000);
  assert.equal(p.closing, 17090000);
  assert.equal(p.rows[0].needs_review, true, 'placed by column, so flagged');
});

// A one-page PDF with each line of text at a fixed position, written by hand.
function makePdf(lines) {
  const escP = (s) => s.replace(/[\\()]/g, '\\$&');
  const content = lines.map(({ cells }, i) => cells.map((c) => `BT /F1 9 Tf 1 0 0 1 ${c.x} ${760 - i * 16} Tm (${escP(c.str)}) Tj ET`).join('\n')).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

test('parse_bank_statement reads a PDF, keeps balances private, and ties out to the book', async () => {
  const { call, dir, store } = makeApp();
  const pdfPath = join(dir, 'statement.pdf');
  const withOpening = [...statement.slice(0, 3), { text: 'Opening Balance 2,00,000.00', cells: [] }, ...statement.slice(3)];
  writeFileSync(pdfPath, makePdf(withOpening.map((l) => (l.cells.length ? l : { cells: [cell(30, l.text)] }))), 'latin1');
  const p = await call('parse_bank_statement', { path: pdfPath, bank_ledger: 'HDFC Bank' });
  assert.equal(p.error, undefined, JSON.stringify(p));
  assert.equal(p.count, 4);
  assert.equal(p.every_row_agrees_with_the_running_balance, true);
  assert.deepEqual(p.proposals.map((x) => x.type), ['Payment', 'Receipt', 'Contra', 'Payment']);
  assert.ok(!JSON.stringify(p).includes('170900') && !JSON.stringify(p).includes('1,70,900'), 'balances are not returned');
  assert.equal(store.readJson(`proposals/${p.proposals_id}.json`).closing_paise, 17090000);

  const tie = await call('statement_tie_out', { company: C, proposals_id: p.proposals_id, bank_ledger: 'HDFC Bank' });
  assert.deepEqual([tie.opening_gap, tie.closing_gap, tie.movement_gap, tie.ties], [0, 0, 0, true]);
  assert.deepEqual([tie.from, tie.to], ['2025-04-05', '2025-06-02']);
  const months = await call('statement_tie_out', { company: C, proposals_id: p.proposals_id, bank_ledger: 'HDFC Bank', whole_months: true });
  assert.deepEqual([months.from, months.to, months.ties], ['2025-05-01', '2025-05-31', true]);

  const pres = await call('voucher_presence', { company: C, proposals_id: p.proposals_id, bank_ledger: 'HDFC Bank' });
  assert.equal(pres.present, 4);
  assert.equal((await call('parse_bank_statement', { path: join(dir, 'missing.pdf') })).error, 'file_not_found');
});

test('a protected statement asks for its password locally, retries once, and gives up without one', async () => {
  const pdfPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'statement-protected.pdf');
  const answers = ['wrong', 'secret123'];
  const kinds = [];
  const { call } = makeApp({}, async (q) => { kinds.push(q.kind); return { ok: true, token: randomUUID(), password: answers.shift() }; });
  const p = await call('parse_bank_statement', { path: pdfPath });
  assert.equal(p.error, undefined, JSON.stringify(p));
  assert.equal(p.count, 4);
  assert.deepEqual(kinds, ['password', 'password']);
  assert.ok(!JSON.stringify(p).includes('secret123'));
  const declined = makeApp({}, async () => ({ ok: false, reason: 'declined' }));
  assert.equal((await declined.call('parse_bank_statement', { path: pdfPath })).error, 'password_not_given');
});

test('the approval window answers only to its own one-time token', async () => {
  let wrong;
  const ok = await askLocally({
    title: 'Post?', rows: [['Dr  <b>Rent</b>', '25000.00']],
    open: async (url) => {
      const html = await (await fetch(url)).text();
      assert.ok(html.includes('&lt;b&gt;Rent&lt;/b&gt;'), 'values are escaped');
      assert.equal((await fetch(url.replace(/\/[a-f0-9]+$/, '/guess'))).status, 404);
      wrong = (await fetch(url, { method: 'POST', body: new URLSearchParams({ token: 'forged', decision: 'yes' }) })).status;
      const token = html.match(/name="token" value="([a-f0-9]+)"/)[1];
      await fetch(url, { method: 'POST', body: new URLSearchParams({ token, decision: 'yes' }) });
    },
  });
  assert.equal(wrong, 403);
  assert.equal(ok.ok, true);
  assert.match(ok.token, /^[a-f0-9]{48}$/);
  const no = await askLocally({ title: 'Post?', open: async (url) => {
    const token = (await (await fetch(url)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    await fetch(url, { method: 'POST', body: new URLSearchParams({ token, decision: 'no' }) });
  } });
  assert.deepEqual(no, { ok: false, reason: 'declined' });
  assert.deepEqual(await askLocally({ title: 'Post?', timeoutMs: 50, open: () => {} }), { ok: false, reason: 'timed_out' });
});

test('local tools: receipts, read evidence and the data report hold no figures', async () => {
  const { call } = makeApp();
  await call('trial_balance', Q1);
  const log = await call('egress_log', {});
  assert.deepEqual(Object.keys(log.receipts[0]).sort(), ['company_guid', 'outcome', 'request_fp', 'response_fp', 'tool', 'ts']);
  assert.equal(log.receipts[0].company_guid, 'cmp-demo-0001');
  const ev = await call('read_evidence', {});
  assert.ok(ev.reads.some((r) => r.query === 'MT Ledgers' && r.from === '2025-04-01'));
  const rep = await call('local_data_report', {});
  assert.ok(rep.files.some((f) => f.file === 'egress.jsonl'));
});

test('the server speaks MCP over stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'minitallo-'));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, [join(root, 'src', 'server.js')], {
    env: { ...process.env, MINI_TALLO_TERMS_ACCEPTED: 'true', MINI_TALLO_PORT: String(mock.port), MINI_TALLO_DATA_DIR: dir },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    let buf = '';
    const waiting = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const msg = JSON.parse(buf.slice(0, i));
        waiting.get(msg.id)?.(msg);
      }
    });
    const rpc = (id, method, params) => new Promise((resolve, reject) => {
      waiting.set(id, resolve);
      setTimeout(() => reject(new Error(`no answer to ${method}`)), 15000).unref();
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'mini-tallo');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    assert.equal((await rpc(2, 'tools/list', {})).result.tools.length, 24);
    const res = await rpc(3, 'tools/call', { name: 'list_companies', arguments: {} });
    assert.equal(JSON.parse(res.result.content[0].text).companies[0].name, C);
  } finally { child.kill(); }
});
