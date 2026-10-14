import { toPaise, fromTallyDate, norm } from './util.js';
import { text, findAll } from './xml.js';

export const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim();
export const nameOf = (n) => clean(n.attrs.NAME ?? text(n, 'NAME'));
const yes = (s) => /^yes$/i.test(String(s ?? '').trim());
const filled = (n, k) => {
  const t = text(n, k);
  return t != null && t !== '';
};
// Tally writes debits as negative amounts; everything above this layer has debit positive.
const dr = (s) => -toPaise(s);

export const CASH_BANK_GROUPS = ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c', 'Bank OCC A/c'];

export async function loadGroups(ctx) {
  const rows = await ctx.read('MT Groups', { type: 'Group', fetch: ['Name', 'Parent', 'IsRevenue'] });
  const map = new Map();
  for (const n of rows) {
    let parent = clean(text(n, 'PARENT'));
    if (norm(parent) === 'primary') parent = '';
    map.set(nameOf(n), { name: nameOf(n), parent, isRevenue: yes(text(n, 'ISREVENUE')) });
  }
  for (const g of map.values()) {
    const chain = [g.name];
    let cur = g;
    while (cur.parent && map.has(cur.parent) && chain.length < 50) {
      cur = map.get(cur.parent);
      chain.push(cur.name);
    }
    g.chain = chain;
    g.primary = cur.name;
    g.revenue = cur.isRevenue || g.isRevenue;
  }
  return map;
}

export const isUnder = (groups, groupName, ancestors) =>
  (groups.get(groupName)?.chain ?? [groupName]).some((g) => ancestors.includes(g));

// Ledgers with balances. With a period, opening and closing are as of its two ends.
export async function loadLedgers(ctx, period, extraFetch = []) {
  const rows = await ctx.read('MT Ledgers', {
    type: 'Ledger',
    fetch: ['Name', 'Parent', 'GUID', 'OpeningBalance', 'ClosingBalance', ...extraFetch],
    compute: period ? { MTOPEN: '$TBalOpening', MTDR: '$TBalDebits', MTCR: '$TBalCredits' } : {},
    ...(period ?? {}),
  });
  return rows.map((n) => {
    const opening = period && filled(n, 'MTOPEN') ? dr(text(n, 'MTOPEN')) : dr(text(n, 'OPENINGBALANCE'));
    const closing = period ? dr(text(n, 'CLOSINGBALANCE')) : opening;
    // Tally leaves a zero total blank, so a blank beside a filled total means zero.
    let debits = filled(n, 'MTDR') ? Math.abs(toPaise(text(n, 'MTDR'))) : null;
    let credits = filled(n, 'MTCR') ? Math.abs(toPaise(text(n, 'MTCR'))) : null;
    if (debits == null && credits != null) debits = 0;
    if (credits == null && debits != null) credits = 0;
    if (debits == null && credits == null && closing === opening) debits = credits = 0;
    let parent = clean(text(n, 'PARENT'));
    if (norm(parent) === 'primary') parent = '';
    return {
      name: nameOf(n),
      parent,
      guid: clean(text(n, 'GUID')),
      opening,
      closing,
      debits,
      credits,
      tied: debits != null && opening + debits - credits === closing,
      node: n,
    };
  });
}

function entriesOf(n) {
  const pick = (names) =>
    findAll(n, (x) => names.includes(x.name) && filled(x, 'LEDGERNAME')).map((x) => ({
      ledger: clean(text(x, 'LEDGERNAME')),
      amount: dr(text(x, 'AMOUNT')),
    }));
  const all = pick(['ALLLEDGERENTRIES.LIST']);
  // Invoice-mode vouchers carry the party and tax lines in LEDGERENTRIES and the
  // sales or purchase lines under each stock line's accounting allocations.
  return all.length ? all : pick(['LEDGERENTRIES.LIST', 'ACCOUNTINGALLOCATIONS.LIST']);
}

export async function loadVouchers(ctx, { from, to }) {
  const rows = await ctx.read('MT Vouchers', {
    type: 'Voucher',
    fetch: [
      'Date', 'VoucherTypeName', 'VoucherNumber', 'Reference', 'Narration', 'PartyLedgerName', 'GUID', 'MasterID',
      'IsCancelled', 'IsOptional',
      'AllLedgerEntries.LedgerName', 'AllLedgerEntries.Amount',
      'LedgerEntries.LedgerName', 'LedgerEntries.Amount',
      'AllInventoryEntries.AccountingAllocations.LedgerName', 'AllInventoryEntries.AccountingAllocations.Amount',
    ],
    filter: '$Date >= $$Date:##SVFROMDATE AND $Date <= $$Date:##SVTODATE',
    from,
    to,
  });
  const out = [];
  let skipped = 0;
  for (const n of rows) {
    const date = fromTallyDate(text(n, 'DATE'));
    if (!date || date < from || date > to) continue;
    if (yes(text(n, 'ISCANCELLED')) || yes(text(n, 'ISOPTIONAL'))) { skipped++; continue; }
    const entries = entriesOf(n);
    out.push({
      date,
      type: clean(text(n, 'VOUCHERTYPENAME') ?? n.attrs.VCHTYPE),
      number: clean(text(n, 'VOUCHERNUMBER')),
      reference: clean(text(n, 'REFERENCE')),
      narration: clean(text(n, 'NARRATION')),
      party: clean(text(n, 'PARTYLEDGERNAME')),
      guid: clean(text(n, 'GUID') ?? n.attrs.REMOTEID),
      master_id: clean(text(n, 'MASTERID')),
      entries,
      amount: entries.reduce((s, e) => s + (e.amount > 0 ? e.amount : 0), 0),
      balanced: entries.reduce((s, e) => s + e.amount, 0) === 0,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  out.skipped = skipped;
  return out;
}

// Voucher type name to the built-in type it is based on (Sales, Purchase, ...).
export async function loadVoucherTypes(ctx) {
  const rows = await ctx.read('MT VoucherTypes', { type: 'VoucherType', fetch: ['Name', 'Parent'] });
  const parent = new Map(rows.map((n) => [nameOf(n), clean(text(n, 'PARENT'))]));
  const base = new Map();
  for (const name of parent.keys()) {
    let cur = name;
    for (let i = 0; i < 20 && parent.get(cur) && parent.get(cur) !== cur && parent.has(parent.get(cur)); i++) cur = parent.get(cur);
    base.set(name, parent.get(cur) && !parent.has(parent.get(cur)) ? parent.get(cur) : cur);
  }
  return base;
}

export async function countStockItems(ctx) {
  return (await ctx.read('MT StockItemNames', { type: 'StockItem', fetch: ['Name'] })).length;
}
