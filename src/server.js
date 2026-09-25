/* =============================================================
   Aluminum pricing server — REST API + static pages
   ============================================================= */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDatabase, getSettings, saveSettings } = require('./db');
const { unitCost, unitSellPrice, priceQuote, round2 } = require('./pricing');
const webhooks = require('./webhooks');
const whatsapp = require('./whatsapp');
const doors = require('./doors');
const agent = require('./agent');
const { renderQuotePdf } = require('./pdf');

const CATEGORIES = ['slat', 'accessory', 'machine'];
const UNITS = ['meter', 'piece', 'm2', 'set', 'kg'];
const QUOTE_STATUSES = ['new', 'contacted', 'accepted', 'rejected', 'done'];

const httpError = (status, message) => Object.assign(new Error(message), { status });
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function withPrices(product, settings) {
    return {
        ...product,
        unit_cost: round2(unitCost(product, settings)),
        unit_price: unitSellPrice(product, settings)
    };
}

/* Small in-memory limiter so the public quote form cannot be spammed */
function rateLimit({ windowMs, max }) {
    const hits = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const key = req.ip;
        const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
        if (recent.length >= max) {
            return res.status(429).json({ error: 'طلبات كثيرة، يرجى المحاولة لاحقاً' });
        }
        recent.push(now);
        hits.set(key, recent);
        next();
    };
}

function requireAdmin(req, res, next) {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) return res.status(503).json({ error: 'ADMIN_TOKEN غير مضبوط على الخادم' });
    const given = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'رمز الدخول غير صحيح' });
    }
    next();
}

/* Validate and normalise a product payload (partial when updating) */
function parseProduct(body, partial = false) {
    const out = {};
    const has = (k) => body[k] !== undefined;
    const num = (k, { nullable = false } = {}) => {
        if (!has(k)) return;
        if (nullable && (body[k] === null || body[k] === '')) { out[k] = null; return; }
        const v = Number(body[k]);
        if (!Number.isFinite(v) || v < 0) throw httpError(400, `قيمة غير صالحة للحقل ${k}`);
        out[k] = v;
    };

    if (!partial || has('category')) {
        if (!CATEGORIES.includes(body.category)) throw httpError(400, 'الفئة غير صالحة');
        out.category = body.category;
    }
    if (!partial || has('name')) {
        if (!body.name || !String(body.name).trim()) throw httpError(400, 'اسم المنتج مطلوب');
        out.name = String(body.name).trim();
    }
    if (has('type')) out.type = body.type ? String(body.type).trim() : null;
    if (has('notes')) out.notes = body.notes ? String(body.notes) : null;
    if (has('unit')) {
        if (!UNITS.includes(body.unit)) throw httpError(400, 'الوحدة غير صالحة');
        out.unit = body.unit;
    }
    if (has('pricing_mode')) {
        if (!['manual', 'lme'].includes(body.pricing_mode)) throw httpError(400, 'طريقة التسعير غير صالحة');
        out.pricing_mode = body.pricing_mode;
    }
    num('purchase_price');
    num('profit_percent', { nullable: true });
    num('sell_price', { nullable: true });
    num('thickness', { nullable: true });
    num('weight_per_meter', { nullable: true });
    for (const k of ['painted', 'is_public', 'active']) {
        if (has(k)) out[k] = body[k] ? 1 : 0;
    }
    return out;
}

