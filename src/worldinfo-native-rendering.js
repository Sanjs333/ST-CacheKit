/* Preserve the native world-info regex result at its existing source read; MPL-2.0. */
const MAX_ENTRIES = 512;
const MAX_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const ownData = (object, key) => {
    const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor : null;
};

function callers() {
    try {
        return String(new Error().stack ?? '').split('\n').filter(line => /:\d+(?::\d+)?/u.test(line)
            && !line.includes('worldinfo-native-rendering.js'));
    } catch { return []; }
}

const worldInfoLine = line => /(?:^|[\/\\@])world-info\.js(?:[?#][^\s):]*)?:(\d+)(?::\d+)?/u.exec(line ?? '');

/** Locate the renderer in the loaded asset; unrelated WI readers never claim it. */
export function worldInfoRenderCallSites(source) {
    if (typeof source !== 'string' || source.length > 2 * 1024 * 1024) return [];
    return source.split('\n').flatMap((line, index) =>
        /^\s*(?:const|let)\s+\w+\s*=\s*getRegexedString\(entry\.content,\s*regex_placement\.WORLD_INFO,\s*\{\s*depth:\s*regexDepth,\s*isMarkdown:\s*false,\s*isPrompt:\s*true\s*\}\);?\s*$/u.test(line)
            ? [index + 1] : []);
}

export function worldInfoRenderDefaultDepth(source) {
    if (typeof source !== 'string') return null;
    const match = /\bconst\s+DEFAULT_DEPTH\s*=\s*(\d+)\s*;/u.exec(source);
    return match ? Number(match[1]) : null;
}

/**
 * A final WI scan precedes the host's synchronous per-entry regex loop. At the
 * loop's own content read, run the exported native renderer once and retain its
 * result. A one-use settings read makes the immediately following native call
 * return that already rendered string. Neither scripts nor global prototypes
 * are changed, and other reads still see the original entry/settings values.
 * Unknown call sites and descriptors are left alone.
 */
export function preserveNativeWorldInfoRendering({ entries, records, regex, getContext,
    isActive = () => true, onRendered = () => {}, defaultDepth = 4, renderCallSites = [] } = {}) {
    if (!Array.isArray(entries) || !Array.isArray(records) || entries.length !== records.length
        || !entries.length || entries.length > MAX_ENTRIES || typeof regex?.getRegexedString !== 'function'
        || regex.regex_placement?.WORLD_INFO === undefined || typeof getContext !== 'function'
        || !Array.isArray(renderCallSites) || !renderCallSites.length) return null;
    const callSites = new Set(renderCallSites);
    const placement = ownData(regex.regex_placement, 'WORLD_INFO');
    if (!placement || placement.value === undefined) return null;
    const worldInfoCaller = line => callSites.has(Number(worldInfoLine(line)?.[1]));
    const key = record => JSON.stringify([record.world, record.uid]);
    const byId = new Map(records.map(record => [key(record), record]));
    if (byId.size !== records.length) return null;
    if (records.some(record => record.position === 4 && record.depth == null)
        && (!Number.isSafeInteger(defaultDepth) || defaultDepth < 0)) return null;
    const sources = [];
    try {
        for (const entry of entries) {
            const fields = Object.getOwnPropertyDescriptors(entry);
            const content = fields.content;
            if (!content || !('value' in content) || !content.configurable || typeof content.value !== 'string'
                || ['world', 'uid', 'constant', 'position', 'depth', 'order', 'role', 'outletName']
                    .some(name => fields[name] && !('value' in fields[name]))) return null;
            const record = byId.get(JSON.stringify([fields.world?.value, fields.uid?.value]));
            if (!record || record.text !== content.value) return null;
            sources.push({ entry, content: { ...content }, record, getter: null });
        }
    } catch { return null; }

    let finished = false, cancelled = false, insideRenderer = false, pendingSkip = false;
    let queued = false, totalBytes = 0, failed = false;
    let expiryTimer = null;
    const rendered = new Map();
    let settings, disabled, disabledGetter, arrayGuard, dataGuard;
    const skippedRegex = ['regex'];
    Object.defineProperty(skippedRegex, 'includes', { value: () => true });
    Object.freeze(skippedRegex);
    function restoreSources() {
        for (const source of sources) {
            try {
                if (Object.getOwnPropertyDescriptor(source.entry, 'content')?.get === source.getter) {
                    Object.defineProperty(source.entry, 'content', source.content);
                }
            } catch { failed = true; }
        }
    }
    function restoreGuard() {
        if (dataGuard) {
            const guard = dataGuard;
            dataGuard = null;
            try {
                if (ownData(settings, 'disabledExtensions')?.value === guard.array) Object.defineProperty(settings, 'disabledExtensions', guard.descriptor);
                else failed = true;
            } catch { failed = true; }
        }
        if (arrayGuard) {
            const guard = arrayGuard;
            arrayGuard = null;
            try {
                if (ownData(guard.array, 'includes')?.value !== guard.wrapper) failed = true;
                else if (guard.own) Object.defineProperty(guard.array, 'includes', guard.own);
                else delete guard.array.includes;
            } catch { failed = true; }
        }
        if (!settings || !disabledGetter) return;
        const getter = disabledGetter;
        disabledGetter = null;
        try {
            if (Object.getOwnPropertyDescriptor(settings, 'disabledExtensions')?.get === getter) {
                Object.defineProperty(settings, 'disabledExtensions', disabled);
            } else failed = true;
        } catch { failed = true; }
    }
    function armSkip() {
        disabled = ownData(settings, 'disabledExtensions');
        if (!disabled || !Array.isArray(disabled.value)) return false;
        disabled = { ...disabled };
        if (disabled.configurable) {
            disabledGetter = function () {
                if (pendingSkip && !insideRenderer) {
                    pendingSkip = false;
                    restoreGuard();
                    return skippedRegex;
                }
                return disabled.value;
            };
            Object.defineProperty(settings, 'disabledExtensions', { configurable: disabled.configurable,
                enumerable: disabled.enumerable, get: disabledGetter,
                ...(disabled.writable ? { set(value) { disabled.value = value; } } : {}) });
            return true;
        }
        if (disabled.writable) {
            const array = ['regex'];
            Object.defineProperty(array, 'includes', { value: () => {
                pendingSkip = false; restoreGuard(); return true;
            } });
            Object.freeze(array);
            dataGuard = { array, descriptor: disabled };
            Object.defineProperty(settings, 'disabledExtensions', { ...disabled, value: array });
            return true;
        }
        // A macro may seal/freeze the settings object. Keep its original data
        // field unchanged and hand off through the array's mutable method.
        const array = disabled.value, own = Object.getOwnPropertyDescriptor(array, 'includes');
        if (own && (!('value' in own) || !own.configurable && !own.writable)
            || !own && !Object.isExtensible(array)) return false;
        let original;
        for (let current = array; current; current = Object.getPrototypeOf(current)) {
            const descriptor = Object.getOwnPropertyDescriptor(current, 'includes');
            if (descriptor) { original = 'value' in descriptor ? descriptor.value : null; break; }
        }
        if (typeof original !== 'function') return false;
        const wrapper = function (...args) {
            if (this === array && pendingSkip && !insideRenderer && args[0] === 'regex') {
                pendingSkip = false; restoreGuard(); return true;
            }
            return original.apply(this, args);
        };
        arrayGuard = { array, own, wrapper };
        Object.defineProperty(array, 'includes', own ? { ...own, value: wrapper }
            : { value: wrapper, configurable: true, writable: true, enumerable: false });
        return true;
    }
    function finish({ publish = true } = {}) {
        if (finished) return;
        if (!publish) cancelled = true;
        restoreSources();
        // A cancellation inside a macro still needs the immediate one-use
        // skip; otherwise that same macro would be evaluated a second time.
        if (insideRenderer || pendingSkip) { enqueue(); return; }
        finished = true;
        if (expiryTimer !== null) clearTimeout(expiryTimer);
        restoreGuard();
        if (!cancelled && !failed && rendered.size === records.length) {
            for (const source of sources) {
                const fields = Object.getOwnPropertyDescriptors(source.entry);
                if (['world', 'uid', 'position', 'depth', 'order', 'role', 'outletName'].some(name =>
                    fields[name] && !('value' in fields[name]) || fields[name]?.value !== source.record[name])
                    || fields.constant && !('value' in fields.constant)
                    || Boolean(fields.constant?.value) !== source.record.constant) { failed = true; break; }
            }
        }
        if (!cancelled && !failed && rendered.size === records.length) {
            try { onRendered(records.map(record => rendered.get(key(record)))); } catch {}
        }
    }
    function enqueue() {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            // The host WI loop and each regex renderer are synchronous.
            pendingSkip = false;
            finish();
        });
    }
    try {
        settings = getContext()?.extensionSettings;
        disabled = ownData(settings, 'disabledExtensions');
        if (!disabled || !Array.isArray(disabled.value)) return null;
        if (!disabled.configurable && !disabled.writable) {
            const method = Object.getOwnPropertyDescriptor(disabled.value, 'includes');
            if (method && (!('value' in method) || !method.configurable && !method.writable)
                || !method && !Object.isExtensible(disabled.value)) return null;
        }
        for (const source of sources) {
            const getter = function () {
                if (finished || cancelled || insideRenderer || !worldInfoCaller(callers()[0])) return source.content.value;
                pendingSkip = false;
                restoreGuard();
                const currentContent = Object.getOwnPropertyDescriptor(source.entry, 'content');
                if (!currentContent?.configurable) {
                    failed = true; finish({ publish: false }); return source.content.value;
                }
                Object.defineProperty(source.entry, 'content', source.content);
                const fields = Object.getOwnPropertyDescriptors(source.entry);
                const metadataMatches = ['world', 'uid', 'position', 'depth', 'order', 'role', 'outletName'].every(name =>
                    (!fields[name] || 'value' in fields[name]) && fields[name]?.value === source.record[name])
                    && (!fields.constant || 'value' in fields.constant)
                    && Boolean(fields.constant?.value) === source.record.constant;
                if (!isActive() || getContext()?.extensionSettings !== settings || !metadataMatches
                    || source.content.value !== source.record.text) {
                    failed = true; finish(); return source.content.value;
                }
                insideRenderer = true;
                let text;
                try {
                    const depth = source.record.position === 4 ? source.record.depth ?? defaultDepth : null;
                    text = regex.getRegexedString(source.content.value, regex.regex_placement.WORLD_INFO,
                        { depth, isMarkdown: false, isPrompt: true });
                } catch (error) {
                    failed = true; insideRenderer = false; finish({ publish: false }); throw error;
                } finally { insideRenderer = false; }
                if (ownData(regex.regex_placement, 'WORLD_INFO')?.value !== placement.value || !armSkip()) {
                    failed = true; finish({ publish: false });
                    throw new TypeError('世界书正则设置在原生渲染期间发生变化');
                }
                pendingSkip = true;
                enqueue();
                if (typeof text !== 'string') { failed = true; return text; }
                totalBytes += encoder.encode(text).length;
                if (totalBytes > MAX_BYTES) failed = true;
                rendered.set(key(source.record), { ...source.record, text,
                    ...(text !== source.record.text ? { originalText: source.record.text } : {}) });
                return text;
            };
            source.getter = getter;
            Object.defineProperty(source.entry, 'content', { configurable: source.content.configurable,
                enumerable: source.content.enumerable, get: getter,
                ...(source.content.writable ? { set(value) {
                    if (Object.isFrozen(source.entry)) throw new TypeError('无法修改只读的世界书内容');
                    source.content.value = value;
                } } : {}) });
        }
        // The async event emitter may continue through other scan listeners
        // before the host starts its synchronous loop. A timer, unlike an
        // immediate microtask, also releases scans whose loop never starts.
        expiryTimer = setTimeout(() => { pendingSkip = false; finish({ publish: false }); }, 0);
    } catch {
        failed = true; cancelled = true; pendingSkip = false; finish({ publish: false }); return null;
    }
    return { finish, stop() { finish({ publish: false }); } };
}
