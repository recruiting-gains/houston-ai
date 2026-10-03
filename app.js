// H-Town AI frontend: chat (/api/ask) + browsable events (/api/events). No framework, no build step.
(() => {
    'use strict';
    const TZ = 'America/Chicago';
    const $ = (s, el = document) => el.querySelector(s);
    const $$ = (s, el = document) => [...el.querySelectorAll(s)];

    const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' });
    const fmtShort = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
    const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const fmtStamp = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function safeUrl(u) {
        try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
    }

    // ---------- tiny, safe markdown (links, bold, bullets, paragraphs) ----------
    function inline(text) {
        let t = esc(text);
        t = t.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) =>
            `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`);
        t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
        return t;
    }
    function renderMarkdown(md) {
        const out = [];
        let list = null;
        for (const raw of String(md).split('\n')) {
            const line = raw.trim();
            const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
            if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
            if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
            if (line) out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`);
        }
        if (list) out.push(`<ul>${list.join('')}</ul>`);
        return out.join('');
    }

    function whenLabel(ev, { withDay = true } = {}) {
        const s = new Date(ev.start);
        const e = ev.end ? new Date(ev.end) : null;
        if (ev.ongoing && e) return `Through ${fmtShort.format(e)}`;
        const day = withDay ? `${fmtShort.format(s)} · ` : '';
        if (ev.all_day) return `${day}All day`;
        return `${day}${fmtTime.format(s)}${e && e - s < 86400000 && e > s ? `–${fmtTime.format(e)}` : ''}`;
    }

    function priceBadge(ev) {
        if (ev.is_free) return '<span class="badge badge-free">Free</span>';
        if (ev.price) return `<span class="badge badge-price">${esc(ev.price)}</span>`;
        return '';
    }

    function eventCard(ev, { compact = false, withDay = false } = {}) {
        const url = safeUrl(ev.url);
        const where = [ev.venue, ev.area && ev.venue && ev.venue.includes(ev.area) ? null : ev.area].filter(Boolean).join(' · ');
        const when = esc(whenLabel(ev, { withDay }));
        return `<article class="ev-card min-w-0 rounded-xl ${compact ? 'p-3' : 'p-3.5 sm:p-4 flex gap-3'}">
            ${compact ? '' : `<div class="shrink-0 w-16 sm:w-20 text-xs font-semibold text-sunset-light pt-0.5">${when}</div>`}
            <div class="min-w-0 flex-1">
                ${compact ? `<p class="text-xs font-semibold text-sunset-light mb-0.5">${when}</p>` : ''}
                <h3 class="font-semibold text-white leading-snug ${compact ? 'text-sm' : 'text-[15px]'}">
                    ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow" class="hover:underline decoration-sunset/60 underline-offset-2 focus-ring rounded">${esc(ev.title)}</a>` : esc(ev.title)}
                </h3>
                ${where ? `<p class="text-xs text-slate-400 mt-0.5 truncate">${esc(where)}</p>` : ''}
                <div class="flex flex-wrap items-center gap-1.5 mt-2">
                    ${priceBadge(ev)}
                    ${ev.ongoing ? '<span class="badge badge-ongoing">Ongoing</span>' : ''}
                    ${ev.more_dates ? `<span class="badge badge-area">+${esc(ev.more_dates)} more dates</span>` : ''}
                    <span class="text-[11px] text-slate-500">${esc(ev.source)}</span>
                </div>
            </div>
        </article>`;
    }

    // ---------- events list ----------
    const state = { when: '', free: false, area: '', q: '', offset: 0, total: 0, loaded: [], areasLoaded: false };
    const list = $('#event-list');
    const moreBtn = $('#more');
    const PAGE = 60;

    function groupByDay(events) {
        const groups = new Map();
        const ongoing = [];
        const todayKey = fmtKey.format(new Date());
        for (const ev of events) {
            if (ev.ongoing) { ongoing.push(ev); continue; }
            let key = fmtKey.format(new Date(ev.start));
            if (key < todayKey) key = todayKey;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(ev);
        }
        return { groups, ongoing };
    }

    function renderList() {
        if (!state.loaded.length) {
            list.innerHTML = `<div class="panel rounded-xl p-6 text-center text-slate-300">No events match those filters. Try “All” or clear the search.</div>`;
            moreBtn.classList.add('hidden');
            return;
        }
        const { groups, ongoing } = groupByDay(state.loaded);
        const todayKey = fmtKey.format(new Date());
        const tomorrowKey = fmtKey.format(new Date(Date.now() + 86400000));
        let html = '';
        for (const [key, evs] of groups) {
            const d = new Date(`${key}T12:00:00-05:00`);
            const label = key === todayKey ? `Today · ${fmtDay.format(d)}` : key === tomorrowKey ? `Tomorrow · ${fmtDay.format(d)}` : fmtDay.format(d);
            html += `<section><h3 class="day-head py-2 text-sm font-semibold text-slate-200">${esc(label)} <span class="text-slate-500 font-normal">· ${evs.length}</span></h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">${evs.map((ev) => eventCard(ev)).join('')}</div></section>`;
        }
        if (ongoing.length) {
            html += `<section><h3 class="day-head py-2 text-sm font-semibold text-slate-200">Ongoing exhibits & festivals <span class="text-slate-500 font-normal">· ${ongoing.length}</span></h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">${ongoing.map((ev) => eventCard(ev)).join('')}</div></section>`;
        }
        list.innerHTML = html;
        moreBtn.classList.toggle('hidden', state.loaded.length >= state.total);
    }

    async function loadEvents({ append = false } = {}) {
        if (!append) { state.offset = 0; list.innerHTML = skeleton(); }
        const p = new URLSearchParams({ limit: String(PAGE), offset: String(state.offset) });
        if (state.when) p.set('when', state.when);
        if (state.free) p.set('free', '1');
        if (state.area) p.set('area', state.area);
        if (state.q) p.set('q', state.q);
        try {
            const res = await fetch(`/api/events?${p}`, { headers: { Accept: 'application/json' } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not load events.');
            state.total = data.total;
            state.loaded = append ? state.loaded.concat(data.events) : data.events;
            state.offset = state.loaded.length;
            if (!state.areasLoaded) setupMeta(data);
            renderList();
        } catch (err) {
            list.innerHTML = `<div class="msg-error rounded-xl p-4 text-sm">${esc(err.message || 'Could not load events.')} Please refresh the page.</div>`;
        }
    }

    function setupMeta(data) {
        state.areasLoaded = true;
        const sel = $('#area');
        for (const a of data.areas || []) {
            const o = document.createElement('option');
            o.value = a.name; o.textContent = `${a.name} (${a.count})`;
            sel.appendChild(o);
        }
        const srcs = (data.sources || []).filter((s) => s.count > 0);
        if (srcs.length) {
            $('#source-count').textContent = String(srcs.length);
            $('#source-links').innerHTML = srcs.map((s) => {
                const u = safeUrl(s.home);
                return u ? `<a class="link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name);
            }).join(', ') + '.';
        }
        const total = (data.sources || []).reduce((n, s) => n + (s.count || 0), 0);
        if (data.updated_at) $('#data-stamp').textContent = `${total} events · listings updated ${fmtStamp.format(new Date(data.updated_at))} CT`;
    }

    function skeleton() {
        return `<div class="grid sm:grid-cols-2 gap-2.5">${'<div class="ev-card rounded-xl h-24 animate-pulse"></div>'.repeat(6)}</div>`;
    }

    $$('[data-when]').forEach((b) => b.addEventListener('click', () => {
        state.when = b.dataset.when;
        $$('[data-when]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        loadEvents();
    }));
    const freeBtn = $('[data-free]');
    freeBtn.addEventListener('click', () => {
        state.free = !state.free;
        freeBtn.setAttribute('aria-pressed', String(state.free));
        loadEvents();
    });
    $('#area').addEventListener('change', (e) => { state.area = e.target.value; loadEvents(); });
    let searchTimer;
    $('#search').addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadEvents(); }, 250);
    });
    moreBtn.addEventListener('click', () => loadEvents({ append: true }));

    // ---------- chat ----------
    const messages = $('#messages');
    const form = $('#ask-form');
    const input = $('#question');
    const send = $('#send');
    const remainingEl = $('#remaining');
    let busy = false;

    function setRemaining(n, limit) {
        if (typeof n !== 'number') return;
        remainingEl.textContent = `${n}/${limit || 10} questions left today`;
    }

    function addMessage(role, html) {
        $('#empty-state')?.remove();
        const wrap = document.createElement('div');
        wrap.className = role === 'user' ? 'flex justify-end' : 'flex justify-start';
        const cls = role === 'user' ? 'msg msg-user' : role === 'error' ? 'msg msg-error' : 'msg msg-bot';
        wrap.innerHTML = `<div class="${cls} rounded-2xl px-4 py-3 max-w-[92%] text-[15px]">${html}</div>`;
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
        return wrap;
    }

    async function ask(question) {
        if (busy) return;
        question = question.trim();
        if (question.length < 3) { input.focus(); return; }
        busy = true; send.disabled = true;
        addMessage('user', esc(question));
        input.value = ''; autoGrow();
        const typing = addMessage('bot', '<span class="typing" aria-label="Thinking"><span></span><span></span><span></span></span>');
        try {
            const res = await fetch('/api/ask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ question }),
            });
            let data = {};
            try { data = await res.json(); } catch { /* non-JSON */ }
            typing.remove();
            if (!res.ok) {
                addMessage('error', esc(data.error || `Something went wrong (${res.status}). Please try again.`));
                if (res.status === 429) setRemaining(0, data.limit);
                return;
            }
            let html = renderMarkdown(data.answer);
            if (data.events && data.events.length) {
                html += `<div class="mt-3 pt-3 border-t border-white/10"><p class="text-xs uppercase tracking-wider text-slate-400 mb-2">${data.cited_count ? 'Events mentioned' : 'Closest matches'}</p>
                    <div class="space-y-2">${data.events.slice(0, 5).map((ev) => eventCard(ev, { compact: true, withDay: true })).join('')}</div></div>`;
            }
            addMessage('bot', html);
            setRemaining(data.remaining_today, data.limit);
        } catch {
            typing.remove();
            addMessage('error', 'Network error. Check your connection and try again.');
        } finally {
            busy = false; send.disabled = false;
        }
    }

    function autoGrow() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    }
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
    $$('#chips [data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));

    fetch('/api/ask', { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null)).then((d) => d && setRemaining(d.remaining_today, d.limit)).catch(() => {});
    $('#year').textContent = String(new Date().getFullYear());
    loadEvents();
})();
