const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./apps-script-harness.cjs');

function ready(options) {
  const h = harness(options);
  h.setup();
  const token = h.call('login', { pin: '5678' }).token;
  const admin = (action, data = {}) => h.call(action, { ...data, token });
  admin('setRate', { value: 10000 });
  const person = admin('addWorker', { name: 'Ana', email: 'ana@example.com', phone: '3001234567' });
  return { h, token, admin, person };
}

test('preparación repetible conserva personas, tarifa, columnas y el Sheet de Zoe', () => {
  const { h, person } = ready();
  h.setup();
  assert.equal(h.sheets.length, 4);
  assert.equal(h.call('getSettings').rate, 10000);
  assert.equal(h.rows('workers')[0][0], person.id);
  assert.equal(h.rows('workers').length, 1);
  assert.equal(h.spreadsheet.getSheetByName('time_logs').rows[0][11], 'in_request_id');
});

test('PIN y token se validan en backend; cerrar sesión invalida el token', () => {
  const { h, admin, token } = ready();
  assert.equal(h.call('login', { pin: '0000' }).code, 'invalid_pin');
  assert.equal(h.call('addWorker', { name: 'Sin permiso' }).code, 'unauthorized');
  assert.equal(h.call('getLiquidations').code, 'unauthorized');
  h.call('logout', { token });
  assert.equal(admin('setRate', { value: 1 }).code, 'unauthorized');
});

test('entradas y salidas usan reloj servidor, resisten reintentos y conservan tarifa al cruzar medianoche', () => {
  const { h, admin, person } = ready({ now: '2026-11-04T03:30:00Z' }); // 22:30 Colombia
  const input = { worker: person.id, requestId: 'in-1', start: '2000-01-01' };
  const entry = h.call('checkIn', input);
  assert.equal(entry.time, '2026-11-04T03:30:00.000Z');
  assert.equal(h.call('checkIn', input).alreadyRegistered, true);
  assert.equal(h.call('checkIn', { worker: person.id, requestId: 'other-in' }).code, 'already_active');
  admin('setWorkerRate', { worker: person.id, rate: 20000 });
  h.advance(3 * 3600000);
  assert.equal(h.call('getWorkers')[0].active, true);
  const exit = h.call('checkOut', { worker: person.id, requestId: 'out-1', hours: 8, exitOnly: true });
  assert.equal(exit.hours, 3);
  assert.equal(exit.earned, 30000);
  assert.equal(exit.hourlyRate, 10000);
  assert.equal(h.call('checkOut', { worker: person.id, requestId: 'out-1' }).alreadyRegistered, true);
  assert.equal(h.call('checkIn', input).active, false);
  assert.equal(h.rows('time_logs').length, 1);
  assert.equal(h.call('getWorkers')[0].pay, 30000);
});

test('no se inventa salida sin entrada y no se marcan tarifas cero', () => {
  const { h, admin, person } = ready();
  assert.equal(h.call('checkOut', { worker: person.id, requestId: 'out' }).code, 'no_active_session');
  h.spreadsheet.getSheetByName('settings').rows[1][1] = 0;
  assert.equal(h.call('checkIn', { worker: person.id, requestId: 'in' }).code, 'invalid_rate');
  assert.equal(h.rows('time_logs').length, 0);
  assert.equal(h.call('checkIn', { worker: person.id }).code, 'missing_request_id');
});

test('lote mixto confirma cada trabajador y no duplica IDs entre trabajadores ni acciones', () => {
  const { h, admin, person } = ready();
  const other = admin('addWorker', { name: 'Luis' });
  const entries = [{ worker: person.id, requestId: 'shared' }, { worker: other.id, requestId: 'shared' }, { worker: other.id, requestId: 'other' }, { worker: 'missing', requestId: 'missing' }];
  const result = h.call('checkInBatch', { entries });
  assert.equal(result.results.filter(r => r.ok).length, 2);
  assert.equal(result.results[1].code, 'idempotency_conflict');
  h.advance(3600000);
  assert.equal(h.call('checkOut', { worker: person.id, requestId: 'shared' }).code, 'idempotency_conflict');
  const out = h.call('checkOutBatch', { entries: [{ worker: person.id, requestId: 'exit-a' }, { worker: other.id, requestId: 'exit-b' }] });
  assert.equal(out.results.reduce((sum, r) => sum + r.earned, 0), 20000);
  assert.equal(h.rows('time_logs').length, 2);
});

