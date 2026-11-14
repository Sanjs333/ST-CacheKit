/* Last JS boundary for Agent snapshots; no host source changes.
 * SPDX-License-Identifier: MPL-2.0 */
import { cleanMacros } from './prompt-migration.js';
import { installTauriAgentAssembly } from './tauri-agent-assembly.js';

const DEFAULT_STATE_KEY = '__vertexPayGoTauriRequestState';
const COMMANDS = new Set(['start_agent_run', 'start_agent_session_run', 'resolve_agent_prompt_assembly', 'resume_agent_run']);
const MARKERS = ['__vertexPayGoRequestState', DEFAULT_STATE_KEY, '__vertexPayGoPromptInspector',
    '__vertexPayGoNativeOrder', 'promptInspectorTicket', 'worldInfoOrderToken'];
const LEGACY_PAYLOADS = ['chatCompletionPayload', 'chat_completion_payload', 'generateData', 'generate_data'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownValue = (value, key) => {
    if (!object(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

function stateKey(value) {
    if (typeof value !== 'string' || !/^__vertexPayGo[A-Za-z0-9_]{1,96}$/u.test(value)) throw new TypeError('Agent 请求状态字段无效。');
    return value;
}
function replaceOwn(value, replacements = new Map(), removed = []) {
    if (!replacements.size && !removed.length) return value;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of removed) delete descriptors[key];
    for (const [key, replacement] of replacements) {
        const previous = descriptors[key];
        descriptors[key] = { value: replacement, enumerable: previous?.enumerable ?? true,
            writable: previous && 'writable' in previous ? previous.writable : true,
            configurable: previous?.configurable ?? true };
    }
    return Object.create(Object.getPrototypeOf(value), descriptors);
}
function mapChanged(values, transform) {
    let updated;
    for (let index = 0; index < values.length; index++) {
        if (!Object.hasOwn(values, index)) continue;
        const next = transform(values[index]);
        if (next !== values[index]) { updated ??= values.slice(); updated[index] = next; }
    }
    return updated ?? values;
}
function cleanText(value) { return typeof value === 'string' && value.includes('{{cache_') ? cleanMacros(value) : value; }
function cleanTextPart(part) {
    // Canonical reasoning, native payloads, tool arguments, media and signatures
    // are opaque. Do not recursively rewrite arbitrary JSON string properties.
    if (!object(part) || ownValue(part, 'type') !== 'text' || ownValue(part, 'thought') === true) return part;
    const text = ownValue(part, 'text'), next = cleanText(text);
    return next === text ? part : replaceOwn(part, new Map([['text', next]]));
}
function cleanMessage(message) {
    if (!object(message) || ownValue(message, 'role') === 'tool') return message;
    const updates = new Map(), parts = ownValue(message, 'parts'), content = ownValue(message, 'content');
    if (Array.isArray(parts)) {
        const next = mapChanged(parts, cleanTextPart);
        if (next !== parts) updates.set('parts', next);
    }
    const nextContent = Array.isArray(content) ? mapChanged(content, cleanTextPart) : cleanText(content);
    if (nextContent !== content) updates.set('content', nextContent);
    return replaceOwn(message, updates);
}
function cleanEnvelope(value, markers, messages = false) {
    if (!object(value)) return value;
    const removed = markers.filter(key => Object.hasOwn(value, key)), updates = new Map();
    if (messages) for (const key of ['messages', 'prompt']) {
        const original = ownValue(value, key);
        if (!Array.isArray(original)) continue;
        const next = mapChanged(original, cleanMessage);
        if (next !== original) updates.set(key, next);
    }
    return replaceOwn(value, updates, removed);
}

export function sanitizeTauriAgentPromptSnapshot(snapshot, { requestStateKey = DEFAULT_STATE_KEY } = {}) {
    if (!object(snapshot)) return snapshot;
    const markers = [...new Set([...MARKERS, stateKey(requestStateKey)])];
    const cleaned = cleanEnvelope(snapshot, markers, true), updates = new Map();
    const parameters = ownValue(cleaned, 'generationParameters');
    if (object(parameters)) {
        const next = cleanEnvelope(parameters, markers);
        if (next !== parameters) updates.set('generationParameters', next);
    }
    for (const key of LEGACY_PAYLOADS) {
        const payload = ownValue(cleaned, key);
        if (!object(payload)) continue;
        const next = cleanEnvelope(payload, markers, true);
        if (next !== payload) updates.set(key, next);
    }
    return replaceOwn(cleaned, updates);
}

export function installTauriAgentTransport({ target = globalThis, requestStateKey = DEFAULT_STATE_KEY,
    prepareParameters, observeSnapshot, getPromptMigration = () => null,
    loadAssemblyModules, onAssembly } = {}) {
    stateKey(requestStateKey);
    if (prepareParameters !== undefined && typeof prepareParameters !== 'function') throw new TypeError('Agent 参数准备接口必须是函数。');
    if (observeSnapshot !== undefined && typeof observeSnapshot !== 'function') throw new TypeError('Agent 快照观察接口必须是函数。');
    const broker = target?.__TAURITAVERN__?.invoke?.broker;
    const original = broker?.invoke;
    let assembly;
    try { assembly = installTauriAgentAssembly({ target, getPromptMigration, loadModules: loadAssemblyModules, onAssembly }); }
    catch { /* Initial input capture and hygiene remain available independently. */ }
    if (typeof original !== 'function') return { available: false, assembly,
        destroy() { assembly?.destroy(); } };
    const descriptor = Object.getOwnPropertyDescriptor(broker, 'invoke');
    let destroyed = false;
    function dispatch(thisValue, command, args, extras, snapshot) {
        const next = sanitizeTauriAgentPromptSnapshot(snapshot, { requestStateKey });
        const dto = ownValue(args, 'dto');
        const forwarded = next === ownValue(dto, 'promptSnapshot') ? args
            : replaceOwn(args, new Map([['dto', replaceOwn(dto, new Map([['promptSnapshot', next]]))]]));
        return original.call(thisValue, command, forwarded, ...extras);
    }
    function wrapper(command, args, ...extras) {
        if (destroyed || typeof command !== 'string' || !COMMANDS.has(command.trim())) return original.call(this, command, args, ...extras);
        const dto = ownValue(args, 'dto'), snapshot = ownValue(dto, 'promptSnapshot');
        if (!object(snapshot)) return original.call(this, command, args, ...extras);
        const parameters = ownValue(snapshot, 'generationParameters');
        const metadata = ownValue(parameters, requestStateKey) ?? ownValue(parameters, '__vertexPayGoRequestState');
        if (observeSnapshot) {
            try {
                // Observer inputs belong to the caller and must be treated as
                // read-only. Observation neither delays nor gates generation.
                const observed = observeSnapshot(snapshot, { command, requestMetadata: metadata,
                    assemblyEvidence: assembly?.getEvidenceSnapshot?.(snapshot) ?? null,
                    dispatch: { chatRef: ownValue(dto, 'chatRef'), stableChatId: ownValue(dto, 'stableChatId'),
                        presentation: ownValue(ownValue(dto, 'options'), 'presentation'), runId: ownValue(dto, 'runId'),
                        assemblyId: ownValue(dto, 'assemblyId') } });
                if (observed && typeof observed.then === 'function') Promise.resolve(observed).catch(() => {});
            } catch { /* A diagnostic observer cannot affect an Agent request. */ }
        }
        try {
            if (!prepareParameters || !object(parameters)) return dispatch(this, command, args, extras, snapshot);
            const prepared = prepareParameters(parameters, metadata);
            const continueDispatch = next => {
                if (!object(next)) throw new TypeError('Agent 参数准备接口必须返回对象。');
                const preparedSnapshot = next === parameters ? snapshot
                    : replaceOwn(snapshot, new Map([['generationParameters', next]]));
                return dispatch(this, command, args, extras, preparedSnapshot);
            };
            // Gate failures always propagate. No rejected preparation ever
            // falls back to forwarding the original paid request.
            return prepared && typeof prepared.then === 'function'
                ? Promise.resolve(prepared).then(continueDispatch) : continueDispatch(prepared);
        } catch (error) { return Promise.reject(error); }
    }
    try {
        if (descriptor && 'value' in descriptor) Object.defineProperty(broker, 'invoke', { ...descriptor, value: wrapper });
        else Object.defineProperty(broker, 'invoke', { value: wrapper, enumerable: descriptor?.enumerable ?? true,
            configurable: true, writable: true });
    } catch {
        assembly?.destroy();
        return { available: false, assembly, destroy() { assembly?.destroy(); } };
    }
    return {
        get available() { return !destroyed; },
        assembly,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            assembly?.destroy();
            // A later extension may retain this wrapper in its own chain.
            // Leave its property intact; this wrapper now transparently delegates.
            if (broker.invoke !== wrapper) return;
            if (descriptor) Object.defineProperty(broker, 'invoke', descriptor);
            else delete broker.invoke;
        },
    };
}
