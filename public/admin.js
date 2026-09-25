/* =============================================================
   Admin panel — connects the pricing app to the server database.
   If the page is opened without the server (e.g. as a local file)
   the original calculators keep working offline with default values.
   ============================================================= */

const CATEGORY_NAMES = { slat: 'شرائح', accessory: 'إكسسوارات', machine: 'مكائن' };
const UNIT_NAMES = { meter: 'متر', piece: 'قطعة', m2: 'م²', set: 'طقم', kg: 'كجم' };
const STATUS_NAMES = { new: 'جديد', contacted: 'تم التواصل', accepted: 'مقبول', rejected: 'مرفوض', done: 'مكتمل' };
const FIELD_NAMES = { purchase_price: 'سعر الشراء', sell_price: 'سعر البيع الثابت', profit_percent: 'نسبة الربح' };
// Approximate OMR per unit of currency — a starting suggestion, always editable
const SUGGESTED_RATES = { OMR: 1, AED: 0.1048, SAR: 0.1026, CNY: 0.053, EUR: 0.42 };

let online = false;
let products = [];
let hookEvents = [];
let hooks = [];

const $id = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

function setStatus(id, text, kind = '') {
    const el = $id(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'status-text ' + kind;
}

async function api(method, url, body) {
    let token = '';
    try { token = localStorage.getItem('adminToken') || ''; } catch { /* storage blocked */ }
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401 || res.status === 503) {
        $id('loginBar').hidden = false;
        const data = await res.json().catch(() => ({}));
        setStatus('loginStatus', data.error || '');
        throw new Error(data.error || 'غير مصرح');
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || 'حدث خطأ');
    return data;
}

async function login() {
    try { localStorage.setItem('adminToken', $id('adminToken').value.trim()); } catch { /* ignore */ }
    try {
        await initAdmin();
        $id('loginBar').hidden = true;
        setStatus('settingsStatus', 'متصل بقاعدة البيانات ✓', 'ok');
    } catch (err) {
        setStatus('loginStatus', err.message);
    }
}

/* ---------------------------- Settings ---------------------------- */

function applySettings(s) {
    $id('lme').value = s.lme;
    $id('manufacturing').value = s.manufacturing;
    $id('painting').value = s.painting;
    $id('exchangeRate').value = s.exchange_rate;
    $id('profitPercent').value = s.profit_percent;
    $id('vatPercent').value = s.vat_percent;
    (s.tax_mode === 'industrial' ? $id('taxIndustrial') : $id('taxAccounting')).checked = true;
    $id('companyName').value = s.company_name || '';
    $id('companyWhatsapp').value = s.company_whatsapp || '';
    $id('publicBaseUrl').value = s.public_base_url || '';
    $id('sqmToLinear').value = s.sqm_to_linear;
    recalculateAll();
}

async function saveSettingsToServer() {
    if (!online) return setStatus('settingsStatus', 'الخادم غير متصل — لا يمكن الحفظ', 'err');
    const inputs = getInputs();
    try {
        const s = await api('PUT', '/api/admin/settings', {
            lme: inputs.lme,
            manufacturing: inputs.manufacturing,
            painting: inputs.painting,
            exchange_rate: inputs.exchangeRate,
            profit_percent: inputs.profitPercent,
            vat_percent: inputs.vatPercent,
            tax_mode: inputs.taxMode,
            company_name: $id('companyName').value,
            company_whatsapp: $id('companyWhatsapp').value,
            public_base_url: $id('publicBaseUrl').value,
            sqm_to_linear: parseFloat($id('sqmToLinear').value) || 13
        });
        applySettings(s);
        await loadProducts(); // LME-based prices depend on these settings
        setStatus('settingsStatus', 'تم الحفظ ✓', 'ok');
    } catch (err) {
        setStatus('settingsStatus', err.message, 'err');
    }
}

/* ---------------------------- Products ---------------------------- */

async function loadProducts() {
    products = await api('GET', '/api/admin/products');
    renderProducts();
    syncSlatThicknesses();
    $id('buyProduct').innerHTML = products
        .filter((p) => p.pricing_mode === 'manual')
        .map((p) => `<option value="${p.id}">${esc(CATEGORY_NAMES[p.category])} — ${esc(p.name)}${p.type ? ' — ' + esc(p.type) : ''}</option>`)
        .join('');
}

