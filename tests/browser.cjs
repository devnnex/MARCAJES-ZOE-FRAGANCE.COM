const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { harness } = require('./apps-script-harness.cjs');
const root = path.resolve(__dirname, '..');
const apiUrl = 'https://script.google.com/macros/s/zoe-test/exec';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function main() {
  const h = harness({ now: new Date().toISOString() });
  h.setup();
  const token = h.call('login', { pin: '5678' }).token;
  const admin = (action, data = {}) => h.call(action, { ...data, token });
  admin('setRate', { value: 10000 });
  const ana = admin('addWorker', { name: 'Ana Martínez', email: 'ana@example.com', phone: '3001234567' });
  const luis = admin('addWorker', { name: 'Luis Gómez' });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(root, '.' + relative);
    if (!target.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    if (relative === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(`window.ZOE_CONFIG = { apiUrl: '${apiUrl}' };`); }
    fs.readFile(target, (error, data) => {
      res.writeHead(error ? 404 : 200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
      res.end(error ? 'Not found' : data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-browser-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const calls = [];
  try {
    // Las solicitudes de Apps Script se ejecutan contra el backend real con servicios simulados.
    await context.route(apiUrl, async route => {
      const data = route.request().postDataJSON();
      calls.push(data.action);
      const result = h.call(data.action, data);
      await route.fulfill({ json: result, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('favicon.ico')) errors.push(msg.text()); });
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#workerSelect').options.length === 2);
    assert.deepEqual(calls, ['getTimeBootstrap'], 'La primera carga debe usar una sola solicitud');
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    const cdp = await context.newCDPSession(page);
    const installability = await cdp.send('Page.getInstallabilityErrors');
    assert.deepEqual(installability.installabilityErrors, [], 'La PWA debe cumplir los criterios de instalación de Chromium');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.getByText('Configuración', { exact: true }).count(), 0);
    await page.click('#checkInButton');
    await page.waitForSelector('.swal2-popup');
    assert.match(await page.locator('.swal2-title').innerText(), /Entrada registrada/);
    await page.click('.swal2-confirm');
    await page.waitForSelector('.liveClock');
    assert.equal(h.rows('time_logs').length, 1);
    assert.equal(calls.filter(a => a === 'checkInBatch').length, 1);
    h.advance(2 * 3600000);
    await page.click('#checkOutButton');
    await page.waitForSelector('.swal2-popup');
    assert.match(await page.locator('.swal2-html-container').innerText(), /20[.,]000/);
    await page.click('.swal2-confirm');
    await page.waitForFunction(() => document.querySelector('#activeShiftPanel').innerText.includes('FUERA DE TURNO'));
    await page.click('[data-section="workers"]');
    await page.waitForSelector('.swal2-input');
    await page.fill('.swal2-input', '0000');
    await page.click('.swal2-confirm');
    await page.waitForSelector('.swal2-validation-message');
    assert.match(await page.locator('.swal2-validation-message').innerText(), /PIN incorrecto/);
    await page.fill('.swal2-input', '5678');
    await page.click('.swal2-confirm');
    await page.waitForSelector('#workers.active .worker-card');
    assert.equal(await page.locator('.worker-card').count(), 2);
    await page.fill('#name', 'María Torres');
    await page.fill('#phone', '3012345678');
    await page.fill('#email', 'maria@example.com');
    await page.click('.add-worker-btn');
    await page.waitForSelector('.swal2-popup');
    await page.click('.swal2-confirm');
    await page.waitForFunction(() => document.querySelectorAll('.worker-card').length === 3);
    await page.locator('.worker-card').filter({ hasText: 'María Torres' }).locator('.edit-worker-btn').click();
    await page.fill('#swalWorkerName', 'María Torres Actualizada');
    await page.click('.swal2-confirm');
    await page.waitForFunction(() => document.querySelector('.swal2-title')?.textContent === 'Cambio exitoso');
    await page.click('.swal2-confirm');
    await page.locator('.worker-card').filter({ hasText: 'María Torres Actualizada' }).locator('.worker-rate-btn').click();
    await page.fill('#swalWorkerRate', '15000');
    await page.click('.swal2-confirm');
    await page.waitForFunction(() => document.querySelector('.swal2-title')?.textContent === 'Tarifa guardada');
    await page.click('.swal2-confirm');
    await page.locator('.worker-card').filter({ hasText: 'María Torres Actualizada' }).locator('.delete-btn').click();
    await page.waitForSelector('.swal2-popup');
    await page.click('.swal2-confirm');
    await page.waitForFunction(() => document.querySelectorAll('.worker-card').length === 2);
    await page.locator('.worker-card').filter({ hasText: 'Ana Martínez' }).locator('.liquidate-btn').click();
    await page.waitForSelector('.swal2-popup');
    await page.click('.swal2-confirm');
    await page.waitForFunction(() => document.querySelector('.swal2-title')?.textContent === 'Liquidación completada');
    await page.click('.swal2-confirm');
    assert.equal(h.rows('liquidations').length, 1);
    assert.equal(h.rows('liquidations')[0][3], 20000);
    await page.click('[data-section="history"]');
    await page.waitForFunction(() => document.querySelector('#historyTotalRecords')?.textContent === '1');
    assert.match(await page.locator('#historyTableBody').innerText(), /Ana Martínez/);
    await page.click('[data-section="dashboard"]');
    await page.waitForFunction(() => document.querySelector('#kpiWorkers').textContent === '2');
    assert.equal(await page.locator('#kpiMonth').innerText(), '1');
    await page.click('#themeToggle');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#workerSelect').options.length === 2);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    // Lotes: una petición para el grupo completo.
    await page.click('#modeMultiBtn');
    await page.evaluate(() => toggleAllBatchWorkers(true));
    await page.click('#checkInButton');
    await page.waitForSelector('.swal2-popup');
    await page.click('.swal2-confirm');
    h.advance(3600000);
    await page.click('#checkOutButton');
    await page.waitForSelector('.swal2-popup');
    await page.click('.swal2-confirm');
    assert.equal(h.rows('time_logs').length, 3);
    assert.ok(h.rows('time_logs').every(row => row[3]));
    // Comprobar tamaños representativos sin desbordamiento del documento.
    fs.mkdirSync(path.join(root, '.qa', 'screenshots'), { recursive: true });
    for (const [width, height] of [[320, 820], [390, 844], [768, 1024], [1024, 900], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.mouse.move(0, 0);
        const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !el.closest('.time-table-wrapper'); }).map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right })) }));
        assert.ok(overflow.document <= overflow.width + 1, `Desbordamiento en ${width}px, ${theme}: ${JSON.stringify(overflow.elements)}`);
        const logo = await page.locator('.company-logo').evaluate(image => ({ complete: image.complete && image.naturalWidth > 0, width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, radius: getComputedStyle(image).borderRadius, clip: getComputedStyle(image).clipPath }));
        assert.ok(logo.complete && logo.width === logo.height && logo.width <= 60, 'Logo visible y compacto');
        assert.equal(logo.radius, '50%');
        assert.equal(logo.clip, 'circle(50%)');
        await page.screenshot({ path: path.join(root, '.qa', 'screenshots', `marcajes-${width}-${theme}.png`), fullPage: true });
      }
    }
    // Validar manifest, iconos y que el shell abre sin red.
    const manifest = await page.evaluate(() => fetch('manifest.json').then(r => r.json()));
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('#activeShiftPanel');
    assert.match(await page.title(), /Zoe Fragance/);
    assert.equal(await page.locator('#themeToggle').count(), 1);
    await context.setOffline(false);
    assert.deepEqual(errors, [], 'No debe haber errores de navegador');
    console.log('OK: carga consolidada, entradas, salidas, PIN, liquidación, historial, resumen, lote, 5 tamaños × 2 temas y PWA sin red.');
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
    if (!path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep + 'zoe-browser-')) throw Error('Unexpected browser profile path');
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
