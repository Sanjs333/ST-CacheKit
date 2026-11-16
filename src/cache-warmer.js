/* Bounded, opt-in background cache warming; SPDX-License-Identifier: MPL-2.0 */
import { completionIdentity } from './worldinfo-stability.js';

export const CACHE_WARM_FIELD = '__vertexPayGoCacheWarm';
export const CACHE_WARM_SETTINGS_KEY = 'vertex-paygo-cache-warm';
export const CACHE_WARM_MAX_REQUESTS = 3;
export const CACHE_WARM_INTERVAL_MS = 270_000;
const LIMIT = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const supported = data => data?.chat_completion_source === 'vertexai' && /^gemini-4-(?:carbon|hydrogen|argon)$/u.test(data.model ?? '')
    && !data.use_interactions_api && !data.interactions && !data.continue_prefill
    && !['enable_web_search', 'enable_code_execution', 'use_code_execution', 'enable_url_context'].some(key => data[key])
    && (data.tools == null || Array.isArray(data.tools) && !data.tools.length)
    && (data.functions == null || Array.isArray(data.functions) && !data.functions.length)
    && Array.isArray(data.messages) && data.messages.length > 0 && data.messages.length <= 512
    && data.messages.every(message => ['system', 'user', 'assistant'].includes(message?.role) && !message.tool_calls
        && (typeof message.content === 'string' || Array.isArray(message.content)
            && message.content.every(part => part?.type === 'text' && typeof part.text === 'string')));

function safeBodyOverrides(data, yaml) {
    const parse = raw => {
        if (raw == null || raw === '') return null;
        if (typeof raw !== 'string') return raw;
        try { return JSON.parse(raw); } catch { return yaml?.parse ? yaml.parse(raw) : undefined; }
    };
    try {
        for (const key of ['custom_include_body', 'include_body', 'customIncludeBody']) {
            const raw = data[key]; if (raw == null || raw === '') continue;
            const value = parse(raw);
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).some(field => !['service_tier', 'labels'].includes(field))) return false;
        }
        for (const key of ['custom_exclude_body', 'exclude_body', 'customExcludeBody']) {
            const raw = data[key]; if (raw == null || raw === '') continue;
            const value = parse(raw);
            if (Array.isArray(value) ? value.some(field => field !== 'service_tier')
                : !value || typeof value !== 'object' || Object.keys(value).some(field => field !== 'service_tier')) return false;
        }
        return true;
    } catch { return false; }
}

export function makeCacheWarmRequest(data, { preserveProxy = false, yaml } = {}) {
    if (!supported(data) || !safeBodyOverrides(data, yaml) || encoder.encode(JSON.stringify(data)).length > LIMIT) return null;
    const request = JSON.parse(JSON.stringify(data));
    for (const key of ['__vertexPayGoRequestState', '__vertexPayGoTauriRequestState', '__vertexPayGoPromptInspector', '__vertexPayGoNativeOrder']) delete request[key];
    if (!preserveProxy) { request.reverse_proxy = ''; request.proxy_password = ''; }
    request[CACHE_WARM_FIELD] = true;
    request.stream = false; request.max_tokens = 1; request.reasoning_effort = 'min'; request.include_reasoning = false;
    if (Object.hasOwn(request, 'max_completion_tokens')) request.max_completion_tokens = 1;
    return request;
}

