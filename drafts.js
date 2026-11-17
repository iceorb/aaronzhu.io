// Private, local-only essay drafts.
// Type "edit" anywhere on an essay (or open it with #edit) to start writing.
// Drafts live in this browser's localStorage and are never published.
(() => {
    const FIELDS = ['.post-title', '.post-subtitle', '.post-content'];
    const PREFIX = 'az:draft:';
    const UNLOCK = 'az:drafts-unlocked';
    const path = location.pathname.split('/').pop() || 'index.html';
    const key = PREFIX + path;

    const fields = FIELDS.map(sel => document.querySelector(sel)).filter(Boolean);
    if (!document.querySelector('.post-content')) return;

    const store = {
        get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
        del(k) { try { localStorage.removeItem(k); } catch { } },
        keys() {
            try { return Object.keys(localStorage).filter(k => k.startsWith(PREFIX)); } catch { return []; }
        },
    };

    const original = fields.map(el => el.innerHTML);
    const hash = s => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
        return (h >>> 0).toString(36);
    };
    const normalize = html => html.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    const base = hash(original.map(normalize).join('|'));
    // innerHTML without the editor's own change markers.
    const clean = el => el.innerHTML.replace(/\s?azd-changed/g, '').replace(/ class=""/g, '');

    let editing = false;
    let ui = null;
    let saveTimer = null;
    let showChanges = true;

    // ---------- unlock: type "edit", or arrive with #edit ----------
    let typed = '';
    document.addEventListener('keydown', e => {
        if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
        typed = (typed + e.key.toLowerCase()).slice(-4);
        if (typed === 'edit') { typed = ''; open(); }
    });
    if (location.hash === '#edit') {
        history.replaceState(null, '', location.pathname + location.search);
        addEventListener('DOMContentLoaded', open);
        if (document.readyState !== 'loading') open();
    }

    // Only the owner's browser (unlocked once) ever sees the draft notice.
    const unlocked = () => { try { return localStorage.getItem(UNLOCK) === '1'; } catch { return false; } };
    if (unlocked() && store.get(key)) {
        if (document.readyState === 'loading') addEventListener('DOMContentLoaded', showNotice);
        else showNotice();
    }

    // ---------- editing ----------
    function open() {
        if (editing) return;
        editing = true;
        try { localStorage.setItem(UNLOCK, '1'); } catch { }
        injectStyles();
        document.getElementById('azd-notice')?.remove();

        const draft = store.get(key);
        if (draft?.fields) fields.forEach((el, i) => { if (draft.fields[i] != null) el.innerHTML = draft.fields[i]; });

        document.execCommand('defaultParagraphSeparator', false, 'p');
        fields.forEach(el => {
            el.contentEditable = 'true';
            el.spellcheck = true;
            el.addEventListener('input', onInput);
            el.addEventListener('paste', onPaste);
        });
        document.documentElement.classList.add('azd-editing');
        buildUI();
        refresh();
        if (draft && draft.base !== base) {
            toast('The published essay changed since this draft began');
        }
        const content = document.querySelector('.post-content');
        if (!draft) placeCaretAtEnd(content.querySelector('p') || content);
    }

    function close() {
        if (!editing) return;
        flushSave();
        editing = false;
        fields.forEach((el, i) => {
            el.removeAttribute('contenteditable');
            el.removeEventListener('input', onInput);
            el.removeEventListener('paste', onPaste);
            el.innerHTML = original[i];
        });
        document.querySelectorAll('.azd-changed').forEach(n => n.classList.remove('azd-changed'));
        document.documentElement.classList.remove('azd-editing');
        ui?.root.remove();
        ui = null;
        if (store.get(key)) showNotice();
    }

    function onInput() {
        setStatus('editing');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 450);
        refresh();
    }

    function onPaste(e) {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        if (!text) return;
        const paras = text.replace(/\r/g, '').split(/\n\s*\n/);
        if (paras.length < 2) {
            document.execCommand('insertText', false, text);
        } else {
            const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            document.execCommand('insertHTML', false, paras.map(p => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join(''));
        }
    }

    function flushSave() {
        if (saveTimer) { clearTimeout(saveTimer); save(); }
    }

    function save() {
        saveTimer = null;
        const current = fields.map(clean);
        const unchanged = current.every((h, i) => normalize(h) === normalize(original[i]));
        if (unchanged) {
            store.del(key);
            setStatus('clean');
            return;
        }
        const prev = store.get(key);
        const ok = store.set(key, {
            path,
            title: textOf(fields[0]) || document.title,
            fields: current,
            base: prev?.base ?? base,
            created: prev?.created ?? Date.now(),
            saved: Date.now(),
        });
        setStatus(ok ? 'saved' : 'error');
    }

    // ---------- changes, counts ----------
    function blocks(root) {
        return [...root.children].flatMap(el =>
            ['OL', 'UL'].includes(el.tagName) ? [...el.children] : [el]);
    }
    const originalBlocks = (() => {
        const tmp = document.createElement('div');
        tmp.innerHTML = original[fields.findIndex(f => f.matches('.post-content'))];
        return new Set(blocks(tmp).map(b => normalize(b.outerHTML)));
    })();
    const words = s => (s.match(/\S+/g) || []).length;
    const originalWords = (() => {
        const tmp = document.createElement('div');
        tmp.innerHTML = original.join(' ');
        return words(tmp.textContent);
    })();

    function refresh() {
        if (!ui) return;
        const content = document.querySelector('.post-content');
        let changed = 0;
        blocks(content).forEach(b => {
            b.classList.remove('azd-changed');
            const isNew = !originalBlocks.has(normalize(b.outerHTML).replace(/ class=""/g, ''));
            if (isNew) changed++;
            b.classList.toggle('azd-changed', isNew && showChanges);
        });
        fields.forEach((el, i) => {
            if (el === content) return;
            const diff = normalize(clean(el)) !== normalize(original[i]);
            if (diff) changed++;
            el.classList.toggle('azd-changed', diff && showChanges);
        });
        const n = words(fields.map(f => f.textContent).join(' '));
        const delta = n - originalWords;
        ui.words.textContent = `${n.toLocaleString()} words`;
        ui.delta.textContent = delta ? (delta > 0 ? `+${delta}` : `−${-delta}`) : '';
        ui.changes.textContent = changed ? `${changed} changed` : 'No changes';
        ui.changes.disabled = !changed;
        ui.changes.setAttribute('aria-pressed', String(showChanges && !!changed));
        ui.revert.disabled = !changed && !store.get(key);
    }

    // ---------- markdown ----------
    function inline(node) {
        let out = '';
        node.childNodes.forEach(n => {
            if (n.nodeType === 3) { out += n.textContent.replace(/\s+/g, ' '); return; }
            if (n.nodeType !== 1) return;
            const t = n.tagName, inner = inline(n);
            if (t === 'EM' || t === 'I') out += wrap(inner, '*');
            else if (t === 'STRONG' || t === 'B') out += wrap(inner, '**');
            else if (t === 'CODE') out += '`' + n.textContent + '`';
            else if (t === 'A') out += `[${inner.trim()}](${n.getAttribute('href') || ''})`;
            else if (t === 'BR') out += '  \n';
            else if (t === 'IMG') out += `![${n.alt || ''}](${n.getAttribute('src')})`;
            else out += inner;
        });
        return out;
    }
    const wrap = (s, m) => {
        const t = s.trim();
        if (!t) return s;
        const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
        return lead + m + t + m + trail;
    };
    function toMarkdown(root) {
        const out = [];
        root.childNodes.forEach(n => {
            if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(t.replace(/\s+/g, ' ')); return; }
            if (n.nodeType !== 1) return;
            const t = n.tagName;
            if (/^H[1-6]$/.test(t)) out.push('#'.repeat(+t[1]) + ' ' + inline(n).trim());
            else if (t === 'BLOCKQUOTE') {
                const body = n.querySelector('p') ? toMarkdown(n) : inline(n).trim();
                out.push(body.split('\n').map(l => '> ' + l).join('\n'));
            }
            else if (t === 'UL' || t === 'OL') {
                out.push([...n.children].map((li, i) => {
                    const marker = t === 'OL' ? `${i + 1}. ` : '- ';
                    const body = li.querySelector('p, h1, h2, h3, h4, ul, ol') ? toMarkdown(li) : inline(li).trim();
                    return marker + body.split('\n').join('\n' + ' '.repeat(marker.length));
                }).join('\n'));
            }
            else if (t === 'HR') out.push('---');
            else if (t === 'FIGURE') {
                const img = n.querySelector('img'), cap = n.querySelector('figcaption');
                if (img) out.push(`![${img.alt || ''}](${img.getAttribute('src')})`);
                if (cap) out.push('*' + inline(cap).trim() + '*');
            }
            else if (t === 'IMG') out.push(`![${n.alt || ''}](${n.getAttribute('src')})`);
            else if (t === 'DIV' && n.querySelector('p, h1, h2, h3, ul, ol, blockquote, figure')) out.push(toMarkdown(n));
            else { const s = inline(n).trim(); if (s) out.push(s); }
        });
        return out.join('\n\n');
    }

    function exportText(kind) {
        const title = textOf(document.querySelector('.post-title'));
        const sub = document.querySelector('.post-subtitle');
        const content = document.querySelector('.post-content').cloneNode(true);
        content.querySelectorAll('.azd-changed').forEach(n => n.classList.remove('azd-changed'));
        const when = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        const head = `<!-- Local draft of ${path} · ${when} -->`;
        if (kind === 'html') {
            return [head,
                `<h1 class="post-title">${clean(document.querySelector('.post-title'))}</h1>`,
                sub ? `<h2 class="post-subtitle">${clean(sub)}</h2>` : '',
                `<div class="post-content">\n${clean(content).trim()}\n</div>`].filter(Boolean).join('\n\n');
        }
        return [head, '# ' + title, sub ? '*' + textOf(sub) + '*' : '', toMarkdown(content)].filter(Boolean).join('\n\n') + '\n';
    }

    async function copy(kind) {
        flushSave();
        const text = exportText(kind);
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            const ta = Object.assign(document.createElement('textarea'), { value: text });
            document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        toast(kind === 'html' ? 'HTML copied' : 'Markdown copied — paste it to Claude');
        closeMenu();
    }

    // ---------- UI ----------
    function buildUI() {
        const root = document.createElement('div');
        root.id = 'azd';
        root.innerHTML = `
            <div class="azd-stamp" aria-hidden="true">Local draft<span>not published</span></div>
            <div class="azd-bubble" role="toolbar" aria-label="Formatting" hidden>
                <button data-cmd="bold" title="Bold (⌘B)"><b>B</b></button>
                <button data-cmd="italic" title="Italic (⌘I)"><i>I</i></button>
                <button data-cmd="link" title="Link">↗</button>
                <span class="azd-rule"></span>
                <button data-cmd="h2" title="Heading">H</button>
                <button data-cmd="quote" title="Quote">“</button>
                <button data-cmd="clear" title="Plain text">¶</button>
            </div>
            <div class="azd-dock" role="toolbar" aria-label="Draft">
                <span class="azd-status" data-state="clean"><i></i><span class="azd-status-text">Published copy</span></span>
                <span class="azd-sep"></span>
                <span class="azd-count"><span class="azd-words"></span><span class="azd-delta"></span></span>
                <button class="azd-btn azd-changes" aria-pressed="true" title="Mark changed paragraphs"></button>
                <span class="azd-sep"></span>
                <div class="azd-menu-wrap">
                    <button class="azd-btn azd-primary azd-copy" aria-haspopup="menu" aria-expanded="false">Copy</button>
                    <div class="azd-menu" role="menu" hidden>
                        <button role="menuitem" data-copy="md">Markdown<small>best for Claude</small></button>
                        <button role="menuitem" data-copy="html">HTML<small>drop-in for the page</small></button>
                        <div class="azd-menu-others"></div>
                    </div>
                </div>
                <button class="azd-btn azd-revert" title="Discard this draft">Discard</button>
                <button class="azd-btn azd-done" title="Close (Esc)">Done</button>
            </div>
            <div class="azd-toast" role="status" aria-live="polite"></div>`;
        document.body.append(root);
        const $ = s => root.querySelector(s);
        ui = {
            root, bubble: $('.azd-bubble'), status: $('.azd-status'), statusText: $('.azd-status-text'),
            words: $('.azd-words'), delta: $('.azd-delta'), changes: $('.azd-changes'),
            copy: $('.azd-copy'), menu: $('.azd-menu'), others: $('.azd-menu-others'),
            revert: $('.azd-revert'), toast: $('.azd-toast'),
        };

        ui.changes.onclick = () => { showChanges = !showChanges; refresh(); };
        ui.copy.onclick = e => { e.stopPropagation(); ui.menu.hidden ? openMenu() : closeMenu(); };
        ui.menu.addEventListener('click', e => {
            const b = e.target.closest('[data-copy]');
            if (b) copy(b.dataset.copy);
        });
        let confirmTimer;
        ui.revert.onclick = () => {
            if (!ui.revert.classList.contains('azd-confirm')) {
                ui.revert.classList.add('azd-confirm');
                ui.revert.textContent = 'Discard draft?';
                confirmTimer = setTimeout(() => { ui.revert.classList.remove('azd-confirm'); ui.revert.textContent = 'Discard'; }, 3000);
                return;
            }
            clearTimeout(confirmTimer);
            const prev = store.get(key);
            if (prev) store.set(key + ':trash', prev);
            store.del(key);
            fields.forEach((el, i) => { el.innerHTML = original[i]; });
            ui.revert.classList.remove('azd-confirm');
            ui.revert.textContent = 'Discard';
            setStatus('clean');
            refresh();
            toast('Draft discarded', prev ? { label: 'Undo', run: undoDiscard } : null);
        };
        $('.azd-done').onclick = close;
        ui.bubble.addEventListener('mousedown', e => e.preventDefault());
        ui.bubble.addEventListener('click', e => {
            const b = e.target.closest('[data-cmd]');
            if (b) format(b.dataset.cmd);
        });
        setStatus(store.get(key) ? 'saved' : 'clean');
    }

    function undoDiscard() {
        const prev = store.get(key + ':trash');
        if (!prev) return;
        store.set(key, prev);
        store.del(key + ':trash');
        fields.forEach((el, i) => { if (prev.fields[i] != null) el.innerHTML = prev.fields[i]; });
        setStatus('saved');
        refresh();
    }

    function openMenu() {
        const others = store.keys()
            .filter(k => k !== key && !k.endsWith(':trash'))
            .map(k => store.get(k)).filter(d => d?.path);
        ui.others.innerHTML = others.length
            ? `<div class="azd-menu-label">Other drafts</div>` + others.map(d =>
                `<a role="menuitem" href="${encodeURI(d.path)}#edit">${escapeHTML(d.title)}<small>${ago(d.saved)}</small></a>`).join('')
            : '';
        ui.menu.hidden = false;
        ui.copy.setAttribute('aria-expanded', 'true');
        setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
    }
    function closeMenu() {
        if (!ui) return;
        ui.menu.hidden = true;
        ui.copy.setAttribute('aria-expanded', 'false');
    }

    function setStatus(state) {
        if (!ui) return;
        ui.status.dataset.state = state;
        const draft = store.get(key);
        ui.statusText.textContent = {
            clean: 'Published copy',
            editing: 'Editing…',
            saved: draft ? `Saved locally · ${ago(draft.saved)}` : 'Saved locally',
            error: 'Couldn’t save — storage full or blocked',
        }[state];
    }
    setInterval(() => { if (ui?.status.dataset.state === 'saved') setStatus('saved'); }, 30000);

    let toastTimer;
    function toast(msg, action) {
        if (!ui) return;
        ui.toast.textContent = msg;
        if (action) {
            const b = document.createElement('button');
            b.textContent = action.label;
            b.onclick = () => { action.run(); ui.toast.classList.remove('azd-show'); };
            ui.toast.append(b);
        }
        ui.toast.classList.add('azd-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => ui?.toast.classList.remove('azd-show'), action ? 6000 : 2600);
    }

    // ---------- selection formatting ----------
    function format(cmd) {
        const sel = getSelection();
        if (cmd === 'bold' || cmd === 'italic') document.execCommand(cmd);
        else if (cmd === 'link') {
            const existing = sel.anchorNode?.parentElement?.closest('a');
            if (existing) { document.execCommand('unlink'); }
            else {
                const url = prompt('Link to', 'https://');
                if (url && url !== 'https://') document.execCommand('createLink', false, url);
            }
        }
        else if (cmd === 'h2') document.execCommand('formatBlock', false, blockOf(sel)?.tagName === 'H2' ? 'p' : 'h2');
        else if (cmd === 'quote') document.execCommand('formatBlock', false, blockOf(sel)?.closest('blockquote') ? 'p' : 'blockquote');
        else if (cmd === 'clear') { document.execCommand('removeFormat'); document.execCommand('formatBlock', false, 'p'); }
        onInput();
        positionBubble();
    }
    const blockOf = sel => sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)
        ?.closest('p, h1, h2, h3, blockquote, li');

    function positionBubble() {
        if (!ui) return;
        const sel = getSelection();
        const inField = sel.rangeCount && fields.some(f => f.contains(sel.anchorNode));
        if (!inField || sel.isCollapsed) { ui.bubble.hidden = true; return; }
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (!r.width) { ui.bubble.hidden = true; return; }
        ui.bubble.hidden = false;
        const bw = ui.bubble.offsetWidth, bh = ui.bubble.offsetHeight;
        const left = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), innerWidth - bw - 12);
        const top = r.top - bh - 10 < 8 ? r.bottom + 10 : r.top - bh - 10;
        ui.bubble.style.transform = `translate(${left}px, ${top}px)`;
    }
    document.addEventListener('selectionchange', () => editing && requestAnimationFrame(positionBubble));
    addEventListener('scroll', () => editing && positionBubble(), { passive: true });

    document.addEventListener('keydown', e => {
        if (!editing) return;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 's') {
            e.preventDefault();
            clearTimeout(saveTimer); save();
            toast(store.get(key) ? 'Saved to this browser' : 'Nothing changed');
        } else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
            e.preventDefault(); copy('md');
        } else if (mod && e.key.toLowerCase() === 'k') {
            e.preventDefault(); format('link');
        } else if (e.key === 'Escape') {
            if (ui && !ui.menu.hidden) closeMenu();
            else close();
        }
    });
    addEventListener('beforeunload', () => editing && flushSave());
    addEventListener('pagehide', () => editing && flushSave());

    // ---------- notice for an existing draft (owner only) ----------
    function showNotice() {
        if (editing || document.getElementById('azd-notice')) return;
        const draft = store.get(key);
        if (!draft) return;
        injectStyles();
        const b = document.createElement('button');
        b.id = 'azd-notice';
        b.innerHTML = `<i></i>Local draft<span>· ${ago(draft.saved)}</span><em>Open</em>`;
        b.onclick = open;
        document.body.append(b);
    }

    // ---------- helpers ----------
    function textOf(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
    function escapeHTML(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function ago(t) {
        const s = Math.round((Date.now() - t) / 1000);
        if (s < 45) return 'just now';
        const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
        const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
        const d = Math.round(h / 24); if (d < 14) return `${d}d ago`;
        return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    function placeCaretAtEnd(el) {
        el.focus({ preventScroll: true });
        const r = document.createRange();
        r.selectNodeContents(el); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }

    function injectStyles() {
        if (document.getElementById('azd-style')) return;
        const style = document.createElement('style');
        style.id = 'azd-style';
        style.textContent = `
:root {
    --azd-ink: #1a1a1a; --azd-sub: #6b6b6b; --azd-glass: rgba(255,255,255,.86); --azd-line: rgba(0,0,0,.08);
    --azd-pencil: #b9792b; --azd-pencil-soft: rgba(185,121,43,.14); --azd-shadow: 0 10px 40px rgba(0,0,0,.10), 0 1px 0 rgba(255,255,255,.6) inset;
    --azd-ease: cubic-bezier(.22,.68,.22,1);
}
:root.dark {
    --azd-ink: #ececec; --azd-sub: #8f8f8f; --azd-glass: rgba(26,26,26,.86); --azd-line: rgba(255,255,255,.08);
    --azd-pencil: #e2b56c; --azd-pencil-soft: rgba(226,181,108,.13); --azd-shadow: 0 12px 48px rgba(0,0,0,.55), 0 1px 0 rgba(255,255,255,.05) inset;
}

/* page while writing */
.azd-editing header, .azd-editing footer, .azd-editing .post-meta {
    opacity: .18; transition: opacity .6s var(--azd-ease);
}
.azd-editing header:hover, .azd-editing footer:hover { opacity: .8; }
.azd-editing [contenteditable="true"] {
    outline: none; caret-color: var(--azd-pencil); -webkit-user-modify: read-write;
}
.azd-editing .post-content ::selection, .azd-editing .post-title::selection, .azd-editing .post-title ::selection {
    background: var(--azd-pencil-soft); color: inherit;
}
.azd-editing .post-container { padding-bottom: 200px; }
.azd-editing .post-content > *, .azd-editing .post-content li, .azd-editing .post-title, .azd-editing .post-subtitle { position: relative; }
.azd-editing .azd-changed::before {
    content: ""; position: absolute; left: -22px; top: .55em; bottom: .45em; width: 2px; border-radius: 2px;
    background: var(--azd-pencil); opacity: .85; animation: azd-in .4s var(--azd-ease);
}
.azd-editing .post-content li.azd-changed::before { left: -44px; }
@media (max-width: 760px) { .azd-editing .azd-changed::before { left: -12px; } .azd-editing .post-content li.azd-changed::before { left: -34px; } }

/* stamp */
.azd-stamp {
    position: fixed; top: 22px; right: 26px; z-index: 1000; pointer-events: none;
    font: 500 11px/1 var(--font-main, 'Outfit', sans-serif); letter-spacing: .14em; text-transform: uppercase;
    color: var(--azd-pencil); display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
    animation: azd-in .7s var(--azd-ease) both;
}
.azd-stamp span { font-family: var(--font-serif, serif); font-style: italic; text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--azd-sub); }
@media (max-width: 620px) { .azd-stamp { top: 14px; right: 16px; } }

/* glass surfaces */
.azd-dock, .azd-bubble, .azd-menu, .azd-toast, #azd-notice {
    background: var(--azd-glass); border: 1px solid var(--azd-line); box-shadow: var(--azd-shadow);
    backdrop-filter: blur(24px) saturate(170%); -webkit-backdrop-filter: blur(24px) saturate(170%);
    color: var(--azd-ink); font-family: var(--font-main, 'Outfit', sans-serif);
}
#azd button, #azd a, #azd-notice { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }

.azd-dock {
    position: fixed; left: 50%; bottom: calc(26px + env(safe-area-inset-bottom)); z-index: 1000;
    transform: translateX(-50%); display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 16px;
    border-radius: 16px; font-size: 13px; white-space: nowrap; max-width: calc(100vw - 24px);
    animation: azd-rise .55s var(--azd-ease) both;
}
.azd-sep { width: 1px; height: 18px; background: var(--azd-line); margin: 0 8px; }
.azd-status { display: inline-flex; align-items: center; gap: 8px; color: var(--azd-sub); font-variant-numeric: tabular-nums; }
.azd-status i { width: 7px; height: 7px; border-radius: 50%; background: var(--azd-sub); opacity: .5; transition: background .3s, opacity .3s, box-shadow .3s; }
.azd-status[data-state="saved"] i { background: var(--azd-pencil); opacity: 1; box-shadow: 0 0 0 3px var(--azd-pencil-soft); }
.azd-status[data-state="editing"] i { background: var(--azd-pencil); opacity: 1; animation: azd-pulse 1s ease-in-out infinite; }
.azd-status[data-state="error"] { color: #e5675b; } .azd-status[data-state="error"] i { background: #e5675b; opacity: 1; }
.azd-count { color: var(--azd-sub); font-variant-numeric: tabular-nums; margin-right: 6px; }
.azd-delta { color: var(--azd-pencil); margin-left: 6px; }
.azd-delta:empty { display: none; }

.azd-btn {
    border: 0; background: transparent; cursor: pointer; padding: 8px 12px; border-radius: 10px;
    transition: background .2s, color .2s, opacity .2s; color: var(--azd-sub) !important;
}
.azd-btn:hover:not(:disabled) { background: var(--azd-line); color: var(--azd-ink) !important; }
.azd-btn:disabled { opacity: .45; cursor: default; }
.azd-btn:focus-visible { outline: 2px solid var(--azd-pencil); outline-offset: 1px; }
.azd-changes[aria-pressed="true"] { color: var(--azd-pencil) !important; }
.azd-primary { color: var(--azd-ink) !important; background: var(--azd-line); font-weight: 500; }
.azd-confirm { color: #e5675b !important; background: rgba(229,103,91,.12); }
.azd-done { color: var(--azd-ink) !important; }

.azd-menu-wrap { position: relative; }
.azd-menu {
    position: absolute; bottom: calc(100% + 12px); left: 50%; transform: translateX(-50%); min-width: 240px;
    border-radius: 14px; padding: 6px; display: flex; flex-direction: column; animation: azd-pop .22s var(--azd-ease);
}
.azd-menu[hidden] { display: none; }
.azd-menu button, .azd-menu a {
    display: flex; justify-content: space-between; align-items: baseline; gap: 16px; text-align: left; text-decoration: none;
    border: 0; background: none; padding: 10px 12px; border-radius: 9px; cursor: pointer; font-size: 14px;
}
.azd-menu button:hover, .azd-menu a:hover { background: var(--azd-line); }
.azd-menu small { color: var(--azd-sub); font-size: 12px; }
.azd-menu-others:not(:empty) { border-top: 1px solid var(--azd-line); margin-top: 6px; padding-top: 6px; }
.azd-menu-label { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--azd-sub); padding: 8px 12px 4px; }

.azd-bubble {
    position: fixed; top: 0; left: 0; z-index: 1001; display: flex; align-items: center; gap: 2px; padding: 4px;
    border-radius: 12px; transition: transform .12s var(--azd-ease); animation: azd-pop .18s var(--azd-ease);
}
.azd-bubble[hidden] { display: none; }
.azd-bubble button {
    min-width: 32px; height: 32px; border: 0; background: none; border-radius: 8px; cursor: pointer;
    font-family: var(--font-serif, serif) !important; font-size: 17px !important; color: var(--azd-ink);
}
.azd-bubble button:hover { background: var(--azd-pencil-soft); color: var(--azd-pencil) !important; }
.azd-rule { width: 1px; height: 18px; background: var(--azd-line); margin: 0 3px; }

.azd-toast {
    position: fixed; left: 50%; bottom: calc(86px + env(safe-area-inset-bottom)); z-index: 1000;
    transform: translate(-50%, 8px); opacity: 0; pointer-events: none; padding: 10px 16px; border-radius: 12px;
    font-size: 13px; display: flex; align-items: center; gap: 14px; transition: opacity .25s, transform .35s var(--azd-ease);
}
.azd-toast.azd-show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
.azd-toast button { border: 0; background: none; cursor: pointer; color: var(--azd-pencil) !important; font-weight: 500; padding: 0; }

#azd-notice {
    position: fixed; right: 22px; bottom: calc(22px + env(safe-area-inset-bottom)); z-index: 1000; cursor: pointer;
    display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 999px; font-size: 13px;
    animation: azd-rise .6s var(--azd-ease) both .4s;
}
#azd-notice i { width: 7px; height: 7px; border-radius: 50%; background: var(--azd-pencil); box-shadow: 0 0 0 3px var(--azd-pencil-soft); }
#azd-notice span { color: var(--azd-sub); }
#azd-notice em { font-style: normal; color: var(--azd-pencil); margin-left: 4px; }
@media (max-width: 620px) { #azd-notice { bottom: calc(90px + env(safe-area-inset-bottom)); right: 50%; transform: translateX(50%); } }

@media (max-width: 620px) {
    .azd-editing .nav-links { display: none !important; }
    .azd-dock { padding-left: 12px; gap: 0; }
    .azd-count, .azd-changes, .azd-sep { display: none; }
    .azd-menu { left: auto; right: -60px; transform: none; }
}

@keyframes azd-in { from { opacity: 0; } }
@keyframes azd-rise { from { opacity: 0; transform: translate(-50%, 14px); } }
#azd-notice { animation-name: azd-fade-up; }
@keyframes azd-fade-up { from { opacity: 0; translate: 0 10px; } }
@keyframes azd-pop { from { opacity: 0; scale: .96; } }
@keyframes azd-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { #azd *, #azd-notice, .azd-changed::before { animation: none !important; transition: none !important; } }
`;
        document.head.append(style);
    }
})();
