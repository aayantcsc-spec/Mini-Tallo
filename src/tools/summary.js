// The figures behind the dashboard's home tiles, gathered in one call.
import { parsePeriod, rupees, toPaise, fromTallyDate } from '../util.js';
import { text } from '../xml.js';
import { loadGroups, loadLedgers, loadVouchers, countStockItems, isUnder, CASH_BANK_GROUPS } from '../book.js';
import { COMPANY } from './reads.js';

const TRADING = ['Sales Accounts', 'Direct Incomes', 'Purchase Accounts', 'Direct Expenses'];

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  for (; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) out.push(`${y}-${String(m).padStart(2, '0')}`);
  return out;
}

export const summaryTools = [
  {
    name: 'dashboard_summary',
    description: 'Month-wise sales, purchases and profit, with trading, cash, assets and liabilities, and outstanding totals for a period.',
    input: { company: COMPANY, from: { type: 'string' }, to: { type: 'string' } },
    required: ['company', 'from', 'to'],
    handler: async (args, ctx) => {
      const period = parsePeriod(args);
      const groups = await loadGroups(ctx);
      const ledgers = await loadLedgers(ctx, period);
      const vouchers = await loadVouchers(ctx, period);
      const hasStock = (await countStockItems(ctx)) > 0;
      const groupOf = new Map(ledgers.map((l) => [l.name, l.parent]));
      const under = (l, names) => isUnder(groups, l.parent, names);
      const isRev = (parent) => !!parent && groups.get(parent)?.revenue === true;

      const months = monthsBetween(period.from, period.to).slice(0, 36);
      const byMonth = new Map(months.map((m) => [m, { month: m, sales: 0, purchases: 0, profit: 0 }]));
      for (const v of vouchers) {
        const row = byMonth.get(v.date.slice(0, 7));
        if (!row) continue;
        for (const e of v.entries) {
          const parent = groupOf.get(e.ledger);
          if (parent == null) continue;
          if (isUnder(groups, parent, ['Sales Accounts'])) row.sales -= e.amount;
          if (isUnder(groups, parent, ['Purchase Accounts'])) row.purchases += e.amount;
          if (isRev(parent)) row.profit -= e.amount;
        }
      }

      // A credit movement on a revenue ledger is income, so profit is opening less closing.
      const moved = (ls) => ls.reduce((s, l) => s + (l.opening - l.closing), 0);
      const revenue = ledgers.filter((l) => isRev(l.parent));
      const cashBank = ledgers.filter((l) => under(l, CASH_BANK_GROUPS));
      const split = cashBank.every((l) => l.tied);
      const primaryTotals = new Map();
      for (const l of ledgers) {
        if (!l.parent || isRev(l.parent)) continue;
        const p = groups.get(l.parent)?.primary ?? l.parent;
        primaryTotals.set(p, (primaryTotals.get(p) ?? 0) + l.closing);
      }

      const bills = (await ctx.read('MT Bills', { type: 'Bills', fetch: ['Name', 'Parent', 'BillDate', 'ClosingBalance'], to: period.to }))
        .map((n) => {
          const date = fromTallyDate(text(n, 'BILLDATE'));
          return { amount: -toPaise(text(n, 'CLOSINGBALANCE')), days: date ? Math.round((Date.parse(period.to) - Date.parse(date)) / 86400000) : 0 };
        })
        .filter((b) => b.amount !== 0);
      const total = (pick) => bills.filter(pick).reduce((s, b) => s + Math.abs(b.amount), 0);

      return {
        period, has_stock_items: hasStock,
        months: months.map((m) => { const r = byMonth.get(m); return { month: m, sales: rupees(r.sales), purchases: rupees(r.purchases), profit: rupees(r.profit) }; }),
        trading: {
          sales: rupees(moved(ledgers.filter((l) => under(l, ['Sales Accounts'])))),
          purchases: rupees(-moved(ledgers.filter((l) => under(l, ['Purchase Accounts'])))),
          // Without closing stock these two would be wrong, so a book with stock items gets neither.
          gross_profit: hasStock ? null : rupees(moved(revenue.filter((l) => TRADING.includes(groups.get(l.parent)?.primary)))),
          net_profit: hasStock ? null : rupees(moved(revenue)),
        },
        cash: {
          net: rupees(cashBank.reduce((s, l) => s + (l.closing - l.opening), 0)),
          inflow: split ? rupees(cashBank.reduce((s, l) => s + l.debits, 0)) : null,
          outflow: split ? rupees(cashBank.reduce((s, l) => s + l.credits, 0)) : null,
        },
        balances: [...primaryTotals].filter(([, v]) => v).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([group, v]) => ({ group, closing: rupees(v) })),
        outstanding: {
          receivables: rupees(total((b) => b.amount > 0)), receivables_over_30_days: rupees(total((b) => b.amount > 0 && b.days > 30)),
          payables: rupees(total((b) => b.amount < 0)), payables_over_30_days: rupees(total((b) => b.amount < 0 && b.days > 30)),
        },
        cash_and_bank: cashBank.filter((l) => l.closing).sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing)).slice(0, 6).map((l) => ({ ledger: l.name, group: l.parent, closing: rupees(l.closing) })),
        vouchers: vouchers.length,
      };
    },
  },
];
