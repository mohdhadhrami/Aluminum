/* =============================================================
   Aluminum pricing server — REST API + static pages
   ============================================================= */
const path = require('node:path');
const crypto = require('node:crypto');
// The built-in SQLite database needs Node.js 22.13 or newer — say so clearly instead of crashing
{
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13)) {
        console.error(`Node.js ${process.versions.node} is too old: this system needs Node.js 22.13+ (اختر Node.js 22 أو أحدث في إعدادات الاستضافة).`);
        process.exit(1);
    }
}
const express = require('express');
const { openDatabase, getSettings, saveSettings } = require('./db');
const { unitCost, unitSellPrice, priceQuote, round2 } = require('./pricing');
const webhooks = require('./webhooks');
const whatsapp = require('./whatsapp');
const doors = require('./doors');
const agent = require('./agent');
const { renderQuotePdf } = require('./pdf');

const APP_VERSION = require('../package.json').version;
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

/* Admin password check. After 10 wrong passwords from one IP in 15 minutes,
   that IP is locked out for 15 minutes (brute-force protection on a public server). */
function makeRequireAdmin() {
    const WINDOW = 15 * 60_000;
    const MAX_FAILURES = 10;
    const failures = new Map();
    return (req, res, next) => {
        const expected = process.env.ADMIN_TOKEN;
        if (!expected) return res.status(503).json({ error: 'ADMIN_TOKEN غير مضبوط على الخادم' });
        const now = Date.now();
        const recent = (failures.get(req.ip) || []).filter((t) => now - t < WINDOW);
        if (recent.length >= MAX_FAILURES) {
            return res.status(429).json({ error: 'محاولات دخول كثيرة خاطئة. حاول مرة أخرى بعد 15 دقيقة.' });
        }
        const given = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        const a = Buffer.from(given);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            recent.push(now);
            failures.set(req.ip, recent);
            return res.status(401).json({ error: 'كلمة مرور الإدارة غير صحيحة' });
        }
        failures.delete(req.ip);
        next();
    };
}

