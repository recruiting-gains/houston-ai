// Question understanding + event retrieval (keyword / date / area / price filtering, no embeddings needed).

import { localParts, startOfLocalDay, localToMs } from './time.js';
import { AREAS } from './areas.js';

const DAY = 86400000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const STOP = new Set(('a an and any are around at be best can could do does find for from fun get give good got have help how i im i\'m in into is it '
    + 'its just know like looking me my near need of on or out over please recommend recommendations some something somewhere suggest suggestions '
    + 'tell that the there these thing things this to today tomorrow tonight up us want we weekend what whats what\'s when where which who will with '
    + 'would you your houston htx h-town city events event happening going go do anything stuff ideas idea plan plans week next free cheap under less '
    + 'than dollars bucks budget night day evening morning afternoon date place places spot spots time live kid kids friendly '
    + 'sunday monday tuesday wednesday thursday friday saturday january february march april june july august september october '
    + 'november december month romantic couple couples ones').split(/\s+/));

// Topic -> words that indicate it in an event's text.
export const TOPICS = {
    music: { q: /\b(music|concerts?|live|band|jazz|blues|symphony|orchestra|choir|opera|dj|open mic|singer|songwriter|hip.?hop|country|rock)\b/, e: /\b(music|concert|band|jazz|blues|symphony|orchestra|choir|opera|dj|open mic|singer|songwriter|chamber|live music|perform|sound bath|sound healing|tango)\b/i },
    kids: { q: /\b(kids?|children|family|families|toddlers?|baby|babies|teens?|child)\b/, e: /\b(kids?|children|child|family|storytime|toddler|preschool|tyke|youth|teen|baby|babies|all ages|kid-friendly)\b/i },
    art: { q: /\b(art|arts|museums?|exhibits?|exhibitions?|gallery|galleries|paint|painting|culture|cultural)\b/, e: /\b(art|arts|museum|exhibit|exhibition|gallery|paint|mosaic|cultural|heritage|sculpture|photograph)\b/i },
    outdoors: { q: /\b(outdoors?|outside|park|parks|nature|hike|hiking|walk|garden|bayou|trail|picnic|birding|kayak|bike)\b/, e: /\b(park|nature|hike|walk|garden|bayou|trail|bird|kayak|cruise|outdoor|plant|tree|forestry|green)\b/i },
    sports: { q: /\b(sports?|games?|football|basketball|volleyball|soccer|baseball|softball|tennis|cougars|owls|uh|rice)\b/, e: /\b(sports|vs\.?|football|basketball|volleyball|soccer|baseball|softball|tennis|athletics)\b/i },
    food: { q: /\b(food|eat|dinner|brunch|lunch|drinks?|beer|wine|cocktails?|tasting|market|festival|oktoberfest)\b/, e: /\b(food|dinner|brunch|beer|wine|cocktail|tasting|market|festival|oktoberfest|chef|culinary|drink)\b/i },
    fitness: { q: /\b(fitness|yoga|workout|exercise|run|running|zumba|tai chi|dance|dancing)\b/, e: /\b(yoga|zumba|tai chi|fitness|workout|run|walk|dance|bhangra|pilates|bootcamp|wellness)\b/i },
    film: { q: /\b(movies?|films?|cinema|screening)\b/, e: /\b(movie|film|cinema|screening)\b/i },
    learning: { q: /\b(class|classes|workshops?|lectures?|talks?|learn|learning|book club|author)\b/, e: /\b(class|workshop|lecture|talk|author|book club|learn|seminar|presentation|tour)\b/i },
    comedy: { q: /\b(comedy|comedian|stand.?up|improv|funny)\b/, e: /\b(comedy|comedian|stand-up|standup|improv)\b/i },
    theater: { q: /\b(theat(er|re)|plays?|musicals?|broadway|show)\b/, e: /\b(theat(er|re)|play|musical|broadway|performing arts|stage)\b/i },
    spooky: { q: /\b(halloween|spooky|haunted|costume|pumpkins?|dia de los muertos|day of the dead)\b/, e: /\b(halloween|spooky|haunted|costume|pumpkin|boo|howl|dracula|muertos|altar)\b/i },
};

