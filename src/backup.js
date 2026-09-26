/* =============================================================
   Database backup as an Excel file, and restore from it.
   - One sheet per table (Arabic sheet names; row 1 = column names).
   - Restore replaces all the data in one transaction; a copy of the
     current data is saved first, so a restore can always be undone.
   - Automatic daily backups are kept next to the database file.
   Logs (webhook deliveries, agent conversations) are not included.
   ============================================================= */
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { resolveDbPath } = require('./db');

/* Parents before children (insert order); delete runs in reverse */
const TABLES = [
    ['settings', 'الإعدادات'],
    ['products', 'المنتجات'],
    ['purchases', 'المشتريات'],
    ['price_history', 'سجل الأسعار'],
    ['quotes', 'عروض الأسعار'],
    ['webhooks', 'Webhooks'],
    ['shutter_types', 'أنواع البوابات'],
    ['shutter_variants', 'السماكات'],
    ['shutter_colors', 'الألوان'],
    ['accessory_groups', 'مجموعات الإكسسوارات'],
    ['accessory_options', 'فئات الإكسسوارات'],
    ['governorates', 'المحافظات'],
    ['regions', 'الولايات'],
    ['overhead_sizes', 'مقاسات الأوفرهيد'],
    ['overhead_motors', 'محركات الأوفرهيد']
];
/* Sheets added after the first backups: an older file without them keeps the current data */
const OPTIONAL = new Set(['overhead_sizes', 'overhead_motors']);
const INFO_SHEET = 'معلومات';
const err400 = (message) => Object.assign(new Error(message), { status: 400 });

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

async function exportWorkbook(db) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Radma pricing';
    wb.created = new Date();
    const info = wb.addWorksheet(INFO_SHEET, { views: [{ rightToLeft: true }] });
    info.columns = [{ header: 'البيان', width: 28 }, { header: 'القيمة', width: 40 }];
    info.addRow(['نسخة احتياطية من قاعدة البيانات', new Date().toISOString().replace('T', ' ').slice(0, 19)]);
    info.addRow(['إصدار النظام', require('../package.json').version]);
    info.addRow(['تنبيه', 'لا تغيّر أسماء الأوراق ولا الصف الأول (أسماء الأعمدة) إذا أردت الاستعادة من هذا الملف']);
    info.getRow(1).font = { bold: true };

    for (const [table, label] of TABLES) {
        const cols = columnsOf(db, table);
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
        info.addRow([label, `${rows.length} سجل`]);
        const ws = wb.addWorksheet(label, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
        ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(12, c.length + 4)) }));
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
        for (const row of rows) ws.addRow(cols.map((c) => row[c]));
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
}

/* Excel cell → SQLite value (empty → NULL; dates, links, rich text → text) */
function cellValue(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
        if ('result' in v) return cellValue(v.result);
        if ('text' in v) return cellValue(v.text);
        return JSON.stringify(v);
    }
    return v;
}

async function readWorkbook(buffer) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); } catch { throw err400('الملف ليس ملف Excel صالحاً'); }
    const missing = TABLES.filter(([table, label]) => !OPTIONAL.has(table) && !wb.getWorksheet(label) && !wb.getWorksheet(table))
        .map(([, label]) => label);
    if (missing.length) throw err400('الملف ليس نسخة احتياطية من النظام — أوراق ناقصة: ' + missing.join('، '));
    const data = {};
    for (const [table, label] of TABLES) {
        const ws = wb.getWorksheet(label) || wb.getWorksheet(table);
        if (!ws) continue; // optional sheet missing
        const header = [];
        ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { header[col] = String(cellValue(cell.value) ?? '').trim(); });
        const rows = [];
        ws.eachRow({ includeEmpty: false }, (row, n) => {
            if (n === 1) return;
            const obj = {};
            header.forEach((name, col) => { if (name) obj[name] = cellValue(row.getCell(col).value); });
            if (Object.values(obj).some((v) => v != null)) rows.push(obj);
        });
        data[table] = { header: header.filter(Boolean), rows };
    }
    return data;
}

/* Replace all the data with the workbook's; all-or-nothing */
async function restoreWorkbook(db, buffer) {
    const data = await readWorkbook(buffer);
    if (!data.settings.rows.length) throw err400('ورقة الإعدادات فارغة — الملف غير صالح للاستعادة');
    const counts = {};
    db.exec('PRAGMA foreign_keys = OFF');
    try {
        db.exec('BEGIN');
        try {
            const present = TABLES.filter(([table]) => data[table]);
            for (const [table] of [...present].reverse()) db.prepare(`DELETE FROM ${table}`).run();
            for (const [table, label] of present) {
                const cols = columnsOf(db, table).filter((c) => data[table].header.includes(c));
                if (!cols.length) throw err400(`ورقة «${label}» لا تحتوي أسماء الأعمدة في الصف الأول`);
                const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
                for (const row of data[table].rows) insert.run(...cols.map((c) => row[c] ?? null));
                counts[table] = data[table].rows.length;
            }
            const broken = db.prepare('PRAGMA foreign_key_check').all();
            if (broken.length) throw err400(`بيانات غير مترابطة في الملف (مثلاً ${broken[0].table} يشير إلى سجل غير موجود في ${broken[0].parent})`);
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            if (!err.status) throw err400('تعذرت الاستعادة: ' + err.message);
            throw err;
        }
    } finally {
        db.exec('PRAGMA foreign_keys = ON');
    }
    return counts;
}

/* ------------------------- Saved backups on the server ------------------------- */

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'aluminum.db');

function backupDir() {
    if (process.env.BACKUP_DIR) return resolveDbPath(process.env.BACKUP_DIR);
    const file = resolveDbPath(process.env.DB_FILE || DEFAULT_DB);
    return file === ':memory:' ? null : path.join(path.dirname(file), 'backups');
}

const NAME_RE = /^(auto|before-restore|manual)-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.xlsx$/;
const KEEP = { auto: 14, 'before-restore': 10, manual: 10 };

function listBackups() {
    const dir = backupDir();
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, kind: name.split('-2')[0], size: st.size, created_at: st.mtime.toISOString() };
    }).sort((a, b) => b.name.localeCompare(a.name));
}

function backupPath(name) {
    const dir = backupDir();
    if (!dir || !NAME_RE.test(String(name))) return null;
    const file = path.join(dir, name);
    return fs.existsSync(file) ? file : null;
}

async function saveBackup(db, kind) {
    const dir = backupDir();
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const name = `${kind}-${stamp}.xlsx`;
    fs.writeFileSync(path.join(dir, name), await exportWorkbook(db));
    // Keep only the newest files of this kind
    for (const old of listBackups().filter((b) => b.kind === kind).slice(KEEP[kind])) {
        fs.rmSync(path.join(dir, old.name), { force: true });
    }
    return name;
}

/* One automatic backup a day (checked at start and every hour) */
function scheduleDailyBackups(db) {
    const run = () => {
        const last = listBackups().find((b) => b.kind === 'auto');
        if (last && Date.now() - Date.parse(last.created_at) < 23 * 3600_000) return;
        saveBackup(db, 'auto').catch((err) => console.error('[backup]', err.message));
    };
    run();
    setInterval(run, 3600_000).unref();
}

module.exports = { exportWorkbook, restoreWorkbook, listBackups, backupPath, saveBackup, scheduleDailyBackups, TABLES };
