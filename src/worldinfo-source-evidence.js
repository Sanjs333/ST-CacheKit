/* World-info regex evidence from static or captured native results; MPL-2.0. */
const LIMIT = Object.freeze({ records: 512, scripts: 128, bytes: 128 * 1024,
    patternChars: 8192, replacementChars: 32768, workChars: 16 * 1024 * 1024, matches: 262144 });
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).length;
const fail = reason => ({ supported: false, reason });
const scalar = value => value == null || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length <= 128);

function field(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) throw new TypeError('无法识别正则设置字段');
    return descriptor.value;
}

function profile({ regex, context, allowDynamic = false } = {}) {
    try {
        if (context?.extensionSettings?.disabledExtensions?.includes('regex')) {
            return { supported: true, scripts: [], fingerprint: 'regex-disabled' };
        }
        const placement = regex?.regex_placement?.WORLD_INFO;
        if (typeof regex?.getRegexScripts !== 'function' || placement === undefined) return fail('WI_REGEX_API_UNAVAILABLE');
        const available = regex.getRegexScripts({ allowedOnly: true });
        if (!Array.isArray(available) || available.length > 512) return fail('WI_REGEX_LIMIT');
        const scripts = [];
        let dynamic = false;
        for (const item of available) {
            if (!item || typeof item !== 'object' || Array.isArray(item)
                || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return fail('WI_REGEX_API_UNAVAILABLE');
            const disabled = field(item, 'disabled'), findRegex = field(item, 'findRegex'),
                promptOnly = field(item, 'promptOnly'), placements = field(item, 'placement');
            if (disabled || !findRegex || !promptOnly || !Array.isArray(placements) || !placements.includes(placement)) continue;
            const replaceString = field(item, 'replaceString'), trimStrings = field(item, 'trimStrings'),
                substituteRegex = field(item, 'substituteRegex'), minDepth = field(item, 'minDepth'), maxDepth = field(item, 'maxDepth');
            if (typeof findRegex !== 'string' || typeof replaceString !== 'string' || !Array.isArray(trimStrings)
                || !trimStrings.every(value => typeof value === 'string')
                || ![substituteRegex, minDepth, maxDepth].every(scalar)) return fail('WI_REGEX_API_UNAVAILABLE');
            if (findRegex.length > LIMIT.patternChars || replaceString.length > LIMIT.replacementChars
                || trimStrings.length > 128 || trimStrings.some(value => value.length > 8192)) return fail('WI_REGEX_LIMIT');
            // The host evaluates macros in replacements and trims. Only the
            // special {{match}} placeholder is a static capture-group operation.
            const replacement = replaceString.replace(/\{\{match\}\}/giu, '$0');
            if (replacement.includes('{{') || trimStrings.some(value => value.includes('{{'))
                || ([1, 2].includes(Number(substituteRegex)) && findRegex.includes('{{'))) dynamic = true;
            scripts.push({ findRegex, replacement, trimStrings: [...trimStrings], substituteRegex, minDepth, maxDepth });
        }
        if (scripts.length > LIMIT.scripts) return fail('WI_REGEX_LIMIT');
        return { supported: !dynamic || allowDynamic, scripts, fingerprint: JSON.stringify({ placement, scripts }),
            ...(dynamic && !allowDynamic ? { reason: 'WI_REGEX_DYNAMIC' } : {}) };
    } catch { return fail('WI_REGEX_API_UNAVAILABLE'); }
}

function applies(script, depth) {
    if (typeof depth !== 'number') return true;
    if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) return false;
    if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) return false;
    return true;
}

/** Reconstruct only deterministic regex results. The caller must also verify
 * the joined result against the actual host aggregate before assigning ranges. */
