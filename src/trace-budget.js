/* Incremental JSON byte accounting for bounded prompt evidence; MPL-2.0. */
const encoder = new TextEncoder();

export function createTraceBudget(trace, limit) {
    // Leave room for complete/reason flags added as observation progresses.
    let used = encoder.encode(JSON.stringify(trace)).length + 256;
    const sections = new Map();
    return {
        put(section, key, value, maxItems) {
            const items = trace[section];
            let index = sections.get(section);
            if (!index) { index = new Map(); sections.set(section, index); }
            const previous = index.get(key);
            if (!previous && items.length >= maxItems) return null;
            const serialized = JSON.stringify(value);
            if (typeof serialized !== 'string' || serialized.length > limit) return null;
            const size = encoder.encode(serialized).length;
            const nextUsed = used + size - (previous?.size ?? 0) + (!previous && items.length ? 1 : 0);
            if (nextUsed > limit) return null;
            const copy = JSON.parse(serialized);
            const position = previous?.position ?? items.length;
            items[position] = copy;
            index.set(key, { position, size });
            used = nextUsed;
            return copy;
        },
    };
}