/** Read a clone completely; never infer a missing cache field to be zero. */
export async function readCacheWarmResponse(response, signal) {
    if (!response?.ok || typeof response.clone !== 'function') return { ok: false };
    const copy = response.clone(), reader = copy.body?.getReader?.();
    if (!reader) return { ok: false };
    const streaming = /text\/event-stream/iu.test(copy.headers.get('Content-Type') ?? '');
    const decoder = new TextDecoder();
    let buffer = '', total = 0, usage = null, invalid = false, failed = false, finished = !streaming;
    const consume = value => {
        if (value?.error) failed = true;
        if (value?.candidates?.some(candidate => candidate.finishReason && candidate.finishReason !== 'CONTINUATION')
            || value?.choices?.some(choice => choice.finish_reason)) finished = true;
        const source = value?.usageMetadata ?? value?.usage;
        if (!source || typeof source !== 'object') return;
        if (['invalid', 'mixed'].includes(source.cacheCountStatus) || source.invalidUsageFields?.length) invalid = true;
        const prompt = source.promptTokenCount ?? source.prompt_tokens ?? source.input_tokens;
        const detail = source.prompt_tokens_details ?? source.input_tokens_details;
        const cached = source.cachedContentTokenCount ?? source.cache_read_input_tokens ?? source.cached_input_tokens ?? detail?.cached_tokens;
        if (prompt != null && integer(prompt) === undefined || cached != null && integer(cached) === undefined) invalid = true;
        usage ??= {};
        if (integer(prompt) !== undefined) usage.prompt = Math.max(usage.prompt ?? 0, prompt);
        if (integer(cached) !== undefined) usage.cached = Math.max(usage.cached ?? 0, cached);
        const output = value?.usageMetadata
            ? integer(source.candidatesTokenCount) !== undefined || integer(source.thoughtsTokenCount) !== undefined
                ? (integer(source.candidatesTokenCount) ?? 0) + (integer(source.thoughtsTokenCount) ?? 0) : undefined
            : integer(source.completion_tokens ?? source.output_tokens);
        if (integer(output) !== undefined) usage.output = Math.max(usage.output ?? 0, output);
    };
    const event = value => {
        const data = value.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') { finished = true; return; }
        if (data) { try { consume(JSON.parse(data)); } catch { failed = true; } }
    };
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > LIMIT) return { ok: false };
            buffer += decoder.decode(value, { stream: true });
            if (streaming) {
                const events = buffer.split(/\r?\n\r?\n/u); buffer = events.pop(); events.forEach(event);
            }
        }
        signal?.throwIfAborted(); buffer += decoder.decode();
        if (streaming) { if (buffer.trim()) event(buffer); }
        else { try { consume(JSON.parse(buffer)); } catch { failed = true; } }
        const valid = !invalid && usage?.prompt > 0 && integer(usage.cached) !== undefined && usage.cached <= usage.prompt;
        return { ok: !failed && finished && usage?.prompt > 0, promptTokens: usage?.prompt, outputTokens: usage?.output,
            ...(valid ? { cachedTokens: usage.cached } : {}) };
    } finally { signal?.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
}

