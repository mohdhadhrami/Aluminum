const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

process.env.ADMIN_TOKEN = 'test-token';

async function start() {
    const server = http.createServer(createApp(openDatabase(':memory:')));
    await new Promise((r) => server.listen(0, r));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('home page is the public calculator; admin panel is at /admin', async (t) => {
    const { server, base } = await start();
    t.after(() => server.close());

    const home = await fetch(base + '/');
    assert.strictEqual(home.status, 200);
    assert.match(await home.text(), /حاسبة أسعار بوابات رولينج شتر/);

    const admin = await fetch(base + '/admin');
    assert.strictEqual(admin.status, 200);
    assert.match(await admin.text(), /لوحة إدارة الأسعار/);

    const old = await fetch(base + '/index.html', { redirect: 'manual' });
    assert.strictEqual(old.status, 301);
    assert.strictEqual(old.headers.get('location'), '/admin');

    assert.strictEqual((await fetch(base + '/embed.js')).status, 200);

    const overhead = await fetch(base + '/overhead');
    assert.strictEqual(overhead.status, 200);
    assert.match(await overhead.text(), /حاسبة أسعار بوابات الأوفرهيد/);
    assert.match(overhead.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/radma\.co/);
});

test('only the customer pages can be framed, and only by the allowed sites', async (t) => {
    const { server, base } = await start();
    t.after(() => server.close());

    const calc = await fetch(base + '/');
    assert.match(calc.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/radma\.co https:\/\/www\.radma\.co/);
    assert.strictEqual(calc.headers.get('x-frame-options'), null);

    for (const path of ['/admin', '/api/admin/settings', '/api/public/configurator']) {
        const res = await fetch(base + path);
        assert.strictEqual(res.headers.get('content-security-policy'), "frame-ancestors 'none'", path);
        assert.strictEqual(res.headers.get('x-frame-options'), 'DENY', path);
    }
});

test('PDFs, API data and pages are never served stale by a CDN', async (t) => {
    const { server, base } = await start();
    t.after(() => server.close());
    const health = await fetch(base + '/healthz');
    assert.strictEqual(health.headers.get('cache-control'), 'no-store');
    assert.strictEqual((await health.json()).version, require('../package.json').version);
    assert.strictEqual((await fetch(base + '/api/public/configurator')).headers.get('cache-control'), 'no-store');
    assert.strictEqual((await fetch(base + '/quotes/X.pdf?k=y')).headers.get('cache-control'), 'no-store');
    assert.strictEqual((await fetch(base + '/')).headers.get('cache-control'), 'no-cache');
    assert.strictEqual((await fetch(base + '/admin.js')).headers.get('cache-control'), 'no-cache');
});

test('admin API locks an IP out after repeated wrong passwords', async (t) => {
    const { server, base } = await start();
    t.after(() => server.close());
    const call = (token) => fetch(base + '/api/admin/settings', { headers: { Authorization: 'Bearer ' + token } });

    assert.strictEqual((await call('test-token')).status, 200);
    for (let i = 0; i < 10; i++) assert.strictEqual((await call('wrong')).status, 401);
    const locked = await call('test-token'); // even the right password waits out the lockout
    assert.strictEqual(locked.status, 429);

    // The public calculator keeps working without any password
    assert.strictEqual((await fetch(base + '/api/public/configurator')).status, 200);
});

test('admin shows a warning when DB_FILE or important keys are missing', async (t) => {
    const saved = { db: process.env.DB_FILE, o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY };
    delete process.env.DB_FILE; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    t.after(() => {
        for (const [k, v] of [['DB_FILE', saved.db], ['OPENAI_API_KEY', saved.o], ['ANTHROPIC_API_KEY', saved.a]]) {
            if (v) process.env[k] = v; else delete process.env[k];
        }
    });
    const { server, base } = await start();
    t.after(() => server.close());
    const get = () => fetch(base + '/api/admin/system-status', { headers: { Authorization: 'Bearer test-token' } }).then((r) => r.json());

    let s = await get();
    assert.strictEqual(s.warnings[0].level, 'danger');
    assert.match(s.warnings[0].text, /DB_FILE/);
    assert.match(s.warnings[1].text, /OPENAI_API_KEY/);

    process.env.DB_FILE = '~/radma-data/aluminum.db';
    s = await get();
    assert.ok(!s.warnings.some((w) => w.level === 'danger'));
    assert.strictEqual((await fetch(base + '/api/admin/system-status')).status, 401);
});
