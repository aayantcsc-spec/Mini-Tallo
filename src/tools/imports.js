import { randomBytes } from 'node:crypto';
import { ToolError, parseDate, amountToPaise, rupees, norm, sha, toTallyDate } from '../util.js';
import { esc } from '../xml.js';
import { loadGroups, loadLedgers, loadVouchers, isUnder, CASH_BANK_GROUPS } from '../book.js';
import { COMPANY } from './reads.js';

const TYPES = ['Journal', 'Payment', 'Receipt', 'Contra'];
const MAX_BATCH = 500;

const VOUCHER_SCHEMA = {
  type: 'object',
  required: ['type', 'date', 'entries'],
  properties: {
    type: { type: 'string', enum: TYPES },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    voucher_number: { type: 'string', description: 'Leave out to let TallyPrime number it.' },
    reference: { type: 'string' },
    narration: { type: 'string' },
    entries: {
      type: 'array', minItems: 2,
      items: {
        type: 'object', required: ['ledger', 'dr_cr', 'amount'],
        properties: {
          ledger: { type: 'string', description: 'Ledger name exactly as in the book.' },
          dr_cr: { type: 'string', enum: ['Dr', 'Cr'] },
          amount: { type: 'number', description: 'Positive, at most two decimals.' },
        },
      },
    },
  },
};
const VOUCHERS_ARG = { type: 'array', minItems: 1, maxItems: MAX_BATCH, items: VOUCHER_SCHEMA };

const str = (v, max, field, problems) => {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) {
    problems.push(`${field} must be plain text of at most ${max} characters`);
    return '';
  }
  return v.trim();
};

// Shape checks that need no book: types, dates, amounts, and debits equal to credits.
export function normalizeVouchers(list) {
  if (!Array.isArray(list) || !list.length) throw new ToolError('invalid_batch', 'vouchers must be a list with at least one voucher.');
  if (list.length > MAX_BATCH) throw new ToolError('invalid_batch', `A batch holds at most ${MAX_BATCH} vouchers.`);
  const problems = [];
  const out = list.map((v, i) => {
    const p = [];
    const res = { type: v?.type, date: v?.date, number: '', reference: '', narration: '', entries: [] };
    if (!TYPES.includes(v?.type)) p.push(`type must be one of ${TYPES.join(', ')}`);
    try { parseDate(v?.date); } catch (e) { p.push(e.message); }
    res.number = str(v?.voucher_number, 30, 'voucher_number', p);
    res.reference = str(v?.reference, 60, 'reference', p);
    res.narration = str(v?.narration, 500, 'narration', p);
    if (!Array.isArray(v?.entries) || v.entries.length < 2) p.push('entries must list at least two lines');
    else {
      for (const [j, e] of v.entries.entries()) {
        const ledger = typeof e?.ledger === 'string' ? e.ledger.trim() : '';
        if (!ledger) p.push(`entries[${j}].ledger is missing`);
        if (!['Dr', 'Cr'].includes(e?.dr_cr)) p.push(`entries[${j}].dr_cr must be Dr or Cr`);
        let paise = 0;
        try { paise = amountToPaise(e?.amount, `entries[${j}].amount`); } catch (err) { p.push(err.message); }
        res.entries.push({ ledger, dr_cr: e?.dr_cr, paise });
      }
      const net = res.entries.reduce((s, e) => s + (e.dr_cr === 'Dr' ? e.paise : -e.paise), 0);
      if (!p.length && net !== 0) p.push(`debits and credits differ by ${rupees(Math.abs(net))}`);
    }
    if (p.length) problems.push({ voucher: i, problems: p });
    return res;
  });
  if (problems.length) throw new ToolError('invalid_batch', 'The batch has problems; nothing was written.', { problems });
  return out;
}

