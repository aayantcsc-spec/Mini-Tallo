const LIMIT = { type: 'integer', description: 'How many of the most recent lines. Default 50, at most 500.' };
const lim = (n) => Math.min(Math.max(Number(n) || 50, 1), 500);

const WHAT = [
  [/^egress\.jsonl$/, 'A receipt for every tool call: time, tool, company identifier, and fingerprints of what was asked and what came back. No figures.'],
  [/^evidence\.jsonl$/, 'A fingerprint of every answer read from TallyPrime. No figures.'],
  [/^ledger\.jsonl$/, 'A record of each import file built and each read-back.'],
  [/^posts\.jsonl$/, 'A record of each voucher posted and each review acknowledged.'],
  [/^terms\.json$/, 'A note that the Terms of Use were accepted on the dashboard, and when.'],
  [/^batches\/.*\.xml$/, 'An import file you can load in TallyPrime. Holds ledger names, amounts and narrations.'],
  [/^batches\/.*\.json$/, 'The vouchers of a built batch, kept so they can be read back. Holds ledger names, amounts and narrations.'],
  [/^proposals\/.*\.json$/, 'Transactions and balances read from a bank statement. Private; the balances are never returned to the assistant.'],
  [/^proofs\/.*\.json$/, 'The result of reading a batch back from TallyPrime, as fingerprints.'],
];

export const localTools = [
  {
    name: 'egress_log',
    description: 'The receipts Mini Tallo keeps of its own tool calls: time, tool, company identifier, outcome and fingerprints. No figures.',
    input: { limit: LIMIT },
    handler: async (args, ctx) => ({ receipts: ctx.store.readLines('egress.jsonl', lim(args.limit)) }),
  },
  {
    name: 'read_evidence',
    description: "Mini Tallo's own recent reads from TallyPrime, as fingerprints of each answer. No figures.",
    input: { limit: LIMIT },
    handler: async (args, ctx) => ({ reads: ctx.store.readLines('evidence.jsonl', lim(args.limit)) }),
  },
  {
    name: 'local_data_report',
    description: 'What Mini Tallo keeps on this computer: the folder, each file with its size, and what each kind of file holds.',
    input: {},
    handler: async (_args, ctx) => {
      const files = ctx.store.inventory().map((f) => ({ ...f, holds: WHAT.find(([re]) => re.test(f.file))?.[1] ?? 'Not a file Mini Tallo writes.' }));
      return {
        folder: ctx.store.dir, file_count: files.length, total_bytes: files.reduce((s, f) => s + f.bytes, 0), files,
        note: 'Nothing here is sent anywhere by Mini Tallo. To remove it, close Claude Desktop and delete the folder.',
      };
    },
  },
];
