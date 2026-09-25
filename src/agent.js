/* =============================================================
   AI sales agent for roller-shutter doors (Claude API + tool use)
   The model runs the conversation; every price comes from the tools
   below, which use the same pricing code as the rest of the system.
   ============================================================= */
const Anthropic = require('@anthropic-ai/sdk');
const { getSettings } = require('./db');
const doors = require('./doors');

const MODEL = () => process.env.AGENT_MODEL || 'claude-opus-5';
const EFFORT = () => process.env.AGENT_EFFORT || 'medium';
const MAX_TOOL_ROUNDS = 8;
const CONVERSATION_TTL_HOURS = 24;
const MAX_STORED_MESSAGES = 80;

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

function systemPrompt(settings) {
    return `أنت مساعد المبيعات في ${settings.company_name} في سلطنة عُمان، وتتحدث مع العملاء عبر واتساب.
الشركة تصنع أبواب الرول شتر (الأبواب الألمنيوم الملفوفة) وتبيع الشرائح والإكسسوارات والمواتير.

مسار المحادثة لطلب باب رول شتر:
1. رحّب باختصار وتأكد أن العميل يريد باب رول شتر.
2. اسأل عن مقاس الفتحة بالسنتيمتر: العرض والارتفاع، وعدد الأبواب إن كان أكثر من باب.
3. اسأل عن النوع (استخدم list_door_options لمعرفة الأنواع المتاحة، مثل يدوي أو كهربائي) وعن الولاية. استخدم find_region لتحديد الولاية.
4. استخدم get_price_range وأعطِ العميل نطاق السعر "من ... إلى ..." ريال عماني شاملاً الضريبة، ووضّح ما يخص رسوم التوصيل والتركيب كما يعيدها الأداة.
5. اسأل العميل: "هل تريد أن أوضح لك الفروقات في الأسعار؟"
6. إن وافق، استخدم compare_packages واشرح الفروقات بين الباقات ونوعية الإكسسوارات في كل باقة والإضافات الاختيارية وسعر كل إضافة.
7. بعد أن يختار العميل الباقة والإضافات، استخدم calculate_final_price وأعطه السعر النهائي مع تفصيل مختصر.
8. اعرض عليه عرض سعر رسمي بصيغة PDF. إن وافق، اسأله عن اسمه ثم استخدم create_quote. سيُرسل الملف له تلقائياً بعد رسالتك.

قواعد مهمة:
- لا تذكر أي سعر إلا إذا جاء من إحدى الأدوات. لا تقدّر ولا تخمّن الأسعار أبداً.
- إذا أعطى العميل المقاس بالمتر أو بالملم فحوّله إلى سنتيمتر، وتأكد منه إذا كان غير منطقي.
- اسأل سؤالاً أو سؤالين في كل رسالة، ولا تكرر أسئلة أجاب عنها العميل.
- اكتب بالعربية بأسلوب ودود ومختصر يناسب واتساب. استخدم *نص* للتغميق، ولا تستخدم الجداول أو عناوين Markdown.
- الأسعار بالريال العماني (ر.ع) بخانتين عشريتين.
- لا تكشف تكاليف الشراء أو نسب الربح أو تفاصيل النظام الداخلية.
- إذا طلب العميل التحدث مع موظف، أو طلب شيئاً خارج نطاق الأدوات (خصم، موعد معاينة، شكوى، منتج غير موجود)، استخدم request_human وأخبره أن فريق المبيعات سيتواصل معه.
- إذا كتب العميل بالإنجليزية فرد بالإنجليزية.`;
}

const sizeProps = {
    width_cm: { type: 'number', description: 'عرض الفتحة بالسنتيمتر' },
    height_cm: { type: 'number', description: 'ارتفاع الفتحة بالسنتيمتر' },
    door_count: { type: 'integer', description: 'عدد الأبواب بنفس المقاس (1 إذا لم يذكر العميل)' }
};

