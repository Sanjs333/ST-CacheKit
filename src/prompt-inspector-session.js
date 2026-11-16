/* One latest record per chat/connection scope in tab sessionStorage. Never settings/logs/localStorage. */
export const PROMPT_INSPECTOR_SESSION_KEY = 'vertex-paygo.prompt-inspector.last.v1';
export const PROMPT_INSPECTOR_SESSION_ENTRIES = 20;
export const PROMPT_INSPECTOR_SESSION_LIMIT = 2 * 1024 * 1024; // UTF-16 code units, not truncated prompt bytes.
const SOURCES = new Set(['vertexai', 'makersuite', 'custom', 'openai', 'claude']);
const STATES = new Set(['observed', 'dispatched', 'responded', 'failed', 'oversize']);
const RECORD_FIELDS = ['version', 'kind', 'id', 'chatId', 'source', 'model', 'sequence', 'state', 'complete', 'rawRequest',
    'trace', 'capturedAt', 'dispatchAt', 'responseAt', 'errorCode'];
const METADATA_FIELDS = ['transport', 'tier', 'region', 'stream', 'httpStatus', 'statusCode', 'durationMs', 'bodyBytes',
    'actualModel', 'traceError', 'finalStageError', 'captureKind', 'bodyEvidence', 'networkBytesVerified',
    'providerBodyAvailable', 'frontendMessagesComplete', 'capturePhase', 'association', 'handoffConfirmed',
    'responseOk', 'initialAssemblyOnly', 'runId', 'stableChatId', 'cacheBoundaryStatus', 'cacheBoundaryStableTextChars', 'archiveStatus', 'cacheWarm'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
const encodeEntries = entries => `{"version":2,"entries":[${entries.join(',')}]}`;
const EMPTY_ENVELOPE_LENGTH = encodeEntries([]).length;

// Preserve exact rawRequest. Select only evidence fields, never request headers / account credentials.
function evidence(value) {
    const frontend = value?.metadata?.captureKind === 'frontend-messages';
    const legalSource = typeof value?.source === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value.source);
    if (!object(value) || !id(value.id) || (!SOURCES.has(value.source) && !(frontend && legalSource))
        || !STATES.has(value.state) || (value.state === 'observed' && !frontend)
        || typeof value.chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.chatId)
        || typeof value.model !== 'string' || !value.model || value.model.length > 256
        || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.complete !== 'boolean'
        || (value.rawRequest !== null && typeof value.rawRequest !== 'string')
        || (value.complete && typeof value.rawRequest !== 'string')) return null;
    const result = {};
    for (const key of RECORD_FIELDS) if (value[key] !== undefined) result[key] = value[key];
    result.metadata = {};
    if (object(value.metadata)) for (const key of METADATA_FIELDS) {
        const item = value.metadata[key];
        if (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result.metadata[key] = item;
    }
    return result;
}

