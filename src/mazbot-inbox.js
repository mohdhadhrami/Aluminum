/* =============================================================
   Customer messages from MazBot → AI sales agent → reply via MazBot.
   MazBot POSTs JSON events to /webhooks/mazbot/<secret>:
     { id, type: 'message.received' | 'interactive.selected', created_at,
       data: { contact: { id, phone, name }, message: { id, message_type, value } } }
   data.contact.id is the receiver_id used to answer.
   ============================================================= */
const { getSettings } = require('./db');
const agent = require('./agent');
const mazbot = require('./mazbot');

const PAUSE_HOURS = 12; // after "talk to a person", the agent stays quiet for this customer

function setStatus(db, eventId, status) {
    db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run(String(status).slice(0, 500), eventId);
}

const isPaused = (db, phone) => Boolean(db.prepare(
    "SELECT 1 FROM agent_pauses WHERE phone = ? AND until > datetime('now')").get(phone));

function pause(db, phone) {
    db.prepare(`INSERT INTO agent_pauses (phone, until) VALUES (?, datetime('now', '+${PAUSE_HOURS} hours'))
                ON CONFLICT(phone) DO UPDATE SET until = excluded.until`).run(phone);
}

const unpause = (db, phone) => db.prepare('DELETE FROM agent_pauses WHERE phone = ?').run(phone);

/* The customer's text: a typed message, or the title of a button/list choice */
function messageText(event) {
    const m = (event.data && event.data.message) || {};
    if (event.type === 'interactive.selected') {
        const d = event.data || {};
        return String(m.value || (d.selection && (d.selection.title || d.selection.id)) || d.title || '').trim() || null;
    }
    return m.message_type === 'text' || m.meta_type === 'text' ? String(m.value || '').trim() || null : null;
}

/* One message at a time per customer, so replies stay in order */
const queues = new Map();
function enqueue(key, job) {
    const next = (queues.get(key) || Promise.resolve()).then(job).catch((err) => console.error('[mazbot-inbox]', err.message));
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
}

/**
 * Decide what to do with a stored webhook event; the reply runs in the background.
 * ctx = { saveQuote(q), notifySales(quote), baseUrl, client? (tests) }
 * Returns the queued job (tests await it) or null.
 */
function handleEvent(db, eventId, event, ctx) {
    if (!event || typeof event !== 'object') { setStatus(db, eventId, 'ignored: not JSON'); return null; }
    if (!['message.received', 'interactive.selected'].includes(event.type)) { setStatus(db, eventId, `ignored: ${event.type}`); return null; }

    const contact = (event.data && event.data.contact) || {};
    const phone = String(contact.phone || '').replace(/\D/g, '');
    if (!phone || contact.id == null) { setStatus(db, eventId, 'ignored: no contact'); return null; }

    // MazBot may retry a delivery: answer each message once
    const key = `${event.type}:${(event.data.message && event.data.message.id) || event.id}`;
    const dup = db.prepare("SELECT 1 FROM inbound_events WHERE event_key = ? AND id != ? AND status NOT LIKE 'bad_signature%'").get(key, eventId);
    db.prepare('UPDATE inbound_events SET event_key = ? WHERE id = ?').run(key, eventId);
    if (dup) { setStatus(db, eventId, 'duplicate'); return null; }

    const settings = getSettings(db);
    if (!settings.mazbot_agent_enabled) { setStatus(db, eventId, 'agent_off'); return null; }
    if (!agent.isConfigured()) { setStatus(db, eventId, 'agent_not_configured (OPENAI_API_KEY / ANTHROPIC_API_KEY)'); return null; }

    setStatus(db, eventId, 'queued');
    return enqueue(phone, () => reply(db, eventId, event, { ...ctx, phone, contact }));
}

async function reply(db, eventId, event, { phone, contact, saveQuote, notifySales, baseUrl, client }) {
    const text = messageText(event);
    const send = async (msg) => {
        const r = await mazbot.sendText(contact.id, msg);
        if (!r.ok) throw new Error('send: ' + r.error);
    };
    try {
        if (!text) {
            await send('أستطيع قراءة الرسائل النصية فقط حالياً 🙏 اكتب لي طلبك من فضلك.');
            return setStatus(db, eventId, 'replied: non-text');
        }
        if (/^\s*(جديد|ابدأ من جديد|reset|restart)\s*$/i.test(text)) unpause(db, phone);
        else if (isPaused(db, phone)) return setStatus(db, eventId, 'paused: with sales team');

        const settings = getSettings(db);
        const result = await agent.chat({
            db, key: 'mz:' + phone, channel: 'mazbot', phone, text,
            createQuote: saveQuote,
            ...(client ? { client } : {}),
            notifyHuman: async (summary) => {
                pause(db, phone);
                const alert = `🙋 عميل يطلب التواصل مع فريق المبيعات\n${contact.name || ''} — +${phone}\n\n${summary}`;
                for (const to of mazbot.parseRecipients(settings.mazbot_recipients)) {
                    const r = await mazbot.sendTextToPhone(to, alert);
                    if (!r.ok) console.error('[mazbot-inbox] alert', to, r.error);
                }
            }
        });
        await send(result.reply);
        const base = String(settings.public_base_url || baseUrl || '').replace(/\/$/, '');
        for (const e of result.events) {
            if (e.type !== 'quote_created') continue;
            await send(`📄 عرض السعر رقم ${e.quote.ref}\n${base}${e.quote.pdf_url}`);
            notifySales(e.quote).catch((err) => console.error('[mazbot-inbox] notify', err.message));
        }
        setStatus(db, eventId, 'replied');
    } catch (err) {
        console.error('[mazbot-inbox]', err.message);
        setStatus(db, eventId, 'error: ' + err.message);
    }
}

module.exports = { handleEvent, messageText };
