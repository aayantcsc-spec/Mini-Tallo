import { readFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ToolError, rupees, lastDayOfMonth } from '../util.js';
import { loadLedgers } from '../book.js';
import { COMPANY } from './reads.js';

const BANKS = [
  ['HDFC', /HDFC\s*BANK/i],
  ['SBI', /STATE\s*BANK\s*OF\s*INDIA|\bSBIN0/i],
  ['Union Bank of India', /UNION\s*BANK\s*OF\s*INDIA|\bUBIN0/i],
];
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// A row starts with its date, optionally after a serial number.
const DATE_RE = /^(?:\d{1,4}\s+)?(\d{1,2})[\/\-. ]([A-Za-z]{3}|\d{1,2})[\/\-. ,]+(\d{4}|\d{2})(?!\d)/;
const AMOUNT_RE = /(?<![\d.,])((?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})(?!\d)\s*(Cr|Dr)?\b/gi;
const CASH_RE = /\b(ATM|CASH|SELF|CSH|ATW|NWD|CWDR)\b/i;

function readDate(line) {
  const m = line.match(DATE_RE);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = /^\d+$/.test(m[2]) ? Number(m[2]) : MON[m[2].toLowerCase()];
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (!mo || mo > 12 || d < 1 || d > lastDayOfMonth(y, mo)) return null;
  return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, rest: line.slice(m[0].length) };
}

const paiseOf = (s) => {
  const [i, f] = s.replaceAll(',', '').split('.');
  return Number(i) * 100 + Number(f);
};

function amountsIn(textValue) {
  return [...textValue.matchAll(AMOUNT_RE)].map((m) => ({
    paise: paiseOf(m[1]), raw: m[1], at: m.index, dr: /dr/i.test(m[2] ?? ''),
  }));
}

// Lines of text (each with the x position of its pieces) to transactions.
// The running balance decides whether a row is a deposit or a withdrawal, which
// holds for any column layout; column position is the fallback for the first row.
export function parseStatementLines(lines) {
  const whole = lines.map((l) => l.text).join('\n');
  const bank = BANKS.find(([, re]) => re.test(whole))?.[0] ?? null;
  const acct = whole.match(/A(?:ccount|\/c)\.?\s*(?:No|Number|Num)\.?\s*[:\-]?\s*([0-9Xx*]{6,20})/i)?.[1] ?? null;
  const rows = [];
  let openingHint = null;
  for (const line of lines) {
    const t = line.text.replace(/\s+/g, ' ').trim();
    const d = readDate(t);
    if (!d) {
      const am = amountsIn(t);
      if (/opening\s+balance|brought\s+forward|\bB\/F\b/i.test(t) && am.length && openingHint == null && !rows.length) {
        const a = am[am.length - 1];
        openingHint = a.dr ? -a.paise : a.paise;
      } else if (rows.length && !am.length && t.length < 120 && !/page\s+\d|statement|generated|balance|closing|summary|^\*/i.test(t)) {
        rows[rows.length - 1].narration += ' ' + t;
      }
      continue;
    }
    const am = amountsIn(d.rest);
    if (am.length < 2) {
      if (am.length === 1 && !rows.length && openingHint == null) openingHint = am[0].dr ? -am[0].paise : am[0].paise;
      continue;
    }
    const bal = am[am.length - 1];
    const amt = am[am.length - 2];
    const narration = d.rest.slice(0, am[0].at).replace(/\b\d{1,2}[\/\-.](?:\d{1,2}|[A-Za-z]{3})[\/\-.]\d{2,4}\b/g, '').replace(/\s+/g, ' ').trim();
    const cell = (line.cells ?? []).filter((c) => c.str.includes(amt.raw)).pop();
    rows.push({ date: d.date, narration, paise: amt.paise, balance: bal.dr ? -bal.paise : bal.paise, x: cell?.x ?? null, direction: null });
  }
  if (rows.length > 1 && rows[0].date > rows[rows.length - 1].date) rows.reverse();

  const settle = (r, prev) => {
    if (prev == null) return;
    if (r.balance - prev === r.paise) r.direction = 'deposit';
    else if (prev - r.balance === r.paise) r.direction = 'withdrawal';
  };
  rows.forEach((r, i) => settle(r, i === 0 ? openingHint : rows[i - 1].balance));
  // Where the balance does not settle a row, fall back to which column its amount sits in.
  const xs = { deposit: [], withdrawal: [] };
  for (const r of rows) if (r.direction && r.x != null) xs[r.direction].push(r.x);
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const dx = avg(xs.deposit), wx = avg(xs.withdrawal);
  for (const r of rows) {
    if (r.direction) continue;
    r.needs_review = true;
    if (r.x != null && dx != null && wx != null && Math.abs(dx - wx) > 5) r.direction = Math.abs(r.x - dx) < Math.abs(r.x - wx) ? 'deposit' : 'withdrawal';
  }
  rows.forEach((r, i) => { r.index = i; });
  const first = rows[0];
  const opening = first?.direction ? first.balance - (first.direction === 'deposit' ? first.paise : -first.paise) : openingHint;
  return {
    bank, account_last4: acct ? acct.slice(-4) : null, rows,
    opening: opening ?? null, closing: rows.length ? rows[rows.length - 1].balance : null,
    balances_chain: rows.every((r) => !r.needs_review),
  };
}

