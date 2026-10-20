/* Turbo Cut: a daily timed free-listing game. Five prompts, 30 seconds each;
   name as many as you can. Rare answers that people still recognise score
   most. Prompts come from turbocut-data-*.js, which push onto
   window.TURBOCUT_PROMPTS. The pure engine below also loads under node. */
(function (root) {
    'use strict';

    // ---------------------------------------------------------------- engine

    const TURBOCUT_EPOCH = 20746; // UTC day index of 2026-10-20, Turbo Cut #1
    const ORDER_SEED = 0x0DEC0C75;
    const PER_DAY = 5;
    const ROUND_MS = 30000;
    const STORAGE_KEY = 'turbocut.v1';
    const SHARE_URL = 'aaronzhu.io/turbocut.html';
    const TIERS = [
        [2000, 'Taleggio'],
        [1300, 'Deep cut'],
        [800, 'Crate digger'],
        [400, 'Quick draw'],
        [0, 'Warming up'],
    ];

    function normalize(s) {
        return String(s == null ? '' : s)
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .trim()
            .replace(/^the\s+/, '')
            .replace(/\+/g, 'plus')
            .replace(/#/g, 'sharp')
            .replace(/[^a-z0-9]/g, '');
    }

    // Optimal string alignment distance (Levenshtein plus adjacent swaps).
    function editDistance(a, b) {
        const m = a.length, n = b.length;
        const d = [];
        for (let i = 0; i <= m; i++) {
            d.push(new Array(n + 1).fill(0));
            d[i][0] = i;
        }
        for (let j = 0; j <= n; j++) d[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
                if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                    d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
                }
            }
        }
        return d[m][n];
    }

    function unit(x) {
        const v = Number(x);
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    }

    function rawScore(a) {
        return 100 * (1 - unit(a.thought)) * unit(a.known);
    }

    const scoreCache = typeof WeakMap === 'function' ? new WeakMap() : null;

    // One entry per answer, in list order. The single highest raw score is the
    // deep cut and scores exactly 100; every other valid answer scores 1..99.
    function scorePrompt(prompt) {
        if (scoreCache && prompt && typeof prompt === 'object' && scoreCache.has(prompt)) return scoreCache.get(prompt);
        const answers = (prompt && Array.isArray(prompt.answers)) ? prompt.answers : [];
        let best = -1, bestRaw = -Infinity;
        const raws = answers.map((a, i) => {
            const r = rawScore(a);
            if (r > bestRaw) { bestRaw = r; best = i; }
            return r;
        });
        const scored = answers.map((a, i) => ({
            answer: a,
            index: i,
            raw: raws[i],
            deepCut: i === best,
            points: i === best ? 100 : Math.min(99, Math.max(1, Math.round(raws[i]))),
        }));
        if (scoreCache && prompt && typeof prompt === 'object') scoreCache.set(prompt, scored);
        return scored;
    }

    // Words that carry no meaning on their own when matching part of an answer.
    const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'mr', 'mrs', 'ms', 'dr', 'sir', 'st', 'saint',
        'mount', 'mt', 'de', 'la', 'le', 'el', 'san', 'da', 'di', 'du', 'van', 'von', 'river', 'sea',
        'lake', 'city', 'fc', 'united', 'town', 'type']);

    // Normalized words of a phrase, keeping word boundaries.
    function words(s) {
        return String(s == null ? '' : s)
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .replace(/\+/g, 'plus')
            .replace(/#/g, 'sharp')
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
    }

    // A loose singular: "cloves" and "clove" compare equal, "glass" stays.
    function stem(w) {
        if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
        if (w.length > 4 && w.endsWith('es') && /[sxz]es$|[cs]hes$/.test(w)) return w.slice(0, -2);
        if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
        return w;
    }

    // How many edits a word of this length may be off by and still count.
    function slack(len) {
        return len >= 10 ? 2 : len >= 5 ? 1 : 0;
    }

    // Distance between two normalized strings if within tolerance, else Infinity.
    function closeness(a, b) {
        if (a === b) return 0;
        const sa = stem(a), sb = stem(b);
        if (sa === sb) return 0.5;
        const allow = slack(Math.min(a.length, b.length));
        if (Math.abs(a.length - b.length) > allow) return Infinity;
        const d = editDistance(sa, sb);
        if (d <= allow) return d;
        // Four letters: only a swapped pair ("zues") is forgiven.
        if (a.length === 4 && b.length === 4 && d === 1 && [...a].sort().join('') === [...b].sort().join('')) return 1;
        return Infinity;
    }

    // The scored entry for the best match, plus `distance` (0 exact, up to 2
    // for typos, 4 for a partial such as "darcy" for Mr. Darcy), or null when
    // the input is not on the list. Forgiving by design: typos, plurals, the
    // prompt's own noun ("cheddar cheese"), and distinctive words of a longer
    // answer all land.
    function matchAnswer(prompt, input) {
        const q = normalize(input);
        if (!q) return null;
        // The prompt's own words never carry a match ("cheddar cheese", "femur bone").
        const stops = new Set(STOP);
        for (const w of words(prompt && prompt.prompt)) { stops.add(w); stops.add(stem(w)); }
        const qWords = words(input);
        const qContent = qWords.filter(w => !stops.has(w) && !stops.has(stem(w)));
        const qForms = [q];
        if (qContent.length && qContent.length < qWords.length) qForms.push(qContent.join(''));

        let best = null, bestD = Infinity;
        const consider = (s, d) => {
            if (d === Infinity) return;
            if (d < bestD || (d === bestD && s.answer.thought > best.answer.thought)) { best = s; bestD = d; }
        };
        const scored = scorePrompt(prompt);
        for (const s of scored) {
            const keys = [s.answer.name].concat(s.answer.aliases || []);
            let d = Infinity;
            for (const k of keys) {
                const nk = normalize(k);
                if (!nk) continue;
                // The full phrase outranks the same phrase with stop words dropped.
                qForms.forEach((f, i) => { const c = closeness(f, nk); if (c !== Infinity) d = Math.min(d, c + i * 0.25); });
                if (d === 0) break;
            }
            consider(s, d);
        }
        if (best && bestD <= 1) return Object.assign({}, best, { distance: bestD });

        // Partial: every content word typed is, exactly, a word of the answer,
        // one of them is at least five letters, and only one answer fits.
        // "darcy" lands Mr. Darcy; "bennet" could be three people, so it does not.
        if (!best && qContent.length && qContent.some(w => w.length >= 5)) {
            const fits = [];
            for (const s of scored) {
                const keys = [s.answer.name].concat(s.answer.aliases || []);
                const hit = keys.some(k => {
                    const all = words(k);
                    const kw = new Set(all.filter(w => !STOP.has(w)).map(stem));
                    return all.length > qContent.length && qContent.every(w => kw.has(stem(w)));
                });
                if (hit) fits.push(s);
            }
            if (fits.length === 1) return Object.assign({}, fits[0], { distance: 4 });
        }
        return best ? Object.assign({}, best, { distance: bestD }) : null;
    }

    // Judge one submission against the answers already banked this round.
    // Duplicates are detected by canonical name, so "cheddar" then
    // "cheddar cheese" counts once. Returns { status, match?, entry? } where
    // status is 'empty' | 'miss' | 'dup' | 'ok'.
    function judgeAnswer(prompt, banked, input) {
        const text = String(input == null ? '' : input).trim();
        if (!text) return { status: 'empty' };
        const m = matchAnswer(prompt, text);
        if (!m) return { status: 'miss' };
        if ((banked || []).some(a => a.name === m.answer.name)) return { status: 'dup', match: m };
        // thought and known ride along so the round-end table can show what
        // each answer was worth without ever listing the others.
        return {
            status: 'ok', match: m,
            entry: { input: text, name: m.answer.name, points: m.points, thought: m.answer.thought, known: m.answer.known },
        };
    }

    // The statistical play behind one banked answer. firstBy: 'most' when
    // half or more name it first, else N for "1 in N", 0 when almost nobody
    // does, null when unknown (saves from before these were kept). knownTo:
    // a whole percent, or null.
    function playStats(entry) {
        const num = v => (typeof v === 'number' && Number.isFinite(v)) ? Math.min(1, Math.max(0, v)) : null;
        const th = num(entry && entry.thought), kn = num(entry && entry.known);
        return {
            firstBy: th == null ? null : th >= 0.5 ? 'most' : th > 0 ? Math.max(1, Math.round(1 / th)) : 0,
            knownTo: kn == null ? null : Math.round(kn * 100),
        };
    }

    function roundScore(answers) {
        return (answers || []).reduce((t, a) => t + (Number(a.points) || 0), 0);
    }

    function bestPoints(answers) {
        return (answers || []).reduce((b, a) => Math.max(b, Number(a.points) || 0), 0);
    }

    // Plays a whole round from a list of inputs; handy for tests and replay.
    function playRound(prompt, inputs) {
        const answers = [];
        const log = [];
        for (const input of inputs || []) {
            const r = judgeAnswer(prompt, answers, input);
            log.push(r.status);
            if (r.status === 'ok') answers.push(r.entry);
        }
        return { promptId: prompt && prompt.id, answers, score: roundScore(answers), log };
    }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function shuffle(list, rng) {
        const a = list.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }

    // Usable prompts, first occurrence of each id kept.
    function cleanPrompts(prompts) {
        const seen = new Set();
        const out = [];
        for (const p of prompts || []) {
            if (!p || typeof p.id !== 'string' || !p.prompt || !Array.isArray(p.answers) || !p.answers.length) continue;
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            out.push(p);
        }
        return out;
    }

    function orderPrompts(prompts, seed) {
        const sorted = cleanPrompts(prompts).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
        return shuffle(sorted, mulberry32(seed == null ? ORDER_SEED : seed));
    }

    function dayIndexNow(now) {
        return Math.floor((now == null ? Date.now() : now) / 86400000);
    }

    function dailyNumberFor(dayIndex) {
        return dayIndex - TURBOCUT_EPOCH + 1;
    }

    function dailyPrompts(prompts, dayIndex) {
        const order = orderPrompts(prompts);
        const n = order.length;
        if (!n) return [];
        const d = (dayIndex == null ? dayIndexNow() : dayIndex) - TURBOCUT_EPOCH;
        const out = [];
        for (let i = 0; i < Math.min(PER_DAY, n); i++) {
            out.push(order[(((d * PER_DAY + i) % n) + n) % n]);
        }
        return out;
    }

    // Endless: random prompts, avoiding today's daily when there are enough.
    function randomPrompts(prompts, count, exclude, rng) {
        const all = cleanPrompts(prompts);
        const skip = new Set(exclude || []);
        const fresh = all.filter(p => !skip.has(p.id));
        const pool = fresh.length >= Math.min(count, all.length) ? fresh : all;
        return shuffle(pool, rng || Math.random).slice(0, count);
    }

    function emojiFor(points) {
        if (points >= 100) return '💎';
        if (points >= 75) return '🟪';
        if (points >= 40) return '🟩';
        if (points >= 1) return '🟨';
        return '⬜';
    }

    function tierFor(total) {
        for (const [min, label] of TIERS) if (total >= min) return label;
        return TIERS[TIERS.length - 1][1];
    }

    // Best answer's colour, then how many valid answers: "💎14".
    function roundToken(round) {
        const answers = (round && round.answers) || [];
        return emojiFor(bestPoints(answers)) + answers.length;
    }

    function shareText(dailyNumber, total, rounds) {
        return `Turbo Cut #${dailyNumber} · ${total} pts\n` +
            (rounds || []).map(roundToken).join(' ') + '\n' +
            SHARE_URL;
    }

    function applyStreak(streak, dailyNumber) {
        const s = streak || { count: 0, lastDaily: null };
        if (s.lastDaily === dailyNumber) return { count: s.count, lastDaily: s.lastDaily };
        return {
            count: s.lastDaily === dailyNumber - 1 ? (s.count || 0) + 1 : 1,
            lastDaily: dailyNumber,
        };
    }

    function displayStreak(streak, dailyNumber) {
        if (!streak || typeof streak.lastDaily !== 'number') return 0;
        if (streak.lastDaily < dailyNumber - 1) return 0;
        return streak.count || 0;
    }

    // ---------------------------------------------------------------- drawing
    // Pure canvas renderers. Each takes a 2D context (or anything with the same
    // methods), sizes in CSS pixels and a colors object { line, accent, muted,
    // bg, text }. They never touch the document, so node tests can drive them.

    const SANS = 'Outfit, sans-serif';
    const SERIF = '"Martina Plantijn", Georgia, serif';
    const MONO = '"Roobert Mono", ui-monospace, monospace';

    // Chip tier once points show: 'low' | 'mid' | 'high' | 'deep'.
    function pointsTier(points) {
        const p = Number(points) || 0;
        if (p >= 100) return 'deep';
        if (p >= 75) return 'high';
        if (p >= 40) return 'mid';
        return 'low';
    }

    const SPIKE_HALF = 1.75; // a spike goes up and back over 3.5px of x
    const TICK = 0.35;       // unrevealed spike height, as a share of the full height

    // Baseline sits on a half pixel so the 1px line is crisp; spikes rise
    // from it to at most one pixel below the top.
    function traceGeometry(width, height) {
        const base = Math.max(1, Math.floor(Number(height) || 0) - 2) + 0.5;
        return { base, maxH: Math.max(0, base - 1) };
    }

    // Spike height for one event: the uniform tick at reveal 0, the true
    // height (points / 100 of full) at reveal 1.
    function spikeHeight(points, maxH, reveal) {
        const r = reveal == null ? 1 : unit(reveal);
        const p = Math.min(100, Math.max(0, Number(points) || 0));
        return maxH * (TICK + (p / 100 - TICK) * r);
    }

    // The round as a seismograph line. events: [{ t (ms), points, deepCut?, lift? }];
    // only events at or before elapsedMs show. The deep cut (100 points) turns
    // accent once anything has been revealed.
    function drawTrace(ctx, width, height, events, elapsedMs, roundMs, colors, reveal) {
        const c = colors || {};
        const W = Math.max(0, Number(width) || 0), H = Math.max(0, Number(height) || 0);
        if (c.bg) { ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H); }
        else if (ctx.clearRect) ctx.clearRect(0, 0, W, H);
        if (W < 4 || H < 4) return;
        const total = Number(roundMs) > 0 ? Number(roundMs) : ROUND_MS;
        const elapsed = Math.min(total, Math.max(0, Number(elapsedMs) || 0));
        const r = reveal == null ? 1 : unit(reveal);
        const g = traceGeometry(W, H);
        const list = (Array.isArray(events) ? events : [])
            .filter(e => e && Number.isFinite(Number(e.t)) && Number(e.t) >= 0 && Number(e.t) <= elapsed)
            .map(e => ({ t: Number(e.t), points: Number(e.points) || 0, deep: !!e.deepCut || Number(e.points) >= 100, lift: Number(e.lift) || 0 }))
            .sort((a, b) => a.t - b.t);
        const xOf = t => Math.min(W - SPIKE_HALF, Math.max(SPIKE_HALF, t / total * W));
        const accentDeep = r > 0 && !!c.accent;
        // lift: an optional extra share of full height, for the needle flick.
        const peak = e => Math.min(g.maxH, Math.max(0, spikeHeight(e.points, g.maxH, r) + e.lift * g.maxH));
        let end = elapsed / total * W;

        ctx.save();
        ctx.lineWidth = 1;
        ctx.lineJoin = 'bevel';
        ctx.lineCap = 'butt';
        ctx.strokeStyle = c.line || c.text || '#000';
        ctx.beginPath();
        ctx.moveTo(0, g.base);
        for (const e of list) {
            const x = xOf(e.t);
            end = Math.max(end, x + SPIKE_HALF);
            if (e.deep && accentDeep) { ctx.lineTo(x, g.base); continue; }
            ctx.lineTo(x - SPIKE_HALF, g.base);
            ctx.lineTo(x, g.base - peak(e));
            ctx.lineTo(x + SPIKE_HALF, g.base);
        }
        ctx.lineTo(end, g.base);
        ctx.stroke();
        if (accentDeep) {
            ctx.strokeStyle = c.accent;
            for (const e of list) {
                if (!e.deep) continue;
                const x = xOf(e.t);
                ctx.beginPath();
                ctx.moveTo(x - SPIKE_HALF, g.base);
                ctx.lineTo(x, g.base - peak(e));
                ctx.lineTo(x + SPIKE_HALF, g.base);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // Plot box for the results scatter: x = thought (rare left, common right),
    // y = known (bottom 0, top 1). Labels live outside left/right/top/bottom.
    function scatterLayout(width, height) {
        const W = Math.max(0, Number(width) || 0), H = Math.max(0, Number(height) || 0);
        const axisY = Math.max(40, Math.floor(H) - 21) + 0.5;
        return { W, H, axisX: 0.5, axisY, left: 12, right: Math.max(13, W - 12), top: 30, bottom: axisY - 10 };
    }

    function scatterPos(layout, thought, known) {
        return {
            x: layout.left + unit(thought) * (layout.right - layout.left),
            y: layout.bottom - unit(known) * (layout.bottom - layout.top),
        };
    }

    // Index into `scored` of the dot nearest (px, py) within maxDist, or -1.
    // With `only` (a Set or array of canonical names), other dots are never
    // picked: the player can name their own answers, not anyone else's.
    function nearestScatterPoint(scored, width, height, px, py, maxDist, only) {
        const L = scatterLayout(width, height);
        const lim = maxDist == null ? 16 : maxDist;
        const allow = only == null ? null : only instanceof Set ? only : new Set(Array.isArray(only) ? only : []);
        let best = -1, bestD = lim * lim;
        (scored || []).forEach((s, i) => {
            if (allow && !allow.has(s.answer.name)) return;
            const p = scatterPos(L, s.answer.thought, s.answer.known);
            let d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
            if (s.deepCut && d <= 81) d = 0; // anywhere inside its ring picks the deep cut
            if (d < bestD || (best < 0 && d <= bestD)) { bestD = d; best = i; }
        });
        return best;
    }

    function textWidth(ctx, s) {
        return ctx.measureText ? ctx.measureText(s).width : String(s).length * 6;
    }

    function fitText(ctx, text, maxW) {
        const s = String(text == null ? '' : text);
        if (textWidth(ctx, s) <= maxW) return s;
        let lo = 0, hi = s.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (textWidth(ctx, s.slice(0, mid).trimEnd() + '…') <= maxW) lo = mid;
            else hi = mid - 1;
        }
        return s.slice(0, lo).trimEnd() + '…';
    }

    function dot(ctx, x, y, r) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }

    // scored: scorePrompt(prompt). gotNames: Set or array of canonical names.
    // hover: index into scored whose label to show, or -1 / null. Only the
    // player's own answers are ever labelled; the rest stay anonymous dots.
    // progress (optional, for the reveal): { arrive: { name: 0..1 }, ring:
    // { name: 0..1 }, deep: 0..1 | null }. A got answer with no arrival is
    // not drawn yet; at arrival a it sits a of the way from the (1, 0) corner
    // to its place; its landing ring, at age ring[name], shows only once it
    // has arrived. An un-got deep cut stays a faint dot until deep is a
    // number, then shows its ring, pulsing once while deep < 1.
    function drawScatter(ctx, width, height, scored, gotNames, colors, hover, progress) {
        const c = colors || {};
        const L = scatterLayout(width, height);
        const list = Array.isArray(scored) ? scored : [];
        const got = gotNames instanceof Set ? gotNames : new Set(Array.isArray(gotNames) ? gotNames : []);
        if (c.bg) { ctx.fillStyle = c.bg; ctx.fillRect(0, 0, L.W, L.H); }
        else if (ctx.clearRect) ctx.clearRect(0, 0, L.W, L.H);
        if (L.W < 40 || L.H < 60) return;
        const P = (t, k) => scatterPos(L, t, k);
        ctx.save();

        // The sweet spot, (1 - thought) * known >= 0.6: a soft upper-left corner.
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = c.accent || '#00f';
        ctx.beginPath();
        ctx.moveTo(L.axisX, P(0, 1).y);
        ctx.lineTo(L.axisX, P(0, 0.6).y);
        for (let t = 0; t <= 0.4001; t += 0.02) {
            const p = P(t, 0.6 / (1 - t));
            ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fill();

        // Hairline axes and their labels.
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = c.muted || '#888';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(L.axisX, L.top - 12);
        ctx.lineTo(L.axisX, L.axisY);
        ctx.lineTo(L.W, L.axisY);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.muted || '#888';
        ctx.font = `400 11px ${SANS}`;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText('recognised ↑', L.axisX + 6, 11);
        ctx.fillText('rare', L.axisX + 2, L.axisY + 15);
        ctx.textAlign = 'right';
        ctx.fillText('common →', L.W, L.axisY + 15);
        ctx.textAlign = 'left';

        const pr = progress && typeof progress === 'object' ? progress : null;
        const arrival = name => {
            if (!pr) return 1;
            const v = pr.arrive && pr.arrive[name];
            return typeof v === 'number' && Number.isFinite(v) ? unit(v) : null;
        };
        const corner = P(1, 0);
        const place = (s, a) => {
            const p = P(s.answer.thought, s.answer.known);
            return a >= 1 ? p : { x: corner.x + (p.x - corner.x) * a, y: corner.y + (p.y - corner.y) * a };
        };
        const deepShown = !pr || typeof pr.deep === 'number';

        // Everything else faint, the player's answers solid, the deep cut ringed.
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = c.muted || '#888';
        for (const s of list) {
            if (got.has(s.answer.name) || (s.deepCut && deepShown)) continue;
            const p = P(s.answer.thought, s.answer.known);
            dot(ctx, p.x, p.y, 3);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.text || '#000';
        for (const s of list) {
            if (s.deepCut || !got.has(s.answer.name)) continue;
            const a = arrival(s.answer.name);
            if (a == null) continue;
            const p = place(s, a);
            dot(ctx, p.x, p.y, 4);
            ctx.fill();
        }
        for (const s of list) {
            if (!s.deepCut) continue;
            const mine = got.has(s.answer.name);
            const a = mine ? arrival(s.answer.name) : 1;
            if (mine ? a == null : !deepShown) continue;
            const p = place(s, a);
            if (a >= 1) {
                if (mine) {
                    ctx.globalAlpha = 0.3;
                    ctx.fillStyle = c.accent || '#00f';
                    dot(ctx, p.x, p.y, 9);
                    ctx.fill();
                    ctx.globalAlpha = 1;
                }
                ctx.strokeStyle = c.accent || '#00f';
                dot(ctx, p.x, p.y, 9);
                ctx.stroke();
            }
            ctx.fillStyle = c.accent || '#00f';
            dot(ctx, p.x, p.y, 5);
            ctx.fill();
        }

        // Landing rings: a thin circle that widens and fades. The deep cut's
        // is bigger; a missed deep cut gets one quiet muted pulse.
        if (pr) {
            const grow = k => 1 - Math.pow(1 - k, 2);
            for (const s of list) {
                const v = pr.ring && pr.ring[s.answer.name];
                if (!got.has(s.answer.name) || typeof v !== 'number' || !(v >= 0 && v < 1)) continue;
                if (arrival(s.answer.name) < 1) continue;
                const p = P(s.answer.thought, s.answer.known);
                const r0 = s.deepCut ? 9 : 4, r1 = s.deepCut ? 28 : 18;
                ctx.globalAlpha = 1 - v;
                ctx.strokeStyle = s.points >= 75 ? (c.accent || '#00f') : (c.text || '#000');
                dot(ctx, p.x, p.y, r0 + (r1 - r0) * grow(v));
                ctx.stroke();
            }
            const deep = list.find(s => s.deepCut);
            if (deep && !got.has(deep.answer.name) && typeof pr.deep === 'number' && pr.deep >= 0 && pr.deep < 1) {
                const p = P(deep.answer.thought, deep.answer.known);
                ctx.globalAlpha = 0.7 * (1 - pr.deep);
                ctx.strokeStyle = c.muted || '#888';
                dot(ctx, p.x, p.y, 9 + 13 * grow(pr.deep));
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        // One label, beside its dot, flipped and clamped to stay inside.
        const hv = list[hover];
        if (hover != null && hover >= 0 && hv && got.has(hv.answer.name) && arrival(hv.answer.name) >= 1) {
            const p = P(hv.answer.thought, hv.answer.known);
            ctx.strokeStyle = c.text || '#000';
            dot(ctx, p.x, p.y, hv.deepCut ? 12 : 7);
            ctx.stroke();
            ctx.font = `500 12px ${SANS}`;
            const label = fitText(ctx, `${hv.answer.name} · ${hv.points} pts`, Math.max(60, L.W - 40));
            const w = textWidth(ctx, label) + 12, bh = 20;
            const gap = hv.deepCut ? 14 : 10;
            let x = p.x + gap;
            if (x + w > L.W) x = p.x - gap - w;
            x = Math.max(0, Math.min(L.W - w, x));
            const y = Math.max(0, Math.min(L.H - bh, p.y - bh / 2));
            ctx.fillStyle = c.bg || '#fff';
            ctx.fillRect(x, y, w, bh);
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = c.muted || '#888';
            ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, bh - 1);
            ctx.globalAlpha = 1;
            ctx.fillStyle = c.text || '#000';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x + 6, y + bh / 2 + 0.5);
        }
        ctx.restore();
    }

    // Timing for the plot reveal. names: the player's answers in landing order
    // (deep cut last). At `elapsed` ms returns the drawScatter progress, how
    // many have landed, when each lands, and whether it's over. opts: gap
    // between launches, travel and ringMs durations, pulse (true when the
    // deep cut was missed, so its ring pulses once after the last landing).
    function plotReveal(names, elapsed, opts) {
        const o = opts || {};
        const list = Array.isArray(names) ? names : [];
        const gap = o.gap == null ? 110 : Number(o.gap) || 0;
        const travel = o.travel || 260, ringMs = o.ringMs || 400, pulseMs = o.pulseMs || 500;
        const t = Number(elapsed) || 0;
        const ease = k => 1 - Math.pow(1 - k, 3);
        const arrive = {}, ring = {}, lands = [];
        let landed = 0;
        list.forEach((n, i) => {
            const start = i * gap, land = start + travel;
            lands.push(land);
            if (t < start) return;
            arrive[n] = ease(Math.min(1, (t - start) / travel));
            if (t >= land) {
                landed++;
                const age = (t - land) / ringMs;
                if (age < 1) ring[n] = age;
            }
        });
        const last = lands.length ? lands[lands.length - 1] : 0;
        const pulseAt = lands.length ? last + 150 : 0;
        const deep = o.pulse && t >= pulseAt ? Math.min(1, (t - pulseAt) / pulseMs) : null;
        // opts.diamond (the deep cut was got, and lands last): a spin of
        // diamondMs after the last landing, as progress.diamond 0..1.
        const diamondMs = o.diamondMs || 1200;
        const diamond = o.diamond && lands.length && t >= last && t < last + diamondMs ? (t - last) / diamondMs : null;
        const end = Math.max(lands.length ? last + ringMs : 0, o.pulse ? pulseAt + pulseMs : 0,
            o.diamond && lands.length ? last + diamondMs : 0);
        return { progress: { arrive, ring, deep, diamond }, landed, lands, done: t >= end, end };
    }

    // ---------------------------------------------------------------- 3D
    // Drawn by hand: a fixed camera orbiting a unit floor, projected with
    // mild perspective. World: x = thought (0 rare, at the left; 1 common,
    // at the right), y = known (0 unknown, at the front; 1 recognised, at
    // the back), z = points / 100 (0 floor, 1 = 100 points). The camera
    // looks from the front, a little to the right and above. Every answer
    // is a pin standing on the floor at (thought, known), as tall as its
    // points; a ruler at the back-left reads the heights off.

    const DEG = Math.PI / 180;
    const LAND_VIEW = Object.freeze({ yaw: -18, pitch: 20, zoom: 1 });
    const LAND_TARGET = Object.freeze({ x: 0.5, y: 0.5, z: 0.3 }); // projects to the canvas centre
    const LAND_SX = 2.5;   // the thought axis runs longer than the known axis, to use the width
    const LAND_Z = 0.9;    // height of a 100-point pin, in floor depths
    const LAND_DIST = 3.4; // camera distance: mild perspective
    const LAND_FLOOR = 8;  // floor cells a side
    const YAW_SWING = 15, PITCH_MIN = 12, PITCH_MAX = 30;
    const LAND_PAD_X = 16, LAND_PAD_Y = 22; // room for the labels round the edge

    // The scoring surface, (1 - thought) * known: an answer's raw share.
    function landHeight(thought, known) {
        return (1 - unit(thought)) * unit(known);
    }

    // A scored answer's pin height: its points (the deep cut exactly 1).
    function pinHeight(s) {
        return unit((Number(s && s.points) || 0) / 100);
    }

    // Camera for a view and canvas: trig and scale, computed once per draw.
    function landCamera(view, width, height, out) {
        const v = view || LAND_VIEW;
        const num = (x, d) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : d);
        const yaw = num(v.yaw, LAND_VIEW.yaw) * DEG, pitch = num(v.pitch, LAND_VIEW.pitch) * DEG;
        const zoom = Math.max(0.1, num(v.zoom, 1));
        const o = out || {};
        o.cyaw = Math.cos(yaw); o.syaw = Math.sin(yaw);
        o.cpit = Math.cos(pitch); o.spit = Math.sin(pitch);
        const W = Math.max(0, Number(width) || 0), H = Math.max(0, Number(height) || 0);
        o.ox = W / 2; o.oy = H / 2;
        o.k = landScale(W, H) * zoom;
        return o;
    }

    function landProject(C, x, y, z, out) {
        const X = (x - LAND_TARGET.x) * LAND_SX, Y = y - LAND_TARGET.y, Z = (z - LAND_TARGET.z) * LAND_Z;
        const rx = X * C.cyaw - Y * C.syaw;
        const ry = X * C.syaw + Y * C.cyaw;
        const depth = LAND_DIST + ry * C.cpit - Z * C.spit;
        const up = ry * C.spit + Z * C.cpit;
        const f = C.k * LAND_DIST / Math.max(0.05, depth);
        out.sx = C.ox + rx * f;
        out.sy = C.oy - up * f;
        out.depth = depth;
        return out;
    }

    // Scale (px per floor depth) at which the floor and a full-height pin
    // at any corner fit the canvas at the default view and at every corner
    // of the orbit.
    let landUnit = null;
    function landScale(W, H) {
        if (!landUnit) {
            const pts = [];
            for (const q of [[0, 0], [1, 0], [1, 1], [0, 1]]) pts.push([q[0], q[1], 0], [q[0], q[1], 1]);
            const p = {};
            landUnit = [1, 1]; // guard the recursion through landCamera
            let ex = 0, ey = 0;
            for (const pit of [PITCH_MIN, LAND_VIEW.pitch, PITCH_MAX]) {
                for (const yw of [LAND_VIEW.yaw - YAW_SWING, LAND_VIEW.yaw, LAND_VIEW.yaw + YAW_SWING]) {
                    const C = landCamera({ yaw: yw, pitch: pit, zoom: 1 }, 0, 0, {});
                    C.k = 1; C.ox = 0; C.oy = 0;
                    for (const q of pts) {
                        landProject(C, q[0], q[1], q[2], p);
                        ex = Math.max(ex, Math.abs(p.sx));
                        ey = Math.max(ey, Math.abs(p.sy));
                    }
                }
            }
            landUnit = [ex, ey];
        }
        return Math.max(1, Math.min((W / 2 - LAND_PAD_X) / landUnit[0], (H / 2 - LAND_PAD_Y) / landUnit[1]));
    }

    // Screen position of a world point for a view on a canvas, plus depth
    // (distance along the camera axis; larger is farther).
    function projectPoint(x, y, z, view, width, height) {
        const C = landCamera(view, width, height, {});
        return landProject(C, Number(x) || 0, Number(y) || 0, Number(z) || 0, { sx: 0, sy: 0, depth: 0 });
    }

    // Index into `scored` of the player's pin top nearest (px, py) within
    // maxDist on the landscape, or -1. Like nearestScatterPoint, `only`
    // limits picks to the player's own answers.
    function nearestLandscapePoint(scored, width, height, view, px, py, maxDist, only) {
        const C = landCamera(view, width, height, {});
        const lim = maxDist == null ? 14 : maxDist;
        const allow = only == null ? null : only instanceof Set ? only : new Set(Array.isArray(only) ? only : []);
        const p = { sx: 0, sy: 0, depth: 0 };
        let best = -1, bestD = lim * lim;
        (scored || []).forEach((s, i) => {
            if (allow && !allow.has(s.answer.name)) return;
            landProject(C, unit(s.answer.thought), unit(s.answer.known), pinHeight(s), p);
            let d = (p.sx - px) * (p.sx - px) + (p.sy - py) * (p.sy - py);
            if (s.deepCut && d <= 81) d = 0;
            if (d < bestD || (best < 0 && d <= bestD)) { bestD = d; best = i; }
        });
        return best;
    }

    // The floor grid, projected once per canvas size and view and reused
    // across frames (the reveal redraws many times with a still camera).
    const wireCache = typeof WeakMap === 'function' ? new WeakMap() : null;
    function landWire(ctx, C, W, H) {
        const F = LAND_FLOOR, m = F + 1;
        const key = `${W}|${H}|${C.cyaw}|${C.syaw}|${C.cpit}|${C.spit}|${C.k}`;
        let w = wireCache && ctx && typeof ctx === 'object' ? wireCache.get(ctx) : null;
        if (w && w.key === key) return w;
        if (!w) {
            w = { key: '', gx: new Float32Array(m * m), gy: new Float32Array(m * m), fx: new Float32Array(4), fy: new Float32Array(4) };
            if (wireCache && ctx && typeof ctx === 'object') wireCache.set(ctx, w);
        }
        w.key = key;
        const p = { sx: 0, sy: 0, depth: 0 };
        for (let j = 0; j < m; j++) {
            for (let i = 0; i < m; i++) {
                landProject(C, i / F, j / F, 0, p);
                w.gx[j * m + i] = p.sx;
                w.gy[j * m + i] = p.sy;
            }
        }
        const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
        corners.forEach((q, i) => { landProject(C, q[0], q[1], 0, p); w.fx[i] = p.sx; w.fy[i] = p.sy; });
        return w;
    }

    // An ellipse lying on the floor around (x, y), radius r in floor depths.
    function floorRing(ctx, C, x, y, r, p) {
        ctx.beginPath();
        for (let i = 0; i <= 32; i++) {
            const a = i / 32 * Math.PI * 2;
            landProject(C, x + Math.cos(a) * r / LAND_SX, y + Math.sin(a) * r, 0, p);
            if (i === 0) ctx.moveTo(p.sx, p.sy);
            else ctx.lineTo(p.sx, p.sy);
        }
    }

    // Every answer to the prompt as a pin over a flat floor: it stands at
    // (thought, known) and is as tall as its points, read off a ruler at
    // the back-left. The field's pins are faint; the player's are solid,
    // topped with a dot and shadowed on the floor; the deep cut is ringed.
    // Pins are painted far to near. view: { yaw, pitch, zoom } in degrees
    // (LAND_VIEW when null). progress and hover work as in drawScatter: a
    // got answer's dot flies from the front-right floor corner (thought 1,
    // known 0) along a straight line to the top of its pin, the pin draws
    // up from the floor over the first 30% of its ring age while a ring
    // spreads on the floor; progress.diamond (0..1) spins a small
    // octahedron over the got deep cut.
    function drawLandscape(ctx, width, height, scored, gotNames, colors, view, progress, hover) {
        const c = colors || {};
        const W = Math.max(0, Number(width) || 0), H = Math.max(0, Number(height) || 0);
        const list = Array.isArray(scored) ? scored : [];
        const got = gotNames instanceof Set ? gotNames : new Set(Array.isArray(gotNames) ? gotNames : []);
        if (c.bg) { ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H); }
        else if (ctx.clearRect) ctx.clearRect(0, 0, W, H);
        if (W < 60 || H < 60) return;
        const C = landCamera(view, W, H, {});
        const wire = landWire(ctx, C, W, H);
        const F = LAND_FLOOR, m = F + 1;
        const muted = c.muted || '#888', text = c.text || '#000', accent = c.accent || '#00f';
        const p = { sx: 0, sy: 0, depth: 0 }, q = { sx: 0, sy: 0, depth: 0 };
        const dash = d => { if (ctx.setLineDash) ctx.setLineDash(d); };
        ctx.save();
        ctx.lineWidth = 1;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'butt';

        // The floor: a faint grid, edged a little stronger.
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = muted;
        ctx.beginPath();
        for (let i = 0; i < m; i++) {
            ctx.moveTo(wire.gx[i], wire.gy[i]);
            ctx.lineTo(wire.gx[F * m + i], wire.gy[F * m + i]);
            ctx.moveTo(wire.gx[i * m], wire.gy[i * m]);
            ctx.lineTo(wire.gx[i * m + F], wire.gy[i * m + F]);
        }
        ctx.stroke();
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(wire.fx[0], wire.fy[0]);
        for (let i = 1; i < 4; i++) ctx.lineTo(wire.fx[i], wire.fy[i]);
        ctx.closePath();
        ctx.stroke();

        // The score axis: a dashed post at the back-left floor corner, read
        // off a ruler just clear of the floor's left edge by dotted leaders
        // at 0, 50 and 100.
        const ticks = [0, 0.5, 1].map(z => { landProject(C, 0, 1, z, p); return { z, x: p.sx, y: p.sy }; });
        ctx.globalAlpha = 0.6;
        dash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(ticks[0].x, ticks[0].y);
        ctx.lineTo(ticks[2].x, ticks[2].y);
        ctx.stroke();
        landProject(C, 0, 0, 0, q);
        const rx = Math.max(24, Math.min(q.sx, ticks[0].x, ticks[2].x) - 10);
        ctx.globalAlpha = 0.3;
        dash([1, 3]);
        ctx.beginPath();
        for (const tk of ticks) { ctx.moveTo(rx, tk.y); ctx.lineTo(tk.x, tk.y); }
        ctx.stroke();
        dash([]);
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(rx, ticks[0].y);
        ctx.lineTo(rx, ticks[2].y);
        for (const tk of ticks) { ctx.moveTo(rx - 4, tk.y); ctx.lineTo(rx, tk.y); }
        ctx.stroke();

        const pr = progress && typeof progress === 'object' ? progress : null;
        const arrival = name => {
            if (!pr) return 1;
            const v = pr.arrive && pr.arrive[name];
            return typeof v === 'number' && Number.isFinite(v) ? unit(v) : null;
        };
        const ringAge = name => {
            const v = pr && pr.ring && pr.ring[name];
            return typeof v === 'number' && v >= 0 && v < 1 ? v : null;
        };
        const deepShown = !pr || typeof pr.deep === 'number';

        // Every pin, far to near by where it stands on the floor.
        const pins = [];
        for (const s of list) {
            const mine = got.has(s.answer.name);
            const special = mine || (s.deepCut && deepShown);
            const a = mine ? arrival(s.answer.name) : 1;
            if (mine && a == null) continue;
            const t = unit(s.answer.thought), k = unit(s.answer.known), z = pinHeight(s);
            landProject(C, t, k, 0, q);
            const fx = q.sx, fy = q.sy, depth = q.depth;
            landProject(C, t, k, z, p);
            const it = { s, mine, special, a, t, k, z, fx, fy, tx: p.sx, ty: p.sy, depth, x: t, y: k };
            if (mine) {
                // In flight: a straight line from the valley corner to the top.
                it.x = 1 + (t - 1) * a; it.y = k * a;
                landProject(C, it.x, it.y, z * a, p);
                it.sx = p.sx; it.sy = p.sy; it.depth = Math.min(depth, p.depth);
            } else { it.sx = it.tx; it.sy = it.ty; }
            pins.push(it);
        }
        pins.sort((u, v) => v.depth - u.depth);
        const tops = pins.map(it => [it.sx, it.sy]).concat(pins.map(it => [it.fx, it.fy]));

        const grow = k => 1 - Math.pow(1 - k, 2);
        for (const it of pins) {
            const s = it.s;
            if (!it.special) {
                ctx.globalAlpha = 0.22;
                ctx.strokeStyle = muted;
                ctx.beginPath();
                ctx.moveTo(it.fx, it.fy);
                ctx.lineTo(it.tx, it.ty);
                ctx.stroke();
                ctx.globalAlpha = 0.5;
                ctx.fillStyle = muted;
                dot(ctx, it.tx, it.ty, 1.75);
                ctx.fill();
                continue;
            }
            const strong = s.deepCut || s.points >= 75;
            const col = strong ? accent : text;
            if (it.mine) {
                // Its shadow on the floor, under wherever it is.
                ctx.globalAlpha = 0.18;
                ctx.fillStyle = col;
                floorRing(ctx, C, it.x, it.y, s.deepCut ? 0.03 : 0.02, q);
                ctx.fill();
            }
            let rise = it.mine ? 0 : 1;
            if (it.mine && it.a >= 1) {
                // Landing ring on the floor, under the pin.
                const age = ringAge(s.answer.name);
                if (age != null) {
                    ctx.globalAlpha = 1 - age;
                    ctx.strokeStyle = col;
                    floorRing(ctx, C, it.t, it.k, s.deepCut ? 0.03 + 0.13 * grow(age) : 0.015 + 0.07 * grow(age), q);
                    ctx.stroke();
                }
                // The pin draws up from the floor over the ring's first 30%.
                rise = age == null ? 1 : Math.min(1, age / 0.3);
            }
            if (rise > 0) {
                ctx.globalAlpha = 0.7;
                ctx.strokeStyle = col;
                ctx.beginPath();
                ctx.moveTo(it.fx, it.fy);
                ctx.lineTo(it.fx + (it.tx - it.fx) * rise, it.fy + (it.ty - it.fy) * rise);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            if (s.deepCut) {
                if (it.a >= 1) {
                    if (it.mine) {
                        ctx.globalAlpha = 0.3;
                        ctx.fillStyle = accent;
                        dot(ctx, it.sx, it.sy, 9);
                        ctx.fill();
                        ctx.globalAlpha = 1;
                    }
                    ctx.strokeStyle = accent;
                    dot(ctx, it.sx, it.sy, 9);
                    ctx.stroke();
                }
                ctx.fillStyle = accent;
                dot(ctx, it.sx, it.sy, 5);
                ctx.fill();
            } else {
                ctx.fillStyle = col;
                dot(ctx, it.sx, it.sy, 3.5);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;

        // Labels, each just outside the floor, haloed in the page colour. On
        // a narrow canvas a floor label that would cover a pin stays hidden.
        const put = (s, x, y, align, base, optional) => {
            ctx.textAlign = align;
            ctx.textBaseline = base;
            const tw = textWidth(ctx, s);
            let lx = x;
            if (align === 'right') lx = Math.max(tw + 1, Math.min(W - 1, lx));
            else if (align === 'left') lx = Math.max(1, Math.min(W - tw - 1, lx));
            else lx = Math.max(tw / 2 + 1, Math.min(W - tw / 2 - 1, lx));
            const ly = Math.max(base === 'top' ? 1 : 12, Math.min(base === 'bottom' ? H - 1 : H - 12, y));
            if (optional && W < 480) {
                const x0 = align === 'right' ? lx - tw : align === 'left' ? lx : lx - tw / 2;
                const y0 = base === 'top' ? ly : base === 'bottom' ? ly - 11 : ly - 6;
                if (tops.some(([px, py]) => px > x0 - 3 && px < x0 + tw + 3 && py > y0 - 3 && py < y0 + 14)) return;
            }
            if (c.bg && ctx.strokeText) {
                ctx.save();
                ctx.globalAlpha = 0.85;
                ctx.strokeStyle = c.bg;
                ctx.lineWidth = 3;
                ctx.lineJoin = 'round';
                ctx.strokeText(s, lx, ly);
                ctx.restore();
            }
            ctx.fillText(s, lx, ly);
        };
        ctx.fillStyle = muted;
        ctx.font = `400 10px ${MONO}`;
        for (const tk of ticks) put(String(Math.round(tk.z * 100)), rx - 7, tk.y, 'right', 'middle');
        ctx.font = `400 11px ${SANS}`;
        put('score', rx, ticks[2].y - 9, 'center', 'bottom');
        // Along the back edge: rare at its left end, common at its right.
        landProject(C, 0, 1, 0, p);
        put('rare', p.sx + 6, p.sy - 5, 'left', 'bottom', true);
        landProject(C, 1, 1, 0, p);
        put('common', p.sx + 2, p.sy - 5, 'right', 'bottom', true);
        // Outside the left edge, 6px clear of it: unknown at the front,
        // recognised toward the back (below the ruler's 0).
        landProject(C, 0, 0.12, 0, p);
        put('unknown', p.sx - 6, p.sy, 'right', 'middle', true);
        landProject(C, 0, 0.7, 0, p);
        put('recognised', p.sx - 6, p.sy, 'right', 'middle', true);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';

        // A missed deep cut: one quiet muted pulse around its ring.
        if (pr) {
            const deep = list.find(s => s.deepCut);
            if (deep && !got.has(deep.answer.name) && typeof pr.deep === 'number' && pr.deep >= 0 && pr.deep < 1) {
                landProject(C, unit(deep.answer.thought), unit(deep.answer.known), pinHeight(deep), p);
                ctx.globalAlpha = 0.7 * (1 - pr.deep);
                ctx.strokeStyle = muted;
                dot(ctx, p.sx, p.sy, 9 + 13 * grow(pr.deep));
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            // The got deep cut's diamond, spinning above its pin.
            const dg = list.find(s => s.deepCut && got.has(s.answer.name));
            if (dg && typeof pr.diamond === 'number' && pr.diamond >= 0 && pr.diamond < 1) {
                landProject(C, unit(dg.answer.thought), unit(dg.answer.known), pinHeight(dg), p);
                const u = pr.diamond;
                const alpha = Math.min(1, u / 0.12) * (u > 0.7 ? (1 - u) / 0.3 : 1);
                const lift = 22 + 6 * grow(Math.min(1, u / 0.4));
                drawDiamond(ctx, p.sx, p.sy - lift, 28, u * Math.PI * 2.5, accent, alpha);
            }
        }

        // One label, beside its dot, for the player's own answers only.
        const hv = list[hover];
        if (hover != null && hover >= 0 && hv && got.has(hv.answer.name) && arrival(hv.answer.name) >= 1) {
            landProject(C, unit(hv.answer.thought), unit(hv.answer.known), pinHeight(hv), p);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = text;
            dot(ctx, p.sx, p.sy, hv.deepCut ? 12 : 7);
            ctx.stroke();
            ctx.font = `500 12px ${SANS}`;
            const s = fitText(ctx, `${hv.answer.name} · ${hv.points} pts`, Math.max(60, W - 40));
            const w = textWidth(ctx, s) + 12, bh = 20;
            const gap = hv.deepCut ? 14 : 10;
            let x = p.sx + gap;
            if (x + w > W) x = p.sx - gap - w;
            x = Math.max(0, Math.min(W - w, x));
            const y = Math.max(0, Math.min(H - bh, p.sy - bh / 2));
            ctx.fillStyle = c.bg || '#fff';
            ctx.fillRect(x, y, w, bh);
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = muted;
            ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, bh - 1);
            ctx.globalAlpha = 1;
            ctx.fillStyle = text;
            ctx.textBaseline = 'middle';
            ctx.fillText(s, x + 6, y + bh / 2 + 0.5);
        }
        ctx.restore();
    }

    // The six corners of a small octahedron spun `angle` about its upright
    // axis and seen from a little above: [top, bottom, e0, e1, e2, e3], each
    // { x, y, front } where front says whether an equator corner faces us.
    const DIAMOND_TILT = 18 * DEG;
    function diamondVertices(cx, cy, size, angle) {
        const hgt = size / 2, r = size * 0.34;
        const a = Number(angle) || 0;
        const out = [
            { x: cx, y: cy - hgt * Math.cos(DIAMOND_TILT), front: true },
            { x: cx, y: cy + hgt * Math.cos(DIAMOND_TILT), front: true },
        ];
        for (let i = 0; i < 4; i++) {
            const e = a + i * Math.PI / 2;
            const ex = Math.sin(e) * r, ez = Math.cos(e) * r; // ez > 0 faces the viewer
            out.push({ x: cx + ex, y: cy + ez * Math.sin(DIAMOND_TILT), front: ez >= -1e-9 });
        }
        return out;
    }

    // ◆ in 3D: twelve hairline edges, the far ones fainter.
    function drawDiamond(ctx, cx, cy, size, angle, color, alpha) {
        const v = diamondVertices(cx, cy, size, angle);
        const al = alpha == null ? 1 : unit(alpha);
        if (al <= 0) return;
        const edges = [];
        for (let i = 0; i < 4; i++) {
            const e = 2 + i, f = 2 + (i + 1) % 4;
            edges.push([e, f], [0, e], [1, e]);
        }
        ctx.save();
        ctx.lineWidth = 1;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = color || '#00f';
        for (const pass of [false, true]) {
            ctx.globalAlpha = al * (pass ? 1 : 0.35);
            ctx.beginPath();
            for (const [a, b] of edges) {
                const front = v[a].front && v[b].front;
                if (front !== pass) continue;
                ctx.moveTo(v[a].x, v[a].y);
                ctx.lineTo(v[b].x, v[b].y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    // "Your day", after the Unknown Pleasures cover: every round becomes a
    // smooth profile, one Gaussian bump per answer, and a dense stack of
    // ridges morphs from round 1 at the back to the last round in front.
    // Each ridge is filled with the page so nearer ones hide farther ones.
    const RIDGE_SAMPLES = 240;
    const RIDGE_MARGIN = 0.18;      // calm margin each side; answers live in the middle 64%
    const RIDGE_NOISE = 0.022;      // texture, as a share of a deep cut's height
    const RIDGE_STAGGER = 40, RIDGE_DRAW = 250;
    const RIDGE_CAP = 1.25;         // where piled-up bumps level off
    const RIDGE_SPAN = 9;           // a deep cut stands this many ridge spacings tall

    function ridgeSigma(points) {
        return 0.014 + 0.01 * Math.min(100, Math.max(0, Number(points) || 0)) / 100;
    }

    // Where an answer at t sits across the ridge, 0..1.
    function ridgeU(t, roundMs) {
        const ms = Number(roundMs) > 0 ? Number(roundMs) : ROUND_MS;
        return RIDGE_MARGIN + (1 - 2 * RIDGE_MARGIN) * Math.min(1, Math.max(0, (Number(t) || 0) / ms));
    }

    function ridgeEvents(round) {
        const ms = Number(round && round.roundMs) > 0 ? Number(round.roundMs) : ROUND_MS;
        return (round && Array.isArray(round.events) ? round.events : [])
            .filter(e => e && Number.isFinite(Number(e.t)) && Number(e.t) >= 0 && Number(e.t) <= ms)
            .map(e => {
                const pts = Math.min(100, Math.max(0, Number(e.points) || 0));
                return { u: ridgeU(e.t, ms), h: pts / 100, sigma: ridgeSigma(pts), deep: !!e.deepCut || pts >= 100 };
            });
    }

    // The ridge's own hand-drawn wobble: four sines at unrelated
    // frequencies, phases fixed by the seed.
    function ridgeNoise(out, seed, amp) {
        const rng = mulberry32((Number(seed) | 0) * 2654435761 + 7);
        const f = [5.3, 11.7, 19.9, 33.1], w = [0.45, 0.3, 0.15, 0.1];
        const ph = [rng(), rng(), rng(), rng()].map(x => x * Math.PI * 2);
        const fq = f.map(x => x * (0.85 + 0.3 * rng()));
        const n = out.length;
        for (let i = 0; i < n; i++) {
            const u = n > 1 ? i / (n - 1) : 0;
            let v = 0;
            for (let j = 0; j < 4; j++) v += w[j] * Math.sin(fq[j] * Math.PI * 2 * u + ph[j]);
            out[i] += amp * v;
        }
        return out;
    }

    // One round's profile f(u), sampled at `samples` points across the
    // ridge: the sum of its answers' bumps (a deep cut stands 1.0 tall).
    // With a numeric seed the ridge texture is added.
    function ridgeProfile(round, samples, seed) {
        const n = Math.max(2, (samples | 0) || RIDGE_SAMPLES);
        const out = new Float32Array(n);
        for (const e of ridgeEvents(round)) {
            const s2 = 2 * e.sigma * e.sigma;
            const lo = Math.max(0, Math.floor((e.u - 4 * e.sigma) * (n - 1)));
            const hi = Math.min(n - 1, Math.ceil((e.u + 4 * e.sigma) * (n - 1)));
            for (let i = lo; i <= hi; i++) {
                const d = i / (n - 1) - e.u;
                out[i] += e.h * Math.exp(-d * d / s2);
            }
        }
        // Close answers add up, but softly: a run of quick answers makes a
        // range of peaks, not a cliff.
        for (let i = 0; i < n; i++) if (out[i] > 1) out[i] = 1 + (RIDGE_CAP - 1) * Math.tanh((out[i] - 1) / (RIDGE_CAP - 1));
        if (typeof seed === 'number' && Number.isFinite(seed)) ridgeNoise(out, seed, RIDGE_NOISE);
        return out;
    }

    // How many ridges to draw at a width: 40, or 32 on a phone.
    function ridgeCount(width) {
        return Number(width) > 0 && Number(width) < 500 ? 32 : 40;
    }

    // The stack: for ridge k of count, its place p between rounds (0 at
    // the back), the two rounds it blends, the blend, and which round it
    // is exactly (or -1).
    function ridgeStack(rounds, count) {
        const R = Array.isArray(rounds) ? rounds.length : 0;
        const n = Math.max(1, (count | 0) || 40);
        const out = [];
        if (!R) return out;
        for (let k = 0; k < n; k++) {
            const p = n > 1 ? k / (n - 1) * (R - 1) : 0;
            const a = Math.floor(p + 1e-9), b = Math.min(R - 1, a + 1);
            let f = p - a;
            if (f < 1e-9) f = 0;
            out.push({ k, p, a: Math.min(R - 1, a), b, f, exact: f === 0 ? Math.min(R - 1, a) : -1 });
        }
        // The ridge nearest each round is that round exactly (with 40 ridges
        // and 5 rounds the grid doesn't land on every round), and it and
        // its two neighbours each side carry the round's accent, fading.
        for (let r = 0; r < R; r++) {
            let at = 0, best = Infinity;
            out.forEach((s, i) => { const d = Math.abs(s.p - r); if (d < best) { best = d; at = i; } });
            Object.assign(out[at], { a: r, b: r, f: 0, exact: r });
            for (let d = -2; d <= 2; d++) {
                const s = out[at + d];
                if (!s) continue;
                const w = d === 0 ? 1 : Math.abs(d) === 1 ? 0.55 : 0.25;
                if (!s.accent || s.accent.weight < w) s.accent = { round: r, weight: w };
            }
        }
        return out;
    }

    function ridgeTotalMs(n) {
        return Math.max(0, n - 1) * RIDGE_STAGGER + RIDGE_DRAW;
    }

    // Geometry for a stack of n ridges in a W x H box.
    function ridgeLayout(width, height, count) {
        const W = Math.max(0, Number(width) || 0), H = Math.max(0, Number(height) || 0);
        const n = Math.max(1, count | 0);
        const gutter = Math.max(16, Math.round(H * 0.06));
        const bottom = H - 6;
        // Tallest bump (overlaps can stack past 1) must clear the top.
        const gap = Math.max(1, (bottom - 6) / (n - 1 + RIDGE_SPAN * RIDGE_CAP));
        const amp = gap * RIDGE_SPAN;
        const out = [];
        for (let i = 0; i < n; i++) out.push({ base: bottom - (n - 1 - i) * gap, x0: gutter, x1: W - 2, amp });
        return out;
    }

    // Per rounds array: the rounds' bare profiles, kept across frames.
    const ridgeCache = typeof WeakMap === 'function' ? new WeakMap() : null;
    function ridgeBases(rounds, samples) {
        let hit = ridgeCache && ridgeCache.get(rounds);
        if (hit && hit.samples === samples && hit.sig === ridgeSig(rounds)) return hit;
        hit = {
            samples, sig: ridgeSig(rounds),
            profiles: rounds.map(r => ridgeProfile(r, samples, null)),
            deep: rounds.map(r => ridgeEvents(r).filter(e => e.deep)),
        };
        if (ridgeCache) ridgeCache.set(rounds, hit);
        return hit;
    }

    function ridgeSig(rounds) {
        return rounds.map(r => (r && Array.isArray(r.events) ? r.events.length : -1)).join(',');
    }

    // rounds: [{ events, roundMs }]. progress 0..1 runs the draw-in: each
    // ridge 40 ms after the one behind it, sweeping left to right over
    // 250 ms. Returns what was drawn, back to front.
    function drawRidges(ctx, width, height, rounds, colors, progress) {
        const c = colors || {};
        const W = Math.max(0, Number(width) || 0), H = Math.max(0, Number(height) || 0);
        const list = Array.isArray(rounds) ? rounds : [];
        if (c.bg) { ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H); }
        else if (ctx.clearRect) ctx.clearRect(0, 0, W, H);
        const out = [];
        if (W < 60 || H < 40 || !list.length) return out;
        const N = ridgeCount(W), S = RIDGE_SAMPLES;
        const stack = ridgeStack(list, N);
        const L = ridgeLayout(W, H, N);
        const B = ridgeBases(list, S);
        const t = (progress == null ? 1 : unit(progress)) * ridgeTotalMs(N);
        const prof = new Float32Array(S);
        const bg = c.bg || '#fff', ink = c.text || '#000';
        ctx.save();
        ctx.lineWidth = 1;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'butt';
        for (const s of stack) {
            const k = Math.min(1, Math.max(0, (t - s.k * RIDGE_STAGGER) / RIDGE_DRAW));
            if (k <= 0) continue;
            const g = L[s.k];
            const pa = B.profiles[s.a], pb = B.profiles[s.b];
            for (let i = 0; i < S; i++) prof[i] = pa[i] + (pb[i] - pa[i]) * s.f;
            ridgeNoise(prof, s.k + 1, RIDGE_NOISE);
            const span = g.x1 - g.x0;
            const last = Math.max(1, Math.round((S - 1) * (1 - Math.pow(1 - k, 2))));
            const X = i => g.x0 + span * i / (S - 1);
            const Y = i => g.base - Math.max(-0.5, prof[i]) * g.amp;
            const line = (from, to) => {
                ctx.beginPath();
                ctx.moveTo(X(from), Y(from));
                for (let i = from + 1; i <= to; i++) ctx.lineTo(X(i), Y(i));
            };
            // Fill under the line to the bottom, so this ridge hides those behind.
            line(0, last);
            ctx.lineTo(X(last), H);
            ctx.lineTo(X(0), H);
            ctx.closePath();
            ctx.globalAlpha = 1;
            ctx.fillStyle = bg;
            ctx.fill();
            line(0, last);
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = ink;
            ctx.stroke();
            // The deep cut's bump, in accent, on the ridges nearest its round.
            if (c.accent && s.accent) {
                for (const e of B.deep[s.accent.round] || []) {
                    const i0 = Math.max(0, Math.floor((e.u - 2 * e.sigma) * (S - 1)));
                    const i1 = Math.min(last, Math.ceil((e.u + 2 * e.sigma) * (S - 1)));
                    if (i1 <= i0) continue;
                    line(i0, i1);
                    ctx.globalAlpha = s.accent.weight;
                    ctx.strokeStyle = c.accent;
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;
            out.push({ index: s.k, base: g.base, x0: g.x0, x1: g.x1, end: X(last), exact: s.exact });
        }
        // Only the ends are named: the first round at the back, the last in front.
        const fs = Math.max(10, Math.round(H * 0.036));
        ctx.font = `400 ${fs}px ${MONO}`;
        ctx.fillStyle = c.muted || '#888';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const backOn = out.length > 0, frontOn = out.length === N;
        if (backOn) ctx.fillText('1', L[0].x0 - 5, L[0].base);
        if (frontOn && list.length > 1) ctx.fillText(String(list.length), L[N - 1].x0 - 5, L[N - 1].base);
        ctx.restore();
        return out;
    }

    // The round as a ripple: the "Your day" ridges for one round, live. A
    // stack of lines, back to front, each filled with the page so nearer
    // ones hide farther ones, all carrying the same bumps, smaller toward
    // the back, so one answer reads as one ripple echoed backward. While
    // playing every bump is the same height (pace, not value); at reveal 1
    // each stands at its true height and the deep cut turns accent on the
    // front three lines.
    const RIPPLE_UNIFORM = 3.5 / RIDGE_SPAN;  // a bump during the round, as a share of a deep cut
    const RIPPLE_POP = 4.5 / RIDGE_SPAN;      // where a new bump overshoots to
    const RIPPLE_POP_MS = 180;
    const RIPPLE_BACK = 0.45;                 // the back line's share of the front line's bumps
    const RIPPLE_NOISE = 0.03;

    // How many ripple lines at a width: 12, or 9 on a phone.
    function rippleCount(width) {
        return Number(width) > 0 && Number(width) < 500 ? 9 : 12;
    }

    // A new bump's height over its first RIPPLE_POP_MS: up past the
    // uniform height to the overshoot, then settling back.
    function ripplePop(ageMs) {
        const k = Math.max(0, Number(ageMs) || 0) / RIPPLE_POP_MS;
        if (k >= 1) return RIPPLE_UNIFORM;
        if (k < 0.4) { const u = k / 0.4; return RIPPLE_POP * (1 - (1 - u) * (1 - u)); }
        const u = (k - 0.4) / 0.6;
        return RIPPLE_POP + (RIPPLE_UNIFORM - RIPPLE_POP) * u * u * (3 - 2 * u);
    }

    // events: [{ t (ms), points, deepCut? }]; only those at or before
    // elapsedMs show. opts: { lines, reveal (0..1), playhead (bool), pop:
    // { t, age } (the bump at t is age ms old) }. Returns { lines: [{ base,
    // factor }], bumps: [{ u, x, h }] (h in px on the front line),
    // playhead: x or null }.
    function drawRipples(ctx, width, height, events, elapsedMs, roundMs, colors, opts) {
        const c = colors || {};
        const o = opts || {};
        const W = Math.max(0, Number(width) || 0), H = Math.max(0, Number(height) || 0);
        if (c.bg) { ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H); }
        else if (ctx.clearRect) ctx.clearRect(0, 0, W, H);
        const out = { lines: [], bumps: [], playhead: null };
        if (W < 20 || H < 20) return out;
        const total = Number(roundMs) > 0 ? Number(roundMs) : ROUND_MS;
        const elapsed = Math.min(total, Math.max(0, Number(elapsedMs) || 0));
        const r = o.reveal == null ? 0 : unit(o.reveal);
        const n = Math.max(1, (Number(o.lines) | 0) || rippleCount(W));
        const S = RIDGE_SAMPLES;
        const gap = Math.max(2, Math.min(7, (H - 12) / (n - 1 + RIDGE_SPAN)));
        const amp = gap * RIDGE_SPAN;            // px for a deep cut on the front line
        const bottom = H - 6, x0 = 0, x1 = W, span = x1 - x0;
        const pop = o.pop && Number.isFinite(Number(o.pop.t)) ? o.pop : null;
        const sigma0 = 0.012; // narrow while uniform, so quick answers stay separate bumps
        const list = (Array.isArray(events) ? events : [])
            .filter(e => e && Number.isFinite(Number(e.t)) && Number(e.t) >= 0 && Number(e.t) <= elapsed)
            .map(e => {
                const pts = Math.min(100, Math.max(0, Number(e.points) || 0));
                let h = RIPPLE_UNIFORM + (pts / 100 - RIPPLE_UNIFORM) * r;
                if (r === 0 && pop && Number(e.t) === Number(pop.t)) h = ripplePop(pop.age);
                return { u: ridgeU(e.t, total), h, sigma: sigma0 + (ridgeSigma(pts) - sigma0) * r, deep: !!e.deepCut || pts >= 100 };
            });

        // One profile, shared by every line.
        const base = new Float32Array(S);
        for (const e of list) {
            const s2 = 2 * e.sigma * e.sigma;
            const lo = Math.max(0, Math.floor((e.u - 4 * e.sigma) * (S - 1)));
            const hi = Math.min(S - 1, Math.ceil((e.u + 4 * e.sigma) * (S - 1)));
            for (let i = lo; i <= hi; i++) {
                const d = i / (S - 1) - e.u;
                base[i] += e.h * Math.exp(-d * d / s2);
            }
            out.bumps.push({ u: e.u, x: x0 + span * e.u, h: e.h * amp, deep: e.deep });
        }
        for (let i = 0; i < S; i++) if (base[i] > 1) base[i] = 1 + (RIDGE_CAP - 1) * Math.tanh((base[i] - 1) / (RIDGE_CAP - 1));

        const prof = new Float32Array(S);
        const bg = c.bg || '#fff', ink = c.text || '#000';
        const X = i => x0 + span * i / (S - 1);
        ctx.save();
        ctx.lineWidth = 1;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'butt';
        for (let k = 0; k < n; k++) {
            const factor = n > 1 ? RIPPLE_BACK + (1 - RIPPLE_BACK) * k / (n - 1) : 1;
            const lb = bottom - (n - 1 - k) * gap;
            for (let i = 0; i < S; i++) prof[i] = base[i] * factor;
            ridgeNoise(prof, k + 1, RIPPLE_NOISE);
            const Y = i => lb - Math.max(-0.5, prof[i]) * amp;
            const line = (from, to) => {
                ctx.beginPath();
                ctx.moveTo(X(from), Y(from));
                for (let i = from + 1; i <= to; i++) ctx.lineTo(X(i), Y(i));
            };
            line(0, S - 1);
            ctx.lineTo(X(S - 1), H);
            ctx.lineTo(X(0), H);
            ctx.closePath();
            ctx.globalAlpha = 1;
            ctx.fillStyle = bg;
            ctx.fill();
            line(0, S - 1);
            ctx.globalAlpha = 0.85;
            ctx.strokeStyle = ink;
            ctx.stroke();
            // Revealed: the deep cut in accent on the front three lines.
            const w = k === n - 1 ? 1 : k === n - 2 ? 0.55 : k === n - 3 ? 0.25 : 0;
            if (r >= 1 && c.accent && w > 0) {
                for (const e of list) {
                    if (!e.deep) continue;
                    const i0 = Math.max(0, Math.floor((e.u - 2 * e.sigma) * (S - 1)));
                    const i1 = Math.min(S - 1, Math.ceil((e.u + 2 * e.sigma) * (S - 1)));
                    if (i1 <= i0) continue;
                    line(i0, i1);
                    ctx.globalAlpha = w;
                    ctx.strokeStyle = c.accent;
                    ctx.stroke();
                }
            }
            out.lines.push({ base: lb, factor });
        }
        // The clock: a dashed hairline at where now falls across the stack.
        if (o.playhead) {
            const x = Math.round(x0 + span * ridgeU(elapsed, total)) + 0.5;
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = c.muted || '#888';
            if (ctx.setLineDash) ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(x, 2);
            ctx.lineTo(x, H);
            ctx.stroke();
            if (ctx.setLineDash) ctx.setLineDash([]);
            out.playhead = x;
        }
        ctx.restore();
        return out;
    }

    // The 1200x630 share card. data: { title, total, tier, url, roundMs,
    // rounds: [{ prompt, score, events? }] }: the words along the top, the
    // day as ridges across the lower 60%.
    function drawShareImage(ctx, width, height, data, colors) {
        const c = colors || {};
        const d = data || {};
        const W = Number(width) || 1200, H = Number(height) || 630;
        const pad = 64;
        ctx.save();
        ctx.fillStyle = c.bg || '#fff';
        ctx.fillRect(0, 0, W, H);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';

        // Top left: title, then the total with its tier beside it.
        ctx.fillStyle = c.muted || '#888';
        ctx.font = `500 22px ${SANS}`;
        ctx.fillText(fitText(ctx, d.title || 'Turbo Cut', 520), pad, pad + 4);
        const total = String(d.total || 0);
        let size = 112;
        ctx.font = `400 ${size}px ${SERIF}`;
        while (size > 48 && textWidth(ctx, total) > 520) {
            size -= 8;
            ctx.font = `400 ${size}px ${SERIF}`;
        }
        const totalY = pad + 4 + 20 + Math.round(size * 0.74);
        ctx.fillStyle = c.text || '#000';
        ctx.fillText(total, pad - Math.round(size * 0.04), totalY);
        let x = pad + textWidth(ctx, total) + 10;
        ctx.fillStyle = c.muted || '#888';
        ctx.font = `500 22px ${SANS}`;
        ctx.fillText('pts', x, totalY);
        x += textWidth(ctx, 'pts') + 32;
        if (d.tier) {
            ctx.fillStyle = c.accent || c.text || '#000';
            ctx.font = `italic 400 34px ${SERIF}`;
            ctx.fillText(fitText(ctx, d.tier, Math.max(80, W - pad - x)), x, totalY);
        }

        // Top right: where to play.
        ctx.textAlign = 'right';
        ctx.fillStyle = c.muted || '#888';
        ctx.font = `400 18px ${SANS}`;
        ctx.fillText(d.url || SHARE_URL, W - pad, pad + 4);
        ctx.textAlign = 'left';

        // Below: the day. The ridge fills use the card's own background.
        const rows = (d.rounds || []).slice(0, PER_DAY);
        if (rows.length) {
            const top = Math.round(H * 0.38);
            ctx.save();
            ctx.translate(pad - 24, top);
            drawRidges(ctx, W - 2 * pad + 24, H - top - 36, rows.map(r => ({ events: r.events, roundMs: d.roundMs || ROUND_MS })),
                Object.assign({}, c, { bg: c.bg || '#fff' }), 1);
            ctx.restore();
        }
        ctx.restore();
    }

    const TurboCut = {
        TURBOCUT_EPOCH, ORDER_SEED, PER_DAY, ROUND_MS, STORAGE_KEY, SHARE_URL, TIERS,
        normalize, editDistance, rawScore, scorePrompt, matchAnswer,
        judgeAnswer, playStats, roundScore, bestPoints, playRound, words, stem, closeness,
        mulberry32, shuffle, cleanPrompts, orderPrompts,
        dayIndexNow, dailyNumberFor, dailyPrompts, randomPrompts,
        emojiFor, tierFor, roundToken, shareText, applyStreak, displayStreak,
        pointsTier, traceGeometry, spikeHeight, drawTrace, TICK, SPIKE_HALF,
        scatterLayout, scatterPos, nearestScatterPoint, drawScatter, plotReveal, drawShareImage,
        LAND_VIEW, LAND_TARGET, LAND_FLOOR, YAW_SWING, PITCH_MIN, PITCH_MAX,
        landHeight, pinHeight, projectPoint, nearestLandscapePoint, drawLandscape,
        diamondVertices, drawDiamond, ridgeLayout, ridgeTotalMs, drawRidges,
        drawRipples, rippleCount, ripplePop,
        ridgeProfile, ridgeStack, ridgeCount, ridgeU, ridgeSigma,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = TurboCut;
    if (root) root.TurboCut = TurboCut;
    if (!root || typeof document === 'undefined') return;

    // ---------------------------------------------------------------- storage

    function emptyStore() {
        return { days: {}, streak: { count: 0, lastDaily: null } };
    }

    function loadStore() {
        try {
            const raw = root.localStorage.getItem(STORAGE_KEY);
            if (!raw) return emptyStore();
            const s = JSON.parse(raw);
            if (!s || typeof s !== 'object') return emptyStore();
            if (!s.days || typeof s.days !== 'object') s.days = {};
            if (!s.streak || typeof s.streak !== 'object') s.streak = { count: 0, lastDaily: null };
            return s;
        } catch (e) {
            return emptyStore();
        }
    }

    function saveStore(s) {
        try {
            root.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        } catch (e) { /* storage unavailable: play continues, nothing persists */ }
    }

    // ---------------------------------------------------------------- DOM helpers

    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k === 'style') el.style.cssText = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) {
            if (c == null || c === false) continue;
            el.append(c instanceof Node ? c : document.createTextNode(String(c)));
        }
        return el;
    }

    const $ = id => document.getElementById(id);
    const reducedMotion = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const now = () => (root.performance && performance.now ? performance.now() : Date.now());

    // Chips are neutral (in or out only) while the clock runs; once it stops
    // they carry the tier.
    function chip(entry, tiered) {
        if (!tiered) return h('li', { class: 'tc-chip', 'data-name': entry.name }, h('span', { class: 'tc-chip-name', text: entry.name }));
        const tier = pointsTier(entry.points);
        return h('li', { class: `tc-chip is-${tier}`, 'data-name': entry.name },
            tier === 'deep' ? h('span', { class: 'tc-chip-mark', 'aria-hidden': 'true', text: '◆' }) : null,
            h('span', { class: 'tc-chip-name', text: entry.name }),
            tier === 'deep' ? h('span', { class: 'visually-hidden', text: ' (deep cut)' }) : null,
            h('span', { class: 'tc-chip-pts', text: `+${entry.points}` }));
    }

    // One row per answer the player gave, in the order typed: what it scored
    // and why. Only the player's own answers appear, never anyone else's.
    function playTable(answers) {
        const list = answers || [];
        if (!list.length) return h('p', { class: 'tc-muted tc-play-none', text: 'Nothing in. The clock wins this one.' });
        const num = text => h('span', { class: 'tc-num', text });
        const rows = list.map(a => {
            const deep = pointsTier(a.points) === 'deep';
            const st = playStats(a);
            const first = st.firstBy == null ? null
                : st.firstBy === 'most' ? h('span', { class: 'tc-play-first' }, 'most people’s first pick')
                    : st.firstBy === 0 ? h('span', { class: 'tc-play-first' }, h('span', { class: 'tc-play-k', text: 'named first by ' }), 'almost nobody')
                        : h('span', { class: 'tc-play-first' }, h('span', { class: 'tc-play-k', text: 'named first by ' }), num('1'), h('span', { class: 'tc-play-k', text: ' in ' }), num(String(st.firstBy)));
            const known = st.knownTo == null ? null
                : h('span', { class: 'tc-play-known' }, h('span', { class: 'tc-play-k', text: 'known to ' }), num(`${st.knownTo}%`));
            return h('li', { class: 'tc-play-row' + (deep ? ' is-deep' : ''), 'data-name': a.name },
                h('span', { class: 'tc-play-name' },
                    deep ? h('span', { class: 'tc-play-mark', 'aria-hidden': 'true', text: '◆' }) : null,
                    a.name,
                    deep ? h('span', { class: 'visually-hidden', text: ' (deep cut)' }) : null),
                h('span', { class: 'tc-play-pts' }, `+${Number(a.points) || 0}`, h('span', { class: 'visually-hidden', text: ' points' })),
                first || h('span', { class: 'tc-play-first', 'aria-hidden': 'true' }),
                known || h('span', { class: 'tc-play-known', 'aria-hidden': 'true' }));
        });
        return h('div', { class: 'tc-play' },
            h('ol', { class: 'tc-play-rows', 'aria-label': 'Your answers, scored' }, rows));
    }

    // Size a canvas's backing store to its CSS box at the device pixel ratio
    // and return a context drawing in CSS pixels.
    function fitCanvas(canvas) {
        const w = canvas.clientWidth, ht = canvas.clientHeight;
        if (!w || !ht) return null;
        const dpr = Math.min(3, Math.max(1, root.devicePixelRatio || 1));
        const bw = Math.round(w * dpr), bh = Math.round(ht * dpr);
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (!ctx) return null;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, w, h: ht };
    }

    const canSaveImage = typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.toBlob;

    // ---------------------------------------------------------------- game

    function init() {
        const els = {
            root: $('turbocut'),
            mode: $('tc-mode'),
            progress: $('tc-progress'),
            seconds: $('tc-seconds'),
            ink: $('tc-ink-fill'),
            intro: $('tc-intro'),
            ready: $('tc-ready'),
            round: $('tc-round'),
            results: $('tc-results'),
            readyLabel: $('tc-ready-label'),
            start: $('tc-start'),
            prompt: $('tc-prompt'),
            note: $('tc-note'),
            trace: $('tc-trace'),
            form: $('tc-form'),
            input: $('tc-input'),
            submit: $('tc-submit'),
            flash: $('tc-flash'),
            chips: $('tc-chips'),
            next: $('tc-next'),
            roundEnd: $('tc-round-end'),
            play: $('tc-play'),
            field: $('tc-field'),
            count: $('tc-count'),
            sr: $('tc-sr'),
        };
        if (!els.intro || !els.round || !els.root) return;

        const all = cleanPrompts(root.TURBOCUT_PROMPTS);
        const dayIndex = dayIndexNow();
        const dailyNumber = dailyNumberFor(dayIndex);
        const today = dailyPrompts(all, dayIndex);
        const byId = new Map(all.map(p => [p.id, p]));

        // mode: 'daily' | 'endless'; phase: 'intro' | 'ready' | 'round' | 'over' | 'results'
        const game = { mode: 'daily', phase: 'intro', prompts: [], index: 0, rounds: [], current: null };
        let raf = 0, clock = 0, advanceTimer = 0, flashTimer = 0, pulseTimer = 0, readyAt = 0, overAt = 0;
        let traceElapsed = 0;          // what the live trace last showed
        let liveReveal = 0;            // live trace: 0 uniform ticks, 1 true heights
        let chipTimers = [];           // short beats: duplicate highlights, the miss beat
        let missing = false;           // a rejected answer is on show; input is read-only
        let redrawers = [];            // scatter and result canvases on screen
        let plotAborts = [];           // detach scatter pointer handlers
        let observer = null;           // reveals result traces as they scroll in
        let activePlot = null;         // the scatter currently showing a label
        const live3d = new Set();      // landscapes on screen that may want frames
        let loop3d = 0;                // the one rAF loop that drives them
        let seen3d = null;             // tracks which landscapes are on screen

        function readColors() {
            const cs = getComputedStyle(els.root);
            const v = name => cs.getPropertyValue(name).trim();
            return { line: v('--tc-line'), accent: v('--tc-accent'), muted: v('--color-muted'), bg: v('--color-bg'), text: v('--color-text') };
        }

        function show(section) {
            for (const s of [els.intro, els.ready, els.round, els.results]) s.hidden = s !== section;
        }

        function setHeader(progress) {
            els.mode.textContent = game.mode === 'endless' ? 'Endless' : `Turbo Cut #${dailyNumber}`;
            els.progress.textContent = progress || '';
            els.progress.hidden = !progress;
        }

        function scrollTop() {
            root.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
        }

        function stopClocks() {
            cancelAnimationFrame(raf);
            clearInterval(clock);
            clearTimeout(advanceTimer);
            clearTimeout(flashTimer);
            for (const t of chipTimers) clearTimeout(t);
            chipTimers = [];
            endMiss();
            if (els.play) { els.play.replaceChildren(); els.play.hidden = true; }
            raf = clock = advanceTimer = flashTimer = 0;
            els.root.classList.remove('is-live', 'is-low', 'is-over');
            if (observer) { observer.disconnect(); observer = null; }
            dropPlots();
        }

        // -------- canvases

        function dropPlots() {
            for (const a of plotAborts) a.abort();
            plotAborts = [];
            redrawers = [];
            activePlot = null;
            if (seen3d) { seen3d.disconnect(); seen3d = null; }
            live3d.clear();
            cancelAnimationFrame(loop3d);
            loop3d = 0;
        }

        // Landscapes drift and spring back on one shared frame loop, only
        // while on screen and while the page is visible.
        function landLoop() {
            loop3d = 0;
            if (document.hidden) return;
            const t = now();
            let more = false;
            for (const pl of live3d) if (pl.frame(t)) more = true;
            if (more) loop3d = requestAnimationFrame(landLoop);
        }

        function kickLand() {
            if (!loop3d && !document.hidden && live3d.size) loop3d = requestAnimationFrame(landLoop);
        }

        function pauseLand() {
            cancelAnimationFrame(loop3d);
            loop3d = 0;
        }

        document.addEventListener('visibilitychange', () => { if (document.hidden) pauseLand(); else kickLand(); });
        root.addEventListener('pagehide', pauseLand);
        root.addEventListener('pageshow', kickLand);

        function watchLand(plot) {
            if (typeof IntersectionObserver !== 'function') { live3d.add(plot); kickLand(); return; }
            if (!seen3d) {
                seen3d = new IntersectionObserver(entries => {
                    for (const e of entries) {
                        const pl = e.target.__plot;
                        if (!pl) continue;
                        if (e.isIntersecting) live3d.add(pl);
                        else live3d.delete(pl);
                    }
                    kickLand();
                });
            }
            plot.canvas.__plot = plot;
            seen3d.observe(plot.canvas);
        }

        // The live ripple. During the round every valid answer is the same
        // bump: pace, not value; the newest pops in. When time runs out the
        // bumps rise to what each scored, and the deep cut turns accent once
        // the rise is done.
        function drawLive(elapsed) {
            const c = game.current;
            const f = fitCanvas(els.trace);
            traceElapsed = elapsed;
            if (!f || !c) return;
            const over = game.phase === 'over';
            let pop = null;
            if (!over && !reducedMotion() && c.events.length) {
                const e = c.events[c.events.length - 1];
                const age = now() - (e.at || 0);
                if (age >= 0 && age < 180) pop = { t: e.t, age };
            }
            drawRipples(f.ctx, f.w, f.h, c.events, elapsed, ROUND_MS, readColors(),
                { lines: rippleCount(f.w), reveal: over ? liveReveal : 0, playhead: !over, pop });
        }

        let redrawQueued = 0;
        function redrawAll() {
            if (redrawQueued) return;
            redrawQueued = requestAnimationFrame(() => {
                redrawQueued = 0;
                if ((game.phase === 'round' || game.phase === 'over') && game.current) drawLive(traceElapsed);
                if (game.phase === 'results' || game.phase === 'over') for (const fn of redrawers) fn();
            });
        }

        root.addEventListener('resize', redrawAll);
        if (typeof MutationObserver === 'function') {
            new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        }
        if (document.fonts) {
            if (document.fonts.ready) document.fonts.ready.then(redrawAll, () => {});
            if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', redrawAll);
        }

        // -------- intro

        function renderIntro() {
            stopClocks();
            game.mode = 'daily';
            game.phase = 'intro';
            setHeader('');
            els.intro.replaceChildren(
                h('h2', { class: 'tc-title', text: `Turbo Cut #${dailyNumber}` }),
                h('p', { class: 'tc-lede' },
                    'Five prompts, 30 seconds each. Name as many as you can. ',
                    'The rarer an answer, as long as people would still recognise it, the more it scores.'),
                h('ul', { class: 'tc-legend', 'aria-label': 'How scoring works' },
                    h('li', null, h('span', { class: 'tc-legend-k', text: 'Obvious' }), ' answers score a few points.'),
                    h('li', null, h('span', { class: 'tc-legend-k', text: 'Rare but familiar' }), ' answers score a lot. The rarest of all, the deep cut, scores 100.'),
                    h('li', null, h('span', { class: 'tc-legend-k', text: 'Every valid answer' }), ' adds to the round, so keep typing. Points stay hidden until the clock runs out.')),
                today.length
                    ? h('div', { class: 'tc-actions' },
                        h('button', { type: 'button', class: 'tc-btn tc-btn-primary', onclick: startDaily, text: 'Play today’s' }),
                        h('button', { type: 'button', class: 'tc-btn tc-btn-quiet', onclick: startEndless, text: 'Endless' }))
                    : h('p', { class: 'tc-muted', text: 'The prompts didn’t load. Try refreshing the page.' })
            );
            show(els.intro);
        }

        // -------- flow

        function startDaily() {
            const rec = loadStore().days[dailyNumber];
            game.mode = 'daily';
            game.prompts = today;
            game.rounds = rec && Array.isArray(rec.rounds) ? rec.rounds.slice(0, today.length) : [];
            game.index = game.rounds.length;
            if (game.index >= game.prompts.length) finishDaily();
            else renderReady();
        }

        function startEndless() {
            stopClocks();
            game.mode = 'endless';
            game.prompts = randomPrompts(all, PER_DAY, today.map(p => p.id));
            game.rounds = [];
            game.index = 0;
            if (!game.prompts.length) renderIntro();
            else renderReady();
        }

        function roundLabel() {
            return `Round ${game.index + 1} / ${game.prompts.length}`;
        }

        // The prompt stays hidden until Start, so nobody gets to pre-think.
        function renderReady() {
            stopClocks();
            game.phase = 'ready';
            setHeader(roundLabel());
            els.readyLabel.textContent = game.prompts.length > 1
                ? `Round ${game.index + 1} of ${game.prompts.length}`
                : 'One round';
            show(els.ready);
            scrollTop();
            readyAt = now();
            els.start.focus({ preventScroll: true });
        }

        function startRound() {
            if (game.phase !== 'ready' || now() - readyAt < 350) return;
            const p = game.prompts[game.index];
            game.phase = 'round';
            game.current = { promptId: p.id, answers: [], events: [], started: now() };
            setHeader(roundLabel());
            els.prompt.textContent = p.prompt;
            els.note.textContent = p.note || '';
            els.note.hidden = !p.note;
            els.chips.replaceChildren();
            els.flash.textContent = '';
            els.flash.className = 'tc-flash';
            els.count.textContent = '';
            els.field.classList.remove('is-hit', 'is-miss', 'is-dup');
            els.sr.textContent = '';
            endMiss();
            els.input.value = '';
            els.input.disabled = false;
            els.submit.disabled = true;
            els.next.hidden = true;
            els.roundEnd.hidden = true;
            dropPlots();
            if (els.play) { els.play.replaceChildren(); els.play.hidden = true; }
            liveReveal = 0;
            els.root.classList.remove('is-low', 'is-over');
            els.root.classList.add('is-live');
            els.root.style.setProperty('--tc-under', '1');
            els.seconds.textContent = String(ROUND_MS / 1000);
            els.ink.style.transform = 'scaleX(1)';
            show(els.round);
            drawLive(0);
            scrollTop();
            els.input.focus({ preventScroll: true });
            lastSecond = -1;
            // rAF draws smoothly; the interval keeps time (and ends the round)
            // even when frames are paused in a background tab.
            clock = setInterval(update, 200);
            frame();
        }

        let lastSecond = -1;
        function frame() {
            if (update()) raf = requestAnimationFrame(frame);
        }

        // Returns true while the round is still running.
        function update() {
            const c = game.current;
            if (!c || game.phase !== 'round') return false;
            const elapsed = Math.min(ROUND_MS, now() - c.started);
            const left = ROUND_MS - elapsed;
            const secs = Math.ceil(left / 1000);
            const still = reducedMotion();
            // Reduced motion: everything steps once a second instead of gliding.
            const frac = still ? secs / (ROUND_MS / 1000) : left / ROUND_MS;
            els.ink.style.transform = `scaleX(${frac.toFixed(4)})`;
            const low = left > 0 && secs <= 5;
            els.root.style.setProperty('--tc-under', low ? (still ? secs / 5 : left / 5000).toFixed(4) : '1');
            const lastT = c.events.length ? c.events[c.events.length - 1].t : 0;
            drawLive(still ? Math.max(ROUND_MS - secs * 1000, lastT) : elapsed);
            if (secs !== lastSecond) {
                lastSecond = secs;
                els.seconds.textContent = String(secs);
                els.root.classList.toggle('is-low', low);
                if (secs === 10) els.sr.textContent = '10 seconds left';
            }
            if (left > 0) return true;
            endRound();
            return false;
        }

        function flash(text, kind) {
            clearTimeout(flashTimer);
            els.flash.textContent = text;
            els.flash.className = `tc-flash is-${kind}`;
            // Restart the fade even when the same message repeats.
            void els.flash.offsetWidth;
            els.flash.classList.add('is-on');
            flashTimer = setTimeout(() => els.flash.classList.remove('is-on'), 1100);
        }

        els.input.addEventListener('input', () => {
            els.submit.disabled = !els.input.value.trim() || game.phase !== 'round' || missing;
        });

        // During a round the player only learns in or out; points wait for the clock.
        els.form.addEventListener('submit', event => {
            event.preventDefault();
            if (game.phase !== 'round' || !game.current || missing) return;
            const p = game.prompts[game.index];
            const r = judgeAnswer(p, game.current.answers, els.input.value);
            if (r.status === 'empty') return;
            els.submit.disabled = true;
            els.input.focus({ preventScroll: true });
            if (r.status === 'miss') {
                // The rejected text stays a beat, struck through, then clears.
                pulse('miss');
                startMiss();
                return flash('✗ not on our list', 'miss');
            }
            els.input.value = '';
            if (r.status === 'dup') {
                pulse('dup');
                remind(r.match.answer.name);
                return flash(`already have ${r.match.answer.name}`, 'dup');
            }
            const c = game.current;
            const t = Math.round(Math.min(ROUND_MS, Math.max(0, now() - c.started)));
            c.answers.push(r.entry);
            c.events.push({ t, points: r.entry.points, at: now() });
            const li = chip(r.entry, false);
            li.classList.add('is-new');
            setTimeout(() => li.classList.remove('is-new'), 700);
            els.chips.append(li);
            drawLive(Math.max(traceElapsed, t));
            pulse('hit');
            deposit(li);
            setCount(c.answers.length);
            flash(`✓ ${r.entry.name}`, 'ok');
        });

        const MISS_MS = 350;
        let missTimer = 0;
        function startMiss() {
            missing = true;
            els.input.readOnly = true;
            els.input.classList.add('is-struck');
            clearTimeout(missTimer);
            missTimer = setTimeout(endMiss, MISS_MS);
        }

        function endMiss() {
            clearTimeout(missTimer);
            missTimer = 0;
            if (!missing) return;
            missing = false;
            els.input.readOnly = false;
            els.input.classList.remove('is-struck');
            els.input.value = '';
            els.submit.disabled = true;
        }

        // A repeat: the chip already banked gives a small wiggle and a brief
        // muted highlight, so the player sees which one they have.
        function remind(name) {
            const li = Array.from(els.chips.children).find(el => el.dataset && el.dataset.name === name);
            if (!li) return;
            li.classList.remove('is-again');
            void li.offsetWidth;
            li.classList.add('is-again');
            clearTimeout(li.__again);
            li.__again = setTimeout(() => li.classList.remove('is-again'), 1000);
            chipTimers.push(li.__again);
        }

        // A small accent dot runs from the end of the input to the new chip.
        function deposit(li) {
            if (reducedMotion() || !li.animate) return;
            const host = els.round.getBoundingClientRect();
            const from = els.input.getBoundingClientRect();
            const to = li.getBoundingClientRect();
            if (!to.width) return;
            const x0 = from.right - host.left - 3, y0 = from.bottom - host.top - 3;
            const x1 = to.left - host.left + to.width / 2 - 3, y1 = to.top - host.top + to.height / 2 - 3;
            const d = h('span', { class: 'tc-deposit', 'aria-hidden': 'true' });
            els.round.append(d);
            const a = d.animate([
                { transform: `translate(${x0}px, ${y0}px)`, opacity: 1 },
                { transform: `translate(${x1}px, ${y1}px)`, opacity: 0.25 },
            ], { duration: 200, easing: 'cubic-bezier(.3, .7, .4, 1)' });
            a.onfinish = a.oncancel = () => d.remove();
        }

        // A short visual beat on the input: accent pulse for a hit, shake for a
        // miss, muted pulse for a duplicate.
        function pulse(kind) {
            const f = els.field;
            f.classList.remove('is-hit', 'is-miss', 'is-dup');
            void f.offsetWidth;
            f.classList.add(`is-${kind}`);
            clearTimeout(pulseTimer);
            pulseTimer = setTimeout(() => f.classList.remove('is-hit', 'is-miss', 'is-dup'), 450);
        }

        function setCount(n) {
            els.count.textContent = n ? `${n} in` : '';
            els.count.classList.remove('is-bump');
            void els.count.offsetWidth;
            els.count.classList.add('is-bump');
        }

        function endRound() {
            if (game.phase !== 'round') return;
            cancelAnimationFrame(raf);
            clearInterval(clock);
            game.phase = 'over';
            overAt = now();
            lastSecond = -1;
            const c = game.current;
            const round = {
                promptId: c.promptId,
                answers: c.answers.slice(),
                score: roundScore(c.answers),
                events: c.events.map(e => ({ t: e.t, points: e.points })),
            };
            game.rounds[game.index] = round;
            game.rounds.length = game.index + 1;
            if (game.mode === 'daily') saveDaily();

            endMiss();
            els.input.disabled = true;
            els.submit.disabled = true;
            els.root.classList.remove('is-low');
            els.root.classList.add('is-over');
            els.root.style.setProperty('--tc-under', '0');
            els.seconds.textContent = '0';
            els.ink.style.transform = 'scaleX(0)';
            const n = round.answers.length;
            els.sr.textContent = `Time. ${n} ${n === 1 ? 'answer' : 'answers'} in, ${round.score} points this round.`;
            flash('Time', 'time');
            els.roundEnd.replaceChildren(
                h('span', { class: 'tc-round-end-count' }, `${n} in`),
                h('span', { class: 'tc-round-end-score', style: `min-width:${String(round.score).length}ch` }, String(round.score)),
                h('span', { class: 'tc-round-end-unit' }, 'pts'),
            );
            els.roundEnd.hidden = false;
            // The reveal: this round's points, and only this player's answers.
            revealRound(round);
            const last = game.index >= game.prompts.length - 1;
            els.next.textContent = last ? 'See results' : 'Next';
            els.next.hidden = false;
            els.next.focus({ preventScroll: true });
        }

        // The round-end plot: the label with a count (never names), the
        // canvas, the caption. Returns { block, plot } or null.
        function roundPlot(scored, got, prompt) {
            if (!scored.length) return null;
            const plot = resultLandscape(scored, got, prompt);
            const block = h('div', { class: 'tc-play-plot' },
                h('p', { class: 'tc-plot-head', 'aria-hidden': 'true' },
                    h('span', { text: 'Where your answers sit' }),
                    h('span', null, h('span', { class: 'tc-num', text: String(got.size) }), ' of ', h('span', { class: 'tc-num', text: String(scored.length) }))),
                h('figure', { class: 'tc-plot' },
                    plot.canvas));
            return { block, plot };
        }

        // The player's answers in landing order: as typed, the deep cut last.
        function landingOrder(answers, scored) {
            const deep = scored.find(s => s.deepCut);
            const isDeep = a => !!deep && a.name === deep.answer.name;
            return answers.filter(a => !isDeep(a)).concat(answers.filter(isDeep));
        }

        // Time's up. One timeline: the ticks rise to true heights (500 ms) and
        // the deep cut spike turns accent; the plot appears with only the
        // field; then each answer flies in from the common-and-unknown corner,
        // lands with a ring, and its chip turns over, its row appears and the
        // round total counts up by its points. A missed deep cut pulses once
        // at the end. Reduced motion: everything lands at once.
        function revealRound(round) {
            const still = reducedMotion();
            const p = game.prompts[game.index];
            const scored = p ? scorePrompt(p) : [];
            const got = new Set(round.answers.map(a => a.name));
            const deep = scored.find(s => s.deepCut);
            const order = landingOrder(round.answers, scored);
            const names = order.map(a => a.name);
            const gap = names.length > 1 ? Math.min(110, 1100 / (names.length - 1)) : 110;
            const pulse = !!deep && !got.has(deep.answer.name);
            const diamond = !!deep && got.has(deep.answer.name);

            const table = playTable(round.answers);
            const rp = roundPlot(scored, got, p ? p.prompt : '');
            if (els.play) {
                // The plot sits above the table here so the flights stay near the chips.
                els.play.replaceChildren(...[rp && rp.block, table].filter(Boolean));
                els.play.hidden = false;
            }
            const rows = new Map(Array.from(table.querySelectorAll('.tc-play-row')).map(r => [r.dataset.name, r]));
            const chips = new Map(Array.from(els.chips.children).map(c => [c.dataset.name, c]));
            const scoreEl = els.roundEnd.querySelector('.tc-round-end-score');

            const land = a => {
                const li = chip(a, true);
                if (!still) li.classList.add('is-flip');
                const old = chips.get(a.name);
                if (old && old.isConnected) old.replaceWith(li);
                else els.chips.append(li);
                const row = rows.get(a.name);
                if (row) { row.classList.remove('is-pending'); if (!still) row.classList.add('is-in'); }
            };

            if (still) {
                liveReveal = 1;
                drawLive(ROUND_MS);
                order.forEach(land);
                if (rp) rp.plot.setProgress(null);
                return;
            }

            liveReveal = 0;
            drawLive(ROUND_MS);
            for (const row of rows.values()) row.classList.add('is-pending');
            if (rp) { rp.block.classList.add('is-waiting'); rp.plot.setProgress({ arrive: {}, ring: {}, deep: null }); }
            if (scoreEl) scoreEl.textContent = '0';

            const RISE = 500, PLOT = 600, DOTS = PLOT + 300, TWEEN = 200;
            const ease = k => 1 - Math.pow(1 - k, 3);
            const t0 = now();
            let applied = 0, plotShown = false, traceDone = false, finished = false;
            // Returns true while there is more to show. Frames draw smoothly; a
            // slow interval keeps it moving when frames are paused.
            const tick = () => {
                if (game.phase !== 'over' || finished) return false;
                const t = now() - t0;
                if (!traceDone) {
                    const k = Math.min(1, t / RISE);
                    liveReveal = ease(k);
                    traceDone = k >= 1;
                    drawLive(ROUND_MS);
                }
                if (rp && !plotShown && t >= PLOT) {
                    plotShown = true;
                    rp.block.classList.remove('is-waiting');
                    rp.block.classList.add('is-in');
                    const r = rp.block.getBoundingClientRect();
                    if (r.bottom > (root.innerHeight || 0)) rp.block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
                const r = plotReveal(names, t - DOTS, { gap, pulse, diamond });
                while (applied < r.landed) land(order[applied++]);
                let shown = 0;
                r.lands.forEach((at, i) => {
                    const age = t - DOTS - at;
                    if (age >= 0) shown += (Number(order[i].points) || 0) * ease(Math.min(1, age / TWEEN));
                });
                if (scoreEl) scoreEl.textContent = String(Math.round(shown));
                if (rp) rp.plot.setProgress(r.progress);
                const lastTween = r.lands.length ? r.lands[r.lands.length - 1] + TWEEN : 0;
                if (!traceDone || !r.done || t - DOTS < lastTween) return true;
                finished = true;
                clearInterval(clock);
                if (scoreEl) scoreEl.textContent = String(round.score);
                if (rp) rp.plot.setProgress(null);
                return false;
            };
            const step = () => { if (tick()) raf = requestAnimationFrame(step); };
            clearInterval(clock);
            clock = setInterval(tick, 100);
            raf = requestAnimationFrame(step);
        }

        function advance() {
            if (game.phase !== 'over') return;
            clearTimeout(advanceTimer);
            game.index += 1;
            game.current = null;
            if (game.index < game.prompts.length) renderReady();
            else if (game.mode === 'daily') finishDaily();
            else renderResults(game.rounds, null);
        }

        els.start.addEventListener('click', startRound);
        els.next.addEventListener('click', () => {
            if (now() - overAt >= 250) advance();
        });

        // Enter starts a round from anywhere on the ready screen, and moves on
        // after time runs out.
        document.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.isComposing || event.repeat) return;
            const onButton = event.target && event.target.closest && event.target.closest('button, a, summary');
            if (onButton) return; // buttons handle their own Enter
            if (game.phase === 'ready') { event.preventDefault(); startRound(); }
            else if (game.phase === 'over' && now() - overAt >= 250) { event.preventDefault(); advance(); }
        });

        function saveDaily() {
            const store = loadStore();
            const rec = { rounds: game.rounds.slice() };
            if (game.rounds.length >= game.prompts.length) {
                rec.total = game.rounds.reduce((t, r) => t + (r.score || 0), 0);
                store.streak = applyStreak(store.streak, dailyNumber);
            }
            store.days[dailyNumber] = rec;
            saveStore(store);
        }

        // -------- results

        function finishDaily() {
            stopClocks();
            let rec = loadStore().days[dailyNumber];
            if (!rec || typeof rec.total !== 'number') {
                game.rounds = game.rounds.slice(0, game.prompts.length);
                saveDaily();
                rec = loadStore().days[dailyNumber] ||
                    { rounds: game.rounds, total: game.rounds.reduce((t, r) => t + (r.score || 0), 0) };
            }
            game.mode = 'daily';
            renderResults(rec.rounds || [], rec);
        }

        // The round's ripple, small and static at its true heights: the
        // same look as the live round and "Your day".
        function resultTrace(round, section) {
            if (!Array.isArray(round.events)) return null; // saved before traces existed
            const canvas = h('canvas', { class: 'tc-trace tc-trace-small', 'aria-hidden': 'true' });
            const draw = () => {
                const f = fitCanvas(canvas);
                if (f) drawRipples(f.ctx, f.w, f.h, round.events, ROUND_MS, ROUND_MS, readColors(), { lines: 8, reveal: 1 });
            };
            redrawers.push(draw);
            section.__reveal = draw;
            return canvas;
        }


        // The anonymized landscape. Returns { canvas, draw, setProgress }:
        // while a reveal is running (progress set) nothing can be hovered or
        // turned. Once it is over the camera drifts a little, can be dragged
        // around, and springs back when let go.
        function resultLandscape(scored, got, prompt) {
            const canvas = h('canvas', {
                class: 'tc-land', role: 'img',
                'aria-label': `A landscape of all ${scored.length} answers to “${prompt}”: rarer and better recognised answers stand higher. You got ${got.size} of ${scored.length}.`,
            });
            const SPRING = 0.01, SPRING_MS = 600, DRIFT_MS = 12000, DRIFT_DEG = 3;
            const state = { hover: -1, progress: null, yaw: 0, pitch: 0, drag: null, spring: null, driftAt: 0 };
            const view = { yaw: LAND_VIEW.yaw, pitch: LAND_VIEW.pitch, zoom: 1 };
            const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
            const drifting = () => !state.progress && !!state.driftAt && !reducedMotion();
            const setView = t => {
                const drift = drifting() ? DRIFT_DEG * Math.sin((t - state.driftAt) / DRIFT_MS * Math.PI * 2) : 0;
                view.yaw = clamp(LAND_VIEW.yaw + state.yaw + drift, LAND_VIEW.yaw - YAW_SWING, LAND_VIEW.yaw + YAW_SWING);
                view.pitch = clamp(LAND_VIEW.pitch + state.pitch, PITCH_MIN, PITCH_MAX);
            };
            const draw = () => {
                const f = fitCanvas(canvas);
                if (!f) return;
                setView(now());
                drawLandscape(f.ctx, f.w, f.h, scored, got, readColors(), view, state.progress, state.hover);
            };
            // One frame of the shared loop: spring, drift, draw. True while
            // there is more to come.
            const frame = t => {
                if (state.progress) return false;
                let moving = false;
                if (state.spring && !state.drag) {
                    const age = t - state.spring.at;
                    const k = age >= SPRING_MS ? 0 : (1 + SPRING * age) * Math.exp(-SPRING * age);
                    state.yaw = state.spring.yaw * k;
                    state.pitch = state.spring.pitch * k;
                    if (k === 0) state.spring = null;
                    else moving = true;
                }
                if (!moving && !drifting()) return false;
                draw();
                return true;
            };
            const setProgress = pr => {
                state.progress = pr;
                if (pr) { state.hover = -1; canvas.classList.remove('is-orbit'); }
                else {
                    if (!state.driftAt) state.driftAt = now();
                    canvas.classList.add('is-orbit');
                    kickLand();
                }
                draw();
            };
            const plot = { state, draw, canvas, frame, view };
            canvas.classList.add('is-orbit');
            const set = i => {
                if (i === state.hover) return;
                if (i >= 0 && activePlot && activePlot !== plot) {
                    activePlot.state.hover = -1;
                    activePlot.draw();
                }
                state.hover = i;
                if (i >= 0) activePlot = plot;
                else if (activePlot === plot) activePlot = null;
                draw();
            };
            const pick = (ev, radius) => {
                if (state.progress) return -1;
                const r = canvas.getBoundingClientRect();
                setView(now());
                return nearestLandscapePoint(scored, r.width, r.height, view, ev.clientX - r.left, ev.clientY - r.top, radius, got);
            };
            const ac = typeof AbortController === 'function' ? new AbortController() : null;
            const opts = ac ? { signal: ac.signal } : undefined;
            canvas.addEventListener('pointerdown', ev => {
                if (state.progress || state.drag || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
                state.drag = { id: ev.pointerId, type: ev.pointerType, x: ev.clientX, y: ev.clientY, yaw: state.yaw, pitch: state.pitch, moved: false };
                state.spring = null;
                try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable: drag still works inside */ }
            }, opts);
            canvas.addEventListener('pointermove', ev => {
                const d = state.drag;
                if (d && ev.pointerId === d.id) {
                    const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
                    if (!d.moved && dx * dx + dy * dy > 25) { d.moved = true; canvas.classList.add('is-turning'); if (state.hover >= 0) set(-1); }
                    if (!d.moved) return;
                    state.yaw = clamp(d.yaw + dx * 0.35, -YAW_SWING, YAW_SWING);
                    state.pitch = clamp(d.pitch + dy * 0.25, PITCH_MIN - LAND_VIEW.pitch, PITCH_MAX - LAND_VIEW.pitch);
                    draw();
                    return;
                }
                if (ev.pointerType === 'mouse' && !d) set(pick(ev, 14));
            }, opts);
            const release = (ev, cancelled) => {
                const d = state.drag;
                if (!d || ev.pointerId !== d.id) return;
                state.drag = null;
                canvas.classList.remove('is-turning');
                if (!d.moved) {
                    if (!cancelled && d.type !== 'mouse') {
                        const i = pick(ev, 24);
                        set(i === state.hover ? -1 : i);
                    }
                    return;
                }
                // Let go: spring home, or stay put when motion is reduced.
                if (!reducedMotion()) { state.spring = { yaw: state.yaw, pitch: state.pitch, at: now() }; kickLand(); }
            };
            canvas.addEventListener('pointerup', ev => release(ev, false), opts);
            canvas.addEventListener('pointercancel', ev => release(ev, true), opts);
            canvas.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse' && !state.drag) set(-1); }, opts);
            if (ac) plotAborts.push(ac);
            redrawers.push(draw);
            watchLand(plot);
            return { canvas, draw, setProgress };
        }

        // "Your day": the rounds as ridges, drawn in back to front the first
        // time they scroll into view.
        function dayRidges(rounds) {
            if (!rounds.some(r => r && Array.isArray(r.events))) return null;
            const data = rounds.map(r => ({ events: r && r.events, roundMs: ROUND_MS }));
            const canvas = h('canvas', {
                class: 'tc-ridges', role: 'img',
                'aria-label': `Your day as ${rounds.length} ridges, round 1 at the back: one spike per answer, as tall as it scored.`,
            });
            const state = { progress: reducedMotion() ? 1 : 0 };
            const draw = () => {
                const f = fitCanvas(canvas);
                if (f) drawRidges(f.ctx, f.w, f.h, data, readColors(), state.progress);
            };
            redrawers.push(draw);
            const block = h('figure', { class: 'tc-day' },
                h('p', { class: 'tc-plot-head', 'aria-hidden': 'true' }, h('span', { text: 'Your day' })),
                canvas,
                h('figcaption', { class: 'tc-plot-caption', text: 'Your five rounds, back to front, each answer a bump. Blue is the deep cut.' }));
            let started = false;
            block.__reveal = () => {
                if (started) return;
                started = true;
                if (reducedMotion()) { state.progress = 1; draw(); return; }
                const total = ridgeTotalMs(ridgeCount(canvas.clientWidth)), t0 = now();
                const step = () => {
                    if (game.phase !== 'results' || !canvas.isConnected) return;
                    state.progress = Math.min(1, (now() - t0) / total);
                    draw();
                    if (state.progress < 1) requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            };
            return block;
        }

        function roundSection(round, i) {
            const p = byId.get(round.promptId);
            const answers = round.answers || [];
            const got = new Set(answers.map(a => a.name));
            const section = h('section', { class: 'tc-round-result' });

            const head = h('div', { class: 'tc-round-head' },
                h('h3', { class: 'tc-round-prompt' },
                    h('span', { class: 'tc-round-num', text: `${i + 1}` }),
                    p ? p.prompt : round.promptId),
                h('span', { class: 'tc-round-total' },
                    h('span', { class: 'tc-sum-emoji', 'aria-hidden': 'true', text: emojiFor(bestPoints(answers)) }),
                    `${round.score || 0} pts`));

            const trace = resultTrace(round, section);
            const yours = answers.length
                ? h('ul', { class: 'tc-chips', 'aria-label': 'Your answers' }, answers.map(a => chip(a, true)))
                : h('p', { class: 'tc-muted', text: 'No valid answers this round.' });

            const play = answers.length ? playTable(answers) : null;

            if (!p) {
                section.append(head, trace || '', yours, play || '');
                return section;
            }

            // The other answers stay anonymous dots: the shape of the field, no names.
            const scored = scorePrompt(p);
            const plot = resultLandscape(scored, got, p.prompt);
            section.append(
                head,
                trace || '',
                yours,
                play || '',
                h('figure', { class: 'tc-plot' },
                    plot.canvas));

            // The first time the section scrolls in, the dots fly in again,
            // a little quicker and with no count.
            if (!reducedMotion()) {
                const deep = scored.find(s => s.deepCut);
                const names = landingOrder(answers, scored).map(a => a.name);
                const opts = { gap: names.length > 1 ? Math.min(90, 900 / (names.length - 1)) : 90, pulse: !!deep && !got.has(deep.answer.name) };
                plot.setProgress({ arrive: {}, ring: {}, deep: null });
                const traceReveal = section.__reveal;
                let started = false;
                section.__reveal = () => {
                    if (traceReveal) traceReveal();
                    if (started) return;
                    started = true;
                    const t0 = now() + 300;
                    let timer = 0;
                    const tick = () => {
                        if (game.phase !== 'results' || !plot.canvas.isConnected) { clearInterval(timer); return false; }
                        const r = plotReveal(names, now() - t0, opts);
                        plot.setProgress(r.done ? null : r.progress);
                        if (r.done) clearInterval(timer);
                        return !r.done;
                    };
                    const step = () => { if (tick()) requestAnimationFrame(step); };
                    timer = setInterval(tick, 100);
                    requestAnimationFrame(step);
                };
            }
            return section;
        }

        function watchReveals(sections) {
            const pending = sections.filter(s => s.__reveal);
            if (!pending.length) return;
            if (typeof IntersectionObserver !== 'function' || reducedMotion()) {
                for (const s of pending) s.__reveal();
                return;
            }
            observer = new IntersectionObserver(entries => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    observer.unobserve(e.target);
                    e.target.__reveal();
                }
            }, { threshold: 0.15 });
            for (const s of pending) observer.observe(s);
        }

        function fontsReady() {
            if (!document.fonts || !document.fonts.load) return Promise.resolve();
            const loads = [
                document.fonts.load(`400 128px ${SERIF}`, '0123456789'),
                document.fonts.load(`italic 400 30px ${SERIF}`, 'Tier'),
                document.fonts.load(`500 22px ${SANS}`, 'Turbo Cut'),
                document.fonts.load(`400 16px ${SANS}`, 'Name a'),
                document.fonts.load(`400 14px ${MONO}`, '12345'),
            ];
            return Promise.all(loads).catch(() => {}).then(() => document.fonts.ready).catch(() => {});
        }

        async function saveImage(button, status, rounds, total) {
            await fontsReady();
            const canvas = document.createElement('canvas');
            canvas.width = 1200;
            canvas.height = 630;
            const ctx = canvas.getContext('2d');
            let blob = null;
            if (ctx) {
                drawShareImage(ctx, 1200, 630, {
                    title: `Turbo Cut #${dailyNumber}`,
                    total, tier: tierFor(total), url: SHARE_URL, roundMs: ROUND_MS,
                    rounds: rounds.map(r => ({ prompt: (byId.get(r.promptId) || {}).prompt || r.promptId, score: r.score || 0, events: r.events })),
                }, readColors());
                blob = await new Promise(resolve => {
                    try { canvas.toBlob(resolve, 'image/png'); } catch (e) { resolve(null); }
                });
            }
            if (!blob) {
                button.hidden = true;
                return 'Couldn’t make an image here.';
            }
            const url = URL.createObjectURL(blob);
            const a = h('a', { href: url, download: `turbocut-${dailyNumber}.png`, class: 'tc-offscreen' });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            return 'Saved';
        }

        function renderResults(rounds, dailyRec) {
            stopClocks();
            game.phase = 'results';
            const daily = !!dailyRec;
            game.mode = daily ? 'daily' : 'endless';
            const total = daily && typeof dailyRec.total === 'number'
                ? dailyRec.total
                : rounds.reduce((t, r) => t + (r.score || 0), 0);
            setHeader('');

            const heading = h('h2', { class: 'tc-total', tabindex: '-1' },
                h('span', { class: 'tc-total-num', text: String(total) }),
                h('span', { class: 'tc-total-of', text: 'pts' }));

            const sections = rounds.map(roundSection);
            const ridges = dayRidges(rounds);
            const parts = [
                heading,
                h('p', { class: 'tc-tier' },
                    h('span', { class: 'tc-eyebrow-inline', text: 'Tier' }),
                    tierFor(total)),
                ridges,
                h('p', { class: 'tc-caption', text: 'Round by round below. Chips run from faint for the obvious to accent for the rare; the filled ◆ is the deep cut.' }),
                h('div', { class: 'tc-rounds' }, sections),
            ];

            if (daily) {
                const streak = displayStreak(loadStore().streak, dailyNumber);
                const text = shareText(dailyNumber, total, rounds);
                const status = h('span', { class: 'tc-copied', role: 'status' });
                let timer = 0;
                const say = msg => {
                    status.textContent = msg;
                    clearTimeout(timer);
                    timer = setTimeout(() => { status.textContent = ''; }, 2000);
                };
                const copy = h('button', {
                    type: 'button', class: 'tc-btn tc-btn-primary', text: 'Copy',
                    onclick: async () => {
                        const ok = await copyText(text);
                        say(ok ? 'Copied' : 'Couldn’t copy. Select the text above.');
                    },
                });
                const save = canSaveImage ? h('button', { type: 'button', class: 'tc-btn tc-btn-ghost', text: 'Save image' }) : null;
                if (save) {
                    save.addEventListener('click', async () => {
                        save.disabled = true;
                        try { say(await saveImage(save, status, rounds, total)); }
                        catch (e) { save.hidden = true; say('Couldn’t make an image here.'); }
                        save.disabled = false;
                    });
                }
                parts.push(
                    h('div', { class: 'tc-share' },
                        h('p', { class: 'tc-eyebrow', text: 'Share' }),
                        h('pre', { class: 'tc-share-card', text: text }),
                        h('div', { class: 'tc-share-actions' }, copy, save, status)),
                    h('p', { class: 'tc-streak', text: streak > 0 ? `${streak}-day streak` : 'Streak: 0 days. Play daily to build one.' }),
                    h('p', { class: 'tc-muted', text: `Turbo Cut #${dailyNumber + 1} arrives at midnight UTC.` }),
                    h('div', { class: 'tc-actions' },
                        h('button', { type: 'button', class: 'tc-btn tc-btn-quiet', onclick: startEndless, text: 'Play endless' })));
            } else {
                parts.push(
                    h('div', { class: 'tc-actions' },
                        h('button', { type: 'button', class: 'tc-btn tc-btn-primary', onclick: startEndless, text: 'Play again' }),
                        h('button', { type: 'button', class: 'tc-btn tc-btn-quiet', onclick: home, text: 'Today’s Turbo Cut' })));
            }

            els.results.replaceChildren(...parts.filter(Boolean));
            setHeader('');
            show(els.results);
            for (const fn of redrawers) fn();
            watchReveals(ridges ? [ridges].concat(sections) : sections);
            scrollTop();
            heading.focus({ preventScroll: true });
        }

        async function copyText(text) {
            try {
                if (navigator.clipboard && root.isSecureContext) {
                    await navigator.clipboard.writeText(text);
                    return true;
                }
            } catch (e) { /* fall through to the textarea fallback */ }
            try {
                const ta = h('textarea', { readonly: true, class: 'tc-offscreen', 'aria-hidden': 'true' });
                ta.value = text;
                document.body.append(ta);
                ta.select();
                ta.setSelectionRange(0, text.length);
                const ok = document.execCommand('copy');
                ta.remove();
                return ok;
            } catch (e) {
                return false;
            }
        }

        // -------- entry

        function home() {
            stopClocks();
            const rec = loadStore().days[dailyNumber];
            game.mode = 'daily';
            game.prompts = today;
            if (rec && typeof rec.total === 'number') renderResults(rec.rounds || [], rec);
            else if (rec && Array.isArray(rec.rounds) && rec.rounds.length && today.length) startDaily();
            else renderIntro();
        }

        home();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})(typeof window !== 'undefined' ? window : null);
