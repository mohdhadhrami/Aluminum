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

const omani = (db) => doors.publicCatalog(db).shutter_types.find((t) => t.name.includes('العماني'));
const size = { widthCm: 300, heightCm: 250, count: 1 };

test('wilayat list follows the governorate, and disabled governorates disappear', () => {
    const db = openDatabase(':memory:');
    const dakhiliyah = doors.locations(db).find((g) => g.name === 'الداخلية');
    assert.ok(dakhiliyah.wilayat.some((w) => w.name === 'نزوى'));
    assert.ok(dakhiliyah.wilayat.every((w) => !['صحار', 'مسقط'].includes(w.name)));

    db.prepare("UPDATE governorates SET active = 0 WHERE name = 'الداخلية'").run();
    assert.strictEqual(doors.locations(db).some((g) => g.name === 'الداخلية'), false);
    const [nizwa] = db.prepare("SELECT * FROM regions WHERE name = 'نزوى'").all();
    assert.strictEqual(doors.getRegion(db, nizwa.id), null); // cannot be quoted either
});

test('door price: thickness, class per accessory group and installation by wilayah', () => {
    const db = openDatabase(':memory:');
    const [nizwa] = doors.findRegions(db, 'نزوى');
    db.prepare('UPDATE regions SET installation_fee = 20 WHERE id = ?').run(nizwa.id);
    const type = omani(db);
    const cmp = doors.compareOptions(db, { ...size, shutterTypeId: type.id });
    assert.strictEqual(cmp.thickness_options.length, 2); // 1.1 and 1.5 mm

    const classB = cmp.accessories.map((g) => g.classes[1].option_id);
    const priced = doors.finalPrice(db, { ...size, shutterTypeId: type.id, variantId: cmp.thickness_options[1].variant_id,
        colorId: type.colors[0].id, optionIds: classB, regionId: nizwa.id });
    assert.strictEqual(priced.items[0].quantity, 97.5); // 3 m × 2.5 m × 13 m per m²
    assert.ok(priced.items.some((i) => i.name === 'التركيب' && i.line_total === 20));
    assert.ok(priced.spec.some(([k, v]) => k === 'اللون' && v === type.colors[0].name));
    assert.strictEqual(priced.delivery_installation, 'شامل التركيب');

    // Every accessory class choice changes the price by exactly the compared amount
    const classA = cmp.accessories.map((g) => g.classes[0].option_id);
    const cheaper = doors.finalPrice(db, { ...size, shutterTypeId: type.id, variantId: cmp.thickness_options[1].variant_id,
        colorId: type.colors[0].id, optionIds: classA, regionId: nizwa.id });
    const expected = cmp.accessories.reduce((s, g) => s + g.classes[1].price_with_vat - g.classes[0].price_with_vat, 0);
    assert.ok(Math.abs(priced.total - cheaper.total - expected) < 0.05);

    // A required group cannot be skipped; the motor group can ("بدون محرك")
    const withoutChannels = classB.slice(1);
    assert.throws(() => doors.finalPrice(db, { ...size, shutterTypeId: type.id, variantId: cmp.thickness_options[0].variant_id, optionIds: withoutChannels }), /اختر نوع/);
    const withoutMotor = classB.slice(0, -1);
    assert.ok(doors.finalPrice(db, { ...size, shutterTypeId: type.id, variantId: cmp.thickness_options[0].variant_id, optionIds: withoutMotor }).total > 0);
});

test('price range spans the cheapest to the dearest configuration', () => {
    const db = openDatabase(':memory:');
    const type = omani(db);
    const range = doors.priceRange(db, { ...size, shutterTypeId: type.id });
    const cmp = doors.compareOptions(db, { ...size, shutterTypeId: type.id });
    const dearest = doors.finalPrice(db, { ...size, shutterTypeId: type.id, variantId: cmp.thickness_options[1].variant_id,
        colorId: type.colors[0].id, optionIds: cmp.accessories.map((g) => g.classes[2].option_id) });
    assert.ok(range.from < range.to);
    assert.strictEqual(range.to, dearest.total);
    assert.strictEqual(doors.priceRange(db, size).by_type.length, 3); // all types when none chosen
});

