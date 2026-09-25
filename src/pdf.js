/* =============================================================
   Arabic quotation PDF (pdfkit)
   pdfkit shapes Arabic letters correctly (via fontkit) but lays words out
   left-to-right, so this file places every word itself, right to left.
   Arabic words use Noto Naskh Arabic; digits and Latin text use Helvetica.
   ============================================================= */
const path = require('node:path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const COLORS = { primary: '#1a5276', accent: '#e67e22', text: '#2c3e50', light: '#7f8c8d', border: '#dce1e8', band: '#f0f2f5' };
const UNIT_LABELS = { meter: 'متر', piece: 'قطعة', m2: 'متر مربع', set: 'طقم', kg: 'كجم', service: 'خدمة' };

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const STRONG_LTR = /[A-Za-z0-9À-ɏ]/;
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<', '{': '}', '}': '{' };

/* Split text into pieces: Arabic words, spaces, and non-Arabic runs */
function tokenize(text) {
    return String(text ?? '').match(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+|\s+|[^\s؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+/g) || [];
}

/* Minimal bidi for a right-to-left paragraph: returns pieces in visual (left→right) order */
function visualOrder(tokens) {
    const dirs = tokens.map((t) => (ARABIC.test(t) ? 'R' : STRONG_LTR.test(t) ? 'L' : 'N'));
    // A neutral between two LTR pieces joins them; any other neutral follows the paragraph (RTL)
    const resolved = dirs.map((d, i) => {
        if (d !== 'N') return d;
        const prev = dirs.slice(0, i).reverse().find((x) => x !== 'N');
        const next = dirs.slice(i + 1).find((x) => x !== 'N');
        return prev === 'L' && next === 'L' ? 'L' : 'R';
    });
    const runs = [];
    tokens.forEach((t, i) => {
        const last = runs[runs.length - 1];
        if (resolved[i] === 'L' && last && last.dir === 'L') last.tokens.push(t);
        else runs.push({ dir: resolved[i], tokens: [t] });
    });
    const pieces = [];
    for (const run of runs.reverse()) {
        if (run.dir === 'L') pieces.push({ text: run.tokens.join(''), arabic: false });
        else {
            for (const t of run.tokens) {
                const text = ARABIC.test(t) ? t : [...t].reverse().map((c) => MIRROR[c] || c).join('');
                pieces.push({ text, arabic: ARABIC.test(t) });
            }
        }
    }
    return pieces;
}

class RtlWriter {
    constructor(doc) {
        this.doc = doc;
        doc.registerFont('ar', path.join(FONT_DIR, 'NotoNaskhArabic-Regular.woff'));
        doc.registerFont('ar-bold', path.join(FONT_DIR, 'NotoNaskhArabic-Bold.woff'));
    }

    fonts(bold) {
        return { ar: bold ? 'ar-bold' : 'ar', lat: bold ? 'Helvetica-Bold' : 'Helvetica' };
    }

    width(text, { size = 10, bold = false } = {}) {
        const f = this.fonts(bold);
        this.doc.fontSize(size);
        return visualOrder(tokenize(text)).reduce((w, p) => w + this.doc.font(p.arabic ? f.ar : f.lat).widthOfString(p.text), 0);
    }

    /* Draw one line. x/width define the box; align: right | left | center */
    line(text, x, y, width, { size = 10, bold = false, color = COLORS.text, align = 'right' } = {}) {
        const f = this.fonts(bold);
        const doc = this.doc;
        const pieces = visualOrder(tokenize(text));
        doc.fontSize(size).fillColor(color);
        const widths = pieces.map((p) => doc.font(p.arabic ? f.ar : f.lat).widthOfString(p.text));
        const total = widths.reduce((a, b) => a + b, 0);
        let cx = align === 'left' ? x : align === 'center' ? x + (width - total) / 2 : x + width - total;
        // Arabic glyphs sit lower than Helvetica; nudge Latin pieces to share a baseline
        pieces.forEach((p, i) => {
            doc.font(p.arabic ? f.ar : f.lat).text(p.text, cx, p.arabic ? y : y + size * 0.28, { lineBreak: false });
            cx += widths[i];
        });
    }

    /* Word-wrapped paragraph; returns the y below it */
    paragraph(text, x, y, width, opts = {}) {
        const size = opts.size || 10;
        const lineHeight = size * 1.9;
        for (const para of String(text ?? '').split('\n')) {
            let current = '';
            for (const word of para.split(/\s+/).filter(Boolean)) {
                const candidate = current ? current + ' ' + word : word;
                if (current && this.width(candidate, opts) > width) {
                    this.line(current, x, y, width, opts);
                    y += lineHeight;
                    current = word;
                } else current = candidate;
            }
            if (current) this.line(current, x, y, width, opts);
            y += lineHeight;
        }
        return y;
    }
}

const money = (n) => Number(n).toFixed(2);
const qty = (n) => String(Math.round(Number(n) * 100) / 100);

/**
 * Stream a quotation PDF.
 * @param quote    quote row with parsed .items and optional .details
 * @param settings getSettings(db)
 * @param out      writable stream (HTTP response or file)
 */
function renderQuotePdf(quote, settings, out) {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Quotation ${quote.ref}` } });
    doc.pipe(out);
    const w = new RtlWriter(doc);
    const left = 40;
    const right = doc.page.width - 40;
    const width = right - left;

    // ---- Header band ----
    doc.rect(0, 0, doc.page.width, 92).fill(COLORS.primary);
    w.line(settings.company_name, left, 18, width, { size: 18, bold: true, color: '#ffffff' });
    w.line('عرض سعر', left, 52, width, { size: 13, color: '#ffffff' });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(quote.ref, left, 26, { lineBreak: false });
    const created = String(quote.created_at || new Date().toISOString()).slice(0, 10);
    doc.font('Helvetica').fontSize(10).text(created, left, 50, { lineBreak: false });
    if (settings.company_whatsapp) doc.text('WhatsApp: +' + settings.company_whatsapp.replace(/\D/g, ''), left, 66, { lineBreak: false });

    // ---- Customer & door details ----
    let y = 110;
    const details = quote.details || {};
    const infoRows = [
        ['العميل', quote.customer_name],
        ['الهاتف', quote.customer_phone],
        ['الولاية / المدينة', quote.customer_city || details.region || '—']
    ];
    if (details.width_cm) {
        infoRows.push(['المقاس', `العرض ${details.width_cm} سم — الارتفاع ${details.height_cm} سم — عدد الأبواب ${details.count}`]);
        infoRows.push(['النوع', `${details.door_type} — ${details.package_name}`]);
    }
    const boxH = infoRows.length * 20 + 16;
    doc.roundedRect(left, y, width, boxH, 6).fill(COLORS.band);
    infoRows.forEach(([label, value], i) => {
        const rowY = y + 10 + i * 20;
        w.line(label + ':', right - 110, rowY, 100, { size: 10, bold: true });
        w.line(value, left + 10, rowY, width - 130, { size: 10 });
    });
    y += boxH + 18;

    // ---- Items table (columns listed right → left) ----
    const cols = [
        { key: 'idx', title: '#', w: 26 },
        { key: 'name', title: 'البيان', w: 215 },
        { key: 'qty', title: 'الكمية', w: 62 },
        { key: 'unit', title: 'الوحدة', w: 54 },
        { key: 'price', title: 'سعر الوحدة', w: 78 },
        { key: 'total', title: 'المجموع', w: width - 26 - 215 - 62 - 54 - 78 }
    ];
    const header = () => {
        doc.rect(left, y, width, 24).fill(COLORS.primary);
        let cx = right;
        for (const c of cols) {
            cx -= c.w;
            w.line(c.title, cx, y + 5, c.w, { size: 10, bold: true, color: '#ffffff', align: 'center' });
        }
        y += 24;
    };
    header();
    quote.items.forEach((item, i) => {
        if (y > doc.page.height - 190) { doc.addPage(); y = 40; header(); }
        if (i % 2 === 1) doc.rect(left, y, width, 24).fill(COLORS.band);
        const cells = {
            idx: String(i + 1),
            name: item.name + (item.type ? ' — ' + item.type : '') + (item.optional ? ' (إضافة)' : ''),
            qty: qty(item.quantity),
            unit: UNIT_LABELS[item.unit] || item.unit,
            price: money(item.unit_price),
            total: money(item.line_total)
        };
        let cx = right;
        for (const c of cols) {
            cx -= c.w;
            w.line(cells[c.key], cx + 4, y + 5, c.w - 8, { size: 9.5, align: c.key === 'name' ? 'right' : 'center' });
        }
        y += 24;
    });
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(COLORS.border).stroke();

    // ---- Totals ----
    y += 14;
    const tW = 230;
    const tX = left;
    const totals = [
        ['المجموع قبل الضريبة', money(quote.subtotal)],
        [`ضريبة القيمة المضافة ${quote.vat_percent}%`, money(quote.vat)]
    ];
    totals.forEach(([label, value]) => {
        w.line(label, tX + 90, y, tW - 90, { size: 10 });
        doc.font('Helvetica').fontSize(10).fillColor(COLORS.text).text(value, tX, y + 3, { width: 80, align: 'left', lineBreak: false });
        y += 20;
    });
    doc.roundedRect(tX, y, tW, 30, 5).fill(COLORS.accent);
    w.line('الإجمالي (ر.ع)', tX + 90, y + 6, tW - 100, { size: 12, bold: true, color: '#ffffff' });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(money(quote.total), tX + 10, y + 9, { width: 80, align: 'left', lineBreak: false });
    y += 48;

    // ---- Notes & terms ----
    const notes = [];
    if (quote.notes) notes.push('ملاحظات: ' + quote.notes);
    if (details.fees_note) notes.push(details.fees_note);
    notes.push(`هذا العرض صالح لمدة ${settings.quote_validity_days} يوماً من تاريخه، والأسعار بالريال العماني.`);
    notes.push('المقاسات النهائية تُعتمد بعد المعاينة الميدانية.');
    for (const n of notes) y = w.paragraph('• ' + n, left, y, width, { size: 9.5, color: COLORS.light }) - 4;

    // ---- Footer (below the bottom margin, so disable it to avoid an automatic page break) ----
    doc.page.margins.bottom = 0;
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.light)
        .text(quote.ref, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
    doc.end();
    return doc;
}

module.exports = { renderQuotePdf, visualOrder, tokenize };