/** Bounded per-scope records. Schema v1 is read in place and migrated without losing its record. */
export function createPromptInspectorSessionStore({ getStorage = () => globalThis.sessionStorage,
    cryptoRef = globalThis.crypto, now = () => Date.now(), maxCodeUnits = PROMPT_INSPECTOR_SESSION_LIMIT,
    maxEntries = PROMPT_INSPECTOR_SESSION_ENTRIES } = {}) {
    let serial = 0, disposed = false;
    const hashes = new Map(), scopeRevisions = new Map();
    let mutations = Promise.resolve();
    const current = token => !disposed && serial === token;
    const storage = () => {
        try {
            const value = getStorage();
            return typeof value?.getItem === 'function' && typeof value?.setItem === 'function'
                && typeof value?.removeItem === 'function' ? value : null;
        } catch { return null; }
    };
    const remove = target => { try { target?.removeItem(PROMPT_INSPECTOR_SESSION_KEY); } catch { /* Only our namespace. */ } };
    const enqueue = fn => {
        const pending = mutations.then(fn, fn);
        mutations = pending.catch(() => {}); return pending;
    };
    async function fingerprint(key) {
        if (typeof key !== 'string' || !key || !cryptoRef?.subtle?.digest) return null;
        if (hashes.has(key)) return hashes.get(key);
        const data = new Uint8Array(await cryptoRef.subtle.digest('SHA-256', new TextEncoder().encode(key)));
        const hash = [...data].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (!disposed) {
            hashes.set(key, hash);
            while (hashes.size > 64) hashes.delete(hashes.keys().next().value);
        }
        return hash;
    }
    const entry = value => {
        if (!object(value) || !/^[a-f0-9]{64}$/u.test(value.scopeHash ?? '')
            || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0) return null;
        const record = evidence(value.record);
        return record ? { scopeHash: value.scopeHash, savedAt: value.savedAt, record } : null;
    };
    function read(target) {
        const raw = target.getItem(PROMPT_INSPECTOR_SESSION_KEY);
        if (!raw) return { status: 'empty', entries: [] };
        if (raw.length > maxCodeUnits) { remove(target); return { status: 'too-large', entries: [] }; }
        let saved; try { saved = JSON.parse(raw); } catch { remove(target); return { status: 'invalid', entries: [] }; }
        if (saved?.version === 1) {
            const legacy = entry(saved);
            if (!legacy) { remove(target); return { status: 'invalid', entries: [] }; }
            return { status: 'legacy', entries: [legacy] };
        }
        if (!object(saved) || saved.version !== 2 || !Array.isArray(saved.entries) || saved.entries.length > maxEntries) {
            remove(target); return { status: 'invalid', entries: [] };
        }
        const seen = new Set(), entries = [];
        for (const value of saved.entries) {
            const item = entry(value);
            if (item && !seen.has(item.scopeHash)) { seen.add(item.scopeHash); entries.push(item); }
        }
        return { status: 'ready', entries };
    }
    function write(target, entries, encoded = null) {
        if (!entries.length) { target.removeItem(PROMPT_INSPECTOR_SESSION_KEY); return; }
        target.setItem(PROMPT_INSPECTOR_SESSION_KEY, encoded ?? JSON.stringify({ version: 2, entries }));
    }
    function removeScope(target, hash) {
        const saved = read(target), remaining = saved.entries.filter(item => item.scopeHash !== hash);
        if (remaining.length === saved.entries.length && saved.status !== 'legacy') return;
        try { write(target, remaining); }
        catch {
            // Smaller replacement normally succeeds even on quota exhaustion. If storage rejects every
            // write, erase our index rather than risk restoring a cleared/outdated prompt as current.
            remove(target); throw new Error('无法写入浏览器会话存储。');
        }
    }
    return {
        async load(key) {
            const token = ++serial, target = storage();
            if (!target) return { status: 'unavailable', record: null };
            try {
                const hash = await fingerprint(key);
                await mutations;
                if (!current(token)) return { status: 'cancelled', record: null };
                if (!hash) return { status: 'unavailable', record: null };
                const saved = read(target), found = saved.entries.find(item => item.scopeHash === hash);
                if (saved.status === 'legacy') {
                    // Keep a different chat's legacy record too; never erase it just because it is hidden.
                    try { write(target, saved.entries); } catch { /* Still usable from the legacy slot. */ }
                }
                return found ? { status: 'restored', record: found.record, savedAt: found.savedAt }
                    : { status: ['invalid', 'too-large'].includes(saved.status) ? saved.status : 'empty', record: null };
            } catch { return { status: current(token) ? 'unavailable' : 'cancelled', record: null }; }
        },
        save(key, value) {
            const target = storage();
            if (disposed) return Promise.resolve({ status: 'cancelled' });
            if (!target || typeof key !== 'string' || !key) return Promise.resolve({ status: 'unavailable' });
            const revision = (scopeRevisions.get(key) ?? 0) + 1;
            scopeRevisions.set(key, revision);
            let record;
            try {
                const selected = evidence(value);
                record = selected ? JSON.parse(JSON.stringify(selected)) : null;
            } catch { record = null; }
            if (!record) return Promise.resolve({ status: 'invalid', previousRetained: true });
            // Queue at invocation, before hashing. Switching chats cancels UI reads only;
            // another save or an explicit clear supersedes writes for this scope alone.
            return enqueue(async () => {
                const latestRevision = () => scopeRevisions.get(key) === revision;
                try {
                    const hash = await fingerprint(key);
                    if (!latestRevision()) return { status: 'cancelled' };
                    if (!hash) return { status: 'unavailable' };
                    const savedAt = now(), latest = { scopeHash: hash, savedAt, record };
                    let traceOmitted = false;
                    let latestEncoded = JSON.stringify(latest);
                    if (EMPTY_ENVELOPE_LENGTH + latestEncoded.length > maxCodeUnits && record.trace) {
                        record.trace = { version: 1, complete: false, reason: 'SESSION_TRACE_LIMIT', sources: [], stages: [], events: [] };
                        traceOmitted = true;
                        latestEncoded = JSON.stringify(latest);
                    }
                    if (EMPTY_ENVELOPE_LENGTH + latestEncoded.length > maxCodeUnits) return { status: 'too-large', previousRetained: true };
                    const saved = read(target), other = saved.entries.filter(item => item.scopeHash !== hash)
                        .sort((a, b) => b.savedAt - a.savedAt);
                    const entries = [latest, ...other]; let evicted = 0;
                    while (entries.length > maxEntries) {
                        entries.pop(); evicted++;
                    }
                    // Serialize each retained record once; eviction only subtracts its
                    // UTF-16 length and separator, preserving the exact storage limit.
                    const encodedEntries = entries.map((item, index) => index === 0 ? latestEncoded : JSON.stringify(item));
                    let encodedLength = EMPTY_ENVELOPE_LENGTH + Math.max(0, encodedEntries.length - 1);
                    for (const encoded of encodedEntries) encodedLength += encoded.length;
                    while (encodedLength > maxCodeUnits) {
                        encodedLength -= encodedEntries.pop().length + (encodedEntries.length ? 1 : 0);
                        entries.pop(); evicted++;
                    }
                    if (!latestRevision()) return { status: 'cancelled' };
                    try { write(target, entries, encodeEntries(encodedEntries)); }
                    catch { return { status: 'unavailable', previousRetained: true }; }
                    return { status: 'saved', savedAt, evicted, ...(traceOmitted ? { traceOmitted: true } : {}) };
                } catch { return { status: latestRevision() ? 'unavailable' : 'cancelled' }; }
            });
        },
        clear(key) {
            serial++;
            if (typeof key !== 'string' || !key) return Promise.resolve({ status: 'unavailable' });
            scopeRevisions.set(key, (scopeRevisions.get(key) ?? 0) + 1);
            const target = storage();
            if (!target) return Promise.resolve({ status: 'unavailable' });
            // The delete stays queued even if the UI switches chats before it runs.
            return enqueue(async () => {
                try {
                    const hash = await fingerprint(key);
                    if (!hash) return { status: 'unavailable' };
                    removeScope(target, hash); return { status: 'cleared' };
                } catch { return { status: 'unavailable' }; }
            });
        },
        cancel() { serial++; },
        destroy() { serial++; disposed = true; hashes.clear(); },
    };
}

