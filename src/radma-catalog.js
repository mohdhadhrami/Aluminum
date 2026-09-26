/* =============================================================
   Radma catalog — the shutter types, prices and installation fees of
   the company site's rolling-shutter calculator (radma-om/radma,
   price-calc/rolling-shutter), arranged as type → thickness/grade → color.

   Used as the starting catalog of a new database, and by the admin
   "import" button to replace the current shutter types and fees.
   Accessory classes are NOT touched: they replace the site's fixed
   accessory/base/motor amounts and are priced in the admin panel.
   ============================================================= */

const HEX = { 'أبيض': '#f4f4f2', 'بيج': '#d8c7a6', 'فضي': '#c0c4c8', 'رمادي': '#8c9197', 'أسود': '#2b2b2b', 'خشبي': '#8b5a2b' };
const WARRANTY = 'ضمان 5 سنوات ضد التآكل والصدأ';

/* price = sell price per m² (OMR); addW/addH = cm added to the opening before computing the slat area */
const SHUTTER_TYPES = [
    {
        name: 'الإيراني',
        description: 'شرائح ألومنيوم صناعة إيرانية.',
        variants: [
            { label: 'Grade C', price: 14, addW: 15, addH: 60,
              description: `شريحة ألومنيوم مزدوج الطبقات ب 3 جسور صناعة إيرانية وزن المتر المربع 4 كجم. ${WARRANTY} صبغة المصنع`,
              colors: ['أبيض', 'بيج', 'فضي', 'رمادي', 'أسود'] }
        ]
    },
    {
        name: 'التركي',
        description: 'شرائح ألومنيوم صناعة تركية بدرجتين.',
        variants: [
            { label: 'Grade B', price: 16.5, addW: 15, addH: 60,
              description: `شريحة ألومنيوم مزدوج الطبقات ب 3 جسور صناعة تركية وزن المتر المربع 5.56 كجم (الخشبي 5.3 كجم). ${WARRANTY} صبغة المصنع`,
              colors: ['أبيض', 'فضي', 'رمادي', 'أسود', { name: 'خشبي', price: 26 }] },
            { label: 'Grade A', price: 20.5, addW: 20, addH: 60,
              description: `شريحة ألومنيوم مزدوج الطبقات بجسر واحد صناعة تركية وزن المتر المربع 6.125 كجم. ${WARRANTY} صبغة المصنع`,
              colors: ['أبيض', 'بيج'] }
        ]
    },
    {
        name: 'العماني NAPCO',
        description: 'شرائح ألومنيوم عُمانية صناعة NAPCO بسماكتين، ويمكن طلب اللون.',
        variants: [
            { label: '1.1 ملم', price: 21.5, addW: 20, addH: 60,
              description: `شريحة ألومنيوم مزدوج الطبقات صناعة NAPCO وزن المتر المربع 8.37 كجم. ${WARRANTY}. الأبيض بصبغة مصنع NAPCO، والملون بصبغ فرن حراري`,
              colors: ['أبيض', { name: 'ملون (حسب الطلب)', price: 19.5, fee: 60 }] },
            { label: '1.5 ملم', price: 27, addW: 20, addH: 60,
              description: `شريحة ألومنيوم مزدوج الطبقات صناعة NAPCO وزن المتر المربع 10.18 كجم. ${WARRANTY}. الأبيض بصبغة مصنع NAPCO، والملون بصبغ فرن حراري`,
              colors: ['أبيض', { name: 'ملون (حسب الطلب)', price: 24.5, fee: 70 }] }
        ]
    }
];

/* Governorates and wilayat the site serves, with the installation fee per gate (OMR) */
const INSTALLATION = {
    'الداخلية': { 'نزوى': 60, 'بهلاء': 80, 'الحمراء': 80, 'أدم': 90, 'إزكي': 80, 'منح': 70, 'سمائل': 80, 'بدبد': 90, 'الجبل الأخضر': 110 },
    'مسقط': { 'مسقط': 100, 'السيب': 90, 'بوشر': 90, 'مطرح': 100, 'العامرات': 100 },
    'جنوب الباطنة': { 'المصنعة': 110, 'بركاء': 90 },
    'شمال الشرقية': { 'إبراء': 100, 'سناو': 100, 'المضيبي': 100, 'دماء والطائيين': 110 },
    'الظاهرة': { 'عبري': 110 }
};

function slatProduct(db, typeName, variantLabel, pricePerM2) {
    const name = `شرائح ${typeName}`;
    const row = db.prepare(`SELECT id FROM products WHERE category = 'slat' AND name = ? AND IFNULL(type, '') = ?`).get(name, variantLabel);
    if (row) {
        db.prepare(`UPDATE products SET unit = 'm2', pricing_mode = 'manual', sell_price = ?, active = 1, updated_at = datetime('now') WHERE id = ?`)
            .run(pricePerM2, row.id);
        return row.id;
    }
    return Number(db.prepare(`INSERT INTO products (category, name, type, unit, pricing_mode, purchase_price, sell_price, is_public, notes)
                              VALUES ('slat', ?, ?, 'm2', 'manual', 0, ?, 0, 'سعر البيع للمتر المربع من حاسبة الموقع — أضف سعر الشراء')`)
        .run(name, variantLabel, pricePerM2).lastInsertRowid);
}