/* Feed slat weights from the database into the original calculators */
function syncSlatThicknesses() {
    const slats = products.filter((p) => p.pricing_mode === 'lme' && p.active && p.thickness && p.weight_per_meter);
    if (!slats.length) return;
    const seen = new Map();
    for (const p of slats) seen.set(String(p.thickness), p.weight_per_meter);
    for (const [t, w] of seen) WEIGHT_PER_METER[t] = w;
    for (const id of ['itemThickness', 'wCalcThickness']) {
        const sel = $id(id);
        const current = sel.value;
        sel.innerHTML = [...seen.keys()].sort((a, b) => a - b)
            .map((t) => `<option value="${t}">${t} ملم</option>`).join('');
        if (seen.has(current)) sel.value = current;
    }
    recalculateAll();
}

function renderProducts() {
    const filter = $id('productFilter').value;
    const rows = products.filter((p) => !filter || p.category === filter);
    const defaultProfit = parseFloat($id('profitPercent').value) || 0;
    $id('productsBody').innerHTML = rows.map((p) => `
        <tr style="${p.active ? '' : 'opacity:0.5'}">
            <td>${esc(CATEGORY_NAMES[p.category])}</td>
            <td class="text-start"><strong>${esc(p.name)}</strong>${p.type ? '<br><small>' + esc(p.type) + '</small>' : ''}
                ${p.notes ? '<br><small style="color:var(--text-light)">' + esc(p.notes) + '</small>' : ''}</td>
            <td>${esc(UNIT_NAMES[p.unit] || p.unit)}</td>
            <td>${p.pricing_mode === 'lme' ? '<span class="badge lme">LME</span>' : '<span class="badge">يدوي</span>'}</td>
            <td>${p.unit_cost.toFixed(3)}</td>
            <td>${p.profit_percent ?? defaultProfit + ' (افتراضي)'}</td>
            <td><strong>${p.unit_price.toFixed(2)}</strong>${p.sell_price !== null ? ' <small>(ثابت)</small>' : ''}</td>
            <td>${p.is_public ? '<span class="badge on">نعم</span>' : '<span class="badge">لا</span>'}</td>
            <td style="white-space:nowrap">
                <button class="btn btn-outline btn-sm" onclick="editProduct(${p.id})">تعديل</button>
                <button class="btn btn-outline btn-sm" onclick="showHistory(${p.id})">السجل</button>
                <button class="btn btn-danger btn-sm" onclick="deleteProduct(${p.id})">حذف</button>
            </td>
        </tr>`).join('');
    $id('productsEmpty').style.display = rows.length ? 'none' : 'block';
}

function onProductCategoryChange() {
    const isSlat = $id('pCategory').value === 'slat';
    if (!isSlat) $id('pPricingMode').value = 'manual';
    $id('pPricingModeGroup').hidden = !isSlat;
    const lme = $id('pPricingMode').value === 'lme';
    document.querySelectorAll('.lme-only').forEach((el) => { el.hidden = !lme; });
    $id('pPurchaseGroup').hidden = lme;
}

function resetProductForm() {
    $id('pId').value = '';
    $id('productFormTitle').textContent = 'إضافة منتج';
    for (const id of ['pName', 'pType', 'pThickness', 'pWeight', 'pProfit', 'pSell', 'pNotes']) $id(id).value = '';
    $id('pPurchase').value = 0;
    $id('pCategory').value = 'accessory';
    $id('pUnit').value = 'piece';
    $id('pPricingMode').value = 'manual';
    $id('pPainted').checked = false;
    $id('pPublic').checked = true;
    $id('pActive').checked = true;
    setStatus('productStatus', '');
    onProductCategoryChange();
}

