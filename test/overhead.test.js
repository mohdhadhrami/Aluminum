const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

process.env.ADMIN_TOKEN = 'test-token';

async function start() {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = 'test-token') => {
        const res = await fetch(base + url, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { db, server, base, call };
}

const wilayah = (conf, name) => conf.locations.flatMap((g) => g.wilayat).find((w) => w.name === name);

test('overhead calculator starts with the company site data', async (t) => {
    const { server, call } = await start();
    t.after(() => server.close());
    const { body: conf } = await call('GET', '/api/public/overhead', null, '');

    assert.deepStrictEqual(conf.gate_types.map((g) => g.name), ['Type A', 'Type B']);
    const [a, b] = conf.gate_types;
    assert.deepStrictEqual(a.heights.map((h) => [h.height_cm, h.widths]), [[250, [415, 455, 615]], [300, [415, 455, 615]]]);
    // Both types come in 250 and 300 cm (Type B 300 cm with default prices to be edited in the admin)
    assert.deepStrictEqual(b.heights.map((h) => [h.height_cm, h.widths]), [[250, [370, 440, 550, 600]], [300, [370, 440, 550, 600]]]);
    assert.deepStrictEqual(conf.motors.map((m) => m.name), ['المكينة الإيطالية 1200N', 'المكينة الإيطالية 1000N', 'المكينة الصينية 1500N']);
    assert.ok(wilayah(conf, 'نزوى') && wilayah(conf, 'عبري'));
    // Public data never carries prices before the customer asks
    assert.ok(!JSON.stringify(conf).includes('price'));
});

test('overhead price = size range + motor + installation, plus VAT (same method as the site)', async (t) => {
    const { server, call } = await start();
    t.after(() => server.close());
    const { body: conf } = await call('GET', '/api/public/overhead', null, '');
    const motor = conf.motors.find((m) => m.name === 'المكينة الإيطالية 1200N');
    const req = { gate_type: 'Type A', width_cm: 415, height_cm: 250, motor_id: motor.id, region_id: wilayah(conf, 'نزوى').id };

    const { status, body: p } = await call('POST', '/api/public/overhead-price', req, '');
    assert.strictEqual(status, 200);
    // Site: 355–375 + 145 + 80 = 580–600 (before VAT)
    assert.strictEqual(p.subtotal, 580);
    assert.strictEqual(p.range.subtotal_to, 600);
    assert.strictEqual(p.total, 609);
    assert.strictEqual(p.range.total_to, 630);
    assert.deepStrictEqual(p.items.map((i) => i.line_total), [355, 145, 80]);

    // Sizes that are not in the table, a missing motor or wilayah are refused
    assert.strictEqual((await call('POST', '/api/public/overhead-price', { ...req, width_cm: 400 }, '')).status, 400);
    assert.strictEqual((await call('POST', '/api/public/overhead-price', { ...req, gate_type: 'Type B' }, '')).status, 400);
    assert.strictEqual((await call('POST', '/api/public/overhead-price', { ...req, motor_id: null }, '')).status, 400);
    assert.strictEqual((await call('POST', '/api/public/overhead-price', { ...req, region_id: null }, '')).status, 400);
});

test('overhead quote is saved with its price range and opens as a PDF', async (t) => {
    const { server, base, call } = await start();
    t.after(() => server.close());
    const { body: conf } = await call('GET', '/api/public/overhead', null, '');
    const res = await call('POST', '/api/public/overhead-quotes', {
        gate_type: 'Type B', width_cm: 440, height_cm: 250, motor_id: conf.motors[2].id, region_id: wilayah(conf, 'عبري').id,
        customer_name: 'عميل', customer_phone: '91234567', total: 1   // a client price is ignored
    }, '');
    assert.strictEqual(res.status, 201);
    // 295–315 + 110 + 115 = 520–540, +5% VAT
    assert.strictEqual(res.body.total, 546);
    assert.strictEqual(res.body.details.range.total_to, 567);
    assert.strictEqual(res.body.details.calculator, 'overhead');

    // Pressing "احتساب السعر" again with the same data: same request, no duplicate
    const again = await call('POST', '/api/public/overhead-quotes', {
        gate_type: 'Type B', width_cm: 440, height_cm: 250, motor_id: conf.motors[2].id, region_id: wilayah(conf, 'عبري').id,
        customer_name: 'عميل', customer_phone: '91234567'
    }, '');
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.ref, res.body.ref);

    const pdf = await fetch(base + res.body.pdf_url);
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok((await pdf.arrayBuffer()).byteLength > 1000);
});