// Text of a PDF as lines. A protected file asks for its password through getPassword.
export async function pdfLines(path, getPassword) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = readFileSync(path);
  let doc, password;
  for (let attempt = 0; ; attempt++) {
    try {
      doc = await getDocument({ data: new Uint8Array(data), password, verbosity: 0, useSystemFonts: true, isEvalSupported: false }).promise;
      break;
    } catch (e) {
      if (e?.name !== 'PasswordException') throw new ToolError('unreadable_pdf', 'That file could not be read as a PDF.');
      if (attempt >= 3) throw new ToolError('wrong_password', 'The statement password was wrong three times.');
      password = await getPassword(attempt > 0);
      if (password == null) throw new ToolError('password_not_given', 'The statement is password-protected and no password was entered in the Mini Tallo window.');
    }
  }
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const items = (await (await doc.getPage(p)).getTextContent()).items.filter((i) => i.str && i.str.trim());
    const byY = new Map();
    for (const it of items) {
      const y = Math.round(it.transform[5] / 3);
      const key = byY.has(y) ? y : byY.has(y + 1) ? y + 1 : byY.has(y - 1) ? y - 1 : y;
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push({ x: it.transform[4], str: it.str });
    }
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      const cells = byY.get(y).sort((a, b) => a.x - b.x);
      lines.push({ text: cells.map((c) => c.str).join(' '), cells });
    }
  }
  await doc.destroy();
  return lines;
}

function loadProposals(ctx, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw new ToolError('unknown_proposals', 'proposals_id is not one parse_bank_statement issued.');
  const saved = ctx.store.readJson(`proposals/${id}.json`);
  if (!saved) throw new ToolError('unknown_proposals', 'No saved proposals with that id on this computer.');
  return saved;
}