export function captureWorldInfoRendering({ records, regex, context, parseRegex, defaultDepth = 4 } = {}) {
    const state = profile({ regex, context });
    if (!state.supported) return { ...state, records };
    if (!Array.isArray(records) || records.length > LIMIT.records) return { ...fail('WI_REGEX_LIMIT'), records };
    if (state.scripts.length && typeof parseRegex !== 'function') return { ...fail('WI_REGEX_API_UNAVAILABLE'), records };
    let inputBytes = 0, outputBytes = 0, work = 0, matches = 0;
    try {
        const rendered = records.map(record => {
            if (!record || typeof record.text !== 'string' || !Number.isInteger(record.position)
                || record.position < 0 || record.position > 7) throw new TypeError('无法识别世界书来源');
            inputBytes += bytes(record.text);
            if (inputBytes > LIMIT.bytes) throw new RangeError('Source limit');
            let text = record.text;
            const depth = record.position === 4 ? record.depth ?? defaultDepth : null;
            if (depth !== null && (typeof depth !== 'number' || !Number.isFinite(depth))) throw new TypeError('无法识别来源深度');
            for (const script of state.scripts) {
                if (!text || !applies(script, depth)) continue;
                work += text.length;
                if (work > LIMIT.workChars) throw new RangeError('Regex work limit');
                const expression = parseRegex(script.findRegex);
                if (!expression) continue; // Stock leaves invalid patterns unchanged.
                if (!(expression instanceof RegExp)) throw new TypeError('无法识别正则处理接口');
                expression.lastIndex = 0;
                text = text.replace(expression, (...args) => {
                    if (++matches > LIMIT.matches) throw new RangeError('Regex match limit');
                    const replacement = script.replacement.replaceAll(/\$(\d+)|\$<([^>]+)>/gu, (_, num, name) => {
                        const groups = args[args.length - 1];
                        const match = num ? args[Number(num)] : groups && typeof groups === 'object' ? groups[name] : undefined;
                        if (!match) return '';
                        if (typeof match !== 'string') throw new TypeError('无法识别正则匹配分组');
                        let result = match;
                        for (const trim of script.trimStrings) result = result.replaceAll(trim, '');
                        return result;
                    });
                    // Captured input can introduce macros even when the regex
                    // itself is literal. Do not execute or guess those values.
                    if (replacement.includes('{{')) throw Object.assign(new Error('动态正则替换'), { code: 'WI_REGEX_DYNAMIC' });
                    return replacement;
                });
                if (text.length > LIMIT.bytes || bytes(text) > LIMIT.bytes) throw new RangeError('Regex output limit');
            }
            outputBytes += bytes(text);
            if (outputBytes > LIMIT.bytes) throw new RangeError('Source output limit');
            return { ...record, text, ...(text !== record.text ? { originalText: record.text } : {}) };
        });
        return { ...state, records: rendered, mode: state.scripts.length ? 'static-regex' : 'no-regex' };
    } catch (error) {
        return { ...state, ...fail(error?.code === 'WI_REGEX_DYNAMIC' ? 'WI_REGEX_DYNAMIC'
            : error instanceof RangeError ? 'WI_REGEX_LIMIT' : 'WI_REGEX_API_UNAVAILABLE'), records };
    }
}

export function worldInfoRenderingMatches(snapshot, options) {
    const current = profile({ ...options, allowDynamic: snapshot?.mode === 'native-regex' });
    return snapshot?.supported === true && current.supported && current.fingerprint === snapshot.fingerprint;
}

/** Accept the per-entry outputs from the one native regex execution. */
export function acceptNativeWorldInfoRendering(snapshot, records, options) {
    const current = profile({ ...options, allowDynamic: true });
    if (!snapshot?.fingerprint || !current.supported || current.fingerprint !== snapshot.fingerprint
        || !Array.isArray(records) || records.length > LIMIT.records) return null;
    let total = 0;
    for (const record of records) {
        if (!record || typeof record.text !== 'string') return null;
        total += bytes(record.text);
        if (total > LIMIT.bytes) return null;
    }
    return { ...current, records, mode: 'native-regex' };
}
