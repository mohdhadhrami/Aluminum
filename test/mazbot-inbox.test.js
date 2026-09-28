const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const inbox = require('../src/mazbot-inbox');
const mazbot = require('../src/mazbot');
const overhead = require('../src/overhead');

process.env.ADMIN_TOKEN = 'test-token';

/* Fake MazBot API: records sent messages */
async function fakeMazbot() {
    const sent = [];
    const resolved = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/login') return res.end(JSON.stringify({ data: { token: 'jwt' } }));
        if (req.url === '/api/contact/resolve-by-phone') {
            resolved.push(JSON.parse(raw).phone);
            return res.end(JSON.stringify({ data: { receiver_id: 900 + resolved.length } }));
        }
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
        sent.push({ path: req.url, ...Object.fromEntries(form.entries()) });
        res.end(JSON.stringify({ success: true }));
    });
    await new Promise((r) => server.listen(0, r));
    Object.assign(process.env, {
        MAZBOT_BASE_URL: `http://127.0.0.1:${server.address().port}/api`,
        MAZBOT_API_KEY: 'k', MAZBOT_STAFF_EMAIL: 's@example.com', MAZBOT_STAFF_PASSWORD: 'p', ANTHROPIC_API_KEY: 'test'
    });
    delete process.env.MAZBOT_TEMPLATE_ID;
    delete process.env.MAZBOT_OVERHEAD_TEMPLATE_ID;
    mazbot._reset();
    return { server, sent, resolved };
}

function fakeClient(script) {
    return { beta: { messages: { create: async (params) => script.shift()(params) } } };
}
const toolUse = (id, name, input) => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
const say = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

let n = 0;
const incoming = (value, type = 'message.received') => ({
    id: 'evt-' + (++n), type, created_at: '2026-09-28T22:06:50+03:00', client_id: 1136,
    data: { contact: { id: 1376829, phone: '96899887897', name: 'محمد' }, message: { id: 14700000 + n, message_type: 'text', value, meta_type: 'text' } }
});

function store(db, event) {
    return Number(db.prepare("INSERT INTO inbound_events (source, method, body) VALUES ('mazbot', 'POST', ?)").run(JSON.stringify(event)).lastInsertRowid);
}
const statusOf = (db, id) => db.prepare('SELECT status FROM inbound_events WHERE id = ?').get(id).status;

function setup() {
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_agent_enabled: true });
    const ctx = (client) => ({ saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, baseUrl: 'https://calcshutter.radma.co', client });
    return { db, ctx };
}

test('a customer message is answered by the agent through MazBot, with overhead prices', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    const { db, ctx } = setup();
    const { motors } = overhead.loadOverhead(db);
    const nizwa = db.prepare("SELECT id FROM regions WHERE name = 'نزوى'").get().id;
    const input = { gate_type: 'Type A', width_cm: 415, height_cm: 250, motor_id: motors[0].id, region_id: nizwa };

    let toolResult = null;
    const client = fakeClient([
        () => toolUse('t1', 'calculate_overhead_price', input),
        (params) => { toolResult = JSON.parse(params.messages.at(-1).content[0].content); return say('سعر بوابة الأوفرهيد من 609 إلى 630 ر.ع'); }
    ]);
    const event = incoming('كم سعر أوفرهيد 4 متر في نزوى؟');
    const id = store(db, event);
    await inbox.handleEvent(db, id, event, ctx(client));

    assert.strictEqual(toolResult.total_with_vat_from, 609);
    assert.strictEqual(toolResult.total_with_vat_to, 630);
    assert.deepStrictEqual(fake.sent.map((s) => [s.path, s.receiver_id, s.message]),
        [['/api/send-message', '1376829', 'سعر بوابة الأوفرهيد من 609 إلى 630 ر.ع']]);
    assert.strictEqual(statusOf(db, id), 'replied');

    // MazBot retries the same message: no second answer
    const again = store(db, event);
    assert.strictEqual(inbox.handleEvent(db, again, event, ctx(fakeClient([]))), null);
    assert.strictEqual(statusOf(db, again), 'duplicate');
});

test('an agent quote sends the PDF link; asking for a person pauses the agent and alerts sales', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    const { db, ctx } = setup();
    // Even when the admin put the company website here, PDF links must point at this system
    saveSettings(db, { public_base_url: 'https://radma.co' });
    const { motors } = overhead.loadOverhead(db);
    const nizwa = db.prepare("SELECT id FROM regions WHERE name = 'نزوى'").get().id;

    const e1 = incoming('نعم أريد عرض سعر، اسمي محمد');
    const id1 = store(db, e1);
    await inbox.handleEvent(db, id1, e1, ctx(fakeClient([
        () => toolUse('t1', 'create_overhead_quote', { gate_type: 'Type B', width_cm: 440, height_cm: 250, motor_id: motors[2].id, region_id: nizwa, customer_name: 'محمد', notes: null }),
        () => say('تم تجهيز عرض السعر ✅')
    ])));
    const quote = db.prepare("SELECT * FROM quotes WHERE source = 'mazbot'").get();
    assert.ok(quote, 'quote saved with source mazbot');
    assert.strictEqual(quote.customer_phone, '96899887897');
    assert.match(fake.sent[1].message, new RegExp(`${quote.ref}\\r?\\nhttps://calcshutter\\.radma\\.co/quotes/${quote.ref}\\.pdf\\?k=`));

    const e2 = incoming('أريد التحدث مع موظف');
    const id2 = store(db, e2);
    await inbox.handleEvent(db, id2, e2, ctx(fakeClient([
        () => toolUse('t2', 'request_human', { summary: 'العميل يريد موعد معاينة' }),
        () => say('سيتواصل معك فريق المبيعات قريباً')
    ])));
    assert.deepStrictEqual(fake.resolved, ['96876979066', '96890660001']); // both sales numbers alerted
    const alerts = fake.sent.filter((m) => ['901', '902'].includes(m.receiver_id));
    assert.strictEqual(alerts.length, 2);
    assert.match(alerts[0].message, /العميل يريد موعد معاينة/);
    assert.strictEqual(fake.sent.at(-1).message, 'سيتواصل معك فريق المبيعات قريباً');

    const e3 = incoming('متى يتصلون؟');
    const id3 = store(db, e3);
    const before = fake.sent.length;
    await inbox.handleEvent(db, id3, e3, ctx(fakeClient([])));
    assert.strictEqual(statusOf(db, id3), 'paused: with sales team');
    assert.strictEqual(fake.sent.length, before);
});