function editProduct(id) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    $id('pId').value = p.id;
    $id('productFormTitle').textContent = 'تعديل: ' + p.name + (p.type ? ' — ' + p.type : '');
    $id('pCategory').value = p.category;
    $id('pName').value = p.name;
    $id('pType').value = p.type || '';
    $id('pUnit').value = p.unit;
    $id('pPricingMode').value = p.pricing_mode;
    $id('pPurchase').value = p.purchase_price;
    $id('pThickness').value = p.thickness ?? '';
    $id('pWeight').value = p.weight_per_meter ?? '';
    $id('pProfit').value = p.profit_percent ?? '';
    $id('pSell').value = p.sell_price ?? '';
    $id('pNotes').value = p.notes || '';
    $id('pPainted').checked = !!p.painted;
    $id('pPublic').checked = !!p.is_public;
    $id('pActive').checked = !!p.active;
    onProductCategoryChange();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function saveProduct() {
    if (!online) return setStatus('productStatus', 'الخادم غير متصل', 'err');
    const id = $id('pId').value;
    const body = {
        category: $id('pCategory').value,
        name: $id('pName').value,
        type: $id('pType').value,
        unit: $id('pUnit').value,
        pricing_mode: $id('pPricingMode').value,
        purchase_price: Number($id('pPurchase').value) || 0,
        thickness: numOrNull($id('pThickness').value),
        weight_per_meter: numOrNull($id('pWeight').value),
        profit_percent: numOrNull($id('pProfit').value),
        sell_price: numOrNull($id('pSell').value),
        notes: $id('pNotes').value,
        painted: $id('pPainted').checked,
        is_public: $id('pPublic').checked,
        active: $id('pActive').checked
    };
    try {
        await api(id ? 'PUT' : 'POST', id ? `/api/admin/products/${id}` : '/api/admin/products', body);
        await loadProducts();
        resetProductForm();
        setStatus('productStatus', 'تم الحفظ ✓', 'ok');
    } catch (err) {
        setStatus('productStatus', err.message, 'err');
    }
}

async function deleteProduct(id) {
    const p = products.find((x) => x.id === id);
    if (!p || !confirm(`حذف «${p.name}${p.type ? ' — ' + p.type : ''}» وكل سجل مشترياته؟\nلإخفائه فقط ألغِ خيار «مفعّل».`)) return;
    try {
        await api('DELETE', `/api/admin/products/${id}`);
        await loadProducts();
        await loadPurchases();
    } catch (err) {
        alert(err.message);
    }
}

async function showHistory(id) {
    const p = products.find((x) => x.id === id);
    const h = await api('GET', `/api/admin/products/${id}/history`);
    $id('historyTitle').textContent = 'سجل الأسعار: ' + p.name + (p.type ? ' — ' + p.type : '');
    $id('historyBody').innerHTML = h.changes.map((c) => `
        <tr>
            <td>${esc(c.changed_at)}</td>
            <td>${esc(FIELD_NAMES[c.field] || c.field)}</td>
            <td>${c.old_value ?? '—'}</td>
            <td>${c.new_value ?? '—'}</td>
            <td>${c.source === 'purchase' ? 'فاتورة شراء' : 'تعديل يدوي'}</td>
        </tr>`).join('') || '<tr><td colspan="5">لا توجد تغييرات مسجلة.</td></tr>';
    $id('historyCard').hidden = false;
    $id('historyCard').scrollIntoView({ behavior: 'smooth' });
}

/* ---------------------------- Purchases --------------------------- */

function onCurrencyChange() {
    const cur = $id('buyCurrency').value;
    $id('buyRate').value = cur === 'USD' ? (parseFloat($id('exchangeRate').value) || 0.385) : SUGGESTED_RATES[cur];
    previewLandedCost();
}

function previewLandedCost() {
    const price = parseFloat($id('buyPrice').value);
    if (!(price >= 0)) return setStatus('buyPreview', '');
    const cost = price * (parseFloat($id('buyRate').value) || 0) + (parseFloat($id('buyExtra').value) || 0);
    setStatus('buyPreview', `التكلفة النهائية للوحدة: ${cost.toFixed(3)} ر.ع`);
}

async function loadPurchases() {
    const rows = await api('GET', '/api/admin/purchases');
    $id('purchasesBody').innerHTML = rows.map((r) => `
        <tr>
            <td>${esc(r.purchased_at)}</td>
            <td class="text-start">${esc(r.product_name)}${r.product_type ? ' — ' + esc(r.product_type) : ''}</td>
            <td>${esc(r.supplier || '—')}</td>
            <td>${r.quantity} ${esc(UNIT_NAMES[r.unit] || r.unit)}</td>
            <td>${r.unit_price} ${esc(r.currency)}</td>
            <td><strong>${r.unit_cost_omr.toFixed(3)}</strong></td>
            <td>${esc(r.notes || '')}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deletePurchase(${r.id})">حذف</button></td>
        </tr>`).join('');
    $id('purchasesEmpty').style.display = rows.length ? 'none' : 'block';
}

