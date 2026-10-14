import { ToolError, parsePeriod, wholeMonths, rupees, SIGN_NOTE } from '../util.js';
import { loadGroups, loadLedgers, countStockItems, isUnder, CASH_BANK_GROUPS } from '../book.js';
import { COMPANY } from './reads.js';

const FROM = { type: 'string', description: 'First day of the period, YYYY-MM-DD.' };
const TO = { type: 'string', description: 'Last day of the period, YYYY-MM-DD.' };
const INCOME = ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'];
const EXPENSE = ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'];
const TRADING = ['Sales Accounts', 'Direct Incomes', 'Purchase Accounts', 'Direct Expenses'];

// Ledger balances cannot carry closing stock, so a statement built from them would be wrong.
async function refuseIfStock(ctx, what) {
  if ((await countStockItems(ctx)) > 0) {
    throw new ToolError('stock_items_present', `This book has stock items. ${what} is built from ledger balances, which leave out closing stock, so it is refused here. Use TallyPrime's own report.`);
  }
}

const byPrimary = (ledgers, groups, valueOf) => {
  const acc = new Map();
  for (const l of ledgers) {
    const key = l.parent ? groups.get(l.parent)?.primary ?? l.parent : l.name;
    acc.set(key, (acc.get(key) ?? 0) + valueOf(l));
  }
  return acc;
};

export const statementTools = [
  {
    name: 'balance_sheet',
    description: "The Balance Sheet as of the end of a date range, by primary group, built from TallyPrime's Trial Balance. A book with stock items is refused.",
    input: { company: COMPANY, from: FROM, to: TO },
    required: ['company', 'from', 'to'],
    handler: async (args, ctx) => {
      const period = parsePeriod(args);
      await refuseIfStock(ctx, 'The Balance Sheet');
      const groups = await loadGroups(ctx);
      const ledgers = await loadLedgers(ctx, period);
      const isRev = (l) => (l.parent ? groups.get(l.parent)?.revenue === true : false);
      const isPnlLedger = (l) => !l.parent;
      const acc = byPrimary(ledgers.filter((l) => !isRev(l) && !isPnlLedger(l)), groups, (l) => l.closing);
      const pnl = ledgers.filter((l) => isRev(l) || isPnlLedger(l));
      const pnlTotal = pnl.reduce((s, l) => s + l.closing, 0);
      const thisPeriod = ledgers.filter(isRev).reduce((s, l) => s + (l.closing - l.opening), 0);
      const assets = [], liabilities = [];
      for (const [group, v] of [...acc].sort()) if (v) (v > 0 ? assets : liabilities).push({ group, amount: rupees(Math.abs(v)) });
      if (pnlTotal) (pnlTotal > 0 ? assets : liabilities).push({ group: 'Profit & Loss A/c', amount: rupees(Math.abs(pnlTotal)), of_which_result_for_this_period: rupees(-thisPeriod) });
      const tot = (rows) => rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
      const diff = tot(assets) - tot(liabilities);
      if (diff !== 0) throw new ToolError('does_not_balance', `The ledger balances TallyPrime returned do not sum to zero (difference ${rupees(diff)}), so no Balance Sheet is returned.`);
      return {
        as_of: period.to, period, liabilities, assets,
        total_liabilities: rupees(tot(liabilities)), total_assets: rupees(tot(assets)),
        note: 'Each primary group is shown net, on the side its balance falls. A positive result for the period is a profit.',
      };
    },
  },
  {
    name: 'profit_and_loss',
    description: 'The Profit and Loss for a date range, by primary group. A book with stock items is refused.',
    input: { company: COMPANY, from: FROM, to: TO },
    required: ['company', 'from', 'to'],
    handler: async (args, ctx) => {
      const period = parsePeriod(args);
      await refuseIfStock(ctx, 'The Profit and Loss');
      const groups = await loadGroups(ctx);
      const ledgers = (await loadLedgers(ctx, period)).filter((l) => l.parent && groups.get(l.parent)?.revenue);
      // Movement in the period; a credit movement is income.
      const acc = byPrimary(ledgers, groups, (l) => l.opening - l.closing);
      const income = [], expenses = [];
      let gross = 0, net = 0;
      for (const [group, v] of [...acc].sort()) {
        net += v;
        if (TRADING.includes(group)) gross += v;
        if (!v) continue;
        const asIncome = INCOME.includes(group) || (!EXPENSE.includes(group) && v > 0);
        (asIncome ? income : expenses).push({ group, amount: rupees(asIncome ? v : -v) });
      }
      return {
        period, income, expenses,
        gross_profit: rupees(gross), net_profit: rupees(net),
        note: 'A negative profit is a loss. Gross profit is Sales and Direct Incomes less Purchases and Direct Expenses; there is no stock in this book to adjust for.',
      };
    },
  },
  {
    name: 'cash_flow',
    description: 'Month-wise movement of the cash and bank ledgers for whole months, returned only after the months add up to the movement the whole-period trial balance shows. Not a cash flow statement under AS 3.',
    input: { company: COMPANY, from: { type: 'string', description: 'First day of a month, YYYY-MM-DD.' }, to: { type: 'string', description: 'Last day of a month, YYYY-MM-DD.' } },
    required: ['company', 'from', 'to'],
    handler: async (args, ctx) => {
      const period = parsePeriod(args);
      const months = wholeMonths(period.from, period.to);
      if (months.length > 36) throw new ToolError('period_too_long', 'cash_flow answers for at most 36 months at a time.');
      const groups = await loadGroups(ctx);
      const cashBank = (ls) => ls.filter((l) => isUnder(groups, l.parent, CASH_BANK_GROUPS));
      const sum = (ls, k) => ls.reduce((s, l) => s + (l[k] ?? 0), 0);
      const whole = cashBank(await loadLedgers(ctx, period));
      if (!whole.length) throw new ToolError('no_cash_or_bank_ledgers', 'No ledgers under Cash-in-Hand, Bank Accounts or Bank OD A/c in this company.');
      const rows = [];
      for (const m of months) {
        const ls = cashBank(await loadLedgers(ctx, { from: m.from, to: m.to }));
        const split = ls.every((l) => l.tied);
        rows.push({
          month: m.month, opening: sum(ls, 'opening'), closing: sum(ls, 'closing'),
          inflow: split ? sum(ls, 'debits') : null, outflow: split ? sum(ls, 'credits') : null,
        });
      }
      const expected = sum(whole, 'closing') - sum(whole, 'opening');
      const got = rows.reduce((s, r) => s + (r.closing - r.opening), 0);
      const continuous = rows.every((r, i) => i === 0 || r.opening === rows[i - 1].closing);
      if (got !== expected || !continuous) {
        throw new ToolError('cash_flow_mismatch', 'The month-wise movements do not add up to the movement the whole-period trial balance shows, so nothing is returned.');
      }
      return {
        period, sign: SIGN_NOTE,
        ledgers: whole.map((l) => ({ ledger: l.name, group: l.parent, opening: rupees(l.opening), closing: rupees(l.closing) })),
        months: rows.map((r) => ({ month: r.month, opening: rupees(r.opening), inflow: rupees(r.inflow), outflow: rupees(r.outflow), net: rupees(r.closing - r.opening), closing: rupees(r.closing) })),
        net_movement: rupees(expected),
        note: 'Movement of cash and bank ledgers only. Transfers between two of these ledgers appear in both inflow and outflow. This is not a cash flow statement under AS 3.',
      };
    },
  },
];
