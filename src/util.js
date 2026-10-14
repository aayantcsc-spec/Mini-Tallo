import { createHash } from 'node:crypto';

// A refusal the assistant can act on: a stable code plus a plain message.
export class ToolError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export const sha = (v) =>
  createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex');

export const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function parseDate(s, field = 'date') {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ToolError('bad_date', `${field} must be a date written as YYYY-MM-DD`);
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ToolError('bad_date', `${field} is not a real calendar date: ${s}`);
  }
  return s;
}

export function parsePeriod(args) {
  const from = parseDate(args.from, 'from');
  const to = parseDate(args.to, 'to');
  if (from > to) throw new ToolError('bad_period', 'from must not be later than to');
  return { from, to };
}

export const toTallyDate = (s) => s.replaceAll('-', '');
export const fromTallyDate = (s) => {
  const t = String(s ?? '').trim();
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}` : null;
};

export const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

// Whole calendar months between two dates, or a refusal if the dates are not month boundaries.
export function wholeMonths(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fd !== 1 || td !== lastDayOfMonth(ty, tm)) {
    throw new ToolError('whole_months_only', 'from must be the first day of a month and to the last day of a month');
  }
  const out = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    out.push({ month: `${y}-${pad(m)}`, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` });
  }
  return out;
}

// Digits to integer paise without going through floating point.
function digitsToPaise(digits) {
  const [int, frac = ''] = digits.replaceAll(',', '').split('.');
  const f = (frac + '000').slice(0, 3);
  return Number(int || '0') * 100 + Number(f.slice(0, 2)) + (Number(f[2]) >= 5 ? 1 : 0);
}

// Tally's amount text to signed paise in Tally's own sign (debit negative).
// A forex amount reads "-$100.00 @ ... = -8000.00"; the base-currency figure follows the last "=".
export function toPaise(textValue) {
  let s = String(textValue ?? '').trim();
  if (!s) return 0;
  if (s.includes('=')) s = s.slice(s.lastIndexOf('=') + 1);
  const m = s.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return 0;
  const p = digitsToPaise(m[0]);
  return /-/.test(s.slice(0, m.index)) || /^\(.*\)$/.test(s.trim()) ? -p : p;
}

// An amount supplied by the caller: positive, at most two decimals.
export function amountToPaise(n, field = 'amount') {
  const s = typeof n === 'number' ? String(n) : typeof n === 'string' ? n.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new ToolError('bad_amount', `${field} must be a positive number with at most two decimals`);
  }
  const p = digitsToPaise(s);
  if (p <= 0) throw new ToolError('bad_amount', `${field} must be greater than zero`);
  return p;
}

export const rupees = (p) => (p == null ? null : Math.round(p) / 100);
export const SIGN_NOTE = 'Debit balances are positive and credit balances negative.';
