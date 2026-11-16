/* Copyright (c) 2026 Mana Nekoha; MPL-2.0 */
import { normalizePrice } from './cost-model.js';
import { MAX_USAGE_RECORDS_PER_CHAT } from './constants.js';
import { requestPreviewView } from './cache-diagnostics.js';
import { createTauriCachePreview } from './tauri-cache-preview.js';
const NS = 'vertex-paygo';
const MAX_CAPTURE = 1024 * 1024;
const COUNTS = ['promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount'];
const DETAILS = ['promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails'];

function method(store, name) {
    if (typeof store?.[name] !== 'function') throw new TypeError(`TauriTavern 存储接口缺少 ${name}。`);
    return store[name].bind(store);
}
function table(chatId) {
    if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) throw new TypeError('需要有效的对话用量 ID。');
    return `chat-${chatId}`;
}
function metadata(value, idFactory) {
    const out = {};
    for (const key of ['id', 'chatId', 'source', 'model', 'tier', 'region', 'paygoOnly', 'stream', 'startedAt', 'cacheWarm']) if (value?.[key] !== undefined) out[key] = value[key];
    const price = normalizePrice(value?.price);
    if (price) out.price = price;
    out.id ||= idFactory?.();
    if (typeof out.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(out.id)) throw new TypeError('用量记录需要有效的 ID。');
    table(out.chatId);
    return out;
}
function code(error, fallback = 'REQUEST_FAILED') {
    if (error?.name === 'AbortError') return 'CLIENT_ABORTED';
    return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : fallback;
}
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function details(value) {
    if (!Array.isArray(value)) return undefined;
    return value.flatMap(item => {
        const modality = typeof item?.modality === 'string' ? item.modality : undefined;
        const tokenCount = integer(item?.tokenCount ?? item?.token_count);
        return modality !== undefined && tokenCount !== undefined ? [{ modality, tokenCount }] : [];
    });
}
function exactUsage(value) {
    const source = value?.usageMetadata;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const out = {};
    for (const key of COUNTS) { const count = integer(source[key]); if (count !== undefined) out[key] = count; }
    if (typeof source.trafficType === 'string') out.trafficType = source.trafficType;
    for (const key of DETAILS) { const clean = details(source[key]); if (clean !== undefined) out[key] = clean; }
    if (!Object.keys(out).length) return null;
    out.cacheCountStatus = source.cachedContentTokenCount == null ? 'omitted'
        : integer(source.cachedContentTokenCount) !== undefined ? 'reported' : 'invalid';
    return out;
}
function normalizedUsage(value) {
    const source = value?.usage;
    if (!source || typeof source !== 'object') return null;
    const pick = (...keys) => keys.map(key => integer(source[key])).find(item => item !== undefined);
    const promptDetails = source.prompt_tokens_details ?? source.input_tokens_details;
    const nestedCounts = Array.isArray(promptDetails)
        ? promptDetails.map(item => integer(item?.cached_tokens)).filter(item => item !== undefined) : [];
    const nestedCached = integer(promptDetails?.cached_tokens)
        ?? (nestedCounts.length ? integer(nestedCounts.reduce((sum, item) => sum + item, 0)) : undefined);
    const reasoning = integer(source.completion_tokens_details?.reasoning_tokens)
        ?? integer(source.output_tokens_details?.reasoning_tokens);
    const out = {
        promptTokenCount: pick('promptTokenCount', 'inputTokens', 'input_tokens', 'prompt_tokens', 'total_input_tokens'),
        cachedContentTokenCount: pick('cachedContentTokenCount', 'cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens', 'total_cached_tokens') ?? nestedCached,
        candidatesTokenCount: pick('candidatesTokenCount', 'outputTokens', 'output_tokens', 'completion_tokens', 'total_output_tokens'),
        thoughtsTokenCount: pick('thoughtsTokenCount', 'thoughtTokens', 'thought_tokens', 'reasoning_tokens', 'total_thought_tokens') ?? reasoning,
    };
    // OpenAI completion/output tokens already include reasoning tokens; the
    // ledger's candidates and thoughts are priced separately.
    if (reasoning !== undefined && pick('candidatesTokenCount', 'outputTokens', 'total_output_tokens') === undefined
        && out.candidatesTokenCount !== undefined) {
        if (reasoning <= out.candidatesTokenCount) out.candidatesTokenCount -= reasoning;
        else delete out.candidatesTokenCount;
    }
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
    if (out.promptTokenCount === undefined && out.candidatesTokenCount === undefined) return null;
    out.cacheCountStatus = out.cachedContentTokenCount !== undefined ? 'reported' : 'omitted';
    const suppliedCaches = ['cachedContentTokenCount', 'cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens', 'total_cached_tokens']
        .map(key => source[key]).concat(Array.isArray(promptDetails)
            ? promptDetails.map(item => item?.cached_tokens) : [promptDetails?.cached_tokens]);
    if (suppliedCaches.some(item => item != null && integer(item) === undefined)) out.cacheCountStatus = 'invalid';
    if (nestedCounts.length && nestedCounts.length !== promptDetails.length
        && out.cacheCountStatus !== 'invalid'
        && pick('cachedContentTokenCount', 'cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens', 'total_cached_tokens') === undefined) {
        out.cacheCountStatus = 'mixed';
    }
    if (nestedCounts.length && nestedCached === undefined) out.cacheCountStatus = 'invalid';
    return out;
}
function usageEnvelope(value) {
    return typeof value?.event_type === 'string' && value.event_type.startsWith('interaction.')
        && value.interaction && typeof value.interaction === 'object' ? value.interaction : value;
}
function merge(current, next) {
    if (!next) return current;
    const out = { ...(current ?? {}) };
    for (const [key, item] of Object.entries(next)) {
        if (key === 'cacheCountStatus') {
            out[key] = out[key] === 'invalid' || item === 'invalid' ? 'invalid'
                : out[key] === 'mixed' || item === 'mixed' ? 'mixed'
                    : out[key] === 'reported' || item === 'reported' ? 'reported' : 'omitted';
        } else out[key] = Number.isSafeInteger(item) && Number.isSafeInteger(out[key]) ? Math.max(item, out[key]) : item;
    }
    return out;
}
function parseEvent(event, consume) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    try { consume(JSON.parse(data)); } catch { /* Response bytes remain untouched. */ }
}
function preserveMetadata(target, source) {
    for (const key of ['url', 'redirected', 'type']) try { Object.defineProperty(target, key, { configurable: true, value: source[key] }); } catch { /* host restriction */ }
    return target;
}

