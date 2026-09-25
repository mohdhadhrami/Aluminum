/* =============================================================
   Admin panel — connects the pricing app to the server database.
   If the page is opened without the server (e.g. as a local file)
   the original calculators keep working offline with default values.
   ============================================================= */

const CATEGORY_NAMES = { slat: 'شرائح', accessory: 'إكسسوارات', machine: 'مكائن' };
const UNIT_NAMES = { meter: 'متر', piece: 'قطعة', m2: 'م²', set: 'طقم', kg: 'كجم' };
const STATUS_NAMES = { new: 'جديد', contacted: 'تم التواصل', accepted: 'مقبول', rejected: 'مرفوض', done: 'مكتمل' };
const SOURCE_NAMES = { web: 'الحاسبة', whatsapp: 'واتساب (AI)', 'agent-test': 'تجربة المساعد' };
const BASIS_NAMES = { fixed: 'ثابت', width: '× العرض', height: '× الارتفاع', area: '× المساحة' };
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
    $id('quoteValidity').value = s.quote_validity_days;
    $id('companyTagline').value = s.company_tagline || '';
    $id('companyPhone').value = s.company_phone || '';
    $id('companyAddress').value = s.company_address || '';
    $id('companyWebsite').value = s.company_website || '';
    $id('calculatorNotice').value = s.calculator_notice || '';
    $id('calculatorNotes').value = s.calculator_notes || '';
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
            sqm_to_linear: parseFloat($id('sqmToLinear').value) || 13,
            quote_validity_days: parseInt($id('quoteValidity').value, 10) || 15,
            company_tagline: $id('companyTagline').value,
            company_phone: $id('companyPhone').value,
            company_address: $id('companyAddress').value,
            company_website: $id('companyWebsite').value,
            calculator_notice: $id('calculatorNotice').value,
            calculator_notes: $id('calculatorNotes').value
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
            <td>${esc(SOURCE_NAMES[q.source] || q.source)}</td>
            <td>
                <select onchange="setQuoteStatus(${q.id}, this.value)">
                    ${Object.entries(STATUS_NAMES).map(([k, v]) => `<option value="${k}" ${k === q.status ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </td>
            <td><button class="btn btn-outline btn-sm" onclick="openQuotePdf(${q.id})">PDF</button></td>
        </tr>`).join('');
    $id('quotesEmpty').style.display = rows.length ? 'none' : 'block';
}

/* The admin PDF needs the auth header, so fetch it as a blob and download it */
async function openQuotePdf(id) {
    let token = '';
    try { token = localStorage.getItem('adminToken') || ''; } catch { /* ignore */ }
    const res = await fetch(`/api/admin/quotes/${id}/pdf`, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return alert('تعذر إنشاء ملف PDF');
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = name ? name[1] : 'quotation.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
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

/* ------------------------ Door configurator ------------------------ */

let configurator = { shutter_types: [], accessory_groups: [] };
let regions = [];
let governorates = [];

const productOptions = (filter, selected) => products.filter(filter)
    .map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.type ? ' — ' + esc(p.type) : ''} (${p.unit_price.toFixed(2)} ر.ع/${esc(UNIT_NAMES[p.unit] || p.unit)})</option>`)
    .join('');

async function loadDoors() {
    [configurator, regions, governorates] = await Promise.all([
        api('GET', '/api/admin/configurator'), api('GET', '/api/admin/regions'), api('GET', '/api/admin/governorates')
    ]);
    $id('pvType').innerHTML = '<option value="">كل الأنواع</option>' +
        configurator.shutter_types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    const activeGov = governorates.filter((g) => g.active).map((g) => g.name);
    $id('pvRegion').innerHTML = '<option value="">— بدون —</option>' +
        regions.filter((r) => r.active && activeGov.includes(r.governorate)).map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.governorate)}</option>`).join('');
    const govOptions = governorates.map((g) => `<option value="${esc(g.name)}">${esc(g.name)}</option>`).join('');
    const keep = $id('regionGovFilter').value;
    $id('regionGovFilter').innerHTML = '<option value="">كل المحافظات</option>' + govOptions;
    $id('regionGovFilter').value = keep;
    $id('newRegionGov').innerHTML = govOptions;
    renderTypes();
    renderGroups();
    renderGovernorates();
    renderRegions();
    if (!$id('variantRows').children.length && !$id('typeId').value) resetTypeForm();
    if (!$id('optionRows').children.length && !$id('groupId').value) resetGroupForm();
}