const AREA_ALIASES = [
    [/\bdowntown\b/, 'Downtown'], [/\bmuseum district\b|\bhermann park\b/, 'Museum District'], [/\bmemorial park\b|\bmemorial\b/, 'Memorial Park'],
    [/\bbuffalo bayou\b/, 'Buffalo Bayou Park'], [/\bupper kirby\b|\blevy\b/, 'Upper Kirby'], [/\bclear lake\b|\bnasa\b|\bspace center\b|\bkemah\b/, 'Clear Lake / NASA'],
    [/\bthird ward\b/, 'Third Ward'], [/\brice village\b|\bwest u\b|\bwest university\b/, 'Rice / West U'], [/\bheights\b/, 'The Heights'],
    [/\bmidtown\b/, 'Midtown'], [/\beast end\b|\beado\b|\bsecond ward\b/, 'East End / EaDo'], [/\bmontrose\b/, 'Montrose'],
    [/\bgalleria\b|\buptown\b/, 'Galleria / Uptown'], [/\bmedical center\b|\btmc\b/, 'Medical Center'], [/\briver oaks\b/, 'River Oaks'],
    [/\bwashington ave(nue)?\b|\bsawyer yards\b/, 'Washington Ave / Sawyer Yards'], [/\bspring branch\b/, 'Spring Branch'], [/\balief\b/, 'Alief'],
    [/\boak forest\b|\bgarden oaks\b/, 'Oak Forest / Garden Oaks'], [/\bmeyerland\b/, 'Meyerland'], [/\basiatown\b|\bchinatown\b|\bbellaire\b/, 'Bellaire / Asiatown'],
];

function weekendRange(now, offsetWeeks = 0) {
    const p = localParts(now);
    // Friday 5pm -> Sunday 23:59. If it's already Fri evening/Sat/Sun, "this weekend" is the current one.
    let daysToFri = (5 - p.dow + 7) % 7;
    if (p.dow === 6) daysToFri = -1;
    if (p.dow === 0) daysToFri = -2;
    const fri = startOfLocalDay(now, daysToFri + offsetWeeks * 7);
    const fp = localParts(fri);
    const start = localToMs(fp.y, fp.m, fp.d, 17, 0);
    const end = startOfLocalDay(fri, 3) - 1;
    return { start: Math.max(start, offsetWeeks ? start : now), end };
}

/** Pull date window, price, area and topics out of a free-form question. */
export function parseQuery(question, now = Date.now()) {
    const q = ` ${String(question || '').toLowerCase().replace(/[’']/g, "'")} `;
    const intent = { window: null, label: null, free: false, maxPrice: null, area: null, topics: [], evening: false, date: false, terms: [] };
    const today0 = startOfLocalDay(now);

    if (/\bnext weekend\b/.test(q)) { intent.window = weekendRange(now, 1); intent.label = 'next weekend'; }
    else if (/\b(this )?weekend\b/.test(q)) { intent.window = weekendRange(now, 0); intent.label = 'this weekend'; }
    else if (/\btonight\b/.test(q)) { intent.window = { start: now, end: startOfLocalDay(now, 1) - 1 }; intent.label = 'tonight'; intent.evening = true; }
    else if (/\btoday\b/.test(q)) { intent.window = { start: now, end: startOfLocalDay(now, 1) - 1 }; intent.label = 'today'; }
    else if (/\btomorrow( night)?\b/.test(q)) { intent.window = { start: startOfLocalDay(now, 1), end: startOfLocalDay(now, 2) - 1 }; intent.label = 'tomorrow'; intent.evening = /tomorrow night/.test(q); }
    else if (/\bnext week\b/.test(q)) {
        const p = localParts(now); const mon = startOfLocalDay(now, ((8 - p.dow) % 7) || 7);
        intent.window = { start: mon, end: startOfLocalDay(mon, 7) - 1 }; intent.label = 'next week';
    } else if (/\bthis week\b/.test(q)) {
        const p = localParts(now); intent.window = { start: now, end: startOfLocalDay(now, (7 - p.dow) % 7 + 1) - 1 }; intent.label = 'this week';
    } else {
        const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(q));
        if (wd !== -1) {
            const p = localParts(now);
            const add = (wd - p.dow + 7) % 7;
            const s = startOfLocalDay(now, add);
            intent.window = { start: Math.max(s, now), end: startOfLocalDay(s, 1) - 1 };
            intent.label = WEEKDAYS[wd][0].toUpperCase() + WEEKDAYS[wd].slice(1);
        } else {
            const mi = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(q));
            if (mi !== -1) {
                const p = localParts(now);
                const y = mi + 1 < p.m ? p.y + 1 : p.y;
                intent.window = { start: Math.max(localToMs(y, mi + 1, 1), now), end: localToMs(y, mi + 2, 1) - 1 };
                intent.label = MONTHS[mi][0].toUpperCase() + MONTHS[mi].slice(1);
            }
        }
    }
    if (/\b(night|evening|after work|after dark)\b/.test(q)) intent.evening = true;
    if (/\bfree\b|\bno cost\b|\$0\b/.test(q)) intent.free = true;
    const budget = q.match(/(?:under|less than|below|max|at most|up to)\s*\$?\s?(\d{1,4})|\$(\d{1,4})\s*(?:or less|max|budget)/);
    if (budget) intent.maxPrice = parseInt(budget[1] || budget[2], 10);
    else if (/\b(cheap|budget|affordable|inexpensive)\b/.test(q)) intent.maxPrice = 25;
    for (const [re, area] of AREA_ALIASES) if (re.test(q)) { intent.area = area; break; }
    for (const [name, t] of Object.entries(TOPICS)) if (t.q.test(q)) intent.topics.push(name);
    if (/\bdate\b|\bdates\b|\bromantic\b|\bcouples?\b|\bgirlfriend\b|\bboyfriend\b|\bwife\b|\bhusband\b|\bpartner\b|\banniversary\b/.test(q)) intent.date = true;
    intent.terms = [...new Set(q.replace(/[^a-z0-9&\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)))].slice(0, 12);
    if (!intent.window) intent.window = { start: now, end: today0 + 30 * DAY };
    return intent;
}

