/* =============================================================
   Door catalog helpers — shared by the AI agent and the admin API
   ============================================================= */
const { getSettings } = require('./db');
const { priceDoor, packageFits, validateDoorSize, round2, unitSellPrice, BASIS_LABELS } = require('./pricing');

function loadCatalog(db, { includeInactive = false } = {}) {
    const settings = getSettings(db);
    const products = new Map(db.prepare('SELECT * FROM products WHERE active = 1').all().map((p) => [p.id, p]));
    const packages = db.prepare(`SELECT * FROM door_packages ${includeInactive ? '' : 'WHERE active = 1'}
                                 ORDER BY door_type, sort_order, id`).all();
    const items = db.prepare('SELECT * FROM door_package_items ORDER BY id').all();
    for (const pkg of packages) pkg.items = items.filter((i) => i.package_id === pkg.id);
    return { settings, products, packages };
}

/* Loose Arabic matching: ignore "ال", hamza forms, taa marbuta, alef maqsura, spaces */
function normalizeArabic(s) {
    return String(s || '')
        .replace(/[ً-ْـ]/g, '')
        .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
        .replace(/(^|\s)ال/g, '$1')
        .replace(/\s+/g, '')
        .toLowerCase();
}

function findRegions(db, query) {
    const q = normalizeArabic(query);
    if (!q) return [];
    const rows = db.prepare('SELECT * FROM regions WHERE active = 1').all();
    const exact = rows.filter((r) => normalizeArabic(r.name) === q);
    if (exact.length) return exact;
    return rows.filter((r) => normalizeArabic(r.name).includes(q) || q.includes(normalizeArabic(r.name))
        || normalizeArabic(r.governorate) === q).slice(0, 8);
}

function getRegion(db, id) {
    return id ? db.prepare('SELECT * FROM regions WHERE id = ? AND active = 1').get(Number(id)) : null;
}

function packagesOfType(catalog, doorType) {
    const t = normalizeArabic(doorType);
    return catalog.packages.filter((p) => !t || normalizeArabic(p.door_type) === t);
}

/* Cheapest (required items only) and dearest (all extras) price per package */
function priceRange(db, { widthCm, heightCm, count = 1, doorType, regionId }) {
    const catalog = loadCatalog(db);
    const size = validateDoorSize(widthCm, heightCm, count);
    const region = getRegion(db, regionId);
    const fitting = packagesOfType(catalog, doorType).filter((p) => packageFits(p, size.area));
    if (!fitting.length) {
        return { available: false, message: 'لا توجد باقة مناسبة لهذا النوع والمقاس — يحتاج مراجعة من فريق المبيعات' };
    }
    const rows = fitting.map((pkg) => {
        const min = priceDoor({ widthCm, heightCm, count }, pkg, catalog.products, region, catalog.settings, 'none');
        const max = priceDoor({ widthCm, heightCm, count }, pkg, catalog.products, region, catalog.settings, 'all');
        return { package_id: pkg.id, package_name: pkg.name, from: min.total, to: max.total };
    });
    return {
        available: true,
        currency: 'OMR',
        includes_vat: true,
        vat_percent: catalog.settings.vat_percent,
        area_m2: round2(size.area),
        region: region ? region.name : null,
        delivery_installation: feesNote(region),
        from: Math.min(...rows.map((r) => r.from)),
        to: Math.max(...rows.map((r) => r.to)),
        packages: rows
    };
}

function feesNote(region) {
    if (!region) return 'الولاية غير محددة — رسوم التوصيل والتركيب تُحدد لاحقاً';
    if (region.delivery_fee == null || region.installation_fee == null) {
        return 'رسوم التوصيل والتركيب لهذه الولاية تُحدد بعد المعاينة';
    }
    return 'شاملة التوصيل والتركيب';
}

/* What each package contains and what the optional extras cost */
function comparePackages(db, { widthCm, heightCm, count = 1, doorType, regionId }) {
    const catalog = loadCatalog(db);
    const size = validateDoorSize(widthCm, heightCm, count);
    const region = getRegion(db, regionId);
    const fitting = packagesOfType(catalog, doorType).filter((p) => packageFits(p, size.area));
    return fitting.map((pkg) => {
        const base = priceDoor({ widthCm, heightCm, count }, pkg, catalog.products, region, catalog.settings, 'none');
        const slat = catalog.products.get(pkg.slat_product_id);
        return {
            package_id: pkg.id,
            package_name: pkg.name,
            description: pkg.description,
            slats: `${slat.name} — ${slat.type || ''}`.trim(),
            included: pkg.items.filter((i) => !i.optional).map((i) => describeItem(catalog, i)).filter(Boolean),
            base_price_with_vat: base.total,
            optional_extras: pkg.items.filter((i) => i.optional).map((i) => {
                const p = catalog.products.get(i.product_id);
                if (!p) return null;
                const extra = priceDoor({ widthCm, heightCm, count }, pkg, catalog.products, region, catalog.settings, [i.id]);
                return { optional_item_id: i.id, name: `${p.name} — ${p.type || ''}`.trim(), adds_with_vat: round2(extra.total - base.total) };
            }).filter(Boolean)
        };
    });
}

function describeItem(catalog, i) {
    const p = catalog.products.get(i.product_id);
    if (!p) return null;
    return `${p.name}${p.type ? ' — ' + p.type : ''}`;
}

function finalPrice(db, { widthCm, heightCm, count = 1, packageId, optionalItemIds = [], regionId }) {
    const catalog = loadCatalog(db);
    const pkg = catalog.packages.find((p) => p.id === Number(packageId));
    if (!pkg) throw Object.assign(new Error('الباقة غير موجودة'), { status: 400 });
    const size = validateDoorSize(widthCm, heightCm, count);
    if (!packageFits(pkg, size.area)) {
        throw Object.assign(new Error(`الباقة ${pkg.name} لا تناسب مساحة ${round2(size.area)} م²`), { status: 400 });
    }
    const region = getRegion(db, regionId);
    const valid = pkg.items.filter((i) => i.optional).map((i) => i.id);
    const chosen = (optionalItemIds || []).map(Number).filter((id) => valid.includes(id));
    const priced = priceDoor({ widthCm, heightCm, count }, pkg, catalog.products, region, catalog.settings, chosen);
    return { ...priced, delivery_installation: feesNote(region) };
}

/* Admin view: package with item descriptions and per-unit prices */
function describePackages(db) {
    const catalog = loadCatalog(db, { includeInactive: true });
    return catalog.packages.map((pkg) => ({
        ...pkg,
        items: pkg.items.map((i) => {
            const p = catalog.products.get(i.product_id);
            return {
                ...i,
                product_name: p ? `${p.name}${p.type ? ' — ' + p.type : ''}` : '(منتج غير مفعّل)',
                unit_price: p ? unitSellPrice(p, catalog.settings) : null,
                basis_label: BASIS_LABELS[i.basis]
            };
        })
    }));
}

module.exports = { loadCatalog, findRegions, getRegion, priceRange, comparePackages, finalPrice, describePackages, normalizeArabic };
