const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

process.env.ADMIN_TOKEN = 'test-token';

async function start() {
    process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'radma-backup-'));
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, url, body, headers = {}) => fetch(base + url, {
        method, body, headers: { Authorization: 'Bearer test-token', ...headers }
    });
    return { db, server, call };
}

const typeNames = (db) => db.prepare('SELECT name FROM shutter_types ORDER BY id').all().map((r) => r.name);

test('the old "import Radma prices" action is gone', async (t) => {
    const { server, call } = await start();
    t.after(() => server.close());
    assert.strictEqual((await call('POST', '/api/admin/import/radma-catalog')).status, 404);
});

test('backup downloads as Excel and restores everything after data is deleted', async (t) => {
    const { db, server, call } = await start();
    t.after(() => server.close());
    assert.strictEqual((await fetch(server.address && `http://127.0.0.1:${server.address().port}/api/admin/backup.xlsx`)).status, 401);

    db.prepare("UPDATE regions SET installation_fee = 77 WHERE name = 'نزوى'").run();
    const before = { types: typeNames(db), colors: db.prepare('SELECT COUNT(*) AS n FROM shutter_colors').get().n };

    const res = await call('GET', '/api/admin/backup.xlsx');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    const file = Buffer.from(await res.arrayBuffer());

    // The file opens in Excel with readable sheets
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file);
    assert.ok(wb.getWorksheet('أنواع البوابات') && wb.getWorksheet('الولايات') && wb.getWorksheet('معلومات'));

    // Data lost by mistake…
    db.exec('DELETE FROM shutter_types');
    db.prepare("UPDATE regions SET installation_fee = 1 WHERE name = 'نزوى'").run();
    assert.deepStrictEqual(typeNames(db), []);

    // …needs an explicit confirmation to restore
    assert.strictEqual((await call('POST', '/api/admin/restore', file, { 'Content-Type': 'application/octet-stream' })).status, 400);
    const restored = await call('POST', '/api/admin/restore', file, { 'Content-Type': 'application/octet-stream', 'X-Confirm-Restore': 'yes' });
    assert.strictEqual(restored.status, 200);
    const body = await restored.json();
    assert.ok(body.counts.shutter_types > 0);
    assert.deepStrictEqual(typeNames(db), before.types);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM shutter_colors').get().n, before.colors);
    assert.strictEqual(db.prepare("SELECT installation_fee FROM regions WHERE name = 'نزوى'").get().installation_fee, 77);

    // The state before the restore was saved, so the restore can be undone
    const list = await (await call('GET', '/api/admin/backups')).json();
    assert.strictEqual(list[0].name, body.saved_before_restore);
    assert.strictEqual(list[0].kind, 'before-restore');
    const undo = await call('POST', `/api/admin/backups/${list[0].name}/restore`, undefined, { 'X-Confirm-Restore': 'yes' });
    assert.strictEqual(undo.status, 200);
    assert.deepStrictEqual(typeNames(db), []);
    assert.strictEqual((await call('GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd')).status, 404);

    // Public calculator still works after restores
    assert.strictEqual((await fetch(`http://127.0.0.1:${server.address().port}/api/public/configurator`)).status, 200);
});

test('a wrong file is refused and nothing changes', async (t) => {
    const { db, server, call } = await start();
    t.after(() => server.close());
    const types = typeNames(db);
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Confirm-Restore': 'yes' };
    assert.strictEqual((await call('POST', '/api/admin/restore', Buffer.from('not excel'), headers)).status, 400);

    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['a', 'b']);
    const other = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await call('POST', '/api/admin/restore', other, headers);
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /أوراق ناقصة/);
    assert.deepStrictEqual(typeNames(db), types);
});

test('an older backup without the overhead sheets still restores and keeps the overhead prices', async (t) => {
    const { db, server, call } = await start();
    t.after(() => server.close());
    const file = Buffer.from(await (await call('GET', '/api/admin/backup.xlsx')).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file);
    wb.removeWorksheet(wb.getWorksheet('مقاسات الأوفرهيد').id);
    wb.removeWorksheet(wb.getWorksheet('محركات الأوفرهيد').id);
    const old = Buffer.from(await wb.xlsx.writeBuffer());
    const sizes = db.prepare('SELECT COUNT(*) AS n FROM overhead_sizes').get().n;
    const res = await call('POST', '/api/admin/restore', old, { 'Content-Type': 'application/octet-stream', 'X-Confirm-Restore': 'yes' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM overhead_sizes').get().n, sizes);
    assert.ok(sizes > 0);
});
