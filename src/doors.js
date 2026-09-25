/* =============================================================
   Roller-shutter door configurator
   Customer (and AI agent) picks: shutter type → thickness variant → color
   → one class per accessory group; installation comes from the wilayah.
   Shared by the public calculator, the AI agent and the admin preview.
   ============================================================= */
const { getSettings } = require('./db');
const { unitSellPrice, validateDoorSize, withTotals, round2 } = require('./pricing');

const err400 = (message) => Object.assign(new Error(message), { status: 400 });

function loadCatalog(db, { includeInactive = false } = {}) {
    const settings = getSettings(db);
    const products = new Map(db.prepare('SELECT * FROM products').all().map((p) => [p.id, p]));
    const onlyActive = includeInactive ? '' : 'WHERE active = 1';

    const variants = db.prepare('SELECT * FROM shutter_variants ORDER BY sort_order, id').all();
    const colors = db.prepare('SELECT * FROM shutter_colors ORDER BY sort_order, id').all();
    const types = db.prepare(`SELECT * FROM shutter_types ${onlyActive} ORDER BY sort_order, id`).all().map((t) => ({
        ...t,
        variants: variants.filter((v) => v.shutter_type_id === t.id && products.get(v.product_id)?.active),
        colors: colors.filter((c) => c.shutter_type_id === t.id)
    }));

    const options = db.prepare(`SELECT * FROM accessory_options ${onlyActive} ORDER BY sort_order, id`).all();
    const groups = db.prepare(`SELECT * FROM accessory_groups ${onlyActive} ORDER BY sort_order, id`).all().map((g) => ({
        ...g,
        options: options.filter((o) => o.group_id === g.id && (includeInactive || products.get(o.product_id)?.active))
    }));

    return { settings, products, types, groups };
}

/* ------------------------------ Pricing ------------------------------ */

const basisValue = (basis, size) => ({ fixed: 1, width: size.w, height: size.h, area: size.area })[basis];

function slatQuantity(product, size, settings) {
    // Slats sold per m² are counted by area; per meter they follow the 13 m / m² rule
    return product.unit === 'm2' ? size.area * size.count : size.area * settings.sqm_to_linear * size.count;
}

const lineItem = (product, quantity, settings, overrides = {}) => {
    const unitPrice = unitSellPrice(product, settings);
    return {
        product_id: product.id, category: product.category, name: product.name, type: product.type, unit: product.unit,
        quantity: Math.round(quantity * 1000) / 1000, unit_price: unitPrice, line_total: round2(unitPrice * quantity),
        ...overrides
    };
};

const serviceItem = (name, type, quantity, price) => ({
    product_id: null, category: 'service', name, type, unit: 'service',
    quantity, unit_price: round2(price), line_total: round2(price * quantity)
});

function getRegion(db, id) {
    if (!id) return null;
    return db.prepare(`SELECT r.* FROM regions r LEFT JOIN governorates g ON g.name = r.governorate
                       WHERE r.id = ? AND r.active = 1 AND IFNULL(g.active, 1) = 1`).get(Number(id)) || null;
}

function feesNote(region) {
    if (!region) return 'الولاية غير محددة — رسوم التركيب تُحدد لاحقاً';
    if (region.installation_fee == null) return 'رسوم التركيب لهذه الولاية تُحدد بعد المعاينة';
    return 'شامل التركيب';
}

/* Check a customer's choice against the catalog and return the resolved rows */
function resolveChoice(catalog, { shutterTypeId, variantId, colorId, optionIds = [] }) {
    const type = catalog.types.find((t) => t.id === Number(shutterTypeId));
    if (!type) throw err400('اختر نوع البوابة');
    if (!type.variants.length) throw err400(`لا توجد شرائح مفعّلة لبوابة ${type.name}`);

    const variant = type.variants.length === 1 && !variantId
        ? type.variants[0]
        : type.variants.find((v) => v.id === Number(variantId));
    if (!variant) throw err400('اختر السماكة');

    let color = null;
    if (colorId) {
        color = type.colors.find((c) => c.id === Number(colorId));
        if (!color) throw err400('اللون غير متوفر لهذا النوع');
    }

    const ids = (optionIds || []).map(Number);
    const accessories = [];
    for (const group of catalog.groups) {
        const option = group.options.find((o) => ids.includes(o.id));
        if (!option && !group.allow_none) throw err400(`اختر نوع ${group.name}`);
        if (option) accessories.push({ group, option });
    }
    return { type, variant, color, accessories };
}