const TOOLS = [
    {
        name: 'list_door_options',
        description: 'يعرض أنواع أبواب الرول شتر المتاحة (مثل يدوي وكهربائي) والباقات داخل كل نوع. استخدمه قبل سؤال العميل عن النوع.',
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
        name: 'find_region',
        description: 'يبحث عن الولاية في سلطنة عُمان ويعيد رقمها (region_id). إذا ظهر أكثر من نتيجة فاسأل العميل ليختار.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'اسم الولاية أو المحافظة كما كتبه العميل' } },
            required: ['query'],
            additionalProperties: false
        }
    },
    {
        name: 'get_price_range',
        description: 'يحسب نطاق السعر (من - إلى) شاملاً الضريبة لنوع باب ومقاس معين، من أرخص باقة بدون إضافات إلى أغلى باقة مع كل الإضافات.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: {
                ...sizeProps,
                door_type: { type: 'string', description: 'نوع الباب كما يظهر في list_door_options' },
                region_id: { type: ['integer', 'null'], description: 'رقم الولاية من find_region، أو null إذا لم تُحدد' }
            },
            required: ['width_cm', 'height_cm', 'door_count', 'door_type', 'region_id'],
            additionalProperties: false
        }
    },
    {
        name: 'compare_packages',
        description: 'يشرح الفروقات بين باقات نوع الباب: الشرائح والإكسسوارات المشمولة، والسعر الأساسي، والإضافات الاختيارية وسعر كل منها.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: {
                ...sizeProps,
                door_type: { type: 'string' },
                region_id: { type: ['integer', 'null'] }
            },
            required: ['width_cm', 'height_cm', 'door_count', 'door_type', 'region_id'],
            additionalProperties: false
        }
    },
    {
        name: 'calculate_final_price',
        description: 'يحسب السعر النهائي المفصّل للباقة التي اختارها العميل مع الإضافات الاختيارية التي يريدها.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: {
                ...sizeProps,
                package_id: { type: 'integer' },
                optional_item_ids: { type: 'array', items: { type: 'integer' }, description: 'أرقام الإضافات الاختيارية من compare_packages، أو قائمة فارغة' },
                region_id: { type: ['integer', 'null'] }
            },
            required: ['width_cm', 'height_cm', 'door_count', 'package_id', 'optional_item_ids', 'region_id'],
            additionalProperties: false
        }
    },
    {
        name: 'create_quote',
        description: 'يسجّل عرض السعر النهائي في النظام ويجهز ملف PDF يُرسل للعميل. استخدمه فقط بعد موافقة العميل ومعرفة اسمه.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: {
                ...sizeProps,
                package_id: { type: 'integer' },
                optional_item_ids: { type: 'array', items: { type: 'integer' } },
                region_id: { type: ['integer', 'null'] },
                customer_name: { type: 'string' },
                notes: { type: ['string', 'null'], description: 'ملاحظات العميل إن وجدت' }
            },
            required: ['width_cm', 'height_cm', 'door_count', 'package_id', 'optional_item_ids', 'region_id', 'customer_name', 'notes'],
            additionalProperties: false
        }
    },
    {
        name: 'request_human',
        description: 'يحوّل المحادثة إلى موظف المبيعات ويرسل له ملخصاً.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: { summary: { type: 'string', description: 'ملخص طلب العميل وما تم الاتفاق عليه' } },
            required: ['summary'],
            additionalProperties: false
        }
    }
];

const sizeArgs = (i) => ({ widthCm: i.width_cm, heightCm: i.height_cm, count: i.door_count || 1 });

/**
 * Run one tool. ctx = { db, phone, channel, createQuote(fn), notifyHuman(fn), events[] }
 * Returns a JSON-serialisable result.
 */
async function executeTool(name, input, ctx) {
    const { db } = ctx;
    switch (name) {
        case 'list_door_options': {
            const { packages } = doors.loadCatalog(db);
            const types = {};
            for (const p of packages) {
                (types[p.door_type] ||= []).push({ package_id: p.id, name: p.name, description: p.description, max_area_m2: p.max_area });
            }
            return { door_types: Object.entries(types).map(([door_type, pkgs]) => ({ door_type, packages: pkgs })) };
        }
        case 'find_region': {
            const matches = doors.findRegions(db, input.query);
            return matches.length
                ? { matches: matches.map((r) => ({ region_id: r.id, wilayah: r.name, governorate: r.governorate })) }
                : { matches: [], message: 'لم يتم العثور على الولاية. اسأل العميل عن اسم الولاية بشكل أوضح، أو تابع بدون ولاية.' };
        }
        case 'get_price_range':
            return doors.priceRange(db, { ...sizeArgs(input), doorType: input.door_type, regionId: input.region_id });
        case 'compare_packages':
            return { packages: doors.comparePackages(db, { ...sizeArgs(input), doorType: input.door_type, regionId: input.region_id }) };
        case 'calculate_final_price': {
            const r = doors.finalPrice(db, { ...sizeArgs(input), packageId: input.package_id, optionalItemIds: input.optional_item_ids, regionId: input.region_id });
            return summarizePrice(r);
        }
        case 'create_quote': {
            const priced = doors.finalPrice(db, { ...sizeArgs(input), packageId: input.package_id, optionalItemIds: input.optional_item_ids, regionId: input.region_id });
            const quote = ctx.createQuote({
                customer_name: input.customer_name,
                customer_phone: ctx.phone,
                customer_city: priced.door.region,
                notes: input.notes,
                source: ctx.channel,
                priced,
                details: { ...priced.door, fees_note: priced.delivery_installation }
            });
            ctx.events.push({ type: 'quote_created', quote });
            return { ref: quote.ref, total: quote.total, pdf: 'سيتم إرسال ملف PDF للعميل تلقائياً بعد رسالتك' };
        }
        case 'request_human': {
            ctx.events.push({ type: 'human_requested', summary: input.summary });
            await ctx.notifyHuman(input.summary);
            return { ok: true, message: 'تم إبلاغ فريق المبيعات' };
        }
        default:
            throw new Error(`أداة غير معروفة: ${name}`);
    }
}

