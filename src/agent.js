/* =============================================================
   AI sales agent for roller-shutter doors (Claude API + tool use)
   The model runs the conversation; every price comes from the tools
   below, which use the same pricing code as the rest of the system.
   ============================================================= */
const Anthropic = require('@anthropic-ai/sdk');
const { getSettings } = require('./db');
const doors = require('./doors');
const overhead = require('./overhead');
const knowledge = require('./knowledge');

/* Which AI runs the agent: AI_PROVIDER=openai|anthropic, or whichever API key is set */
const hasAnthropicKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const provider = () => {
    const p = String(process.env.AI_PROVIDER || '').toLowerCase();
    if (p === 'openai' || p === 'anthropic') return p;
    return process.env.OPENAI_API_KEY && !hasAnthropicKey() ? 'openai' : 'anthropic';
};
const MODEL = () => process.env.AGENT_MODEL || 'claude-opus-5';
const OPENAI_MODEL = () => process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const modelName = () => (provider() === 'openai' ? OPENAI_MODEL() : MODEL());
const EFFORT = () => process.env.AGENT_EFFORT || 'medium';
const MAX_TOOL_ROUNDS = 8;
const CONVERSATION_TTL_HOURS = 24;
const MAX_STORED_MESSAGES = 80;

const isConfigured = () => (provider() === 'openai' ? Boolean(process.env.OPENAI_API_KEY) : hasAnthropicKey());

/* What the agent may tell customers about the company: contact details + the admin's free text */
function companyInfo(settings) {
    const lines = [];
    if (settings.company_phone) lines.push(`- رقم خدمة العملاء: ${settings.company_phone}`);
    if (settings.company_address) lines.push(`- العنوان: ${settings.company_address}`);
    if (settings.company_website) lines.push(`- الموقع الإلكتروني: ${settings.company_website}`);
    const extra = String(settings.agent_knowledge || '').trim();
    if (extra) lines.push(extra.slice(0, 6000));
    return lines.length ? lines.join('\n') : '(لا توجد معلومات إضافية — حوّل الأسئلة العامة إلى فريق المبيعات)';
}

