document.documentElement.classList.add('dark');

// Older browsers get a brief fade with normal document navigation.
(() => {
    const nativeTransitions = 'onpagereveal' in window && 'onpageswap' in window;
    if (nativeTransitions) return;
    document.documentElement.classList.add('page-fade-fallback');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let leaving = false, outgoing = null;

    document.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || reducedMotion.matches) return;
        const link = event.target.closest?.('.header-line a[href]');
        if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
        const destination = new URL(link.href, location.href);
        if (destination.origin !== location.origin || destination.pathname === location.pathname) return;
        if (!destination.pathname.endsWith('.html') && !destination.pathname.endsWith('/')) return;
        if (!document.body.animate) return;
        event.preventDefault();
        if (leaving) return;
        leaving = true;
        outgoing = document.body.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 140, easing: 'ease-out', fill: 'forwards'
        });
        outgoing.finished.then(() => location.assign(destination.href), () => { leaving = false; });
    });

    // A cached page must not return with its outgoing fade still applied.
    window.addEventListener('pageshow', event => {
        leaving = false;
        outgoing?.cancel();
        outgoing = null;
        if (event.persisted && !reducedMotion.matches && document.body.animate) {
            document.body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
        }
    });
})();

// Essays show their read time and length, worked out from the text itself.
document.addEventListener('DOMContentLoaded', () => {
    const meta = document.querySelector('.post-meta');
    const content = document.querySelector('.post-content');
    if (!meta || !content) return;
    const words = (content.textContent.match(/\S+/g) || []).length;
    const minutes = Math.max(1, Math.round(words / 230));
    const span = text => Object.assign(document.createElement('span'), { textContent: text });
    const readTime = [...meta.children].find(el => /min read/i.test(el.textContent));
    if (readTime) readTime.textContent = `${minutes} min read`;
    else meta.append(span('·'), span(`${minutes} min read`));
    meta.append(span('·'), span(`${words.toLocaleString('en-US')} words`));
});
