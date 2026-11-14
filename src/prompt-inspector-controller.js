/* Automatic final prompt evidence. Latest snapshot per chat/connection in tab-session storage; no settings, logs, or model calls. */
import { completionIdentity } from './worldinfo-stability.js';
import { createPromptInspectorSessionStore } from './prompt-inspector-session.js';
import { canonicalHistoryId, describePromptSource } from './prompt-inspector-sources.js';
import { createConversationId } from './cost-context.js';
export const PROMPT_INSPECTOR_FIELD = '__vertexPayGoPromptInspector';
const validSource = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value);
const GOOGLE = new Set(['vertexai', 'makersuite']);
const SOURCE_KINDS = new Set(['preset', 'character', 'persona', 'worldinfo-blue', 'worldinfo-green',
    'worldinfo-depth', 'worldinfo-other', 'author-note', 'memory', 'extension', 'history', 'input', 'unknown']);
const NATIVE = new Set(['custom', 'openai', 'claude']);
const NATIVE_REQUEST_FIELDS = ['reverse_proxy', 'proxy_password', 'secret_id', 'custom_url', 'custom_include_headers', 'custom_api_format'];
const FOREGROUND = new Set([undefined, null, '', 'normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);
const LIMIT = Object.freeze({ traceBytes: 1024 * 1024, frontendBytes: 2 * 1024 * 1024, sources: 256, stages: 6, events: 64, tickets: 8 });
const FRONTEND_PROMPT_FIELDS = ['messages', 'tools', 'tool_choice', 'functions', 'function_call', 'json_schema',
    'response_format', 'instructions', 'input', 'prompt'];
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const clone = value => JSON.parse(JSON.stringify(value));
function ownData(value, key) {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function frontendPromptBody(data, model) {
    const body = { model };
    for (const field of FRONTEND_PROMPT_FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(data, field);
        if (descriptor && 'value' in descriptor && descriptor.value !== undefined) body[field] = descriptor.value;
    }
    if (!Array.isArray(body.messages)) throw new TypeError('前端组装的消息不可用。');
    const raw = JSON.stringify(body);
    if (raw.length > LIMIT.frontendBytes || bytes(raw) > LIMIT.frontendBytes) throw new RangeError('Frontend prompt is too large.');
    return raw;
}
const INFO = Object.freeze({
    PUBLIC_EVENTS_UNAVAILABLE: '当前酒馆缺少聊天生成事件，无法记录提示词。',
    SERVER_UNAVAILABLE: '提示词记录接口不可用，请检查后端版本并重启酒馆。',
    UNSUPPORTED_SCOPE: '仅支持当前聊天的聊天补全请求。',
    RECORD_UNAVAILABLE: '无法读取本次请求记录；生成不受影响。',
    CAPTURE_UNAVAILABLE: '本次请求未启用记录；生成不受影响。',
    RECORD_TOO_LARGE: '消息或请求记录超过查看上限，未保存截断正文。',
    RECORD_EXPIRED: '临时记录已过期，下一次发送将自动记录。',
});
const kindFor = identifier => {
    if (['charDescription', 'charPersonality', 'scenario'].includes(identifier)) return 'character';
    if (['personaDescription', 'persona'].includes(identifier)) return 'persona';
    if (identifier === 'authorsNote') return 'author-note';
    return 'preset';
};
const wiKind = entry => [2, 3, 4].includes(entry.position) ? 'worldinfo-depth' : entry.constant === true ? 'worldinfo-blue' : 'worldinfo-green';

export function createPromptInspectorController({ context, getContext = () => context, serverClient,
    getChatId = () => getContext()?.getCurrentChatId?.(), getPluginState = () => ({}), target = globalThis,
    now = () => Date.now(), delay = ms => new Promise(resolve => setTimeout(resolve, ms)), readAttempts = 5,
    getOwner = () => null, getSessionStorage = () => target.sessionStorage,
    sessionCrypto = target.crypto ?? globalThis.crypto, frontendChatScope = false } = {}) {
    const listeners = new Set(), subscriptions = [], pending = new Map();
    let destroyed = false, enabled = true, backendAvailable = false, status = 'idle', error = null;
    let nativeRelaySources = new Set(), lastCapabilityCheck = 0;
    let armedScope = null, generation = null, epoch = 0, ordinal = 0, requestOrdinal = 0, recordOrdinal = 0, record = null, latestTicket = null, recordReservation = null;
    const sessionStore = createPromptInspectorSessionStore({ getStorage: getSessionStorage, cryptoRef: sessionCrypto, now });
    let restorePending = true, restoration = null, restoredRecord = false;
    let persistence = { status: 'empty' };
    let trace = emptyTrace(), promptRefs = [], sourceIndex = new Map(), stageIndex = new Map(), capabilitySerial = 0;
    const publicCaptureAvailable = typeof context?.eventTypes?.GENERATION_STARTED === 'string'
        && typeof context?.eventSource?.on === 'function' && typeof context?.eventSource?.removeListener === 'function';
    function emptyTrace() { return { version: 1, complete: false, reason: 'PUBLIC_EVENT_CAPTURE', sources: [], stages: [], events: [] }; }
    const sourceAvailable = () => Boolean((record?.trace?.sources ?? trace.sources)?.length);
    function scope() {
        try {
            const c = getContext(), identity = completionIdentity(c), chatId = getChatId();
            const suppliedOwner = getOwner(), owner = typeof suppliedOwner === 'string' && suppliedOwner.length > 0
                && suppliedOwner.length <= 256 ? suppliedOwner : null;
            if (!identity || !validSource(identity.source) || c?.mainApi !== 'openai'
                || typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) return null;
            const settings = c.chatCompletionSettings;
            if (frontendChatScope) return { ...identity, chatId, owner, key: JSON.stringify(['frontend-chat', owner, chatId,
                c.groupId ?? null, c.characters?.[c.characterId]?.avatar ?? c.characterId ?? null]) };
            return { ...identity, chatId, owner, key: JSON.stringify([owner, chatId, identity, c.groupId ?? null,
                c.characters?.[c.characterId]?.avatar ?? c.characterId ?? null,
                c.extensionSettings?.connectionManager?.selectedProfile ?? null, settings?.custom_url ?? null,
                settings?.reverse_proxy ?? null, identity.source === 'vertexai' ? [settings?.vertexai_region ?? null,
                    settings?.vertexai_auth_mode ?? null, settings?.vertexai_express_project_id ?? null] : null]) };
        } catch { return null; }
    }
    const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* UI cannot affect evidence. */ } } };
    const fail = code => { error = { code, message: (INFO[code] ?? INFO.RECORD_UNAVAILABLE)
        + (record ? ' 已保留上一轮提示词。' : '') }; status = 'error'; emit(); };
    function resetTrace() { trace = emptyTrace(); sourceIndex = new Map(); stageIndex = new Map(); promptRefs = []; }
    function cancelReservation(value) {
        if (!value) return;
        value.cancelled = true;
        if (value.captureMode === 'frontend') { value.rawRequest = null; value.trace = null; value.snapshot = null; }
        releaseNativeProxy(value);
    }
    function disposeNativeTicket(ticket) {
        if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(ticket)) return;
        try { serverClient?.cancelNativeRequest?.(ticket)?.catch?.(() => {}); } catch { /* Request-scoped relay cleanup. */ }
    }
    function releaseNativeProxy(value) {
        const native = value?.nativeProxy;
        if (!native) return;
        value.nativeProxy = null; disposeNativeTicket(native.ticket);
    }
    function disposeTicket(ticket) {
        if (typeof ticket !== 'string' || ticket.startsWith('frontend-')) return;
        try { const promise = serverClient?.clearPromptInspector?.(ticket); promise?.catch?.(() => {}); } catch { /* Optional capture cleanup. */ }
    }
    function release({ disable = false, notify = true, clearSaved = false } = {}) {
        epoch++; restoration = null;
        const clearing = clearSaved && armedScope ? sessionStore.clear(armedScope) : null;
        if (!clearing) sessionStore.cancel();
        persistence = { status: 'empty' };
        restoredRecord = false;
        for (const value of pending.values()) cancelReservation(value);
        cancelReservation(recordReservation);
        for (const ticket of new Set([...pending.keys(), ...(latestTicket ? [latestTicket] : [])])) disposeTicket(ticket);
        pending.clear(); latestTicket = null; record = null; recordOrdinal = 0; recordReservation = null; generation = null; error = null; resetTrace();
        if (disable) { enabled = false; armedScope = null; }
        status = enabled ? 'idle' : 'disabled'; if (notify) emit();
        return clearing ?? Promise.resolve();
    }
    function validScope() {
        const current = scope();
        if (enabled && (current?.key ?? null) !== armedScope) {
            release({ notify: false }); armedScope = current?.key ?? null; restorePending = true;
        }
        return current;
    }
    async function restoreSaved() {
        const current = validScope();
        if (destroyed || !enabled || !restorePending || !current?.owner || record) return record;
        if (restoration?.scope === current.key && restoration?.epoch === epoch) return restoration.promise;
        const token = { scope: current.key, epoch };
        persistence = { status: 'loading' };
        token.promise = (async () => {
            const saved = await sessionStore.load(current.key);
            if (destroyed || !enabled || epoch !== token.epoch || validScope()?.key !== token.scope
                || !restorePending || record || saved.status === 'cancelled') return record;
            restorePending = false; persistence = { status: saved.status, savedAt: saved.savedAt };
            const value = saved.record;
            if (value && value.chatId === current.chatId && (frontendChatScope
                ? value.metadata?.captureKind === 'frontend-messages' : value.source === current.source && value.model === current.model)) {
                record = value; recordOrdinal = 0; recordReservation = null; latestTicket = null; restoredRecord = true;
                status = generation?.active ? 'recording' : pending.size ? 'pending' : 'ready'; error = null;
            } else if (value) { await sessionStore.clear(current.key);
                if (destroyed || epoch !== token.epoch || validScope()?.key !== token.scope) return record;
                persistence = { status: 'invalid' }; }
            if (restoration === token) restoration = null;
            emit(); return record;
        })();
        restoration = token; return token.promise;
    }
    async function saveRecord(value, current) {
        const savedEpoch = epoch;
        // Unknown owner: capture still works, but never restore across accounts using a default identity.
        if (!current?.owner) { sessionStore.cancel(); persistence = { status: 'unavailable' }; emit(); return; }
        const result = await sessionStore.save(current.key, value);
        if (destroyed || epoch !== savedEpoch || validScope()?.key !== current.key || record !== value || result.status === 'cancelled') return;
        persistence = result; emit();
    }
    const active = () => {
        const current = validScope();
        return !destroyed && enabled && publicCaptureAvailable && generation?.active
            && generation.startedEnabled && !!current && current.key === generation.scope;
    };
    function incomplete(reason) { trace.complete = false; trace.reason ??= reason; }
    function fits(candidate) { try { return bytes(candidate) <= LIMIT.traceBytes; } catch { return false; } }
    function addSource(value) {
        if (!active() || typeof value?.text !== 'string' || !value.text.length) return;
        try {
            if (bytes(value.text) > LIMIT.traceBytes) { incomplete('SOURCE_LIMIT'); return; }
            const existing = sourceIndex.get(value.id), next = clone(value);
            const sources = existing ? trace.sources.map(source => source.id === next.id ? next : source) : [...trace.sources, next];
            if (sources.length > LIMIT.sources || !fits({ ...trace, sources })) { incomplete('SOURCE_LIMIT'); return; }
            trace.sources = sources; sourceIndex.set(next.id, next);
        } catch { incomplete('SOURCE_UNAVAILABLE'); }
    }
    function addEvent(value) {
        if (trace.events.length >= LIMIT.events) { incomplete('EVENT_LIMIT'); return; }
        const next = { ...value, evidence: 'observed' };
        if (fits({ ...trace, events: [...trace.events, next] })) trace.events.push(clone(next)); else incomplete('EVENT_LIMIT');
    }
    function captureStage(id, messages, preparedPrompts) {
        if (!active() || !Array.isArray(messages)) return;
        try {
            if (id === 'post-plugin') for (const prompt of preparedPrompts?.collection ?? promptRefs) {
                const source = sourceIndex.get('prompt:' + prompt.identifier);
                const texts = messages.flatMap(message => typeof message?.content === 'string' ? [message.content]
                    : (Array.isArray(message?.content) ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text) : []));
                if (source && typeof prompt.content === 'string' && source.text !== prompt.content
                    && texts.some(text => prompt.content && text.includes(prompt.content)))
                    addSource({ ...source, originalText: source.originalText ?? source.text, text: prompt.content });
            }
            const labels = { assembled: '酒馆组装结果（已接受的消息）', 'post-plugin': '插件处理后的前端消息',
                'prompt-ready': '提示词就绪事件（前端）', 'frontend-final': '酒馆前端最终消息',
                'settings-ready': '请求参数就绪事件（前端）', 'frontend-request': '进入后端前的消息' };
            const serialized = JSON.stringify(messages);
            if (serialized.length > LIMIT.traceBytes || bytes(serialized) > LIMIT.traceBytes) { incomplete('STAGE_LIMIT'); return; }
            const stage = { id, label: labels[id] ?? id, messages: JSON.parse(serialized), complete: true };
            const stages = stageIndex.has(id) ? trace.stages.map(v => v.id === id ? stage : v) : [...trace.stages, stage];
            if (stages.length > LIMIT.stages || !fits({ ...trace, stages })) { incomplete('STAGE_LIMIT'); return; }
            trace.stages = stages; stageIndex.set(id, stage);
        } catch { incomplete('STAGE_UNAVAILABLE'); }
    }
    const observer = {
        captureRuntimeSnapshot(payload) {
            if (!active() || !payload || typeof payload !== 'object') return;
            if (Array.isArray(payload.sources)) {
                if (payload.sources.length > LIMIT.sources) incomplete('SOURCE_LIMIT');
                for (const value of payload.sources.slice(0, LIMIT.sources)) {
                    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 512
                        || typeof value.text !== 'string') { incomplete('SOURCE_UNAVAILABLE'); continue; }
                    const identifier = typeof value.identifier === 'string' ? value.identifier
                        : value.id.startsWith('prompt:') ? value.id.slice(7) : '';
                    const worldInfo = ['worldInfoBefore', 'worldInfoAfter'].includes(identifier);
                    const label = worldInfo ? identifier === 'worldInfoBefore' ? '世界书前段' : '世界书后段'
                        : typeof value.label === 'string' && value.label ? value.label : identifier || value.id;
                    const source = { id: value.id, identifier, label,
                        kind: SOURCE_KINDS.has(value.kind) ? value.kind : value.aggregate === true ? 'extension'
                            : worldInfo ? 'worldinfo-other' : identifier === 'dialogueExamples' ? 'character' : kindFor(identifier), text: value.text };
                    for (const field of ['role', 'position', 'depth', 'priority']) if (typeof value[field] === 'string'
                        || (typeof value[field] === 'number' && Number.isFinite(value[field]))) source[field] = value[field];
                    if (typeof value.originalText === 'string') source.originalText = value.originalText;
                    if (typeof value.world === 'string') source.world = value.world;
                    if (typeof value.outletName === 'string') source.outletName = value.outletName;
                    if (Number.isSafeInteger(value.uid) && value.uid >= 0) source.uid = value.uid;
                    if (typeof value.constant === 'boolean') source.constant = value.constant;
                    if (value.aggregate === true) {
                        source.aggregate = true;
                        if (Array.isArray(value.inputs)) {
                            if (value.inputs.length > 128) incomplete('SOURCE_LIMIT');
                            source.inputs = value.inputs.slice(0, 128).filter(input => input && typeof input.id === 'string'
                                && input.id.length <= 512 && typeof input.label === 'string' && input.label.length <= 512
                                && ['prompt', 'extension-prompt'].includes(input.kind))
                                .map(input => ({ id: input.id, label: input.label, kind: input.kind }));
                        }
                    }
                    const previous = sourceIndex.get(source.id);
                    if (previous && previous.text !== source.text && source.originalText === undefined)
                        source.originalText = previous.originalText ?? previous.text;
                    addSource(source);
                }
            }
            if (typeof payload.stage === 'string' && ['assembled', 'post-plugin', 'prompt-ready', 'frontend-final'].includes(payload.stage)) {
                captureStage(payload.stage, payload.messages);
            }
            trace.complete = false;
        },
        captureWorldInfo(data) {
            if (!active()) return;
            if (!Array.isArray(data?.records)) { incomplete('WI_SOURCE_UNAVAILABLE'); return; }
            for (const item of data.records) {
                if (!item || !item.entry || typeof item.entry !== 'object' || typeof item.text !== 'string'
                    || typeof item.entry.world !== 'string' || !Number.isSafeInteger(item.entry.uid)) { incomplete('WI_SOURCE_UNAVAILABLE'); continue; }
                const entry = item.entry, kind = wiKind(entry);
                addSource({ id: `wi:${entry.world}:${entry.uid}`, kind,
                    label: `${entry.world ?? '世界书'} · ${entry.comment || entry.name || ('条目 ' + entry.uid)}`,
                    text: item.text, world: entry.world, uid: entry.uid, constant: entry.constant === true,
                    position: entry.position, depth: entry.depth, role: entry.role });
            }
            if (typeof data.originalAN === 'string') addSource({ id: 'author-note:original', kind: 'author-note', label: '作者注释', text: data.originalAN });
        },
        captureTemplate(original, prepared) {
            if (!active() || !prepared) return;
            const id = prepared.identifier ?? original?.identifier;
            if (['worldInfoBefore', 'worldInfoAfter'].includes(id)) return;
            if ((id === 'impersonate' && generation?.type !== 'impersonate')
                || (id === 'quietPrompt' && generation?.type !== 'quiet')
                || (id === 'groupNudge' && getContext()?.groupId == null)) return;
            const sourceId = canonicalHistoryId({ identifier: id }) ?? 'prompt:' + id;
            const descriptor = describePromptSource({ id: sourceId, identifier: id, kind: kindFor(id),
                label: sourceIndex.get(sourceId)?.label || original?.name || prepared.name || String(id ?? '') });
            addSource({ id: sourceId, ...descriptor,
                text: prepared.content, ...(typeof original?.content === 'string' && original.content !== prepared.content ? { originalText: original.content } : {}), identifier: id, position: prepared.injection_position,
                depth: prepared.injection_depth, role: prepared.role });
        },
        beginNative(prompts, dryRun, examples, messages) {
            if (!active() || dryRun) return;
            promptRefs = (prompts?.collection ?? []).filter(p => typeof p?.content === 'string');
            for (const p of promptRefs) this.captureTemplate(p, p);
            for (const [index, message] of (messages ?? []).entries()) if (typeof message?.content === 'string')
                addSource({ id: 'conversation:' + index, kind: 'history', label: `第 ${index + 1} 条聊天消息`, text: message.content, role: message.role });
            for (const [index, dialogue] of (examples ?? []).entries()) for (const [part, message] of (Array.isArray(dialogue) ? dialogue : []).entries())
                if (typeof message?.content === 'string') addSource({ id: `example:${index}:${part}`, kind: 'character', label: `示例对话 ${index + 1}`, text: message.content, role: message.role });
        },
        captureExtensionSource(data) {
            if (!active() || typeof data?.id !== 'string') return;
            if (data.id.startsWith('customDepthWI_') || data.id === '2_floating_prompt') return;
            const memory = ['qqj_v3_prequel_context', 'qqj_v3_recalled_context'].includes(data.id);
            addSource({ id: 'extension:' + data.id, kind: memory ? 'memory' : 'extension', label: data.id,
                text: data.text, position: data.position, depth: data.depth, role: data.role });
        },
        captureStage,
        captureUnavailable() { if (active()) incomplete('SOURCE_CAPTURE_UNAVAILABLE'); },
    };
    function listen(name, fn) {
        const event = context?.eventTypes?.[name];
        if (typeof event === 'string' && typeof context?.eventSource?.on === 'function') {
            subscriptions.push([event, fn]);
            try { context.eventSource.on(event, fn); }
            catch (error) {
                destroyed = true; sessionStore.destroy();
                for (const [registered, listener] of subscriptions) {
                    try { context.eventSource.removeListener?.(registered, listener); } catch { /* Release the other subscriptions. */ }
                }
                subscriptions.length = 0; throw error;
            }
        }
    }
    listen('GENERATION_STARTED', (type, _options, dryRun) => {
        resetTrace(); const current = validScope();
        if (!dryRun && FOREGROUND.has(type)) {
            void restoreSaved();
        }
        generation = { type, active: !dryRun && FOREGROUND.has(type),
            startedEnabled: enabled, scope: current?.key, serial: ++ordinal };
        if (enabled) { status = 'recording'; error = null; emit(); }
    });
    listen('CHAT_COMPLETION_PROMPT_READY', event => {
        if (event?.dryRun !== false || !Array.isArray(event.chat)) return;
        captureStage('prompt-ready', event.chat);
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) listen(name, () => {
        if (generation) generation.active = false; resetTrace(); if (enabled && !pending.size) status = record ? 'ready' : 'idle'; emit();
    });
    for (const name of ['CHAT_CHANGED', 'SETTINGS_LOADED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED'])
        listen(name, () => { validScope(); void restoreSaved(); emit(); });

    async function refreshCapabilities() {
        if (destroyed) return false;
        const serial = ++capabilitySerial;
        try {
            const health = await serverClient?.checkHealth?.(), cap = health?.capabilities?.promptInspector;
            if (!destroyed && serial === capabilitySerial) {
                backendAvailable = Boolean(cap === true || (cap && typeof cap === 'object' && cap.available !== false && cap.enabled !== false));
                nativeRelaySources = new Set(backendAvailable && Array.isArray(cap?.pluginWireSources)
                    && typeof serverClient?.prepareNativeRequest === 'function' ? cap.pluginWireSources.filter(source => NATIVE.has(source)) : []);
                lastCapabilityCheck = now();
            }
        } catch { if (!destroyed && serial === capabilitySerial) {
            backendAvailable = false; nativeRelaySources.clear(); lastCapabilityCheck = now();
        } }
        return backendAvailable;
    }
    async function reserveRequest(data, { background = false, chatId, providerCapture = true, signal, capturePhase } = {}) {
        if (background || signal?.aborted || !active()) return null;
        const current = validScope(), currentEpoch = epoch;
        const generationSerial = generation.serial;
        const frontendOnly = frontendChatScope && providerCapture === false;
        const payloadSource = frontendOnly ? ownData(data, 'chat_completion_source') : data?.chat_completion_source;
        const payloadModel = frontendOnly ? ownData(data, 'model') : data?.model;
        const legalPayloadIdentity = validSource(payloadSource) && typeof payloadModel === 'string' && payloadModel.length > 0
            && payloadModel.length <= 256 && payloadModel.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(payloadModel);
        if (!current || (chatId && chatId !== current.chatId) || (frontendOnly ? !legalPayloadIdentity
            : payloadSource !== current.source || payloadModel !== current.model)) return null;
        const requestIdentity = frontendOnly ? { source: payloadSource, model: payloadModel } : current;
        const identityChanged = requestIdentity.source !== current.source || requestIdentity.model !== current.model;
        const pluginWire = GOOGLE.has(current.source) && providerCapture !== false;
        const nativeCandidate = !frontendOnly && !pluginWire && NATIVE.has(current.source) && typeof serverClient?.prepareNativeRequest === 'function';
        const stillPreparing = () => !signal?.aborted && !destroyed && enabled && epoch === currentEpoch
            && validScope()?.key === current.key && generation?.serial === generationSerial && active();
        // First request does not depend on opening the viewer or a prior health check.
        // Source observations are already captured synchronously before this await.
        if ((pluginWire && !backendAvailable) || (nativeCandidate && (!lastCapabilityCheck || now() - lastCapabilityCheck >= 30000))) {
            await refreshCapabilities();
            if (!stillPreparing()) return null;
            if (pluginWire && !backendAvailable) { fail('SERVER_UNAVAILABLE'); return null; }
        }
        if (!identityChanged) captureStage(capturePhase === 'settings-ready' ? 'settings-ready' : 'frontend-request', data.messages);
        try {
            if (!identityChanged) {
                const plugin = getPluginState(), scan = plugin?.sorting?.lastScan;
                if (scan?.valid && scan.changed > 0) addEvent({ kind: 'stable-sort', label: `世界书稳定排序：${scan.changed} 个条目位置调整`,
                    before: scan.before?.map(v => ({ world: v.world, uid: v.uid })), after: scan.after?.map(v => ({ world: v.world, uid: v.uid })) });
                for (const [owner, collection] of Object.entries(plugin?.migration?.last?.collections ?? {})) if (collection?.count > 0)
                    addEvent({ kind: 'macro-migration', label: `${owner === 'green' ? '绿灯' : '@D／作者注释'}宏搬迁：${collection.count} 段`,
                        after: { owner, count: collection.count, groups: collection.groups } });
                const setting = data.custom_prompt_post_processing;
                if (typeof setting === 'string' && setting.length < 128) addEvent({ kind: 'api-setting', label: '酒馆 API 后处理设置', after: setting });
            }
            const evidence = identityChanged ? { ...emptyTrace(), reason: 'SOURCE_CHANGED' } : clone(trace);
            if (!fits(evidence)) { evidence.sources = []; evidence.stages = []; evidence.complete = false; evidence.reason = 'TRACE_LIMIT'; }
            if (!pluginWire) {
                if (!Array.isArray(data.messages)) { fail('CAPTURE_UNAVAILABLE'); return null; }
                let rawRequest;
                try { rawRequest = frontendPromptBody(data, requestIdentity.model); }
                catch (failure) { fail(failure instanceof RangeError ? 'RECORD_TOO_LARGE' : 'CAPTURE_UNAVAILABLE'); return null; }
                if (nativeCandidate && nativeRelaySources.has(current.source)) {
                    let issued, native;
                    try {
                        issued = await serverClient.preparePromptInspector({ version: 1, chatId: current.chatId,
                            source: current.source, model: current.model, trace: evidence });
                        if (!stillPreparing()) { disposeTicket(issued?.ticket); return null; }
                        if (typeof issued?.ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(issued.ticket)) throw new TypeError('提示词查看凭证无效');
                        const request = { version: 1, source: current.source, model: current.model, chatId: current.chatId,
                            promptInspectorTicket: issued.ticket };
                        for (const field of NATIVE_REQUEST_FIELDS) if (data[field] !== undefined && data[field] !== null) request[field] = data[field];
                        native = await serverClient.prepareNativeRequest(request);
                        if (!stillPreparing()) { disposeNativeTicket(native?.ticket); disposeTicket(issued.ticket); return null; }
                        if (native?.ok !== true || native.source !== current.source || native.transport !== 'native-loopback-http'
                            || typeof native.ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(native.ticket)
                            || !native.requestOverrides || typeof native.requestOverrides !== 'object') throw new TypeError('原生请求准备信息无效');
                        if (pending.size >= LIMIT.tickets) {
                            const first = pending.keys().next().value; cancelReservation(pending.get(first)); disposeTicket(first); pending.delete(first);
                        }
                        const value = { ticket: issued.ticket, chatId: current.chatId, source: current.source, model: current.model,
                            scope: current.key, epoch: currentEpoch, ordinal: generationSerial, requestOrdinal: ++requestOrdinal,
                            createdAt: now(), captureMode: 'native', nativeProxy: native };
                        pending.set(value.ticket, value); latestTicket = value.ticket; status = 'pending'; error = null; emit(); return value;
                    } catch (failure) {
                        disposeNativeTicket(native?.ticket ?? failure?.nativeTicket); disposeTicket(issued?.ticket);
                        if (!stillPreparing()) return null;
                        // Unsupported native routing remains a read-only frontend snapshot.
                    }
                }
                const ticket = 'frontend-' + createConversationId(target.crypto ?? globalThis.crypto);
                const value = { ticket, chatId: current.chatId, source: requestIdentity.source, model: requestIdentity.model,
                    scope: current.key, epoch: currentEpoch, ordinal: generationSerial, requestOrdinal: ++requestOrdinal,
                    createdAt: now(), captureMode: 'frontend', rawRequest, trace: evidence, stream: data.stream === true,
                    capturePhase: ['settings-ready', 'tauri-dispatch'].includes(capturePhase) ? capturePhase : 'frontend-dispatch' };
                if (pending.size >= LIMIT.tickets) {
                    const first = pending.keys().next().value; cancelReservation(pending.get(first));
                    disposeTicket(first); pending.delete(first);
                }
                pending.set(ticket, value); latestTicket = ticket; status = 'pending'; error = null; emit(); return value;
            }
            const issued = await serverClient?.preparePromptInspector?.({ version: 1, chatId: current.chatId,
                source: current.source, model: current.model, trace: evidence });
            if (!stillPreparing()) { if (typeof issued?.ticket === 'string') disposeTicket(issued.ticket); return null; }
            if (typeof issued?.ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(issued.ticket)) { fail('CAPTURE_UNAVAILABLE'); return null; }
            if (pending.size >= LIMIT.tickets) {
                const first = pending.keys().next().value; cancelReservation(pending.get(first)); disposeTicket(first); pending.delete(first);
            }
            const value = { ticket: issued.ticket, chatId: current.chatId, source: current.source, model: current.model,
                scope: current.key, epoch: currentEpoch, ordinal: generationSerial, requestOrdinal: ++requestOrdinal,
                createdAt: now(), captureMode: 'google' };
            pending.set(value.ticket, value); latestTicket = value.ticket; status = 'pending'; error = null; emit(); return value;
        } catch { if (destroyed || !enabled || epoch !== currentEpoch || validScope()?.key !== current.key) return null; fail('CAPTURE_UNAVAILABLE'); return null; }
    }
    function updateFrontendRequest(value, data, { background = false, chatId, signal, capturePhase = 'frontend-dispatch' } = {}) {
        if (background || signal?.aborted || !active() || value?.captureMode !== 'frontend'
            || value.cancelled || value.finalized || value.dispatched || value.snapshot || pending.get(value.ticket) !== value) return null;
        const current = validScope();
        if (!current || value.epoch !== epoch || value.scope !== current.key || value.ordinal !== generation?.serial
            || (chatId !== undefined && chatId !== current.chatId)
            || data?.chat_completion_source !== value.source || data?.model !== value.model) return null;
        try {
            value.rawRequest = frontendPromptBody(data, value.model);
            value.stream = data.stream === true;
            value.capturePhase = capturePhase === 'tauri-dispatch' ? 'tauri-dispatch' : 'frontend-dispatch';
            value.finalized = true;
            return value;
        } catch (failure) {
            fail(failure instanceof RangeError ? 'RECORD_TOO_LARGE' : 'CAPTURE_UNAVAILABLE');
            return null;
        }
    }
    function ownsFrontendCandidate(value) {
        const current = scope();
        return !destroyed && enabled && publicCaptureAvailable && generation?.active === true && generation.startedEnabled
            && value?.captureMode === 'frontend' && value.capturePhase === 'settings-ready' && !value.cancelled
            && !value.finalized && !value.dispatched && !value.snapshot && pending.get(value.ticket) === value
            && value.epoch === epoch && value.ordinal === generation.serial
            && value.scope === generation.scope && value.scope === armedScope && value.scope === current?.key;
    }
    function commitFrontendRecord(value, { dispatch = false, settle = false, responseOk, httpStatus, failed = false } = {}) {
        if (value?.captureMode !== 'frontend' || !value.ticket || value.cancelled || destroyed || !enabled
            || value.epoch !== epoch || value.scope !== validScope()?.key || pending.get(value.ticket) !== value) return null;
        if (!restoredRecord && recordOrdinal > value.requestOrdinal) {
            value.rawRequest = null; value.trace = null; value.snapshot = null;
            if (settle) pending.delete(value.ticket);
            return record;
        }
        const current = validScope(), timestamp = now();
        let snapshot = value.snapshot;
        if (!snapshot) {
            if (typeof value.rawRequest !== 'string' || !value.trace) return null;
            const evidence = clone(value.trace);
            evidence.stages = evidence.stages.filter(stage => stage.id !== 'frontend-request');
            snapshot = { version: 1, id: value.ticket, chatId: value.chatId, source: value.source, model: value.model,
                sequence: value.requestOrdinal, state: 'observed', complete: true, rawRequest: value.rawRequest,
                capturedAt: new Date(value.createdAt).toISOString(), trace: evidence,
                metadata: { captureKind: 'frontend-messages', bodyEvidence: 'frontend-messages',
                    transport: value.capturePhase === 'tauri-dispatch' ? 'tauri-frontend' : 'frontend',
                    capturePhase: value.capturePhase, networkBytesVerified: false, providerBodyAvailable: false,
                    frontendMessagesComplete: true, stream: value.stream } };
        }
        if (dispatch || (settle && value.capturePhase !== 'settings-ready')) {
            if (!value.dispatched) value.dispatchAt = timestamp;
            value.dispatched = true;
            snapshot = { ...snapshot, state: 'dispatched', dispatchAt: new Date(value.dispatchAt).toISOString(),
                metadata: { ...snapshot.metadata, ...(value.capturePhase === 'tauri-dispatch'
                    ? { association: 'current-chat-frontend', handoffConfirmed: true } : {}) } };
        }
        if (settle && (failed || typeof responseOk === 'boolean' || Number.isInteger(httpStatus))) {
            snapshot = { ...snapshot, state: failed || responseOk === false ? 'failed'
                : responseOk === true ? 'responded' : snapshot.state, responseAt: new Date(timestamp).toISOString(),
                metadata: { ...snapshot.metadata,
                    ...(typeof responseOk === 'boolean' ? { responseOk } : {}),
                    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
                    ...(value.dispatchAt !== undefined ? { durationMs: Math.max(0, timestamp - value.dispatchAt) } : {}) } };
        }
        value.snapshot = snapshot; value.rawRequest = null; value.trace = null;
        if (settle) pending.delete(value.ticket);
        record = snapshot; recordOrdinal = value.requestOrdinal; recordReservation = value; latestTicket = value.ticket;
        const newerPending = [...pending.values()].some(candidate => !candidate.cancelled && candidate.requestOrdinal > recordOrdinal);
        restoredRecord = false; restorePending = false; status = !settle || newerPending ? 'pending' : 'ready';
        error = null; persistence = { status: 'saving' }; emit();
        // Record replacement is synchronous: a response can arrive before storage settles.
        const saving = saveRecord(snapshot, current);
        return saving.then(() => snapshot);
    }
    async function readRecord(query, { attempts = readAttempts, settlePending = false } = {}) {
        const ticket = typeof query === 'string' ? query : null;
        const state = arguments[1]?.reservation ?? (ticket ? pending.get(ticket) : null), currentEpoch = state?.epoch ?? epoch, currentScope = state?.scope ?? validScope()?.key;
        const startingRecord = record;
        const superseded = () => Boolean(record && (state?.requestOrdinal
            ? recordOrdinal > state.requestOrdinal : record !== startingRecord && (!ticket || record.id !== ticket)));
        const stillActive = () => !destroyed && enabled && !state?.cancelled && epoch === currentEpoch && validScope()?.key === currentScope;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (!stillActive()) return null;
            try {
                const result = await serverClient?.readPromptInspector?.(query);
                if (!stillActive()) return null;
                const value = result?.snapshot;
                if (value && typeof value === 'object') {
                    const current = validScope();
                    if ((ticket ? value.id !== ticket : typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.id)) || value.chatId !== current?.chatId || value.source !== current?.source || value.model !== current?.model
                        || !Number.isSafeInteger(value.sequence) || value.sequence < 0
                        || (value.rawRequest != null && typeof value.rawRequest !== 'string')) { fail('RECORD_UNAVAILABLE'); return null; }
                    if (!value.sequence || (value.rawRequest == null && ['pending', 'dispatched'].includes(value.state))) {
                        if (value.state === 'failed') {
                            pending.delete(ticket); disposeTicket(ticket);
                            if (superseded()) return record;
                            if (latestTicket === ticket) latestTicket = record?.id ?? null;
                            fail('CAPTURE_UNAVAILABLE'); return null;
                        }
                        if (settlePending && attempt === attempts - 1) {
                            pending.delete(ticket); disposeTicket(ticket);
                            if (superseded()) return record;
                            if (latestTicket === ticket) latestTicket = record?.id ?? null;
                            fail('CAPTURE_UNAVAILABLE'); return null;
                        }
                        if (attempt < attempts - 1) await delay(200);
                        continue; // A ticket/prepared draft is not an actual captured outbound request.
                    }
                    if (value.state === 'oversize' || typeof value.rawRequest !== 'string') {
                        pending.delete(ticket); disposeTicket(ticket);
                        if (superseded()) return record;
                        if (latestTicket === ticket) latestTicket = record?.id ?? null;
                        fail(value.state === 'oversize' ? 'RECORD_TOO_LARGE' : 'CAPTURE_UNAVAILABLE'); return record;
                    }
                    const owned = pending.get(value.id) ?? (record?.id === value.id ? recordReservation : null) ?? (state?.ticket === value.id ? state : null);
                    if (!owned || owned.cancelled || owned.epoch !== epoch || owned.scope !== current.key) return null;
                    // Client request order and backend capture sequence are separate counters.
                    if (!record || restoredRecord || owned.requestOrdinal > recordOrdinal
                        || (owned.requestOrdinal === recordOrdinal && value.id === record.id && value.sequence >= record.sequence)) {
                        record = { ...clone(value), complete: value.complete === true && typeof value.rawRequest === 'string' && !['pending', 'oversize'].includes(value.state) };
                        recordReservation = owned; recordOrdinal = owned.requestOrdinal; latestTicket = value.id; restoredRecord = false;
                        restorePending = false; status = 'ready'; error = null; persistence = { status: 'saving' }; emit();
                        await saveRecord(record, current);
                    }
                    pending.delete(value.id); return value;
                }
                const condition = result?.status;
                if (condition === 'unknown' && !ticket) { status = pending.size ? 'pending' : record ? 'ready' : 'idle'; error = null; emit(); return record; }
                if (condition === 'expired' || condition === 'unknown') {
                    pending.delete(ticket);
                    if (superseded()) return record;
                    if (record && (!ticket || record.id === ticket) && typeof record.rawRequest === 'string') {
                        // The backend's short TTL is independent of our already captured exact local snapshot.
                        if (recordReservation) recordReservation.cancelled = true;
                        recordReservation = null; latestTicket = null; status = 'ready'; error = null; emit(); return record;
                    }
                    if (latestTicket === ticket) latestTicket = record?.id ?? null;
                    fail('RECORD_EXPIRED'); return record;
                }
                if (condition === 'oversize') {
                    pending.delete(ticket); if (superseded()) return record;
                    if (latestTicket === ticket) latestTicket = record?.id ?? null;
                    fail('RECORD_TOO_LARGE'); return record;
                }
            } catch { if (!stillActive()) return null; if (superseded()) return record; if (attempt === attempts - 1) fail('RECORD_UNAVAILABLE'); }
            if (attempt < attempts - 1) await delay(200);
        }
        return null;
    }
    armedScope = scope()?.key ?? null;
    void restoreSaved();
    return {
        observer,
        snapshot() {
            const current = validScope(); if (restorePending) void restoreSaved(); return { supported: !destroyed && publicCaptureAvailable && !!current, enabled,
                status, record, error, sourceAvailable: sourceAvailable(), backendAvailable,
                frontendAvailable: publicCaptureAvailable, requiresHostPatch: false,
                nativeRelayAvailable: current ? nativeRelaySources.has(current.source) : false,
                captureKind: record?.metadata?.captureKind ?? (record ? 'outbound'
                    : pending.get(latestTicket)?.captureMode === 'native' || pending.get(latestTicket)?.captureMode === 'google' ? 'outbound'
                        : pending.get(latestTicket)?.captureMode === 'frontend' || (current && !GOOGLE.has(current.source)) ? 'frontend-messages' : 'outbound'),
                recordAvailable: Boolean(record), restored: Boolean(record && (restoredRecord || !recordReservation)), persistence: { ...persistence }, privacyMode: 'tab-session' };
        },
        subscribe(fn) {
            if (typeof fn !== 'function') throw new TypeError('缺少事件监听函数');
            if (destroyed) return () => {};
            listeners.add(fn); return () => listeners.delete(fn);
        },
        async setEnabled(value) {
            if (!value) { restorePending = false; await release({ disable: true, clearSaved: true }); return false; }
            const activationEpoch = epoch, activationScope = scope()?.key;
            if (destroyed || activationEpoch !== epoch) return false;
            const current = scope();
            if (!publicCaptureAvailable) { fail('PUBLIC_EVENTS_UNAVAILABLE'); return false; }
            if (!current || !activationScope || current.key !== activationScope) { fail('UNSUPPORTED_SCOPE'); return false; }
            enabled = true; armedScope = current.key; status = 'idle'; error = null; resetTrace(); emit(); return true;
        },
        async refresh() {
            await restoreSaved();
            const refreshEpoch = epoch, refreshScope = scope()?.key, startedEnabled = enabled;
            const selected = pending.get(latestTicket) ?? recordReservation;
            const frontend = selected ? selected.captureMode === 'frontend' : record?.metadata?.captureKind === 'frontend-messages';
            if ((GOOGLE.has(scope()?.source) && !frontend)
                || (NATIVE.has(scope()?.source) && typeof serverClient?.prepareNativeRequest === 'function')) await refreshCapabilities();
            if (destroyed || epoch !== refreshEpoch || scope()?.key !== refreshScope || enabled !== startedEnabled) return null;
            if (!enabled || (!pending.size && !recordReservation)) { emit(); return record; }
            const current = validScope();
            const latest = pending.get(latestTicket) ?? recordReservation;
            const frontendNow = latest ? latest.captureMode === 'frontend' : record?.metadata?.captureKind === 'frontend-messages';
            const native = latest?.captureMode === 'native';
            if (frontendNow || (current && !GOOGLE.has(current.source) && !native)) { emit(); return record; }
            if (current) return readRecord({ chatId: current.chatId, source: current.source, model: current.model });
            emit(); return record;
        },
        clear() { validScope(); restorePending = false; return release({ clearSaved: true }); },
        reserveRequest,
        ownsFrontendCandidate,
        updateFrontendRequest,
        markDispatched(value) { return value?.captureMode === 'frontend' ? commitFrontendRecord(value, { dispatch: true }) : null; },
        async finishRequest(value, { responseOk, httpStatus, failed = false } = {}) {
            if (!value?.ticket || value.cancelled || destroyed || !enabled || value.epoch !== epoch || value.scope !== validScope()?.key) return null;
            if (value.captureMode === 'frontend') {
                return commitFrontendRecord(value, { settle: true, responseOk, httpStatus, failed });
            }
            try { return await readRecord(value.ticket, { reservation: value, settlePending: value.captureMode === 'native' }); }
            finally { releaseNativeProxy(value); }
        },
        cancelRequest(value) { if (value?.ticket) {
            cancelReservation(value); const owned = pending.get(value.ticket); cancelReservation(owned);
            if (recordReservation?.ticket === value.ticket) {
                recordReservation.cancelled = true; recordReservation = null;
            }
            disposeTicket(value.ticket); pending.delete(value.ticket); if (latestTicket === value.ticket) latestTicket = record?.id ?? null;
        } if (enabled) { status = pending.size ? 'pending' : generation?.active ? 'recording' : record ? 'ready' : 'idle'; emit(); } },
        destroy() {
            if (destroyed) return;
            restorePending = false; release({ disable: true, notify: false, clearSaved: false }); destroyed = true;
            sessionStore.destroy();
            for (const [event, fn] of subscriptions) {
                try { context?.eventSource?.removeListener?.(event, fn); } catch { /* Release every remaining listener. */ }
            }
            subscriptions.length = 0;
            listeners.clear();
        },
    };
}
