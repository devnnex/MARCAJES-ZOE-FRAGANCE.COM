/**
 * Zoe Fragance — backend independiente, Google Apps Script V8.
 * Ejecutar prepararSistema() una vez y publicar como aplicación web.
 * No requiere librerías, activadores ni ejecutar funciones de marcaje manualmente.
 */
const SPREADSHEET_ID = '1DTTKbIhHpOysjDimQZ1FT8noTmbsrX1HWznochJf14w';
const TIME_ZONE = 'America/Bogota';
const VERSION = 'zoe-1.0.0';
const MAX_ROWS_PER_SHEET = 50000;
const HEADERS = {
  workers: ['id', 'name', 'phone', 'email', 'created_at', 'hourly_rate', 'archived_at'],
  time_logs: ['id', 'worker_id', 'start', 'end', 'hours', 'shift_type', 'shift_label', 'hourly_rate', 'earned', 'created_at', 'request_id', 'in_request_id'],
  liquidations: ['id', 'worker_id', 'hours_paid', 'amount_paid', 'liquidation_date', 'hourly_rate', 'included_logs', 'request_id', 'worker_name', 'worker_phone', 'worker_email', 'email_status'],
  settings: ['key', 'value']
};
let database_ = null;
let tables_ = {};

function db_() {
  if (!database_) database_ = SpreadsheetApp.openById(SPREADSHEET_ID);
  return database_;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(message, code) {
  const error = new Error(message);
  error.code = code || 'validation_error';
  throw error;
}

function withLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('Hay otra operación en curso. Intenta nuevamente.', 'busy');
  try { return callback(); } finally { lock.releaseLock(); }
}