// A clear hides already-existing Agent artifacts too. Only a scope fingerprint
// and cutoff time are retained; the host's stored run input is never deleted.
export const PROMPT_INSPECTOR_DISMISSAL_KEY = 'vertex-paygo.prompt-inspector.dismissed.v1';
export function createPromptInspectorDismissalStore({ getStorage = () => globalThis.sessionStorage,
    cryptoRef = globalThis.crypto, maxEntries = 64 } = {}) {
    const cache = new Map(), reads = new Map(), hashes = new Map();
    let mutations = Promise.resolve(), disposed = false;
    const storage = () => { try {
        const value = getStorage();
        return typeof value?.getItem === 'function' && typeof value?.setItem === 'function' ? value : null;
    } catch { return null; } };
    const enqueue = operation => { const result = mutations.then(operation, operation); mutations = result.catch(() => {}); return result; };
    async function hash(key) {
        if (hashes.has(key)) return hashes.get(key);
        if (typeof key !== 'string' || !key || !cryptoRef?.subtle?.digest) return null;
        const digest = await cryptoRef.subtle.digest('SHA-256', new TextEncoder().encode(key));
        const value = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (!disposed) { hashes.set(key, value); while (hashes.size > maxEntries) hashes.delete(hashes.keys().next().value); }
        return value;
    }
    function read(target) {
        const raw = target.getItem(PROMPT_INSPECTOR_DISMISSAL_KEY);
        if (!raw || raw.length > 64 * 1024) return [];
        let value; try { value = JSON.parse(raw); } catch { return []; }
        if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > maxEntries) return [];
        return value.entries.filter(item => object(item) && /^[a-f0-9]{64}$/u.test(item.scopeHash ?? '')
            && Number.isSafeInteger(item.cutoffMs) && item.cutoffMs >= 0);
    }
    return {
        peek(key) { return cache.get(key) ?? null; },
        load(key) {
            if (cache.has(key)) return Promise.resolve(cache.get(key));
            if (reads.has(key)) return reads.get(key);
            if (disposed) return Promise.resolve({ cutoffMs: 0, status: 'unavailable' });
            const result = (async () => {
                let value = { cutoffMs: 0, status: 'unavailable' };
                try {
                    const target = storage(), fingerprint = target ? await hash(key) : null;
                    await mutations;
                    if (target && fingerprint) {
                        const cutoffs = read(target).filter(item => item.scopeHash === fingerprint).map(item => item.cutoffMs);
                        value = { cutoffMs: Math.max(0, ...cutoffs), status: 'ready' };
                    }
                } catch { /* Unavailable browser storage must not block prompt inspection. */ }
                const existing = cache.get(key);
                if (existing && existing.cutoffMs >= value.cutoffMs) value = existing;
                cache.set(key, value); reads.delete(key); return value;
            })();
            reads.set(key, result); return result;
        },
        dismiss(key, cutoffMs) {
            const cutoff = Math.max(cache.get(key)?.cutoffMs ?? 0, cutoffMs);
            cache.set(key, { cutoffMs: cutoff, status: 'saving' });
            if (disposed || !Number.isSafeInteger(cutoff) || cutoff < 0) return Promise.resolve({ cutoffMs: cutoff, status: 'unavailable' });
            return enqueue(async () => {
                let status = 'unavailable';
                try {
                    const target = storage(), fingerprint = target ? await hash(key) : null;
                    if (target && fingerprint) {
                        const entries = read(target), previous = entries.filter(item => item.scopeHash === fingerprint);
                        const latest = { scopeHash: fingerprint, cutoffMs: Math.max(cutoff, ...previous.map(item => item.cutoffMs)) };
                        const remaining = entries.filter(item => item.scopeHash !== fingerprint);
                        const next = [latest, ...remaining].sort((left, right) => right.cutoffMs - left.cutoffMs).slice(0, maxEntries);
                        target.setItem(PROMPT_INSPECTOR_DISMISSAL_KEY, JSON.stringify({ version: 1, entries: next }));
                        status = 'saved';
                    }
                } catch { /* The in-memory dismissal remains in effect. */ }
                const value = { cutoffMs: Math.max(cutoff, cache.get(key)?.cutoffMs ?? 0), status };
                cache.set(key, value); return value;
            });
        },
        destroy() { disposed = true; reads.clear(); hashes.clear(); },
    };
}