function priceChoice({ widthCm, heightCm, count = 1 }, choice, catalog, region) {
    const size = validateDoorSize(widthCm, heightCm, count);
    const { settings, products } = catalog;
    const { type, variant, color, accessories } = choice;

    const slat = products.get(variant.product_id);
    const items = [lineItem(slat, slatQuantity(slat, size, settings), settings, {
        name: `شرائح ${type.name}`, type: [variant.label, color && color.name].filter(Boolean).join(' — ')
    })];
    if (color && color.surcharge_per_m2 > 0) {
        items.push(serviceItem('إضافة لون', color.name, round2(size.area * size.count), color.surcharge_per_m2));
        items[items.length - 1].unit = 'm2';
    }
    for (const { group, option } of accessories) {
        const product = products.get(option.product_id);
        items.push(lineItem(product, group.factor * basisValue(group.basis, size) * size.count, settings, {
            name: group.name, type: option.label
        }));
    }
    if (region && region.installation_fee > 0) items.push(serviceItem('التركيب', region.name, size.count, region.installation_fee));
    if (region && region.delivery_fee > 0) items.push(serviceItem('التوصيل', region.name, 1, region.delivery_fee));

    const spec = [
        ['المقاس', `العرض ${Number(widthCm)} سم — الارتفاع ${Number(heightCm)} سم`],
        ['عدد الأبواب', String(size.count)],
        ['نوع البوابة', `${type.name} — ${variant.label}`]
    ];
    if (color) spec.push(['اللون', color.name]);
    for (const { group, option } of accessories) spec.push([group.name, option.label]);
    for (const g of catalog.groups) {
        if (g.allow_none && !accessories.some((a) => a.group.id === g.id)) spec.push([g.name, g.none_label || 'بدون']);
    }

    return {
        ...withTotals(items, settings),
        door: {
            width_cm: Number(widthCm), height_cm: Number(heightCm), count: size.count, area_m2: round2(size.area),
            shutter_type: type.name, variant: variant.label, color: color ? color.name : null,
            accessories: accessories.map(({ group, option }) => ({ group: group.name, option: option.label })),
            region: region ? region.name : null, governorate: region ? region.governorate : null
        },
        spec,
        delivery_installation: feesNote(region)
    };
}

function finalPrice(db, { widthCm, heightCm, count = 1, shutterTypeId, variantId, colorId, optionIds, regionId }) {
    const catalog = loadCatalog(db);
    const choice = resolveChoice(catalog, { shutterTypeId, variantId, colorId, optionIds });
    return priceChoice({ widthCm, heightCm, count }, choice, catalog, getRegion(db, regionId));
}

/* Price of each individual choice for this size, so the cheapest/dearest can be picked */
function optionCosts(catalog, type, size) {
    const { settings, products } = catalog;
    const variants = type.variants.map((v) => {
        const p = products.get(v.product_id);
        return { variant: v, cost: unitSellPrice(p, settings) * slatQuantity(p, size, settings) };
    });
    const colors = type.colors.map((c) => ({ color: c, cost: c.surcharge_per_m2 * size.area * size.count }));
    const groups = catalog.groups.map((g) => ({
        group: g,
        options: g.options.map((o) => ({
            option: o,
            cost: unitSellPrice(products.get(o.product_id), settings) * g.factor * basisValue(g.basis, size) * size.count
        }))
    }));
    return { variants, colors, groups };
}

const pick = (list, fn) => list.reduce((best, x) => (best === null || fn(x.cost, best.cost) ? x : best), null);

/* From: cheapest thickness/color/classes (or "none" where allowed). To: dearest of everything. */
function priceRange(db, { widthCm, heightCm, count = 1, shutterTypeId = null, regionId = null }) {
    const catalog = loadCatalog(db);
    const size = validateDoorSize(widthCm, heightCm, count);
    const region = getRegion(db, regionId);
    const types = catalog.types.filter((t) => t.variants.length && (!shutterTypeId || t.id === Number(shutterTypeId)));
    if (!types.length) return { available: false, message: 'لا يوجد نوع بوابة متاح — يحتاج مراجعة من فريق المبيعات' };

    const rows = types.map((type) => {
        const costs = optionCosts(catalog, type, size);
        const build = (cheapest) => {
            const cmp = cheapest ? (a, b) => a < b : (a, b) => a > b;
            const optionIds = costs.groups.map(({ group, options }) =>
                (cheapest && group.allow_none) || !options.length ? null : pick(options, cmp).option.id).filter(Boolean);
            const color = pick(costs.colors, cmp);
            const choice = resolveChoice(catalog, {
                shutterTypeId: type.id, variantId: pick(costs.variants, cmp).variant.id,
                colorId: color ? color.color.id : null, optionIds
            });
            return priceChoice({ widthCm, heightCm, count }, choice, catalog, region).total;
        };
        return { shutter_type_id: type.id, shutter_type: type.name, from: build(true), to: build(false) };
    });

    return {
        available: true, currency: 'OMR', includes_vat: true, vat_percent: catalog.settings.vat_percent,
        area_m2: round2(size.area), region: region ? region.name : null, delivery_installation: feesNote(region),
        from: Math.min(...rows.map((r) => r.from)), to: Math.max(...rows.map((r) => r.to)), by_type: rows
    };
}