// Checks against the live book: every ledger exists, and cash or bank sits where the voucher type needs it.
export async function checkAgainstBook(ctx, vouchers) {
  const groups = await loadGroups(ctx);
  const ledgers = await loadLedgers(ctx);
  const byName = new Map(ledgers.map((l) => [l.name, l]));
  const isCash = (name) => isUnder(groups, byName.get(name)?.parent ?? '', CASH_BANK_GROUPS);
  const problems = [];
  vouchers.forEach((v, i) => {
    const p = [];
    for (const e of v.entries) {
      if (byName.has(e.ledger)) continue;
      const near = ledgers.find((l) => norm(l.name) === norm(e.ledger));
      p.push(`no ledger named "${e.ledger}"${near ? `; the book has "${near.name}"` : ''}`);
    }
    if (!p.length) {
      if (v.type === 'Contra' && !v.entries.every((e) => isCash(e.ledger))) p.push('a Contra may only use cash and bank ledgers');
      if (v.type === 'Payment' && !v.entries.some((e) => e.dr_cr === 'Cr' && isCash(e.ledger))) p.push('a Payment must credit a cash or bank ledger');
      if (v.type === 'Receipt' && !v.entries.some((e) => e.dr_cr === 'Dr' && isCash(e.ledger))) p.push('a Receipt must debit a cash or bank ledger');
    }
    if (p.length) problems.push({ voucher: i, problems: p });
  });
  if (problems.length) throw new ToolError('book_check_failed', 'The batch does not fit the live book; nothing was written.', { problems });
  return byName;
}

