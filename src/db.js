/* =============================================================
   Database layer (SQLite via Node's built-in node:sqlite)
   ============================================================= */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
    lme: 2300,               // دولار/طن
    manufacturing: 800,      // دولار/طن
    painting: 200,           // ريال/طن
    exchange_rate: 0.385,    // ريال عماني لكل دولار
    profit_percent: 15,      // نسبة الربح الافتراضية
    vat_percent: 5,
    tax_mode: 'accounting',
    sqm_to_linear: 13,       // 1 م² = 13 متر طولي من الشرائح
    company_name: 'مصنع شرائح الألمنيوم',
    company_whatsapp: '',    // رقم واتساب الشركة بالصيغة الدولية مثل 9689XXXXXXX
    public_base_url: ''      // رابط الموقع العام، يستخدم في رسائل واتساب
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    category         TEXT NOT NULL CHECK (category IN ('slat', 'accessory', 'machine')),
    name             TEXT NOT NULL,
    type             TEXT,
    unit             TEXT NOT NULL DEFAULT 'piece',
    pricing_mode     TEXT NOT NULL DEFAULT 'manual' CHECK (pricing_mode IN ('manual', 'lme')),
    purchase_price   REAL NOT NULL DEFAULT 0,
    profit_percent   REAL,
    sell_price       REAL,
    thickness        REAL,
    weight_per_meter REAL,
    painted          INTEGER NOT NULL DEFAULT 0,
    is_public        INTEGER NOT NULL DEFAULT 1,
    active           INTEGER NOT NULL DEFAULT 1,
    notes            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchases (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    supplier       TEXT,
    quantity       REAL NOT NULL DEFAULT 1,
    unit_price     REAL NOT NULL,
    currency       TEXT NOT NULL DEFAULT 'OMR',
    exchange_rate  REAL NOT NULL DEFAULT 1,
    extra_cost     REAL NOT NULL DEFAULT 0,
    unit_cost_omr  REAL NOT NULL,
    purchased_at   TEXT NOT NULL DEFAULT (date('now')),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    field       TEXT NOT NULL,
    old_value   REAL,
    new_value   REAL,
    source      TEXT,
    changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ref             TEXT NOT NULL UNIQUE,
    customer_name   TEXT NOT NULL,
    customer_phone  TEXT NOT NULL,
    customer_city   TEXT,
    notes           TEXT,
    items_json      TEXT NOT NULL,
    subtotal        REAL NOT NULL,
    vat_percent     REAL NOT NULL,
    vat             REAL NOT NULL,
    total           REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'contacted', 'accepted', 'rejected', 'done')),
    source          TEXT NOT NULL DEFAULT 'web',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    secret      TEXT,
    events      TEXT NOT NULL DEFAULT '*',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id   INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event        TEXT NOT NULL,
    status_code  INTEGER,
    ok           INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases(product_id);
CREATE INDEX IF NOT EXISTS idx_history_product ON price_history(product_id);
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at);
`;

/* Starter catalog, inserted only into an empty database.
   Slats use the LME formula from the original app, so their prices are real.
   Accessories and machines carry placeholder purchase prices and are hidden
   from customers (is_public = 0) until the owner reviews them. */
const SAMPLE_PRODUCTS = [
    { category: 'slat', name: 'شريحة ألمنيوم', type: '1.1 ملم مصبوغة', unit: 'meter', pricing_mode: 'lme', thickness: 1.1, weight_per_meter: 0.63, painted: 1 },
    { category: 'slat', name: 'شريحة ألمنيوم', type: '1.1 ملم بدون صبغ', unit: 'meter', pricing_mode: 'lme', thickness: 1.1, weight_per_meter: 0.63, painted: 0 },
    { category: 'slat', name: 'شريحة ألمنيوم', type: '1.5 ملم مصبوغة', unit: 'meter', pricing_mode: 'lme', thickness: 1.5, weight_per_meter: 0.839, painted: 1 },
    { category: 'slat', name: 'شريحة ألمنيوم', type: '1.5 ملم بدون صبغ', unit: 'meter', pricing_mode: 'lme', thickness: 1.5, weight_per_meter: 0.839, painted: 0 },
    { category: 'accessory', name: 'مجرى جانبي', type: 'ألمنيوم', unit: 'meter', purchase_price: 1.2, is_public: 0, notes: 'سعر تجريبي — عدّله' },
    { category: 'accessory', name: 'عمود (محور)', type: 'حديد مجلفن', unit: 'meter', purchase_price: 2.5, is_public: 0, notes: 'سعر تجريبي — عدّله' },
    { category: 'accessory', name: 'قفل', type: 'قفل أرضي', unit: 'piece', purchase_price: 1.5, is_public: 0, notes: 'سعر تجريبي — عدّله' },
    { category: 'machine', name: 'موتور أنبوبي', type: '50 نيوتن', unit: 'piece', purchase_price: 35, is_public: 0, notes: 'سعر تجريبي — عدّله' },
    { category: 'machine', name: 'موتور جانبي', type: '600 كجم', unit: 'piece', purchase_price: 90, is_public: 0, notes: 'سعر تجريبي — عدّله' }
];

function openDatabase(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'aluminum.db')) {
    if (file !== ':memory:') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);

    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        insertSetting.run(key, JSON.stringify(value));
    }

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM products').get();
    if (n === 0 && process.env.SEED_SAMPLE !== '0') {
        const insert = db.prepare(`
            INSERT INTO products (category, name, type, unit, pricing_mode, purchase_price,
                                  thickness, weight_per_meter, painted, is_public, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const p of SAMPLE_PRODUCTS) {
            insert.run(p.category, p.name, p.type, p.unit, p.pricing_mode || 'manual',
                p.purchase_price || 0, p.thickness ?? null, p.weight_per_meter ?? null,
                p.painted || 0, p.is_public ?? 1, p.notes ?? null);
        }
    }
    return db;
}

function getSettings(db) {
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
        settings[row.key] = JSON.parse(row.value);
    }
    return settings;
}

function saveSettings(db, patch) {
    const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                               ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (patch[key] === undefined) continue;
        const numeric = typeof DEFAULT_SETTINGS[key] === 'number';
        const value = numeric ? Number(patch[key]) : String(patch[key]);
        if (numeric && !Number.isFinite(value)) {
            throw Object.assign(new Error(`قيمة غير صالحة للحقل ${key}`), { status: 400 });
        }
        upsert.run(key, JSON.stringify(value));
    }
    return getSettings(db);
}

module.exports = { openDatabase, getSettings, saveSettings, DEFAULT_SETTINGS };