function makeRef() {
    const d = new Date();
    const ymd = d.getFullYear().toString().slice(2) +
        String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    return `Q${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const parseQuote = ({ items_json, details_json, ...q }) => ({
    ...q, items: JSON.parse(items_json), details: details_json ? JSON.parse(details_json) : null
});

const pdfPath = (quote) => `/quotes/${quote.ref}.pdf?k=${quote.access_key}`;

/* Persist a priced quote (from the web calculator or the AI agent) and notify integrations */
function saveQuote(db, { customer_name, customer_phone, customer_city, notes, source, priced, details = null }) {
    const quote = {
        ref: makeRef(),
        access_key: crypto.randomBytes(16).toString('hex'),
        customer_name: String(customer_name).trim().slice(0, 120),
        customer_phone: whatsapp.normalizePhone(customer_phone),
        customer_city: customer_city ? String(customer_city).slice(0, 80) : null,
        notes: notes ? String(notes).slice(0, 1000) : null,
        items: priced.items,
        subtotal: priced.subtotal,
        vat_percent: priced.vat_percent,
        vat: priced.vat,
        total: priced.total,
        details,
        status: 'new',
        source
    };
    const info = db.prepare(`INSERT INTO quotes (ref, access_key, customer_name, customer_phone, customer_city, notes,
                             items_json, details_json, subtotal, vat_percent, vat, total, source)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(quote.ref, quote.access_key, quote.customer_name, quote.customer_phone, quote.customer_city, quote.notes,
            JSON.stringify(quote.items), details ? JSON.stringify(details) : null,
            quote.subtotal, quote.vat_percent, quote.vat, quote.total, quote.source);
    quote.id = Number(info.lastInsertRowid);
    quote.created_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    quote.pdf_url = pdfPath(quote);

    const { access_key, ...publicQuote } = quote;
    webhooks.emit(db, 'quote.created', publicQuote);
    return quote;
}

