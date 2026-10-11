// In-memory stand-ins for the Google Apps Script services Code.gs uses.
// Lets the real backend code run under Node for tests and for a local preview server.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(d, tz, fmt) {
  // Only Asia/Kolkata (UTC+05:30) is used by Code.gs.
  const t = new Date(d.getTime() + 330 * 60000);
  const map = {
    yyyy: t.getUTCFullYear(), yy: String(t.getUTCFullYear()).slice(-2), MM: pad(t.getUTCMonth() + 1),
    dd: pad(t.getUTCDate()), HH: pad(t.getUTCHours()), mm: pad(t.getUTCMinutes()), ss: pad(t.getUTCSeconds())
  };
  return fmt.replace(/'([^']*)'/g, '\u0000$1\u0000').split('\u0000').map((part, i) =>
    i % 2 ? part : part.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, k => map[k])).join('');
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr: nr || 1, nc: nc || 1 }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r - 1 + i] || [];
      const o = [];
      for (let j = 0; j < this.nc; j++) o.push(row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j]);
      out.push(o);
    }
    return out;
  }
  getDisplayValues() { return this.getValues().map(r => r.map(v => String(v))); }
  setValues(v) { v.forEach((row, i) => row.forEach((x, j) => this.sheet.set(this.r + i, this.c + j, x))); return this; }
  setValue(x) { this.sheet.set(this.r, this.c, x); return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  static norm(v) { return typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v; }
  set(r, c, v) { while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = Sheet.norm(v); }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  appendRow(row) { this.data.push(row.map(Sheet.norm)); }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  setFrozenRows() {}
}

class Spreadsheet {
  constructor() { this.sheets = {}; }
  getName() { return 'NMMS Mock Spreadsheet'; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new Sheet(n)); }
}

function createEnv(opts = {}) {
  const ss = new Spreadsheet();
  const props = Object.assign({ SPREADSHEET_ID: 'mock-spreadsheet' }, opts.props || {});
  const cache = new Map();
  const files = new Map();
  let idSeq = 0;
  const mkBlob = (bytes, mime, name) => {
    const buf = Buffer.from(bytes);
    return { getBytes: () => buf, getContentType: () => mime, getName: () => name, _buf: buf };
  };
  const folder = id => ({
    getId: () => id,
    createFile: blob => {
      const fid = 'file' + (++idSeq);
      files.set(fid, { blob, trashed: false, folder: id });
      return { getId: () => fid };
    }
  });
  const ctx = {
    console: { log() {}, error() {} },
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    Utilities: {
      base64Decode: s => Array.from(Buffer.from(s, 'base64')),
      base64Encode: b => Buffer.from(b).toString('base64'),
      newBlob: mkBlob,
      getUuid: () => crypto.randomUUID(),
      formatDate,
      sleep() {}
    },
    DriveApp: {
      createFolder: () => folder('folder' + (++idSeq)),
      getFolderById: id => folder(id),
      getFileById: id => {
        const f = files.get(id);
        if (!f) throw new Error('No file ' + id);
        return { getBlob: () => f.blob, setTrashed: v => { f.trashed = v; } };
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: s => ({ content: s, setMimeType() { return this; }, getContent() { return s; } })
    }
  };
  vm.createContext(ctx);
  // Private.gs (seed list with mobile numbers, spreadsheet ID) is not in the public repository; load it when present.
  const priv = path.join(__dirname, '..', 'apps-script', 'Private.gs');
  if (fs.existsSync(priv)) vm.runInContext(fs.readFileSync(priv, 'utf8'), ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code + "\n;globalThis.__ = { doPost, doGet, setup, nmmsScore, ANSWER_KEY, SEED_PARTICIPANTS: typeof SEED_PARTICIPANTS !== 'undefined' ? SEED_PARTICIPANTS : [], HEADERS };", ctx);
  if (opts.now) vm.runInContext('now_ = function () { return new Date(' + JSON.stringify(opts.now) + '); };', ctx);
  const api = ctx.__;
  const call = (action, payload = {}) =>
    JSON.parse(api.doPost({ postData: { contents: JSON.stringify(Object.assign({ action }, payload)) } }).content);
  return {
    ctx, ss, props, files, cache, api, call,
    setNow: iso => vm.runInContext('now_ = function () { return new Date(' + JSON.stringify(iso) + '); };', ctx)
  };
}

module.exports = { createEnv, formatDate };
