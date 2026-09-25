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
الشركة تركّب بوابات الرول شتر (الأبواب الألمنيوم الملفوفة) بأنواع مختلفة، مع إكسسوارات بفئات مختلفة.

مسار المحادثة لطلب بوابة رول شتر:
1. رحّب باختصار وتأكد أن العميل يريد بوابة رول شتر.
2. اسأل عن مقاس الفتحة بالسنتيمتر: العرض والارتفاع، وعدد البوابات إن كان أكثر من واحدة.
3. استخدم list_door_options واسأل العميل عن نوع البوابة (مثل الإيراني أو التركي أو العماني)، واسأله عن الولاية. استخدم find_region لتحديد الولاية؛ إذا ظهرت أكثر من نتيجة فاسأله عن المحافظة.
4. استخدم get_price_range وأعطِ العميل نطاق السعر "من ... إلى ..." ريال عماني شاملاً الضريبة، ووضّح حالة رسوم التركيب كما تعيدها الأداة.
5. اسأل العميل: "هل تريد أن أوضح لك الفروقات في الأسعار؟"
6. إن وافق، استخدم compare_options واشرح: السماكات/الدرجات المتاحة لهذا النوع (إن وُجد أكثر من واحدة) والألوان المتوفرة مع كل سماكة وسعر الشرائح لكل لون (بعض الألوان لها سعر ورسوم صبغ مختلفة)، ثم الإكسسوارات واحدة تلو الأخرى (المسارات الجانبية، عمود محور الدوران، القواعد، المحرك...) مع فئاتها Class A / B / C وتفاصيل كل فئة وسعرها لهذا المقاس. لا تُغرق العميل بكل شيء في رسالة واحدة إن كانت طويلة.
7. بعد أن يختار العميل السماكة واللون وفئة كل إكسسوار، استخدم calculate_final_price وأعطه السعر النهائي مع تفصيل مختصر.
8. اعرض عليه عرض سعر رسمي بصيغة PDF. إن وافق، اسأله عن اسمه ثم استخدم create_quote. سيُرسل الملف له تلقائياً بعد رسالتك.

قواعد مهمة:
- لا تذكر أي سعر إلا إذا جاء من إحدى الأدوات. لا تقدّر ولا تخمّن الأسعار أبداً.
- إذا أعطى العميل المقاس بالمتر أو بالملم فحوّله إلى سنتيمتر، وتأكد منه إذا كان غير منطقي.
- إذا لم يحدد العميل فئة إكسسوار بعد شرحها، فاسأله أو اقترح عليه، ولا تختر عنه بصمت.
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
    door_count: { type: 'integer', description: 'عدد البوابات بنفس المقاس (1 إذا لم يذكر العميل)' }
};

const choiceProps = {
    shutter_type_id: { type: 'integer', description: 'رقم نوع البوابة من list_door_options' },
    variant_id: { type: ['integer', 'null'], description: 'رقم السماكة من compare_options، أو null إذا للنوع سماكة واحدة' },
    color_id: { type: ['integer', 'null'], description: 'رقم اللون من ألوان السماكة المختارة في compare_options، أو null إذا لا توجد ألوان' },
    option_ids: { type: 'array', items: { type: 'integer' }, description: 'رقم الفئة المختارة (option_id) لكل مجموعة إكسسوارات؛ لا تضع شيئاً لمجموعة يمكن تركها (مثل بدون محرك)' },
    region_id: { type: ['integer', 'null'], description: 'رقم الولاية من find_region، أو null' }
};