export function createCacheWarmer({ getContext, onChange = () => {}, now = Date.now, yaml,
    setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 60_000 } = {}) {
    let serial = 0, target = null, timer = null, active = null, count = 0, status = 'waiting', nextAt = null, destroyed = false;
    const listeners = [], context = getContext?.();
    const enabled = () => getContext?.()?.extensionSettings?.[CACHE_WARM_SETTINGS_KEY]?.enabled === true;
    const notify = () => { try { onChange(); } catch {} };
    const scope = () => {
        try {
            const current = getContext?.(), identity = completionIdentity(current), settings = current?.chatCompletionSettings;
            const chatId = current?.getCurrentChatId?.();
            if (!identity || !chatId) return null;
            return JSON.stringify([chatId, identity, current.groupId ?? null, current.characterId ?? null,
                current.extensionSettings?.connectionManager?.selectedProfile ?? null,
                settings?.vertexai_region ?? '', settings?.vertexai_auth_mode ?? '', settings?.vertexai_express_project_id ?? '',
                settings?.secret_id ?? null, settings?.reverse_proxy ?? '', settings?.custom_url ?? '',
                settings?.use_sysprompt, settings?.squash_system_messages, settings?.custom_prompt_post_processing,
                settings?.preset_settings_openai, settings?.custom_include_body, settings?.custom_exclude_body,
                settings?.additional_parameters_by_source ?? null, current.name1, current.name2,
                current.extensionSettings?.['vertex-paygo-system-prompt'] ?? null,
                current.extensionSettings?.['vertex-paygo-prompt-migration'] ?? null]);
        } catch { return null; }
    };
    const stop = reason => {
        serial++; if (timer !== null) clearTimer(timer); timer = null; nextAt = null;
        target?.reading?.abort(); target = null; active?.abort(); active = null;
        status = reason; notify();
    };
    const current = entry => !destroyed && enabled() && target === entry && entry.serial === serial && entry.scope === scope();
    const schedule = entry => {
        if (!current(entry)) return;
        nextAt = entry.lastSentAt + CACHE_WARM_INTERVAL_MS;
        if (now() > nextAt + CACHE_WARM_INTERVAL_MS) { stop('expired'); return; }
        status = 'scheduled'; notify();
        timer = setTimer(() => { timer = null; nextAt = null; void warm(entry); }, Math.max(0, nextAt - now()));
    };
    async function warm(entry) {
        if (!current(entry)) { stop(enabled() ? 'cancelled' : 'disabled'); return; }
        if (count >= CACHE_WARM_MAX_REQUESTS) { stop('complete'); return; }
        if (now() > entry.lastSentAt + 2 * CACHE_WARM_INTERVAL_MS) { stop('expired'); return; }
        const controller = new AbortController(); active = controller;
        const timeout = setTimer(() => controller.abort(), timeoutMs);
        count++; entry.lastSentAt = now(); status = 'warming'; notify();
        try {
            const response = await entry.send(JSON.parse(JSON.stringify(entry.request)), controller.signal);
            const result = await readCacheWarmResponse(response, controller.signal);
            if (!current(entry)) return;
            if (!result.ok || result.outputTokens > 1) stop('error');
            else if (result.cachedTokens === undefined) stop('unknown');
            else if (result.cachedTokens === 0) stop('miss');
            else if (count >= CACHE_WARM_MAX_REQUESTS) stop('complete');
            else schedule(entry);
        } catch { if (current(entry)) stop('error'); }
        finally { clearTimer(timeout); if (active === controller) active = null; }
    }
    for (const name of ['CHAT_CHANGED', 'SETTINGS_LOADED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED',
        'CONNECTION_PROFILE_LOADED', 'GENERATION_STOPPED']) {
        const event = context?.eventTypes?.[name];
        if (event && context?.eventSource?.on) { const fn = () => stop('cancelled'); context.eventSource.on(event, fn); listeners.push([event, fn]); }
    }
    const generationEvent = context?.eventTypes?.GENERATION_STARTED;
    if (generationEvent && context?.eventSource?.on) {
        const fn = (_type, _options, dryRun) => { if (dryRun !== true) stop('cancelled'); };
        context.eventSource.on(generationEvent, fn); listeners.push([generationEvent, fn]);
    }
    return {
        snapshot: () => ({ enabled: enabled(), status: enabled() ? status : 'disabled', count, max: CACHE_WARM_MAX_REQUESTS,
            active: !!target, nextAt }),
        setEnabled(value) {
            const root = getContext?.()?.extensionSettings; if (!root) return;
            root[CACHE_WARM_SETTINGS_KEY] = { version: 1, enabled: value === true };
            getContext?.()?.saveSettingsDebounced?.(); count = 0; stop(value ? 'waiting' : 'disabled');
        },
        stop: () => stop('cancelled'),
        captureRequest(data, send, { background = false, supported: channelSupported = true, preserveProxy = false } = {}) {
            if (destroyed || background || data?.[CACHE_WARM_FIELD] === true) return null;
            count = 0; stop('waiting');
            if (!enabled()) return null;
            const request = channelSupported ? makeCacheWarmRequest(data, { preserveProxy, yaml }) : null, key = scope();
            if (!request || !key || typeof send !== 'function') { status = 'unsupported'; notify(); return null; }
            const identity = completionIdentity(getContext?.());
            if (identity?.source !== data.chat_completion_source || identity?.model !== data.model) return null;
            const entry = { request, send, scope: key, serial, lastSentAt: now(), reading: new AbortController() };
            target = entry; return entry;
        },
        async observeResponse(entry, response) {
            if (!entry || !current(entry)) return;
            try {
                const result = await readCacheWarmResponse(response, entry.reading.signal);
                if (!current(entry)) return;
                if (result.ok) schedule(entry); else stop('error');
            } catch { if (current(entry)) stop('error'); }
        },
        cancelRequest(entry) { if (entry && current(entry)) stop('error'); },
        destroy() { if (destroyed) return; stop('disabled'); destroyed = true;
            for (const [event, fn] of listeners) context?.eventSource?.removeListener?.(event, fn); },
    };
}
