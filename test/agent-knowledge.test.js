const test = require('node:test');
const assert = require('node:assert');
const { openDatabase, saveSettings, getSettings } = require('../src/db');
const agent = require('../src/agent');

test('the agent answers general questions from the company information set in the admin panel', async (t) => {
    const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    t.after(() => {
        if (saved.o) process.env.OPENAI_API_KEY = saved.o; else delete process.env.OPENAI_API_KEY;
        if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
    });
    const db = openDatabase(':memory:');
    saveSettings(db, { agent_knowledge: 'أوقات العمل: من السبت إلى الخميس، 8 صباحاً – 6 مساءً.', company_address: 'نزوى – سعال' });

    let system = '';
    const client = { chat: { completions: { create: async (params) => {
        system = params.messages[0].content;
        return { choices: [{ message: { role: 'assistant', content: 'نعمل من السبت إلى الخميس، 8 صباحاً – 6 مساءً.' } }] };
    } } } };
    const r = await agent.chat({ db, key: 'test:1', channel: 'mazbot', phone: '96899887766', text: 'ما أوقات العمل؟',
        createQuote: () => null, notifyHuman: async () => {}, client });

    assert.match(system, /معلومات الشركة/);
    assert.match(system, /أوقات العمل: من السبت إلى الخميس/);
    assert.match(system, /العنوان: نزوى – سعال/);
    assert.match(r.reply, /السبت/);

    // Empty information: the agent is told to hand general questions to the sales team
    saveSettings(db, { agent_knowledge: '', company_phone: '', company_address: '', company_website: '' });
    assert.match(agent.systemPrompt(getSettings(db)), /حوّل الأسئلة العامة إلى فريق المبيعات/);
});