/* The admin's guidelines and the knowledge base (both edited in the admin panel) */
function adminSections(settings, db) {
    const parts = [];
    const guide = String(settings.agent_instructions || '').trim();
    if (guide) {
        parts.push('توجيهات الإدارة (اتبعها، إلا إذا تعارضت مع قواعد الأسعار والأدوات أعلاه فالقواعد أولى):\n' + guide.slice(0, 6000));
    }
    const kb = db ? knowledge.promptSection(db) : '';
    if (kb) parts.push(kb);
    return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

function systemPrompt(settings, db = null) {
    return `أنت مساعد المبيعات في ${settings.company_name} في سلطنة عُمان، وتتحدث مع العملاء عبر واتساب.
الشركة تركّب نوعين من البوابات:
- بوابات الرول شتر (الأبواب الألمنيوم الملفوفة) بأنواع مختلفة، مع إكسسوارات بفئات مختلفة.
- بوابات الأوفرهيد (السكشنال) تُباع طقماً كاملاً بمقاسات قياسية.
إذا لم يحدد العميل النوع فاسأله: رول شتر أم أوفرهيد؟ ويمكنه السؤال عن النوعين في نفس المحادثة.

مسار المحادثة لطلب بوابة رول شتر:
1. رحّب باختصار وتأكد أن العميل يريد بوابة رول شتر.
2. اسأل عن مقاس الفتحة بالسنتيمتر: العرض والارتفاع، وعدد البوابات إن كان أكثر من واحدة.
3. استخدم list_door_options واسأل العميل عن نوع البوابة (مثل الإيراني أو التركي أو العماني)، واسأله عن الولاية. استخدم find_region لتحديد الولاية؛ إذا ظهرت أكثر من نتيجة فاسأله عن المحافظة.
4. استخدم get_price_range وأعطِ العميل نطاق السعر "من ... إلى ..." ريال عماني شاملاً الضريبة، ووضّح حالة رسوم التركيب كما تعيدها الأداة.
5. اسأل العميل: "هل تريد أن أوضح لك الفروقات في الأسعار؟"
6. إن وافق، استخدم compare_options واشرح: السماكات/الدرجات المتاحة لهذا النوع (إن وُجد أكثر من واحدة) والألوان المتوفرة مع كل سماكة وسعر الشرائح لكل لون (بعض الألوان لها سعر ورسوم صبغ مختلفة)، ثم الإكسسوارات واحدة تلو الأخرى (المسارات الجانبية، عمود محور الدوران، القواعد، المحرك...) مع فئاتها Class A / B / C وتفاصيل كل فئة وسعرها لهذا المقاس. لا تُغرق العميل بكل شيء في رسالة واحدة إن كانت طويلة.
7. بعد أن يختار العميل السماكة واللون وفئة كل إكسسوار، استخدم calculate_final_price وأعطه السعر النهائي مع تفصيل مختصر.
8. اعرض عليه عرض سعر رسمي بصيغة PDF. إن وافق، اسأله عن اسمه ثم استخدم create_quote. سيُرسل الملف له تلقائياً بعد رسالتك.

مسار المحادثة لطلب بوابة أوفرهيد:
1. اسأل عن مقاس الفتحة بالسنتيمتر (العرض والارتفاع) وعن الولاية (استخدم find_region).
2. استخدم list_overhead_options: لكل نوع (Type A / Type B) مقاسات قياسية (عرض × ارتفاع 250 أو 300 سم) ومحركات.
   اختر للعميل المقاس القياسي الأقرب والأكبر من مقاسه الفعلي لكل نوع، ووضّح له المقاس المختار. إذا كانت فتحته أكبر من كل المقاسات فاستخدم request_human.
3. اسأله عن المحرك (أو اعرض الخيارات وأسعارها)، ثم استخدم calculate_overhead_price وأعطه السعر من ... إلى ... شامل الضريبة والتركيب، ووضّح أن الفرق حسب اللون. يمكنك مقارنة Type A و Type B إن طلب.
4. اعرض عليه عرض سعر رسمي. إن وافق، اسأله عن اسمه ثم استخدم create_overhead_quote.

قواعد مهمة:
- لا تذكر أي سعر إلا إذا جاء من إحدى الأدوات. لا تقدّر ولا تخمّن الأسعار أبداً.
- إذا أعطى العميل المقاس بالمتر أو بالملم فحوّله إلى سنتيمتر، وتأكد منه إذا كان غير منطقي.
- إذا لم يحدد العميل فئة إكسسوار بعد شرحها، فاسأله أو اقترح عليه، ولا تختر عنه بصمت.
- اسأل سؤالاً أو سؤالين في كل رسالة، ولا تكرر أسئلة أجاب عنها العميل.
- اكتب بالعربية بأسلوب ودود ومختصر يناسب واتساب. استخدم *نص* للتغميق، ولا تستخدم الجداول أو عناوين Markdown.
- الأسعار بالريال العماني (ر.ع) بخانتين عشريتين.
- لا تكشف تكاليف الشراء أو نسب الربح أو تفاصيل النظام الداخلية.
- أجب عن الأسئلة العامة (أوقات العمل، الموقع، الضمان، طرق الدفع، مدة التوريد والتركيب، الخدمات...) من قسمي «معلومات الشركة» و«قاعدة المعرفة» أدناه فقط (وإن وُجدت الأداة search_knowledge فابحث بها). إذا لم تجد الإجابة فيه فلا تخترعها: قل إنك ستتأكد من فريق المبيعات واستخدم request_human.
- إذا طلب العميل التحدث مع موظف، أو طلب شيئاً خارج نطاق الأدوات ومعلومات الشركة (خصم، موعد معاينة، شكوى، منتج غير موجود)، استخدم request_human وأخبره أن فريق المبيعات سيتواصل معه.
- إذا كتب العميل بالإنجليزية فرد بالإنجليزية.
- في محادثات الموقع الإلكتروني لا نعرف رقم جوال العميل: اسأله عن رقم جواله (عُماني، 8 أرقام) قبل إنشاء عرض السعر وضعه في customer_phone. في واتساب اترك customer_phone فارغاً (null).

معلومات الشركة (مصدر إجاباتك عن الأسئلة العامة):
${companyInfo(settings)}${adminSections(settings, db)}`;
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
                customer_phone: { type: ['string', 'null'], description: 'رقم جوال العميل — مطلوب في محادثات الموقع، و null في واتساب' },
                notes: { type: ['string', 'null'], description: 'ملاحظات العميل إن وجدت' }
            },
            required: ['width_cm', 'height_cm', 'door_count', ...Object.keys(choiceProps), 'customer_name', 'customer_phone', 'notes'],
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

const overheadChoiceProps = {
    gate_type: { type: 'string', description: 'نوع بوابة الأوفرهيد كما في list_overhead_options، مثل Type A' },
    width_cm: { type: 'number', description: 'العرض القياسي المختار بالسنتيمتر (من list_overhead_options)' },
    height_cm: { type: 'number', description: 'الارتفاع القياسي المختار بالسنتيمتر (250 أو 300)' },
    motor_id: { type: 'integer', description: 'رقم المحرك من list_overhead_options' },
    region_id: { type: 'integer', description: 'رقم الولاية من find_region' }
};

TOOLS.splice(TOOLS.length - 1, 0,
    {
        name: 'search_knowledge',
        description: 'يبحث في قاعدة معرفة الشركة (الأسئلة الشائعة والمعلومات والمستندات) عن إجابة سؤال عام مثل أوقات العمل أو الضمان أو طرق الدفع.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'كلمات السؤال' } },
            required: ['query'],
            additionalProperties: false
        }
    },
    {
        name: 'list_overhead_options',
        description: 'يعرض بوابات الأوفرهيد: الأنواع (Type A / Type B) ومقاساتها القياسية (العرض لكل ارتفاع) والمحركات وأسعارها.',
        strict: true,
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
        name: 'calculate_overhead_price',
        description: 'يحسب سعر بوابة أوفرهيد لمقاس قياسي ومحرك وولاية: نطاق من - إلى (حسب اللون) شامل الطقم والمحرك والتركيب والضريبة.',
        strict: true,
        input_schema: { type: 'object', properties: overheadChoiceProps, required: Object.keys(overheadChoiceProps), additionalProperties: false }
    },
    {
        name: 'create_overhead_quote',
        description: 'يسجّل عرض سعر بوابة الأوفرهيد في النظام ويجهز ملف PDF يُرسل للعميل. استخدمه فقط بعد موافقة العميل ومعرفة اسمه.',
        strict: true,
        input_schema: {
            type: 'object',
            properties: {
                ...overheadChoiceProps, customer_name: { type: 'string' },
                customer_phone: { type: ['string', 'null'], description: 'رقم جوال العميل — مطلوب في محادثات الموقع، و null في واتساب' },
                notes: { type: ['string', 'null'], description: 'ملاحظات العميل إن وجدت' }
            },
            required: [...Object.keys(overheadChoiceProps), 'customer_name', 'customer_phone', 'notes'],
            additionalProperties: false
        }
    }
);

