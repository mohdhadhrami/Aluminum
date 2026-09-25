/* =============================================================
   Pricing rules — the single source of truth for customer prices
   ============================================================= */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/* Same formula as the in-house pricing calculator (public/index.html) */
function slatCostPerMeter(product, settings) {
    const w = Number(product.weight_per_meter) || 0;
    const metal = (settings.lme / 1000) * w * settings.exchange_rate;
    const mfg = (settings.manufacturing / 1000) * w * settings.exchange_rate;
    const paint = product.painted ? (settings.painting / 1000) * w : 0;
    return metal + mfg + paint;
}

/* Cost of one unit in OMR (before profit and VAT) */
function unitCost(product, settings) {
    if (product.pricing_mode === 'lme') return slatCostPerMeter(product, settings);
    return Number(product.purchase_price) || 0;
}

/* Selling price of one unit in OMR, before VAT */
function unitSellPrice(product, settings) {
    if (product.sell_price !== null && product.sell_price !== undefined && product.sell_price !== '') {
        return round2(Number(product.sell_price));
    }
    const profit = product.profit_percent ?? settings.profit_percent;
    return round2(unitCost(product, settings) * (1 + profit / 100));
}

/* Quantity of a quote line. Slats may be ordered by shutter dimensions:
   area (width × height) × pieces × sqm_to_linear = linear meters of slat. */
function lineQuantity(line, product, settings) {
    if (product.category === 'slat' && line.width && line.height) {
        const pieces = Number(line.pieces) || 1;
        return Number(line.width) * Number(line.height) * pieces * settings.sqm_to_linear;
    }
    return Number(line.quantity);
}

/**
 * Build a priced quote from requested lines.
 * @param lines    [{ product_id, quantity } | { product_id, width, height, pieces }]
 * @param products Map<id, product row>
 */
function priceQuote(lines, products, settings) {
    if (!Array.isArray(lines) || lines.length === 0) {
        throw Object.assign(new Error('يجب إضافة بند واحد على الأقل'), { status: 400 });
    }
    if (lines.length > 100) {
        throw Object.assign(new Error('عدد البنود كبير جداً'), { status: 400 });
    }

    const items = lines.map((line) => {
        const product = products.get(Number(line.product_id));
        if (!product) {
            throw Object.assign(new Error(`المنتج ${line.product_id} غير متوفر`), { status: 400 });
        }
        const quantity = lineQuantity(line, product, settings);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e6) {
            throw Object.assign(new Error(`كمية غير صالحة للمنتج ${product.name}`), { status: 400 });
        }
        const unitPrice = unitSellPrice(product, settings);
        const item = {
            product_id: product.id,
            category: product.category,
            name: product.name,
            type: product.type,
            unit: product.unit,
            quantity: Math.round(quantity * 1000) / 1000,
            unit_price: unitPrice,
            line_total: round2(unitPrice * quantity)
        };
        if (product.category === 'slat' && line.width && line.height) {
            item.dimensions = { width: Number(line.width), height: Number(line.height), pieces: Number(line.pieces) || 1 };
        }
        return item;
    });

    return withTotals(items, settings);
}

function withTotals(items, settings) {
    const subtotal = round2(items.reduce((s, i) => s + i.line_total, 0));
    const vat = round2(subtotal * settings.vat_percent / 100);
    return { items, subtotal, vat_percent: settings.vat_percent, vat, total: round2(subtotal + vat) };
}

/* =============================================================
   Complete roller-shutter doors
   ============================================================= */

const BASIS_LABELS = { fixed: 'ثابت', width: 'حسب العرض', height: 'حسب الارتفاع', area: 'حسب المساحة' };

function validateDoorSize(widthCm, heightCm, count) {
    const w = Number(widthCm), h = Number(heightCm), c = Number(count ?? 1);
    if (!(w >= 50 && w <= 1500)) throw Object.assign(new Error('العرض يجب أن يكون بين 50 و 1500 سم'), { status: 400 });
    if (!(h >= 50 && h <= 1000)) throw Object.assign(new Error('الارتفاع يجب أن يكون بين 50 و 1000 سم'), { status: 400 });
    if (!(Number.isInteger(c) && c >= 1 && c <= 50)) throw Object.assign(new Error('عدد الأبواب يجب أن يكون بين 1 و 50'), { status: 400 });
    return { w: w / 100, h: h / 100, count: c, area: (w / 100) * (h / 100) };
}

function packageFits(pkg, area) {
    return (pkg.min_area == null || area >= pkg.min_area) && (pkg.max_area == null || area <= pkg.max_area);
}

/**
 * Price one door package for a given size.
 * @param pkg        door_packages row, with .items (door_package_items rows) attached
 * @param products   Map<id, product row>
 * @param region     regions row or null
 * @param optionalIds  array of door_package_items ids to include, or 'all' / 'none'
 */
function priceDoor({ widthCm, heightCm, count = 1 }, pkg, products, region, settings, optionalIds = 'none') {
    const size = validateDoorSize(widthCm, heightCm, count);
    const basisValue = { fixed: 1, width: size.w, height: size.h, area: size.area };

    const item = (product, quantity, extra = {}) => {
        const unitPrice = unitSellPrice(product, settings);
        return {
            product_id: product.id, category: product.category, name: product.name, type: product.type,
            unit: product.unit, quantity: Math.round(quantity * 1000) / 1000, unit_price: unitPrice,
            line_total: round2(unitPrice * quantity), ...extra
        };
    };

    const slat = products.get(pkg.slat_product_id);
    if (!slat) throw Object.assign(new Error(`شرائح الباقة ${pkg.name} غير متوفرة`), { status: 400 });
    const items = [item(slat, size.area * settings.sqm_to_linear * size.count)];

    for (const pi of pkg.items) {
        const include = !pi.optional || optionalIds === 'all' || (Array.isArray(optionalIds) && optionalIds.includes(pi.id));
        const product = products.get(pi.product_id);
        if (!include || !product) continue;
        items.push(item(product, pi.factor * basisValue[pi.basis] * size.count, pi.optional ? { optional: true } : {}));
    }

    let feesPending = false;
    if (region) {
        const service = (name, qty, price) => ({
            product_id: null, category: 'service', name, type: region.name, unit: 'service',
            quantity: qty, unit_price: round2(price), line_total: round2(price * qty)
        });
        if (region.installation_fee == null || region.delivery_fee == null) feesPending = true;
        if (region.installation_fee > 0) items.push(service('تركيب', size.count, region.installation_fee));
        if (region.delivery_fee > 0) items.push(service('توصيل', 1, region.delivery_fee));
    }

    return {
        ...withTotals(items, settings),
        door: {
            width_cm: Number(widthCm), height_cm: Number(heightCm), count: size.count,
            area_m2: round2(size.area), package_id: pkg.id, package_name: pkg.name, door_type: pkg.door_type,
            region: region ? region.name : null
        },
        fees_pending: feesPending || !region
    };
}

module.exports = {
    round2, slatCostPerMeter, unitCost, unitSellPrice, priceQuote, withTotals,
    priceDoor, packageFits, validateDoorSize, BASIS_LABELS
};
