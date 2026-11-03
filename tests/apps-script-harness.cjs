const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function harness(options = {}) {
  let now = Date.parse(options.now || '2026-11-03T13:00:00Z');
  const NativeDate = Date;
  class Clock extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const metrics = { reads: 0, writes: 0, flushes: 0 };
  class Range {
    constructor(sheet, row, col, height = 1, width = 1) { Object.assign(this, { sheet, row, col, height, width }); }
    getValues() {
      metrics.reads++;
      return Array.from({ length: this.height }, (_, r) => Array.from({ length: this.width }, (_, c) => this.sheet.rows[this.row - 1 + r]?.[this.col - 1 + c] ?? ''));
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(values) {
      if (values.length !== this.height || values.some(v => v.length !== this.width)) throw Error('Range size mismatch');
      metrics.writes++;
      values.forEach((values, r) => {
        const target = this.sheet.rows[this.row - 1 + r] ||= [];
        values.forEach((value, c) => { target[this.col - 1 + c] = value; });
      });
      return this;
    }
    setValue(value) { return this.setValues([[value]]); }
    setNumberFormat() { return this; }
    setBackground() { return this; }
    setFontColor() { return this; }
    setFontWeight() { return this; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; this.maxRows = 1000; this.maxColumns = 26; }
    getName() { return this.name; }
    getLastRow() { return this.rows.length; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxColumns; }
    insertColumnsAfter(_, count) { this.maxColumns += count; }
    insertRowsAfter(_, count) { this.maxRows += count; }
    getRange(...args) { return new Range(this, ...args); }
    setFrozenRows() {}
    setTabColor() {}
    setColumnWidths() {}
  }
  const sheets = [];
  const spreadsheet = {
    getSheets: () => sheets,
    getSheetByName: name => sheets.find(s => s.name === name) || null,
    insertSheet: name => { if (sheets.some(s => s.name === name)) throw Error('Duplicate sheet'); const sheet = new Sheet(name); sheets.push(sheet); return sheet; },
    setSpreadsheetTimeZone() {}, setSpreadsheetLocale() {}
  };
  const props = new Map();
  const cache = new Map();
  const messages = [];
  let busy = false;
  const context = vm.createContext({
    console: { log() {}, error: console.error }, Date: Clock,
    SpreadsheetApp: { openById: id => { if (id !== '1DTTKbIhHpOysjDimQZ1FT8noTmbsrX1HWznochJf14w') throw Error('Wrong spreadsheet'); return spreadsheet; }, flush: () => metrics.flushes++ },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key) ?? null, setProperty: (key, value) => props.set(key, value), setProperties: obj => Object.entries(obj).forEach(([k, v]) => props.set(k, v)) }) },
    CacheService: { getScriptCache: () => ({ get: key => { const v = cache.get(key); return v && v.expires > now ? v.value : null; }, put: (key, value, seconds) => { cache.set(key, { value, expires: now + seconds * 1000 }); }, remove: key => cache.delete(key) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (busy) return false; busy = true; return true; }, releaseLock: () => { busy = false; } }) },
    Utilities: {
      getUuid: crypto.randomUUID, DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algo, value) => [...crypto.createHash(algo).update(value).digest()],
      formatDate: (value, timezone, pattern) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
        return `${parts.year}-${parts.month}-${parts.day}` + (pattern.includes('HH') ? ` ${parts.hour}:${parts.minute}:${parts.second}` : '');
      }
    },
    MailApp: { getRemainingDailyQuota: () => options.mailFails ? 0 : 100, sendEmail: data => messages.push(data) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ value, setMimeType() { return this; } }) }
  });
  let source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  if (options.maxRows) source = source.replace('const MAX_ROWS_PER_SHEET = 50000;', `const MAX_ROWS_PER_SHEET = ${options.maxRows};`);
  vm.runInContext(source, context, { filename: 'Code.gs' });
  return {
    context, sheets, spreadsheet, metrics, props, messages,
    advance: ms => { now += ms; }, setTime: date => { now = Date.parse(date); },
    call: (action, data = {}) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action, ...data }) } }).value),
    setup: () => context.prepararSistema(),
    rows: base => sheets.filter(s => s.name === base || new RegExp(`^${base}_\\d+$`).test(s.name)).flatMap(s => s.rows.slice(1))
  };
}
module.exports = { harness };
