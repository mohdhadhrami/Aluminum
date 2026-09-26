/* =============================================================
   Overhead (sectional) gate calculator — same method as the company
   site's overhead calculator: the customer picks a type and the
   nearest larger standard size, a motor and the wilayah; the price is
   a range (it depends on the color):
       from = size price from + motor + installation
       to   = size price to   + motor + installation
   Site prices exclude VAT, so VAT is added on top (as for the shutters).
   ============================================================= */
const { getSettings } = require('./db');
const { round2 } = require('./pricing');
const { getRegion, locations } = require('./doors');

const err400 = (message) => Object.assign(new Error(message), { status: 400 });

function loadOverhead(db, { includeInactive = false } = {}) {
    const onlyActive = includeInactive ? '' : 'WHERE active = 1';
    return {
        sizes: db.prepare(`SELECT * FROM overhead_sizes ${onlyActive} ORDER BY sort_order, id`).all(),
        motors: db.prepare(`SELECT * FROM overhead_motors ${onlyActive} ORDER BY sort_order, id`).all()
    };
}

/* Types → heights → widths, in catalog order (what the customer page offers) */
function gateTypes(sizes) {
    const types = [];
    for (const s of sizes) {
        let type = types.find((t) => t.name === s.gate_type);
        if (!type) types.push(type = { name: s.gate_type, heights: [] });
        let height = type.heights.find((h) => h.height_cm === s.height_cm);
        if (!height) type.heights.push(height = { height_cm: s.height_cm, widths: [] });
        height.widths.push(s.width_cm);
    }
    for (const t of types) {
        t.heights.sort((a, b) => a.height_cm - b.height_cm);
        for (const h of t.heights) h.widths.sort((a, b) => a - b);
    }
    return types;
}

/* Wilayat of the enabled governorates that have an overhead installation fee */
function overheadLocations(db) {
    const fees = new Map(db.prepare('SELECT id, overhead_installation_fee AS fee FROM regions').all().map((r) => [r.id, r.fee]));
    return locations(db)
        .map((g) => ({ ...g, wilayat: g.wilayat.filter((w) => fees.get(w.id) != null).map(({ id, name }) => ({ id, name })) }))
        .filter((g) => g.wilayat.length);
}

function publicOverhead(db) {
    const { sizes, motors } = loadOverhead(db);
    return {
        gate_types: gateTypes(sizes),
        motors: motors.map((m) => ({ id: m.id, name: m.name })),
        locations: overheadLocations(db)
    };
}

const service = (name, type, from, to = from) => ({
    product_id: null, category: 'service', name, type, unit: 'service', quantity: 1,
    unit_price: round2(from), line_total: round2(from),
    ...(to !== from ? { unit_price_to: round2(to), line_total_to: round2(to) } : {})
});

function overheadPrice(db, { gateType, heightCm, widthCm, motorId, regionId }) {
    const { sizes, motors } = loadOverhead(db);
    if (!gateType || !sizes.some((s) => s.gate_type === gateType)) throw err400('اختر نوع البوابة');
    const size = sizes.find((s) => s.gate_type === gateType && s.height_cm === Number(heightCm) && s.width_cm === Number(widthCm));
    if (!size) throw err400('اختر المقاس (العرض والارتفاع)');
    const motor = motors.find((m) => m.id === Number(motorId));
    if (!motor) throw err400('اختر المحرك');
    const region = getRegion(db, regionId);
    const install = region && db.prepare('SELECT overhead_installation_fee AS fee FROM regions WHERE id = ?').get(region.id).fee;
    if (!region || install == null) throw err400('اختر المحافظة والولاية');

    const vatPercent = Number(getSettings(db).vat_percent) || 0;
    const items = [
        service(`بوابة أوفرهيد ${size.gate_type}`, `العرض ${size.width_cm} سم × الارتفاع ${size.height_cm} سم`, size.price_from, size.price_to),
        service('المحرك', motor.name, motor.price),
        service('التركيب', region.name, install)
    ];
    const subtotal = round2(items.reduce((sum, i) => sum + i.line_total, 0));
    const subtotalTo = round2(items.reduce((sum, i) => sum + (i.line_total_to ?? i.line_total), 0));
    const vat = round2(subtotal * vatPercent / 100);
    const vatTo = round2(subtotalTo * vatPercent / 100);

    return {
        items,
        subtotal, vat_percent: vatPercent, vat, total: round2(subtotal + vat),
        // The upper end of the range (the price depends on the color)
        range: { subtotal_to: subtotalTo, vat_to: vatTo, total_to: round2(subtotalTo + vatTo) },
        spec: [
            ['نوع البوابة', `أوفرهيد ${size.gate_type}`],
            ['المقاس', `العرض ${size.width_cm} سم — الارتفاع ${size.height_cm} سم`],
            ['المحرك', motor.name]
        ],
        delivery_installation: 'شامل التركيب والملحقات الأساسية — اختلاف السعر ضمن النطاق حسب اللون',
        gate: { gate_type: size.gate_type, width_cm: size.width_cm, height_cm: size.height_cm, motor: motor.name, region: region.name },
        region
    };
}

module.exports = { loadOverhead, publicOverhead, overheadPrice, gateTypes };