/* ---- Shutter types ---- */

function renderTypes() {
    $id('typesList').innerHTML = configurator.shutter_types.map((t) => `
        <div class="pkg-card" style="${t.active ? '' : 'opacity:0.55'}">
            <h4>${esc(t.name)}</h4>
            <div class="status-text">${esc(t.description || '')}</div>
            <ul>
                <li>السماكات: ${t.variants.map((v) => esc(v.label)).join('، ') || '<span style="color:var(--danger)">لا يوجد — لن يظهر للعميل</span>'}</li>
                <li>الألوان: ${t.colors.map((c) => `<span class="swatch-dot" style="background:${esc(c.hex || '#ccc')}"></span> ${esc(c.name)}`).join('، ') || 'بدون اختيار لون'}</li>
            </ul>
            <button class="btn btn-outline btn-sm" onclick="editType(${t.id})">تعديل</button>
            <button class="btn btn-danger btn-sm" onclick="deleteType(${t.id})">حذف</button>
        </div>`).join('') || '<div class="empty-message">لا توجد أنواع.</div>';
}

function addVariantRow(v = {}) {
    const tr = document.createElement('tr');
    tr.dataset.id = v.id || '';
    tr.innerHTML = `
        <td><input class="row-input v-label" value="${esc(v.label || '')}"></td>
        <td><select class="row-input v-product">${productOptions((p) => p.category === 'slat', v.product_id)}</select></td>
        <td><button class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">✕</button></td>`;
    $id('variantRows').appendChild(tr);
}

function addColorRow(c = {}) {
    const tr = document.createElement('tr');
    tr.dataset.id = c.id || '';
    tr.innerHTML = `
        <td><input class="row-input c-name" value="${esc(c.name || '')}"></td>
        <td><input type="color" class="c-hex" value="${esc(c.hex || '#cccccc')}"></td>
        <td><input type="number" class="row-input c-surcharge" min="0" step="0.1" value="${c.surcharge_per_m2 || 0}" style="width:100px"></td>
        <td><button class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">✕</button></td>`;
    $id('colorRows').appendChild(tr);
}

function resetTypeForm() {
    $id('typeId').value = '';
    $id('typeFormTitle').textContent = 'إضافة نوع بوابة';
    for (const id of ['typeName', 'typeImage', 'typeDesc']) $id(id).value = '';
    $id('typeSort').value = 0;
    $id('typeActive').checked = true;
    $id('variantRows').innerHTML = '';
    $id('colorRows').innerHTML = '';
    addVariantRow({ label: 'قياسي' });
    setStatus('typeStatus', '');
}

function editType(id) {
    const t = configurator.shutter_types.find((x) => x.id === id);
    if (!t) return;
    $id('typeId').value = t.id;
    $id('typeFormTitle').textContent = 'تعديل: ' + t.name;
    $id('typeName').value = t.name;
    $id('typeImage').value = t.image_url || '';
    $id('typeDesc').value = t.description || '';
    $id('typeSort').value = t.sort_order;
    $id('typeActive').checked = !!t.active;
    $id('variantRows').innerHTML = '';
    $id('colorRows').innerHTML = '';
    t.variants.forEach(addVariantRow);
    t.colors.forEach(addColorRow);
    $id('typeFormTitle').scrollIntoView({ behavior: 'smooth' });
}

async function saveType() {
    const id = $id('typeId').value;
    const rows = (sel) => [...document.querySelectorAll(sel + ' tr')];
    try {
        await api(id ? 'PUT' : 'POST', id ? `/api/admin/shutter-types/${id}` : '/api/admin/shutter-types', {
            name: $id('typeName').value, description: $id('typeDesc').value, image_url: $id('typeImage').value,
            sort_order: $id('typeSort').value, active: $id('typeActive').checked,
            variants: rows('#variantRows').map((tr) => ({
                id: Number(tr.dataset.id) || undefined, label: tr.querySelector('.v-label').value,
                product_id: Number(tr.querySelector('.v-product').value)
            })),
            colors: rows('#colorRows').map((tr) => ({
                id: Number(tr.dataset.id) || undefined, name: tr.querySelector('.c-name').value,
                hex: tr.querySelector('.c-hex').value, surcharge_per_m2: tr.querySelector('.c-surcharge').value
            }))
        });
        resetTypeForm();
        setStatus('typeStatus', 'تم الحفظ ✓', 'ok');
        await loadDoors();
    } catch (err) {
        setStatus('typeStatus', err.message, 'err');
    }
}