export function voucherXml(v, remoteId, { action = 'Create', locate = '' } = {}) {
  const d = toTallyDate(v.date);
  const lines = v.entries
    .map((e) => {
      // Tally's convention: a debit is "deemed positive" and carries a negative amount.
      const amt = (e.paise / 100).toFixed(2);
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${e.dr_cr === 'Dr' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${e.dr_cr === 'Dr' ? '-' : ''}${amt}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    })
    .join('');
  return (
    `<VOUCHER REMOTEID="${esc(remoteId)}" ${locate}VCHTYPE="${esc(v.type)}" ACTION="${action}" OBJVIEW="Accounting Voucher View">` +
    `<DATE>${d}</DATE><EFFECTIVEDATE>${d}</EFFECTIVEDATE><GUID>${esc(remoteId)}</GUID><VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME>` +
    (v.number ? `<VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>` : '') +
    (v.reference ? `<REFERENCE>${esc(v.reference)}</REFERENCE>` : '') +
    `<NARRATION>${esc(v.narration)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${lines}</VOUCHER>`
  );
}

export const envelope = (company, vouchersXml) =>
  `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>` +
  `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
  `<REQUESTDATA>${vouchersXml.map((x) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${x}</TALLYMESSAGE>`).join('')}</REQUESTDATA>` +
  `</IMPORTDATA></BODY></ENVELOPE>`;

const signature = (date, type, entries) =>
  [date, norm(type), ...entries.map((e) => `${norm(e.ledger)}|${e.amount}`).sort()].join('~');
const sigOfSaved = (v) => signature(v.date, v.type, v.entries.map((e) => ({ ledger: e.ledger, amount: e.dr_cr === 'Dr' ? e.paise : -e.paise })));
const sigOfBook = (b) => signature(b.date, b.type, b.entries);

// Find a saved voucher in the book: by the identifier written into the file, else by date, type and lines.
export function matchInBook(book, saved) {
  const byId = book.find((b) => b.guid && saved.remote_id && b.guid.toLowerCase().includes(saved.remote_id.toLowerCase()));
  if (byId) return { hit: byId, how: 'identifier', exact: sigOfBook(byId) === sigOfSaved(saved) };
  const bySig = book.find((b) => sigOfBook(b) === sigOfSaved(saved));
  return bySig ? { hit: bySig, how: 'date, type and lines', exact: true } : null;
}

function loadBatch(ctx, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw new ToolError('unknown_batch', 'batch_id is not one build_import_xml issued.');
  const batch = ctx.store.readJson(`batches/${id}.json`);
  if (!batch) throw new ToolError('unknown_batch', `No saved batch ${id} on this computer.`);
  return batch;
}

async function companyOfBatch(ctx, batch) {
  const company = await ctx.useCompany(batch.company.name);
  if (company.guid !== batch.company.guid) {
    throw new ToolError('company_changed', `The company now loaded as "${batch.company.name}" is not the one this batch was built for.`);
  }
  return company;
}

const span = (vouchers) => ({
  from: vouchers.reduce((m, v) => (v.date < m ? v.date : m), vouchers[0].date),
  to: vouchers.reduce((m, v) => (v.date > m ? v.date : m), vouchers[0].date),
});
const showBook = (b) => ({
  date: b.date, voucher_type: b.type, voucher_number: b.number, narration: b.narration || undefined,
  entries: b.entries.map((e) => ({ ledger: e.ledger, dr_cr: e.amount >= 0 ? 'Dr' : 'Cr', amount: rupees(Math.abs(e.amount)) })),
});

const postsFor = (ctx, batchId, index) => ctx.store.readLines('posts.jsonl').filter((p) => p.batch_id === batchId && p.index === index);

export const importTools = [
  {
    name: 'voucher_schema',
    description: 'The voucher format build_import_xml accepts, with its rules. Answers without asking TallyPrime.',
    input: {},
    handler: async () => ({
      voucher: VOUCHER_SCHEMA,
      rules: [
        `Voucher types: ${TYPES.join(', ')}.`,
        'Every voucher needs at least two lines, and its debits must equal its credits.',
        'Amounts are positive rupees with at most two decimals; dr_cr says which side.',
        'Ledger names must match the book exactly. Check them with validate_masters first.',
        'A Contra uses only cash and bank ledgers. A Payment credits one; a Receipt debits one.',
        `A batch holds at most ${MAX_BATCH} vouchers.`,
        'Not supported: bill-wise allocations, cost centres, stock lines, GST details and foreign currency.',
      ],
      example: {
        type: 'Payment', date: '2026-04-05', narration: 'Office rent for April',
        entries: [{ ledger: 'Rent', dr_cr: 'Dr', amount: 25000 }, { ledger: 'HDFC Bank', dr_cr: 'Cr', amount: 25000 }],
      },
    }),
  },
  {
    name: 'validate_masters',
    description: 'Checks ledger names against the live book before you build an import file, and suggests the book\'s spelling where a name differs only in case or spacing.',
    input: { company: COMPANY, ledgers: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ledger names to check.' } },
    required: ['company', 'ledgers'],
    handler: async (args, ctx) => {
      if (!Array.isArray(args.ledgers) || !args.ledgers.length) throw new ToolError('bad_input', 'ledgers must be a list of names.');
      const groups = await loadGroups(ctx);
      const ledgers = await loadLedgers(ctx);
      const results = args.ledgers.map((raw) => {
        const name = String(raw).trim();
        const hit = ledgers.find((l) => l.name === name);
        if (hit) return { ledger: name, found: true, group: hit.parent, cash_or_bank: isUnder(groups, hit.parent, CASH_BANK_GROUPS) };
        const near = ledgers.filter((l) => norm(l.name) === norm(name)).map((l) => ({ ledger: l.name }));
        return { ledger: name, found: false, ...(near.length ? { did_you_mean: near } : {}) };
      });
      return { all_found: results.every((r) => r.found), results };
    },
  },
  {
    name: 'build_import_xml',
    description: 'Checks a batch of Journal, Payment, Receipt or Contra vouchers against the live book and writes a TallyPrime import file on this computer. It does not change the books: you import the file in TallyPrime yourself.',
    input: { company: COMPANY, vouchers: VOUCHERS_ARG },
    required: ['company', 'vouchers'],
    handler: async (args, ctx) => {
      const vouchers = normalizeVouchers(args.vouchers);
      const byName = await checkAgainstBook(ctx, vouchers);
      const id = randomBytes(6).toString('hex');
      const saved = vouchers.map((v, i) => ({
        ...v,
        remote_id: `minitallo-${id}-${String(i + 1).padStart(4, '0')}`,
        // Which master each ledger name pointed to when the file was built.
        ledger_guids: Object.fromEntries(v.entries.map((e) => [e.ledger, byName.get(e.ledger).guid])),
      }));
      const xml = envelope(ctx.company.name, saved.map((v) => voucherXml(v, v.remote_id)));
      const xmlPath = ctx.store.writeText(`batches/${id}.xml`, xml);
      const total = saved.reduce((s, v) => s + v.entries.reduce((t, e) => t + (e.dr_cr === 'Dr' ? e.paise : 0), 0), 0);
      ctx.store.writeJson(`batches/${id}.json`, { id, built: new Date().toISOString(), company: ctx.company, xml_sha256: sha(xml), vouchers: saved });
      ctx.store.append('ledger.jsonl', { ts: new Date().toISOString(), event: 'built', batch_id: id, company_guid: ctx.company.guid, vouchers: saved.length, xml_sha256: sha(xml) });
      return {
        batch_id: id, file: xmlPath, voucher_count: saved.length, total_debits: rupees(total),
        next: 'In TallyPrime: Import > Transactions, choose this file, then run verify_import with this batch_id to read the vouchers back.',
      };
    },
  },
  {
    name: 'verify_import',
    description: 'Reads back a batch you imported by hand in TallyPrime and says, voucher by voucher, whether it is in the book as built. Writes a proof file and a status record on this computer.',
    input: { batch_id: { type: 'string', description: 'The batch_id build_import_xml returned.' } },
    required: ['batch_id'],
    handler: async (args, ctx) => {
      const batch = loadBatch(ctx, args.batch_id);
      await companyOfBatch(ctx, batch);
      const book = await loadVouchers(ctx, span(batch.vouchers));
      const results = batch.vouchers.map((v, i) => {
        const m = matchInBook(book, v);
        if (!m) return { voucher: i, status: 'not_found' };
        return { voucher: i, status: m.exact ? 'found_as_built' : 'found_but_different', matched_by: m.how, voucher_number: m.hit.number, ...(m.exact ? {} : { in_book: showBook(m.hit) }) };
      });
      const count = (s) => results.filter((r) => r.status === s).length;
      const summary = { found_as_built: count('found_as_built'), found_but_different: count('found_but_different'), not_found: count('not_found') };
      const ts = new Date().toISOString();
      const proof = ctx.store.writeJson(`proofs/${batch.id}-${ts.replace(/[:.]/g, '')}.json`, {
        batch_id: batch.id, checked: ts, company_guid: batch.company.guid, xml_sha256: batch.xml_sha256, summary,
        vouchers: results.map((r, i) => ({ voucher: i, status: r.status, built_fingerprint: sha(sigOfSaved(batch.vouchers[i])) })),
      });
      ctx.store.append('ledger.jsonl', { ts, event: 'verified', batch_id: batch.id, company_guid: batch.company.guid, ...summary });
      return { batch_id: batch.id, summary, results, proof_file: proof };
    },
  },
  {
    name: 'voucher_presence',
    description: 'Which proposed vouchers are already in the book, so you do not enter them twice. Give either vouchers in the build_import_xml format, or a proposals_id from parse_bank_statement with the bank ledger.',
    input: {
      company: COMPANY,
      vouchers: { ...VOUCHERS_ARG, description: 'Vouchers in the voucher_schema format.' },
      proposals_id: { type: 'string', description: 'From parse_bank_statement.' },
      bank_ledger: { type: 'string', description: 'With proposals_id: the bank ledger the statement belongs to.' },
    },
    required: ['company'],
    handler: async (args, ctx) => {
      if (args.proposals_id) {
        if (!args.bank_ledger) throw new ToolError('bad_input', 'bank_ledger is needed with proposals_id.');
        if (!/^[a-f0-9]{12}$/.test(args.proposals_id)) throw new ToolError('unknown_proposals', 'proposals_id is not one parse_bank_statement issued.');
        const saved = ctx.store.readJson(`proposals/${args.proposals_id}.json`);
        if (!saved) throw new ToolError('unknown_proposals', 'No saved proposals with that id on this computer.');
        const rows = saved.transactions.filter((t) => t.direction);
        if (!rows.length) return { checked: 0, present: 0, absent: 0, results: [] };
        const book = await loadVouchers(ctx, span(rows));
        const used = new Set();
        const results = rows.map((t) => {
          const want = t.direction === 'deposit' ? t.paise : -t.paise;
          const idx = book.findIndex((b, k) => !used.has(k) && b.date === t.date && b.entries.some((e) => e.ledger === args.bank_ledger && e.amount === want));
          if (idx >= 0) used.add(idx);
          return { proposal: t.index, date: t.date, amount: rupees(t.paise), present: idx >= 0, ...(idx >= 0 ? { voucher_type: book[idx].type, voucher_number: book[idx].number } : {}) };
        });
        const present = results.filter((r) => r.present).length;
        return { matched_on: 'date, bank ledger and amount', checked: results.length, present, absent: results.length - present, results };
      }
      const vouchers = normalizeVouchers(args.vouchers);
      const book = await loadVouchers(ctx, span(vouchers));
      const results = vouchers.map((v, i) => {
        const m = matchInBook(book, v);
        return { voucher: i, date: v.date, present: !!m, ...(m ? { voucher_number: m.hit.number } : {}) };
      });
      const present = results.filter((r) => r.present).length;
      return { matched_on: 'date, voucher type and every line', checked: results.length, present, absent: results.length - present, results };
    },
  },
];

// Listed only when posting is turned on in the settings.
export const postingTools = [
  {
    name: 'post_import',
    description: 'Posts one saved voucher from a built batch into TallyPrime, after the person at this computer approves it in a separate Mini Tallo window. The assistant cannot approve it. The voucher is read back afterwards.',
    input: { batch_id: { type: 'string' }, voucher: { type: 'integer', description: 'Position of the voucher in the batch, counting from 0.' } },
    required: ['batch_id', 'voucher'],
    handler: async (args, ctx) => {
      const batch = loadBatch(ctx, args.batch_id);
      const index = Number(args.voucher);
      const v = batch.vouchers[index];
      if (!Number.isInteger(index) || !v) throw new ToolError('unknown_voucher', `Batch ${batch.id} has vouchers 0 to ${batch.vouchers.length - 1}.`);
      if (postsFor(ctx, batch.id, index).some((p) => p.event === 'posted')) throw new ToolError('already_posted', 'Mini Tallo already posted this voucher.');
      await companyOfBatch(ctx, batch);
      await checkAgainstBook(ctx, [v]);
      const day = { from: v.date, to: v.date };
      if (matchInBook(await loadVouchers(ctx, day), v)) throw new ToolError('already_present', 'A voucher matching this one is already in the book.');

      const answer = await ctx.ask({
        kind: 'approve',
        title: 'Post this voucher to TallyPrime?',
        intro: 'Mini Tallo cannot undo a posted voucher. If it is wrong, you correct it in TallyPrime.',
        rows: [
          ['Company', batch.company.name], ['Voucher type', v.type], ['Date', v.date],
          ...v.entries.map((e) => [`${e.dr_cr}  ${e.ledger}`, (e.paise / 100).toFixed(2)]),
          ['Narration', v.narration || '(none)'],
        ],
      });
      if (!answer?.ok || !answer.token || ctx.usedTokens.has(answer.token)) {
        throw new ToolError('not_approved', `The voucher was not posted: ${answer?.reason === 'timed_out' ? 'the approval window was not answered in time' : answer?.reason === 'window_failed' ? 'the approval window could not be opened' : 'it was not approved in the Mini Tallo window'}.`);
      }
      ctx.usedTokens.add(answer.token);

      // The company and its ledgers are checked again at the last moment before sending.
      ctx.forgetCompanies();
      await companyOfBatch(ctx, batch);
      const now = await checkAgainstBook(ctx, [v]);
      const res = await ctx.tally.importData(envelope(batch.company.name, [voucherXml(v, v.remote_id)]));
      const ts = new Date().toISOString();
      if (res.created !== 1 || res.errors) {
        ctx.store.append('posts.jsonl', { ts, event: 'refused_by_tally', batch_id: batch.id, index, company_guid: batch.company.guid, response_fp: res.fp });
        throw new ToolError('tally_refused', `TallyPrime did not create the voucher${res.line_errors.length ? `: ${res.line_errors.join('; ')}` : '.'}`);
      }
      const m = matchInBook(await loadVouchers(ctx, day), v);
      const moved = v.entries.map((e) => e.ledger).filter((name) => v.ledger_guids?.[name] && now.get(name)?.guid !== v.ledger_guids[name]);
      const review = !m || !m.exact || moved.length > 0;
      ctx.store.append('posts.jsonl', { ts, event: 'posted', batch_id: batch.id, index, company_guid: batch.company.guid, response_fp: res.fp, read_back: m ? (m.exact ? 'as_built' : 'different') : 'not_found', review_required: review });
      return {
        posted: true, batch_id: batch.id, voucher: index,
        read_back: m ? showBook(m.hit) : null,
        read_back_matches_what_was_approved: !!m?.exact,
        ...(moved.length ? { ledgers_now_pointing_to_a_different_master: moved.map((ledger) => ({ ledger })) } : {}),
        ...(review ? { review_required: true, next: 'Ask the person to check this voucher in TallyPrime, then call acknowledge_post_review.' } : {}),
      };
    },
  },
  {
    name: 'acknowledge_post_review',
    description: 'Asks the person, in a separate Mini Tallo window, to record that they reviewed a posted voucher that was flagged for review (for example because a ledger now points to a different master).',
    input: { batch_id: { type: 'string' }, voucher: { type: 'integer' } },
    required: ['batch_id', 'voucher'],
    handler: async (args, ctx) => {
      const batch = loadBatch(ctx, args.batch_id);
      const index = Number(args.voucher);
      const posts = postsFor(ctx, batch.id, index);
      const post = posts.find((p) => p.event === 'posted');
      if (!post) throw new ToolError('not_posted', 'Mini Tallo has not posted that voucher.');
      if (!post.review_required) throw new ToolError('no_review_needed', 'That voucher was not flagged for review.');
      if (posts.some((p) => p.event === 'review_acknowledged')) return { acknowledged: true, already: true };
      const v = batch.vouchers[index];
      const answer = await ctx.ask({
        kind: 'acknowledge',
        title: 'Have you reviewed this posted voucher?',
        intro: 'What landed in TallyPrime may differ from what you approved. Open the voucher in TallyPrime, check it, and confirm here.',
        rows: [['Company', batch.company.name], ['Voucher type', v.type], ['Date', v.date], ...v.entries.map((e) => [`${e.dr_cr}  ${e.ledger}`, (e.paise / 100).toFixed(2)])],
      });
      if (!answer?.ok || !answer.token || ctx.usedTokens.has(answer.token)) throw new ToolError('not_acknowledged', 'The review was not confirmed in the Mini Tallo window.');
      ctx.usedTokens.add(answer.token);
      ctx.store.append('posts.jsonl', { ts: new Date().toISOString(), event: 'review_acknowledged', batch_id: batch.id, index, company_guid: batch.company.guid });
      return { acknowledged: true };
    },
  },
];
