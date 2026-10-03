const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const PDFDocument = require('pdfkit');
const { openDatabase, saveSettings, getSettings } = require('../src/db');
const { createApp } = require('../src/server');
const agent = require('../src/agent');
const knowledge = require('../src/knowledge');

process.env.ADMIN_TOKEN = 'test-token';

async function start() {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, headers = {}) => {
        const res = await fetch(base + url, {
            method, headers: { Authorization: 'Bearer test-token', ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { db, server, call };
}

const pdfOf = (text) => new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.text(text);
    doc.end();
});

test('admin manages FAQs and documents; uploaded PDF and text become knowledge items', async (t) => {
    const { server, call } = await start();
    t.after(() => server.close());
    assert.strictEqual((await call('GET', '/api/admin/knowledge', null, { Authorization: 'Bearer x' })).status, 401);

    let r = await call('POST', '/api/admin/knowledge', { kind: 'faq', title: 'هل المعاينة مجانية؟', content: 'نعم داخل نزوى.' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.items.length, 1);
    assert.strictEqual(r.body.mode, 'full');
    assert.strictEqual((await call('POST', '/api/admin/knowledge', { kind: 'faq', title: 'سؤال', content: '' })).status, 400);

    r = await call('POST', '/api/admin/knowledge/upload', await pdfOf('Warranty: 5 years on manufacturing defects.'),
        { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('الضمان.pdf') });
    assert.strictEqual(r.status, 201);
    const doc = r.body.items.find((i) => i.kind === 'document');
    assert.strictEqual(doc.title, 'الضمان');
    assert.match(doc.content, /Warranty: 5 years/);

    r = await call('POST', '/api/admin/knowledge/upload', Buffer.from('طرق الدفع: نقداً أو تحويل بنكي'),
        { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('الدفع.txt') });
    assert.strictEqual(r.body.items.length, 3);
    assert.strictEqual((await call('POST', '/api/admin/knowledge/upload', Buffer.from('x'),
        { 'Content-Type': 'application/octet-stream', 'X-Filename': 'image.png' })).status, 400);

    // Edit, disable, delete
    const faq = r.body.items.find((i) => i.kind === 'faq');
    r = await call('PUT', `/api/admin/knowledge/${faq.id}`, { content: 'نعم، المعاينة مجانية داخل نزوى وبهلاء.' });
    assert.match(r.body.items.find((i) => i.id === faq.id).content, /بهلاء/);
    r = await call('PUT', `/api/admin/knowledge/${faq.id}`, { active: false });
    assert.strictEqual(r.body.items.find((i) => i.id === faq.id).active, 0);
    r = await call('DELETE', `/api/admin/knowledge/${doc.id}`);
    assert.strictEqual(r.body.items.length, 2);
});

test('the agent gets the guidelines and the knowledge base; a large base is searched with a tool', async () => {
    const db = openDatabase(':memory:');
    saveSettings(db, { agent_instructions: 'رحّب بالعميل باسم ردما دائماً.' });
    knowledge.add(db, { kind: 'faq', title: 'هل المعاينة مجانية؟', content: 'نعم، المعاينة مجانية داخل نزوى.' });
    knowledge.add(db, { kind: 'info', title: 'معلومة معطلة', content: 'لا تظهر', active: false });

    let prompt = agent.systemPrompt(getSettings(db), db);
    assert.match(prompt, /توجيهات الإدارة[^]*رحّب بالعميل باسم ردما/);
    assert.match(prompt, /قاعدة المعرفة[^]*س: هل المعاينة مجانية؟\nج: نعم، المعاينة مجانية داخل نزوى/);
    assert.doesNotMatch(prompt, /معلومة معطلة/);

    // Large base: only titles in the prompt, the agent searches
    knowledge.add(db, { kind: 'document', title: 'دليل الصيانة', content: 'تنظيف المسارات كل ستة أشهر. ' + 'نص طويل. '.repeat(2500) });
    prompt = agent.systemPrompt(getSettings(db), db);
    assert.match(prompt, /search_knowledge/);
    assert.match(prompt, /- مستند: دليل الصيانة/);
    assert.doesNotMatch(prompt, /تنظيف المسارات/);
    const found = await agent.executeTool('search_knowledge', { query: 'هل المعاينه مجانيه في نزوى' }, { db });
    assert.strictEqual(found.results[0].title, 'هل المعاينة مجانية؟');
    const none = await agent.executeTool('search_knowledge', { query: 'xyz' }, { db });
    assert.deepStrictEqual(none.results, []);
});