export function createTauriUsageClient({ store, notifyWarning = () => {}, idFactory, cryptoRef = globalThis.crypto, yaml } = {}) {
    const setJson = method(store, 'setJson');
    const deleteJson = method(store, 'deleteJson');
    const listKeys = method(store, 'listKeys');
    const getJson = typeof store?.tryGetJson === 'function' ? store.tryGetJson.bind(store) : method(store, 'getJson');
    let writes = Promise.resolve();
    let writeError = null;
    let destroyed = false;
    const activeCleanups = new Set();
    const captureRequest = createTauriCachePreview({ cryptoRef, yaml });
    function warn(error) {
        try { notifyWarning('This request could not be added to the usage ledger. Conversation costs will be incomplete.', error); }
        catch (notificationError) { console.warn('[提示词缓存优化] Usage warning failed.', notificationError); }
        console.warn('[提示词缓存优化] Usage ledger write failed.', error);
    }
    function queue(operation) {
        if (destroyed) return Promise.reject(new Error('用量读取接口已释放。'));
        const task = writes.then(operation);
        writes = task.catch(error => { writeError = error; warn(error); });
        return task;
    }
    async function readAndTrim(chatId) {
        const tableName = table(chatId);
        const keys = await listKeys({ namespace: NS, table: tableName });
        if (!Array.isArray(keys)) throw new TypeError('TauriTavern 用量记录索引无效。');
        const records = [];
        let truncated = false, cursor = 0;
        async function worker() {
            while (cursor < keys.length) {
                const key = keys[cursor++];
                if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(key)) { truncated = true; continue; }
                const result = await getJson({ namespace: NS, table: tableName, key });
                const value = result && typeof result === 'object' && typeof result.found === 'boolean'
                    ? (result.found ? result.value : null) : result;
                if (value && typeof value === 'object' && value.id === key && value.chatId === chatId) records.push(value);
                else truncated = true;
            }
        }
        await Promise.all(Array.from({ length: Math.min(8, keys.length) }, worker));
        records.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id));
        const expired = records.slice(0, Math.max(0, records.length - MAX_USAGE_RECORDS_PER_CHAT));
        // Each deletion targets a validated request ID in this chat's own table.
        // Native global logs, prompt artifacts and settings are separate stores.
        for (const record of expired) await deleteJson({ namespace: NS, table: tableName, key: record.id });
        return { ok: true, records: records.slice(-MAX_USAGE_RECORDS_PER_CHAT), truncated };
    }
    function persist(record, previewPromise) {
        return queue(async () => {
            let saved = record;
            if (previewPromise !== undefined) {
                let preview;
                try { preview = requestPreviewView(await previewPromise); }
                catch { preview = { status: 'unavailable', reason: 'FINGERPRINT_UNAVAILABLE', bodyBytes: null }; }
                saved = { ...record, googleRequests: [{ version: 1, ...preview }] };
            }
            await setJson({ namespace: NS, table: table(record.chatId), key: record.id, value: saved });
            await readAndTrim(record.chatId);
        });
    }
    // Upgrade old per-chat tables even before the user opens the costs window.
    if (typeof store.listTables === 'function') void queue(async () => {
        const tables = await store.listTables({ namespace: NS });
        if (!Array.isArray(tables)) throw new TypeError('TauriTavern 用量记录表索引无效。');
        for (const name of tables) if (typeof name === 'string' && /^chat-[A-Za-z0-9_-]{1,128}$/u.test(name)) {
            await readAndTrim(name.slice(5));
        }
    }).catch(() => {});
    const base = value => { const clean = metadata(value, idFactory); return { ...clean, createdAt: new Date(clean.startedAt ?? Date.now()).toISOString() }; };
    function recordFailure(meta, error) {
        const record = { ...base(meta), status: 'failed', errorCode: code(error), usage: null };
        void persist(record, meta?.requestPreview).catch(() => {}); return record;
    }
    function observeResponse(response, meta, { signal } = {}) {
        if (!(response instanceof Response)) throw new TypeError('需要有效的 Response 响应对象。');
        const recordBase = base(meta);
        if (!response.ok) { void persist({ ...recordBase, status: 'failed', errorCode: `UPSTREAM_HTTP_${response.status}`, usage: null }, meta?.requestPreview).catch(() => {}); return response; }
        if (!response.body) { void persist({ ...recordBase, status: 'incomplete', errorCode: 'USAGE_METADATA_MISSING', usage: null }, meta?.requestPreview).catch(() => {}); return response; }
        const streaming = meta?.stream === true || /text\/event-stream/i.test(response.headers.get('content-type') ?? '');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', captured = 0, limited = false, discardEvent = false, discardTail = '';
        let usage = null, responseError = false, finished = false, aborted = false, normalizedSeen = false;
        const consume = value => {
            const envelope = usageEnvelope(value);
            const exact = exactUsage(envelope);
            const normalized = exact ? null : normalizedUsage(envelope);
            usage = merge(usage, exact ?? normalized);
            normalizedSeen ||= Boolean(normalized);
            responseError ||= Boolean(value?.error);
        };
        const cleanup = () => { signal?.removeEventListener('abort', abort); activeCleanups.delete(cleanup); };
        activeCleanups.add(cleanup);
        const finalize = (status, errorCode = null) => {
            if (finished) return;
            finished = true;
            let finalUsage = usage, accuracy = normalizedSeen ? 'tauri-normalized' : undefined;
            if (!streaming && !limited && status === 'complete') {
                try {
                    const value = usageEnvelope(JSON.parse(buffer));
                    responseError ||= Boolean(value?.error);
                    finalUsage = value?.usageMetadata ? exactUsage(value) : normalizedUsage(value);
                    if (finalUsage && !value?.usageMetadata) accuracy = 'tauri-normalized';
                } catch { finalUsage = null; }
            }
            if (responseError) { status = 'failed'; errorCode = 'UPSTREAM_RESPONSE_ERROR'; }
            if (limited) { status = 'incomplete'; errorCode = 'USAGE_CAPTURE_LIMIT'; }
            const hasUsage = finalUsage && Object.keys(finalUsage).length;
            void persist({ ...recordBase, status: hasUsage ? status : status === 'failed' ? 'failed' : 'incomplete',
                errorCode: hasUsage ? errorCode : errorCode ?? 'USAGE_METADATA_MISSING', usage: hasUsage ? finalUsage : null,
                ...(accuracy ? { usageAccuracy: accuracy } : {}) }, meta?.requestPreview).catch(() => {});
        };
        const abort = () => { aborted = true; void reader.cancel(signal?.reason).catch(() => {}); finalize('incomplete', 'CLIENT_ABORTED'); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const body = new ReadableStream({
            async pull(controller) {
                try {
                    if (aborted) throw signal?.reason ?? new DOMException('操作已取消。', 'AbortError');
                    const result = await reader.read();
                    if (aborted) throw signal?.reason ?? new DOMException('操作已取消。', 'AbortError');
                    if (result.done) {
                        if (!limited || (streaming && !discardEvent)) buffer += decoder.decode();
                        if (streaming && buffer.trim() && !discardEvent) parseEvent(buffer, consume);
                        finalize('complete'); cleanup(); controller.close(); return;
                    }
                    const decoded = decoder.decode(result.value, { stream: true });
                    if (streaming) {
                        let piece = decoded;
                        if (discardEvent) {
                            piece = discardTail + piece;
                            const boundary = piece.search(/\r?\n\r?\n/);
                            if (boundary < 0) { discardTail = piece.slice(-3); piece = ''; }
                            else { piece = piece.slice(boundary).replace(/^\r?\n\r?\n/, ''); discardEvent = false; discardTail = ''; }
                        }
                        buffer += piece;
                        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() ?? '';
                        for (const event of events) {
                            if (event.length > MAX_CAPTURE) { limited = true; continue; }
                            parseEvent(event, consume);
                        }
                        if (buffer.length > MAX_CAPTURE) { limited = true; discardEvent = true; discardTail = buffer.slice(-3); buffer = ''; }
                    } else {
                        captured += result.value.byteLength;
                        if (!limited && captured <= MAX_CAPTURE) buffer += decoded;
                        else { limited = true; buffer = ''; }
                    }
                    controller.enqueue(result.value);
                } catch (error) { finalize('incomplete', code(error, 'UPSTREAM_RESPONSE_STREAM_FAILED')); cleanup(); controller.error(error); }
            },
            async cancel(reason) { try { await reader.cancel(reason); } finally { finalize('incomplete', signal?.aborted ? 'CLIENT_ABORTED' : 'CLIENT_DISCONNECTED'); cleanup(); } },
        });
        return preserveMetadata(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), response);
    }
    async function flush() {
        let pending;
        do { pending = writes; await pending; } while (pending !== writes);
        if (writeError) { const error = writeError; writeError = null; throw error; }
    }
    async function readUsage(chatId, { latest, ids, includeRequestPreviews = false } = {}) {
        table(chatId);
        if (latest !== undefined && (!Number.isSafeInteger(latest) || latest < 1 || latest > 50 || ids !== undefined)) {
            throw new TypeError('读取最近请求时需要有效的数量限制。');
        }
        if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)))) {
            throw new TypeError('需要有效的用量记录 ID 列表。');
        }
        await flush();
        const result = await queue(() => readAndTrim(chatId));
        const wanted = ids === undefined ? null : new Set(ids);
        let records = wanted ? result.records.filter(record => wanted.has(record.id)) : result.records;
        if (latest !== undefined) records = records.slice(-latest);
        if (!includeRequestPreviews) records = records.map(record => {
            const { googleRequests, googleRequestCount, ...costRecord } = record; return costRecord;
        });
        return { ...result, records };
    }
    function destroy() { destroyed = true; for (const cleanup of activeCleanups) cleanup(); activeCleanups.clear(); }
    return { observeResponse, recordFailure, captureRequest, readUsage, flush, destroy };
}
