import { ToolError, sha, toTallyDate, fromTallyDate } from './util.js';
import { parseXml, find, findAll, text, esc } from './xml.js';

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim();

// Client for TallyPrime's own XML gateway on this computer.
export class Tally {
  constructor({ host = '127.0.0.1', port = 9000, timeoutMs = 60000 } = {}) {
    this.url = `http://${host}:${port}`;
    this.timeoutMs = timeoutMs;
  }

  async post(xml) {
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        body: xml,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError';
      throw new ToolError(
        timedOut ? 'tally_timeout' : 'tally_unreachable',
        timedOut
          ? 'TallyPrime did not answer in time. A large period can take long; try a shorter one.'
          : `TallyPrime's gateway did not answer at ${this.url}. Open TallyPrime, load a company, and check that it is set to act as a server on this port.`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Tally answers in UTF-16 when asked that way; detect it instead of trusting the header.
    const utf16 = buf.length > 3 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[1] === 0 && buf[3] === 0));
    return buf.toString(utf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '');
  }

  // Export a TDL collection defined inline in the request. Returns the object nodes
  // and a fingerprint of the raw response.
  async collection({ id, type, fetch: fields = [], compute = {}, childOf, belongsTo, filter, company, from, to }) {
    const statics = [
      '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
      company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : '',
      from ? `<SVFROMDATE TYPE="Date">${toTallyDate(from)}</SVFROMDATE>` : '',
      to ? `<SVTODATE TYPE="Date">${toTallyDate(to)}</SVTODATE>` : '',
    ].join('');
    const body = [
      `<TYPE>${esc(type)}</TYPE>`,
      childOf ? `<CHILDOF>${esc(childOf)}</CHILDOF>` : '',
      belongsTo ? '<BELONGSTO>Yes</BELONGSTO>' : '',
      fields.length ? `<FETCH>${esc(fields.join(', '))}</FETCH>` : '',
      ...Object.entries(compute).map(([k, v]) => `<COMPUTE>${esc(k)} : ${esc(v)}</COMPUTE>`),
      filter ? `<FILTER>${esc(id.replace(/\s+/g, ''))}Filter</FILTER>` : '',
    ].join('');
    const formula = filter
      ? `<SYSTEM TYPE="Formulae" NAME="${esc(id.replace(/\s+/g, ''))}Filter">${esc(filter)}</SYSTEM>`
      : '';
    const xml =
      `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${esc(id)}</ID></HEADER>` +
      `<BODY><DESC><STATICVARIABLES>${statics}</STATICVARIABLES><TDL><TDLMESSAGE>` +
      `<COLLECTION NAME="${esc(id)}" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">${body}</COLLECTION>${formula}` +
      `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const raw = await this.post(xml);
    const root = parseXml(raw);
    const coll = find(root, 'COLLECTION');
    if (!coll) {
      const err = find(root, 'LINEERROR') || find(root, 'RESPONSE');
      throw new ToolError('tally_error', `TallyPrime did not return the data asked for${err?.text.trim() ? `: ${clean(err.text)}` : '.'}`);
    }
    return { nodes: coll.children.filter((c) => c.name !== 'CMPINFO'), fp: sha(raw) };
  }

  async companies() {
    const { nodes, fp } = await this.collection({
      id: 'MT Companies',
      type: 'Company',
      fetch: ['Name', 'GUID', 'BooksFrom', 'StartingFrom'],
    });
    const list = nodes.map((n) => ({
      name: clean(n.attrs.NAME ?? text(n, 'NAME')),
      guid: clean(text(n, 'GUID')),
      books_from: fromTallyDate(text(n, 'BOOKSFROM') || text(n, 'STARTINGFROM')),
    }));
    return { list: list.filter((c) => c.name), fp };
  }

  // Send an import envelope and read Tally's count of what it created.
  async importData(xml) {
    const raw = await this.post(xml);
    const root = parseXml(raw);
    const num = (name) => {
      const n = find(root, name);
      return n ? Number(n.text.trim()) || 0 : 0;
    };
    return {
      created: num('CREATED'),
      altered: num('ALTERED'),
      deleted: num('DELETED'),
      errors: num('ERRORS'),
      exceptions: num('EXCEPTIONS'),
      line_errors: findAll(root, (n) => n.name === 'LINEERROR').map((n) => clean(n.text)),
      fp: sha(raw),
    };
  }
}