test('liquidación con tarifas mixtas, comprobante, saldo cero y reintento sin segundo pago', () => {
  const { h, admin, person } = ready();
  h.call('checkIn', { worker: person.id, requestId: 'in1' });
  assert.equal(admin('liquidateWorker', { worker: person.id, requestId: 'pay-open' }).code, 'active_session');
  h.advance(2 * 3600000);
  h.call('checkOut', { worker: person.id, requestId: 'out1' });
  admin('setWorkerRate', { worker: person.id, rate: 15000 });
  h.call('checkIn', { worker: person.id, requestId: 'in2' });
  h.advance(3600000);
  h.call('checkOut', { worker: person.id, requestId: 'out2' });
  const payment = admin('liquidateWorker', { worker: person.id, requestId: 'pay' });
  assert.equal(payment.hours, 3);
  assert.equal(payment.amount, 35000);
  assert.equal(h.messages.length, 1);
  assert.match(payment.emailStatus, /enviado/);
  assert.equal(admin('liquidateWorker', { worker: person.id, requestId: 'pay' }).id, payment.id);
  assert.equal(h.messages.length, 1);
  assert.equal(h.rows('liquidations').length, 1);
  assert.equal(h.call('getWorkers')[0].pay, 0);
  assert.equal(admin('liquidateWorker', { worker: person.id, requestId: 'new-pay' }).code, 'no_pending_balance');
  assert.equal(admin('deleteWorker', { id: person.id }).ok, true);
  assert.equal(h.call('getWorkers').length, 0);
  assert.equal(admin('getLiquidations')[0].workerName, 'Ana');
});

test('un fallo del correo conserva el pago y comunica el resultado real', () => {
  const { h, admin, person } = ready({ mailFails: true });
  h.call('checkIn', { worker: person.id, requestId: 'in' });
  h.advance(3600000);
  h.call('checkOut', { worker: person.id, requestId: 'out' });
  const payment = admin('liquidateWorker', { worker: person.id, requestId: 'pay' });
  assert.equal(payment.ok, true);
  assert.match(payment.emailStatus, /No se pudo enviar/);
  assert.equal(h.rows('liquidations').length, 1);
});

test('retiro no borra nómina pendiente ni turnos abiertos', () => {
  const { h, admin, person } = ready();
  h.call('checkIn', { worker: person.id, requestId: 'in' });
  assert.equal(admin('deleteWorker', { id: person.id }).code, 'pending_balance');
  h.advance(3600000);
  h.call('checkOut', { worker: person.id, requestId: 'out' });
  assert.equal(admin('deleteWorker', { id: person.id }).code, 'pending_balance');
});

test('rotación de hojas conserva marcajes y permite liquidar entre varias hojas', () => {
  const { h, admin, person } = ready({ maxRows: 3 });
  for (let i = 0; i < 5; i++) {
    h.call('checkIn', { worker: person.id, requestId: `in-${i}` });
    h.advance(3600000);
    h.call('checkOut', { worker: person.id, requestId: `out-${i}` });
  }
  assert.equal(h.sheets.filter(s => s.name.startsWith('time_logs')).length, 3);
  assert.equal(h.call('getTimeBootstrap').totalLogs, 5);
  const page = h.call('getTimeLogsByWorker', { worker: person.id, limit: 2 });
  assert.equal(page.logs.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(admin('liquidateWorker', { worker: person.id, requestId: 'pay' }).amount, 50000);
});

test('la lectura consolidada evita recorrer las hojas una vez por trabajador', () => {
  const { h, admin } = ready();
  for (let i = 0; i < 50; i++) admin('addWorker', { name: `Persona ${i}` });
  h.metrics.reads = 0;
  const snapshot = h.call('getTimeBootstrap');
  assert.equal(snapshot.workers.length, 51);
  assert.ok(h.metrics.reads <= 4, `Se hicieron ${h.metrics.reads} lecturas`);
});
