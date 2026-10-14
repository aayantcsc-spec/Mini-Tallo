import { ToolError, parseDate, parsePeriod, rupees, norm, amountToPaise, fromTallyDate, toPaise, SIGN_NOTE } from '../util.js';
import { text } from '../xml.js';
import { clean, nameOf, loadGroups, loadLedgers, loadVouchers, loadVoucherTypes, isUnder } from '../book.js';

export const COMPANY = { type: 'string', description: 'Company name exactly as list_companies returns it.' };
const FROM = { type: 'string', description: 'First day of the period, YYYY-MM-DD.' };
const TO = { type: 'string', description: 'Last day of the period, YYYY-MM-DD.' };

async function findLedger(ctx, name, period) {
  const ledgers = await loadLedgers(ctx, period);
  const hit = ledgers.find((l) => l.name === name);
  if (hit) return hit;
  const near = ledgers.filter((l) => norm(l.name) === norm(name)).map((l) => ({ ledger: l.name }));
  throw new ToolError('unknown_ledger', `No ledger named "${name}" in this company.`, near.length ? { did_you_mean: near } : undefined);
}

const MASTER_KINDS = {
  voucher_types: 'VoucherType',
  godowns: 'Godown',
  units: 'Unit',
  stock_groups: 'StockGroup',
  cost_centres: 'CostCentre',
  cost_categories: 'CostCategory',
  account_groups: 'Group',
};

function register(kind) {
  const bases = kind === 'sales' ? ['Sales', 'Credit Note'] : ['Purchase', 'Debit Note'];
  const note = bases[1];
  return async (args, ctx) => {
    const period = parsePeriod(args);
    const [groups, ledgers, types, vouchers] = [
      await loadGroups(ctx), await loadLedgers(ctx), await loadVoucherTypes(ctx), await loadVouchers(ctx, period),
    ];
    const isTax = new Set(ledgers.filter((l) => isUnder(groups, l.parent, ['Duties & Taxes'])).map((l) => l.name));
    const rows = [];
    for (const v of vouchers) {
      const base = types.get(v.type) ?? v.type;
      if (!bases.includes(base)) continue;
      const taxLines = v.entries.filter((e) => isTax.has(e.ledger));
      if (!taxLines.length) continue;
      // A sale credits tax and a purchase debits it; a note reverses that and so comes out negative.
      const dir = kind === 'sales' ? -1 : 1;
      const taxes = taxLines.map((e) => ({ ledger: e.ledger, amount: rupees(dir * e.amount) }));
      const taxTotal = taxLines.reduce((s, e) => s + dir * e.amount, 0);
      const total = (base === note ? -1 : 1) * v.amount;
      rows.push({
        date: v.date, voucher_number: v.number, voucher_type: v.type, reference: v.reference, party: v.party,
        taxable_value: rupees(total - taxTotal), taxes, tax_total: rupees(taxTotal), voucher_total: rupees(total),
        ...(v.balanced ? {} : { note: 'Entries read for this voucher do not balance; the totals may be incomplete.' }),
      });
    }
    const sum = (k) => rupees(rows.reduce((s, r) => s + Math.round(r[k] * 100), 0));
    return {
      period, count: rows.length,
      totals: { taxable_value: sum('taxable_value'), tax_total: sum('tax_total'), voucher_total: sum('voucher_total') },
      vouchers: rows,
      note: `As the books record them: ${bases.join(' and ')} vouchers that touch a ledger under Duties & Taxes. This is not a GST return.`,
    };
  };
}

