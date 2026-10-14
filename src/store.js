import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Everything Mini Tallo keeps lives under one folder on this computer.
export class Store {
  constructor(dir) {
    this.dir = dir;
    for (const d of ['', 'batches', 'proposals', 'proofs']) mkdirSync(join(dir, d), { recursive: true });
  }

  path(...parts) {
    return join(this.dir, ...parts);
  }

  append(file, obj) {
    appendFileSync(this.path(file), JSON.stringify(obj) + '\n', { mode: 0o600 });
  }

  readLines(file, limit) {
    const p = this.path(file);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const picked = limit ? lines.slice(-limit) : lines;
    return picked.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  writeJson(rel, obj) {
    writeFileSync(this.path(rel), JSON.stringify(obj, null, 2), { mode: 0o600 });
    return this.path(rel);
  }

  writeText(rel, textValue) {
    writeFileSync(this.path(rel), textValue, { mode: 0o600 });
    return this.path(rel);
  }

  readJson(rel) {
    const p = this.path(rel);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }

  // Files kept, with sizes; no contents.
  inventory() {
    const out = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const st = statSync(p);
          out.push({ file: relative(this.dir, p).replaceAll('\\', '/'), bytes: st.size, modified: st.mtime.toISOString() });
        }
      }
    };
    walk(this.dir);
    return out;
  }
}