test('admin edits overhead sizes, motors and the installation fee per wilayah', async (t) => {
    const { server, call } = await start();
    t.after(() => server.close());
    assert.strictEqual((await call('GET', '/api/admin/overhead', null, 'wrong')).status, 401);
    const { body: data } = await call('GET', '/api/admin/overhead');
    assert.strictEqual(data.sizes.length, 14);

    const sizes = data.sizes.map((s) => (s.gate_type === 'Type B' && s.width_cm === 370 ? { ...s, price_from: 280, price_to: 300 } : s));
    const motors = [...data.motors, { name: 'محرك تجريبي', price: 99, active: false }];
    const saved = await call('PUT', '/api/admin/overhead', { sizes, motors });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.motors.length, 4);
    assert.strictEqual((await call('PUT', '/api/admin/overhead', { sizes: [{ ...sizes[0], price_to: 1 }], motors })).status, 400);
    assert.strictEqual((await call('PUT', '/api/admin/overhead', { sizes: [sizes[0], sizes[0]], motors })).status, 400);

    // Clearing a wilayah's overhead fee hides it from the overhead calculator only
    const nizwa = data.regions.find((r) => r.name === 'نزوى');
    await call('PUT', `/api/admin/regions/${nizwa.id}`, { overhead_installation_fee: '' });
    const { body: conf } = await call('GET', '/api/public/overhead', null, '');
    assert.strictEqual(wilayah(conf, 'نزوى'), undefined);
    assert.ok(!conf.motors.some((m) => m.name === 'محرك تجريبي'));   // inactive motor hidden
    const { body: shutter } = await call('GET', '/api/public/configurator', null, '');
    assert.ok(shutter.locations.flatMap((g) => g.wilayat).some((w) => w.name === 'نزوى'));

    // The old "import site prices" action does not exist (it would overwrite the admin's prices)
    assert.strictEqual((await call('POST', '/api/admin/import/radma-overhead')).status, 404);
});

test('an existing database gets the default Type B 300 cm sizes once, not again after the admin deletes them', () => {
    const { addDefaultOverheadSizes } = require('../src/radma-catalog');
    const db = openDatabase(':memory:');
    const b300 = () => db.prepare("SELECT COUNT(*) AS n FROM overhead_sizes WHERE gate_type = 'Type B' AND height_cm = 300").get().n;
    // A database from before this version: no Type B 300 rows, no flag; an edited Type A price
    db.exec("DELETE FROM overhead_sizes WHERE gate_type = 'Type B' AND height_cm = 300; DELETE FROM settings WHERE key = 'overhead_defaults_v1'");
    db.exec("UPDATE overhead_sizes SET price_from = 999 WHERE gate_type = 'Type A' AND width_cm = 415 AND height_cm = 250");
    addDefaultOverheadSizes(db);
    assert.strictEqual(b300(), 4);
    assert.strictEqual(db.prepare("SELECT price_from FROM overhead_sizes WHERE gate_type = 'Type A' AND width_cm = 415 AND height_cm = 250").get().price_from, 999);
    db.exec("DELETE FROM overhead_sizes WHERE gate_type = 'Type B' AND height_cm = 300");
    addDefaultOverheadSizes(db);
    assert.strictEqual(b300(), 0);
});