export const readTools = [
  {
    name: 'list_companies',
    description: 'The companies loaded in TallyPrime. Start here: every other book tool needs a company name from this list.',
    input: {},
    handler: async (_args, ctx) => ({ companies: await ctx.companies() }),
  },
  {
    name: 'tally_status',
    description: "Whether TallyPrime's gateway answers on this computer, and which companies are loaded.",
    input: {},
    handler: async (_args, ctx) => {
      try {
        const companies = await ctx.companies();
        return { gateway: 'answers', address: ctx.tally.url, companies };
      } catch (e) {
        if (e instanceof ToolError) return { gateway: 'no_answer', address: ctx.tally.url, reason: e.code, detail: e.message };
        throw e;
      }
    },
  },
  {
    name: 'trial_balance',
    description: 'The ledger-wise Trial Balance for a date range: opening, debits, credits and closing for each ledger.',
    input: { company: COMPANY, from: FROM, to: TO, include_zero: { type: 'boolean', description: 'Include ledgers with no balance and no movement. Default false.' } },
    required: ['company', 'from', 'to'],
    handler: async (args, ctx) => {
      const period = parsePeriod(args);
      const ledgers = await loadLedgers(ctx, period);
      const rows = ledgers
        .filter((l) => args.include_zero || l.opening || l.closing || l.debits || l.credits)
        .map((l) => ({ ledger: l.name, group: l.parent, opening: rupees(l.opening), debits: rupees(l.debits), credits: rupees(l.credits), closing: rupees(l.closing) }));
      const sumClosing = ledgers.reduce((s, l) => s + l.closing, 0);
      const untied = ledgers.filter((l) => !l.tied).length;
      return {
        period, sign: SIGN_NOTE, ledger_count: rows.length, ledgers: rows,
        checks: {
          closing_balances_sum_to_zero: sumClosing === 0,
          difference: rupees(sumClosing),
          ledgers_where_opening_plus_movement_equals_closing: ledgers.length - untied,
          ledgers_where_it_does_not_or_tally_gave_no_split: untied,
        },
      };
    },
  },
  {
    name: 'ledger_movement',
    description: "One ledger's opening balance, total debits, total credits and closing balance for a period.",
    input: { company: COMPANY, ledger: { type: 'string', description: 'Ledger name exactly as in the book.' }, from: FROM, to: TO },
    required: ['company', 'ledger', 'from', 'to'],
    handler: async (args, ctx) => {
      const period = parsePeriod(args);
      const l = await findLedger(ctx, args.ledger, period);
      return {
        ledger: l.name, group: l.parent, period, sign: SIGN_NOTE,
        opening: rupees(l.opening), debits: rupees(l.debits), credits: rupees(l.credits), closing: rupees(l.closing),
        opening_plus_movement_equals_closing: l.tied,
      };
    },
  },
  {
    name: 'ledger_masters',
    description: 'Ledgers with their opening balances. With details=true also GSTIN, PAN, bank account, IFSC, MSME/Udyam number, email, phone and address where the book holds them.',
    input: {
      company: COMPANY,
      group: { type: 'string', description: 'Only ledgers under this group (any depth).' },
      details: { type: 'boolean', description: 'Include party details. These are personal data and go to your AI provider. Default false.' },
    },
    required: ['company'],
    handler: async (args, ctx) => {
      const extra = args.details
        ? ['PartyGSTIN', 'IncomeTaxNumber', 'Email', 'LedgerPhone', 'LedgerMobile', 'Address', 'LedStateName', 'PinCode', 'BankDetails', 'IFSCode', 'MSMERegNumber', 'UdyamRegNumber']
        : [];
      const groups = args.group ? await loadGroups(ctx) : null;
      if (groups && !groups.has(args.group)) throw new ToolError('unknown_group', `No account group named "${args.group}".`);
      const ledgers = (await loadLedgers(ctx, null, extra)).filter((l) => !groups || isUnder(groups, l.parent, [args.group]));
      const opt = (n, k) => clean(text(n, k)) || undefined;
      return {
        sign: SIGN_NOTE, count: ledgers.length,
        ledgers: ledgers.map((l) => ({
          ledger: l.name, group: l.parent, opening: rupees(l.opening),
          ...(args.details
            ? {
                gstin: opt(l.node, 'PARTYGSTIN'), pan: opt(l.node, 'INCOMETAXNUMBER'),
                bank_account_number: opt(l.node, 'BANKDETAILS'), ifsc: opt(l.node, 'IFSCODE'),
                msme_number: opt(l.node, 'MSMEREGNUMBER') ?? opt(l.node, 'UDYAMREGNUMBER'),
                email: opt(l.node, 'EMAIL'), phone: opt(l.node, 'LEDGERPHONE') ?? opt(l.node, 'LEDGERMOBILE'),
                address: [...(l.node.children.find((c) => c.name === 'ADDRESS.LIST')?.children.map((c) => clean(c.text)) ?? []), opt(l.node, 'LEDSTATENAME'), opt(l.node, 'PINCODE')].filter(Boolean).join(', ') || undefined,
              }
            : {}),
        })),
      };
    },
  },
  {
    name: 'masters',
    description: 'Names of one kind of master: voucher_types, godowns, units, stock_groups, cost_centres, cost_categories or account_groups.',
    input: { company: COMPANY, kind: { type: 'string', enum: Object.keys(MASTER_KINDS) } },
    required: ['company', 'kind'],
    handler: async (args, ctx) => {
      const type = MASTER_KINDS[args.kind];
      if (!type) throw new ToolError('bad_kind', `kind must be one of: ${Object.keys(MASTER_KINDS).join(', ')}`);
      const rows = await ctx.read(`MT Masters ${type}`, { type, fetch: ['Name', 'Parent'] });
      return { kind: args.kind, count: rows.length, masters: rows.map((n) => ({ name: nameOf(n), parent: clean(text(n, 'PARENT')).replace(/^primary$/i, '') || undefined })) };
    },
  },
  {
    name: 'vouchers',
    description: 'The vouchers in a period. Optionally search by voucher number, reference, narration or amount, or get a summary by ledger, month, voucher_type, group or primary_group instead of the list.',
    input: {
      company: COMPANY, from: FROM, to: TO,
      search: {
        type: 'object',
        description: 'All given conditions must match.',
        properties: {
          voucher_number: { type: 'string' }, reference: { type: 'string' },
          narration: { type: 'string', description: 'Text contained in the narration, any case.' },
          amount: { type: 'number', description: 'Voucher total, or the amount of any one line.' },
          ledger: { type: 'string', description: 'Vouchers with a line on this ledger.' },
        },
      },
      summary: { type: 'string', enum: ['ledger', 'month', 'voucher_type', 'group', 'primary_group'] },
      limit: { type: 'integer', description: 'Most vouchers to return. Default 100, at most 500.' },
      offset: { type: 'integer', description: 'Vouchers to skip, for paging.' },
    },
    required: ['company', 'from', 'to'],
    handler: async (args, ctx) => {
      const period = parsePeriod(args);
      let vouchers = await loadVouchers(ctx, period);
      const skipped = vouchers.skipped;
      const s = args.search ?? {};
      const amt = s.amount != null ? amountToPaise(s.amount, 'search.amount') : null;
      vouchers = vouchers.filter(
        (v) =>
          (s.voucher_number == null || norm(v.number) === norm(s.voucher_number)) &&
          (s.reference == null || norm(v.reference) === norm(s.reference)) &&
          (s.narration == null || norm(v.narration).includes(norm(s.narration))) &&
          (s.ledger == null || v.entries.some((e) => e.ledger === s.ledger)) &&
          (amt == null || v.amount === amt || v.entries.some((e) => Math.abs(e.amount) === amt)),
      );
      const base = { period, matched: vouchers.length, cancelled_or_optional_left_out: skipped };
      if (args.summary) {
        const acc = new Map();
        const add = (key, d, c, n) => {
          const r = acc.get(key) ?? { debits: 0, credits: 0, vouchers: 0 };
          r.debits += d; r.credits += c; r.vouchers += n;
          acc.set(key, r);
        };
        if (args.summary === 'month' || args.summary === 'voucher_type') {
          for (const v of vouchers) add(args.summary === 'month' ? v.date.slice(0, 7) : v.type, v.amount, v.amount, 1);
          const label = args.summary === 'month' ? 'month' : 'voucher_type';
          return { ...base, summary_by: args.summary, rows: [...acc].sort().map(([k, r]) => ({ [label]: k, vouchers: r.vouchers, amount: rupees(r.debits) })) };
        }
        let keyOf = (e) => e.ledger;
        if (args.summary !== 'ledger') {
          const groups = await loadGroups(ctx);
          const parentOf = new Map((await loadLedgers(ctx)).map((l) => [l.name, l.parent]));
          keyOf = (e) => {
            const g = parentOf.get(e.ledger) ?? '';
            return args.summary === 'group' ? g || e.ledger : groups.get(g)?.primary ?? (g || e.ledger);
          };
        }
        for (const v of vouchers) {
          const seen = new Set();
          for (const e of v.entries) {
            const k = keyOf(e);
            add(k, e.amount > 0 ? e.amount : 0, e.amount < 0 ? -e.amount : 0, seen.has(k) ? 0 : 1);
            seen.add(k);
          }
        }
        const label = args.summary === 'ledger' ? 'ledger' : 'group';
        return { ...base, summary_by: args.summary, rows: [...acc].sort().map(([k, r]) => ({ [label]: k, vouchers: r.vouchers, debits: rupees(r.debits), credits: rupees(r.credits) })) };
      }
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
      const offset = Math.max(Number(args.offset) || 0, 0);
      return {
        ...base, offset, returned: Math.min(limit, Math.max(vouchers.length - offset, 0)),
        vouchers: vouchers.slice(offset, offset + limit).map((v) => ({
          date: v.date, voucher_type: v.type, voucher_number: v.number, reference: v.reference || undefined,
          party: v.party || undefined, narration: v.narration || undefined, amount: rupees(v.amount), guid: v.guid || undefined,
          entries: v.entries.map((e) => ({ ledger: e.ledger, dr_cr: e.amount >= 0 ? 'Dr' : 'Cr', amount: rupees(Math.abs(e.amount)) })),
        })),
      };
    },
  },
  {
    name: 'sales_register',
    description: 'Sales and Credit Note vouchers that touch a ledger under Duties & Taxes, as the books record them. Not a GST return.',
    input: { company: COMPANY, from: FROM, to: TO },
    required: ['company', 'from', 'to'],
    handler: register('sales'),
  },
  {
    name: 'purchase_register',
    description: 'Purchase and Debit Note vouchers that touch a ledger under Duties & Taxes, as the books record them. Not a GST return.',
    input: { company: COMPANY, from: FROM, to: TO },
    required: ['company', 'from', 'to'],
    handler: register('purchase'),
  },
  {
    name: 'outstandings',
    description: 'Receivables and payables as of a date: totals, ageing by bill date, the top parties and the open bills.',
    input: {
      company: COMPANY,
      as_of: { type: 'string', description: 'Date, YYYY-MM-DD.' },
      kind: { type: 'string', enum: ['receivable', 'payable', 'both'], description: 'Default both.' },
      top: { type: 'integer', description: 'How many top parties to list. Default 10.' },
    },
    required: ['company', 'as_of'],
    handler: async (args, ctx) => {
      const asOf = parseDate(args.as_of, 'as_of');
      const kinds = args.kind && args.kind !== 'both' ? [args.kind] : ['receivable', 'payable'];
      const rows = await ctx.read('MT Bills', { type: 'Bills', fetch: ['Name', 'Parent', 'BillDate', 'ClosingBalance'], to: asOf });
      const bills = rows
        .map((n) => {
          const amount = -toPaise(text(n, 'CLOSINGBALANCE'));
          const date = fromTallyDate(text(n, 'BILLDATE'));
          const days = date ? Math.round((Date.parse(asOf) - Date.parse(date)) / 86400000) : null;
          return { party: clean(text(n, 'PARENT')), bill: nameOf(n), bill_date: date, days, amount };
        })
        .filter((b) => b.amount !== 0 && (!b.bill_date || b.bill_date <= asOf));
      const buckets = [['0-30', 30], ['31-60', 60], ['61-90', 90], ['91-180', 180], ['over 180', Infinity]];
      const out = { as_of: asOf, ageing_basis: 'bill date' };
      for (const kind of kinds) {
        const mine = bills.filter((b) => (kind === 'receivable' ? b.amount > 0 : b.amount < 0)).map((b) => ({ ...b, amount: Math.abs(b.amount) }));
        const ageing = Object.fromEntries(buckets.map(([k]) => [k, 0]));
        const byParty = new Map();
        for (const b of mine) {
          const bucket = b.days == null ? 'undated' : buckets.find(([, max]) => b.days <= max)[0];
          ageing[bucket] = (ageing[bucket] ?? 0) + b.amount;
          byParty.set(b.party, (byParty.get(b.party) ?? 0) + b.amount);
        }
        mine.sort((a, b) => b.amount - a.amount);
        out[kind] = {
          total: rupees(mine.reduce((s, b) => s + b.amount, 0)),
          open_bills: mine.length,
          ageing: Object.fromEntries(Object.entries(ageing).map(([k, v]) => [k, rupees(v)])),
          top_parties: [...byParty].sort((a, b) => b[1] - a[1]).slice(0, Math.max(Number(args.top) || 10, 1)).map(([party, amount]) => ({ party, amount: rupees(amount) })),
          bills: mine.slice(0, 200).map((b) => ({ party: b.party, bill: b.bill, bill_date: b.bill_date, days: b.days, amount: rupees(b.amount) })),
          ...(mine.length > 200 ? { note: 'Only the 200 largest open bills are listed.' } : {}),
        };
      }
      return out;
    },
  },
  {
    name: 'stock_summary',
    description: 'The closing stock value of each item as of a 31 March, values only. Small books only: more than 500 stock items is refused, and so is any other date.',
    input: { company: COMPANY, as_of: { type: 'string', description: 'A 31 March, YYYY-MM-DD.' } },
    required: ['company', 'as_of'],
    handler: async (args, ctx) => {
      const asOf = parseDate(args.as_of, 'as_of');
      if (!asOf.endsWith('-03-31')) throw new ToolError('year_end_only', 'stock_summary only answers for a 31 March.');
      const from = `${Number(asOf.slice(0, 4)) - 1}-04-01`;
      const rows = await ctx.read('MT StockItems', { type: 'StockItem', fetch: ['Name', 'Parent', 'ClosingValue'], from, to: asOf });
      if (rows.length > 500) throw new ToolError('book_too_large', 'This book has more than 500 stock items; stock_summary only handles small books.');
      const items = rows.map((n) => ({ item: nameOf(n), stock_group: clean(text(n, 'PARENT')).replace(/^primary$/i, '') || undefined, closing_value: rupees(Math.abs(toPaise(text(n, 'CLOSINGVALUE')))) }));
      return {
        as_of: asOf, count: items.length,
        total_closing_value: rupees(items.reduce((s, i) => s + Math.round(i.closing_value * 100), 0)),
        items,
        note: 'Values only, as TallyPrime computes them under each item\'s own valuation method. Quantities are not returned.',
      };
    },
  },
];
