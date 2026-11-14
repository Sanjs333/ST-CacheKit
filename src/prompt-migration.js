/* Source-scoped macro migration; SPDX-License-Identifier: MPL-2.0. */
export const MIGRATION_SETTINGS_KEY = 'vertex-paygo-prompt-migration';
export const MACROS = Object.freeze({ green: '{{cache_green}}', depth: '{{cache_depth}}' });
export const cleanMacros = text => typeof text === 'string' ? Object.values(MACROS).reduce((value, macro) => value.split(macro).join(''), text) : text;
export function textParts(chat) {
    return (chat ?? []).flatMap(message => message?.role === 'tool' ? [] : typeof message?.content === 'string' ? [message.content]
        : Array.isArray(message?.content) ? message.content.filter(part => part?.type === 'text' && part.thought !== true && typeof part.text === 'string').map(part => part.text) : []);
}
export function occurrences(texts, needle, maxHits = Infinity) {
    if (!needle) return [];
    const found = [];
    texts.forEach((text, part) => { if (found.length >= maxHits) return; let offset = 0, index; while (found.length < maxHits && (index = text.indexOf(needle, offset)) >= 0) { found.push({ part, index }); offset = index + 1; } });
    return found;
}
export function sanitizeChat(chat) {
    return (chat ?? []).map(message => !message || message.role === 'tool' || !Object.hasOwn(message, 'content') ? message : ({ ...message, content: typeof message.content === 'string' ? cleanMacros(message.content)
        : Array.isArray(message.content) ? message.content.map(part => part?.type === 'text' && part.thought !== true ? { ...part, text: cleanMacros(part.text) } : part) : message.content }));
}
const find = (texts, needle) => occurrences(texts, needle, 2);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const countText = (texts, needle) => {
    if (!needle) return 0;
    let count = 0;
    for (const text of texts) { let start = 0, index; while ((index = text.indexOf(needle, start)) >= 0) { count++; start = index + 1; } }
    return count;
};
/** Slots are captured BEFORE native merging, and refer only to ephemeral source
 * objects. A segment is an exact range in its own source slot, never a guessed
 * range in final system messages. Effective chat is only an eligibility check. */
