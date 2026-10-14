'use strict';
// The dashboard page. It asks the local Mini Tallo server for each report and draws it.
// Book data is always put on the page as text, never as markup.

const TOKEN = document.querySelector('meta[name="mini-tallo-token"]').content;
const $ = (id) => document.getElementById(id);
const main = $('main');
let info = null;
let current = 'home';
let drawId = 0;
let editing = false; // mirrors the server's switch; writes are refused there while it is off
let flash = null;    // one message to show on the next draw, after a save or delete

async function api(path, body = {}) {
  const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-Tallo': TOKEN }, body: JSON.stringify(body) });
  return res.json();
}
const call = (tool, args) => api('call', { tool, args });

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => (n == null ? '—' : nf.format(n));
// A signed balance: debit positive, credit negative.
const bal = (n) => (n == null ? '—' : n === 0 ? '0.00' : `${nf.format(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`);

// columns: [header, cell function, 'num' for right-aligned]
function table(columns, rows, foot) {
  if (!rows.length) return h('p', { class: 'sub' }, 'Nothing to show for this selection.');
  const row = (tag, cells) => h('tr', null, cells.map((c, i) => h(tag, { class: columns[i][2] }, c)));
  return h('div', { class: 'scroll' }, h('table', null,
    h('thead', null, row('th', columns.map((c) => c[0]))),
    h('tbody', null, rows.map((r) => row('td', columns.map((c) => c[1](r))))),
    foot ? h('tfoot', null, row('td', foot)) : null));
}
const cards = (items) => h('div', { class: 'cards' }, items.map(([k, v, cls]) => h('div', { class: 'card' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls || ''}` }, v))));
const title = (text, sub) => [h('h1', null, text), h('p', { class: 'sub' }, sub)];
const note = (text) => (text ? h('p', { class: 'note' }, text) : null);
const sel = () => ({ company: $('company').value, from: $('from').value, to: $('to').value });
const span = (s) => `${s.from} to ${s.to}`;

// ---- Home tiles and their charts ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 2025-04-01 as 1-Apr-25, and 2025-04 as Apr-25, the way Tally writes dates.
const tdate = (d) => (d ? `${Number(d.slice(8, 10))}-${MONTHS[Number(d.slice(5, 7)) - 1]}-${d.slice(2, 4)}` : '');
const tmonth = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]}-${m.slice(2, 4)}`;

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// A line or bar chart of [{ label, value }], scaled to crores, lakhs or thousands as the figures need.
function chart(kind, points, legend) {
  const W = 520, H = 300, m = { l: 70, r: 12, t: 16, b: 38 };
  const vals = points.map((p) => p.value || 0);
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  const mag = Math.max(hi, -lo);
  const [div, unit] = mag >= 1e7 ? [1e7, 'In Crores'] : mag >= 1e5 ? [1e5, 'In Lakhs'] : mag >= 1e3 ? [1e3, 'In Thousands'] : [1, 'In Rupees'];
  const step = niceStep(((hi - lo) / div || 1) / 4);
  const top = Math.max(Math.ceil(hi / div / step) * step, lo < 0 ? 0 : step);
  const bottom = Math.floor(lo / div / step) * step;
  const y = (v) => m.t + ((top - v) / (top - bottom)) * (H - m.t - m.b);
  const slot = (W - m.l - m.r) / Math.max(points.length, 1);
  const x = (i) => m.l + (i + 0.5) * slot;
  const kids = [];
  for (let t = bottom; t <= top + step / 1000; t += step) {
    kids.push(svg('line', { x1: m.l - 4, x2: m.l, y1: y(t), y2: y(t), stroke: '#111' }));
    kids.push(svg('text', { x: m.l - 8, y: y(t) + 6, 'text-anchor': 'end' }, step < 1 ? t.toFixed(1) : Math.round(t)));
  }
  kids.push(svg('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, stroke: '#111' }));
  kids.push(svg('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: '#111' }));
  kids.push(svg('text', { x: 18, y: (H - m.b + m.t) / 2, 'text-anchor': 'middle', transform: `rotate(-90 18 ${(H - m.b + m.t) / 2})` }, unit));
  const every = Math.ceil(points.length / 7);
  points.forEach((p, i) => {
    if (i % every === 0) kids.push(svg('text', { x: x(i), y: H - m.b + 24, 'text-anchor': 'middle' }, p.label));
    const tip = svg('title', null, `${p.label}: ${money(p.value || 0)}`);
    const v = (p.value || 0) / div;
    if (kind === 'bar') {
      const w = Math.min(slot * 0.42, 44);
      kids.push(svg('rect', { x: x(i) - w / 2, y: Math.min(y(v), y(0)), width: w, height: Math.abs(y(v) - y(0)), fill: '#1f66a5' }, tip));
    } else kids.push(svg('circle', { cx: x(i), cy: y(v), r: 4, fill: '#1f66a5' }, tip));
  });
  if (kind === 'line' && points.length > 1) {
    kids.unshift(svg('polyline', { points: points.map((p, i) => `${x(i)},${y((p.value || 0) / div)}`).join(' '), fill: 'none', stroke: '#1f66a5', 'stroke-width': 2 }));
  }
  const summary = `${legend}: ${points.map((p) => `${p.label} ${money(p.value || 0)}`).join(', ')}`;
  return [svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': summary }, kids), h('div', { class: 'legend' }, h('i'), legend)];
}

const drCr = (n, plus) => (n == null ? '—' : `${nf.format(Math.abs(n))} ${n >= 0 ? plus : plus === 'Cr' ? 'Dr' : 'Cr'}`);
const kv = (rows, right = 'Amount') => h('table', null,
  h('thead', null, h('tr', null, h('th', null, 'Particulars'), h('th', { class: 'num' }, right))),
  h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'num' }, v)))));
// A tile opens the full report behind it, as a click or Enter does on a Tally tile.
const tile = (name, when, target, ...body) => h('section', {
  class: 'tile', tabindex: 0, role: 'link', 'aria-label': `${name}. Open the report.`,
  onclick: () => go(target), onkeydown: (e) => { if (e.key === 'Enter') go(target); },
}, h('h3', null, name), h('p', { class: 'when' }, when), body);

const pages = {
  home: {
    label: 'Dashboard', needsCompany: true,
    async draw(s) {
      const r = await call('dashboard_summary', s);
      if (r.error) return r;
      const when = `${tdate(s.from)} to ${tdate(s.to)}`;
      const pts = (k) => r.months.map((m) => ({ label: tmonth(m.month), value: m[k] }));
      const t = r.trading, o = r.outstanding;
      const noStockNote = h('p', { class: 'hint' }, 'This book has stock items. Profit needs closing stock, which ledger balances leave out, so it is not shown here.');
      return [h('div', { class: 'tiles' },
        tile('Sales Trend', when, 'sales', chart('line', pts('sales'), 'Nett Transactions')),
        tile('Purchase Trend', when, 'purchase', chart('bar', pts('purchases'), 'Nett Transactions')),
        tile('Cash In/Out Flow', when, 'cash', h('p', { class: 'caption' }, 'for Cash and Bank'),
          kv([['Nett Flow', bal(r.cash.net)], ['Inflow', r.cash.inflow == null ? '—' : `${money(r.cash.inflow)} Dr`], ['Outflow', r.cash.outflow == null ? '—' : `${money(r.cash.outflow)} Cr`]])),
        tile('Trading Details', when, 'pnl',
          kv([...(r.has_stock_items ? [] : [['Gross Profit', drCr(t.gross_profit, 'Cr')], ['Nett Profit', drCr(t.net_profit, 'Cr')]]), ['Sales Accounts', drCr(t.sales, 'Cr')], ['Purchase Accounts', drCr(t.purchases, 'Dr')]]),
          r.has_stock_items ? noStockNote : null),
        tile('Nett Profit Trend', when, 'pnl', r.has_stock_items ? noStockNote : chart('line', pts('profit'), 'Nett Transactions')),
        tile('Receivables/Payables', when, 'outstandings',
          kv([['Receivables', money(o.receivables)], ['Receivables over 30 days', money(o.receivables_over_30_days)], ['Payables', money(o.payables)], ['Payables over 30 days', money(o.payables_over_30_days)]], 'Pending Amount'),
          chart('bar', [{ label: 'Receivables', value: o.receivables }, { label: 'Over 30 days', value: o.receivables_over_30_days }, { label: 'Payables', value: o.payables }, { label: 'Over 30 days', value: o.payables_over_30_days }], 'Pending Amount')),
        tile('Assets/Liabilities', when, 'bs', kv(r.balances.map((b) => [b.group, bal(b.closing)]), 'Closing Balance')),
        tile('Top Groups/Ledgers', when, 'trial', h('p', { class: 'caption' }, 'for Cash and Bank (Ledger-wise)'),
          r.cash_and_bank.length ? kv(r.cash_and_bank.map((l) => [l.ledger, bal(l.closing)]), 'Closing Balance') : h('p', { class: 'hint' }, 'No cash or bank balances.')),
      )];
    },
  },
  status: {
    label: 'Status',
    async draw() {
      const st = await call('tally_status');
      const data = await call('local_data_report');
      const up = st.gateway === 'answers';
      return [
        ...title('Status', `TallyPrime gateway at ${info.gateway}`),
        cards([['TallyPrime', up ? 'Connected' : 'Not answering', up ? 'good' : 'bad'], ['Companies loaded', up ? st.companies.length : '—'], ['Files kept locally', data.file_count ?? '—']]),
        up ? null : h('div', { class: 'msg bad' }, st.detail || st.message || 'TallyPrime did not answer.'),
        up ? table([['Company', (c) => c.name], ['Tally identifier', (c) => c.guid], ['Books from', (c) => c.books_from || '—']], st.companies) : null,
        h('h2', null, 'On this computer'),
        h('p', { class: 'sub' }, `Mini Tallo keeps its receipts and files in ${info.data_folder}`),
        data.files ? table([['File', (f) => f.file], ['Holds', (f) => f.holds], ['Bytes', (f) => f.bytes, 'num']], data.files) : null,
      ];
    },
  },
  trial: {
    label: 'Trial Balance', needsCompany: true,
    async draw(s) {
      const r = await call('trial_balance', s);
      if (r.error) return r;
      const c = r.checks;
      return [
        ...title('Trial Balance', span(s)),
        cards([['Ledgers', r.ledger_count], ['Closings sum to zero', c.closing_balances_sum_to_zero ? 'Yes' : `No, off by ${money(c.difference)}`, c.closing_balances_sum_to_zero ? 'good' : 'bad'], ['Ledgers that do not tie', c.ledgers_where_it_does_not_or_tally_gave_no_split, c.ledgers_where_it_does_not_or_tally_gave_no_split ? 'bad' : 'good']]),
        table([['Ledger', (l) => l.ledger], ['Group', (l) => l.group], ['Opening', (l) => bal(l.opening), 'num'], ['Debits', (l) => money(l.debits), 'num'], ['Credits', (l) => money(l.credits), 'num'], ['Closing', (l) => bal(l.closing), 'num']],
          r.ledgers, ['Total', '', '', money(sum(r.ledgers, 'debits')), money(sum(r.ledgers, 'credits')), '']),
        note('A ledger "ties" when its opening plus debits less credits equals its closing.'),
      ];
    },
  },
  pnl: {
    label: 'Profit & Loss A/c', needsCompany: true,
    async draw(s) {
      const r = await call('profit_and_loss', s);
      if (r.error) return r;
      const side = (name, rows) => h('div', null, h('h2', null, name), table([['Group', (x) => x.group], ['Amount', (x) => money(x.amount), 'num']], rows, ['Total', money(sum(rows, 'amount'))]));
      return [
        ...title('Profit & Loss A/c', span(s)),
        cards([['Gross profit', money(r.gross_profit), r.gross_profit < 0 ? 'bad' : 'good'], [r.net_profit < 0 ? 'Net loss' : 'Net profit', money(Math.abs(r.net_profit)), r.net_profit < 0 ? 'bad' : 'good']]),
        h('div', { class: 'two' }, side('Expenses', r.expenses), side('Income', r.income)),
        note(r.note),
      ];
    },
  },
  bs: {
    label: 'Balance Sheet', needsCompany: true,
    async draw(s) {
      const r = await call('balance_sheet', s);
      if (r.error) return r;
      const side = (name, rows, total) => h('div', null, h('h2', null, name), table([['Group', (x) => x.group], ['Amount', (x) => money(x.amount), 'num']], rows, ['Total', money(total)]));
      return [
        ...title('Balance Sheet', `As of ${r.as_of}`),
        h('div', { class: 'two' }, side('Liabilities', r.liabilities, r.total_liabilities), side('Assets', r.assets, r.total_assets)),
        note(r.note),
      ];
    },
  },
  cash: {
    label: 'Cash Flow', needsCompany: true,
    async draw(s) {
      // This report answers for whole months, so the dates are widened to month boundaries.
      const end = new Date(Date.UTC(Number(s.to.slice(0, 4)), Number(s.to.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const q = { company: s.company, from: `${s.from.slice(0, 7)}-01`, to: end };
      const r = await call('cash_flow', q);
      if (r.error) return r;
      return [
        ...title('Cash Flow', `${span(q)} (whole months)`),
        cards([['Net movement', bal(r.net_movement)], ['Cash and bank ledgers', r.ledgers.length]]),
        table([['Month', (m) => m.month], ['Opening', (m) => bal(m.opening), 'num'], ['Inflow', (m) => money(m.inflow), 'num'], ['Outflow', (m) => money(m.outflow), 'num'], ['Net', (m) => money(m.net), 'num'], ['Closing', (m) => bal(m.closing), 'num']], r.months),
        h('h2', null, 'Ledgers included'),
        table([['Ledger', (l) => l.ledger], ['Group', (l) => l.group], ['Opening', (l) => bal(l.opening), 'num'], ['Closing', (l) => bal(l.closing), 'num']], r.ledgers),
        note(r.note),
      ];
    },
  },
  vouchers: {
    label: 'Day Book', needsCompany: true,
    state: { narration: '', offset: 0, form: null },
    async draw(s) {
      const st = this.state;
      const remove = async (v) => {
        if (!confirm(`Delete ${v.voucher_type} voucher ${v.voucher_number} dated ${v.date} for ${money(v.amount)}?\n\nThis changes your TallyPrime books and cannot be undone here.`)) return;
        const out = await call('delete_voucher', { company: s.company, guid: v.guid, date: v.date });
        flash = out.error ? { bad: true, text: out.message } : { text: `Deleted ${v.voucher_type} voucher ${v.voucher_number}.` };
        draw();
      };
      const edit = (v) => { st.form = { action: 'update', guid: v.guid, date: v.date, voucher: { type: v.voucher_type, date: v.date, voucher_number: v.voucher_number, narration: v.narration || '', entries: v.entries.map((e) => ({ ...e })) } }; draw(); };
      const blank = () => ({ action: 'create', voucher: { type: 'Payment', date: s.to, voucher_number: '', narration: '', entries: [{ ledger: '', dr_cr: 'Dr', amount: '' }, { ledger: '', dr_cr: 'Cr', amount: '' }] } });
      const r = await call('vouchers', { ...s, limit: 100, offset: st.offset, ...(st.narration ? { search: { narration: st.narration } } : {}) });
      if (r.error) return r;
      const box = h('input', { type: 'search', placeholder: 'Search narration', value: st.narration, 'aria-label': 'Search narration' });
      const go = () => { st.narration = box.value.trim(); st.offset = 0; draw(); };
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      const page = (d) => () => { st.offset = Math.max(0, st.offset + d); draw(); };
      return [
        ...title('Day Book', `${span(s)} · ${r.matched} matched${r.cancelled_or_optional_left_out ? ` · ${r.cancelled_or_optional_left_out} cancelled or optional left out` : ''}`),
        h('div', { class: 'toolbar' }, box, h('button', { type: 'button', onclick: go }, 'Search'),
          editing ? h('button', { type: 'button', class: 'primary', onclick: () => { st.form = blank(); draw(); } }, 'New voucher') : h('span', { class: 'small' }, 'Turn on "Allow editing" at the top to add, change or delete.'),
          r.matched > 100 ? [h('button', { type: 'button', onclick: page(-100), disabled: st.offset === 0 }, 'Previous'), h('span', { class: 'small' }, `${st.offset + 1} to ${st.offset + r.returned}`), h('button', { type: 'button', onclick: page(100), disabled: st.offset + r.returned >= r.matched }, 'Next')] : null),
        table([['Date', (v) => tdate(v.date)], ['Type', (v) => v.voucher_type], ['No.', (v) => v.voucher_number],
          ['Entries', (v) => v.entries.map((e) => h('div', null, `${e.dr_cr} ${e.ledger} `, h('span', { class: 'small' }, money(e.amount))))],
          ['Narration', (v) => v.narration || ''], ['Amount', (v) => money(v.amount), 'num'],
          // Only the plain accounting types can be rewritten; any voucher can be deleted.
          ...(editing ? [['', (v) => rowActions(EDITABLE.includes(v.voucher_type) ? () => edit(v) : null, v.guid ? () => remove(v) : null), 'num']] : [])], r.vouchers),
      ].toSpliced(3, 0, st.form && editing ? await voucherForm(s, st) : null);
    },
  },
  sales: { label: 'Sales Register', needsCompany: true, draw: (s) => registerPage('sales_register', 'Sales Register', s) },
  purchase: { label: 'Purchase Register', needsCompany: true, draw: (s) => registerPage('purchase_register', 'Purchase Register', s) },
  outstandings: {
    label: 'Bills Outstanding', needsCompany: true,
    async draw(s) {
      const r = await call('outstandings', { company: s.company, as_of: s.to });
      if (r.error) return r;
      const block = (name, o) => [
        h('h2', null, name),
        cards([['Total', money(o.total)], ['Open bills', o.open_bills], ...Object.entries(o.ageing).filter(([, v]) => v).map(([k, v]) => [`${k} days`, money(v)])]),
        h('div', { class: 'two' },
          h('div', null, table([['Top parties', (p) => p.party], ['Amount', (p) => money(p.amount), 'num']], o.top_parties)),
          h('div', null, table([['Party', (b) => b.party], ['Bill', (b) => b.bill], ['Bill date', (b) => tdate(b.bill_date) || '—'], ['Days', (b) => b.days ?? '—', 'num'], ['Amount', (b) => money(b.amount), 'num']], o.bills))),
        note(o.note),
      ];
      return [...title('Bills Outstanding', `As of ${r.as_of}, aged by ${r.ageing_basis}`), ...block('Receivable', r.receivable), ...block('Payable', r.payable)];
    },
  },
  masters: {
    label: 'Masters', needsCompany: true,
    state: { kind: 'ledger', form: null },
    async draw(s) {
      const st = this.state;
      const k = KINDS[st.kind];
      const r = await call('edit_list_masters', { company: s.company, kind: st.kind });
      if (r.error) return r;
      const kindBox = choose(Object.entries(KINDS).map(([id, x]) => [id, x.label]), st.kind);
      kindBox.addEventListener('change', () => { st.kind = kindBox.value; st.form = null; draw(); });
      const remove = async (m) => {
        if (!confirm(`Delete the ${k.one} "${m.name}"?\n\nThis changes your TallyPrime books and cannot be undone here.`)) return;
        const out = await call('delete_master', { company: s.company, kind: st.kind, name: m.name });
        flash = out.error ? { bad: true, text: out.message } : { text: `Deleted the ${k.one} "${m.name}".` };
        draw();
      };
      const columns = [
        ['Name', (m) => m.name],
        ...(k.parentKind ? [['Under', (m) => m.parent || 'Primary']] : []),
        ...(st.kind === 'ledger' ? [['Opening', (m) => bal(m.opening), 'num']] : []),
        ...(st.kind === 'stock_item' ? [['Unit', (m) => m.unit || '—']] : []),
        ...(st.kind === 'unit' ? [['Formal name', (m) => m.formal_name || '—'], ['Decimals', (m) => m.decimals, 'num']] : []),
        ...(st.kind === 'cost_centre' ? [['Category', (m) => m.category || '—']] : []),
        ...(editing ? [['', (m) => rowActions(() => { st.form = { action: 'update', was: m }; draw(); }, () => remove(m)), 'num']] : []),
      ];
      return [
        ...title('Masters', `${r.count} ${k.label.toLowerCase()}`),
        h('div', { class: 'toolbar' }, h('label', { class: 'small' }, 'Show ', kindBox),
          editing ? h('button', { type: 'button', class: 'primary', onclick: () => { st.form = { action: 'create', was: {} }; draw(); } }, `New ${k.one}`) : h('span', { class: 'small' }, 'Turn on "Allow editing" at the top to add, change or delete.')),
        st.form && editing ? await masterForm(s, st, r.masters) : null,
        table(columns, r.masters),
      ];
    },
  },
  stock: {
    label: 'Stock Summary', needsCompany: true,
    async draw(s) {
      // Stock answers only for a 31 March: the latest one on or before the To date.
      const y = Number(s.to.slice(0, 4)) - (s.to.slice(5) < '03-31' ? 1 : 0);
      const r = await call('stock_summary', { company: s.company, as_of: `${y}-03-31` });
      if (r.error) return r;
      return [
        ...title('Stock Summary', `Closing value as of ${r.as_of}`),
        cards([['Items', r.count], ['Total closing value', money(r.total_closing_value)]]),
        table([['Item', (i) => i.item], ['Stock group', (i) => i.stock_group || 'Primary'], ['Closing value', (i) => money(i.closing_value), 'num']], r.items),
        note(r.note),
      ];
    },
  },
};

const sum = (rows, k) => Math.round(rows.reduce((t, r) => t + Math.round((r[k] || 0) * 100), 0)) / 100;

// ---- Editing: forms for masters and vouchers ----

const EDITABLE = ['Journal', 'Payment', 'Receipt', 'Contra'];
const KINDS = {
  ledger: { label: 'Ledgers', one: 'ledger', parentKind: 'group', parentRequired: true },
  group: { label: 'Account groups', one: 'account group', parentKind: 'group' },
  stock_group: { label: 'Stock groups', one: 'stock group', parentKind: 'stock_group' },
  stock_item: { label: 'Stock items', one: 'stock item', parentKind: 'stock_group' },
  unit: { label: 'Units', one: 'unit' },
  godown: { label: 'Godowns', one: 'godown', parentKind: 'godown' },
  cost_category: { label: 'Cost categories', one: 'cost category' },
  cost_centre: { label: 'Cost centres', one: 'cost centre', parentKind: 'cost_centre' },
};

// options: [value, label] pairs
function choose(options, value, attrs) {
  const box = h('select', attrs, options.map(([v, label]) => h('option', { value: v }, label)));
  box.value = value ?? '';
  return box;
}
const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
const rowActions = (onEdit, onDelete) => h('span', { class: 'actions' },
  onEdit ? h('button', { type: 'button', onclick: onEdit }, 'Edit') : null,
  onDelete ? h('button', { type: 'button', class: 'danger', onclick: onDelete }, 'Delete') : null);

// A form panel whose Save button is disabled while the save is under way.
function formPanel(heading, fields, onSave, onCancel) {
  const problem = h('div', { class: 'msg bad', hidden: true });
  const save = h('button', { type: 'submit', class: 'primary' }, 'Save to TallyPrime');
  const form = h('form', { class: 'panel' }, h('h2', null, heading), fields, problem,
    h('div', { class: 'toolbar' }, save, h('button', { type: 'button', onclick: onCancel }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    const out = await onSave().catch((err) => ({ error: 'dashboard', message: err.message }));
    save.disabled = false;
    if (out?.error) {
      problem.hidden = false;
      problem.replaceChildren(out.message || out.error, ...(out.problems || []).flatMap((p) => p.problems.map((t) => h('div', null, `• ${t}`))));
    }
  });
  return form;
}

async function masterForm(s, st, rows) {
  const k = KINDS[st.kind];
  const { action, was } = st.form;
  const names = async (kind) => (kind === st.kind ? rows : (await call('edit_list_masters', { company: s.company, kind })).masters || []).map((m) => [m.name, m.name]);
  const name = h('input', { type: 'text', required: true, maxlength: 100, value: was.name || '' });
  const fields = [field('Name', name)];
  const get = { name: () => name.value.trim() };
  if (k.parentKind) {
    const options = (await names(k.parentKind)).filter(([n]) => n !== was.name);
    const parent = choose([...(k.parentRequired ? [['', 'Choose a group']] : [['', 'Primary']]), ...options], was.parent, { required: k.parentRequired });
    fields.push(field('Under', parent));
    get.parent = () => parent.value;
  }
  if (st.kind === 'ledger') {
    const amount = h('input', { type: 'number', min: 0, step: '0.01', value: was.opening ? Math.abs(was.opening) : '' });
    const side = choose([['Dr', 'Dr'], ['Cr', 'Cr']], was.opening < 0 ? 'Cr' : 'Dr');
    fields.push(field('Opening balance', h('span', { class: 'pair' }, amount, side)));
    get.opening = () => Number(amount.value) || 0;
    get.opening_dr_cr = () => side.value;
  }
  if (st.kind === 'stock_item') {
    const unit = choose([['', 'No unit'], ...(await names('unit'))], was.unit);
    fields.push(field('Unit', unit));
    get.unit = () => unit.value;
  }
  if (st.kind === 'unit') {
    const formal = h('input', { type: 'text', maxlength: 100, value: was.formal_name || '' });
    const decimals = h('input', { type: 'number', min: 0, max: 4, step: 1, value: was.decimals ?? 0 });
    fields.push(field('Formal name', formal), field('Decimal places', decimals));
    get.formal_name = () => formal.value.trim();
    get.decimals = () => Number(decimals.value) || 0;
  }
  if (st.kind === 'cost_centre') {
    const category = choose([['', 'Default'], ...(await names('cost_category'))], was.category);
    fields.push(field('Category', category));
    get.category = () => category.value;
  }
  return formPanel(action === 'create' ? `New ${k.one}` : `Change the ${k.one} "${was.name}"`, h('div', { class: 'fields' }, fields), async () => {
    const values = Object.fromEntries(Object.entries(get).map(([key, fn]) => [key, fn()]));
    const args = { company: s.company, kind: st.kind, action, ...values, name: action === 'create' ? values.name : was.name, ...(action === 'update' ? { new_name: values.name } : {}) };
    const out = await call('save_master', args);
    if (out.error) return out;
    flash = { text: `${action === 'create' ? 'Created' : 'Changed'} the ${k.one} "${out.name}". TallyPrime shows it when read back.` };
    st.form = null;
    draw();
  }, () => { st.form = null; draw(); });
}

async function voucherForm(s, st) {
  const f = st.form;
  const v = f.voucher;
  const ledgers = ((await call('edit_list_masters', { company: s.company, kind: 'ledger' })).masters || []).map((m) => [m.name, m.name]);
  const type = choose(EDITABLE.map((t) => [t, t]), v.type, { disabled: f.action === 'update' });
  const date = h('input', { type: 'date', required: true, value: v.date });
  const number = h('input', { type: 'text', maxlength: 30, value: v.voucher_number, placeholder: 'Automatic', disabled: f.action === 'update' });
  const narration = h('input', { type: 'text', maxlength: 500, value: v.narration, class: 'wide' });
  const lines = h('div', { class: 'lines' });
  const diff = h('span', { class: 'small' });
  const paise = (e) => Math.round((Number(e.amount) || 0) * 100);
  const showDiff = () => {
    const net = v.entries.reduce((t, e) => t + (e.dr_cr === 'Dr' ? paise(e) : -paise(e)), 0);
    diff.textContent = net === 0 ? 'Debits equal credits.' : `Debits and credits differ by ${money(Math.abs(net) / 100)}.`;
  };
  const drawLines = () => {
    lines.replaceChildren(...v.entries.map((e, i) => {
      const side = choose([['Dr', 'Dr'], ['Cr', 'Cr']], e.dr_cr, { 'aria-label': 'Debit or credit' });
      const ledger = choose([['', 'Choose a ledger'], ...ledgers], e.ledger, { required: true, 'aria-label': 'Ledger' });
      const amount = h('input', { type: 'number', min: '0.01', step: '0.01', required: true, value: e.amount, placeholder: 'Amount', 'aria-label': 'Amount' });
      side.addEventListener('change', () => { e.dr_cr = side.value; showDiff(); });
      ledger.addEventListener('change', () => { e.ledger = ledger.value; });
      amount.addEventListener('input', () => { e.amount = amount.value; showDiff(); });
      return h('div', { class: 'line' }, side, ledger, amount,
        v.entries.length > 2 ? h('button', { type: 'button', onclick: () => { v.entries.splice(i, 1); drawLines(); } }, 'Remove') : null);
    }));
    showDiff();
  };
  drawLines();
  const fields = [
    h('div', { class: 'fields' }, field('Type', type), field('Date', date), field('Number', number), field('Narration', narration)),
    lines,
    h('div', { class: 'toolbar' }, h('button', { type: 'button', onclick: () => { v.entries.push({ ledger: '', dr_cr: 'Dr', amount: '' }); drawLines(); } }, 'Add line'), diff),
  ];
  return formPanel(f.action === 'create' ? 'New voucher' : `Change ${v.type} voucher ${v.voucher_number}`, fields, async () => {
    const voucher = {
      type: type.value, date: date.value, narration: narration.value.trim(),
      ...(f.action === 'create' && number.value.trim() ? { voucher_number: number.value.trim() } : {}),
      entries: v.entries.map((e) => ({ ledger: e.ledger, dr_cr: e.dr_cr, amount: Number(e.amount) })),
    };
    const out = await call('save_voucher', { company: s.company, action: f.action, voucher, ...(f.action === 'update' ? { guid: f.guid, date: f.date } : {}) });
    if (out.error) return out;
    flash = { text: `${f.action === 'create' ? 'Created' : 'Changed'} ${voucher.type} voucher ${out.voucher_number}. TallyPrime shows it when read back.` };
    st.form = null;
    draw();
  }, () => { st.form = null; draw(); });
}

async function registerPage(tool, name, s) {
  const r = await call(tool, s);
  if (r.error) return r;
  return [
    ...title(name, `${span(s)} · ${r.count} vouchers`),
    cards([['Taxable value', money(r.totals.taxable_value)], ['Tax', money(r.totals.tax_total)], ['Total', money(r.totals.voucher_total)]]),
    table([['Date', (v) => tdate(v.date)], ['Type', (v) => v.voucher_type], ['No.', (v) => v.voucher_number], ['Party', (v) => v.party || '—'],
      ['Taxable', (v) => money(v.taxable_value), 'num'], ['Taxes', (v) => v.taxes.map((t) => h('div', null, `${t.ledger} `, h('span', { class: 'small' }, money(t.amount))))],
      ['Tax', (v) => money(v.tax_total), 'num'], ['Total', (v) => money(v.voucher_total), 'num']], r.vouchers),
    note(r.note),
  ];
}

// The gateway list on the left, grouped the way Tally groups its menu.
const NAV = [
  ['', ['home']],
  ['Masters', ['masters']],
  ['Transactions', ['vouchers']],
  ['Reports', ['bs', 'pnl', 'trial', 'cash', 'sales', 'purchase', 'outstandings', 'stock']],
  ['Utilities', ['status']],
];

function go(id) {
  current = id;
  location.hash = id;
  draw();
}

// Start a new master or voucher from anywhere; refused politely while editing is off.
function create(pageId) {
  if (!editing) flash = { bad: true, text: 'Tick "Allow editing" at the top first.' };
  else if (pageId === 'masters') pages.masters.state.form = { action: 'create', was: {} };
  else pages.vouchers.state.form = { action: 'create', voucher: { type: 'Payment', date: sel().to, voucher_number: '', narration: '', entries: [{ ledger: '', dr_cr: 'Dr', amount: '' }, { ledger: '', dr_cr: 'Cr', amount: '' }] } };
  go(pageId);
}

function drawKeys() {
  const keys = current === 'masters' ? [['C', 'Create Master', () => create('masters')]]
    : current === 'vouchers' ? [['V', 'Create Voucher', () => create('vouchers')]]
    : [['V', 'Create Voucher', () => create('vouchers')], ['C', 'Create Master', () => create('masters')]];
  $('page-keys').replaceChildren(...keys.map(([k, label, run]) => h('button', { type: 'button', onclick: run }, h('b', null, k), `: ${label}`)));
}

async function draw() {
  const mine = ++drawId;
  const page = pages[current];
  for (const b of $('nav').children) b.removeAttribute('aria-current');
  $(`nav-${current}`).setAttribute('aria-current', 'page');
  const s = sel();
  $('crumb').textContent = current === 'home' ? 'Dashboard' : `Gateway - ${page.label}`;
  $('strip-company').textContent = s.company;
  $('strip-period').textContent = s.from && s.to ? `${tdate(s.from)} to ${tdate(s.to)}` : '';
  drawKeys();
  main.replaceChildren(h('div', { class: 'sheet' }, h('p', { class: 'sub' }, 'Loading…')));
  let out;
  try {
    if (page.needsCompany && !s.company) out = { error: 'no_company', message: 'No company is loaded in TallyPrime. Open TallyPrime, load a company, and press F5: Refresh.' };
    else if (page.needsCompany && (!s.from || !s.to)) out = { error: 'no_dates', message: 'Choose the From and To dates.' };
    else out = await page.draw(s);
  } catch (e) {
    out = { error: 'dashboard', message: `The dashboard could not reach Mini Tallo: ${e.message}. Is it still running?` };
  }
  if (mine !== drawId) return;
  const failed = !Array.isArray(out);
  if (failed) {
    const extra = (out.problems || []).map((p) => h('div', null, JSON.stringify(p)));
    out = [h('h1', null, page.label), h('div', { class: 'msg bad' }, out.message || out.error, extra)];
  }
  const kids = out.flat().filter(Boolean);
  if (flash) kids.splice(current === 'home' && !failed ? 0 : 1, 0, h('div', { class: `msg ${flash.bad ? 'bad' : 'good'}`, role: 'status' }, flash.text));
  flash = null;
  // The home tiles sit straight on the grey work area; every report is a white sheet.
  main.replaceChildren(...(current === 'home' && !failed ? kids : [h('div', { class: 'sheet' }, kids)]));
}

async function setEditing(on) {
  if (on && !confirm('Allow editing?\n\nWith this on, the New, Edit and Delete buttons change your TallyPrime books directly. Mini Tallo cannot undo a change. Take a backup in TallyPrime first.')) {
    $('editing').checked = false;
    return;
  }
  editing = (await api('editing', { on })).editing === true;
  $('editing').checked = editing;
  $('banner-edit').hidden = !editing;
  draw();
}

async function loadCompanies() {
  const st = await call('tally_status');
  const box = $('company');
  const keep = box.value;
  box.replaceChildren(...(st.companies || []).map((c) => h('option', { value: c.name }, c.name)));
  if (keep && [...box.options].some((o) => o.value === keep)) box.value = keep;
}

async function showTerms() {
  const text = await (await fetch('/terms')).text();
  $('crumb').textContent = 'Terms of Use';
  main.replaceChildren(h('div', { class: 'sheet' },
    h('h1', null, 'Terms of Use'),
    h('p', { class: 'sub' }, `Accept version ${info.terms_version} to use the dashboard.`),
    h('pre', { class: 'terms' }, text),
    h('p', null, h('button', { type: 'button', class: 'primary', onclick: async () => { await api('accept-terms'); start(); } }, 'I accept these terms'))));
}

// ---- Go To: type to filter, arrows to move, Enter to open ----

const GOTO = [
  ['', [['Create Voucher', () => create('vouchers'), true], ['Create Master', () => create('masters'), true], ['Alter Master', () => go('masters'), true]]],
  ['Common Reports', [['Balance Sheet', 'bs'], ['Profit & Loss A/c', 'pnl'], ['Day Book', 'vouchers'], ['Trial Balance', 'trial'], ['Cash Flow', 'cash'], ['Stock Summary', 'stock'], ['Bills Receivable', 'outstandings'], ['Bills Payable', 'outstandings']]],
  ['Registers', [['Sales Register', 'sales'], ['Purchase Register', 'purchase']]],
  ['Masters', [['Chart of Accounts', 'masters']]],
  ['Utilities', [['Dashboard', 'home'], ['Status', 'status']]],
];

function closeGoTo() {
  $('goto-panel').hidden = true;
  $('goto-panel').replaceChildren();
}

function openGoTo() {
  if (!info?.terms_accepted) return;
  const input = h('input', { type: 'text', placeholder: 'Type a report name', 'aria-label': 'Go To', autocomplete: 'off' });
  const list = h('div', { class: 'list', role: 'listbox' });
  let items = [], at = 0;
  const mark = () => items.forEach((b, i) => { b.setAttribute('aria-selected', i === at ? 'true' : 'false'); if (i === at) b.scrollIntoView({ block: 'nearest' }); });
  const fill = () => {
    const q = input.value.trim().toLowerCase();
    items = [];
    const kids = [];
    for (const [head, entries] of GOTO) {
      const hits = entries.filter(([label]) => label.toLowerCase().includes(q));
      if (!hits.length) continue;
      if (head) kids.push(h('div', { class: 'head' }, head));
      for (const [label, target, right] of hits) {
        const b = h('button', { type: 'button', class: `item${right ? ' right' : ''}`, role: 'option', onclick: () => { closeGoTo(); typeof target === 'function' ? target() : go(target); } }, label);
        items.push(b);
        kids.push(b);
      }
    }
    // Like Tally, the bar starts on the first report, below the create and alter actions.
    at = q ? 0 : Math.max(0, items.findIndex((b) => !b.classList.contains('right')));
    list.replaceChildren(...(kids.length ? kids : [h('div', { class: 'head' }, 'Nothing matches.')]));
    mark();
  };
  input.addEventListener('input', fill);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(items.length, 1); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); items[at]?.click(); }
  });
  const panel = $('goto-panel');
  panel.replaceChildren(h('div', { class: 'gotobox', role: 'dialog', 'aria-label': 'Go To' }, h('div', { class: 'cap' }, 'Go To'), input, h('div', { class: 'cap' }, 'List of Reports'), list));
  panel.hidden = false;
  fill();
  input.focus();
}

async function start() {
  info = await api('info');
  $('version').textContent = `Dashboard ${info.version}`;
  if (info.demo) {
    $('banner').hidden = false;
    $('banner').textContent = 'Demo data. This is a made-up company, "Demo Traders", not your books. Start the dashboard without --demo to read TallyPrime.';
  }
  if (!info.terms_accepted) return showTerms();
  editing = info.editing === true;
  $('editing').checked = editing;
  $('banner-edit').hidden = !editing;
  $('from').value = info.period.from;
  $('to').value = info.period.to;
  $('nav').replaceChildren(...NAV.flatMap(([head, ids]) => [
    head ? h('div', { class: 'head' }, head) : null,
    ...ids.map((id) => h('button', { type: 'button', id: `nav-${id}`, onclick: () => go(id) }, pages[id].label)),
  ]).filter(Boolean));
  // The address remembers the report, so a reload or a bookmark returns to it.
  if (pages[location.hash.slice(1)]) current = location.hash.slice(1);
  await loadCompanies();
  draw();
}

const ready = () => info?.terms_accepted === true;
const refresh = async () => { if (ready()) { await loadCompanies(); draw(); } };
$('refresh').addEventListener('click', refresh);
$('goto').addEventListener('click', openGoTo);
$('key-goto').addEventListener('click', openGoTo);
$('key-home').addEventListener('click', () => { if (ready()) go('home'); });
$('key-period').addEventListener('click', () => $('from').focus());
$('key-company').addEventListener('click', () => $('company').focus());
$('goto-panel').addEventListener('click', (e) => { if (e.target === $('goto-panel')) closeGoTo(); });
$('editing').addEventListener('change', (e) => { if (ready()) setEditing(e.target.checked); else e.target.checked = false; });
for (const id of ['company', 'from', 'to']) $(id).addEventListener('change', () => { if (ready()) draw(); });
// Tally's keys: Alt+G for Go To, F2 for the period, F3 for the company, F5 to refresh, Esc to close.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('goto-panel').hidden) closeGoTo();
  else if (e.altKey && e.key.toLowerCase() === 'g') { e.preventDefault(); openGoTo(); }
  else if (e.key === 'F2') { e.preventDefault(); $('from').focus(); }
  else if (e.key === 'F3') { e.preventDefault(); $('company').focus(); }
  else if (e.key === 'F5') { e.preventDefault(); refresh(); }
});
start();
