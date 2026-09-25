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

        const quote = {
            ref: makeRef(),
            customer_name: String(customer_name).trim().slice(0, 120),
            customer_phone: phone,
            customer_city: customer_city ? String(customer_city).slice(0, 80) : null,
            notes: notes ? String(notes).slice(0, 1000) : null,
            ...priced,
            status: 'new',
            source: 'web'
        };
        const info = db.prepare(`INSERT INTO quotes (ref, customer_name, customer_phone, customer_city, notes,
                                 items_json, subtotal, vat_percent, vat, total, source)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(quote.ref, quote.customer_name, quote.customer_phone, quote.customer_city, quote.notes,
                JSON.stringify(quote.items), quote.subtotal, quote.vat_percent, quote.vat, quote.total, quote.source);
        quote.id = Number(info.lastInsertRowid);

        webhooks.emit(db, 'quote.created', quote);
        whatsapp.notifyQuote(db, quote).catch((err) => console.error('[whatsapp]', err.message));

        const waText = encodeURIComponent(`مرحباً، أرغب بمتابعة عرض السعر رقم ${quote.ref}`);
        res.status(201).json({
            ...quote,
            whatsapp_link: settings.company_whatsapp
                ? `https://wa.me/${whatsapp.normalizePhone(settings.company_whatsapp)}?text=${waText}`
                : null
        });
    }));

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
        res.json(rows.map(({ items_json, ...q }) => ({ ...q, items: JSON.parse(items_json) })));
    });

    admin.patch('/quotes/:id', (req, res) => {
        if (!QUOTE_STATUSES.includes(req.body.status)) throw httpError(400, 'الحالة غير صالحة');
        const info = db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(req.body.status, Number(req.params.id));
        if (!info.changes) throw httpError(404, 'العرض غير موجود');
        const { items_json, ...q } = db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(req.params.id));
        const quote = { ...q, items: JSON.parse(items_json) };
        webhooks.emit(db, 'quote.status_changed', quote);
        res.json(quote);
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

    whatsapp.registerRoutes(app, db);
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
    });
}

module.exports = { createApp };