test('agent off, other event types and non-text messages', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    const { db, ctx } = setup();

    const other = { id: 'x', type: 'appointment.created', data: {} };
    const idOther = store(db, other);
    inbox.handleEvent(db, idOther, other, ctx());
    assert.strictEqual(statusOf(db, idOther), 'ignored: appointment.created');

    const image = incoming('');
    image.data.message.message_type = 'image';
    image.data.message.meta_type = 'image';
    const idImg = store(db, image);
    await inbox.handleEvent(db, idImg, image, ctx(fakeClient([])));
    assert.match(fake.sent.at(-1).message, /النصوص|النصية/);

    saveSettings(db, { mazbot_agent_enabled: false });
    const e = incoming('مرحبا');
    const id = store(db, e);
    assert.strictEqual(inbox.handleEvent(db, id, e, ctx()), null);
    assert.strictEqual(statusOf(db, id), 'agent_off');
});

test('the webhook checks X-Mazbot-Signature when the signing secret is set', async (t) => {
    process.env.MAZBOT_WEBHOOK_SECRET = 'abcdefghijklmnop1234';
    process.env.MAZBOT_SIGNING_SECRET = 'sign-secret';
    t.after(() => { delete process.env.MAZBOT_WEBHOOK_SECRET; delete process.env.MAZBOT_SIGNING_SECRET; });
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/webhooks/mazbot/abcdefghijklmnop1234`;
    const body = JSON.stringify({ id: 'e', type: 'user.registered', data: {} });
    const post = (sig) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Mazbot-Signature': sig } : {}) }, body });

    assert.strictEqual((await post(null)).status, 401);
    assert.strictEqual((await post('sha256=deadbeef')).status, 401);
    const hex = crypto.createHmac('sha256', 'sign-secret').update(body).digest('hex');
    assert.strictEqual((await post(hex)).status, 200);
    assert.strictEqual((await post('sha256=' + hex)).status, 200);
    const statuses = db.prepare('SELECT status FROM inbound_events ORDER BY id').all().map((r) => r.status);
    assert.deepStrictEqual(statuses.slice(0, 2), ['bad_signature', 'bad_signature']);

    assert.ok(mazbot.verifySignature(body, crypto.createHmac('sha256', 'sign-secret').update(body).digest('base64'), 'sign-secret'));
    const ts = '1700000000';
    assert.ok(mazbot.verifySignature(body, `t=${ts},v1=${crypto.createHmac('sha256', 'sign-secret').update(ts + '.' + body).digest('hex')}`, 'sign-secret'));
});

test('with OPENAI_API_KEY the agent runs on OpenAI (same tools and prices) and replies through MazBot', async (t) => {
    const fake = await fakeMazbot();
    const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    t.after(() => {
        fake.server.close();
        delete process.env.OPENAI_API_KEY;
        if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
    });
    const agent = require('../src/agent');
    assert.strictEqual(agent.provider(), 'openai');
    assert.ok(agent.isConfigured());

    const { db, ctx } = setup();
    const { motors } = overhead.loadOverhead(db);
    const nizwa = db.prepare("SELECT id FROM regions WHERE name = 'نزوى'").get().id;
    const requests = [];
    const client = { chat: { completions: { create: async (params) => {
        requests.push(structuredClone(params));
        if (requests.length === 1) {
            return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{
                id: 'call_1', type: 'function',
                function: { name: 'calculate_overhead_price', arguments: JSON.stringify({ gate_type: 'Type A', width_cm: 415, height_cm: 250, motor_id: motors[0].id, region_id: nizwa }) }
            }] } }] };
        }
        return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'السعر من 609 إلى 630 ر.ع' } }] };
    } } } };

    const event = incoming('كم سعر الأوفرهيد؟');
    const id = store(db, event);
    await inbox.handleEvent(db, id, event, ctx(client));

    assert.strictEqual(statusOf(db, id), 'replied');
    assert.strictEqual(fake.sent.at(-1).message, 'السعر من 609 إلى 630 ر.ع');
    // The system prompt and every tool are sent in OpenAI's format
    assert.strictEqual(requests[0].messages[0].role, 'system');
    assert.ok(requests[0].tools.every((x) => x.type === 'function' && x.function.strict === true));
    assert.ok(requests[0].tools.some((x) => x.function.name === 'create_overhead_quote'));
    const toolMsg = requests[1].messages.find((m) => m.role === 'tool');
    assert.strictEqual(JSON.parse(toolMsg.content).total_with_vat_to, 630);
    // History is stored per provider
    assert.ok(db.prepare("SELECT 1 FROM agent_conversations WHERE conversation_key = 'oa:mz:96899887897'").get());
});