export const bankTools = [
  {
    name: 'parse_bank_statement',
    description: 'Reads an SBI, HDFC or Union Bank of India statement PDF on this computer and proposes Payment, Receipt and Contra vouchers. If the PDF is password-protected, the password is asked for in a separate Mini Tallo window and never passes through the assistant. The statement balances are kept in a private proposals file and are not returned.',
    input: {
      path: { type: 'string', description: 'Full path of the statement PDF on this computer.' },
      bank_ledger: { type: 'string', description: 'The bank ledger this statement belongs to, to fill into the proposals.' },
    },
    required: ['path'],
    handler: async (args, ctx) => {
      const path = String(args.path ?? '');
      if (!/\.pdf$/i.test(path) || !existsSync(path) || !statSync(path).isFile()) throw new ToolError('file_not_found', 'path must be an existing .pdf file on this computer.');
      if (statSync(path).size > 30 * 1024 * 1024) throw new ToolError('file_too_large', 'Statements over 30 MB are not read.');
      const lines = await pdfLines(path, async (again) => {
        const a = await ctx.ask({
          kind: 'password',
          title: again ? 'That password did not open the statement' : 'Bank statement password',
          intro: 'Enter the password for this statement. It is used once, on this computer, and is not stored or shown to the assistant.',
          rows: [['File', path]],
        });
        return a?.ok ? a.password ?? '' : null;
      });
      const parsed = parseStatementLines(lines);
      if (!parsed.bank) throw new ToolError('unsupported_bank', 'This does not look like an SBI, HDFC or Union Bank of India statement.');
      if (!parsed.rows.length) throw new ToolError('no_transactions', 'No transaction rows were recognised. Scanned statements (images) cannot be read.');
      const id = randomBytes(6).toString('hex');
      const bankLedger = args.bank_ledger ? String(args.bank_ledger) : null;
      const proposals = parsed.rows.map((r) => {
        const type = !r.direction ? null : CASH_RE.test(r.narration) ? 'Contra' : r.direction === 'deposit' ? 'Receipt' : 'Payment';
        return {
          proposal: r.index, date: r.date, type, amount: rupees(r.paise), narration: r.narration,
          bank_ledger: bankLedger, bank_side: !r.direction ? null : r.direction === 'deposit' ? 'Dr' : 'Cr',
          other_ledger: null, ...(type === 'Contra' ? { hint: 'Looks like cash; the other ledger is probably a cash ledger.' } : {}),
          ...(r.needs_review ? { needs_review: true } : {}),
        };
      });
      ctx.store.writeJson(`proposals/${id}.json`, {
        id, parsed: new Date().toISOString(), bank: parsed.bank, account_last4: parsed.account_last4, source_file: path,
        opening_paise: parsed.opening, closing_paise: parsed.closing, balances_chain: parsed.balances_chain,
        transactions: parsed.rows.map(({ index, date, narration, paise, balance, direction, needs_review }) => ({ index, date, narration, paise, balance, direction, needs_review: !!needs_review })),
      });
      return {
        proposals_id: id, bank: parsed.bank, account_last4: parsed.account_last4,
        from: parsed.rows[0].date, to: parsed.rows[parsed.rows.length - 1].date,
        count: proposals.length, needing_review: proposals.filter((p) => p.needs_review).length,
        every_row_agrees_with_the_running_balance: parsed.balances_chain,
        proposals,
        next: 'Each proposal needs its other ledger chosen. Use voucher_presence to see which are already in the book, then build_import_xml.',
      };
    },
  },
  {
    name: 'statement_tie_out',
    description: "Whether the bank ledger stands where a parsed bank statement says it stood at the start and at the end of the statement's dates, or of the whole calendar months inside it. Returns three gaps and the dates; the balances themselves are not returned.",
    input: {
      company: COMPANY,
      proposals_id: { type: 'string', description: 'From parse_bank_statement.' },
      bank_ledger: { type: 'string', description: 'The bank ledger in the book.' },
      whole_months: { type: 'boolean', description: 'Compare over the whole calendar months the statement covers instead of its first and last dates.' },
    },
    required: ['company', 'proposals_id', 'bank_ledger'],
    handler: async (args, ctx) => {
      const saved = loadProposals(ctx, args.proposals_id);
      const tx = saved.transactions;
      if (!saved.balances_chain || saved.opening_paise == null) {
        throw new ToolError('statement_not_reliable', 'Some rows of this statement did not agree with its running balance, so it cannot be tied out.');
      }
      let from = tx[0].date, to = tx[tx.length - 1].date;
      let stOpen = saved.opening_paise, stClose = saved.closing_paise;
      if (args.whole_months) {
        // Whole months need a row in the month before and the month after to know the statement spans them.
        const ym = (d) => d.slice(0, 7);
        const months = [...new Set(tx.map((t) => ym(t.date)))].sort().filter((m) => m !== ym(tx[0].date) && m !== ym(tx[tx.length - 1].date));
        if (!months.length) throw new ToolError('no_whole_month', 'The statement does not span a whole calendar month between its first and last rows.');
        const [ly, lm] = months[months.length - 1].split('-').map(Number);
        from = `${months[0]}-01`;
        to = `${months[months.length - 1]}-${String(lastDayOfMonth(ly, lm)).padStart(2, '0')}`;
        stOpen = tx.filter((t) => t.date < from).pop().balance;
        stClose = tx.filter((t) => t.date <= to).pop().balance;
      }
      const ledger = (await loadLedgers(ctx, { from, to })).find((l) => l.name === args.bank_ledger);
      if (!ledger) throw new ToolError('unknown_ledger', `No ledger named "${args.bank_ledger}" in this company.`);
      // Money in the bank is a debit balance in the book and a positive balance on the statement.
      const openGap = ledger.opening - stOpen;
      const closeGap = ledger.closing - stClose;
      return {
        bank_ledger: ledger.name, from, to, basis: args.whole_months ? 'whole calendar months' : 'statement dates',
        opening_gap: rupees(openGap), closing_gap: rupees(closeGap), movement_gap: rupees(closeGap - openGap),
        ties: openGap === 0 && closeGap === 0,
        note: 'Each gap is the book balance less the statement balance. A gap can be timing (cheques not yet presented) and is not by itself an error.',
      };
    },
  },
];