function sendPdf(res, quote, settings) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="quotation-${quote.ref}.pdf"`);
    renderQuotePdf(quote, settings, res);
}

function createApp(db) {
    const app = express();
    app.set('trust proxy', process.env.TRUST_PROXY === '1');
    app.use(express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

    const getProduct = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));

    /* ------------------------- Public API ------------------------- */

    app.get('/api/public/catalog', (req, res) => {
        const settings = getSettings(db);
        const products = db.prepare(`SELECT * FROM products WHERE active = 1 AND is_public = 1
                                     ORDER BY category, name, type`).all();
        res.json({
            company_name: settings.company_name,
            company_whatsapp: settings.company_whatsapp,
            currency: 'OMR',
            vat_percent: settings.vat_percent,
            sqm_to_linear: settings.sqm_to_linear,
            // Never expose purchase prices, costs or margins publicly
            products: products.map((p) => ({
                id: p.id, category: p.category, name: p.name, type: p.type, unit: p.unit,
                thickness: p.thickness, painted: p.painted,
                unit_price: unitSellPrice(p, settings)
            }))
        });
    });

    app.post('/api/public/quotes', rateLimit({ windowMs: 10 * 60_000, max: 10 }), asyncRoute(async (req, res) => {
        const { customer_name, customer_phone, customer_city, notes, items } = req.body || {};
        if (!customer_name || !String(customer_name).trim()) throw httpError(400, 'الاسم مطلوب');
        const phone = whatsapp.normalizePhone(customer_phone);
        if (phone.length < 8 || phone.length > 15) throw httpError(400, 'رقم الهاتف غير صالح');

        const settings = getSettings(db);
        const rows = db.prepare('SELECT * FROM products WHERE active = 1 AND is_public = 1').all();
        const priced = priceQuote(items, new Map(rows.map((p) => [p.id, p])), settings);

        const quote = saveQuote(db, {
            customer_name, customer_phone: phone, customer_city, notes, source: 'web', priced
        });
        whatsapp.notifyQuote(db, quote).catch((err) => console.error('[whatsapp]', err.message));

        const waText = encodeURIComponent(`مرحباً، أرغب بمتابعة عرض السعر رقم ${quote.ref}`);
        const { access_key, ...publicQuote } = quote;
        res.status(201).json({
            ...publicQuote,
            whatsapp_link: settings.company_whatsapp
                ? `https://wa.me/${whatsapp.normalizePhone(settings.company_whatsapp)}?text=${waText}`
                : null
        });
    }));

    /* Customer-facing PDF: the random key in the link is the access control */
    app.get('/quotes/:ref.pdf', (req, res) => {
        const row = db.prepare('SELECT * FROM quotes WHERE ref = ?').get(req.params.ref);
        const key = String(req.query.k || '');
        if (!row || !row.access_key || key.length !== row.access_key.length ||
            !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(row.access_key))) {
            return res.status(404).type('text/plain').send('Not found');
        }
        sendPdf(res, parseQuote(row), getSettings(db));
    });

    /* ------------------------- Admin API -------------------------- */

    const admin = express.Router();
    admin.use(requireAdmin);

    admin.get('/settings', (req, res) => res.json(getSettings(db)));

    admin.put('/settings', (req, res) => {
        if (req.body.tax_mode !== undefined && !['accounting', 'industrial'].includes(req.body.tax_mode)) {
            throw httpError(400, 'وضع الضريبة غير صالح');
        }
        const settings = saveSettings(db, req.body || {});
        webhooks.emit(db, 'settings.updated', settings);
        res.json(settings);
    });

    admin.get('/products', (req, res) => {
        const settings = getSettings(db);
        const where = req.query.category ? 'WHERE category = ?' : '';
        const args = req.query.category ? [req.query.category] : [];
        const rows = db.prepare(`SELECT * FROM products ${where} ORDER BY category, name, type`).all(...args);
        res.json(rows.map((p) => withPrices(p, settings)));
    });

    admin.post('/products', (req, res) => {
        const p = parseProduct(req.body || {});
        const cols = Object.keys(p);
        const info = db.prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map((c) => p[c]));
        const product = withPrices(getProduct(info.lastInsertRowid), getSettings(db));
        webhooks.emit(db, 'product.created', product);
        res.status(201).json(product);
    });

    admin.put('/products/:id', (req, res) => {
        const before = getProduct(req.params.id);
        if (!before) throw httpError(404, 'المنتج غير موجود');
        const p = parseProduct(req.body || {}, true);
        const cols = Object.keys(p);
        if (cols.length) {
            db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now')
                        WHERE id = ?`).run(...cols.map((c) => p[c]), before.id);
        }
        const logChange = db.prepare(`INSERT INTO price_history (product_id, field, old_value, new_value, source)
                                      VALUES (?, ?, ?, ?, 'manual')`);
        for (const f of ['purchase_price', 'sell_price', 'profit_percent']) {
            if (f in p && p[f] !== before[f]) logChange.run(before.id, f, before[f], p[f]);
        }
        const product = withPrices(getProduct(before.id), getSettings(db));
        webhooks.emit(db, 'product.updated', product);
        res.json(product);
    });

    admin.delete('/products/:id', (req, res) => {
        const product = getProduct(req.params.id);
        if (!product) throw httpError(404, 'المنتج غير موجود');
        db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
        webhooks.emit(db, 'product.deleted', { id: product.id, name: product.name, type: product.type });
        res.status(204).end();
    });

    admin.get('/products/:id/history', (req, res) => {
        res.json({
            changes: db.prepare('SELECT * FROM price_history WHERE product_id = ? ORDER BY id DESC').all(Number(req.params.id)),
            purchases: db.prepare('SELECT * FROM purchases WHERE product_id = ? ORDER BY purchased_at DESC, id DESC').all(Number(req.params.id))
        });
    });

    admin.get('/purchases', (req, res) => {
        res.json(db.prepare(`SELECT pu.*, p.name AS product_name, p.type AS product_type, p.category, p.unit
                             FROM purchases pu JOIN products p ON p.id = pu.product_id
                             ORDER BY pu.purchased_at DESC, pu.id DESC LIMIT 500`).all());
    });

    /* Record a purchase invoice line. By default the product's purchase
       price becomes this latest landed cost per unit (in OMR). */
    admin.post('/purchases', (req, res) => {
        const b = req.body || {};
        const product = getProduct(b.product_id);
        if (!product) throw httpError(400, 'المنتج غير موجود');
        const unitPrice = Number(b.unit_price);
        const quantity = b.quantity === undefined || b.quantity === '' ? 1 : Number(b.quantity);
        const rate = b.exchange_rate === undefined || b.exchange_rate === '' ? 1 : Number(b.exchange_rate);
        const extra = b.extra_cost === undefined || b.extra_cost === '' ? 0 : Number(b.extra_cost);
        for (const [k, v] of Object.entries({ unit_price: unitPrice, quantity, exchange_rate: rate, extra_cost: extra })) {
            if (!Number.isFinite(v) || v < 0) throw httpError(400, `قيمة غير صالحة للحقل ${k}`);
        }
        const unitCostOmr = Math.round((unitPrice * rate + extra) * 1000) / 1000;
        const purchasedAt = /^\d{4}-\d{2}-\d{2}$/.test(b.purchased_at || '') ? b.purchased_at : new Date().toISOString().slice(0, 10);

        const info = db.prepare(`INSERT INTO purchases (product_id, supplier, quantity, unit_price, currency,
                                 exchange_rate, extra_cost, unit_cost_omr, purchased_at, notes)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(product.id, b.supplier || null, quantity, unitPrice, String(b.currency || 'OMR').toUpperCase().slice(0, 3),
                rate, extra, unitCostOmr, purchasedAt, b.notes || null);

        if (b.update_product !== false && product.pricing_mode === 'manual' && unitCostOmr !== product.purchase_price) {
            db.prepare(`UPDATE products SET purchase_price = ?, updated_at = datetime('now') WHERE id = ?`).run(unitCostOmr, product.id);
            db.prepare(`INSERT INTO price_history (product_id, field, old_value, new_value, source)
                        VALUES (?, 'purchase_price', ?, ?, 'purchase')`).run(product.id, product.purchase_price, unitCostOmr);
        }
        const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(info.lastInsertRowid);
        const updated = withPrices(getProduct(product.id), getSettings(db));
        webhooks.emit(db, 'purchase.created', { purchase, product: updated });
        res.status(201).json({ purchase, product: updated });
    });

    admin.delete('/purchases/:id', (req, res) => {
        db.prepare('DELETE FROM purchases WHERE id = ?').run(Number(req.params.id));
        res.status(204).end();
    });

    admin.get('/quotes', (req, res) => {
        const where = req.query.status ? 'WHERE status = ?' : '';
        const args = req.query.status ? [req.query.status] : [];
        const rows = db.prepare(`SELECT * FROM quotes ${where} ORDER BY id DESC LIMIT 500`).all(...args);
        res.json(rows.map((r) => { const { access_key, ...q } = parseQuote(r); return q; }));
    });

    admin.patch('/quotes/:id', (req, res) => {
        if (!QUOTE_STATUSES.includes(req.body.status)) throw httpError(400, 'الحالة غير صالحة');
        const info = db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(req.body.status, Number(req.params.id));
        if (!info.changes) throw httpError(404, 'العرض غير موجود');
        const { access_key, ...quote } = parseQuote(db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(req.params.id)));
        webhooks.emit(db, 'quote.status_changed', quote);
        res.json(quote);
    });

    admin.get('/quotes/:id/pdf', (req, res) => {
        const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(req.params.id));
        if (!row) throw httpError(404, 'العرض غير موجود');
        sendPdf(res, parseQuote(row), getSettings(db));
    });

    /* ---- Door packages (used by the AI agent) ---- */

    admin.get('/door-packages', (req, res) => res.json(doors.describePackages(db)));

    const parsePackage = (b) => {
        if (!b.door_type || !String(b.door_type).trim()) throw httpError(400, 'نوع الباب مطلوب');
        if (!b.name || !String(b.name).trim()) throw httpError(400, 'اسم الباقة مطلوب');
        const slat = getProduct(b.slat_product_id);
        if (!slat || slat.category !== 'slat') throw httpError(400, 'اختر منتج شرائح للباقة');
        const area = (v) => (v === '' || v == null ? null : Number(v));
        const items = (Array.isArray(b.items) ? b.items : []).map((i) => {
            if (!getProduct(i.product_id)) throw httpError(400, 'منتج غير موجود في مكونات الباقة');
            if (!['fixed', 'width', 'height', 'area'].includes(i.basis)) throw httpError(400, 'طريقة حساب الكمية غير صالحة');
            const factor = Number(i.factor);
            if (!Number.isFinite(factor) || factor <= 0) throw httpError(400, 'المعامل يجب أن يكون أكبر من صفر');
            return { product_id: Number(i.product_id), basis: i.basis, factor, optional: i.optional ? 1 : 0 };
        });
        return {
            door_type: String(b.door_type).trim(), name: String(b.name).trim(), description: b.description || null,
            slat_product_id: slat.id, min_area: area(b.min_area), max_area: area(b.max_area),
            sort_order: Number(b.sort_order) || 0, active: b.active === false ? 0 : 1, items
        };
    };

    const writePackageItems = (packageId, items) => {
        db.prepare('DELETE FROM door_package_items WHERE package_id = ?').run(packageId);
        const insert = db.prepare(`INSERT INTO door_package_items (package_id, product_id, basis, factor, optional)
                                   VALUES (?, ?, ?, ?, ?)`);
        for (const i of items) insert.run(packageId, i.product_id, i.basis, i.factor, i.optional);
    };

    admin.post('/door-packages', (req, res) => {
        const p = parsePackage(req.body || {});
        const id = Number(db.prepare(`INSERT INTO door_packages (door_type, name, description, slat_product_id, min_area, max_area, sort_order, active)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(p.door_type, p.name, p.description, p.slat_product_id, p.min_area, p.max_area, p.sort_order, p.active).lastInsertRowid);
        writePackageItems(id, p.items);
        res.status(201).json(doors.describePackages(db).find((x) => x.id === id));
    });

    admin.put('/door-packages/:id', (req, res) => {
        const id = Number(req.params.id);
        if (!db.prepare('SELECT id FROM door_packages WHERE id = ?').get(id)) throw httpError(404, 'الباقة غير موجودة');
        const p = parsePackage(req.body || {});
        db.prepare(`UPDATE door_packages SET door_type = ?, name = ?, description = ?, slat_product_id = ?, min_area = ?,
                    max_area = ?, sort_order = ?, active = ? WHERE id = ?`)
            .run(p.door_type, p.name, p.description, p.slat_product_id, p.min_area, p.max_area, p.sort_order, p.active, id);
        writePackageItems(id, p.items);
        res.json(doors.describePackages(db).find((x) => x.id === id));
    });

    admin.delete('/door-packages/:id', (req, res) => {
        db.prepare('DELETE FROM door_packages WHERE id = ?').run(Number(req.params.id));
        res.status(204).end();
    });

    /* Try a size against all packages — the same numbers the agent will quote */
    admin.get('/door-packages/preview', (req, res) => {
        const q = { widthCm: req.query.width_cm, heightCm: req.query.height_cm, count: Number(req.query.count) || 1,
            doorType: req.query.door_type || '', regionId: req.query.region_id || null };
        res.json({ range: doors.priceRange(db, q), packages: doors.comparePackages(db, q) });
    });

    admin.get('/regions', (req, res) => res.json(db.prepare('SELECT * FROM regions ORDER BY governorate, name').all()));

    admin.post('/regions', (req, res) => {
        const name = String((req.body || {}).name || '').trim();
        if (!name) throw httpError(400, 'اسم الولاية مطلوب');
        const info = db.prepare('INSERT INTO regions (name, governorate) VALUES (?, ?)').run(name, req.body.governorate || null);
        res.status(201).json(db.prepare('SELECT * FROM regions WHERE id = ?').get(info.lastInsertRowid));
    });

    admin.put('/regions/:id', (req, res) => {
        const b = req.body || {};
        const fee = (v) => {
            if (v === '' || v == null) return null;
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) throw httpError(400, 'رسوم غير صالحة');
            return n;
        };
        const info = db.prepare('UPDATE regions SET delivery_fee = ?, installation_fee = ?, active = ? WHERE id = ?')
            .run(fee(b.delivery_fee), fee(b.installation_fee), b.active === false ? 0 : 1, Number(req.params.id));
        if (!info.changes) throw httpError(404, 'الولاية غير موجودة');
        res.json(db.prepare('SELECT * FROM regions WHERE id = ?').get(Number(req.params.id)));
    });

    /* ---- AI agent test console (same agent as WhatsApp) ---- */

    admin.get('/agent/status', (req, res) => res.json({
        configured: agent.isConfigured(),
        model: process.env.AGENT_MODEL || 'claude-opus-5',
        whatsapp_configured: whatsapp.isConfigured()
    }));

    admin.post('/agent/chat', asyncRoute(async (req, res) => {
        if (!agent.isConfigured()) throw httpError(503, 'ANTHROPIC_API_KEY غير مضبوط على الخادم');
        const session = String(req.body.session || 'default').slice(0, 40);
        const message = String(req.body.message || '').trim();
        if (!message) throw httpError(400, 'اكتب رسالة');
        const result = await agent.chat({
            db, key: 'test:' + session, channel: 'agent-test', phone: '96800000000', text: message,
            createQuote: (q) => saveQuote(db, q),
            notifyHuman: async () => {}
        });
        res.json({
            reply: result.reply,
            events: result.events.map((e) => (e.type === 'quote_created'
                ? { type: e.type, ref: e.quote.ref, total: e.quote.total, pdf_url: e.quote.pdf_url }
                : e))
        });
    }));

    admin.post('/agent/reset', (req, res) => {
        agent.resetConversation(db, 'test:' + String((req.body || {}).session || 'default').slice(0, 40));
        res.status(204).end();
    });

    admin.get('/webhooks', (req, res) => {
        res.json({
            events: webhooks.EVENTS,
            whatsapp_configured: whatsapp.isConfigured(),
            webhooks: db.prepare('SELECT * FROM webhooks ORDER BY id').all()
        });
    });

    const parseHook = (b) => {
        let url;
        try { url = new URL(b.url); } catch { throw httpError(400, 'الرابط غير صالح'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'يجب أن يبدأ الرابط بـ http أو https');
        const events = Array.isArray(b.events) ? b.events.join(',') : String(b.events || '*');
        const unknown = events.split(',').map((e) => e.trim()).filter((e) => e !== '*' && !webhooks.EVENTS.includes(e));
        if (unknown.length) throw httpError(400, `أحداث غير معروفة: ${unknown.join(', ')}`);
        return { name: String(b.name || url.host), url: url.toString(), secret: b.secret || null, events, active: b.active === false ? 0 : 1 };
    };

    admin.post('/webhooks', (req, res) => {
        const h = parseHook(req.body || {});
        const info = db.prepare('INSERT INTO webhooks (name, url, secret, events, active) VALUES (?, ?, ?, ?, ?)')
            .run(h.name, h.url, h.secret, h.events, h.active);
        res.status(201).json(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(info.lastInsertRowid));
    });

    admin.put('/webhooks/:id', (req, res) => {
        const h = parseHook(req.body || {});
        const info = db.prepare('UPDATE webhooks SET name = ?, url = ?, secret = ?, events = ?, active = ? WHERE id = ?')
            .run(h.name, h.url, h.secret, h.events, h.active, Number(req.params.id));
        if (!info.changes) throw httpError(404, 'الـ Webhook غير موجود');
        res.json(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(req.params.id)));
    });

    admin.delete('/webhooks/:id', (req, res) => {
        db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(req.params.id));
        res.status(204).end();
    });

    admin.post('/webhooks/:id/test', asyncRoute(async (req, res) => {
        const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(req.params.id));
        if (!hook) throw httpError(404, 'الـ Webhook غير موجود');
        const [result] = await webhooks.emit(db, 'webhook.test', { message: 'اختبار الربط ناجح ✅' }, hook);
        res.json(result);
    }));

    admin.get('/webhooks/:id/deliveries', (req, res) => {
        res.json(db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 50')
            .all(Number(req.params.id)));
    });

    /* Ready-made WhatsApp text of the public price list (for copy/paste or automations) */
    admin.get('/price-list.txt', (req, res) => res.type('text/plain').send(whatsapp.priceListText(db)));

    app.use('/api/admin', admin);

    whatsapp.registerRoutes(app, db, { saveQuote: (q) => saveQuote(db, q) });
    app.use(express.static(path.join(__dirname, '..', 'public')));

    app.use('/api', (req, res) => res.status(404).json({ error: 'غير موجود' }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
        if (status >= 500) console.error(err);
        res.status(status).json({ error: status >= 500 ? 'خطأ في الخادم' : err.message });
    });

    return app;
}

if (require.main === module) {
    try { process.loadEnvFile(); } catch { /* .env is optional */ }
    const db = openDatabase();
    const port = Number(process.env.PORT) || 3000;
    createApp(db).listen(port, () => {
        console.log(`Aluminum pricing server on http://localhost:${port}`);
        console.log(`  • لوحة الإدارة:      http://localhost:${port}/`);
        console.log(`  • حاسبة العملاء:     http://localhost:${port}/calculator.html`);
        if (!process.env.ADMIN_TOKEN) console.warn('  ! ADMIN_TOKEN غير مضبوط — واجهة الإدارة مقفلة');
        console.log(`  • واتساب: ${whatsapp.isConfigured() ? 'مفعّل' : 'غير مفعّل'}`);
        console.log(`  • المساعد الذكي: ${agent.isConfigured() ? 'مفعّل' : 'غير مفعّل (ANTHROPIC_API_KEY)'}`);
    });
}

module.exports = { createApp, saveQuote };