async function deleteType(id) {
    if (!confirm('حذف هذا النوع؟ (لإخفائه فقط عدّله وألغِ «مفعّل»)')) return;
    await api('DELETE', `/api/admin/shutter-types/${id}`);
    await loadDoors();
}

/* ---- Accessory groups ---- */

function renderGroups() {
    $id('groupsList').innerHTML = configurator.accessory_groups.map((g) => `
        <div class="pkg-card" style="${g.active ? '' : 'opacity:0.55'}">
            <h4>${esc(g.name)} <span class="badge">${g.factor} ${esc(BASIS_NAMES[g.basis])}</span>${g.allow_none ? ` <span class="badge">${esc(g.none_label || 'يمكن الاستغناء')}</span>` : ''}</h4>
            <div class="status-text">${esc(g.description || '')}</div>
            <ul>${g.options.map((o) => {
                const p = products.find((x) => x.id === o.product_id);
                return `<li style="${o.active ? '' : 'opacity:0.5'}"><strong>${esc(o.label)}</strong> — ${p ? p.unit_price.toFixed(2) + ' ر.ع/' + esc(UNIT_NAMES[p.unit] || p.unit) : '؟'} — ${esc(o.details || '')}</li>`;
            }).join('')}</ul>
            <button class="btn btn-outline btn-sm" onclick="editGroup(${g.id})">تعديل</button>
            <button class="btn btn-danger btn-sm" onclick="deleteGroup(${g.id})">حذف</button>
        </div>`).join('') || '<div class="empty-message">لا توجد مجموعات.</div>';
}

function addOptionRow(o = {}) {
    const tr = document.createElement('tr');
    tr.dataset.id = o.id || '';
    tr.innerHTML = `
        <td><input class="row-input o-label" value="${esc(o.label || '')}" style="width:110px"></td>
        <td><select class="row-input o-product">${productOptions((p) => p.category !== 'slat', o.product_id)}</select></td>
        <td><input class="row-input o-details" value="${esc(o.details || '')}"></td>
        <td><input class="row-input o-image" value="${esc(o.image_url || '')}" placeholder="https://..." style="width:130px"></td>
        <td><input type="checkbox" class="o-active" ${o.active === 0 ? '' : 'checked'}></td>
        <td><button class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">✕</button></td>`;
    $id('optionRows').appendChild(tr);
}

function resetGroupForm() {
    $id('groupId').value = '';
    $id('groupFormTitle').textContent = 'إضافة مجموعة إكسسوارات';
    for (const id of ['groupName', 'groupDesc', 'groupNoneLabel']) $id(id).value = '';
    $id('groupBasis').value = 'fixed';
    $id('groupFactor').value = 1;
    $id('groupSort').value = 0;
    $id('groupNone').checked = false;
    $id('groupNoneLabel').disabled = true;
    $id('groupActive').checked = true;
    $id('optionRows').innerHTML = '';
    ['Class A', 'Class B', 'Class C'].forEach((label) => addOptionRow({ label }));
    setStatus('groupStatus', '');
}

function editGroup(id) {
    const g = configurator.accessory_groups.find((x) => x.id === id);
    if (!g) return;
    $id('groupId').value = g.id;
    $id('groupFormTitle').textContent = 'تعديل: ' + g.name;
    $id('groupName').value = g.name;
    $id('groupDesc').value = g.description || '';
    $id('groupBasis').value = g.basis;
    $id('groupFactor').value = g.factor;
    $id('groupSort').value = g.sort_order;
    $id('groupNone').checked = !!g.allow_none;
    $id('groupNoneLabel').disabled = !g.allow_none;
    $id('groupNoneLabel').value = g.none_label || '';
    $id('groupActive').checked = !!g.active;
    $id('optionRows').innerHTML = '';
    g.options.forEach(addOptionRow);
    $id('groupFormTitle').scrollIntoView({ behavior: 'smooth' });
}

