const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const { slatCostPerMeter } = require('../src/pricing');

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
    return { db, server, call };
}

test('slat cost matches the original in-house formula', () => {
    const s = { lme: 2300, manufacturing: 800, painting: 200, exchange_rate: 0.385 };
    const cost = slatCostPerMeter({ weight_per_meter: 0.63, painted: 1 }, s);
    const expected = (2300 / 1000) * 0.63 * 0.385 + (800 / 1000) * 0.63 * 0.385 + (200 / 1000) * 0.63;
    assert.ok(Math.abs(cost - expected) < 1e-9);
});

test('admin API requires the token', async (t) => {
    const { server, call } = await start();
    t.after(() => server.close());
    assert.strictEqual((await call('GET', '/api/admin/products', null, 'wrong')).status, 401);
    assert.strictEqual((await call('GET', '/api/admin/products')).status, 200);
});

test('purchase updates the product price and records history', async (t) => {
    const { server, call } = await start();
    t.after(() => server.close());

    const created = await call('POST', '/api/admin/products', {
        category: 'machine', name: 'موتور', type: 'اختبار', unit: 'piece', purchase_price: 50, profit_percent: 20
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.unit_price, 60);

    const bought = await call('POST', '/api/admin/purchases', {
        product_id: created.body.id, supplier: 'مورد', quantity: 10, unit_price: 100, currency: 'USD', exchange_rate: 0.385, extra_cost: 1.5
    });
    assert.strictEqual(bought.status, 201);
    assert.strictEqual(bought.body.purchase.unit_cost_omr, 40);
    assert.strictEqual(bought.body.product.purchase_price, 40);
    assert.strictEqual(bought.body.product.unit_price, 48);

    const history = await call('GET', `/api/admin/products/${created.body.id}/history`);
    assert.strictEqual(history.body.changes[0].old_value, 50);
    assert.strictEqual(history.body.changes[0].new_value, 40);
    assert.strictEqual(history.body.purchases.length, 1);
});

test('public catalog hides costs and private products; quote is priced on the server', async (t) => {
    const { server, call } = await start();
    t.after(() => server.close());

    const catalog = await call('GET', '/api/public/catalog', null, '');
    assert.ok(catalog.body.products.length > 0);
    assert.ok(catalog.body.products.every((p) => p.category === 'slat')); // seeded extras are private
    assert.ok(catalog.body.products.every((p) => !('purchase_price' in p) && !('unit_cost' in p)));

    const slat = catalog.body.products[0];
    const quote = await call('POST', '/api/public/quotes', {
        customer_name: 'أحمد', customer_phone: '99123456', region_id: 1,
        items: [{ product_id: slat.id, width: 2, height: 1.5, pieces: 1, unit_price: 0.001 }]
    }, '');
    assert.strictEqual(quote.status, 201);
    assert.strictEqual(quote.body.customer_phone, '96899123456');
    assert.strictEqual(quote.body.items[0].quantity, 39); // 2 × 1.5 × 13
    assert.strictEqual(quote.body.items[0].unit_price, slat.unit_price); // client price ignored
    assert.ok(quote.body.total > quote.body.subtotal);

    const hidden = await call('GET', '/api/admin/products?category=machine');
    const bad = await call('POST', '/api/public/quotes', {
        customer_name: 'x', customer_phone: '99123456', region_id: 1, items: [{ product_id: hidden.body[0].id, quantity: 1 }]
    }, '');
    assert.strictEqual(bad.status, 400);

    const quotes = await call('GET', '/api/admin/quotes');
    assert.strictEqual(quotes.body.length, 1);
});

test('webhook receives signed quote.created event', async (t) => {
    const { server, call } = await start();
    const received = [];
    const sink = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(body) }); res.end('ok'); });
    });
    await new Promise((r) => sink.listen(0, r));
    t.after(() => { server.close(); sink.close(); });

    await call('POST', '/api/admin/webhooks', {
        name: 'sink', url: `http://127.0.0.1:${sink.address().port}/hook`, secret: 's3cret', events: ['quote.created']
    });
    const catalog = await call('GET', '/api/public/catalog', null, '');
    await call('POST', '/api/public/quotes', {
        customer_name: 'سالم', customer_phone: '96891234567', region_id: 1, items: [{ product_id: catalog.body.products[0].id, quantity: 6 }]
    }, '');

    for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].body.event, 'quote.created');
    assert.match(received[0].headers['x-aluminum-signature'], /^sha256=[0-9a-f]{64}$/);
});

test('whatsapp webhook verification handshake', async (t) => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
    const { server } = await start();
    t.after(() => { server.close(); delete process.env.WHATSAPP_VERIFY_TOKEN; });
    const port = server.address().port;
    const ok = await fetch(`http://127.0.0.1:${port}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
    assert.strictEqual(await ok.text(), '42');
    const bad = await fetch(`http://127.0.0.1:${port}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
    assert.strictEqual(bad.status, 403);
});