function prepararSistema() {
  return withLock_(function () {
    const book = db_();
    book.setSpreadsheetTimeZone(TIME_ZONE);
    book.setSpreadsheetLocale('es_CO');
    Object.keys(HEADERS).forEach(function (base) {
      let sheets = sheets_(base);
      if (!sheets.length) sheets = [book.insertSheet(base)];
      sheets.forEach(function (sheet) {
        const headers = HEADERS[base];
        if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
        const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
        headers.forEach(function (header, i) {
          if (current[i] && current[i] !== header) fail_('La columna ' + (i + 1) + ' de ' + sheet.getName() + ' debe llamarse ' + header + '. No se modificaron sus datos.', 'schema_mismatch');
        });
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setBackground('#112d55').setFontColor('#ffffff').setFontWeight('bold');
        sheet.setFrozenRows(1);
        sheet.setTabColor('#3478db');
        sheet.setColumnWidths(1, headers.length, 160);
        const capacity = Math.max(1, sheet.getMaxRows() - 1);
        if (base === 'workers') {
          sheet.getRange(2, 3, capacity, 2).setNumberFormat('@');
          sheet.getRange(2, 5, capacity, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
          sheet.getRange(2, 6, capacity, 1).setNumberFormat('"$"#,##0');
        }
        if (base === 'time_logs') {
          sheet.getRange(2, 3, capacity, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
          sheet.getRange(2, 5, capacity, 1).setNumberFormat('0.00000000');
          sheet.getRange(2, 8, capacity, 2).setNumberFormat('"$"#,##0');
          sheet.getRange(2, 10, capacity, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
        }
        if (base === 'liquidations') {
          sheet.getRange(2, 3, capacity, 1).setNumberFormat('0.00000000');
          sheet.getRange(2, 4, capacity, 1).setNumberFormat('"$"#,##0');
          sheet.getRange(2, 5, capacity, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
        }
      });
    });
    tables_ = {};
    const settings = read_('settings');
    const defaults = { hour_rate: 0, company_name: 'Zoe Fragance', time_zone: TIME_ZONE, schema_version: VERSION };
    const missing = Object.keys(defaults).filter(function (key) { return !settings.some(function (r) { return r.values[0] === key; }); });
    if (missing.length) append_('settings', missing.map(function (key) { return [key, defaults[key]]; }));
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty('ZOE_PIN_HASH')) {
      const salt = Utilities.getUuid();
      props.setProperties({ ZOE_PIN_SALT: salt, ZOE_PIN_HASH: hash_(salt + ':5678') });
    }
    props.setProperty('ZOE_SCHEMA', VERSION);
    changed_();
    SpreadsheetApp.flush();
    const result = { ok: true, company: 'Zoe Fragance', spreadsheetId: SPREADSHEET_ID, sheets: Object.keys(HEADERS), message: 'Hojas listas. Configura la tarifa por hora desde la aplicación.' };
    console.log(JSON.stringify(result));
    return result;
  });
}

// Alias para quien prefiera seleccionar setup en el editor.
function setup() { return prepararSistema(); }

function ensure_() {
  if (PropertiesService.getScriptProperties().getProperty('ZOE_SCHEMA') !== VERSION) prepararSistema();
}

function doGet() {
  return json_({ ok: true, company: 'Zoe Fragance', version: VERSION, ready: PropertiesService.getScriptProperties().getProperty('ZOE_SCHEMA') === VERSION });
}

function doPost(e) {
  try {
    database_ = null;
    tables_ = {};
    ensure_();
    const d = JSON.parse(e && e.postData && e.postData.contents || '{}');
    const action = String(d.action || '');
    const handlers = {
      login: login_, logout: logout_, getTimeBootstrap: bootstrap_,
      getWorkers: workers_, getDashboard: dashboard_, getSettings: settings_,
      getTimeLogsByWorker: logs_, getLiquidations: liquidations_,
      addWorker: addWorker_, updateWorker: updateWorker_, deleteWorker: deleteWorker_,
      setRate: setRate_, setWorkerRate: setWorkerRate_, liquidateWorker: liquidate_,
      checkIn: function (data) { return attendance_(data, true, false); },
      checkOut: function (data) { return attendance_(data, false, false); },
      checkInBatch: function (data) { return attendance_(data, true, true); },
      checkOutBatch: function (data) { return attendance_(data, false, true); }
    };
    if (!Object.prototype.hasOwnProperty.call(handlers, action)) fail_('Acción no reconocida.', 'unknown_action');
    if (['getDashboard', 'getLiquidations', 'addWorker', 'updateWorker', 'deleteWorker', 'setRate', 'setWorkerRate', 'liquidateWorker'].indexOf(action) >= 0) authorize_(d);
    return json_(handlers[action](d));
  } catch (error) {
    return json_({ error: true, code: error.code || 'server_error', message: error.message || 'No se pudo completar la operación.' });
  }
}

function hash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function login_(d) {
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  const digest = hash_(props.getProperty('ZOE_PIN_SALT') + ':' + String(d.pin || ''));
  if (digest !== props.getProperty('ZOE_PIN_HASH')) fail_('PIN incorrecto.', 'invalid_pin');
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('zoe-session:' + hash_(token), 'admin', 21600);
  return { ok: true, token: token, expiresIn: 21600 };
}

function authorize_(d) {
  const token = String(d.token || '');
  if (!token || CacheService.getScriptCache().get('zoe-session:' + hash_(token)) !== 'admin') fail_('Ingresa el PIN de administrador para continuar.', 'unauthorized');
}

function logout_(d) {
  if (d.token) CacheService.getScriptCache().remove('zoe-session:' + hash_(d.token));
  return { ok: true };
}

function sheets_(base) {
  const pattern = new RegExp('^' + base + '(?:_([2-9]|[1-9][0-9]+))?$');
  return db_().getSheets().filter(function (s) { return pattern.test(s.getName()); }).sort(function (a, b) {
    return Number(a.getName().slice(base.length + 1) || 1) - Number(b.getName().slice(base.length + 1) || 1);
  });
}

function read_(base) {
  if (tables_[base]) return tables_[base];
  const rows = [];
  sheets_(base).forEach(function (sheet) {
    const last = sheet.getLastRow();
    if (last <= 1) return;
    sheet.getRange(2, 1, last - 1, HEADERS[base].length).getValues().forEach(function (values, index) {
      if (values[0] !== '') rows.push({ sheet: sheet, rowNumber: index + 2, values: values });
    });
  });
  tables_[base] = rows;
  return rows;
}

function append_(base, rows) {
  let remaining = rows.slice();
  while (remaining.length) {
    const existing = sheets_(base);
    let sheet = existing[existing.length - 1];
    if (!sheet || sheet.getLastRow() >= MAX_ROWS_PER_SHEET) {
      const next = existing.length ? Number(sheet.getName().slice(base.length + 1) || 1) + 1 : 1;
      sheet = db_().insertSheet(base + (next === 1 ? '' : '_' + next));
      sheet.getRange(1, 1, 1, HEADERS[base].length).setValues([HEADERS[base]]).setBackground('#112d55').setFontColor('#ffffff').setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    const nextRow = sheet.getLastRow() + 1;
    const chunk = remaining.splice(0, MAX_ROWS_PER_SHEET - nextRow + 1);
    if (sheet.getMaxRows() < nextRow + chunk.length - 1) sheet.insertRowsAfter(sheet.getMaxRows(), nextRow + chunk.length - 1 - sheet.getMaxRows());
    const padded = chunk.map(function (row) { return HEADERS[base].map(function (_, i) { return row[i] === undefined ? '' : row[i]; }); });
    sheet.getRange(nextRow, 1, padded.length, HEADERS[base].length).setValues(padded);
  }
  delete tables_[base];
}

function changed_() {
  // Una revisión distinta invalida las lecturas en caché sin enumerar claves.
  PropertiesService.getScriptProperties().setProperty('ZOE_REVISION', Utilities.getUuid());
}

function cached_(key, builder) {
  const revision = PropertiesService.getScriptProperties().getProperty('ZOE_REVISION') || '0';
  const cache = CacheService.getScriptCache();
  const cacheKey = 'zoe:' + revision + ':' + key;
  const saved = cache.get(cacheKey);
  if (saved) return JSON.parse(saved);
  const result = builder();
  const encoded = JSON.stringify(result);
  if (encoded.length < 20000) { try { cache.put(cacheKey, encoded, 8); } catch (_) {} }
  return result;
}

function id_(value) { return String(value || '').trim(); }
function number_(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function hours_(value) { return Math.round(value * 100000000) / 100000000; }
function money_(value) { return Math.round(value); }
function text_(value, max) {
  const text = String(value || '').trim();
  if (text.length > max) fail_('El texto supera el máximo de ' + max + ' caracteres.');
  // Evita que el contenido de formularios se ejecute como fórmula en Sheets.
  return /^[=+@-]/.test(text) ? "'" + text : text;
}
function request_(d) {
  const id = id_(d.requestId || d.operationId || d.request_id);
  if (!id || id.length > 200) fail_('Falta un identificador válido de operación.', 'missing_request_id');
  return id;
}

function settings_() {
  const settings = {};
  read_('settings').forEach(function (r) { settings[r.values[0]] = r.values[1]; });
  const rate = number_(settings.hour_rate);
  return { rate: rate, hourRate: rate, value: rate, company: 'Zoe Fragance', timeZone: TIME_ZONE };
}

function index_() {
  const rate = settings_().rate;
  const people = {};
  const paid = {};
  const last = {};
  read_('liquidations').forEach(function (r) {
    const v = r.values;
    String(v[6] || '').split(',').filter(Boolean).forEach(function (id) { paid[id] = true; });
    if (!last[v[1]] || new Date(v[4]) > new Date(last[v[1]])) last[v[1]] = v[4];
  });
  read_('workers').forEach(function (r) {
    const v = r.values;
    people[v[0]] = { id: id_(v[0]), name: v[1], phone: String(v[2] || ''), email: v[3] || '', hourly_rate: v[5] || '', hourlyRate: number_(v[5]) || rate,
      archived: Boolean(v[6]), hours: 0, pay: 0, days: 0, active: false, activeStart: null, activeRate: 0, lastLiquidation: last[v[0]] || null,
      pending: [], invalidLogs: [], dayKeys: {} };
  });
  read_('time_logs').forEach(function (r) {
    const v = r.values;
    const worker = people[v[1]];
    if (!worker) return;
    if (!v[3]) {
      if (worker.active) worker.invalidLogs.push(v[0]);
      worker.active = true;
      worker.activeStart = v[2];
      worker.activeRate = number_(v[7]);
      return;
    }
    if (paid[v[0]]) return;
    if (!v[0] || !Number.isFinite(new Date(v[2]).getTime()) || !Number.isFinite(new Date(v[3]).getTime()) || new Date(v[3]) <= new Date(v[2]) || number_(v[4]) <= 0 || number_(v[7]) <= 0 || !Number.isFinite(Number(v[8])) || Number(v[8]) < 0) {
      worker.invalidLogs.push(v[0]); return;
    }
    worker.hours += number_(v[4]);
    worker.pay += number_(v[8]);
    worker.pending.push(id_(v[0]));
    worker.dayKeys[Utilities.formatDate(new Date(v[2]), TIME_ZONE, 'yyyy-MM-dd')] = true;
  });
  Object.keys(people).forEach(function (id) {
    people[id].hours = hours_(people[id].hours);
    people[id].pay = money_(people[id].pay);
    people[id].days = Object.keys(people[id].dayKeys).length;
  });
  return { people: people, rate: rate };
}

function publicWorker_(worker) {
  const out = Object.assign({}, worker);
  delete out.pending; delete out.dayKeys; delete out.archived;
  return out;
}

function workers_() {
  return cached_('workers', function () {
    const index = index_();
    return Object.keys(index.people).filter(function (id) { return !index.people[id].archived; }).map(function (id) { return publicWorker_(index.people[id]); });
  });
}

function logResponse_(r, names) {
  const v = r.values;
  return { id: v[0], workerId: v[1], workerName: names[v[1]] || 'Trabajador', start: v[2], end: v[3] || null, hours: number_(v[4]), shiftType: v[5] || '', shiftLabel: v[6] || '', hourlyRate: number_(v[7]), earned: number_(v[8]), requestId: v[10] || '', inRequestId: v[11] || '' };
}

function logs_(d) {
  const workerId = id_(d.worker || d.worker_id);
  const names = {};
  read_('workers').forEach(function (r) { names[r.values[0]] = r.values[1]; });
  const rows = read_('time_logs').filter(function (r) { return id_(r.values[1]) === workerId; }).sort(function (a, b) { return new Date(b.values[2]) - new Date(a.values[2]); });
  const offset = Math.max(0, Math.floor(number_(d.offset)));
  const limit = Math.min(500, Math.max(1, Math.floor(number_(d.limit) || 100)));
  return { ok: true, logs: rows.slice(offset, offset + limit).map(function (r) { return logResponse_(r, names); }), total: rows.length, offset: offset, hasMore: offset + limit < rows.length };
}

function bootstrap_(d) {
  const workers = workers_();
  const selected = workers.some(function (w) { return w.id === id_(d.worker); }) ? id_(d.worker) : (workers[0] && workers[0].id || '');
  const page = selected ? logs_({ worker: selected }) : { logs: [], total: 0, hasMore: false };
  return { ok: true, company: 'Zoe Fragance', version: VERSION, spreadsheetId: SPREADSHEET_ID, workers: workers, rate: settings_().rate, selectedWorkerId: selected, logs: page.logs, totalLogs: page.total, hasMoreLogs: page.hasMore, serverTime: new Date() };
}

function dashboard_() {
  const workers = workers_();
  return { workers: workers.length, hours: hours_(workers.reduce(function (n, w) { return n + w.hours; }, 0)), pay: money_(workers.reduce(function (n, w) { return n + w.pay; }, 0)), rate: settings_().rate, liquidations: read_('liquidations').length };
}

function workerRow_(workerId, allowArchived) {
  const row = read_('workers').filter(function (r) { return id_(r.values[0]) === workerId && (allowArchived || !r.values[6]); })[0];
  if (!row) fail_('Trabajador no encontrado.', 'worker_not_found');
  return row;
}

function validatePerson_(d) {
  const name = text_(d.name, 150);
  if (!name) fail_('El nombre es obligatorio.');
  const email = String(d.email || '').trim().toLowerCase();
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254)) fail_('El correo no es válido.');
  return { name: name, phone: text_(d.phone, 50), email: email };
}

function addWorker_(d) {
  return withLock_(function () {
    const p = validatePerson_(d);
    const id = Utilities.getUuid();
    append_('workers', [[id, p.name, p.phone, p.email, new Date(), '', '']]);
    changed_();
    return { ok: true, id: id, name: p.name, phone: p.phone, email: p.email };
  });
}

function updateWorker_(d) {
  return withLock_(function () {
    const p = validatePerson_(d);
    const row = workerRow_(id_(d.id));
    row.sheet.getRange(row.rowNumber, 2, 1, 3).setValues([[p.name, p.phone, p.email]]);
    changed_();
    return { ok: true, id: d.id };
  });
}

function deleteWorker_(d) {
  return withLock_(function () {
    const worker = index_().people[id_(d.id)];
    if (!worker || worker.archived) fail_('Trabajador no encontrado.');
    if (worker.active || worker.pending.length || worker.invalidLogs.length) fail_('Cierra el turno y liquida los registros pendientes antes de retirar al trabajador.', 'pending_balance');
    const row = workerRow_(id_(d.id));
    row.sheet.getRange(row.rowNumber, 7).setValue(new Date());
    changed_();
    return { ok: true, archived: true };
  });
}

function setRate_(d) {
  return withLock_(function () {
    const rate = number_(d.value);
    if (rate <= 0 || rate > 1000000000) fail_('Ingresa una tarifa válida mayor a cero.');
    const row = read_('settings').filter(function (r) { return r.values[0] === 'hour_rate'; })[0];
    row.sheet.getRange(row.rowNumber, 2).setValue(rate);
    changed_();
    return { ok: true, rate: rate };
  });
}

function setWorkerRate_(d) {
  return withLock_(function () {
    const rate = number_(d.rate);
    if (rate <= 0 || rate > 1000000000) fail_('Ingresa una tarifa válida mayor a cero.');
    const row = workerRow_(id_(d.worker));
    row.sheet.getRange(row.rowNumber, 6).setValue(rate);
    changed_();
    return { ok: true, rate: rate };
  });
}

function attendanceResult_(row, worker, isIn, duplicate) {
  const v = Array.isArray(row) ? row : row.values;
  return { ok: true, type: isIn ? 'IN' : 'OUT', workerId: id_(v[1]), name: worker.name, logId: v[0], time: isIn ? v[2] : v[3], start: v[2], end: v[3] || null, hours: number_(v[4]), hourlyRate: number_(v[7]), earned: number_(v[8]), alreadyRegistered: Boolean(duplicate), attendanceConfirmed: true, active: !v[3] };
}

function attendance_(d, isIn, isBatch) {
  return withLock_(function () {
    const entries = isBatch ? (Array.isArray(d.entries) ? d.entries : (d.workers || []).map(function (worker) { return { worker: worker, requestId: d.operationIds && d.operationIds[worker] }; })) : [d];
    if (!entries.length || entries.length > 200) fail_('Selecciona entre 1 y 200 trabajadores.');
    const people = {};
    const globalRate = settings_().rate;
    read_('workers').forEach(function (r) {
      const v = r.values;
      if (!v[6]) people[v[0]] = { id: id_(v[0]), name: v[1], rate: number_(v[5]) || globalRate };
    });
    const rows = read_('time_logs');
    const inRequests = Object.create(null); const outRequests = Object.create(null); const open = Object.create(null);
    rows.forEach(function (r) {
      const v = r.values;
      if (v[11]) inRequests[v[11]] = r;
      if (v[10]) outRequests[v[10]] = r;
      if (!v[3]) {
        if (!open[v[1]]) open[v[1]] = [];
        open[v[1]].push(r);
      }
    });
    const appended = [];
    const now = new Date();
    const results = entries.map(function (entry) {
      const workerId = id_(entry.worker || entry.worker_id);
      const person = people[workerId];
      try {
        if (!person) fail_('Trabajador no encontrado.', 'worker_not_found');
        const requestId = request_(entry);
        const found = isIn ? inRequests[requestId] : outRequests[requestId];
        if (found) {
          if (id_(found.values[1]) !== workerId) fail_('La operación pertenece a otro trabajador.', 'idempotency_conflict');
          return attendanceResult_(found, person, isIn, true);
        }
        if ((isIn ? outRequests : inRequests)[requestId]) fail_('El identificador ya se usó en otro movimiento.', 'idempotency_conflict');
        const active = open[workerId] || [];
        if (isIn) {
          if (active.length) fail_('Este trabajador ya tiene una entrada abierta.', 'already_active');
          if (person.rate <= 0) fail_('Configura el valor por hora antes de registrar la entrada.', 'invalid_rate');
          const row = [Utilities.getUuid(), workerId, now, '', 0, 'time', 'Tiempo real', person.rate, 0, now, '', requestId];
          const record = { values: row };
          appended.push(row); open[workerId] = [record]; inRequests[requestId] = record;
          return attendanceResult_(row, person, true, false);
        }
        if (!active.length) fail_('Este trabajador no tiene una entrada abierta.', 'no_active_session');
        if (active.length > 1) fail_('Hay varias entradas abiertas. Revisa las hojas antes de continuar.', 'multiple_open_sessions');
        const record = active[0];
        const row = record.values.slice();
        const elapsed = now.getTime() - new Date(row[2]).getTime();
        if (!Number.isFinite(elapsed) || elapsed <= 0) fail_('La hora de salida debe ser posterior a la entrada.', 'invalid_time');
        const rate = number_(row[7]);
        if (rate <= 0) fail_('El turno no tiene una tarifa válida.', 'invalid_rate');
        row[3] = now; row[4] = hours_(elapsed / 3600000); row[8] = money_(elapsed / 3600000 * rate); row[10] = requestId;
        // Una escritura por jornada, conservando tarifa y fecha originales.
        record.sheet.getRange(record.rowNumber, 4, 1, 8).setValues([row.slice(3, 11)]);
        record.values = row; open[workerId] = []; outRequests[requestId] = record;
        return attendanceResult_(row, person, false, false);
      } catch (error) {
        return { error: true, workerId: workerId, name: person && person.name || 'Trabajador', code: error.code || 'server_error', message: error.message };
      }
    });
    if (appended.length) append_('time_logs', appended);
    if (results.some(function (r) { return !r.error && !r.alreadyRegistered; })) { SpreadsheetApp.flush(); changed_(); }
    return isBatch ? { ok: true, results: results, serverTime: now } : results[0];
  });
}

function liquidationResponse_(v, duplicate) {
  return { ok: true, id: v[0], workerId: v[1], hours: number_(v[2]), amount: number_(v[3]), liquidation_date: v[4], rate: number_(v[5]), name: v[8], phone: String(v[9] || ''), email: v[10] || '', emailStatus: v[11] || '', alreadyRegistered: Boolean(duplicate) };
}

function liquidate_(d) {
  const result = withLock_(function () {
    const workerId = id_(d.worker || d.worker_id);
    const requestId = request_(d);
    const existing = read_('liquidations').filter(function (r) { return r.values[7] === requestId; })[0];
    if (existing) {
      if (id_(existing.values[1]) !== workerId) fail_('La operación pertenece a otro trabajador.', 'idempotency_conflict');
      return liquidationResponse_(existing.values, true);
    }
    const worker = index_().people[workerId];
    if (!worker || worker.archived) fail_('Trabajador no encontrado.');
    if (worker.active) fail_('Registra la salida antes de liquidar al trabajador.', 'active_session');
    if (worker.invalidLogs.length) fail_('Hay marcajes inválidos. Revisa las hojas antes de liquidar.', 'invalid_logs');
    if (!worker.pending.length || worker.hours <= 0 || worker.pay <= 0) fail_('No hay horas cerradas pendientes por liquidar.', 'no_pending_balance');
    const included = worker.pending.join(',');
    if (included.length > 45000) fail_('Hay demasiados registros para una liquidación. Solicita dividir el período.', 'too_many_logs');
    const row = [Utilities.getUuid(), workerId, worker.hours, worker.pay, new Date(), worker.pay / worker.hours, included, requestId, worker.name, worker.phone, worker.email];
    append_('liquidations', [row]);
    SpreadsheetApp.flush(); changed_();
    return liquidationResponse_(row, false);
  });
  // El pago se confirma primero. Un fallo del correo nunca revierte ni repite el pago.
  if (!result.alreadyRegistered) {
    let status = 'Sin correo registrado; comprobante guardado en el historial.';
    if (result.email) {
      try {
        if (MailApp.getRemainingDailyQuota() < 1) throw new Error('Sin cuota de correo disponible');
        MailApp.sendEmail({
          to: result.email,
          name: 'Zoe Fragance',
          subject: 'Comprobante de pago — Zoe Fragance — ' + result.id.slice(0, 8).toUpperCase(),
          body: ['ZOE FRAGANCE', 'Comprobante de pago por horas trabajadas', '', 'Trabajador: ' + result.name,
            'Horas pagadas: ' + result.hours, 'Valor pagado: COP $' + result.amount.toLocaleString('es-CO'),
            'Fecha: ' + Utilities.formatDate(new Date(result.liquidation_date), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'),
            'Referencia: ' + result.id, '', 'Este pago corresponde a los marcajes cerrados incluidos en el historial de la empresa.'].join('\n')
        });
        status = 'Comprobante enviado a ' + result.email;
      } catch (_) { status = 'Pago guardado. No se pudo enviar el comprobante por correo; consulta el historial.'; }
    }
    result.emailStatus = status;
    try {
      const row = read_('liquidations').filter(function (r) { return r.values[0] === result.id; })[0];
      if (row) row.sheet.getRange(row.rowNumber, 12).setValue(status);
    } catch (_) {}
  }
  return result;
}

function liquidations_() {
  const names = {};
  read_('workers').forEach(function (r) { names[r.values[0]] = r.values[1]; });
  return read_('liquidations').map(function (r) {
    const v = r.values;
    return { id: v[0], workerId: v[1], workerName: v[8] || names[v[1]] || 'Trabajador', hours_paid: number_(v[2]), amount_paid: number_(v[3]), liquidation_date: v[4], rate: number_(v[5]), included_logs: v[6] || '' };
  }).sort(function (a, b) { return new Date(b.liquidation_date) - new Date(a.liquidation_date); });
}