test('agent runs tools, prices from the database and creates a quote with a PDF', async (t) => {
    const db = openDatabase(':memory:');
    const type = omani(db);
    const cmp = doors.compareOptions(db, { ...size, shutterTypeId: type.id });
    const choice = {
        width_cm: 300, height_cm: 250, door_count: 1, shutter_type_id: type.id, variant_id: cmp.thickness_options[0].variant_id,
        color_id: type.colors[1].id, option_ids: cmp.accessories.map((g) => g.classes[0].option_id), region_id: null
    };

    const client = fakeClient([
        () => ({ stop_reason: 'tool_use', content: [toolUse('t1', 'get_price_range', { width_cm: 300, height_cm: 250, door_count: 1, shutter_type_id: type.id, region_id: null })] }),
        (params) => {
            const result = JSON.parse(params.messages.at(-1).content[0].content);
            return { stop_reason: 'end_turn', content: [text(`السعر من ${result.from} إلى ${result.to} ر.ع`)] };
        },
        () => ({ stop_reason: 'tool_use', content: [toolUse('t2', 'create_quote', { ...choice, customer_name: 'سالم', notes: null })] }),
        () => ({ stop_reason: 'end_turn', content: [text('تم تجهيز عرض السعر')] })
    ]);

    const ctx = { db, key: 'wa:96891234567', channel: 'whatsapp', phone: '96891234567', createQuote: (q) => saveQuote(db, q), notifyHuman: async () => {}, client };
    const first = await agent.chat({ ...ctx, text: 'أبغى بوابة شتر عماني 300 في 250' });
    const range = doors.priceRange(db, { ...size, shutterTypeId: type.id });
    assert.strictEqual(first.reply, `السعر من ${range.from} إلى ${range.to} ر.ع`);

    const second = await agent.chat({ ...ctx, text: 'اسمي سالم، أرسل العرض' });
    assert.strictEqual(second.events[0].type, 'quote_created');
    const quote = second.events[0].quote;
    const expected = doors.finalPrice(db, { ...size, shutterTypeId: type.id, variantId: choice.variant_id, colorId: choice.color_id, optionIds: choice.option_ids });
    assert.strictEqual(quote.total, expected.total);
    assert.strictEqual(quote.source, 'whatsapp');
    assert.ok(quote.details.spec.some(([k]) => k === 'نوع البوابة'));

    // Conversation history persisted and replayed (append-only) on the second message
    const secondCall = client.calls[2];
    assert.strictEqual(secondCall.messages[0].content, 'أبغى بوابة شتر عماني 300 في 250');
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
    assert.ok((await pdf.arrayBuffer()).byteLength > 5000);
    assert.strictEqual((await fetch(`${base}/quotes/${quote.ref}.pdf?k=wrong`)).status, 404);
});

test('public door quote requires name, mobile and wilayah, and prices on the server', async (t) => {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const conf = await (await fetch(base + '/api/public/configurator')).json();
    const type = conf.shutter_types.find((x) => x.variants.length === 1); // Iranian: no thickness choice
    const door = { width_cm: 300, height_cm: 250, count: 1, shutter_type_id: type.id, color_id: type.colors[0].id,
        option_ids: conf.accessory_groups.map((g) => g.options[0].id) };
    assert.ok(!JSON.stringify(conf).includes('purchase_price'));

    const live = await (await post('/api/public/door-price', door)).json();
    assert.ok(live.total > 0);

    const noRegion = await post('/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456' });
    assert.strictEqual(noRegion.status, 400);

    const wilayah = conf.locations[0].wilayat[0];
    const ok = await post('/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456', region_id: wilayah.id });
    const quote = await ok.json();
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(quote.total, live.total); // no installation fee set yet for this wilayah
    assert.match(quote.customer_city, new RegExp(wilayah.name));
    assert.ok(!('access_key' in quote));
});

test('tool errors are returned to the model instead of crashing the conversation', async () => {
    const db = openDatabase(':memory:');
    const client = fakeClient([
        () => ({ stop_reason: 'tool_use', content: [toolUse('t1', 'get_price_range', { width_cm: 5, height_cm: 250, door_count: 1, shutter_type_id: null, region_id: null })] }),
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
