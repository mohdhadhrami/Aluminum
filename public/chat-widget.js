/*
 * AI assistant chat bubble for the company website (e.g. radma.co).
 *
 *   <script src="https://calcshutter.radma.co/chat-widget.js" async></script>
 *
 * Options (attributes on the script tag, all optional):
 *   data-position="left" | "right"   side of the screen (default: left)
 *   data-label="اسألني عن السعر"      text of the small hint next to the icon ("" to hide)
 *   data-color="#1e40af"              icon color
 *
 * The chat window is a page of the pricing system (/chat) in an iframe, so prices,
 * quotes and PDFs come from the system itself. The host site must be listed in
 * EMBED_ALLOWED_ORIGINS on the server (radma.co is by default).
 */
(function () {
    var script = document.currentScript;
    if (!script || window.__radmaChatLoaded) return;
    window.__radmaChatLoaded = true;
    var base = new URL(script.src).origin;
    var side = script.getAttribute('data-position') === 'right' ? 'right' : 'left';
    var color = script.getAttribute('data-color') || '#1e40af';
    var label = script.getAttribute('data-label');
    if (label === null) label = 'اسألني عن سعر بوابتك';

    function build(conf) {
        if (!conf || !conf.enabled) return; // switched off in the admin panel: show nothing

        var css = document.createElement('style');
        css.textContent =
            '.radma-chat-btn{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000;width:62px;height:62px;border-radius:50%;' +
            'border:0;cursor:pointer;background:' + color + ';color:#fff;box-shadow:0 10px 28px -8px rgba(15,23,42,.55);' +
            'display:flex;align-items:center;justify-content:center;transition:transform .2s ease}' +
            '.radma-chat-btn:hover{transform:scale(1.07)}' +
            '.radma-chat-btn:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}' +
            '.radma-chat-btn .radma-dot{position:absolute;top:4px;' + (side === 'left' ? 'right' : 'left') + ':4px;width:13px;height:13px;border-radius:50%;background:#4ade80;border:2px solid #fff}' +
            '.radma-chat-hint{position:fixed;bottom:34px;' + side + ':92px;z-index:2147483000;background:#fff;color:#1e293b;' +
            'font:700 14px Tajawal,system-ui,sans-serif;padding:9px 14px;border-radius:14px;box-shadow:0 8px 24px -8px rgba(15,23,42,.35);' +
            'direction:rtl;cursor:pointer;white-space:nowrap}' +
            '.radma-chat-frame{position:fixed;bottom:94px;' + side + ':20px;z-index:2147483001;width:380px;height:600px;' +
            'max-height:calc(100vh - 120px);border:0;border-radius:18px;background:#fff;box-shadow:0 24px 60px -12px rgba(15,23,42,.45);display:none}' +
            '.radma-chat-open .radma-chat-frame{display:block}' +
            '.radma-chat-open .radma-chat-hint{display:none}' +
            '@media (max-width:480px){.radma-chat-frame{inset:0;width:100%;height:100%;max-height:none;border-radius:0}' +
            '.radma-chat-open .radma-chat-btn{display:none}}';
        document.head.appendChild(css);

        var root = document.createElement('div');
        root.className = 'radma-chat';
        root.innerHTML =
            '<iframe class="radma-chat-frame" title="المساعد الذكي" allow="clipboard-write"></iframe>' +
            (label ? '<div class="radma-chat-hint" role="button" tabindex="0"></div>' : '') +
            '<button type="button" class="radma-chat-btn" aria-label="المساعد الذكي" aria-expanded="false">' +
            '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><circle cx="9" cy="12" r=".6" fill="currentColor"/>' +
            '<circle cx="12.5" cy="12" r=".6" fill="currentColor"/><circle cx="16" cy="12" r=".6" fill="currentColor"/></svg>' +
            '<span class="radma-dot"></span></button>';
        document.body.appendChild(root);

        var frame = root.querySelector('iframe');
        var btn = root.querySelector('.radma-chat-btn');
        var hint = root.querySelector('.radma-chat-hint');
        if (hint) hint.textContent = label;

        function toggle(open) {
            if (open && !frame.src) frame.src = base + '/chat'; // load the chat only when first opened
            root.classList.toggle('radma-chat-open', open);
            btn.setAttribute('aria-expanded', String(open));
            if (open) frame.focus();
        }
        btn.addEventListener('click', function () { toggle(!root.classList.contains('radma-chat-open')); });
        if (hint) {
            hint.addEventListener('click', function () { toggle(true); });
            hint.addEventListener('keydown', function (e) { if (e.key === 'Enter') toggle(true); });
        }
        window.addEventListener('message', function (e) {
            if (e.origin === base && e.data && e.data.source === 'radma-chat' && e.data.type === 'close') toggle(false);
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggle(false); });
    }

    function start() {
        fetch(base + '/api/public/chat/config')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(build)
            .catch(function () { /* system unreachable: show nothing */ });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