const overheadArgs = (i) => ({ gateType: i.gate_type, widthCm: i.width_cm, heightCm: i.height_cm, motorId: i.motor_id, regionId: i.region_id });

function summarizeOverhead(p) {
    return {
        choices: p.spec.map(([label, value]) => `${label}: ${value}`),
        lines: p.items.map((i) => ({ item: `${i.name}${i.type ? ' — ' + i.type : ''}`, from: i.line_total, to: i.line_total_to ?? i.line_total })),
        total_with_vat_from: p.total,
        total_with_vat_to: p.range.total_to,
        vat_percent: p.vat_percent,
        note: p.delivery_installation
    };
}

/* WhatsApp knows the customer's number; on the website the agent must ask for it */
function customerPhone(ctx, input) {
    if (ctx.phone) return ctx.phone;
    let digits = String(input.customer_phone || '').replace(/\D/g, '').replace(/^00/, '');
    if (/^[79]\d{7}$/.test(digits)) digits = '968' + digits;
    if (!/^968[79]\d{7}$/.test(digits)) throw new Error('رقم جوال العميل مطلوب (رقم عُماني من 8 أرقام) — اسأل العميل عنه ثم أعد المحاولة');
    return digits;
}

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
                customer_phone: customerPhone(ctx, input),
                customer_city: priced.door.region ? `${priced.door.region}، ${priced.door.governorate}` : null,
                notes: input.notes,
                source: ctx.channel,
                priced,
                details: { ...priced.door, spec: priced.spec, fees_note: priced.delivery_installation }
            });
            ctx.events.push({ type: 'quote_created', quote });
            return { ref: quote.ref, total: quote.total, pdf: 'سيتم إرسال ملف PDF للعميل تلقائياً بعد رسالتك' };
        }
        case 'search_knowledge': {
            const results = knowledge.search(db, input.query);
            return results.length ? { results } : { results: [], message: 'لا توجد إجابة في قاعدة المعرفة — لا تخترع إجابة، وحوّل السؤال لفريق المبيعات إن لزم.' };
        }
        case 'list_overhead_options': {
            const { sizes, motors } = overhead.loadOverhead(db);
            return {
                gate_types: overhead.gateTypes(sizes).map((t) => ({
                    gate_type: t.name,
                    sizes: t.heights.map((h) => ({ height_cm: h.height_cm, widths_cm: h.widths }))
                })),
                motors: motors.map((m) => ({ motor_id: m.id, name: m.name, price: m.price })),
                note: 'اختر المقاس القياسي الأقرب والأكبر من مقاس الفتحة. الأسعار تشمل الطقم كاملاً.'
            };
        }
        case 'calculate_overhead_price':
            return summarizeOverhead(overhead.overheadPrice(db, overheadArgs(input)));
        case 'create_overhead_quote': {
            const priced = overhead.overheadPrice(db, overheadArgs(input));
            const quote = ctx.createQuote({
                customer_name: input.customer_name,
                customer_phone: customerPhone(ctx, input),
                customer_city: `${priced.region.name}، ${priced.region.governorate}`,
                notes: input.notes,
                source: ctx.channel,
                priced,
                details: {
                    calculator: 'overhead', ...priced.gate, governorate: priced.region.governorate,
                    spec: priced.spec, fees_note: priced.delivery_installation, range: priced.range
                }
            });
            ctx.events.push({ type: 'quote_created', quote });
            return { ref: quote.ref, total_from: quote.total, total_to: priced.range.total_to, pdf: 'سيتم إرسال رابط ملف PDF للعميل تلقائياً بعد رسالتك' };
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

/* Each AI keeps its own history format, so the stored conversation is per provider */
const storeKey = (key) => (provider() === 'openai' ? 'oa:' + key : key);

function resetConversation(db, key) {
    db.prepare('DELETE FROM agent_conversations WHERE conversation_key IN (?, ?)').run(key, 'oa:' + key);
}

/* ------------------------------ Agent loop ----------------------------- */

let sharedClient = null;
const defaultClient = () => (sharedClient ||= new Anthropic());

/**
 * Handle one customer message and return the agent's reply.
 * @param opts { db, key, channel, phone, text, createQuote, notifyHuman, client? }
 */
/* Last failure of the AI provider, shown in the admin panel (keys masked) */
let lastError = null;
const getLastError = () => lastError;
const maskSecrets = (msg) => String(msg || '').replace(/(sk|key|token)[-_A-Za-z0-9]{8,}/gi, '$1-****').slice(0, 400);

async function chat(opts) {
    try {
        return await runChat(opts);
    } catch (err) {
        lastError = { at: new Date().toISOString(), channel: opts.channel, provider: provider(), model: modelName(), message: maskSecrets(err.message) };
        console.error('[agent]', opts.channel, lastError.message);
        throw err;
    }
}

async function runChat({ db, key, channel, phone, text, createQuote, notifyHuman, client }) {
    if (/^\s*(جديد|ابدأ من جديد|reset|restart)\s*$/i.test(text)) {
        resetConversation(db, key);
        return { reply: 'تم بدء محادثة جديدة 👋 كيف أقدر أساعدك؟', events: [] };
    }
    const args = { db, key: storeKey(key), channel, phone, text, createQuote, notifyHuman };
    return provider() === 'openai'
        ? chatOpenAI({ ...args, client: client || defaultOpenAIClient() })
        : chatAnthropic({ ...args, client: client || defaultClient() });
}

async function chatAnthropic({ db, key, channel, phone, text, createQuote, notifyHuman, client }) {
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
            system: systemPrompt(settings, db),
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

/* ------------------------- OpenAI (Chat Completions) ------------------------- */

/* Minimal client with the same shape as the official SDK: client.chat.completions.create(params) */
function defaultOpenAIClient() {
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    return {
        chat: {
            completions: {
                create: async (params) => {
                    const res = await fetch(base + '/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
                        body: JSON.stringify(params),
                        signal: AbortSignal.timeout(90_000)
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(data.error && data.error.message) || 'request failed'}`);
                    return data;
                }
            }
        }
    };
}

const OPENAI_TOOLS = TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema, strict: true }
}));

async function chatOpenAI({ db, key, channel, phone, text, createQuote, notifyHuman, client }) {
    const settings = getSettings(db);
    const messages = loadConversation(db, key);
    const startLength = messages.length;
    messages.push({ role: 'user', content: text });
    const ctx = { db, phone, channel, createQuote, notifyHuman, events: [] };

    let reply = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await client.chat.completions.create({
            model: OPENAI_MODEL(),
            messages: [{ role: 'system', content: systemPrompt(settings, db) }, ...messages],
            tools: OPENAI_TOOLS,
            tool_choice: 'auto'
        });
        const choice = (response.choices || [])[0] || {};
        const msg = choice.message || {};
        if (msg.refusal) {
            messages.length = startLength;
            reply = 'عذراً، لا أستطيع المساعدة في هذا الطلب. سيتواصل معك أحد موظفينا قريباً.';
            break;
        }
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        messages.push({ role: 'assistant', content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
        reply = String(msg.content || '').trim();
        if (!calls.length) break;

        for (const call of calls) {
            let content;
            try {
                const input = JSON.parse((call.function && call.function.arguments) || '{}');
                content = JSON.stringify(await executeTool(call.function.name, input, ctx));
            } catch (err) {
                content = JSON.stringify({ error: err.message });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
    }

    // Never store a turn that ends with unanswered tool results
    if (messages.length && messages[messages.length - 1].role === 'tool') {
        messages.length = startLength;
        reply = reply || 'عذراً، حدث خطأ. سيتواصل معك فريقنا قريباً.';
    }
    saveConversation(db, key, channel, messages);
    return { reply: reply || '…', events: ctx.events };
}

module.exports = { chat, executeTool, TOOLS, OPENAI_TOOLS, isConfigured, resetConversation, systemPrompt, provider, modelName, getLastError };