const TOOLS = [
    {
        name: 'list_door_options',
        description: 'يعرض أنواع بوابات الرول شتر المتاحة (مثل الإيراني والتركي والعماني) مع وصف كل نوع، وأسماء مجموعات الإكسسوارات وفئاتها. استخدمه قبل سؤال العميل عن النوع.',
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
        name: 'find_region',
        description: 'يبحث عن الولاية (أو المحافظة) في سلطنة عُمان ويعيد رقمها region_id. إذا ظهر أكثر من نتيجة فاسأل العميل ليختار.',
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
        description: 'يحسب نطاق السعر (من - إلى) شاملاً الضريبة والتركيب لمقاس معين: من أرخص سماكة وفئات إكسسوارات إلى أغلاها. إذا لم يُحدد النوع يعطي النطاق لكل الأنواع.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: {
                ...sizeProps,
                shutter_type_id: { type: ['integer', 'null'], description: 'رقم نوع البوابة، أو null لكل الأنواع' },
                region_id: choiceProps.region_id
            },
            required: ['width_cm', 'height_cm', 'door_count', 'shutter_type_id', 'region_id'],
            additionalProperties: false
        }
    },
    {
        name: 'compare_options',
        description: 'يشرح الفروقات لنوع بوابة ومقاس معين: السماكات/الدرجات المتاحة مع تفاصيلها، والألوان المتوفرة مع كل سماكة وسعر الشرائح لكل لون (شامل رسوم الصبغ)، ولكل مجموعة إكسسوارات فئاتها (Class A/B/C) مع التفاصيل وسعر كل فئة لهذا المقاس.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: { ...sizeProps, shutter_type_id: choiceProps.shutter_type_id },
            required: ['width_cm', 'height_cm', 'door_count', 'shutter_type_id'],
            additionalProperties: false
        }
    },
    {
        name: 'calculate_final_price',
        description: 'يحسب السعر النهائي المفصّل لاختيارات العميل: النوع والسماكة واللون وفئة كل إكسسوار، مع التركيب حسب الولاية.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: { ...sizeProps, ...choiceProps },
            required: ['width_cm', 'height_cm', 'door_count', ...Object.keys(choiceProps)],
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
                ...choiceProps,
                customer_name: { type: 'string' },
                notes: { type: ['string', 'null'], description: 'ملاحظات العميل إن وجدت' }
            },
            required: ['width_cm', 'height_cm', 'door_count', ...Object.keys(choiceProps), 'customer_name', 'notes'],
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
const choiceArgs = (i) => ({
    ...sizeArgs(i), shutterTypeId: i.shutter_type_id, variantId: i.variant_id, colorId: i.color_id,
    optionIds: i.option_ids || [], regionId: i.region_id
});

/**
 * Run one tool. ctx = { db, phone, channel, createQuote(fn), notifyHuman(fn), events[] }
 * Returns a JSON-serialisable result.
 */
async function executeTool(name, input, ctx) {
    const { db } = ctx;
    switch (name) {
        case 'list_door_options': {
            const catalog = doors.publicCatalog(db);
            return {
                shutter_types: catalog.shutter_types.map((t) => ({
                    shutter_type_id: t.id, name: t.name, description: t.description,
                    thickness_options: t.variants.map((v) => ({ label: v.label, details: v.description, colors: v.colors.map((c) => c.name) }))
                })),
                accessory_groups: catalog.accessory_groups.map((g) => ({
                    group: g.name, classes: g.options.map((o) => o.label), can_skip: g.allow_none
                }))
            };
        }
        case 'find_region': {
            const matches = doors.findRegions(db, input.query);
            return matches.length
                ? { matches: matches.map((r) => ({ region_id: r.id, wilayah: r.name, governorate: r.governorate })) }
                : { matches: [], message: 'لم يتم العثور على الولاية. اسأل العميل عن اسم الولاية والمحافظة بشكل أوضح، أو تابع بدون ولاية.' };
        }
        case 'get_price_range':
            return doors.priceRange(db, { ...sizeArgs(input), shutterTypeId: input.shutter_type_id, regionId: input.region_id });
        case 'compare_options':
            return doors.compareOptions(db, { ...sizeArgs(input), shutterTypeId: input.shutter_type_id });
        case 'calculate_final_price':
            return summarizePrice(doors.finalPrice(db, choiceArgs(input)));
        case 'create_quote': {
            const priced = doors.finalPrice(db, choiceArgs(input));
            const quote = ctx.createQuote({
                customer_name: input.customer_name,
                customer_phone: ctx.phone,
                customer_city: priced.door.region ? `${priced.door.region}، ${priced.door.governorate}` : null,
                notes: input.notes,
                source: ctx.channel,
                priced,
                details: { ...priced.door, spec: priced.spec, fees_note: priced.delivery_installation }
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
        choices: r.spec.map(([label, value]) => `${label}: ${value}`),
        lines: r.items.map((i) => ({ item: `${i.name}${i.type ? ' — ' + i.type : ''}`, quantity: i.quantity, unit: i.unit, total: i.line_total })),
        subtotal: r.subtotal,
        vat_percent: r.vat_percent,
        vat: r.vat,
        total_with_vat: r.total,
        installation: r.delivery_installation
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
