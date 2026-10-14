import { NAME, TERMS_VERSION } from './config.js';
import { ToolError, sha, norm } from './util.js';
import { askLocally } from './approval.js';
import { readTools } from './tools/reads.js';
import { statementTools } from './tools/statements.js';
import { importTools, postingTools } from './tools/imports.js';
import { bankTools } from './tools/bank.js';
import { localTools } from './tools/local.js';
import { editTools } from './tools/edits.js';
import { summaryTools } from './tools/summary.js';

const NAME_KEYS = new Set(['ledger', 'party', 'bank_ledger', 'other_ledger', 'bank_account_number']);
const mask = (s) => (s.length <= 4 ? '…' : `${s.slice(0, 2)}…${s.slice(-2)}`);

// The privacy setting takes one value: shorten names, or drop narrations.
export function redact(value, mode) {
  if (mode === 'none') return value;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (mode === 'names' && NAME_KEYS.has(k) && typeof x === 'string') out[k] = mask(x);
      else if (mode === 'narrations' && k === 'narration') continue;
      else out[k] = walk(x);
    }
    return out;
  };
  return walk(value);
}

export function createApp({ config, tally, store, ask = askLocally }) {
  const tools = [...readTools, ...statementTools, ...importTools, ...bankTools, ...localTools, ...(config.posting ? postingTools : []),
    // These exist only for the dashboard, which sets this itself; the assistant never gets them.
    ...(config.editing ? [...editTools, ...summaryTools] : [])]
    .sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const usedTokens = new Set();
  let companyCache = null;

  function makeCtx(toolName) {
    const ctx = {
      tally, store, config, ask, usedTokens,
      company: null,
      forgetCompanies: () => { companyCache = null; },
      async companies() {
        if (!companyCache) {
          const { list, fp } = await tally.companies();
          store.append('evidence.jsonl', { ts: new Date().toISOString(), tool: toolName, query: 'MT Companies', response_fp: fp });
          companyCache = list;
        }
        return companyCache;
      },
      // Pin the call to one loaded company, matched on its exact name.
      async useCompany(name) {
        if (typeof name !== 'string' || !name.trim()) throw new ToolError('company_required', 'Give the company name exactly as list_companies returns it.');
        companyCache = null;
        const list = await ctx.companies();
        const exact = list.filter((c) => c.name === name);
        if (exact.length > 1) throw new ToolError('company_ambiguous', `More than one loaded company is named "${name}".`);
        if (!exact.length) {
          const near = list.filter((c) => norm(c.name) === norm(name)).map((c) => c.name);
          throw new ToolError(near.length ? 'company_name_mismatch' : 'company_not_loaded',
            near.length ? `No loaded company is named exactly "${name}". Did you mean "${near[0]}"?` : `"${name}" is not loaded in TallyPrime.`);
        }
        ctx.company = { name: exact[0].name, guid: exact[0].guid };
        return ctx.company;
      },
      async read(id, spec) {
        if (!ctx.company) throw new ToolError('company_required', 'This tool needs a company.');
        const { nodes, fp } = await tally.collection({ ...spec, id, company: ctx.company.name });
        store.append('evidence.jsonl', { ts: new Date().toISOString(), tool: toolName, company_guid: ctx.company.guid, query: id, from: spec.from, to: spec.to, response_fp: fp });
        return nodes;
      },
    };
    return ctx;
  }

  return {
    listTools: () =>
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: t.input ?? {}, required: t.required ?? [], additionalProperties: false },
      })),

    // Every call ends in a receipt, whether it succeeds or is refused.
    async callTool(name, args = {}) {
      const ctx = makeCtx(name);
      let result, outcome = 'ok';
      try {
        if (!config.termsAccepted) {
          throw new ToolError('terms_not_accepted', `Accept the ${NAME} Terms of Use (version ${TERMS_VERSION}) in the extension's settings before using its tools.`);
        }
        const tool = byName.get(name);
        if (!tool) throw new ToolError('unknown_tool', `${NAME} has no tool named "${name}".`);
        if (tool.input?.company && (tool.required ?? []).includes('company')) await ctx.useCompany(args.company);
        result = redact(await tool.handler(args ?? {}, ctx), config.redact);
      } catch (e) {
        const known = e instanceof ToolError;
        outcome = known ? e.code : 'internal_error';
        result = { error: outcome, message: known ? e.message : `${NAME} hit an unexpected problem: ${e?.message ?? e}`, ...(known && e.extra ? redact(e.extra, config.redact) : {}) };
      }
      try {
        store.append('egress.jsonl', { ts: new Date().toISOString(), tool: name, company_guid: ctx.company?.guid ?? null, outcome, request_fp: sha(args), response_fp: sha(result) });
      } catch { /* a full disk must not turn an answer into a failure */ }
      return { isError: outcome !== 'ok', content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  };
}