function textOf(ev) {
    return `${ev.title} ${(ev.categories || []).join(' ')} ${ev.venue || ''} ${ev.area || ''} ${ev.summary || ''}`.toLowerCase();
}

function overlaps(ev, w) {
    const s = Date.parse(ev.start);
    const e = ev.end ? Date.parse(ev.end) : s + 3 * 3600000;
    return s <= w.end && e >= w.start;
}

const KIDS_ONLY = /\b(storytime|toddler|preschool|tyke|baby|babies|kids?|children'?s|youth|teen)\b/i;

/** Rank events for a parsed query. Returns the best `limit` events (diversified by source/title). */
export function retrieve(events, intent, { limit = 18, now = Date.now() } = {}) {
    const scored = [];
    for (const ev of events) {
        if (!overlaps(ev, intent.window)) continue;
        if (intent.free && ev.is_free !== true) continue;
        if (intent.maxPrice !== null && ev.min_price !== null && ev.min_price > intent.maxPrice) continue;
        const text = textOf(ev);
        const title = ev.title.toLowerCase();
        let score = 1;
        for (const t of intent.terms) {
            if (title.includes(t)) score += 4;
            else if (text.includes(t)) score += 1.5;
        }
        for (const topic of intent.topics) if (TOPICS[topic].e.test(text)) score += 5;
        if (intent.topics.length && !intent.topics.some((t) => TOPICS[t].e.test(text))) score -= 3;
        if (intent.area) score += ev.area === intent.area ? 6 : -2;
        const s = Date.parse(ev.start);
        const hour = ev.all_day ? null : localParts(s).h;
        if (intent.evening) score += hour !== null && hour >= 17 ? 3 : ev.all_day || ev.ongoing ? -1 : -3;
        if (intent.date && !intent.topics.includes('kids')) {
            const meta = `${ev.title} ${(ev.categories || []).join(' ')} ${ev.audience || ''}`;
            if (KIDS_ONLY.test(meta) || /\bfamily\b|storytime|classes & education|technology & workshop|tram tour/i.test(meta)) score -= 6;
            if (/\b(music|concert|jazz|art|cruise|wine|cocktail|tasting|sip|stroll|sound bath|film|garden|dance|tango|festival|theat|exhibit|museum|sunset|bayou|stargaz|candle)/i.test(text)) score += 3;
        }
        if (ev.ongoing) score -= 1; // prefer dated happenings over long-running exhibits
        if (intent.free && ev.is_free) score += 1;
        if (/\b(garbage|recycl|blood drive|volunteer|board meeting|committee|esl|ged|citizenship|resume)\b/i.test(ev.title)) score -= 4;
        const daysOut = Math.max(0, (Math.max(s, now) - now) / DAY);
        score += Math.max(0, 2 - daysOut / 7); // sooner is slightly better
        scored.push({ ev, score });
    }
    scored.sort((a, b) => b.score - a.score || a.ev.start.localeCompare(b.ev.start));
    const out = [];
    const perSource = {};
    const titles = new Set();
    const maxPerSource = Math.max(4, Math.ceil(limit / 3));
    for (const { ev, score } of scored) {
        if (out.length >= limit) break;
        if (score <= 0) break; // clearly irrelevant; better to let the model say "nothing fits"

        const t = ev.title.toLowerCase();
        if (titles.has(t)) continue;
        if ((perSource[ev.source_id] || 0) >= maxPerSource) continue;
        titles.add(t);
        perSource[ev.source_id] = (perSource[ev.source_id] || 0) + 1;
        out.push({ ...ev, _score: Math.round(score * 10) / 10 });
    }
    return out;
}

/** Filters for the browse list (/api/events). */
export function browseFilter(events, { when, free, area, q, source }, now = Date.now()) {
    let w = null;
    if (when === 'today') w = { start: now, end: startOfLocalDay(now, 1) - 1 };
    else if (when === 'tomorrow') w = { start: startOfLocalDay(now, 1), end: startOfLocalDay(now, 2) - 1 };
    else if (when === 'weekend') w = weekendRange(now, 0);
    else if (when === 'week') w = { start: now, end: startOfLocalDay(now, 7) - 1 };
    const needle = (q || '').toLowerCase().trim();
    return events.filter((ev) => (!w || overlaps(ev, w))
        && (!free || ev.is_free === true)
        && (!area || ev.area === area)
        && (!source || ev.source_id === source)
        && (!needle || textOf(ev).includes(needle)));
}

export { AREAS };