/* Replace all shutter types (with their thicknesses and colors) by the Radma catalog */
function importShutterTypes(db) {
    db.prepare('DELETE FROM shutter_types').run();
    SHUTTER_TYPES.forEach((t, i) => {
        const typeId = Number(db.prepare('INSERT INTO shutter_types (name, description, sort_order) VALUES (?, ?, ?)')
            .run(t.name, t.description, i).lastInsertRowid);
        t.variants.forEach((v, j) => {
            const variantId = Number(db.prepare(`INSERT INTO shutter_variants
                (shutter_type_id, label, product_id, description, width_add_cm, height_add_cm, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(typeId, v.label, slatProduct(db, t.name, v.label, v.price), v.description, v.addW, v.addH, j).lastInsertRowid);
            v.colors.forEach((c, k) => {
                const color = typeof c === 'string' ? { name: c } : c;
                db.prepare(`INSERT INTO shutter_colors (shutter_type_id, variant_id, name, hex, price_per_m2, fixed_fee, sort_order)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`)
                    .run(typeId, variantId, color.name, HEX[color.name] || null, color.price ?? null, color.fee || 0, k);
            });
        });
    });
}

/* Installation fees; only the governorates and wilayat the site serves stay enabled */
function importInstallation(db) {
    db.prepare('UPDATE governorates SET active = 0').run();
    db.prepare('UPDATE regions SET active = 0').run();
    for (const [gov, wilayat] of Object.entries(INSTALLATION)) {
        db.prepare('INSERT OR IGNORE INTO governorates (name, sort_order) VALUES (?, 99)').run(gov);
        db.prepare('UPDATE governorates SET active = 1 WHERE name = ?').run(gov);
        for (const [name, fee] of Object.entries(wilayat)) {
            db.prepare('INSERT OR IGNORE INTO regions (name, governorate) VALUES (?, ?)').run(name, gov);
            db.prepare('UPDATE regions SET governorate = ?, installation_fee = ?, active = 1 WHERE name = ?').run(gov, fee, name);
        }
    }
}

function applyRadmaCatalog(db) {
    db.exec('BEGIN');
    try {
        importShutterTypes(db);
        importInstallation(db);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

/* ---------------------------------------------------------------
   Overhead (sectional) gates — the site's overhead calculator
   (price-calc/overhead): a price range per type × height × width,
   plus the motor and the installation fee of the wilayah.
   --------------------------------------------------------------- */

/* [type, height cm, width cm, price from, price to] (OMR, before VAT) */
const OVERHEAD_SIZES = [
    ['Type A', 250, 415, 355, 375], ['Type A', 250, 455, 370, 385], ['Type A', 250, 615, 470, 485],
    ['Type A', 300, 415, 465, 495], ['Type A', 300, 455, 485, 505], ['Type A', 300, 615, 625, 635],
    ['Type B', 250, 370, 270, 290], ['Type B', 250, 440, 295, 315], ['Type B', 250, 550, 320, 345], ['Type B', 250, 600, 350, 380]
];

const OVERHEAD_MOTORS = [
    ['المكينة الإيطالية 1200N', 145],
    ['المكينة الإيطالية 1000N', 135],
    ['المكينة الصينية 1500N', 110]
];

const OVERHEAD_INSTALLATION = {
    'الداخلية': { 'نزوى': 80, 'بهلاء': 90, 'الحمراء': 90, 'أدم': 100, 'إزكي': 90, 'منح': 90, 'سمائل': 100, 'بدبد': 100, 'الجبل الأخضر': 140 },
    'مسقط': { 'مسقط': 110, 'السيب': 100, 'بوشر': 100, 'مطرح': 100, 'العامرات': 110 },
    'جنوب الباطنة': { 'المصنعة': 120, 'بركاء': 110 },
    'شمال الشرقية': { 'إبراء': 110, 'المضيبي': 110, 'دماء والطائيين': 110, 'سناو': 110 },
    'الظاهرة': { 'عبري': 115 }
};

/* Replace the overhead sizes and motors, and set the overhead installation fee of each wilayah.
   Wilayat and governorates keep their enabled/disabled state (they are shared with the shutters). */
function applyOverheadCatalog(db) {
    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM overhead_sizes').run();
        db.prepare('DELETE FROM overhead_motors').run();
        const size = db.prepare(`INSERT INTO overhead_sizes (gate_type, height_cm, width_cm, price_from, price_to, sort_order)
                                 VALUES (?, ?, ?, ?, ?, ?)`);
        OVERHEAD_SIZES.forEach((row, i) => size.run(...row, i));
        const motor = db.prepare('INSERT INTO overhead_motors (name, price, sort_order) VALUES (?, ?, ?)');
        OVERHEAD_MOTORS.forEach((row, i) => motor.run(...row, i));
        db.prepare('UPDATE regions SET overhead_installation_fee = NULL').run();
        for (const [gov, wilayat] of Object.entries(OVERHEAD_INSTALLATION)) {
            db.prepare('INSERT OR IGNORE INTO governorates (name, sort_order) VALUES (?, 99)').run(gov);
            for (const [name, fee] of Object.entries(wilayat)) {
                db.prepare('INSERT OR IGNORE INTO regions (name, governorate) VALUES (?, ?)').run(name, gov);
                db.prepare('UPDATE regions SET overhead_installation_fee = ? WHERE name = ?').run(fee, name);
            }
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

module.exports = {
    applyRadmaCatalog, applyOverheadCatalog, SHUTTER_TYPES, INSTALLATION,
    OVERHEAD_SIZES, OVERHEAD_MOTORS, OVERHEAD_INSTALLATION
};
