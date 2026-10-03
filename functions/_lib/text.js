// Tiny text helpers that work in both Workers and Node (no DOM available).

const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú',
    ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·',
};

export function decodeEntities(s) {
    if (!s) return '';
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
        if (code[0] === '#') {
            const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch { return m; }
        }
        const v = NAMED[code.toLowerCase()];
        return v === undefined ? m : v;
    });
}

/** HTML -> plain text, collapsed whitespace. */
export function stripHtml(s) {
    if (!s) return '';
    let t = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    t = decodeEntities(t); // some feeds double-encode their HTML
    t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h\d)>/gi, ' ');
    t = t.replace(/<[^>]+>/g, ' ');
    t = decodeEntities(t);
    return t.replace(/\s+/g, ' ').trim();
}

export function truncate(s, n) {
    if (!s || s.length <= n) return s || '';
    const cut = s.slice(0, n);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

export function cleanTitle(s) {
    return stripHtml(s).replace(/\s+/g, ' ').trim();
}

/** Content of the first <tag>…</tag> in an XML fragment (CDATA unwrapped, entities NOT decoded). */
export function xmlTag(block, tag) {
    const open = block.indexOf(`<${tag}`);
    if (open === -1) return '';
    const gt = block.indexOf('>', open);
    if (gt === -1) return '';
    if (block[gt - 1] === '/') return '';
    const close = block.indexOf(`</${tag}>`, gt);
    if (close === -1) return '';
    return block.slice(gt + 1, close).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

export function xmlTags(block, tag) {
    const out = [];
    let i = 0;
    for (;;) {
        const open = block.indexOf(`<${tag}>`, i);
        if (open === -1) break;
        const close = block.indexOf(`</${tag}>`, open);
        if (close === -1) break;
        out.push(block.slice(open + tag.length + 2, close).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1'));
        i = close;
    }
    return out;
}

/** Split an RSS document into <item> blocks without a full XML parser. */
export function rssItems(xml) {
    const items = [];
    let i = 0;
    for (;;) {
        const open = xml.indexOf('<item>', i);
        if (open === -1) break;
        const close = xml.indexOf('</item>', open);
        if (close === -1) break;
        items.push(xml.slice(open + 6, close));
        i = close + 7;
    }
    return items;
}

/** Minimal RFC 5545 parser: returns VEVENTs as { NAME: { value, params } } (first occurrence wins). */
export function parseIcs(text) {
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const events = [];
    let cur = null;
    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
        if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
        if (!cur) continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const head = line.slice(0, colon);
        const value = line.slice(colon + 1);
        const [name, ...paramParts] = head.split(';');
        const params = {};
        for (const p of paramParts) {
            const eq = p.indexOf('=');
            if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
        }
        const key = name.toUpperCase();
        if (!(key in cur)) cur[key] = { value, params };
    }
    return events;
}

export function icsText(v) {
    return String(v || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').replace(/\s+/g, ' ').trim();
}
