#!/usr/bin/env node
// A local web dashboard over the same read-only tools the assistant uses.
// It listens on this computer only and shows the books in your browser.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NAME, VERSION, TERMS_VERSION, loadConfig } from './config.js';
import { Tally } from './tally.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { openInBrowser } from './approval.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/app.js': ['dashboard/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['dashboard/style.css', 'text/css; charset=utf-8'],
};
// The dashboard reads; building import files and posting stay with the assistant tools.
const ALLOWED = new Set([
  'tally_status', 'list_companies', 'trial_balance', 'ledger_movement', 'ledger_masters', 'masters', 'vouchers',
  'sales_register', 'purchase_register', 'outstandings', 'stock_summary', 'balance_sheet', 'profit_and_loss',
  'cash_flow', 'local_data_report', 'egress_log', 'dashboard_summary', 'edit_list_masters', 'save_master', 'delete_master', 'save_voucher', 'delete_voucher',
]);
// These change the books, and answer only while editing is switched on in the page.
const WRITES = new Set(['save_master', 'delete_master', 'save_voucher', 'delete_voucher']);

const today = () => new Date().toISOString().slice(0, 10);
// The Indian financial year that holds today, up to today.
function defaultPeriod() {
  const t = today();
  const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0);
  return { from: `${y}-04-01`, to: t };
}

export async function startDashboard({ demo = false, port = 8787, open = true, env = process.env } = {}) {
  let mock = null;
  const e = { ...env, MINI_TALLO_REDACT: 'none', MINI_TALLO_POSTING: '' };
  if (demo) {
    const { startMockTally } = await import(pathToFileURL(join(HERE, '..', 'test', 'mock-tally.js')));
    mock = await startMockTally();
    e.MINI_TALLO_PORT = String(mock.port);
  }
  const config = loadConfig(e);
  const store = new Store(demo ? join(config.dataDir, 'demo') : config.dataDir);
  // Terms accepted on the dashboard are remembered in the data folder.
  if (store.readJson('terms.json')?.version === TERMS_VERSION) config.termsAccepted = true;
  config.editing = true;
  const app = createApp({ config, tally: new Tally(config), store });
  let editing = false; // off at every start; the person turns it on in the page
  const token = randomBytes(24).toString('hex');

  const send = (res, code, type, body) => {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  };
  const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

  const server = http.createServer((req, res) => {
    const addr = `127.0.0.1:${server.address().port}`;
    // Only this computer's own browser, on this address, is answered.
    if (req.headers.host !== addr && req.headers.host !== `localhost:${server.address().port}`) return send(res, 403, 'text/plain', 'Forbidden');
    const path = new URL(req.url, `http://${addr}`).pathname;
    if (req.method === 'GET') {
      if (path === '/') return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(HERE, 'dashboard/index.html'), 'utf8').replace('__TOKEN__', token));
      if (STATIC[path]) return send(res, 200, STATIC[path][1], readFileSync(join(HERE, STATIC[path][0])));
      if (path === '/terms') return send(res, 200, 'text/plain; charset=utf-8', readFileSync(join(HERE, '..', 'TERMS.md')));
      return send(res, 404, 'text/plain', 'Not found');
    }
    if (req.method !== 'POST' || !path.startsWith('/api/')) return send(res, 405, 'text/plain', 'Not allowed');
    // The page carries a token no other site can read, so no other site can ask for the books.
    if (req.headers['x-mini-tallo'] !== token) return json(res, 403, { error: 'forbidden', message: 'Reload the dashboard page.' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad_request', message: 'Not JSON.' }); }
      if (path === '/api/info') {
        return json(res, 200, {
          name: NAME, version: VERSION, demo, editing, terms_version: TERMS_VERSION, terms_accepted: config.termsAccepted,
          gateway: `${config.host}:${config.port}`, data_folder: store.dir,
          period: demo ? { from: '2025-04-01', to: '2025-06-30' } : defaultPeriod(),
        });
      }
      if (path === '/api/accept-terms') {
        store.writeJson('terms.json', { version: TERMS_VERSION, accepted: new Date().toISOString() });
        config.termsAccepted = true;
        return json(res, 200, { terms_accepted: true });
      }
      if (path === '/api/editing') {
        editing = msg.on === true;
        store.append('ledger.jsonl', { ts: new Date().toISOString(), event: editing ? 'editing_on' : 'editing_off' });
        return json(res, 200, { editing });
      }
      if (path === '/api/call') {
        if (!ALLOWED.has(msg.tool)) return json(res, 400, { error: 'not_on_dashboard', message: 'That tool is not available on the dashboard.' });
        if (WRITES.has(msg.tool) && !editing) return json(res, 200, { error: 'editing_off', message: 'Turn on "Allow editing" at the top of the page first.' });
        const r = await app.callTool(msg.tool, msg.args ?? {});
        return json(res, 200, JSON.parse(r.content[0].text));
      }
      return json(res, 404, { error: 'not_found', message: 'No such endpoint.' });
    });
  });

  // If the port is taken, try the next few.
  const listening = await new Promise((resolveListen, reject) => {
    let p = port, tries = 0;
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0 && tries++ < 10) server.listen(++p, '127.0.0.1');
      else reject(err);
    });
    server.on('listening', () => resolveListen(server.address().port));
    server.listen(p, '127.0.0.1');
  });
  const url = `http://127.0.0.1:${listening}/`;
  if (open) openInBrowser(url);
  return {
    url, token, demo,
    close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await mock?.close(); },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  try {
    const d = await startDashboard({ demo, open: !process.argv.includes('--no-open'), port: Number(process.env.MINI_TALLO_DASHBOARD_PORT || 8787) });
    console.log(`${NAME} dashboard: ${d.url}${demo ? '  (demo data, not your books)' : ''}`);
    console.log('Press Ctrl+C to stop.');
  } catch (err) {
    console.error(`${NAME}: ${err.message}`);
    process.exit(1);
  }
}
