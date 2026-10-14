import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NAME } from './config.js';

const escH = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openInBrowser(url) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  const child =
    process.platform === 'win32'
      ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], opts)
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts);
  child.on('error', () => {});
  child.unref();
}

function page({ kind, title, intro, rows, token }) {
  const table = rows.length
    ? `<table>${rows.map(([k, v]) => `<tr><th>${escH(k)}</th><td>${escH(v)}</td></tr>`).join('')}</table>`
    : '';
  const field = kind === 'password' ? '<p><input type="password" name="password" autofocus placeholder="Statement password"></p>' : '';
  const yes = kind === 'password' ? 'Open the statement' : kind === 'acknowledge' ? 'I have reviewed it' : 'Approve and post';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escH(NAME)}: ${escH(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1c1c1c;background:#fafafa}
h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:16px 0;background:#fff}th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top}
th{width:32%;background:#f0f0f0;font-weight:600}button{font:inherit;padding:8px 18px;margin-right:12px;cursor:pointer}
input{font:inherit;padding:6px 10px;width:60%}.yes{background:#0b6b3a;color:#fff;border:0;border-radius:4px}.no{background:#fff;border:1px solid #888;border-radius:4px}</style></head>
<body><h1>${escH(title)}</h1><p>${escH(intro)}</p>${table}
<form method="post"><input type="hidden" name="token" value="${token}">${field}
<button class="yes" name="decision" value="yes">${yes}</button><button class="no" name="decision" value="no">Cancel</button></form>
<p><small>This window belongs to ${escH(NAME)} and runs only on this computer. The assistant cannot press these buttons.</small></p></body></html>`;
}

// Ask the person at this computer, in a window the assistant has no way to reach.
// The page address carries a secret that is handed only to the browser, and the
// answer counts only when the form returns the one-time token minted for it.
export function askLocally({ kind = 'approve', title, intro = '', rows = [], timeoutMs = 300000, open = openInBrowser }) {
  return new Promise((resolve) => {
    const secret = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      resolve(result);
    };
    const reply = (res, code, html) => {
      res.writeHead(code, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(html);
    };
    const server = http.createServer((req, res) => {
      const port = server.address()?.port;
      if (req.headers.host !== `127.0.0.1:${port}` || req.url !== `/${secret}`) return reply(res, 404, 'Not found');
      if (req.method === 'GET') return reply(res, 200, page({ kind, title, intro, rows, token }));
      if (req.method !== 'POST') return reply(res, 405, 'Not allowed');
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}`) return reply(res, 403, 'Forbidden');
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('token') !== token) return reply(res, 403, 'Forbidden');
        const ok = form.get('decision') === 'yes';
        reply(res, 200, `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:40px">${ok ? 'Recorded.' : 'Cancelled.'} You can close this window.</body>`);
        finish(ok ? { ok: true, token, password: form.get('password') ?? undefined } : { ok: false, reason: 'declined' });
      });
    });
    const timer = setTimeout(() => finish({ ok: false, reason: 'timed_out' }), timeoutMs);
    server.on('error', () => finish({ ok: false, reason: 'window_failed' }));
    server.listen(0, '127.0.0.1', () => {
      try {
        Promise.resolve(open(`http://127.0.0.1:${server.address().port}/${secret}`)).catch(() => finish({ ok: false, reason: 'window_failed' }));
      } catch {
        finish({ ok: false, reason: 'window_failed' });
      }
    });
  });
}
