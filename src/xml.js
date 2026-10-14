// A small XML reader for Tally's responses. Tally emits character references for
// control characters (for example &#4; in front of "Primary") that strict parsers
// reject, so those are dropped before reading.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, c) => {
    if (c[0] === '#') {
      const n = c[1] === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
      if (!Number.isFinite(n) || (n < 32 && n !== 9 && n !== 10 && n !== 13)) return '';
      try { return String.fromCodePoint(n); } catch { return ''; }
    }
    return ENT[c] ?? m;
  });
}

export function parseXml(src) {
  const root = { name: '#ROOT', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s>\/]+)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      const name = m[2].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
    } else if (m[3] !== undefined) {
      const node = { name: m[3].toUpperCase(), attrs: {}, children: [], text: '' };
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) node.attrs[a[1].toUpperCase()] = decode(a[2] ?? a[3] ?? '');
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root;
}

export const children = (node, name) => node.children.filter((c) => c.name === name);
export const child = (node, name) => node.children.find((c) => c.name === name);
// Text of a direct child, or null when the child is absent.
export const text = (node, name) => {
  const c = child(node, name);
  return c ? c.text.trim() : null;
};

export function find(node, name) {
  for (const c of node.children) {
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return null;
}

export function findAll(node, pred, out = []) {
  for (const c of node.children) {
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}

export const esc = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
