/* =============================================================
   WhatsApp Cloud API (Meta) integration
   - Incoming:  GET/POST /webhooks/whatsapp  (verification + messages)
   - Outgoing:  text messages via the Graph API
   Configure with environment variables (see .env.example).
   ============================================================= */
const crypto = require('node:crypto');
const { getSettings } = require('./db');
const { unitSellPrice } = require('./pricing');
const agent = require('./agent');

const env = () => ({
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET,
    notifyTo: process.env.WHATSAPP_NOTIFY_TO,
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0'
});

const isConfigured = () => Boolean(env().token && env().phoneNumberId);

/* Normalise to international digits; 8-digit numbers are treated as Omani */
function normalizePhone(phone) {
    let digits = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
    if (digits.length === 8) digits = '968' + digits;
    return digits;
}

async function send(to, message) {
    const { token, phoneNumberId, apiVersion } = env();
    if (!isConfigured()) return { skipped: true };
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizePhone(to), ...message }),
        signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
    return res.json();
}

// WhatsApp caps a text message at 4096 characters
const sendText = (to, body) => send(to, { type: 'text', text: { preview_url: true, body: String(body).slice(0, 4096) } });

/* Send the quotation PDF as a WhatsApp document (Meta downloads it from our public URL) */
function sendQuotePdf(db, to, quote) {
    const base = getSettings(db).public_base_url.replace(/\/$/, '');
    if (!base) return Promise.resolve({ skipped: 'public_base_url غير مضبوط' });
    return send(to, {
        type: 'document',
        document: { link: base + quote.pdf_url, filename: `عرض-سعر-${quote.ref}.pdf`, caption: `عرض السعر رقم ${quote.ref}` }
    });
}

const UNIT_LABELS = { meter: 'متر', piece: 'قطعة', m2: 'م²', set: 'طقم', kg: 'كجم' };
const unitLabel = (u) => UNIT_LABELS[u] || u;

function priceListText(db) {
    const settings = getSettings(db);
    const products = db.prepare(`SELECT * FROM products WHERE active = 1 AND is_public = 1
                                 ORDER BY category, name, type`).all();
    const groups = { slat: '🔹 الشرائح', accessory: '🔸 الإكسسوارات', machine: '⚙️ المكائن' };
    const lines = [`*قائمة أسعار ${settings.company_name}*`, '(الأسعار بالريال العماني قبل الضريبة)', ''];
    for (const [cat, title] of Object.entries(groups)) {
        const rows = products.filter((p) => p.category === cat);
        if (!rows.length) continue;
        lines.push(`*${title}*`);
        for (const p of rows) {
            lines.push(`• ${p.name}${p.type ? ' — ' + p.type : ''}: ${unitSellPrice(p, settings).toFixed(2)} ر.ع / ${unitLabel(p.unit)}`);
        }
        lines.push('');
    }
    if (settings.public_base_url) {
        lines.push(`🧮 احسب عرض سعرك: ${settings.public_base_url.replace(/\/$/, '')}/calculator.html`);
    }
    return lines.join('\n');
}

function quoteText(quote, settings) {
    const lines = [`*عرض سعر رقم ${quote.ref}*`, `العميل: ${quote.customer_name} (${quote.customer_phone})`];
    if (quote.customer_city) lines.push(`المدينة: ${quote.customer_city}`);
    lines.push('');
    // Overhead gates are priced as a range (from – to, depending on the color)
    const range = (quote.details && quote.details.range) || {};
    const amount = (from, to) => (to != null && to !== from ? `${from.toFixed(2)} – ${to.toFixed(2)}` : from.toFixed(2));
    for (const i of quote.items) {
        lines.push(`• ${i.name}${i.type ? ' — ' + i.type : ''}: ${i.quantity} ${unitLabel(i.unit)} × ${amount(i.unit_price, i.unit_price_to)} = ${amount(i.line_total, i.line_total_to)} ر.ع`);
    }
    lines.push('', `المجموع: ${amount(quote.subtotal, range.subtotal_to)} ر.ع`,
        `الضريبة (${quote.vat_percent}%): ${amount(quote.vat, range.vat_to)} ر.ع`,
        `*الإجمالي: ${amount(quote.total, range.total_to)} ر.ع*`);
    if (quote.notes) lines.push('', `ملاحظات: ${quote.notes}`);
    lines.push('', `— ${settings.company_name}`);
    return lines.join('\n');
}

/* Called after a quote is saved: alert the owner and send the customer a copy.
   Note: Meta only delivers free-form text inside the 24-hour customer-service
   window; outside it an approved template message is required. */
