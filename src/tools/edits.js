// Create, change and delete masters and vouchers. These tools exist only on the
// dashboard, where the person at this computer presses the buttons. Every write
// is read back from TallyPrime, and is reported as done only if the book shows it.
import { randomBytes } from 'node:crypto';
import { ToolError, norm, rupees, amountToPaise, parseDate, toTallyDate, toPaise } from '../util.js';
import { esc, text } from '../xml.js';
import { clean, nameOf, loadVouchers } from '../book.js';
import { COMPANY } from './reads.js';
import { normalizeVouchers, checkAgainstBook, voucherXml, envelope, matchInBook } from './imports.js';

// parentKind: where a master's parent is looked up. parentRequired: a blank parent (Primary) is not allowed.
export const KINDS = {
  ledger: { tag: 'LEDGER', type: 'Ledger', label: 'ledger', fetch: ['OpeningBalance'], parentKind: 'group', parentRequired: true },
  group: { tag: 'GROUP', type: 'Group', label: 'account group', fetch: [], parentKind: 'group' },
  stock_group: { tag: 'STOCKGROUP', type: 'StockGroup', label: 'stock group', fetch: [], parentKind: 'stock_group' },
  stock_item: { tag: 'STOCKITEM', type: 'StockItem', label: 'stock item', fetch: ['BaseUnits'], parentKind: 'stock_group' },
  unit: { tag: 'UNIT', type: 'Unit', label: 'unit', fetch: ['FormalName', 'DecimalPlaces'] },
  godown: { tag: 'GODOWN', type: 'Godown', label: 'godown', fetch: [], parentKind: 'godown' },
  cost_category: { tag: 'COSTCATEGORY', type: 'CostCategory', label: 'cost category', fetch: [] },
  cost_centre: { tag: 'COSTCENTRE', type: 'CostCentre', label: 'cost centre', fetch: ['Category'], parentKind: 'cost_centre' },
};
const EDITABLE_TYPES = ['Journal', 'Payment', 'Receipt', 'Contra'];

const kindOf = (kind) => {
  if (!Object.hasOwn(KINDS, kind)) throw new ToolError('bad_kind', `kind must be one of: ${Object.keys(KINDS).join(', ')}`);
  return KINDS[kind];
};

function nameArg(v, field = 'name') {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 100 || /[\u0000-\u001f]/.test(s)) throw new ToolError('bad_name', `${field} must be plain text of 1 to 100 characters.`);
  return s;
}

async function listKind(ctx, kind) {
  const k = kindOf(kind);
  const rows = await ctx.read(`MT Edit ${k.type}`, { type: k.type, fetch: ['Name', 'Parent', ...k.fetch] });
  return rows.map((n) => {
    const parent = clean(text(n, 'PARENT'));
    return {
      name: nameOf(n),
      ...(k.parentKind ? { parent: norm(parent) === 'primary' ? '' : parent } : {}),
      ...(kind === 'ledger' ? { opening: rupees(-toPaise(text(n, 'OPENINGBALANCE'))) } : {}),
      ...(kind === 'stock_item' ? { unit: clean(text(n, 'BASEUNITS')) } : {}),
      ...(kind === 'unit' ? { formal_name: clean(text(n, 'FORMALNAME')), decimals: Number(clean(text(n, 'DECIMALPLACES'))) || 0 } : {}),
      ...(kind === 'cost_centre' ? { category: clean(text(n, 'CATEGORY')) } : {}),
    };
  });
}

const el = (tag, value) => `<${tag}>${esc(value)}</${tag}>`;

function masterXml(kind, action, target, m) {
  const k = KINDS[kind];
  if (action === 'Delete') return `<${k.tag} NAME="${esc(target)}" ACTION="Delete"></${k.tag}>`;
  const body = [
    kind === 'unit' ? el('NAME', m.name) : `<NAME.LIST TYPE="String">${el('NAME', m.name)}</NAME.LIST>`,
    k.parentKind ? el('PARENT', m.parent) : '',
    // Tally's sign: a debit opening balance is written negative.
    kind === 'ledger' ? el('OPENINGBALANCE', m.openingPaise ? (-m.openingPaise / 100).toFixed(2) : '') : '',
    kind === 'stock_item' && m.unit ? el('BASEUNITS', m.unit) : '',
    kind === 'unit' ? el('ISSIMPLEUNIT', 'Yes') + el('FORMALNAME', m.formal_name) + el('DECIMALPLACES', m.decimals) : '',
    kind === 'cost_centre' && m.category ? el('CATEGORY', m.category) : '',
  ].join('');
  return `<${k.tag} NAME="${esc(target)}" ACTION="${action}">${body}</${k.tag}>`;
}

const mastersEnvelope = (company, xml) =>
  `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>` +
  `<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
  `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${xml}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

const notApplied = (res, what) =>
  new ToolError('tally_did_not_apply', `TallyPrime did not ${what}${res.line_errors.length ? `: ${res.line_errors.join('; ')}` : '. Reading the book back shows no change.'}`);

