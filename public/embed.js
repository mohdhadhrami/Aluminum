/*
 * Embed a customer calculator in another website (e.g. radma.co).
 *
 *   <div data-radma-calculator></div>            ← rolling shutter
 *   <div data-radma-calculator="overhead"></div> ← overhead gates
 *   <script src="https://calcshutter.radma.co/embed.js" async></script>
 *
 * The iframe grows to the calculator's height automatically. The host site must be
 * listed in EMBED_ALLOWED_ORIGINS on the calculator server (radma.co is by default).
 */
(function () {
    var script = document.currentScript;
    var base = new URL(script.src).origin;
    var frames = [];

    function mount(target) {
        if (target.getAttribute('data-radma-mounted')) return;
        target.setAttribute('data-radma-mounted', '1');
        var iframe = document.createElement('iframe');
        var overhead = target.getAttribute('data-radma-calculator') === 'overhead';
        iframe.src = base + (overhead ? '/overhead' : '/') + '?embed=1';
        iframe.title = overhead ? 'حاسبة أسعار بوابات الأوفرهيد' : 'حاسبة أسعار بوابات الرولينج شتر';
        iframe.loading = 'lazy';
        iframe.setAttribute('scrolling', 'no');
        iframe.style.cssText = 'width:100%;border:0;display:block;min-height:900px;overflow:hidden;background:transparent';
        target.appendChild(iframe);
        frames.push(iframe);
    }

    var targets = document.querySelectorAll('[data-radma-calculator]');
    if (!targets.length) {
        var div = document.createElement('div');
        div.setAttribute('data-radma-calculator', '');
        script.parentNode.insertBefore(div, script);
        targets = [div];
    }
    Array.prototype.forEach.call(targets, mount);

    window.addEventListener('message', function (e) {
        if (e.origin !== base || !e.data || e.data.source !== 'radma-calculator') return;
        var iframe = frames.filter(function (f) { return f.contentWindow === e.source; })[0];
        if (!iframe) return;
        if (e.data.type === 'height' && e.data.height > 0) {
            iframe.style.minHeight = '0';
            iframe.style.height = Math.ceil(e.data.height) + 'px';
        } else if (e.data.type === 'scroll') {
            var top = iframe.getBoundingClientRect().top + window.pageYOffset + (Number(e.data.top) || 0) - 80;
            window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        }
    });
})();
