const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const doors = require('../src/doors');
const agent = require('../src/agent');

process.env.ADMIN_TOKEN = 'test-token';

/* Stands in for the Anthropic client: returns scripted responses in order */
function fakeClient(script) {
    const calls = [];
    return {
        calls,
        beta: { messages: { create: async (params) => { calls.push(structuredClone(params)); return script.shift()(params); } } }
    };
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });

test('door price range covers cheapest to dearest package, and final price adds chosen extras', () => {
    const db = openDatabase(':memory:');
    const [seeb] = doors.findRegions(db, 'السيب');
    assert.strictEqual(seeb.name, 'السيب');
    db.prepare('UPDATE regions SET delivery_fee = 10, installation_fee = 15 WHERE id = ?').run(seeb.id);

    const size = { widthCm: 300, heightCm: 250, count: 1 };
    const range = doors.priceRange(db, { ...size, doorType: 'كهربائي', regionId: seeb.id });
    assert.ok(range.available);
    assert.ok(range.from < range.to);
    assert.strictEqual(range.delivery_installation, 'شاملة التوصيل والتركيب');

    const [pkg] = doors.comparePackages(db, { ...size, doorType: 'كهربائي', regionId: seeb.id });
    const extra = pkg.optional_extras[0];
    const base = doors.finalPrice(db, { ...size, packageId: pkg.package_id, regionId: seeb.id });
    const withExtra = doors.finalPrice(db, { ...size, packageId: pkg.package_id, optionalItemIds: [extra.optional_item_id], regionId: seeb.id });
    assert.strictEqual(base.total, pkg.base_price_with_vat);
    assert.ok(Math.abs(withExtra.total - base.total - extra.adds_with_vat) < 0.02);
    assert.ok(base.items.some((i) => i.name === 'توصيل' && i.line_total === 10));
    assert.strictEqual(base.items[0].quantity, 97.5); // 3 m × 2.5 m × 13

    // Too large for every electric package's max area → no quote, not a guess
    assert.strictEqual(doors.priceRange(db, { widthCm: 1000, heightCm: 900, count: 1, doorType: 'كهربائي' }).available, false);
});

test('agent runs tools, prices from the database and creates a quote with a PDF', async (t) => {
    const db = openDatabase(':memory:');
    const [pkg] = doors.comparePackages(db, { widthCm: 300, heightCm: 250, count: 1, doorType: 'كهربائي', regionId: null });

    const client = fakeClient([
        () => ({ stop_reason: 'tool_use', content: [toolUse('t1', 'get_price_range', { width_cm: 300, height_cm: 250, door_count: 1, door_type: 'كهربائي', region_id: null })] }),
        (params) => {
            const result = JSON.parse(params.messages.at(-1).content[0].content);
            return { stop_reason: 'end_turn', content: [text(`السعر من ${result.from} إلى ${result.to} ر.ع`)] };
        },
        () => ({ stop_reason: 'tool_use', content: [toolUse('t2', 'create_quote', {
            width_cm: 300, height_cm: 250, door_count: 1, package_id: pkg.package_id, optional_item_ids: [],
            region_id: null, customer_name: 'سالم', notes: null
        })] }),
        () => ({ stop_reason: 'end_turn', content: [text('تم تجهيز عرض السعر')] })
    ]);

    const ctx = { db, key: 'wa:96891234567', channel: 'whatsapp', phone: '96891234567', createQuote: (q) => saveQuote(db, q), notifyHuman: async () => {}, client };
    const first = await agent.chat({ ...ctx, text: 'أبغى باب رول شتر كهربائي 300 في 250' });
    const range = doors.priceRange(db, { widthCm: 300, heightCm: 250, count: 1, doorType: 'كهربائي' });
    assert.strictEqual(first.reply, `السعر من ${range.from} إلى ${range.to} ر.ع`);

    const second = await agent.chat({ ...ctx, text: 'اسمي سالم، أرسل العرض' });
    assert.strictEqual(second.events[0].type, 'quote_created');
    const quote = second.events[0].quote;
    assert.strictEqual(quote.total, pkg.base_price_with_vat);
    assert.strictEqual(quote.source, 'whatsapp');
    assert.strictEqual(quote.details.width_cm, 300);

    // Conversation history persisted and replayed (append-only) on the second message
    const secondCall = client.calls[2];
    assert.strictEqual(secondCall.messages[0].content, 'أبغى باب رول شتر كهربائي 300 في 250');
    assert.strictEqual(secondCall.messages.at(-1).content, 'اسمي سالم، أرسل العرض');
    assert.ok(secondCall.tools.every((tool) => tool.strict === true));

    // PDF is reachable only with the secret key
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const pdf = await fetch(base + quote.pdf_url);
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
    assert.strictEqual((await pdf.arrayBuffer()).byteLength > 5000, true);
    assert.strictEqual((await fetch(`${base}/quotes/${quote.ref}.pdf?k=wrong`)).status, 404);
});

test('tool errors are returned to the model instead of crashing the conversation', async () => {
    const db = openDatabase(':memory:');
    const client = fakeClient([
        () => ({ stop_reason: 'tool_use', content: [toolUse('t1', 'get_price_range', { width_cm: 5, height_cm: 250, door_count: 1, door_type: 'يدوي', region_id: null })] }),
        (params) => {
            const r = params.messages.at(-1).content[0];
            assert.strictEqual(r.is_error, true);
            return { stop_reason: 'end_turn', content: [text('المقاس غير صحيح، هل تقصد 500 سم؟')] };
        }
    ]);
    const out = await agent.chat({ db, key: 'test:x', channel: 'agent-test', phone: '968', text: 'باب عرض 5', createQuote: () => {}, notifyHuman: async () => {}, client });
    assert.match(out.reply, /500/);
});

test('a refused turn is not stored, so the next message starts from valid history', async () => {
    const db = openDatabase(':memory:');
    const client = fakeClient([
        () => ({ stop_reason: 'refusal', content: [] }),
        (params) => {
            assert.strictEqual(params.messages.length, 1);
            return { stop_reason: 'end_turn', content: [text('أهلاً')] };
        }
    ]);
    const ctx = { db, key: 'test:r', channel: 'agent-test', phone: '968', createQuote: () => {}, notifyHuman: async () => {}, client };
    await agent.chat({ ...ctx, text: 'x' });
    assert.strictEqual((await agent.chat({ ...ctx, text: 'مرحبا' })).reply, 'أهلاً');
});