const VOUCHER_ARG = { type: 'object', description: 'A voucher in the voucher_schema format.' };

export const editTools = [
  {
    name: 'edit_list_masters',
    description: 'Masters of one kind with the fields the dashboard can edit.',
    input: { company: COMPANY, kind: { type: 'string', enum: Object.keys(KINDS) } },
    required: ['company', 'kind'],
    handler: async (args, ctx) => {
      const rows = await listKind(ctx, args.kind);
      return { kind: args.kind, count: rows.length, masters: rows };
    },
  },
  {
    name: 'save_master',
    description: 'Creates a master, or changes an existing one (including its name), in TallyPrime.',
    write: true,
    input: {
      company: COMPANY, kind: { type: 'string', enum: Object.keys(KINDS) }, action: { type: 'string', enum: ['create', 'update'] },
      name: { type: 'string', description: 'The name to create, or the existing name to change.' },
      new_name: { type: 'string' }, parent: { type: 'string' }, opening: { type: 'number' }, opening_dr_cr: { type: 'string', enum: ['Dr', 'Cr'] },
      unit: { type: 'string' }, formal_name: { type: 'string' }, decimals: { type: 'integer' }, category: { type: 'string' },
    },
    required: ['company', 'kind', 'action', 'name'],
    handler: async (args, ctx) => {
      const k = kindOf(args.kind);
      if (!['create', 'update'].includes(args.action)) throw new ToolError('bad_action', 'action must be create or update.');
      const existing = await listKind(ctx, args.kind);
      const target = nameArg(args.name);
      const finalName = args.action === 'update' && args.new_name ? nameArg(args.new_name, 'new_name') : target;
      if (args.action === 'create' && existing.some((e) => norm(e.name) === norm(target))) throw new ToolError('already_exists', `A ${k.label} named "${target}" already exists.`);
      if (args.action === 'update') {
        if (!existing.some((e) => e.name === target)) throw new ToolError('not_found', `No ${k.label} named "${target}".`);
        if (existing.some((e) => e.name !== target && norm(e.name) === norm(finalName))) throw new ToolError('already_exists', `Another ${k.label} is already named "${finalName}".`);
      }
      const m = { name: finalName, parent: '' };
      if (k.parentKind) {
        m.parent = typeof args.parent === 'string' ? args.parent.trim() : '';
        if (!m.parent && k.parentRequired) throw new ToolError('parent_required', `A ${k.label} must be placed under a group.`);
        if (m.parent) {
          const parents = k.parentKind === args.kind ? existing : await listKind(ctx, k.parentKind);
          if (!parents.some((p) => p.name === m.parent)) throw new ToolError('unknown_parent', `No ${KINDS[k.parentKind].label} named "${m.parent}".`);
          if (k.parentKind === args.kind && m.parent === target) throw new ToolError('bad_parent', 'A master cannot be placed under itself.');
        }
      }
      if (args.kind === 'ledger' && args.opening) {
        if (!['Dr', 'Cr'].includes(args.opening_dr_cr)) throw new ToolError('bad_amount', 'Say whether the opening balance is Dr or Cr.');
        m.openingPaise = (args.opening_dr_cr === 'Dr' ? 1 : -1) * amountToPaise(args.opening, 'opening');
      }
      if (args.kind === 'stock_item' && args.unit) {
        m.unit = nameArg(args.unit, 'unit');
        if (!(await listKind(ctx, 'unit')).some((u) => u.name === m.unit)) throw new ToolError('unknown_unit', `No unit named "${m.unit}".`);
      }
      if (args.kind === 'unit') {
        m.formal_name = args.formal_name ? nameArg(args.formal_name, 'formal_name') : finalName;
        m.decimals = Number.isInteger(args.decimals) && args.decimals >= 0 && args.decimals <= 4 ? args.decimals : 0;
      }
      if (args.kind === 'cost_centre' && args.category) {
        m.category = nameArg(args.category, 'category');
        if (!(await listKind(ctx, 'cost_category')).some((c) => c.name === m.category)) throw new ToolError('unknown_category', `No cost category named "${m.category}".`);
      }
      const res = await ctx.tally.importData(mastersEnvelope(ctx.company.name, masterXml(args.kind, args.action === 'create' ? 'Create' : 'Alter', target, m)));
      const after = await listKind(ctx, args.kind);
      const there = after.some((e) => e.name === finalName);
      const oldGone = finalName === target || !after.some((e) => e.name === target);
      if (res.errors || !there || !oldGone) throw notApplied(res, `${args.action} the ${k.label}`);
      return { done: true, action: args.action, kind: args.kind, name: finalName, confirmed_by_reading_back: true };
    },
  },
  {
    name: 'delete_master',
    description: 'Deletes a master from TallyPrime. TallyPrime refuses when the master is in use.',
    write: true,
    input: { company: COMPANY, kind: { type: 'string', enum: Object.keys(KINDS) }, name: { type: 'string' } },
    required: ['company', 'kind', 'name'],
    handler: async (args, ctx) => {
      const k = kindOf(args.kind);
      const target = nameArg(args.name);
      if (!(await listKind(ctx, args.kind)).some((e) => e.name === target)) throw new ToolError('not_found', `No ${k.label} named "${target}".`);
      const res = await ctx.tally.importData(mastersEnvelope(ctx.company.name, masterXml(args.kind, 'Delete', target)));
      if (res.errors || (await listKind(ctx, args.kind)).some((e) => e.name === target)) throw notApplied(res, `delete the ${k.label}. It may be in use`);
      return { done: true, action: 'delete', kind: args.kind, name: target, confirmed_by_reading_back: true };
    },
  },
  {
    name: 'save_voucher',
    description: 'Creates a Journal, Payment, Receipt or Contra voucher in TallyPrime, or replaces an existing one of those types.',
    write: true,
    input: {
      company: COMPANY, action: { type: 'string', enum: ['create', 'update'] }, voucher: VOUCHER_ARG,
      guid: { type: 'string', description: 'For update: the identifier of the voucher to replace.' },
      date: { type: 'string', description: 'For update: the date the voucher has now, YYYY-MM-DD.' },
    },
    required: ['company', 'action', 'voucher'],
    handler: async (args, ctx) => {
      const [v] = normalizeVouchers([args.voucher]);
      await checkAgainstBook(ctx, [v]);
      const day = { from: v.date, to: v.date };
      if (args.action === 'create') {
        const saved = { ...v, remote_id: `minitallo-dash-${randomBytes(8).toString('hex')}` };
        const res = await ctx.tally.importData(envelope(ctx.company.name, [voucherXml(saved, saved.remote_id)]));
        const m = matchInBook(await loadVouchers(ctx, day), saved);
        if (res.errors || res.created !== 1 || !m) throw notApplied(res, 'create the voucher');
        return { done: true, action: 'create', voucher_number: m.hit.number, guid: m.hit.guid, confirmed_by_reading_back: true };
      }
      if (args.action !== 'update') throw new ToolError('bad_action', 'action must be create or update.');
      const was = parseDate(args.date, 'date');
      const old = (await loadVouchers(ctx, { from: was, to: was })).find((b) => b.guid && b.guid === args.guid);
      if (!old) throw new ToolError('not_found', 'That voucher is no longer in the book on that date.');
      // Rewriting a voucher replaces all of its lines, so only the plain accounting types are offered.
      if (!EDITABLE_TYPES.includes(old.type) || v.type !== old.type) throw new ToolError('type_not_editable', `Only ${EDITABLE_TYPES.join(', ')} vouchers can be changed here, and the type cannot be changed.`);
      const saved = { ...v, remote_id: old.guid };
      const locate = `DATE="${toTallyDate(old.date)}" ${old.master_id ? `TAGNAME="MASTERID" TAGVALUE="${esc(old.master_id)}" ` : ''}`;
      const res = await ctx.tally.importData(envelope(ctx.company.name, [voucherXml(saved, old.guid, { action: 'Alter', locate })]));
      const m = matchInBook(await loadVouchers(ctx, day), saved);
      if (res.errors || !m || !m.exact || m.hit.guid !== old.guid) throw notApplied(res, 'change the voucher');
      return { done: true, action: 'update', voucher_number: m.hit.number, guid: old.guid, confirmed_by_reading_back: true };
    },
  },
  {
    name: 'delete_voucher',
    description: 'Deletes a voucher from TallyPrime. This cannot be undone.',
    write: true,
    input: { company: COMPANY, guid: { type: 'string' }, date: { type: 'string', description: 'The date of the voucher, YYYY-MM-DD.' } },
    required: ['company', 'guid', 'date'],
    handler: async (args, ctx) => {
      const day = { from: parseDate(args.date, 'date'), to: args.date };
      const old = (await loadVouchers(ctx, day)).find((b) => b.guid && b.guid === args.guid);
      if (!old) throw new ToolError('not_found', 'That voucher is no longer in the book on that date.');
      const xml = `<VOUCHER REMOTEID="${esc(old.guid)}" DATE="${toTallyDate(old.date)}" ${old.master_id ? `TAGNAME="MASTERID" TAGVALUE="${esc(old.master_id)}" ` : ''}VCHTYPE="${esc(old.type)}" ACTION="Delete"></VOUCHER>`;
      const res = await ctx.tally.importData(envelope(ctx.company.name, [xml]));
      if (res.errors || (await loadVouchers(ctx, day)).some((b) => b.guid === old.guid)) throw notApplied(res, 'delete the voucher');
      return { done: true, action: 'delete', voucher_type: old.type, voucher_number: old.number, date: old.date, confirmed_by_reading_back: true };
    },
  },
];