async function saveGroup() {
    const id = $id('groupId').value;
    try {
        await api(id ? 'PUT' : 'POST', id ? `/api/admin/accessory-groups/${id}` : '/api/admin/accessory-groups', {
            name: $id('groupName').value, description: $id('groupDesc').value, basis: $id('groupBasis').value,
            factor: $id('groupFactor').value, sort_order: $id('groupSort').value, allow_none: $id('groupNone').checked,
            none_label: $id('groupNoneLabel').value, active: $id('groupActive').checked,
            options: [...document.querySelectorAll('#optionRows tr')].map((tr) => ({
                id: Number(tr.dataset.id) || undefined, label: tr.querySelector('.o-label').value,
                product_id: Number(tr.querySelector('.o-product').value), details: tr.querySelector('.o-details').value,
                image_url: tr.querySelector('.o-image').value, active: tr.querySelector('.o-active').checked
            }))
        });
        resetGroupForm();
        setStatus('groupStatus', 'تم الحفظ ✓', 'ok');
        await loadDoors();
    } catch (err) {
        setStatus('groupStatus', err.message, 'err');
    }
}

async function deleteGroup(id) {
    if (!confirm('حذف هذه المجموعة وفئاتها؟')) return;
    await api('DELETE', `/api/admin/accessory-groups/${id}`);
    await loadDoors();
}

/* ---- Preview ---- */

async function previewDoor() {
    const qs = new URLSearchParams({
        width_cm: $id('pvWidth').value, height_cm: $id('pvHeight').value, count: $id('pvCount').value,
        shutter_type_id: $id('pvType').value, region_id: $id('pvRegion').value
    });
    try {
        const { range, compare } = await api('GET', '/api/admin/configurator/preview?' + qs);
        if (!range.available) { $id('pvResult').innerHTML = `<div class="range-box">${esc(range.message)}</div>`; return; }
        const byType = range.by_type.map((t) => `<li>${esc(t.shutter_type)}: من ${t.from.toFixed(2)} إلى ${t.to.toFixed(2)} ر.ع</li>`).join('');
        const details = compare ? `
            <div class="pkg-card" style="margin-top:10px;">
                <h4>${esc(compare.shutter_type.name)} — تفاصيل الفروقات (شاملة الضريبة)</h4>
                <ul>
                    ${compare.thickness_options.map((v) => `<li>شرائح ${esc(v.label)}: ${v.slats_price_with_vat.toFixed(2)} ر.ع</li>`).join('')}
                    ${compare.colors.filter((c) => c.adds_with_vat > 0).map((c) => `<li>لون ${esc(c.name)}: +${c.adds_with_vat.toFixed(2)} ر.ع</li>`).join('')}
                </ul>
                ${compare.accessories.map((g) => `<strong>${esc(g.group)}</strong><ul>${g.classes.map((c) => `<li>${esc(c.label)}: ${c.price_with_vat.toFixed(2)} ر.ع</li>`).join('')}${g.can_skip ? `<li>${esc(g.skip_label)}: 0.00</li>` : ''}</ul>`).join('')}
            </div>` : '';
        $id('pvResult').innerHTML = `
            <div class="range-box">النطاق: <strong>من ${range.from.toFixed(2)} إلى ${range.to.toFixed(2)} ر.ع</strong>
                شامل الضريبة — المساحة ${range.area_m2} م² — ${esc(range.delivery_installation)}<ul style="margin-top:6px; padding-inline-start:20px">${byType}</ul></div>${details}`;
    } catch (err) {
        $id('pvResult').innerHTML = `<div class="range-box" style="color:var(--danger)">${esc(err.message)}</div>`;
    }
}

/* ---- Governorates & wilayat ---- */

function renderGovernorates() {
    $id('govToggles').innerHTML = governorates.map((g) =>
        `<label><input type="checkbox" ${g.active ? 'checked' : ''} onchange="toggleGovernorate(${g.id}, this.checked)"> ${esc(g.name)}</label>`).join('');
}

