/* =============================================================
   Knowledge base for the AI agent: FAQs, information and uploaded
   documents (PDF, Word, text) written in the admin panel.
   A small base goes into the agent's instructions in full; a large
   one is searched with the search_knowledge tool.
   ============================================================= */
const path = require('node:path');

const KINDS = { faq: 'سؤال وجواب', info: 'معلومة', document: 'مستند' };
const MAX_CONTENT = 50_000;      // characters kept per item
const FULL_PROMPT_LIMIT = 15_000; // up to this size the whole base is given to the agent
const err400 = (message) => Object.assign(new Error(message), { status: 400 });

function list(db, { activeOnly = false } = {}) {
    return db.prepare(`SELECT * FROM knowledge_items ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, id`).all();
}

function clean(item) {
    const kind = KINDS[item.kind] ? item.kind : 'info';
    const title = String(item.title || '').trim().slice(0, 300);
    const content = String(item.content || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CONTENT);
    if (!title) throw err400(kind === 'faq' ? 'اكتب السؤال' : 'اكتب العنوان');
    if (!content) throw err400(kind === 'faq' ? 'اكتب الجواب' : 'المحتوى فارغ');
    return { kind, title, content, active: item.active === false || item.active === 0 ? 0 : 1 };
}

function add(db, item, sourceName = null) {
    const c = clean(item);
    const next = db.prepare('SELECT IFNULL(MAX(sort_order), -1) + 1 AS n FROM knowledge_items').get().n;
    const id = Number(db.prepare(`INSERT INTO knowledge_items (kind, title, content, source_name, active, sort_order)
                                  VALUES (?, ?, ?, ?, ?, ?)`).run(c.kind, c.title, c.content, sourceName, c.active, next).lastInsertRowid);
    return db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id);
}

function update(db, id, item) {
    const current = db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(Number(id));
    if (!current) throw Object.assign(new Error('العنصر غير موجود'), { status: 404 });
    const c = clean({ ...current, ...item });
    db.prepare(`UPDATE knowledge_items SET kind = ?, title = ?, content = ?, active = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(c.kind, c.title, c.content, c.active, current.id);
    return db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(current.id);
}

/* Text of an uploaded document: PDF, Word (.docx), or plain text (.txt .md .csv) */
async function extractText(buffer, filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (['.txt', '.md', '.csv'].includes(ext)) return buffer.toString('utf8');
    if (ext === '.docx') {
        const mammoth = require('mammoth');
        return (await mammoth.extractRawText({ buffer })).value;
    }
    if (ext === '.pdf') {
        const { extractText: pdfText, getDocumentProxy } = require('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(buffer));
        return (await pdfText(pdf, { mergePages: true })).text;
    }
    throw err400('نوع الملف غير مدعوم — استخدم PDF أو Word (docx) أو ملفاً نصياً (txt)');
}

async function addDocument(db, buffer, filename) {
    let text;
    try {
        text = await extractText(buffer, filename);
    } catch (err) {
        if (err.status) throw err;
        throw err400('تعذرت قراءة الملف: ' + err.message);
    }
    if (!String(text || '').trim()) throw err400('لم يُعثر على نص في الملف (قد يكون صوراً ممسوحة ضوئياً)');
    const title = path.basename(String(filename), path.extname(String(filename))).slice(0, 300) || 'مستند';
    return add(db, { kind: 'document', title, content: text }, String(filename).slice(0, 300));
}

const itemText = (i) => (i.kind === 'faq' ? `س: ${i.title}\nج: ${i.content}` : `### ${i.title}\n${i.content}`);

/* The knowledge-base part of the agent's instructions */
function promptSection(db) {
    const items = list(db, { activeOnly: true });
    if (!items.length) return '';
    const full = items.map(itemText).join('\n\n');
    if (full.length <= FULL_PROMPT_LIMIT) {
        return `قاعدة المعرفة (معلومات معتمدة من الشركة — أجب منها):\n${full}`;
    }
    return 'قاعدة المعرفة كبيرة؛ ابحث فيها بالأداة search_knowledge قبل الإجابة عن أي سؤال عام. عناوينها:\n' +
        items.map((i) => `- ${KINDS[i.kind]}: ${i.title}`).join('\n');
}

/* Words for matching: no diacritics, one form of alef/ta marbuta/ya, no leading "ال" */
const words = (s) => String(s || '').toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => (w.length > 4 && w.startsWith('ال') ? w.slice(2) : w))
    .filter((w) => w.length > 1);

/* Simple word-overlap search (titles count double) */
function search(db, query, limit = 3) {
    const q = [...new Set(words(query))];
    if (!q.length) return [];
    return list(db, { activeOnly: true })
        .map((i) => {
            const title = new Set(words(i.title));
            const body = new Set(words(i.content));
            const score = q.reduce((s, w) => s + (title.has(w) ? 2 : 0) + (body.has(w) ? 1 : 0), 0);
            return { i, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ i }) => ({ type: KINDS[i.kind], title: i.title, content: i.content.slice(0, 4000) }));
}

module.exports = { KINDS, list, add, update, addDocument, extractText, promptSection, search, FULL_PROMPT_LIMIT };
