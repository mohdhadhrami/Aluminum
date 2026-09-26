const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const mazbot = require('../src/mazbot');

process.env.ADMIN_TOKEN = 'test-token';

/* A fake MazBot API that records what it receives */
async function fakeMazbot({ expireFirstToken = false } = {}) {
    const calls = [];
    let logins = 0;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        const call = { path: req.url, apikey: req.headers.apikey, auth: req.headers.authorization };
        if (req.url === '/api/login') {
            call.body = JSON.parse(raw);
            logins += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: { token: 'jwt-' + logins } }));
        } else {
            // multipart: parse with the web Request API
            const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
            call.form = Object.fromEntries(form.entries());
            if (expireFirstToken && call.auth === 'Bearer jwt-1') {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            }
        }
        calls.push(call);
    });
    await new Promise((r) => server.listen(0, r));
    Object.assign(process.env, {
        MAZBOT_BASE_URL: `http://127.0.0.1:${server.address().port}/api`,
        MAZBOT_API_KEY: 'key-1', MAZBOT_STAFF_EMAIL: 'staff@example.com', MAZBOT_STAFF_PASSWORD: 'pw', MAZBOT_TEMPLATE_ID: '42'
    });
    mazbot._reset();
    return { server, calls };
}

async function startApp() {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (url, body, token) => fetch(base + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body)
    });
    const conf = await (await fetch(base + '/api/public/configurator')).json();
    const type = conf.shutter_types.find((x) => x.variants.length === 1);
    const gov = conf.locations.find((g) => g.name === 'الداخلية');
    const door = {
        width_cm: 300, height_cm: 250, count: 1, shutter_type_id: type.id, color_id: type.variants[0].colors[1].id,
        option_ids: conf.accessory_groups.map((g) => g.options[0].id), region_id: gov.wilayat.find((w) => w.name === 'نزوى').id,
        customer_name: 'أحمد', customer_phone: '99123456'
    };
    return { db, server, base, post, door };
}

const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('recipients accept local 8-digit and international numbers', () => {
    assert.deepStrictEqual(mazbot.parseRecipients('76979066, 90660001'), ['96876979066', '96890660001']);
    assert.deepStrictEqual(mazbot.parseRecipients('+968 7697 9066\n0096890660001'), ['96876979066', '96890660001']);
    assert.strictEqual(mazbot.cleanValue('a\nb'), 'a / b');
});

test('"احتساب السعر" sends the MazBot template with all the data to both sales numbers', async (t) => {
    const fake = await fakeMazbot();
    const app = await startApp();
    t.after(() => { fake.server.close(); app.server.close(); });

    const res = await app.post('/api/public/door-quotes', app.door);
    assert.strictEqual(res.status, 201);
    const quote = await res.json();
    await waitFor(() => fake.calls.filter((c) => c.form).length === 2);

    const [login, ...sends] = fake.calls;
    assert.strictEqual(login.path, '/api/login');
    assert.strictEqual(login.apikey, 'key-1');
    assert.deepStrictEqual(login.body, { email: 'staff@example.com', password: 'pw' });
    assert.deepStrictEqual(sends.map((c) => c.form.mobile), ['96876979066', '96890660001']);
    const f = sends[0].form;
    assert.strictEqual(sends[0].path, '/api/whatsapp/send-template');
    assert.strictEqual(sends[0].auth, 'Bearer jwt-1');
    assert.strictEqual(f.template_id, '42');
    assert.strictEqual(f['body_matchs[1]'], 'input_value');
    assert.strictEqual(f['body_values[1]'], quote.ref);
    assert.strictEqual(f['body_values[2]'], 'أحمد');
    assert.strictEqual(f['body_values[3]'], '96899123456');
    assert.strictEqual(f['body_values[4]'], 'الداخلية - نزوى');
    assert.match(f['body_values[5]'], /^رولينج شتر الإيراني Grade C بيج \/ /);
    assert.strictEqual(f['body_values[6]'], '300x250 سم');
    assert.strictEqual(f['body_values[7]'], `${quote.total.toFixed(3)} ريال عماني شامل الضريبة`);
    assert.ok(!('body_values[8]' in f));

    await waitFor(() => app.db.prepare('SELECT notify_status FROM quotes').get().notify_status);
    assert.strictEqual(app.db.prepare('SELECT notify_status FROM quotes').get().notify_status, 'تم الإرسال 2/2');

    // Pressing again with the same data: same quote, no second message
    const again = await app.post('/api/public/door-quotes', app.door);
    assert.strictEqual(again.status, 200);
    assert.strictEqual((await again.json()).ref, quote.ref);
    // A change is a new request
    const changed = await (await app.post('/api/public/door-quotes', { ...app.door, width_cm: 320 })).json();
    assert.notStrictEqual(changed.ref, quote.ref);
    await waitFor(() => fake.calls.filter((c) => c.form).length === 4);
    assert.strictEqual(fake.calls.filter((c) => c.form).length, 4);
    assert.strictEqual(fake.calls.filter((c) => c.path === '/api/login').length, 1); // token reused
});

test('an expired token logs in again once; admin test message and status', async (t) => {
    const fake = await fakeMazbot({ expireFirstToken: true });
    const app = await startApp();
    t.after(() => { fake.server.close(); app.server.close(); });

    const status = await (await fetch(app.base + '/api/admin/mazbot/status', { headers: { Authorization: 'Bearer test-token' } })).json();
    assert.deepStrictEqual(status, { configured: true, dry_run: false, recipients: ['96876979066', '96890660001'] });

    const r = await (await app.post('/api/admin/mazbot/test', {}, 'test-token')).json();
    assert.strictEqual(r.sent, 2);
    assert.strictEqual(fake.calls.filter((c) => c.path === '/api/login').length, 2);
    assert.strictEqual((await app.post('/api/admin/mazbot/test', {})).status, 401);
});