async function savePurchase() {
    if (!online) return setStatus('buyStatus', 'الخادم غير متصل', 'err');
    if (!$id('buyProduct').value) return setStatus('buyStatus', 'أضف منتجاً أولاً من تبويب المنتجات', 'err');
    if ($id('buyPrice').value === '') return setStatus('buyStatus', 'أدخل سعر الوحدة', 'err');
    try {
        await api('POST', '/api/admin/purchases', {
            product_id: Number($id('buyProduct').value),
            supplier: $id('buySupplier').value,
            purchased_at: $id('buyDate').value,
            quantity: $id('buyQty').value,
            unit_price: $id('buyPrice').value,
            currency: $id('buyCurrency').value,
            exchange_rate: $id('buyRate').value,
            extra_cost: $id('buyExtra').value,
            notes: $id('buyNotes').value,
            update_product: $id('buyUpdate').checked
        });
        $id('buyPrice').value = '';
        $id('buyNotes').value = '';
        setStatus('buyPreview', '');
        setStatus('buyStatus', 'تم التسجيل ✓', 'ok');
        await Promise.all([loadPurchases(), loadProducts()]);
    } catch (err) {
        setStatus('buyStatus', err.message, 'err');
    }
}

async function deletePurchase(id) {
    if (!confirm('حذف هذا السطر من سجل المشتريات؟ (لن يتغير سعر المنتج الحالي)')) return;
    await api('DELETE', `/api/admin/purchases/${id}`);
    await loadPurchases();
}

/* ----------------------------- Quotes ----------------------------- */

