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
    quote_validity_days: 15, // مدة صلاحية عرض السعر
    // نصوص صفحة العميل (الترويسة والتذييل والملاحظات) — تُعدَّل من تبويب الربط
    company_tagline: 'علامة تجارية عُمانية 100% بإدارة عُمانية 100%',
    company_phone: '90660001',
    company_address: 'نزوى – سعال',
    company_website: 'radma.co',
    calculator_notice: 'الأسعار في الحاسبة الإلكترونية تقديرية - اطلب عرض الأسعار',
    calculator_notes: 'الأسعار تشمل التركيب والملحقات الأساسية\nالأسعار ابتدائية وقد تختلف حسب طبيعة العمل\nالضمان يشمل عيوب التصنيع لمدة 5 سنوات',
    // الشروط والأحكام في ملف PDF لعرض السعر — كل سطر شرط، ويُرقَّم تلقائياً
    quote_terms: [
        'الأسعار لمدة 14 يوم من تاريخ العرض ويتم التوريد خلال 14 يوم من إستلام طلب الشراء.',
        'يتم دفع وديعة كمقدم 40% في حال التعاقد قبل شهرين من التركيب وتقوم الشركة بالإشراف.',
        'يتم دفع 70% عند التعاقد و30% قبل التركيب بيوم واحد.',
        'يحق للمؤسسة أن ترفع قيمة القطع والخدمة والعدد في حال طلب العميل إجراء بعض التعديلات.',
        'يحق للمؤسسة عمل لوحة تعريفية بالشركة مع الشعار ووسائل التواصل.'
    ].join('\n')
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