async function notifyQuote(db, quote) {
    if (!isConfigured()) return;
    const settings = getSettings(db);
    const text = quoteText(quote, settings);
    const jobs = [];
    if (env().notifyTo) jobs.push(sendText(env().notifyTo, '🆕 طلب عرض سعر جديد\n\n' + text));
    jobs.push(sendText(quote.customer_phone, 'شكراً لتواصلك معنا 🌟\n\n' + text)
        .then(() => sendQuotePdf(db, quote.customer_phone, quote)));
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === 'rejected') console.error('[whatsapp]', r.reason.message);
}

function menuText(settings) {
    const lines = [`أهلاً بك في ${settings.company_name} 👋`, '',
        'أرسل *الأسعار* لعرض قائمة الأسعار.'];
    if (settings.public_base_url) {
        lines.push(`أو اطلب عرض سعر من الحاسبة: ${settings.public_base_url.replace(/\/$/, '')}/calculator.html`);
    }
    return lines.join('\n');
}

/* Keyword bot used when no Claude API key is configured */
async function keywordReply(db, message) {
    const text = message.text.body.trim().toLowerCase();
    const reply = /سعر|اسعار|أسعار|الأسعار|price|prices/.test(text)
        ? priceListText(db)
        : menuText(getSettings(db));
    await sendText(message.from, reply);
}

async function agentReply(db, message, saveQuote) {
    const result = await agent.chat({
        db,
        key: 'wa:' + message.from,
        channel: 'whatsapp',
        phone: message.from,
        text: message.text.body,
        createQuote: saveQuote,
        notifyHuman: async (summary) => {
            if (env().notifyTo) await sendText(env().notifyTo, `🙋 عميل يطلب التواصل: +${message.from}\n\n${summary}`);
        }
    });
    await sendText(message.from, result.reply);
    for (const e of result.events) {
        if (e.type !== 'quote_created') continue;
        await sendQuotePdf(db, message.from, e.quote);
        if (env().notifyTo) {
            await sendText(env().notifyTo, '🆕 عرض سعر من المساعد الذكي\n\n' + quoteText(e.quote, getSettings(db)));
        }
    }
}

async function handleIncomingMessage(db, message, saveQuote) {
    if (message.type !== 'text') {
        await sendText(message.from, 'أستطيع قراءة الرسائل النصية فقط حالياً 🙏 اكتب لي طلبك من فضلك.');
        return;
    }
    if (agent.isConfigured()) {
        try {
            await agentReply(db, message, saveQuote);
        } catch (err) {
            console.error('[agent]', err.message);
            await sendText(message.from, 'عذراً، حدث خطأ مؤقت. حاول مرة أخرى بعد قليل، أو انتظر تواصل فريقنا معك.');
        }
    } else {
        await keywordReply(db, message);
    }
}

/* Meta retries deliveries — remember recent message ids to answer each only once */
const seenMessages = new Map();
function firstTimeSeen(id) {
    const now = Date.now();
    for (const [k, t] of seenMessages) if (now - t > 60 * 60_000) seenMessages.delete(k);
    if (seenMessages.has(id)) return false;
    seenMessages.set(id, now);
    return true;
}

/* One message at a time per customer, so replies stay in order */
const queues = new Map();
function enqueue(phone, job) {
    const next = (queues.get(phone) || Promise.resolve()).then(job).catch((err) => console.error('[whatsapp]', err.message));
    queues.set(phone, next);
    next.finally(() => { if (queues.get(phone) === next) queues.delete(phone); });
}

function verifySignature(req) {
    const { appSecret } = env();
    if (!appSecret) return true;
    const header = req.get('X-Hub-Signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody || '').digest('hex');
    return header.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function registerRoutes(app, db, { saveQuote }) {
    // Meta calls this once when you save the webhook URL in the app dashboard
    app.get('/webhooks/whatsapp', (req, res) => {
        const { verifyToken } = env();
        if (verifyToken && req.query['hub.mode'] === 'subscribe' &&
            req.query['hub.verify_token'] === verifyToken) {
            return res.status(200).send(req.query['hub.challenge']);
        }
        res.sendStatus(403);
    });

    app.post('/webhooks/whatsapp', (req, res) => {
        if (!verifySignature(req)) return res.sendStatus(401);
        res.sendStatus(200); // acknowledge fast; Meta retries slow responses
        const messages = (req.body.entry || [])
            .flatMap((e) => e.changes || [])
            .flatMap((c) => (c.value && c.value.messages) || []);
        for (const m of messages) {
            if (!m.id || !firstTimeSeen(m.id)) continue;
            enqueue(m.from, () => handleIncomingMessage(db, m, saveQuote));
        }
    });
}

module.exports = { registerRoutes, notifyQuote, priceListText, normalizePhone, isConfigured, sendText };