/* Sites allowed to embed the customer calculator in an <iframe> (space separated) */
const embedOrigins = () => (process.env.EMBED_ALLOWED_ORIGINS ?? 'https://radma.co https://www.radma.co').trim();

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
    app.disable('x-powered-by');

    // Security headers. Only the customer pages may be embedded, and only by the allowed sites;
    // the admin panel and everything else can never be framed (clickjacking protection).
    const customerPages = new Set(['/', '/calculator.html', '/materials.html']);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        // Never let a hosting CDN keep stale copies: PDFs, API data and the health check are
        // always fresh; pages, scripts and styles must be revalidated (cheap, thanks to ETags).
        if (req.path.startsWith('/api/') || req.path.startsWith('/quotes/') || req.path === '/healthz') {
            res.setHeader('Cache-Control', 'no-store');
        } else if (!/\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(req.path)) {
            res.setHeader('Cache-Control', 'no-cache');
        }
        if (customerPages.has(req.path)) {
            res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${embedOrigins()}`.trim());
        } else {
            res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
            res.setHeader('X-Frame-Options', 'DENY');
        }
        next();
    });

    const getProduct = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));

    /* Status check for the hosting panel / uptime monitors */
    app.get('/healthz', (req, res) => {
        db.prepare('SELECT 1').get();
        res.json({ ok: true, version: APP_VERSION, features: ['quote_terms'], node: process.versions.node });
    });

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
            locations: doors.locations(db),
            // Never expose purchase prices, costs or margins publicly
            products: products.map((p) => ({
                id: p.id, category: p.category, name: p.name, type: p.type, unit: p.unit,
                thickness: p.thickness, painted: p.painted,
                unit_price: unitSellPrice(p, settings)
            }))
        });
    });

    /* Name, mobile and an enabled wilayah are required on every customer request */
    const readCustomer = (body) => {
        if (!body.customer_name || !String(body.customer_name).trim()) throw httpError(400, 'الاسم مطلوب');
        const phone = whatsapp.normalizePhone(body.customer_phone);
        if (phone.length < 8 || phone.length > 15) throw httpError(400, 'رقم الجوال غير صالح');
        const region = doors.getRegion(db, body.region_id);
        if (!region) throw httpError(400, 'اختر المحافظة والولاية');
        return { customer_name: body.customer_name, customer_phone: phone, region, customer_city: `${region.name}، ${region.governorate}`, notes: body.notes };
    };

    const quoteResponse = (res, quote) => {
        const settings = getSettings(db);
        whatsapp.notifyQuote(db, quote).catch((err) => console.error('[whatsapp]', err.message));
        const waText = encodeURIComponent(`مرحباً، أرغب بمتابعة عرض السعر رقم ${quote.ref}`);
        const { access_key, ...publicQuote } = quote;
        res.status(201).json({
            ...publicQuote,
            whatsapp_link: settings.company_whatsapp
                ? `https://wa.me/${whatsapp.normalizePhone(settings.company_whatsapp)}?text=${waText}`
                : null
        });
    };

    const quoteLimit = rateLimit({ windowMs: 10 * 60_000, max: 10 });

    /* Materials order (slats / accessories by quantity) */
    app.post('/api/public/quotes', quoteLimit, (req, res) => {
        const body = req.body || {};
        const customer = readCustomer(body);
        const rows = db.prepare('SELECT * FROM products WHERE active = 1 AND is_public = 1').all();
        const priced = priceQuote(body.items, new Map(rows.map((p) => [p.id, p])), getSettings(db));
        quoteResponse(res, saveQuote(db, { ...customer, source: 'web', priced }));
    });

    /* ---- Roller-shutter door configurator ---- */

    app.get('/api/public/configurator', (req, res) => {
        const settings = getSettings(db);
        res.json({
            company_name: settings.company_name,
            company_whatsapp: settings.company_whatsapp,
            company_tagline: settings.company_tagline,
            company_phone: settings.company_phone,
            company_address: settings.company_address,
            company_website: settings.company_website,
            calculator_notice: settings.calculator_notice,
            calculator_notes: settings.calculator_notes,
            vat_percent: settings.vat_percent,
            locations: doors.locations(db),
            ...doors.publicCatalog(db)
        });
    });

    const readDoor = (b) => ({
        widthCm: b.width_cm, heightCm: b.height_cm, count: Number(b.count) || 1,
        shutterTypeId: b.shutter_type_id, variantId: b.variant_id, colorId: b.color_id,
        optionIds: Array.isArray(b.option_ids) ? b.option_ids : [], regionId: b.region_id
    });

    const publicPrice = (p) => ({
        items: p.items.map(({ product_id, category, ...i }) => i),
        subtotal: p.subtotal, vat_percent: p.vat_percent, vat: p.vat, total: p.total,
        spec: p.spec, delivery_installation: p.delivery_installation
    });

    /* Live price while the customer is choosing (same code that prices the saved quote) */
    app.post('/api/public/door-price', (req, res) => {
        res.json(publicPrice(doors.finalPrice(db, readDoor(req.body || {}))));
    });

    app.post('/api/public/door-quotes', quoteLimit, (req, res) => {
        const body = req.body || {};
        const customer = readCustomer(body);
        const priced = doors.finalPrice(db, { ...readDoor(body), regionId: customer.region.id });
        quoteResponse(res, saveQuote(db, {
            ...customer, source: 'web', priced,
            details: { ...priced.door, spec: priced.spec, fees_note: priced.delivery_installation }
        }));
    });

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
    admin.use(makeRequireAdmin());

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

    /* ---- Door configurator: shutter types, accessory classes, locations ---- */

    admin.get('/configurator', (req, res) => {
        const catalog = doors.loadCatalog(db, { includeInactive: true });
        res.json({ shutter_types: catalog.types, accessory_groups: catalog.groups });
    });

    /* All-or-nothing writes for a parent row and its children */
    const tx = (fn) => {
        db.exec('BEGIN');
        try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    };

    const text = (v, max = 2000) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
    const requireProduct = (id) => {
        if (!getProduct(id)) throw httpError(400, 'منتج غير موجود');
        return Number(id);
    };

    /* Insert/update child rows by id and delete the ones no longer listed (keeps ids stable) */
    const syncChildren = (table, parentCol, parentId, rows, cols) => {
        const keep = rows.filter((r) => r.id).map((r) => Number(r.id));
        const existing = db.prepare(`SELECT id FROM ${table} WHERE ${parentCol} = ?`).all(parentId).map((r) => r.id);
        for (const id of existing) if (!keep.includes(id)) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        rows.forEach((r, i) => {
            const values = cols.map((c) => r[c]);
            if (r.id && existing.includes(Number(r.id))) {
                db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, sort_order = ? WHERE id = ?`)
                    .run(...values, i, Number(r.id));
            } else {
                db.prepare(`INSERT INTO ${table} (${parentCol}, ${cols.join(', ')}, sort_order) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`)
                    .run(parentId, ...values, i);
            }
        });
    };

    const parseShutterType = (b) => {
        if (!text(b.name)) throw httpError(400, 'اسم نوع البوابة مطلوب');
        const nonNegative = (v, label, nullable = false) => {
            if (nullable && (v === '' || v == null)) return null;
            const n = Number(v) || 0;
            if (n < 0) throw httpError(400, `${label} لا يمكن أن يكون سالباً`);
            return n;
        };
        const variants = (b.variants || []).map((v) => {
            if (!text(v.label)) throw httpError(400, 'اكتب اسم السماكة / الدرجة لكل شريحة');
            const product = getProduct(v.product_id);
            if (!product || product.category !== 'slat') throw httpError(400, 'اختر منتج شرائح لكل سماكة');
            return {
                id: v.id, label: text(v.label, 80), product_id: product.id, description: text(v.description),
                width_add_cm: nonNegative(v.width_add_cm, 'زيادة العرض'), height_add_cm: nonNegative(v.height_add_cm, 'زيادة الارتفاع')
            };
        });
        if (!variants.length) throw httpError(400, 'أضف سماكة واحدة على الأقل');
        const colors = (b.colors || []).map((c) => {
            if (!text(c.name)) throw httpError(400, 'اكتب اسم اللون');
            const vi = c.variant_index === '' || c.variant_index == null ? null : Number(c.variant_index);
            if (vi !== null && !(vi >= 0 && vi < variants.length)) throw httpError(400, 'سماكة اللون غير صحيحة');
            return {
                id: c.id, name: text(c.name, 40), hex: /^#[0-9a-f]{6}$/i.test(c.hex || '') ? c.hex : null, variant_index: vi,
                price_per_m2: nonNegative(c.price_per_m2, 'سعر المتر المربع', true), fixed_fee: nonNegative(c.fixed_fee, 'رسوم الصبغ'),
                surcharge_per_m2: nonNegative(c.surcharge_per_m2, 'إضافة اللون')
            };
        });
        return {
            name: text(b.name, 80), description: text(b.description), image_url: text(b.image_url, 500),
            sort_order: Number(b.sort_order) || 0, active: b.active === false ? 0 : 1, variants, colors
        };
    };

    const saveShutterType = (id, t) => {
        syncChildren('shutter_variants', 'shutter_type_id', id, t.variants, ['label', 'product_id', 'description', 'width_add_cm', 'height_add_cm']);
        // Colors point at a thickness by its row position in the form; resolve to the saved ids
        const variantIds = db.prepare('SELECT id FROM shutter_variants WHERE shutter_type_id = ? ORDER BY sort_order, id').all(id).map((r) => r.id);
        const colors = t.colors.map((c) => ({ ...c, variant_id: c.variant_index === null ? null : variantIds[c.variant_index] }));
        syncChildren('shutter_colors', 'shutter_type_id', id, colors, ['name', 'hex', 'variant_id', 'price_per_m2', 'fixed_fee', 'surcharge_per_m2']);
    };

    admin.post('/shutter-types', (req, res) => {
        const t = parseShutterType(req.body || {});
        const id = tx(() => {
            const newId = Number(db.prepare('INSERT INTO shutter_types (name, description, image_url, sort_order, active) VALUES (?, ?, ?, ?, ?)')
                .run(t.name, t.description, t.image_url, t.sort_order, t.active).lastInsertRowid);
            saveShutterType(newId, t);
            return newId;
        });
        res.status(201).json({ id });
    });

    admin.put('/shutter-types/:id', (req, res) => {
        const id = Number(req.params.id);
        const t = parseShutterType(req.body || {});
        tx(() => {
            const info = db.prepare('UPDATE shutter_types SET name = ?, description = ?, image_url = ?, sort_order = ?, active = ? WHERE id = ?')
                .run(t.name, t.description, t.image_url, t.sort_order, t.active, id);
            if (!info.changes) throw httpError(404, 'نوع البوابة غير موجود');
            saveShutterType(id, t);
        });
        res.json({ id });
    });

    admin.delete('/shutter-types/:id', (req, res) => {
        db.prepare('DELETE FROM shutter_types WHERE id = ?').run(Number(req.params.id));
        res.status(204).end();
    });

    const parseGroup = (b) => {
        if (!text(b.name)) throw httpError(400, 'اسم مجموعة الإكسسوارات مطلوب');
        if (!['fixed', 'width', 'height', 'area'].includes(b.basis)) throw httpError(400, 'طريقة حساب الكمية غير صالحة');
        const factor = Number(b.factor);
        if (!(factor > 0)) throw httpError(400, 'المعامل يجب أن يكون أكبر من صفر');
        const options = (b.options || []).map((o) => {
            if (!text(o.label)) throw httpError(400, 'اكتب اسم كل فئة (مثل Class A)');
            return {
                id: o.id, label: text(o.label, 60), product_id: requireProduct(o.product_id), details: text(o.details),
                image_url: text(o.image_url, 500), active: o.active === false ? 0 : 1
            };
        });
        return {
            name: text(b.name, 80), description: text(b.description), basis: b.basis, factor,
            allow_none: b.allow_none ? 1 : 0, none_label: text(b.none_label, 60),
            sort_order: Number(b.sort_order) || 0, active: b.active === false ? 0 : 1, options
        };
    };

    const groupCols = ['name', 'description', 'basis', 'factor', 'allow_none', 'none_label', 'sort_order', 'active'];

    admin.post('/accessory-groups', (req, res) => {
        const g = parseGroup(req.body || {});
        const id = tx(() => {
            const newId = Number(db.prepare(`INSERT INTO accessory_groups (${groupCols.join(', ')}) VALUES (${groupCols.map(() => '?').join(', ')})`)
                .run(...groupCols.map((c) => g[c])).lastInsertRowid);
            syncChildren('accessory_options', 'group_id', newId, g.options, ['label', 'product_id', 'details', 'image_url', 'active']);
            return newId;
        });
        res.status(201).json({ id });
    });

    admin.put('/accessory-groups/:id', (req, res) => {
        const id = Number(req.params.id);
        const g = parseGroup(req.body || {});
        tx(() => {
            const info = db.prepare(`UPDATE accessory_groups SET ${groupCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
                .run(...groupCols.map((c) => g[c]), id);
            if (!info.changes) throw httpError(404, 'المجموعة غير موجودة');
            syncChildren('accessory_options', 'group_id', id, g.options, ['label', 'product_id', 'details', 'image_url', 'active']);
        });
        res.json({ id });
    });

    admin.delete('/accessory-groups/:id', (req, res) => {
        db.prepare('DELETE FROM accessory_groups WHERE id = ?').run(Number(req.params.id));
        res.status(204).end();
    });

    /* Try a size — the same numbers the customer page and the AI agent will show */
    admin.get('/configurator/preview', (req, res) => {
        const q = { widthCm: req.query.width_cm, heightCm: req.query.height_cm, count: Number(req.query.count) || 1,
            shutterTypeId: req.query.shutter_type_id || null, regionId: req.query.region_id || null };
        res.json({
            range: doors.priceRange(db, q),
            compare: q.shutterTypeId ? doors.compareOptions(db, q) : null
        });
    });

    /* Replace shutter types and installation fees with the company site's catalog */
    admin.post('/import/radma-catalog', (req, res) => {
        require('./radma-catalog').applyRadmaCatalog(db);
        res.json({ ok: true, shutter_types: db.prepare('SELECT COUNT(*) AS n FROM shutter_types').get().n });
    });

    admin.get('/governorates', (req, res) => res.json(db.prepare('SELECT * FROM governorates ORDER BY sort_order, name').all()));

    admin.put('/governorates/:id', (req, res) => {
        const info = db.prepare('UPDATE governorates SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, Number(req.params.id));
        if (!info.changes) throw httpError(404, 'المحافظة غير موجودة');
        res.json(db.prepare('SELECT * FROM governorates WHERE id = ?').get(Number(req.params.id)));
    });

    admin.get('/regions', (req, res) => res.json(db.prepare('SELECT * FROM regions ORDER BY governorate, name').all()));

    admin.post('/regions', (req, res) => {
        const name = String((req.body || {}).name || '').trim();
        const governorate = String(req.body.governorate || '').trim();
        if (!name || !governorate) throw httpError(400, 'اسم الولاية والمحافظة مطلوبان');
        db.prepare('INSERT OR IGNORE INTO governorates (name, sort_order) VALUES (?, 99)').run(governorate);
        const info = db.prepare('INSERT INTO regions (name, governorate) VALUES (?, ?)').run(name, governorate);
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
        const id = Number(req.params.id);
        const current = db.prepare('SELECT * FROM regions WHERE id = ?').get(id);
        if (!current) throw httpError(404, 'الولاية غير موجودة');
        // Only fields that were sent change (saving fees must not re-enable a disabled wilayah)
        const info = db.prepare('UPDATE regions SET delivery_fee = ?, installation_fee = ?, active = ? WHERE id = ?')
            .run(b.delivery_fee === undefined ? current.delivery_fee : fee(b.delivery_fee),
                b.installation_fee === undefined ? current.installation_fee : fee(b.installation_fee),
                b.active === undefined ? current.active : (b.active ? 1 : 0), id);
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
    // Pages: the customer calculator is the site's home page (shareable link, no password);
    // the admin panel lives at /admin and asks for the admin password.
    const publicDir = path.join(__dirname, '..', 'public');
    app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'calculator.html')));
    app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
    app.get(['/index.html', '/admin.html'], (req, res) => res.redirect(301, '/admin'));
    app.use(express.static(publicDir, { index: false }));

    app.use('/api', (req, res) => res.status(404).json({ error: 'غير موجود' }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
        if (status >= 500) console.error(err);
        res.status(status).json({ error: status >= 500 ? 'خطأ في الخادم' : err.message });
    });

    return app;
}

