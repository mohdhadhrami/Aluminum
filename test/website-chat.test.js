const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const overhead = require('../src/overhead');

process.env.ADMIN_TOKEN = 'test-token';

async function start(agentClient) {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db, { agentClient }));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const chat = (body) => fetch(base + '/api/public/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { db, server, base, chat };
}

const SESSION = 'a1b2c3d4-e5f6-4711-9abc-def012345678';

test('the website chat is off until enabled, and the chat page may be embedded in the company site', async (t) => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    t.after(() => { if (saved) process.env.OPENAI_API_KEY = saved; else delete process.env.OPENAI_API_KEY; });
    const { db, server, base, chat } = await start();
    t.after(() => server.close());

    const off = await fetch(base + '/api/public/chat/config');
    assert.strictEqual(off.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual((await off.json()).enabled, false);
    assert.strictEqual((await chat({ session_id: SESSION, message: 'مرحبا' })).status, 503);

    saveSettings(db, { website_chat_enabled: true });
    const on = await (await fetch(base + '/api/public/chat/config')).json();
    assert.strictEqual(on.enabled, true);
    assert.match(on.greeting, /المساعد الذكي/);
    assert.strictEqual((await chat({ session_id: 'bad', message: 'مرحبا' })).status, 400);
    assert.strictEqual((await chat({ session_id: SESSION, message: '   ' })).status, 400);

    const page = await fetch(base + '/chat');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/radma\.co/);
    assert.strictEqual((await fetch(base + '/chat-widget.js')).status, 200);
});

test('website visitors get prices and a quote; the agent must ask for the mobile number first', async (t) => {
    const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    t.after(() => {
        if (saved.o) process.env.OPENAI_API_KEY = saved.o; else delete process.env.OPENAI_API_KEY;
        if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
    });

    let db;
    const toolResults = [];
    const replies = [];
    const client = { chat: { completions: { create: async (params) => {
        const last = params.messages.at(-1);
        if (last.role === 'tool') {
            toolResults.push(JSON.parse(last.content));
            return { choices: [{ message: { role: 'assistant', content: replies.shift() } }] };
        }
        const { motors } = overhead.loadOverhead(db);
        const nizwa = db.prepare("SELECT id FROM regions WHERE name = 'نزوى'").get().id;
        const phone = /\d{8}/.test(last.content) ? last.content.match(/\d{8}/)[0] : null;
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
            id: 'c' + toolResults.length, type: 'function',
            function: { name: 'create_overhead_quote', arguments: JSON.stringify({
                gate_type: 'Type A', width_cm: 415, height_cm: 250, motor_id: motors[0].id, region_id: nizwa,
                customer_name: 'زائر', customer_phone: phone, notes: null
            }) }
        }] } }] };
    } } } };

    const app = await start(client);
    db = app.db;
    t.after(() => app.server.close());
    saveSettings(db, { website_chat_enabled: true });

    replies.push('أحتاج رقم جوالك لإرسال عرض السعر');
    const first = await (await app.chat({ session_id: SESSION, message: 'أريد عرض سعر أوفرهيد' })).json();
    assert.match(toolResults[0].error, /رقم جوال العميل مطلوب/);
    assert.deepStrictEqual(first.quotes, []);

    replies.push('تم تجهيز عرض السعر ✅');
    const second = await (await app.chat({ session_id: SESSION, message: 'رقمي 99887766' })).json();
    assert.strictEqual(second.reply, 'تم تجهيز عرض السعر ✅');
    assert.strictEqual(second.quotes.length, 1);
    assert.strictEqual(second.quotes[0].total, 609);
    assert.strictEqual(second.quotes[0].total_to, 630);
    assert.match(second.quotes[0].pdf_url, /^http:\/\/127\.0\.0\.1:\d+\/quotes\/Q.+\.pdf\?k=/);
    const quote = db.prepare("SELECT * FROM quotes WHERE source = 'website'").get();
    assert.strictEqual(quote.customer_phone, '96899887766');
    // The PDF link works
    assert.strictEqual((await fetch(second.quotes[0].pdf_url)).status, 200);
});