-- ===== Roller-shutter door configurator (customer calculator + AI agent) =====
-- Shutter type (e.g. Iranian / Turkish / Omani) → variants (thickness) and colors
CREATE TABLE IF NOT EXISTS shutter_types (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    description  TEXT,
    image_url    TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shutter_variants (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    shutter_type_id  INTEGER NOT NULL REFERENCES shutter_types(id) ON DELETE CASCADE,
    label            TEXT NOT NULL,
    product_id       INTEGER NOT NULL REFERENCES products(id),
    sort_order       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shutter_colors (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    shutter_type_id   INTEGER NOT NULL REFERENCES shutter_types(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    hex               TEXT,
    surcharge_per_m2  REAL NOT NULL DEFAULT 0,
    sort_order        INTEGER NOT NULL DEFAULT 0
);

-- Accessory groups (channels, axle, bases, motor…) each offering classes A/B/C.
-- Quantity per door = factor × (1 | width m | height m | area m²)
CREATE TABLE IF NOT EXISTS accessory_groups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    description  TEXT,
    basis        TEXT NOT NULL DEFAULT 'fixed' CHECK (basis IN ('fixed', 'width', 'height', 'area')),
    factor       REAL NOT NULL DEFAULT 1,
    allow_none   INTEGER NOT NULL DEFAULT 0,
    none_label   TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS accessory_options (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL REFERENCES accessory_groups(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    details     TEXT,
    image_url   TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
);

-- Governorates the admin enables for the customer form
CREATE TABLE IF NOT EXISTS governorates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
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

-- Overhead (sectional) gates: a price range per type × standard size, and the motors
CREATE TABLE IF NOT EXISTS overhead_sizes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    gate_type   TEXT NOT NULL,
    height_cm   REAL NOT NULL,
    width_cm    REAL NOT NULL,
    price_from  REAL NOT NULL,
    price_to    REAL NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS overhead_motors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    price       REAL NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0
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

/* Starter accessory groups (classes A/B/C) with placeholder prices and texts for
   the owner to replace. The shutter types, their prices and the installation fees
   come from the company site's calculator (src/radma-catalog.js). */
const SAMPLE_ACCESSORIES = [
    { name: 'المسارات الجانبية (Channels)', basis: 'height', factor: 2, unit: 'meter', prices: [0.9, 1.3, 1.8],
      description: 'المجاري التي تنزلق فيها الشرائح على جانبي الفتحة.' },
    { name: 'عمود محور الدوران', basis: 'width', factor: 1, unit: 'meter', prices: [2, 2.8, 3.6],
      description: 'العمود الذي تلتف عليه الشرائح أعلى الفتحة.' },
    { name: 'القواعد', basis: 'fixed', factor: 2, unit: 'piece', prices: [1.5, 2.5, 3.5],
      description: 'القواعد التي تحمل عمود الدوران على الجانبين.' },
    { name: 'المحرك', basis: 'fixed', factor: 1, unit: 'piece', prices: [30, 55, 90], allow_none: true, none_label: 'بدون محرك (يدوي)',
      description: 'المحرك الكهربائي لفتح وإغلاق البوابة.' }
];

function seedConfigurator(db) {
    if (process.env.SEED_SAMPLE === '0') return;
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM shutter_types').get();
    if (n === 0) require('./radma-catalog').applyRadmaCatalog(db);
    // Overhead gates: start from the company site's overhead calculator (also on existing databases)
    const overhead = db.prepare('SELECT (SELECT COUNT(*) FROM overhead_sizes) + (SELECT COUNT(*) FROM overhead_motors) AS n').get();
    if (overhead.n === 0) require('./radma-catalog').applyOverheadCatalog(db);

    if (db.prepare('SELECT COUNT(*) AS n FROM accessory_groups').get().n > 0) return;
    const findOrCreate = (p, category) => {
        const row = db.prepare('SELECT id FROM products WHERE category = ? AND name = ? AND IFNULL(type, \'\') = ?')
            .get(category, p.name, p.type || '');
        if (row) return row.id;
        return Number(db.prepare(`INSERT INTO products (category, name, type, unit, purchase_price, is_public, notes)
                                  VALUES (?, ?, ?, ?, ?, 0, 'سعر تجريبي — عدّله')`)
            .run(category, p.name, p.type || null, p.unit, p.purchase_price).lastInsertRowid);
    };
    SAMPLE_ACCESSORIES.forEach((g, i) => {
        const groupId = db.prepare(`INSERT INTO accessory_groups (name, description, basis, factor, allow_none, none_label, sort_order)
                                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(g.name, g.description, g.basis, g.factor, g.allow_none ? 1 : 0, g.none_label || null, i).lastInsertRowid;
        ['Class A', 'Class B', 'Class C'].forEach((label, j) => {
            const shortName = g.name.replace(/\s*\(.*\)$/, '');
            const productId = findOrCreate({ name: shortName, type: label, unit: g.unit, purchase_price: g.prices[j] },
                g.name === 'المحرك' ? 'machine' : 'accessory');
            db.prepare(`INSERT INTO accessory_options (group_id, label, product_id, details, sort_order) VALUES (?, ?, ?, ?, ?)`)
                .run(groupId, label, productId, `مواصفات ${shortName} ${label} — تفاصيل تجريبية، عدّلها من لوحة الإدارة.`, j);
        });
    });
}

function seedRegions(db) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM regions').get();
    if (n === 0) {
        const insert = db.prepare('INSERT INTO regions (name, governorate) VALUES (?, ?)');
        for (const [gov, list] of Object.entries(WILAYAT)) for (const w of list) insert.run(w, gov);
    }
    // Every governorate used by a wilayah gets a row the admin can enable or disable
    const govs = db.prepare('SELECT DISTINCT governorate FROM regions WHERE governorate IS NOT NULL').all().map((r) => r.governorate);
    const order = Object.keys(WILAYAT);
    const insertGov = db.prepare('INSERT OR IGNORE INTO governorates (name, sort_order) VALUES (?, ?)');
    for (const g of govs) insertGov.run(g, order.includes(g) ? order.indexOf(g) : 99);
}

/* Additive migrations for databases created by earlier versions */
function migrate(db) {
    const addColumns = (table, defs) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        for (const [name, def] of Object.entries(defs)) {
            if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        }
    };
    addColumns('quotes', { access_key: 'TEXT', details_json: 'TEXT' });
    // Thickness/grade: its own description and the size allowance used for the slat area
    addColumns('shutter_variants', { description: 'TEXT', width_add_cm: 'REAL NOT NULL DEFAULT 0', height_add_cm: 'REAL NOT NULL DEFAULT 0' });
    // Colors can belong to one thickness (NULL = all), replace the price per m² and add a fixed fee
    addColumns('shutter_colors', { variant_id: 'INTEGER', price_per_m2: 'REAL', fixed_fee: 'REAL NOT NULL DEFAULT 0' });
    // Overhead gates have their own installation fee per wilayah (NULL = not offered there)
    addColumns('regions', { overhead_installation_fee: 'REAL' });
}

/* "~/radma-data/aluminum.db" → the account's home folder. On shared hosting this keeps the
   database outside the app folder, so redeploying the code never replaces it. */
function resolveDbPath(file) {
    if (file === ':memory:') return file;
    return file.startsWith('~/') ? path.join(require('node:os').homedir(), file.slice(2)) : file;
}

function openDatabase(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'aluminum.db')) {
    file = resolveDbPath(file);
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
    seedRegions(db);        // wilayat first: the catalog import sets their installation fees
    seedConfigurator(db);
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
