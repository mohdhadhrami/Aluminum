/* Governorate → wilayah dropdowns shared by the customer pages.
   Only governorates enabled by the admin are listed; picking one fills the
   wilayah list with that governorate's wilayat only. */
function setupLocationPicker(locations, govSelect, wilayahSelect, onChange) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    govSelect.innerHTML = '<option value="">اختر المحافظة</option>' +
        locations.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');

    const fillWilayat = () => {
        const gov = locations.find((g) => g.id === Number(govSelect.value));
        wilayahSelect.disabled = !gov;
        wilayahSelect.innerHTML = '<option value="">' + (gov ? 'اختر الولاية' : 'اختر المحافظة أولاً') + '</option>' +
            (gov ? gov.wilayat.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('') : '');
        if (onChange) onChange(null);
    };
    govSelect.addEventListener('change', fillWilayat);
    wilayahSelect.addEventListener('change', () => {
        const gov = locations.find((g) => g.id === Number(govSelect.value));
        const w = gov && gov.wilayat.find((x) => x.id === Number(wilayahSelect.value));
        if (onChange) onChange(w || null);
    });
    fillWilayat();
}