let started = false;

function start() {
    if (started) return; // may be reached twice (auto-start + app.js); listen only once
    started = true;
    try { process.loadEnvFile(); } catch { /* .env is optional */ }
    const db = openDatabase();
    // PORT is usually a number; some hosting runners pass a socket path instead
    const port = process.env.PORT || 3000;
    createApp(db).listen(/^\d+$/.test(String(port)) ? Number(port) : port, () => {
        console.log(`Aluminum pricing server listening on ${port} (Node ${process.versions.node})`);
        console.log(`  • حاسبة العملاء:  /`);
        console.log(`  • لوحة الإدارة:   /admin`);
        if (!process.env.ADMIN_TOKEN) console.warn('  ! ADMIN_TOKEN غير مضبوط — لوحة الإدارة مقفلة');
        console.log(`  • واتساب: ${whatsapp.isConfigured() ? 'مفعّل' : 'غير مفعّل'}`);
        console.log(`  • المساعد الذكي: ${agent.isConfigured() ? 'مفعّل' : 'غير مفعّل (ANTHROPIC_API_KEY)'}`);
    });
}

/* Start when run directly (node src/server.js), and also when a hosting runner outside this
   project loads the file (shared hosting wraps the entry file, so require.main is the runner).
   Files inside the project (app.js, tests) decide for themselves. */
const projectRoot = path.join(__dirname, '..');
const loadedByOutsideRunner = !require.main || !require.main.filename.startsWith(projectRoot + path.sep);
if (require.main === module || loadedByOutsideRunner) start();

module.exports = { createApp, saveQuote, start };