async function loadQuotes() {
    if (!online) return;
    const status = $id('quoteFilter').value;
    const rows = await api('GET', '/api/admin/quotes' + (status ? '?status=' + status : ''));
    $id('quotesBody').innerHTML = rows.map((q) => `
        <tr>
            <td><strong>${esc(q.ref)}</strong></td>
            <td>${esc(q.created_at)}</td>
            <td>${esc(q.customer_name)}${q.customer_city ? '<br><small>' + esc(q.customer_city) + '</small>' : ''}
                ${q.notes ? '<br><small style="color:var(--text-light)">' + esc(q.notes) + '</small>' : ''}</td>
            <td><a href="https://wa.me/${esc(q.customer_phone)}" target="_blank" rel="noopener">${esc(q.customer_phone)}</a></td>
            <td class="quote-items">${q.items.map((i) => `${esc(i.name)}${i.type ? ' — ' + esc(i.type) : ''}: ${i.quantity} × ${i.unit_price.toFixed(2)}`).join('<br>')}</td>
            <td><strong>${q.total.toFixed(2)}</strong></td>
            <td>
                <select onchange="setQuoteStatus(${q.id}, this.value)">
                    ${Object.entries(STATUS_NAMES).map(([k, v]) => `<option value="${k}" ${k === q.status ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </td>
        </tr>`).join('');
    $id('quotesEmpty').style.display = rows.length ? 'none' : 'block';
}

async function setQuoteStatus(id, status) {
    try { await api('PATCH', `/api/admin/quotes/${id}`, { status }); } catch (err) { alert(err.message); }
}

/* --------------------------- Integrations ------------------------- */

async function loadHooks() {
    const data = await api('GET', '/api/admin/webhooks');
    hookEvents = data.events;
    hooks = data.webhooks;
    $id('waStatus').textContent = data.whatsapp_configured ? 'مفعّل' : 'غير مفعّل';
    $id('waStatus').className = 'badge' + (data.whatsapp_configured ? ' on' : '');
    $id('waWebhookUrl').textContent = location.origin + '/webhooks/whatsapp';
    if (!$id('hookEvents').children.length) {
        $id('hookEvents').innerHTML = '<label><input type="checkbox" value="*" checked> كل الأحداث</label>' +
            hookEvents.map((e) => `<label><input type="checkbox" value="${e}"> ${e}</label>`).join('');
    }
    $id('hooksBody').innerHTML = data.webhooks.map((h) => `
        <tr>
            <td>${esc(h.name)}</td>
            <td style="direction:ltr; word-break:break-all">${esc(h.url)}</td>
            <td style="direction:ltr">${esc(h.events)}</td>
            <td>${h.active ? '<span class="badge on">مفعّل</span>' : '<span class="badge">متوقف</span>'}</td>
            <td style="white-space:nowrap">
                <button class="btn btn-outline btn-sm" onclick="testHook(${h.id})">اختبار</button>
                <button class="btn btn-outline btn-sm" onclick="editHook(${h.id})">تعديل</button>
                <button class="btn btn-danger btn-sm" onclick="deleteHook(${h.id})">حذف</button>
            </td>
        </tr>`).join('');
    $id('hooksEmpty').style.display = data.webhooks.length ? 'none' : 'block';
}

function resetHookForm() {
    for (const id of ['hookId', 'hookName', 'hookUrl', 'hookSecret']) $id(id).value = '';
    document.querySelectorAll('#hookEvents input').forEach((c) => { c.checked = c.value === '*'; });
    setStatus('hookStatus', '');
}

function editHook(id) {
    const h = hooks.find((x) => x.id === id);
    if (!h) return;
    $id('hookId').value = h.id;
    $id('hookName').value = h.name;
    $id('hookUrl').value = h.url;
    $id('hookSecret').value = h.secret || '';
    const events = h.events.split(',');
    document.querySelectorAll('#hookEvents input').forEach((c) => { c.checked = events.includes(c.value); });
}

async function saveHook() {
    const checked = [...document.querySelectorAll('#hookEvents input:checked')].map((c) => c.value);
    const id = $id('hookId').value;
    try {
        await api(id ? 'PUT' : 'POST', id ? `/api/admin/webhooks/${id}` : '/api/admin/webhooks', {
            name: $id('hookName').value,
            url: $id('hookUrl').value,
            secret: $id('hookSecret').value,
            events: checked.includes('*') || !checked.length ? '*' : checked.join(',')
        });
        resetHookForm();
        setStatus('hookStatus', 'تم الحفظ ✓', 'ok');
        await loadHooks();
    } catch (err) {
        setStatus('hookStatus', err.message, 'err');
    }
}

async function testHook(id) {
    setStatus('hookStatus', 'جارٍ الإرسال...');
    try {
        const r = await api('POST', `/api/admin/webhooks/${id}/test`);
        setStatus('hookStatus', r.ok ? `نجح الاختبار ✓ (HTTP ${r.status_code})` : `فشل: ${r.error}`, r.ok ? 'ok' : 'err');
    } catch (err) {
        setStatus('hookStatus', err.message, 'err');
    }
}

async function deleteHook(id) {
    if (!confirm('حذف هذا الـ Webhook؟')) return;
    await api('DELETE', `/api/admin/webhooks/${id}`);
    await loadHooks();
}

async function previewPriceList() {
    const box = $id('priceListPreview');
    box.textContent = await api('GET', '/api/admin/price-list.txt');
    box.hidden = false;
}

/* ------------------------------ Boot ------------------------------ */

const baseSwitchTab = switchTab;
window.switchTab = function (tabId) {
    baseSwitchTab(tabId);
    if (!online) return;
    if (tabId === 'quotes') loadQuotes();
    if (tabId === 'products') renderProducts();
};

async function initAdmin() {
    applySettings(await api('GET', '/api/admin/settings'));
    online = true;
    await Promise.all([loadProducts(), loadPurchases(), loadHooks()]);
}

(async function boot() {
    $id('buyDate').value = new Date().toISOString().slice(0, 10);
    resetProductForm();
    if (location.protocol === 'file:') {
        setStatus('settingsStatus', 'وضع بدون اتصال — شغّل الخادم لحفظ الأسعار في قاعدة البيانات');
        return;
    }
    try {
        await initAdmin();
        setStatus('settingsStatus', 'متصل بقاعدة البيانات ✓', 'ok');
    } catch (err) {
        setStatus('settingsStatus', err.message, 'err');
    }
})();