export function planMigration({ slots, chat, enabled = {}, failedOwners = new Set(), structuredOwners = new Set() }) {
    const texts = textParts(chat);
    const trusted = slot => Number.isSafeInteger(slot.wirePart) && slot.wirePart >= 0 && texts[slot.wirePart] === slot.text;
    if (texts.reduce((n, text) => n + new TextEncoder().encode(text).length, 0) > 2 * 1024 * 1024) return { output: new Map(), collections: {}, statuses: { green: enabled.green ? 'limit' : 'disabled', depth: enabled.depth ? 'limit' : 'disabled' }, migrated: false };
    const ambiguousOwners = new Set();
    for (const slot of slots) if (!trusted(slot) && slot.text?.trim() && find(texts, slot.text.trim()).length > 1)
        for (const segment of slot.segments ?? []) if (segment.owner) ambiguousOwners.add(segment.owner);
    slots = slots.filter(slot => slot.text?.trim() && (trusted(slot) || find(texts, slot.text.trim()).length === 1));
    const changes = new Map(), statuses = {}, collections = {};
    const anchors = {};
    for (const owner of Object.keys(MACROS)) {
        const macro = MACROS[owner], hits = find(texts, macro);
        const sourceHits = slots.flatMap(slot => find([slot.text], macro).map(hit => ({ slot, index: hit.index })));
        statuses[owner] = !enabled[owner] ? 'disabled' : !hits.length ? 'absent'
            : hits.length !== 1 || sourceHits.length !== 1 ? 'ambiguous-anchor'
            : ambiguousOwners.has(owner) ? 'ambiguous-source' : failedOwners.has(owner) ? 'provenance-unavailable' : 'eligible';
        if (statuses[owner] === 'eligible') anchors[owner] = sourceHits[0];
    }
    const selected = [];
    for (const slot of slots) {
        let end = 0;
        for (const segment of slot.segments ?? []) {
            if (!['green', 'depth'].includes(segment.owner) || !segment.text?.trim()) continue;
            const text = slot.text.slice(segment.start, segment.end);
            if (segment.start < end || segment.end <= segment.start || text !== segment.text) {
                if (statuses[segment.owner] === 'eligible') statuses[segment.owner] = 'provenance-unavailable';
                continue;
            }
            end = segment.end;
            // Empty sources and sources excluded by native budgeting/filters are
            // never activated here. Duplicate text cannot establish ownership.
            const hits = trusted(slot) ? [{ part: slot.wirePart, index: segment.start }] : find(texts, text);
            if (hits.length > 1 && statuses[segment.owner] === 'eligible') statuses[segment.owner] = 'ambiguous-source';
            if (hits.length === 1) selected.push({ ...segment, slot, text, wirePosition: hits[0] });
        }
    }
    for (const source of selected) if (!trusted(source.slot) && selected.filter(other => other.text === source.text).length > 1 && statuses[source.owner] === 'eligible') statuses[source.owner] = 'ambiguous-source';
    for (const owner of Object.keys(MACROS)) {
        if (statuses[owner] !== 'eligible') continue;
        const sources = selected.filter(source => source.owner === owner);
        if (sources.length > 128 || sources.reduce((n, s) => n + new TextEncoder().encode(s.text).length, 0) > 128 * 1024
            || sources.some(s => s.text.length > 32768)) { statuses[owner] = 'limit'; continue; }
        // Green source subgroups stay adjacent. Book/order and original
        // insertion/depth/role/priority are all part of the subgroup identity.
        // @D/AN sources keep native source order, never survivor/UID sorting.
        const groups = new Map();
        for (const source of sources) { const key = source.group ?? source.slot.id; const group = groups.get(key) ?? []; group.push(source); groups.set(key, group); }
        const entries = [...groups];
        if (owner === 'green') entries.sort(([a], [b]) => compare(a, b));
        else entries.sort(([, a], [, b]) => a[0].wirePosition.part - b[0].wirePosition.part || a[0].wirePosition.index - b[0].wirePosition.index);
        const ordered = entries.flatMap(([, group]) => group);
        const collectText = source => { const value = cleanMacros(source.text); return source.preserveWhitespace ? value : value.trim(); };
        const body = ordered.map(collectText).filter(Boolean).join('\n');
        collections[owner] = { body, count: ordered.length, groups: groups.size };
        Object.defineProperty(collections[owner], 'sourceTexts', { value: ordered.map(collectText).filter(Boolean) });
        for (const source of sources) {
            const edits = changes.get(source.slot) ?? [];
            // An anchor inside an owned source remains at its authored source
            // depth/role; the source's remaining text joins its own collector.
            const embedded = [...source.text.matchAll(/{{cache_(?:green|depth)}}/g)].map(match => match[0]).join('');
            edits.push({ start: source.start, end: source.end, value: embedded }); changes.set(source.slot, edits);
        }
    }
    const output = new Map();
    for (const slot of slots) {
        let value = slot.text;
        const edits = (changes.get(slot) ?? []).sort((a, b) => b.start - a.start);
        for (const edit of edits) value = value.slice(0, edit.start) + edit.value + value.slice(edit.end);
        for (const owner of Object.keys(MACROS)) value = value.split(MACROS[owner]).join(structuredOwners.has(owner) && collections[owner] ? MACROS[owner] : collections[owner]?.body ?? '');
        output.set(slot, value);
    }
    let expectedTexts = texts.map(cleanMacros);
    for (const [slot, value] of output) {
        if (trusted(slot)) expectedTexts[slot.wirePart] = value;
        else {
            const hits = find(texts, slot.text);
            if (hits.length !== 1 || hits[0].index !== 0 || texts[hits[0].part] !== slot.text) { expectedTexts = null; break; }
            expectedTexts[hits[0].part] = value;
        }
    }
    const expectedCounts = expectedTexts ? new Map(Object.values(collections).flatMap(collection => [collection.body, ...(collection.sourceTexts ?? [])])
        .filter(Boolean).map(text => [text, countText(expectedTexts, text)])) : null;
    return { output, collections, statuses, anchors, expectedCounts, migrated: Object.keys(collections).length > 0 };
}
export function setMigrationExpectedCounts(plan, chat, extraTexts = []) {
    const texts = textParts(chat);
    plan.expectedCounts = new Map([...Object.values(plan.collections).flatMap(collection => [collection.body, ...(collection.sourceTexts ?? [])]), ...extraTexts]
        .filter(Boolean).map(text => [text, countText(texts, text)]));
}
/** Rebuilt prompts must preserve the planned collector and source counts.
 * A lost budgeted anchor or changed occurrence count restores the native build. */
export function verifyMigration(plan, chat) {
    const texts = textParts(chat);
    if (texts.reduce((n, text) => n + new TextEncoder().encode(text).length, 0) > 2 * 1024 * 1024) return false;
    if (Object.values(MACROS).some(macro => find(texts, macro).length)) return false;
    if (plan.expectedCounts instanceof Map) return [...plan.expectedCounts].every(([text, expected]) => countText(texts, text) === expected);
    return Object.values(plan.collections).every(collection => (!collection.body || find(texts, collection.body).length === 1)
        && (collection.sourceTexts ?? []).every(text => find(texts, text).length === 1));
}
