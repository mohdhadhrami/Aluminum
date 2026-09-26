/* =============================================================
   Arabic quotation PDF (pdfkit)
   pdfkit shapes Arabic letters correctly (via fontkit) but lays words out
   left-to-right, so this file places every word itself, right to left.
   Arabic words use Noto Naskh Arabic; digits and Latin text use Helvetica.
   ============================================================= */
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
// Same palette as the customer calculator (company site identity)
const COLORS = { primary: '#1e40af', accent: '#16a34a', text: '#1e293b', light: '#64748b', border: '#e2e8f0', band: '#f1f5f9' };
const LOGO = path.join(__dirname, '..', 'public', 'images', 'logo.png');
const UNIT_LABELS = { meter: 'متر', piece: 'قطعة', m2: 'متر مربع', set: 'طقم', kg: 'كجم', service: 'خدمة' };

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const STRONG_LTR = /[A-Za-z0-9À-ɏ]/;
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<', '{': '}', '}': '{' };

/* Split text into pieces: Arabic words, spaces, and non-Arabic runs. Punctuation at
   either end of a Latin/number run ("(Channels):") is split off so it can follow the
   Arabic direction, as a browser would. */
const ARABIC_RANGE = '؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿';
const PIECE = new RegExp(`[${ARABIC_RANGE}]+|\\s+|[^\\s${ARABIC_RANGE}]+`, 'g');
const EDGES = /^([^A-Za-z0-9À-ɏ]*)(.*?)([^A-Za-z0-9À-ɏ%]*)$/;

function tokenize(text) {
    const out = [];
    for (const t of String(text ?? '').match(PIECE) || []) {
        const m = !ARABIC.test(t) && STRONG_LTR.test(t) && t.match(EDGES);
        if (!m) { out.push(t); continue; }
        out.push(...m[1], m[2], ...m[3]);
    }
    return out;
}

/* Minimal bidi for a right-to-left paragraph: returns pieces in visual (left→right) order */
function visualOrder(tokens) {
    // The spaced dash we use between parts ("النوع — 1.5 ملم") always separates, never joins, LTR runs
    const dirs = tokens.map((t) => (ARABIC.test(t) || t === '—' ? 'R' : STRONG_LTR.test(t) ? 'L' : 'N'));
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
    line(text, x, y, width, { size = 10, bold = false, color = COLORS.text, align = 'right', fit = false } = {}) {
        const f = this.fonts(bold);
        const doc = this.doc;
        const pieces = visualOrder(tokenize(text));
        // fit: shrink the font (down to 70%) rather than overflow the box
        if (fit) {
            const natural = this.width(text, { size, bold });
            if (natural > width) size = Math.max(size * 0.7, size * width / natural);
        }
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
const amount = (from, to) => (to != null && to !== from ? `${money(from)} – ${money(to)}` : money(from));
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
    // Logo on a white badge at the right; company name beside it
    let nameRight = width;
    if (fs.existsSync(LOGO)) {
        doc.roundedRect(right - 64, 14, 64, 64, 10).fill('#ffffff');
        try { doc.image(LOGO, right - 60, 18, { fit: [56, 56], align: 'center', valign: 'center' }); nameRight = width - 76; } catch { /* unreadable image: skip */ }
    }
    w.line(settings.company_name, left, 18, nameRight, { size: 18, bold: true, color: '#ffffff' });
    w.line('عرض سعر', left, 52, nameRight, { size: 13, color: '#ffffff' });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(quote.ref, left, 26, { lineBreak: false });
    const created = String(quote.created_at || new Date().toISOString()).slice(0, 10);
    doc.font('Helvetica').fontSize(10).text(created, left, 50, { lineBreak: false });
    if (settings.company_whatsapp) doc.text('WhatsApp: +' + settings.company_whatsapp.replace(/\D/g, ''), left, 66, { lineBreak: false });

    // ---- Customer & door details ----
    let y = 110;
    const details = quote.details || {};
    const infoRows = [
        ['اسم العميل', quote.customer_name],
        ['رقم الجوال', quote.customer_phone],
        ['الموقع', quote.customer_city || details.region || '—']
    ];
    // Door basics only (gate type and size); the color and accessories are listed in the items table
    const spec = [];
    const given = new Map(Array.isArray(details.spec) ? details.spec : []);
    if (details.shutter_type) {
        spec.push(['نوع البوابة', [details.shutter_type, details.variant].filter(Boolean).join(' — ')]);
    } else if (given.has('نوع البوابة')) {
        spec.push(['نوع البوابة', given.get('نوع البوابة')]);
    } else if (details.package_name) {
        spec.push(['نوع البوابة', `${details.door_type} — ${details.package_name}`]);
    }
    if (details.width_cm) {
        spec.push(['المقاس', `العرض ${details.width_cm} سم — الارتفاع ${details.height_cm} سم` +
            (details.count > 1 ? ` — عدد ${details.count} بوابات` : '')]);
    }

    // Right column: customer; left column: door details (two columns keep the box short)
    const colW = (width - 20) / 2;
    const rows = Math.max(infoRows.length, spec.length);
    const boxH = rows * 20 + 16;
    doc.roundedRect(left, y, width, boxH, 6).fill(COLORS.band);
    const drawColumn = (list, x) => {
        // Label column as wide as its longest label (at most 55% of the column)
        const labelW = Math.min(colW * 0.55, Math.max(60, ...list.map(([l]) => w.width(l + ':', { size: 9.5, bold: true }))) + 8);
        list.forEach(([label, value], i) => {
            const rowY = y + 10 + i * 20;
            w.line(label + ':', x + colW - labelW, rowY, labelW, { size: 9.5, bold: true });
            w.line(value, x + 6, rowY, colW - labelW - 12, { size: 9.5, fit: true });
        });
    };
    drawColumn(infoRows, right - colW);
    if (spec.length) drawColumn(spec, left);
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
            price: amount(item.unit_price, item.unit_price_to),
            total: amount(item.line_total, item.line_total_to)
        };
        let cx = right;
        for (const c of cols) {
            cx -= c.w;
            w.line(cells[c.key], cx + 4, y + 5, c.w - 8, { size: 9.5, align: c.key === 'name' ? 'right' : 'center', fit: true });
        }
        y += 24;
    });
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(COLORS.border).stroke();

    // ---- Totals ----
    y += 14;
    // A range quote (overhead gates: the price depends on the color) shows "from – to" amounts
    const range = details.range || {};
    const tW = range.total_to != null ? 290 : 230;
    const tX = left;
    const valW = range.total_to != null ? 130 : 80;
    const totals = [
        ['المجموع قبل الضريبة', amount(quote.subtotal, range.subtotal_to)],
        [`ضريبة القيمة المضافة ${quote.vat_percent}%`, amount(quote.vat, range.vat_to)]
    ];
    totals.forEach(([label, value]) => {
        w.line(label, tX + valW + 10, y, tW - valW - 10, { size: 10 });
        doc.font('Helvetica').fontSize(10).fillColor(COLORS.text).text(value, tX, y + 3, { width: valW, align: 'left', lineBreak: false });
        y += 20;
    });
    doc.roundedRect(tX, y, tW, 30, 5).fill(COLORS.accent);
    w.line('الإجمالي (ر.ع)', tX + valW + 10, y + 6, tW - valW - 20, { size: 12, bold: true, color: '#ffffff', fit: true });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(amount(quote.total, range.total_to), tX + 10, y + 9, { width: valW, align: 'left', lineBreak: false });
    y += 48;

    // ---- Customer notes, installation note ----
    const pageBottom = doc.page.height - 50;
    const ensureSpace = (h) => { if (y + h > pageBottom) { doc.addPage(); y = 40; } };
    const notes = [];
    if (quote.notes) notes.push('ملاحظات العميل: ' + quote.notes);
    if (details.fees_note) notes.push(details.fees_note);
    for (const n of notes) { ensureSpace(20); y = w.paragraph('• ' + n, left, y, width, { size: 9.5, color: COLORS.light }) - 4; }

    // ---- Terms and conditions (admin setting; one term per line, numbered here) ----
    const terms = String(settings.quote_terms || '').split('\n')
        .map((t) => t.trim().replace(/^\(?\d+\s*[).\-]\s*/, ''))   // drop any typed "1)" — numbers are drawn below
        .filter(Boolean);
    if (terms.length) {
        ensureSpace(40);
        y += 6;
        w.line('الشروط والأحكام:', left, y, width, { size: 11, bold: true, color: COLORS.primary });
        y += 24;
        const numW = 22;
        terms.forEach((term, i) => {
            ensureSpace(22);
            // Number in its own column at the right, so it never mixes into the Arabic text order
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.text)
                .text(`${i + 1})`, right - numW, y + 2.5, { width: numW, align: 'right', lineBreak: false });
            y = w.paragraph(term, left, y, width - numW - 4, { size: 9.5, color: COLORS.text }) - 2;
        });
    }

    // ---- Footer (below the bottom margin, so disable it to avoid an automatic page break) ----
    doc.page.margins.bottom = 0;
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.light)
        .text(quote.ref, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
    doc.end();
    return doc;
}

module.exports = { renderQuotePdf, visualOrder, tokenize };