/* What each choice adds for this size (prices include VAT) — used to explain differences */
function compareOptions(db, { widthCm, heightCm, count = 1, shutterTypeId }) {
    const catalog = loadCatalog(db);
    const size = validateDoorSize(widthCm, heightCm, count);
    const type = catalog.types.find((t) => t.id === Number(shutterTypeId));
    if (!type) throw err400('نوع البوابة غير موجود');
    const vat = 1 + catalog.settings.vat_percent / 100;
    const costs = optionCosts(catalog, type, size);
    return {
        shutter_type: { id: type.id, name: type.name, description: type.description },
        thickness_options: costs.variants.map(({ variant, cost }) => ({ variant_id: variant.id, label: variant.label, slats_price_with_vat: round2(cost * vat) })),
        colors: costs.colors.map(({ color, cost }) => ({ color_id: color.id, name: color.name, adds_with_vat: round2(cost * vat) })),
        accessories: costs.groups.map(({ group, options }) => ({
            group: group.name,
            description: group.description,
            can_skip: Boolean(group.allow_none),
            skip_label: group.allow_none ? group.none_label || 'بدون' : null,
            classes: options.map(({ option, cost }) => ({
                option_id: option.id, label: option.label, details: option.details, price_with_vat: round2(cost * vat)
            }))
        }))
    };
}

/* ---------------------------- Locations ----------------------------- */

/* Loose Arabic matching: ignore "ال", hamza forms, taa marbuta, alef maqsura, spaces */
function normalizeArabic(s) {
    return String(s || '')
        .replace(/[ً-ْـ]/g, '')
        .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
        .replace(/(^|\s)ال/g, '$1')
        .replace(/\s+/g, '')
        .toLowerCase();
}

function activeRegions(db) {
    return db.prepare(`SELECT r.* FROM regions r JOIN governorates g ON g.name = r.governorate
                       WHERE r.active = 1 AND g.active = 1 ORDER BY g.sort_order, r.name`).all();
}

function findRegions(db, query) {
    const q = normalizeArabic(query);
    if (!q) return [];
    const rows = activeRegions(db);
    const exact = rows.filter((r) => normalizeArabic(r.name) === q);
    if (exact.length) return exact;
    return rows.filter((r) => normalizeArabic(r.name).includes(q) || q.includes(normalizeArabic(r.name))
        || normalizeArabic(r.governorate) === q).slice(0, 12);
}

/* Enabled governorates with their wilayat, for the customer form */
function locations(db) {
    const regions = activeRegions(db);
    return db.prepare('SELECT * FROM governorates WHERE active = 1 ORDER BY sort_order, name').all()
        .map((g) => ({
            id: g.id,
            name: g.name,
            wilayat: regions.filter((r) => r.governorate === g.name)
                .map((r) => ({ id: r.id, name: r.name, installation_fee: r.installation_fee, delivery_fee: r.delivery_fee }))
        }))
        .filter((g) => g.wilayat.length);
}

/* ------------------------- Public catalog view ------------------------ */

function publicCatalog(db) {
    const catalog = loadCatalog(db);
    const price = (id) => unitSellPrice(catalog.products.get(id), catalog.settings);
    return {
        shutter_types: catalog.types.filter((t) => t.variants.length).map((t) => ({
            id: t.id, name: t.name, description: t.description, image_url: t.image_url,
            variants: t.variants.map((v) => ({ id: v.id, label: v.label })),
            colors: t.colors.map((c) => ({ id: c.id, name: c.name, hex: c.hex, surcharge_per_m2: c.surcharge_per_m2 }))
        })),
        accessory_groups: catalog.groups.filter((g) => g.options.length).map((g) => ({
            id: g.id, name: g.name, description: g.description, allow_none: Boolean(g.allow_none), none_label: g.none_label,
            options: g.options.map((o) => ({ id: o.id, label: o.label, details: o.details, image_url: o.image_url, unit_price: price(o.product_id) }))
        }))
    };
}

module.exports = {
    loadCatalog, resolveChoice, priceChoice, finalPrice, priceRange, compareOptions,
    findRegions, getRegion, locations, publicCatalog, normalizeArabic
};