async function toggleGovernorate(id, active) {
    try {
        const g = await api('PUT', `/api/admin/governorates/${id}`, { active });
        governorates[governorates.findIndex((x) => x.id === id)] = g;
    } catch (err) {
        alert(err.message);
    }
}

function renderRegions() {
    const gov = $id('regionGovFilter').value;
    const f = $id('regionFilter').value.trim();
    $id('regionsBody').innerHTML = regions
        .filter((r) => (!gov || r.governorate === gov) && (!f || r.name.includes(f)))
        .map((r) => `
        <tr>
            <td>${esc(r.governorate || '')}</td>
            <td>${esc(r.name)}</td>
            <td><input type="number" min="0" step="0.5" id="ri${r.id}" value="${r.installation_fee ?? ''}" placeholder="بعد المعاينة" style="width:110px"></td>
            <td><input type="number" min="0" step="0.5" id="rd${r.id}" value="${r.delivery_fee ?? ''}" placeholder="—" style="width:90px"></td>
            <td><button class="btn btn-outline btn-sm" onclick="saveRegion(${r.id}, this)">حفظ</button></td>
        </tr>`).join('');
}

async function saveRegion(id, btn) {
    try {
        const r = await api('PUT', `/api/admin/regions/${id}`, { installation_fee: $id('ri' + id).value, delivery_fee: $id('rd' + id).value });
        regions[regions.findIndex((x) => x.id === id)] = r;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = 'حفظ'; }, 1500);
    } catch (err) {
        alert(err.message);
    }
}

async function addRegion() {
    try {
        await api('POST', '/api/admin/regions', { name: $id('newRegionName').value, governorate: $id('newRegionGov').value });
        $id('newRegionName').value = '';
        await loadDoors();
    } catch (err) {
        alert(err.message);
    }
}

/* --------------------------- Agent console ------------------------- */

const chatSession = 'admin-' + Math.random().toString(36).slice(2, 8);

function bubble(kind, content) {
    const div = document.createElement('div');
    div.className = 'bubble ' + kind;
    if (content instanceof Node) div.appendChild(content); else div.textContent = content;
    $id('chatLog').appendChild(div);
    $id('chatLog').scrollTop = $id('chatLog').scrollHeight;
}

async function loadAgentStatus() {
    const s = await api('GET', '/api/admin/agent/status');
    $id('agentStatus').textContent = s.configured ? 'مفعّل' : 'غير مفعّل — أضف ANTHROPIC_API_KEY في ملف .env';
    $id('agentStatus').className = 'badge' + (s.configured ? ' on' : '');
    $id('agentModel').textContent = s.configured ? 'النموذج: ' + s.model : '';
}

async function sendChat() {
    const input = $id('chatInput');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    bubble('user', message);
    $id('chatSend').disabled = true;
    try {
        const r = await api('POST', '/api/admin/agent/chat', { session: chatSession, message });
        bubble('bot', r.reply);
        for (const e of r.events) {
            if (e.type === 'quote_created') {
                const a = document.createElement('a');
                a.href = e.pdf_url; a.target = '_blank'; a.rel = 'noopener';
                a.textContent = `📄 عرض سعر ${e.ref} — ${e.total.toFixed(2)} ر.ع (فتح PDF)`;
                bubble('event', a);
            } else if (e.type === 'human_requested') {
                bubble('event', '🙋 طلب تحويل لموظف: ' + e.summary);
            }
        }
    } catch (err) {
        bubble('event', '⚠️ ' + err.message);
    } finally {
        $id('chatSend').disabled = false;
        input.focus();
    }
}

async function resetChat() {
    await api('POST', '/api/admin/agent/reset', { session: chatSession });
    $id('chatLog').innerHTML = '';
}

/* ------------------------------ Boot ------------------------------ */

const baseSwitchTab = switchTab;
window.switchTab = function (tabId) {
    baseSwitchTab(tabId);
    if (!online) return;
    if (tabId === 'quotes') loadQuotes();
    if (tabId === 'products') renderProducts();
    if (tabId === 'doors') loadDoors();
};

async function initAdmin() {
    applySettings(await api('GET', '/api/admin/settings'));
    online = true;
    await Promise.all([loadProducts(), loadPurchases(), loadHooks(), loadAgentStatus()]);
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
