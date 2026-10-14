// A stand-in for TallyPrime's XML gateway, for tests. It answers the collection
// and import requests Mini Tallo sends, from a small synthetic book. It mimics
// Tally's habits that matter to the reader: debits are negative, zero amounts
// are blank, and primary groups have a control character before "Primary".
import http from 'node:http';
import { parseXml, find, findAll, text, esc } from '../src/xml.js';

const R = (rupees) => Math.round(rupees * 100);

export function sampleBook() {
  const g = (name, parent = '', isRevenue = false) => ({ name, parent, isRevenue });
  const l = (name, parent, opening = 0) => ({ name, parent, opening: R(opening), guid: `led-${name.toLowerCase().replace(/\W+/g, '-')}` });
  const v = (date, type, number, narration, ...lines) => ({
    date, type, number, narration, guid: `vch-${type}-${number}`,
    entries: lines.map(([ledger, amount]) => ({ ledger, amount: R(amount) })),
  });
  return {
    company: { name: 'Demo Traders', guid: 'cmp-demo-0001' },
    groups: [
      g('Capital Account'), g('Current Assets'), g('Current Liabilities'),
      g('Sales Accounts', '', true), g('Purchase Accounts', '', true), g('Indirect Expenses', '', true),
      g('Bank Accounts', 'Current Assets'), g('Cash-in-Hand', 'Current Assets'), g('Sundry Debtors', 'Current Assets'),
      g('Sundry Creditors', 'Current Liabilities'), g('Duties & Taxes', 'Current Liabilities'),
    ],
    ledgers: [
      l('Cash', 'Cash-in-Hand', 50000), l('HDFC Bank', 'Bank Accounts', 200000), l('Capital', 'Capital Account', -250000),
      l('Sales', 'Sales Accounts'), l('Purchases', 'Purchase Accounts'), l('Rent', 'Indirect Expenses'),
      l('Output GST', 'Duties & Taxes'), l('Input GST', 'Duties & Taxes'),
      l('Acme Ltd', 'Sundry Debtors'), l('Supplier Co', 'Sundry Creditors'), l('Profit & Loss A/c', ''),
    ],
    voucherTypes: [['Sales', ''], ['Purchase', ''], ['Payment', ''], ['Receipt', ''], ['Contra', ''], ['Journal', ''], ['Credit Note', ''], ['Debit Note', ''], ['Export Sales', 'Sales']],
    vouchers: [
      v('2025-04-05', 'Payment', '1', 'Office rent April', ['Rent', 25000], ['HDFC Bank', -25000]),
      v('2025-04-10', 'Export Sales', 'S1', 'Goods sold', ['Acme Ltd', 11800], ['Sales', -10000], ['Output GST', -1800]),
      v('2025-04-20', 'Purchase', 'P1', 'Goods bought', ['Purchases', 5000], ['Input GST', 900], ['Supplier Co', -5900]),
      v('2025-05-03', 'Receipt', '1', 'From Acme', ['HDFC Bank', 11800], ['Acme Ltd', -11800]),
      v('2025-05-15', 'Contra', '1', 'Cash withdrawn', ['Cash', 10000], ['HDFC Bank', -10000]),
      v('2025-06-02', 'Payment', '2', 'Paid supplier', ['Supplier Co', 5900], ['HDFC Bank', -5900]),
    ],
    bills: [
      { name: 'S2', party: 'Acme Ltd', date: '2025-06-10', amount: R(4000) },
      { name: 'P7', party: 'Supplier Co', date: '2025-03-01', amount: R(-2500) },
    ],
    stockItems: [],
    stockGroups: [{ name: 'Finished Goods', parent: '' }],
    units: [{ name: 'Nos', formalName: 'Numbers', decimals: 0 }],
    godowns: [{ name: 'Main Location', parent: '' }],
    costCategories: [{ name: 'Primary Cost Category' }],
    costCentres: [{ name: 'Head Office', parent: '', category: 'Primary Cost Category' }],
  };
}

const amt = (p) => (p === 0 ? '' : (-p / 100).toFixed(2));
const d8 = (s) => s.replaceAll('-', '');
const iso = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null);
const primary = (p) => (p ? esc(p) : '&#4; Primary');