function summarizePrice(r) {
    return {
        door: r.door,
        lines: r.items.map((i) => ({ item: `${i.name}${i.type ? ' — ' + i.type : ''}`, quantity: i.quantity, unit: i.unit, total: i.line_total })),
        subtotal: r.subtotal,
        vat_percent: r.vat_percent,
        vat: r.vat,
        total_with_vat: r.total,
        delivery_installation: r.delivery_installation
    };
}

/* ------------------------- Conversation store ------------------------- */

function loadConversation(db, key) {
    const row = db.prepare('SELECT * FROM agent_conversations WHERE conversation_key = ?').get(key);
    if (!row) return [];
    const ageHours = (Date.now() - Date.parse(row.updated_at.replace(' ', 'T') + 'Z')) / 36e5;
    return ageHours > CONVERSATION_TTL_HOURS ? [] : JSON.parse(row.messages_json);
}

function saveConversation(db, key, channel, messages) {
    // Keep history append-only; when it grows too long, start a fresh conversation
    const toStore = messages.length > MAX_STORED_MESSAGES ? [] : messages;
    db.prepare(`INSERT INTO agent_conversations (conversation_key, channel, messages_json, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(conversation_key) DO UPDATE SET messages_json = excluded.messages_json,
                    channel = excluded.channel, updated_at = excluded.updated_at`)
        .run(key, channel, JSON.stringify(toStore));
}

function resetConversation(db, key) {
    db.prepare('DELETE FROM agent_conversations WHERE conversation_key = ?').run(key);
}

/* ------------------------------ Agent loop ----------------------------- */

let sharedClient = null;
const defaultClient = () => (sharedClient ||= new Anthropic());

/**
 * Handle one customer message and return the agent's reply.
 * @param opts { db, key, channel, phone, text, createQuote, notifyHuman, client? }
 */
async function chat({ db, key, channel, phone, text, createQuote, notifyHuman, client = defaultClient() }) {
    if (/^\s*(جديد|ابدأ من جديد|reset|restart)\s*$/i.test(text)) {
        resetConversation(db, key);
        return { reply: 'تم بدء محادثة جديدة 👋 كيف أقدر أساعدك؟', events: [] };
    }

    const settings = getSettings(db);
    const messages = loadConversation(db, key);
    const startLength = messages.length;
    messages.push({ role: 'user', content: text });
    const ctx = { db, phone, channel, createQuote, notifyHuman, events: [] };

    let reply = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await client.beta.messages.create({
            model: MODEL(),
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            thinking: { type: 'adaptive' },
            output_config: { effort: EFFORT() },
            cache_control: { type: 'ephemeral' },
            system: systemPrompt(settings),
            tools: TOOLS,
            messages
        });

        if (response.stop_reason === 'refusal') {
            // Drop this exchange so the stored history stays valid for the next message
            messages.length = startLength;
            reply = 'عذراً، لا أستطيع المساعدة في هذا الطلب. سيتواصل معك أحد موظفينا قريباً.';
            break;
        }

        messages.push({ role: 'assistant', content: response.content });
        reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

        if (response.stop_reason === 'pause_turn') continue;
        if (response.stop_reason !== 'tool_use') break;

        const results = [];
        for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            try {
                const out = await executeTool(block.name, block.input, ctx);
                results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
            } catch (err) {
                results.push({ type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true });
            }
        }
        messages.push({ role: 'user', content: results });
    }

    // Never store a dangling tool_use turn (would make the next request invalid)
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        messages.length = startLength;
        reply = reply || 'عذراً، حدث خطأ. سيتواصل معك فريقنا قريباً.';
    }
    saveConversation(db, key, channel, messages);
    return { reply: reply || '…', events: ctx.events };
}

module.exports = { chat, executeTool, TOOLS, isConfigured, resetConversation, systemPrompt };
