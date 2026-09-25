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
    public_base_url: '',     // رابط الموقع العام، يستخدم في رسائل واتساب وروابط PDF
    quote_validity_days: 15  // مدة صلاحية عرض السعر
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

-- A complete roller-shutter door: one slat product + accessories whose
-- quantities follow the door size. door_type groups packages ("يدوي", "كهربائي").
CREATE TABLE IF NOT EXISTS door_packages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    door_type        TEXT NOT NULL,
    name             TEXT NOT NULL,
    description      TEXT,
    slat_product_id  INTEGER NOT NULL REFERENCES products(id),
    min_area         REAL,
    max_area         REAL,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    active           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS door_package_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id  INTEGER NOT NULL REFERENCES door_packages(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    basis       TEXT NOT NULL DEFAULT 'fixed' CHECK (basis IN ('fixed', 'width', 'height', 'area')),
    factor      REAL NOT NULL DEFAULT 1,
    optional    INTEGER NOT NULL DEFAULT 0
);

-- Wilayat with delivery / installation fees (NULL = decided after site visit)
CREATE TABLE IF NOT EXISTS regions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE,
    governorate       TEXT,
    delivery_fee      REAL,
    installation_fee  REAL,
    active            INTEGER NOT NULL DEFAULT 1
);

-- WhatsApp / test conversations with the AI sales agent
CREATE TABLE IF NOT EXISTS agent_conversations (
    conversation_key  TEXT PRIMARY KEY,
    channel           TEXT NOT NULL,
    messages_json     TEXT NOT NULL DEFAULT '[]',
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
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

const WILAYAT = {
    'مسقط': ['مسقط', 'مطرح', 'بوشر', 'السيب', 'العامرات', 'قريات'],
    'ظفار': ['صلالة', 'طاقة', 'مرباط', 'رخيوت', 'ثمريت', 'ضلكوت', 'المزيونة', 'مقشن', 'شليم وجزر الحلانيات', 'سدح'],
    'مسندم': ['خصب', 'دبا', 'بخا', 'مدحاء'],
    'البريمي': ['البريمي', 'محضة', 'السنينة'],
    'الداخلية': ['نزوى', 'بهلاء', 'منح', 'الحمراء', 'أدم', 'إزكي', 'سمائل', 'بدبد', 'الجبل الأخضر'],
    'شمال الباطنة': ['صحار', 'شناص', 'لوى', 'صحم', 'الخابورة', 'السويق'],
    'جنوب الباطنة': ['الرستاق', 'العوابي', 'نخل', 'وادي المعاول', 'بركاء', 'المصنعة'],
    'جنوب الشرقية': ['صور', 'الكامل والوافي', 'جعلان بني بو حسن', 'جعلان بني بو علي', 'مصيرة'],
    'شمال الشرقية': ['إبراء', 'المضيبي', 'بدية', 'القابل', 'وادي بني خالد', 'دماء والطائيين'],
    'الظاهرة': ['عبري', 'ينقل', 'ضنك'],
    'الوسطى': ['هيماء', 'محوت', 'الدقم', 'الجازر']
};

/* Extra accessories the sample door packages need (hidden, placeholder prices) */
const DOOR_SAMPLE_PRODUCTS = [
    { key: 'guide', category: 'accessory', name: 'مجرى جانبي', type: 'ألمنيوم', unit: 'meter', purchase_price: 1.2 },
    { key: 'axle', category: 'accessory', name: 'عمود (محور)', type: 'حديد مجلفن', unit: 'meter', purchase_price: 2.5 },
    { key: 'lock', category: 'accessory', name: 'قفل', type: 'قفل أرضي', unit: 'piece', purchase_price: 1.5 },
    { key: 'bottom', category: 'accessory', name: 'قاطع سفلي', type: 'ألمنيوم مع مطاط', unit: 'meter', purchase_price: 1.8 },
    { key: 'spring', category: 'accessory', name: 'نابض (سوستة)', type: 'للأبواب اليدوية', unit: 'piece', purchase_price: 4 },
    { key: 'remote', category: 'accessory', name: 'ريموت إضافي', type: 'لاسلكي', unit: 'piece', purchase_price: 5 },
    { key: 'ups', category: 'accessory', name: 'بطارية احتياطية', type: 'تشغيل عند انقطاع الكهرباء', unit: 'piece', purchase_price: 45 },
    { key: 'tubular', category: 'machine', name: 'موتور أنبوبي', type: '50 نيوتن', unit: 'piece', purchase_price: 35 },
    { key: 'side', category: 'machine', name: 'موتور جانبي', type: '600 كجم', unit: 'piece', purchase_price: 90 }
];

const DOOR_SAMPLE_PACKAGES = [
    { door_type: 'يدوي', name: 'يدوي اقتصادي', slat: [1.1, 0], max_area: 12, description: 'شرائح 1.1 ملم بدون صبغ مع نوابض وقفل',
      items: [['guide', 'height', 2], ['axle', 'width', 1], ['bottom', 'width', 1], ['spring', 'fixed', 2], ['lock', 'fixed', 1]] },
    { door_type: 'يدوي', name: 'يدوي قياسي', slat: [1.1, 1], max_area: 12, description: 'شرائح 1.1 ملم مصبوغة مع نوابض وقفل',
      items: [['guide', 'height', 2], ['axle', 'width', 1], ['bottom', 'width', 1], ['spring', 'fixed', 2], ['lock', 'fixed', 1]] },
    { door_type: 'كهربائي', name: 'كهربائي قياسي', slat: [1.1, 1], max_area: 12, description: 'شرائح 1.1 ملم مصبوغة مع موتور أنبوبي وريموت',
      items: [['guide', 'height', 2], ['axle', 'width', 1], ['bottom', 'width', 1], ['tubular', 'fixed', 1], ['remote', 'fixed', 1, 1], ['ups', 'fixed', 1, 1]] },
    { door_type: 'كهربائي', name: 'كهربائي ممتاز', slat: [1.5, 1], max_area: 30, description: 'شرائح 1.5 ملم مصبوغة مع موتور جانبي قوي للأبواب الكبيرة',
      items: [['guide', 'height', 2], ['axle', 'width', 1], ['bottom', 'width', 1], ['side', 'fixed', 1], ['remote', 'fixed', 1, 1], ['ups', 'fixed', 1, 1]] }
];

function seedDoors(db) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM door_packages').get();
    if (n > 0 || process.env.SEED_SAMPLE === '0') return;

    const findOrCreate = (p) => {
        const row = db.prepare('SELECT id FROM products WHERE category = ? AND name = ? AND IFNULL(type, \'\') = ?')
            .get(p.category, p.name, p.type || '');
        if (row) return row.id;
        return Number(db.prepare(`INSERT INTO products (category, name, type, unit, purchase_price, is_public, notes)
                                  VALUES (?, ?, ?, ?, ?, 0, 'سعر تجريبي — عدّله')`)
            .run(p.category, p.name, p.type, p.unit, p.purchase_price).lastInsertRowid);
    };
    const ids = Object.fromEntries(DOOR_SAMPLE_PRODUCTS.map((p) => [p.key, findOrCreate(p)]));
    const slatId = (thickness, painted) => {
        const row = db.prepare(`SELECT id FROM products WHERE category = 'slat' AND pricing_mode = 'lme'
                                AND thickness = ? AND painted = ? ORDER BY id LIMIT 1`).get(thickness, painted);
        return row && row.id;
    };

    const insertPkg = db.prepare(`INSERT INTO door_packages (door_type, name, description, slat_product_id, max_area, sort_order)
                                  VALUES (?, ?, ?, ?, ?, ?)`);
    const insertItem = db.prepare(`INSERT INTO door_package_items (package_id, product_id, basis, factor, optional)
                                   VALUES (?, ?, ?, ?, ?)`);
    DOOR_SAMPLE_PACKAGES.forEach((pkg, i) => {
        const slat = slatId(...pkg.slat);
        if (!slat) return;
        const pkgId = insertPkg.run(pkg.door_type, pkg.name, pkg.description, slat, pkg.max_area, i).lastInsertRowid;
        for (const [key, basis, factor, optional] of pkg.items) {
            insertItem.run(pkgId, ids[key], basis, factor, optional || 0);
        }
    });
}

function seedRegions(db) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM regions').get();
    if (n > 0) return;
    const insert = db.prepare('INSERT INTO regions (name, governorate) VALUES (?, ?)');
    for (const [gov, list] of Object.entries(WILAYAT)) for (const w of list) insert.run(w, gov);
}

/* Additive migrations for databases created by earlier versions */
function migrate(db) {
    const cols = db.prepare('PRAGMA table_info(quotes)').all().map((c) => c.name);
    if (!cols.includes('access_key')) db.exec('ALTER TABLE quotes ADD COLUMN access_key TEXT');
    if (!cols.includes('details_json')) db.exec('ALTER TABLE quotes ADD COLUMN details_json TEXT');
}

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
    migrate(db);
    seedDoors(db);
    seedRegions(db);
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
