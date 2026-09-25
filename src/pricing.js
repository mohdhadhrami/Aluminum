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

    const subtotal = round2(items.reduce((s, i) => s + i.line_total, 0));
    const vat = round2(subtotal * settings.vat_percent / 100);
    return { items, subtotal, vat_percent: settings.vat_percent, vat, total: round2(subtotal + vat) };
}

module.exports = { round2, slatCostPerMeter, unitCost, unitSellPrice, priceQuote };