function collection(book, type, from, to) {
  if (type === 'Company') return `<COMPANY NAME="${esc(book.company.name)}"><GUID TYPE="String">${book.company.guid}</GUID><BOOKSFROM TYPE="Date">20250401</BOOKSFROM></COMPANY>`;
  if (type === 'Group') return book.groups.map((g) => `<GROUP NAME="${esc(g.name)}"><PARENT TYPE="String">${primary(g.parent)}</PARENT><ISREVENUE TYPE="Logical">${g.isRevenue ? 'Yes' : 'No'}</ISREVENUE></GROUP>`).join('');
  if (type === 'VoucherType') return book.voucherTypes.map(([n, p]) => `<VOUCHERTYPE NAME="${esc(n)}"><PARENT TYPE="String">${esc(p || n)}</PARENT></VOUCHERTYPE>`).join('');
  if (type === 'StockGroup') return book.stockGroups.map((s) => `<STOCKGROUP NAME="${esc(s.name)}"><PARENT>${primary(s.parent)}</PARENT></STOCKGROUP>`).join('');
  if (type === 'Godown') return book.godowns.map((s) => `<GODOWN NAME="${esc(s.name)}"><PARENT>${primary(s.parent)}</PARENT></GODOWN>`).join('');
  if (type === 'CostCategory') return book.costCategories.map((s) => `<COSTCATEGORY NAME="${esc(s.name)}"></COSTCATEGORY>`).join('');
  if (type === 'CostCentre') return book.costCentres.map((s) => `<COSTCENTRE NAME="${esc(s.name)}"><PARENT>${primary(s.parent)}</PARENT><CATEGORY>${esc(s.category ?? '')}</CATEGORY></COSTCENTRE>`).join('');
  if (type === 'Unit') return book.units.map((s) => `<UNIT NAME="${esc(s.name)}"><FORMALNAME>${esc(s.formalName ?? '')}</FORMALNAME><DECIMALPLACES>${s.decimals ?? 0}</DECIMALPLACES></UNIT>`).join('');
  if (type === 'StockItem') return book.stockItems.map((s) => `<STOCKITEM NAME="${esc(s.name)}"><PARENT>${primary(s.parent)}</PARENT><BASEUNITS>${esc(s.unit ?? '')}</BASEUNITS><CLOSINGVALUE TYPE="Amount">${amt(s.value ?? 0)}</CLOSINGVALUE></STOCKITEM>`).join('');
  if (type === 'Bills') return book.bills.map((b) => `<BILL NAME="${esc(b.name)}"><PARENT TYPE="String">${esc(b.party)}</PARENT><BILLDATE TYPE="Date">${d8(b.date)}</BILLDATE><CLOSINGBALANCE TYPE="Amount">${amt(b.amount)}</CLOSINGBALANCE></BILL>`).join('');
  if (type === 'Ledger') {
    return book.ledgers.map((l) => {
      let open = l.opening, dr = 0, cr = 0;
      for (const v of book.vouchers) for (const e of v.entries) {
        if (e.ledger !== l.name) continue;
        if (from && v.date < from) open += e.amount;
        else if (!to || v.date <= to) e.amount > 0 ? (dr += e.amount) : (cr -= e.amount);
      }
      return `<LEDGER NAME="${esc(l.name)}" RESERVEDNAME=""><PARENT TYPE="String">${primary(l.parent)}</PARENT><GUID TYPE="String">${l.guid}</GUID>` +
        `<OPENINGBALANCE TYPE="Amount">${amt(l.opening)}</OPENINGBALANCE><CLOSINGBALANCE TYPE="Amount">${amt(open + dr - cr)}</CLOSINGBALANCE>` +
        `<MTOPEN TYPE="Amount">${amt(open)}</MTOPEN><MTDR TYPE="Amount">${amt(dr)}</MTDR><MTCR TYPE="Amount">${amt(-cr)}</MTCR></LEDGER>`;
    }).join('');
  }
  if (type === 'Voucher') {
    // Dates are deliberately not filtered here, so the reader's own filter is exercised.
    return book.vouchers.map((v) =>
      `<VOUCHER REMOTEID="${esc(v.guid)}" VCHTYPE="${esc(v.type)}"><DATE TYPE="Date">${d8(v.date)}</DATE><GUID TYPE="String">${esc(v.guid)}</GUID><MASTERID TYPE="Number">${book.vouchers.indexOf(v) + 1}</MASTERID>` +
      `<VOUCHERTYPENAME TYPE="String">${esc(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER TYPE="String">${esc(v.number)}</VOUCHERNUMBER>` +
      `<NARRATION TYPE="String">${esc(v.narration)}</NARRATION><PARTYLEDGERNAME TYPE="String">${esc(v.party ?? '')}</PARTYLEDGERNAME>` +
      `<ISCANCELLED TYPE="Logical">No</ISCANCELLED><ISOPTIONAL TYPE="Logical">No</ISOPTIONAL>` +
      v.entries.map((e) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME TYPE="String">${esc(e.ledger)}</LEDGERNAME><AMOUNT TYPE="Amount">${amt(e.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('') +
      `</VOUCHER>`).join('');
  }
  return '';
}

// Master tags to the list each lives in, and how a new one is read from the request.
const MASTERS = {
  LEDGER: ['ledgers', (n, name) => ({ name, parent: text(n, 'PARENT') ?? '', opening: -Math.round(Number(text(n, 'OPENINGBALANCE') || 0) * 100), guid: `led-${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}` })],
  GROUP: ['groups', (n, name) => ({ name, parent: text(n, 'PARENT') ?? '', isRevenue: false })],
  STOCKGROUP: ['stockGroups', (n, name) => ({ name, parent: text(n, 'PARENT') ?? '' })],
  STOCKITEM: ['stockItems', (n, name) => ({ name, parent: text(n, 'PARENT') ?? '', unit: text(n, 'BASEUNITS') ?? '', value: 0 })],
  UNIT: ['units', (n, name) => ({ name, formalName: text(n, 'FORMALNAME') ?? '', decimals: Number(text(n, 'DECIMALPLACES') || 0) })],
  GODOWN: ['godowns', (n, name) => ({ name, parent: text(n, 'PARENT') ?? '' })],
  COSTCATEGORY: ['costCategories', (n, name) => ({ name })],
  COSTCENTRE: ['costCentres', (n, name) => ({ name, parent: text(n, 'PARENT') ?? '', category: text(n, 'CATEGORY') ?? '' })],
};

// Like TallyPrime, refuse to delete a master that something else still uses.
function inUse(book, tag, name) {
  if (tag === 'LEDGER') return book.vouchers.some((v) => v.entries.some((e) => e.ledger === name));
  if (tag === 'GROUP') return book.ledgers.some((l) => l.parent === name) || book.groups.some((g) => g.parent === name);
  if (tag === 'STOCKGROUP') return book.stockItems.some((s) => s.parent === name) || book.stockGroups.some((g) => g.parent === name);
  if (tag === 'UNIT') return book.stockItems.some((s) => s.unit === name);
  if (tag === 'COSTCATEGORY') return book.costCentres.some((c) => c.category === name);
  return book[MASTERS[tag][0]].some((m) => m.parent === name);
}

// A renamed master keeps everything that pointed at it.
function renamed(book, tag, from, to) {
  if (tag === 'LEDGER') for (const v of book.vouchers) for (const e of v.entries) if (e.ledger === from) e.ledger = to;
  if (tag === 'GROUP') for (const x of [...book.ledgers, ...book.groups]) if (x.parent === from) x.parent = to;
  if (tag === 'STOCKGROUP') for (const x of [...book.stockItems, ...book.stockGroups]) if (x.parent === from) x.parent = to;
  if (tag === 'UNIT') for (const s of book.stockItems) if (s.unit === from) s.unit = to;
  if (tag === 'COSTCATEGORY') for (const c of book.costCentres) if (c.category === from) c.category = to;
  if (tag === 'GODOWN' || tag === 'COSTCENTRE') for (const x of book[MASTERS[tag][0]]) if (x.parent === from) x.parent = to;
}

function importData(book, root) {
  const count = { created: 0, altered: 0, deleted: 0 };
  const errors = [];
  for (const msg of findAll(root, (x) => x.name === 'TALLYMESSAGE')) for (const n of msg.children) {
    const action = (n.attrs.ACTION || 'Create').toLowerCase();
    if (n.name === 'VOUCHER') {
      const at = book.vouchers.findIndex((v) => v.guid === n.attrs.REMOTEID);
      if (action === 'delete') {
        if (at < 0) { errors.push('Voucher does not exist!'); continue; }
        book.vouchers.splice(at, 1);
        count.deleted++;
        continue;
      }
      const entries = findAll(n, (x) => x.name === 'ALLLEDGERENTRIES.LIST').map((x) => ({ ledger: text(x, 'LEDGERNAME'), amount: -Math.round(Number(text(x, 'AMOUNT')) * 100) }));
      const missing = entries.find((e) => !book.ledgers.some((l) => l.name === e.ledger));
      if (missing) { errors.push(`Ledger '${missing.ledger}' does not exist!`); continue; }
      const type = text(n, 'VOUCHERTYPENAME');
      const fields = { date: iso(text(n, 'DATE')), type, narration: text(n, 'NARRATION') ?? '', entries };
      if (action === 'alter') {
        if (at < 0) { errors.push('Voucher does not exist!'); continue; }
        Object.assign(book.vouchers[at], fields);
        count.altered++;
      } else {
        book.vouchers.push({ ...fields, number: text(n, 'VOUCHERNUMBER') || String(book.vouchers.filter((v) => v.type === type).length + 1), guid: n.attrs.REMOTEID });
        count.created++;
      }
      continue;
    }
    if (!MASTERS[n.name]) continue;
    const [key, make] = MASTERS[n.name];
    const list = book[key];
    const target = n.attrs.NAME;
    const at = list.findIndex((m) => m.name === target);
    const label = n.name[0] + n.name.slice(1).toLowerCase();
    if (action === 'delete') {
      if (at < 0) errors.push(`${label} '${target}' does not exist!`);
      else if (inUse(book, n.name, target)) errors.push(`${label} '${target}' is in use and cannot be deleted!`);
      else { list.splice(at, 1); count.deleted++; }
      continue;
    }
    const name = find(n, 'NAME')?.text.trim() || target;
    if (action === 'alter') {
      if (at < 0) { errors.push(`${label} '${target}' does not exist!`); continue; }
      const next = make(n, name);
      delete next.guid; // the master keeps its identity
      Object.assign(list[at], next);
      if (name !== target) renamed(book, n.name, target, name);
      count.altered++;
    } else if (at >= 0) errors.push(`${label} '${target}' already exists!`);
    else { list.push(make(n, name)); count.created++; }
  }
  return `<RESPONSE><CREATED>${count.created}</CREATED><ALTERED>${count.altered}</ALTERED><DELETED>${count.deleted}</DELETED><LASTVCHID>${book.vouchers.length}</LASTVCHID><ERRORS>${errors.length}</ERRORS>${errors.map((e) => `<LINEERROR>${esc(e)}</LINEERROR>`).join('')}</RESPONSE>`;
}

export function startMockTally(book = sampleBook()) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const root = parseXml(body);
      const kind = find(root, 'TALLYREQUEST')?.text.trim();
      let out;
      if (kind === 'Import Data') out = importData(book, root);
      else {
        const company = find(root, 'SVCURRENTCOMPANY')?.text.trim();
        if (company && company !== book.company.name) out = `<ENVELOPE><BODY><DATA><LINEERROR>Could not set 'SVCurrentCompany' to '${esc(company)}'</LINEERROR></DATA></BODY></ENVELOPE>`;
        else {
          const type = text(find(root, 'COLLECTION'), 'TYPE');
          out = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION ISMSTDEPTYPE="Yes" MSTDEPTYPE="1">${collection(book, type, iso(find(root, 'SVFROMDATE')?.text.trim()), iso(find(root, 'SVTODATE')?.text.trim()))}</COLLECTION></DATA></BODY></ENVELOPE>`;
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(out);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ book, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}
