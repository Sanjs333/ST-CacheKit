/* Evidence from the host's single native macro evaluation; MPL-2.0. */
const LIMIT = Object.freeze({ bytes: 2 * 1024 * 1024, records: 512, calls: 4096, depth: 32, proofs: 512 });
const encoder = new TextEncoder();
const size = text => encoder.encode(text).length;
const own = (object, key) => {
    if (!object || typeof object !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
const fingerprint = fn => {
    if (typeof fn !== 'function') return '';
    const text = Function.prototype.toString.call(fn).replace(/\r/gu, '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    return text.length + ':' + (hash >>> 0).toString(16);
};
// Actual ST 1.19 / TT 2.4 built-in handlers. Identical names alone do not
// identify an outlet: extensions and dynamic macros can override a definition.
const OUTLET_HANDLERS = new Set(['199:cac4f93', '207:586819e4']);
const IF_HANDLER = '2631:a52e3fd8';
const TRIM_HANDLER = '1502:918927f7';
const group = entry => JSON.stringify([entry.world, entry.order, entry.position, entry.depth ?? null, entry.role ?? null, entry.outletName ?? null]);
const rangeOf = node => {
    const start = own(own(node, 'children'), 'Macro.Start')?.[0], end = own(own(node, 'children'), 'Macro.End')?.[0];
    const first = own(start, 'startOffset'), last = own(end, 'endOffset');
    return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first >= 0 && last >= first ? { start: first, end: last + 1 } : null;
};

/**
 * Observe public singleton methods without evaluating a template a second time.
 * capture() is synchronous, matching native PromptManager.preparePrompt().
 * Its result is returned unchanged; unknown transformations yield no evidence.
 */
export function installNativeOutletEvidence({ macros, getExtensionPrompts = () => undefined } = {}) {
    const engine = macros?.engine, registry = macros?.registry, walker = macros?.cstWalker;
    let destroyed = false, enabled = false;
    const scopes = [], restorers = [];
    const supports = engine && registry && walker && typeof engine.evaluate === 'function'
        && typeof registry.executeMacro === 'function' && typeof registry.getMacro === 'function'
        && typeof walker.evaluateDocument === 'function' && typeof walker.extractMacroInfo === 'function';
    const current = () => destroyed ? null : scopes.at(-1);
    function wrap(object, key, makeWrapper) {
        const original = object[key], descriptor = Object.getOwnPropertyDescriptor(object, key), wrapper = makeWrapper(original);
        if (descriptor && (!('value' in descriptor) || !descriptor.configurable || !descriptor.writable)
            || !descriptor && !Object.isExtensible(object)) throw new TypeError('无法识别公开的宏处理接口');
        restorers.push(() => {
            if (object[key] !== wrapper) return;
            if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key];
        });
        Object.defineProperty(object, key, { value: wrapper, writable: true, enumerable: descriptor?.enumerable ?? false, configurable: true });
    }
    function budget(scope) {
        if (++scope.calls > LIMIT.calls || scope.engines.length >= LIMIT.depth) scope.failed = true;
        return !scope.failed;
    }
    function safeRecord(entry) {
        if (!entry || typeof entry !== 'object') return null;
        const text = own(entry, 'text');
        if (typeof own(entry, 'world') !== 'string' || !Number.isSafeInteger(own(entry, 'uid')) || typeof text !== 'string'
            || ['constant', 'position', 'outletName', 'order', 'depth', 'role'].some(key => {
                const descriptor = Object.getOwnPropertyDescriptor(entry, key);
                return descriptor ? !('value' in descriptor) : key in entry;
            })) return null;
        return entry;
    }
    function outletProof(scope, call, definition, value) {
        if (!OUTLET_HANDLERS.has(fingerprint(own(definition, 'handler'))) || typeof value !== 'string' || !value) return null;
        const args = own(call, 'args'), key = Array.isArray(args) && args.length === 1 ? args[0] : null;
        if (typeof key !== 'string' || !key || key.length > 256 || /[{}]/u.test(key)) return null;
        const records = scope.records.filter(entry => own(entry, 'position') === 7 && own(entry, 'outletName') === key && own(entry, 'text'));
        if (!records.length) return null;
        const expected = records.map(entry => own(entry, 'text')).join('\n');
        if (value !== expected) return null;
        const makeId = own(own(scope.constants, 'inject_ids'), 'CUSTOM_WI_OUTLET');
        if (typeof makeId !== 'function') return null;
        const id = makeId(key);
        if (typeof id !== 'string' || !id) return null;
        let prompts = own(own(call, 'env'), 'extensionPrompts') ?? scope.extensionPrompts;
        if (!prompts) try { prompts = getExtensionPrompts(); } catch { return null; }
        const reference = own(prompts, id);
        if (!reference || own(reference, 'value') !== expected || own(reference, 'position') !== -1
            || typeof own(reference, 'filter') === 'function') return null;
        const filter = Object.getOwnPropertyDescriptor(reference, 'filter');
        if (filter && !('value' in filter) || !filter && 'filter' in reference) return null;
        let offset = 0;
        const segments = records.map(entry => {
            const text = own(entry, 'text'), segment = { start: offset, end: offset + text.length, text,
                owner: own(entry, 'constant') ? null : 'green', group: group(entry), entry };
            offset += text.length + 1; return segment;
        });
        return { id, key, expected, reference, records, start: 0, end: value.length, segments, nativeObserved: true };
    }
    const shifted = (proofs, offset) => proofs.map(proof => ({ ...proof, start: proof.start + offset, end: proof.end + offset,
        segments: proof.segments.map(segment => ({ ...segment, start: segment.start + offset, end: segment.end + offset })) }));
    function trimmedProofs(input, output, proofs, nativeTrim) {
        if (typeof input !== 'string' || typeof output !== 'string' || fingerprint(nativeTrim) !== TRIM_HANDLER) return [];
        const lines = input.split('\n'), first = lines.find(line => line.trim()), indent = first?.match(/^[ \t]*/u)?.[0].length ?? 0;
        const positions = [];
        let rebuilt = '', cursor = 0;
        lines.forEach((line, index) => {
            const spaces = line.match(/^[ \t]*/u)?.[0].length ?? 0, removed = spaces >= indent ? indent : spaces;
            for (let pos = removed; pos < line.length; pos++) { rebuilt += line[pos]; positions.push(cursor + pos); }
            cursor += line.length;
            if (index < lines.length - 1) { rebuilt += '\n'; positions.push(cursor); cursor++; }
        });
        const before = rebuilt.length - rebuilt.trimStart().length, after = rebuilt.trimEnd().length;
        const mapping = positions.slice(before, after), final = rebuilt.slice(before, after);
        if (final !== output) return [];
        const project = (start, end) => {
            const indexes = [];
            for (let index = 0; index < mapping.length; index++) if (mapping[index] >= start && mapping[index] < end) indexes.push(index);
            if (!indexes.length || indexes.at(-1) - indexes[0] + 1 !== indexes.length) return null;
            return { start: indexes[0], end: indexes.at(-1) + 1 };
        };
        return proofs.flatMap(proof => {
            const location = project(proof.start, proof.end);
            if (!location) return [];
            const segments = proof.segments.flatMap(segment => {
                const position = project(segment.start, segment.end);
                return position ? [{ ...segment, ...position, text: output.slice(position.start, position.end) }] : [];
            });
            return segments.some(segment => segment.owner === 'green' && segment.text)
                ? [{ ...proof, ...location, segments }] : [];
        });
    }
    function documentProofs(scope, frame, output) {
        if (scope.failed || typeof output !== 'string' || !frame.cst?.children) return [];
        const nodes = frame.cst.children.macro;
        if (!Array.isArray(nodes)) return [];
        const items = nodes.map(node => {
            const info = walker.extractMacroInfo(node), range = rangeOf(node);
            return { node, info, range };
        });
        if (items.length > LIMIT.calls) return [];
        if (items.some(item => !item.info || !item.range || item.range.end > frame.text.length)) return [];
        const replacements = [];
        for (let index = 0; index < items.length; index++) {
            const { node, info, range } = items[index];
            const call = frame.calls.find(value => value.call.cstNode === node);
            if (info.isClosing || !call) return []; // Recovery, shorthand, or an unobserved call.
            const replacement = { ...range, call };
            if (call.call.isScoped) {
                let depth = 1, close = -1;
                for (let next = index + 1; next < items.length; next++) {
                    const other = items[next];
                    if (other.info.name.toLowerCase() !== info.name.toLowerCase()) continue;
                    if (other.info.isClosing) { if (--depth === 0) { close = next; break; } }
                    else depth++;
                }
                if (close < 0) return [];
                replacement.end = items[close].range.end; index = close;
            }
            replacements.push(replacement);
        }
        replacements.sort((left, right) => left.start - right.start);
        let result = '', cursor = 0;
        const proofs = [];
        let outputBytes = 0;
        for (const replacement of replacements) {
            if (replacement.start < cursor || typeof replacement.call.value !== 'string') return [];
            result += frame.text.slice(cursor, replacement.start);
            outputBytes += size(frame.text.slice(cursor, replacement.start)) + size(replacement.call.value);
            if (outputBytes > LIMIT.bytes || proofs.length + replacement.call.proofs.length > LIMIT.proofs) return [];
            proofs.push(...shifted(replacement.call.proofs, result.length));
            result += replacement.call.value; cursor = replacement.end;
        }
        result += frame.text.slice(cursor);
        return result === output && proofs.length <= LIMIT.proofs && size(result) <= LIMIT.bytes ? proofs : [];
    }
    if (supports) try {
        wrap(engine, 'evaluate', original => function (input, env, options) {
            const scope = current();
            if (!scope || !budget(scope)) return original.call(this, input, env, options);
            if (typeof input !== 'string' || size(input) > LIMIT.bytes) { scope.failed = true; return original.call(this, input, env, options); }
            const frame = { input, documents: [], trims: [], children: [], proofs: [] }, parent = scope.engines.at(-1);
            scope.engines.push(frame);
            let output;
            try { output = original.call(this, input, env, options); return output; }
            finally {
                scope.engines.pop(); frame.output = output;
                const document = frame.documents.length === 1 ? frame.documents[0] : null;
                if (!destroyed && !scope.failed && typeof output === 'string' && size(output) <= LIMIT.bytes && document?.output === output) frame.proofs = document.proofs;
                else if (typeof output === 'string' && size(output) > LIMIT.bytes) scope.failed = true;
                parent?.children.push(frame); if (!parent) scope.roots.push(frame);
            }
        });
        wrap(walker, 'evaluateDocument', original => function (options) {
            const scope = current(), evaluation = scope?.engines.at(-1);
            if (!scope || !evaluation || !budget(scope)) return original.call(this, options);
            if (typeof options?.text !== 'string' || size(options.text) > LIMIT.bytes) { scope.failed = true; return original.call(this, options); }
            const frame = { text: options.text, cst: options.cst, calls: [], proofs: [] };
            const resolver = options.resolveMacro;
            const observed = { ...options, resolveMacro(call) {
                const record = { call, value: undefined, proofs: [] };
                scope.callFrames.push(record);
                try {
                    const value = resolver(call); record.value = value;
                    // executeMacro records pre-postprocess output. A changed
                    // result cannot inherit its source without separate proof.
                    if (record.nativeValue !== value) record.proofs = [];
                    return value;
                } finally { scope.callFrames.pop(); frame.calls.push(record); }
            } };
            let output;
            try { output = original.call(this, observed); return output; }
            finally {
                frame.output = output;
                try { frame.proofs = documentProofs(scope, frame, output); } catch { frame.proofs = []; }
                evaluation.documents.push(frame);
            }
        });
        wrap(registry, 'executeMacro', original => function (call, options) {
            const scope = current(), observation = scope?.callFrames.at(-1), evaluation = scope?.engines.at(-1);
            if (!scope || !observation || !evaluation || observation.call !== call || !budget(scope)) return original.call(this, call, options);
            let definition;
            try { definition = options?.defOverride ?? own(call, 'definition') ?? registry.getMacro(call.name); } catch { scope.failed = true; }
            const start = evaluation.children.length, trims = evaluation.trims.length;
            const value = original.call(this, call, options);
            observation.nativeValue = value;
            try {
                if (call.name?.toLowerCase() === 'outlet') {
                    const proof = outletProof(scope, call, definition, value); observation.proofs = proof ? [proof] : [];
                } else if (call.name?.toLowerCase() === 'if' && fingerprint(own(definition, 'handler')) === IF_HANDLER) {
                    // The actual built-in resolves condition first and only the
                    // selected branch last. Consume/filter branches stay empty.
                    const child = evaluation.children.slice(start).at(-1);
                    if (child?.proofs.length) {
                        if (child.output === value) observation.proofs = child.proofs;
                        else {
                            const trim = evaluation.trims.slice(trims).at(-1);
                            if (trim?.input === child.output && trim.output === value) observation.proofs = trimmedProofs(child.output, value, child.proofs, trim.native);
                        }
                    }
                }
            } catch { observation.proofs = []; }
            return value;
        });
        wrap(engine, 'trimScopedContent', original => function (input, options) {
            const result = original.call(this, input, options), scope = current(), frame = scope?.engines.at(-1);
            if (scope && frame && budget(scope)) frame.trims.push({ input, output: result, native: original });
            return result;
        });
        enabled = true;
    } catch {
        for (const restore of restorers.reverse()) try { restore(); } catch { /* Release all installed wrappers. */ }
        restorers.length = 0;
    }
    return {
        capture({ templateText, records, constants, extensionPrompts } = {}, invokeNativePrepare) {
            if (typeof invokeNativePrepare !== 'function') throw new TypeError('缺少原生请求准备回调');
            if (!enabled || destroyed || typeof templateText !== 'string' || size(templateText) > LIMIT.bytes
                || !Array.isArray(records) || records.length > LIMIT.records || !records.every(safeRecord)
                || records.reduce((sum, entry) => sum + size(own(entry, 'text')), 0) > LIMIT.bytes) return { result: invokeNativePrepare(), proofs: [] };
            const scope = { records, constants, extensionPrompts, engines: [], callFrames: [], roots: [], calls: 0, failed: false };
            scopes.push(scope);
            let result;
            try { result = invokeNativePrepare(); }
            finally { scopes.pop(); }
            const content = typeof result === 'string' ? result : own(result, 'content');
            const roots = scope.roots.filter(frame => frame.input === templateText && frame.output === content);
            const proofs = !destroyed && !scope.failed && roots.length === 1 ? roots[0].proofs : [];
            return { result, proofs };
        },
        destroy() {
            if (destroyed) return;
            destroyed = true; enabled = false;
            for (const restore of restorers.reverse()) try { restore(); } catch { /* Preserve wrappers installed later. */ }
            restorers.length = 0;
        },
    };
}
