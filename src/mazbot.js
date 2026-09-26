/* =============================================================
   MazBot API client — the WhatsApp template the company site's
   calculators send to the sales numbers (same flow as radma-om/radma
   private/mazbot-client.php):
     POST /login                  → JWT (≈60 min; cached 45 min)
     POST /whatsapp/send-template → approved template to one mobile
   Every request carries the "apikey" header; send-template must be
   multipart with body_matchs[i] / body_values[i] fields.
   Secrets come only from environment variables — never from Git.
   ============================================================= */

const env = () => ({
    apiKey: process.env.MAZBOT_API_KEY || '',
    email: process.env.MAZBOT_STAFF_EMAIL || '',
    password: process.env.MAZBOT_STAFF_PASSWORD || '',
    templateId: process.env.MAZBOT_TEMPLATE_ID || '',                  // rolling-shutter template
    overheadTemplateId: process.env.MAZBOT_OVERHEAD_TEMPLATE_ID || '', // overhead-gate template
    baseUrl: (process.env.MAZBOT_BASE_URL || 'https://mazbot.net/api').replace(/\/$/, ''),
    dryRun: process.env.MAZBOT_DRY_RUN === '1'
});

const hasLogin = () => {
    const e = env();
    return Boolean(e.apiKey && e.email && e.password);
};

/* Template of each calculator ('' = not set) */
const templateFor = (calculator) => (calculator === 'overhead' ? env().overheadTemplateId : env().templateId);

const isConfigured = (calculator = 'rolling_shutter') => hasLogin() && Boolean(templateFor(calculator));

let tokenCache = { token: null, expiresAt: 0 };
const TOKEN_TTL_MS = 45 * 60_000;

async function post(path, fields, { jwt = null, multipart = false } = {}) {
    const e = env();
    const headers = { apikey: e.apiKey, Accept: 'application/json' };
    if (jwt) headers.Authorization = 'Bearer ' + jwt;
    let body;
    if (multipart) {
        body = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            // Arrays go as real array fields: body_values[1], body_values[2] ...
            if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) body.append(`${key}[${k}]`, String(v));
            } else {
                body.append(key, String(value));
            }
        }
    } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(fields);
    }
    try {
        const res = await fetch(e.baseUrl + path, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) });
        const data = await res.json().catch(() => null);
        return { status: res.status, body: data };
    } catch (err) {
        return { status: 0, body: null, error: err.message };
    }
}

async function getToken(force = false) {
    if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
    const e = env();
    const res = await post('/login', { email: e.email, password: e.password });
    const token = res.body && res.body.data && res.body.data.token;
    if (res.status !== 200 || !token) throw new Error(res.error || `login_failed_http_${res.status}`);
    tokenCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
}

/* WhatsApp rejects template values with new lines, tabs or more than 4 spaces in a row */
const cleanValue = (v) => String(v ?? '—').replace(/[\r\n\t]+/g, ' / ').replace(/ {4,}/g, '   ').trim().slice(0, 1000) || '—';

async function sendTemplateOnce(jwt, mobile, values, templateId) {
    const bodyValues = {};
    const bodyMatchs = {};
    values.forEach((v, i) => { bodyValues[i + 1] = cleanValue(v); bodyMatchs[i + 1] = 'input_value'; });
    const res = await post('/whatsapp/send-template', {
        template_id: templateId, mobile, body_matchs: bodyMatchs, body_values: bodyValues
    }, { jwt, multipart: true });
    const ok = res.status === 200 && Boolean(res.body && res.body.success);
    return { ok, status: res.status, error: ok ? null : res.error || `template_failed_http_${res.status} ${JSON.stringify(res.body)}` };
}

/* Send to one mobile: one new login after a 401 (JWT expired), one retry on a network/5xx error */
async function sendTemplate(mobile, values, templateId) {
    if (env().dryRun) return { ok: true, status: 200, error: 'dry_run' };
    let jwt;
    try { jwt = await getToken(); } catch (err) { return { ok: false, status: 0, error: err.message }; }
    let result = await sendTemplateOnce(jwt, mobile, values, templateId);
    if (!result.ok && result.status === 401) {
        try { jwt = await getToken(true); result = await sendTemplateOnce(jwt, mobile, values, templateId); } catch (err) { result = { ok: false, status: 0, error: err.message }; }
    }
    if (!result.ok && (result.status === 0 || result.status >= 500)) result = await sendTemplateOnce(jwt, mobile, values, templateId);
    return result;
}

/* "76979066, 90660001" → ['96876979066', '96890660001'] */
function parseRecipients(text) {
    return String(text || '').split(/[,،;\n]+/).map((p) => p.replace(/\D/g, '')).filter(Boolean)
        .map((p) => (p.length === 8 ? '968' + p : p.replace(/^00/, '')));
}

/* Each recipient is sent independently; returns a short status for the quote ("2/2 ✓") */
async function sendToAll(recipients, values, calculator = 'rolling_shutter') {
    const templateId = templateFor(calculator);
    const results = [];
    for (const mobile of recipients) {
        const r = await sendTemplate(mobile, values, templateId);
        results.push({ mobile, ...r });
        if (!r.ok) console.error('[mazbot]', mobile, r.error);
    }
    const sent = results.filter((r) => r.ok).length;
    return { sent, total: results.length, results };
}

module.exports = { isConfigured, hasLogin, templateFor, sendToAll, parseRecipients, cleanValue, _reset: () => { tokenCache = { token: null, expiresAt: 0 }; } };
