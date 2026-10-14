import { homedir } from 'node:os';
import { join } from 'node:path';

export const NAME = 'Mini Tallo';
export const VERSION = '0.1.0';
export const TERMS_VERSION = '2026-10.2';

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

export function loadConfig(env = process.env) {
  const host = String(env.MINI_TALLO_HOST || '127.0.0.1').trim().toLowerCase();
  // Loopback only. "localhost" is pinned to 127.0.0.1 so a hosts-file entry cannot redirect it.
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`${NAME} only connects to TallyPrime on this computer; "${host}" is not a loopback address.`);
  }
  const port = Number(env.MINI_TALLO_PORT || 9000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MINI_TALLO_PORT must be a port number.');
  const redact = String(env.MINI_TALLO_REDACT || 'none').trim().toLowerCase();
  if (!['none', 'names', 'narrations'].includes(redact)) {
    throw new Error('MINI_TALLO_REDACT must be one of: none, names, narrations.');
  }
  const accepted = String(env.MINI_TALLO_TERMS_ACCEPTED ?? '').trim();
  return {
    host: host.includes(':') ? '[::1]' : '127.0.0.1',
    port,
    redact,
    termsAccepted: truthy(accepted) || accepted === TERMS_VERSION,
    posting: truthy(env.MINI_TALLO_POSTING),
    timeoutMs: Number(env.MINI_TALLO_TIMEOUT_MS || 60000),
    dataDir:
      env.MINI_TALLO_DATA_DIR ||
      (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'MiniTallo') : join(homedir(), '.mini-tallo')),
  };
}
