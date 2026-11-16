/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/
 */

import {
    AI_STUDIO_SOURCE,
    DEFAULT_STATE,
    EXTENSION_ID,
    VERTEX_SOURCE,
    isGoogleSource,
} from './constants.js';
import { requiresPlugin, validatePluginState, normalizeState } from './state-machine.js';
import { sanitizeChat } from './prompt-migration.js';
import { installTauriAgentTransport } from './tauri-agent-transport.js';
import { applySystemPromptPreference } from './system-prompt-settings.js';
import { applyTauriAgentSystemPromptPreference } from './tauri-system-prompt.js';
import { pricingRegion } from './cost-model.js';
import { CACHE_WARM_FIELD } from './cache-warmer.js';
import {
    applyTauriParameters,
    hasExplicitTauriState,
    hasTauriParameterSnapshot,
    readTauriState,
} from './tauri-parameters.js';

const GENERATE_PATH = '/api/backends/chat-completions/generate';
const REQUEST_STATE = '__vertexPayGoTauriRequestState';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceOf(data) {
    return String(data?.chat_completion_source ?? data?.source ?? data?.provider ?? '').trim().toLowerCase();
}

function modelOf(data) {
    return data?.model ?? data?.model_name ?? data?.modelName;
}

function sourceIsGoogle(data) {
    return isGoogleSource(sourceOf(data));
}

function safeCall(fn, ...args) {
    if (typeof fn !== 'function') return undefined;
    try {
        return fn(...args);
    } catch {
        return undefined;
    }
}

function makeRequestId(target = globalThis) {
    try {
        if (typeof target.crypto?.randomUUID === 'function') return target.crypto.randomUUID();
        if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    } catch {

    }
    return `tauri-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function signalAbort(signal) {
    if (!signal) return;
    if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
    } else if (signal.aborted) {
        const error = new Error('操作已取消。');
        error.name = 'AbortError';
        throw error;
    }
}

function requestUrl(input, init, origin) {
    const raw = typeof input === 'string' || input instanceof URL ? input : input?.url;
    if (!raw) return null;
    try {
        return new URL(raw, origin || 'http://tauri-paygo.invalid');
    } catch {
        return null;
    }
}

function isGenerationRequest(input, init, origin) {
    const url = requestUrl(input, init, origin);
    if (!url || url.pathname !== GENERATE_PATH) return false;
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') return false;
    if (!origin) {
        // Relative URLs are local requests.  Absolute URLs are only accepted
        // when their origin is explicitly the host origin below.
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        return !/^[a-z][a-z\d+.-]*:/i.test(raw);
    }
    try {
        return url.origin === new URL(origin).origin;
    } catch {
        return false;
    }
}

async function readRequestBody(input, init) {
    if (init && Object.hasOwn(init, 'body')) {
        if (typeof init.body === 'string') return init.body;
        if (init.body === null || init.body === undefined) return undefined;
        // URLSearchParams/FormData/Blob bodies cannot represent the host JSON
        // generate payload.  Reject rather than sending an unadapted request.
        throw new TypeError('[提示词缓存优化] Tauri generation requests require a JSON body.');
    }
    if (typeof input?.clone === 'function') return input.clone().text();
    return undefined;
}

function extensionState(data) {
    const direct = data?.extensions?.[EXTENSION_ID] ?? data?.[EXTENSION_ID];
    return isRecord(direct) ? direct : null;
}

function nativeState(data, yaml) {
    // Presence of any native custom/include field is authoritative, including
    // an all-empty snapshot emitted for Standard.  Checking only managed
    // values would let a legacy extension state resurrect after the user
    // selected Standard in native settings.
    if (!hasTauriParameterSnapshot(data, { yaml })) return null;
    return readTauriState(data, { yaml });
}

function presetCandidate(context, name) {
    if (!name) return null;
    if (typeof context?.getPresetManager !== 'function') {
        const error = new Error(`[提示词缓存优化] Cannot resolve request preset: ${name}`);
        error.code = 'TAURI_PRESET_UNAVAILABLE';
        throw error;
    }
    try {
        const manager = context.getPresetManager('openai');
        const preset = manager?.getCompletionPresetByName?.(name);
        if (!preset) {
            const error = new Error(`[提示词缓存优化] Cannot resolve request preset: ${name}`);
            error.code = 'TAURI_PRESET_NOT_FOUND';
            throw error;
        }
        return preset;
    } catch (error) {
        if (error?.code === 'TAURI_PRESET_NOT_FOUND' || error?.code === 'TAURI_PRESET_UNAVAILABLE') throw error;
        const wrapped = new Error(`[提示词缓存优化] Cannot resolve request preset: ${name}`, { cause: error });
        wrapped.code = 'TAURI_PRESET_RESOLUTION_FAILED';
        throw wrapped;
    }
}

function presetState(context, name, yaml) {
    const preset = presetCandidate(context, name);
    if (!preset) return null;
    const fromNative = nativeState(presetParameterData(preset), yaml);
    if (fromNative) return fromNative;
    const fromLegacy = extensionState(preset);
    return fromLegacy ? normalizeState(fromLegacy) : null;
}

function ownFirst(object, names) {
    if (!isRecord(object)) return undefined;
    for (const name of names) {
        if (Object.hasOwn(object, name)) return object[name];
    }
    return undefined;
}

/**
 * TauriTavern stores preset Additional Parameters by source.  Keep the
 * preset object itself intact for the host, but expose the selected source's
 * persistent entry in the request-shaped fields consumed by the parameter
 * adapter.  Empty strings are meaningful: they are the saved Standard
 * snapshot and must not fall through to the old extension state.
 */
function presetParameterData(preset) {
    if (!isRecord(preset)) return preset;
    const stores = preset.additional_parameters_by_source;
    if (!isRecord(stores)) return preset;
    const requested = String(preset.chat_completion_source ?? preset.source ?? preset.api ?? '').trim();
    const sourceKey = Object.keys(stores).find(key => key.toLowerCase() === requested.toLowerCase());
    if (sourceKey === undefined || !isRecord(stores[sourceKey])) return preset;
    const entry = stores[sourceKey];
    const output = { ...preset };
    const mappings = [
        [['include_body', 'custom_include_body', 'customIncludeBody'], 'custom_include_body'],
        [['exclude_body', 'custom_exclude_body', 'customExcludeBody'], 'custom_exclude_body'],
        [['include_headers', 'custom_include_headers', 'customIncludeHeaders'], 'custom_include_headers'],
    ];
    for (const [names, target] of mappings) {
        const value = ownFirst(entry, names);
        if (value !== undefined || names.some(name => Object.hasOwn(entry, name))) output[target] = value;
    }
    if (!output.chat_completion_source && requested) output.chat_completion_source = requested.toLowerCase();
    return output;
}

function profileSource(profile, fallback) {
    return String(profile?.api ?? profile?.chat_completion_source ?? profile?.source ?? fallback ?? '')
        .trim().toLowerCase();
}

function profilePayload(profile) {
    if (!isRecord(profile)) return null;
    const hints = isRecord(profile.adapterHints) ? profile.adapterHints : {};
    const output = {
        ...profile,
        chat_completion_source: profileSource(profile),
    };
    const mappings = [
        ['custom_include_headers', 'customIncludeHeaders'],
        ['custom_include_body', 'customIncludeBody'],
        ['custom_exclude_body', 'customExcludeBody'],
    ];
    for (const [field, hint] of mappings) {
        if (Object.hasOwn(profile, field) && profile[field] !== undefined) output[field] = profile[field];
        else if (Object.hasOwn(hints, hint)) output[field] = hints[hint];
        else delete output[field];
    }
    return output;
}

function stateFromData({ data, context, yaml, presetName, fallback = true, stateProvider }) {
    if (isRecord(data?.[REQUEST_STATE]?.state)) return normalizeState(data[REQUEST_STATE].state);
    // Resolve a named preset even when the request already contains native
    // parameters.  A missing preset must never silently fall back to the
    // foreground state or accidentally send another preset's request.
    const fromPreset = presetName ? presetState(context, presetName, yaml) : null;
    const fromNative = hasTauriParameterSnapshot(data, { yaml }) ? nativeState(data, yaml) : null;
    if (fromNative) return fromNative;

    const fromLegacy = extensionState(data);
    if (fromLegacy) return normalizeState(fromLegacy);

    if (fromPreset) return fromPreset;

    if (fallback) {
        const supplied = safeCall(stateProvider, data);
        if (supplied) return normalizeState(supplied);
    }
    return { ...DEFAULT_STATE };
}

function metadataFor({ data, state, target, captureUsageContext, getUsagePrice, startedAt,
    existing, chatId: suppliedChatId, price: suppliedPrice }) {
    const source = sourceOf(data);
    const model = modelOf(data);
    const shouldObserve = isGoogleSource(source) && requiresPlugin(state, source, model);
    if (!shouldObserve) return null;
    const prior = isRecord(existing) ? existing : null;
    // A request's conversation and price are snapshots.  In particular,
    // preserve an explicit null chat ID: filling it from the current chat at
    // the final fetch boundary would misattribute delayed background work.
    const chatId = suppliedChatId !== undefined
        ? suppliedChatId
        : Object.hasOwn(prior ?? {}, 'chatId')
            ? prior.chatId
            : safeCall(captureUsageContext, data, state);
    const price = suppliedPrice !== undefined
        ? suppliedPrice
        : Object.hasOwn(prior ?? {}, 'price')
            ? prior.price
            : safeCall(getUsagePrice, data, state);
    return {
        ...(prior ?? {}),
        id: makeRequestId(target),
        ...(prior?.id ? { id: prior.id } : {}),
        chatId: chatId ?? null,
        source,
        model,
        tier: state.tier,
        region: source === 'vertexai' && typeof data.vertexai_region === 'string' ? data.vertexai_region : '',
        paygoOnly: false,
        stream: Boolean(data?.stream),
        price: price ?? null,
        startedAt: prior?.startedAt ?? startedAt ?? Date.now(),
        state: normalizeState(state),
    };
}

function markPayload(data, state, options) {
    const marked = { ...data };
    const existing = isRecord(data?.[REQUEST_STATE]) ? data[REQUEST_STATE] : null;
    const metadata = metadataFor({
        ...options,
        data: options.metadataData ?? marked,
        state,
        existing,
        ...(existing && Object.hasOwn(existing, 'chatId') ? { chatId: existing.chatId } : {}),
        ...(existing && Object.hasOwn(existing, 'price') ? { price: existing.price } : {}),
        startedAt: existing?.startedAt ?? options.startedAt,
    });
    marked[REQUEST_STATE] = {
        ...(existing ?? {}),
        state: normalizeState(state),
        ...(metadata ?? {}),
    };
    return marked;
}

function replacePayload(target, prepared) {
    try {
        Object.assign(target, prepared);
        return target;
    } catch {
        return prepared;
    }
}

function validationError(validation) {
    const error = new Error(validation.message || `Tauri request rejected: ${validation.code}`);
    error.name = 'TauriRequestValidationError';
    error.code = validation.code;
    error.validation = validation;
    return error;
}

function callFailure(usageClient, error, metadata) {
    try {
        // createTauriUsageClient uses (metadata, error), matching its
        // observeResponse metadata shape.  Keep the guard for injected
        // clients so accounting failures never alter request semantics.
        if (metadata?.id && metadata.chatId) usageClient?.recordFailure?.(metadata, error);
    } catch {
        // Accounting must never change the request failure semantics.
    }
}

function callObservation(usageClient, response, metadata, signal) {
    if (typeof usageClient?.observeResponse !== 'function' || !metadata?.id || !metadata.chatId) return response;
    try {
        const result = usageClient.observeResponse(response, {
            id: metadata.id,
            chatId: metadata.chatId,
            source: metadata.source,
            model: metadata.model,
            tier: metadata.tier,
            region: metadata.region,
            paygoOnly: metadata.paygoOnly,
            stream: metadata.stream,
            price: metadata.price,
            startedAt: metadata.startedAt,
            requestPreview: metadata.requestPreview,
            ...(metadata.cacheWarm === true ? { cacheWarm: true } : {}),
        }, { signal });
        if (result && typeof result.then === 'function') {
            void result.catch(error => callFailure(usageClient, error, metadata));
        }
        return result ?? response;
    } catch (error) {
        callFailure(usageClient, error, metadata);
        return response;
    }
}

function notifyBlocked(notifyError, localize, error) {
    try {
        if (typeof notifyError !== 'function') return;
        const message = typeof localize === 'function'
            ? localize('vertex_paygo.tauri.request_blocked', { message: error?.message ?? String(error) })
            : (error?.message ?? String(error));
        notifyError(message || error?.message || String(error));
    } catch {
        // Notifications are advisory and cannot be allowed to mask the error.
    }
}

/**
 * Install the Tauri native-parameter transport.  The return value is the
 * settings-ready listener expected by the host event bus; it also exposes
 * `destroy()` so the fetch and service wrappers can be removed on teardown.
 */
export function installTauriTransport({
    context = {},
    getContext = () => context,
    stateProvider = () => DEFAULT_STATE,
    target = globalThis,
    yaml,
    usageClient,
    cacheWarmer,
    messageCosts,
    getPromptInspector = () => null,
    getPromptMigration = () => null,
    getCacheBoundary = () => null,
    getBillingClient = () => null,
    captureUsageContext = () => null,
    getUsagePrice = () => null,
    notifyError = () => {},
    notifyWarning = () => {},
    localize = message => message,
    origin = target.location?.origin,
} = {}) {
    if (typeof target.fetch !== 'function') throw new TypeError('当前环境缺少 fetch 请求接口。');
    const originalFetch = target.fetch;
    const wrappedServices = [];
    let destroyed = false;
    const observeCost = (method, ...args) => {
        try { return messageCosts?.[method]?.(...args); }
        catch (error) { console.warn('[提示词缓存优化] Message cost observation failed.', error); }
    };
    async function reservePrompt(data, signal, metadata, fallbackChatId) {
        try {
            const controller = getPromptInspector();
            const token = await controller?.reserveRequest?.(data, { providerCapture: false, signal,
                background: metadata?.background === true,
                requestMetadata: metadata,
                chatId: metadata && Object.hasOwn(metadata, 'chatId') ? metadata.chatId : fallbackChatId,
                capturePhase: 'tauri-dispatch' });
            return token ? { controller, token } : null;
        } catch { return null; }
    }
    async function observePrompt(reservation, method, options) {
        try { return await reservation?.controller?.[method]?.(reservation.token, options); }
        catch { return null; }
    }
    function confirmMigration(messages, metadata, reason) {
        try {
            if (metadata?.background === true || !getPromptInspector()?.ownsCandidate?.(metadata?.promptInspectorTicket)) return;
            const migration = getPromptMigration();
            migration?.confirmFinalPrompt?.({ messages, reason, ordinal: migration.snapshot?.().ordinal });
        } catch { /* Final diagnostics do not change request handling. */ }
    }
    async function prepareAgentParameters(parameters, metadata, dispatch) {
        parameters = await applyTauriAgentSystemPromptPreference(parameters, {
            api: target.__TAURITAVERN__?.api, getContext, dispatch,
        });
        const source = sourceOf(parameters);
        if (!isGoogleSource(source) || (!metadata?.state && !hasExplicitTauriState(parameters, { yaml }))) return parameters;
        try {
            const state = hasExplicitTauriState(parameters, { yaml }) ? readTauriState(parameters, { yaml })
                : normalizeState(metadata.state);
            const validation = validatePluginState({ state, source, model: modelOf(parameters), region: parameters.vertexai_region });
            if (!validation.ok) throw validationError(validation);
            return applyTauriParameters(parameters, validation.state, { yaml });
        } catch (error) { notifyBlocked(notifyError, localize, error); throw error; }
    }

    function stateForEvent(data) {
        // Request/preset parameters are authoritative.  The foreground state
        // is consulted only when the host emitted no native snapshot.
        if (hasTauriParameterSnapshot(data, { yaml })) {
            return stateFromData({ data, context, yaml, fallback: false, stateProvider });
        }
        return stateFromData({ data, context, yaml, fallback: true, stateProvider });
    }

    function settingsReady(data) {
        if (!isRecord(data)) return data;
        const source = sourceOf(data);
        if (!isGoogleSource(source)) return data;
        const state = stateForEvent(data);
        try {
            const prepared = applyTauriParameters(data, state, { yaml });
            applySystemPromptPreference(prepared, getContext());
            replacePayload(data, prepared);
            // Mark only after successful parameter application.  A malformed
            // exclude list is rejected again at the final fetch boundary.
            const marked = markPayload(data, state, {
                target,
                captureUsageContext,
                getUsagePrice,
                startedAt: Date.now(),
            });
            data[REQUEST_STATE] = marked[REQUEST_STATE];
            if (data[REQUEST_STATE].background !== true && !data[REQUEST_STATE].cacheBoundaryToken) {
                data[REQUEST_STATE].cacheBoundaryToken = safeCall(() => getCacheBoundary()?.captureRequest?.(data)) ?? null;
            }
            if (data[REQUEST_STATE].background !== true && !data[REQUEST_STATE].messageCostToken) {
                data[REQUEST_STATE].messageCostToken = observeCost('capture', data, data[REQUEST_STATE].chatId) ?? null;
            }
        } catch (error) {
            // Preserve the intended request-local state even though the event
            // bus may swallow this error.  The final fetch gate will retry the
            // policy and fail closed (for example on an exclude conflict).
            const marked = markPayload(data, state, {
                target,
                captureUsageContext,
                getUsagePrice,
                startedAt: Date.now(),
            });
            data[REQUEST_STATE] = marked[REQUEST_STATE];
            if (data[REQUEST_STATE].background !== true && !data[REQUEST_STATE].messageCostToken) {
                data[REQUEST_STATE].messageCostToken = observeCost('capture', data, data[REQUEST_STATE].chatId) ?? null;
            }
            notifyBlocked(notifyError, localize, error);
        }
        return data;
    }

    const service = context.ChatCompletionService;
    if (service && typeof service.processRequest === 'function') {
        const original = service.processRequest;
        const wrapped = async function tauriProcessRequest(data, options = {}, ...args) {
            if (destroyed || !isRecord(data)) return original.call(this, data, options, ...args);
            const presetName = options?.presetName ?? options?.preset ?? data?.presetName;
            // The host may add chat_completion_source only after loading the
            // named preset.  Resolve that source before the await so the
            // request gets its own chat/price snapshot at generation start.
            const preset = !sourceOf(data) && presetName ? presetCandidate(context, presetName) : null;
            const source = sourceOf(data) || sourceOf(preset);
            if (!isGoogleSource(source)) return original.call(this,
                { ...data, [REQUEST_STATE]: { background: true } }, options, ...args);
            const state = stateFromData({ data, context, yaml, presetName, fallback: true, stateProvider });
            const marked = markPayload(data, state, {
                target,
                captureUsageContext,
                getUsagePrice,
                startedAt: Date.now(),
                metadataData: preset ? { ...preset, ...data, chat_completion_source: source } : data,
            });
            marked[REQUEST_STATE].background = true;
            marked[REQUEST_STATE].messageCostToken = null;
            return original.call(this, marked, options, ...args);
        };
        service.processRequest = wrapped;
        wrappedServices.push(() => {
            if (service.processRequest === wrapped) service.processRequest = original;
        });
    }

    if (service && typeof service.sendRequest === 'function') {
        const original = service.sendRequest;
        const wrapped = async function tauriSendRequest(data, ...args) {
            if (destroyed || !isRecord(data)) return original.call(this, data, ...args);
            const source = sourceOf(data);
            if (!isGoogleSource(source)) return original.call(this, { ...data, [REQUEST_STATE]: { background: true } }, ...args);
            const state = stateFromData({ data, context, yaml, fallback: true, stateProvider });
            const marked = markPayload(data, state, {
                target,
                captureUsageContext,
                getUsagePrice,
                startedAt: Date.now(),
            });
            marked[REQUEST_STATE].background = true;
            marked[REQUEST_STATE].messageCostToken = null;
            return original.call(this, marked, ...args);
        };
        service.sendRequest = wrapped;
        wrappedServices.push(() => {
            if (service.sendRequest === wrapped) service.sendRequest = original;
        });
    }

    const manager = context.ConnectionManagerRequestService;
    if (manager && typeof manager.sendRequest === 'function') {
        const original = manager.sendRequest;
        const wrapped = async function tauriConnectionRequest(profileId, prompt, maxTokens, custom = {}, overridePayload = {}, ...args) {
            if (destroyed) return original.call(this, profileId, prompt, maxTokens, custom, overridePayload, ...args);
            const profile = safeCall(this.getProfile?.bind(this), profileId);
            const profileData = profilePayload(profile);
            const source = profileSource(profile, overridePayload?.chat_completion_source);
            if (!isGoogleSource(source)) {
                return original.call(this, profileId, prompt, maxTokens, custom,
                    profile?.mode === 'cc' ? { ...overridePayload, [REQUEST_STATE]: { background: true } } : overridePayload, ...args);
            }
            const native = (hasTauriParameterSnapshot(profileData, { yaml }) ? nativeState(profileData, yaml) : null)
                || (hasTauriParameterSnapshot(overridePayload, { yaml }) ? nativeState(overridePayload, yaml) : null);
            const oldState = extensionState(profile) ?? extensionState(overridePayload);
            const presetName = custom?.includePreset === false ? undefined : profile?.preset;
            const resolvedPreset = presetName ? presetState(context, presetName, yaml) : null;
            const state = native
                ?? (oldState ? normalizeState(oldState) : resolvedPreset)
                ?? safeCall(stateProvider, { ...profileData, ...overridePayload })
                ?? { ...DEFAULT_STATE };
            const payload = { ...overridePayload };
            payload[REQUEST_STATE] = {
                state: normalizeState(state),
                background: true,
                messageCostToken: null,
                ...(metadataFor({
                    data: { ...profileData, ...payload },
                    state: normalizeState(state),
                    target,
                    captureUsageContext,
                    getUsagePrice,
                    startedAt: Date.now(),
                }) ?? {}),
            };
            return original.call(this, profileId, prompt, maxTokens, custom, payload, ...args);
        };
        manager.sendRequest = wrapped;
        wrappedServices.push(() => {
            if (manager.sendRequest === wrapped) manager.sendRequest = original;
        });
    }

    try {
        const agentTransport = installTauriAgentTransport({ target, requestStateKey: REQUEST_STATE,
            getPromptMigration,
            prepareParameters: prepareAgentParameters,
            observeSnapshot: (snapshot, details) => {
                const accepted = getPromptMigration()?.acceptAgentAssemblyReport?.(details.assemblyEvidence, details);
                if (!accepted) confirmMigration(snapshot?.messages, details.requestMetadata, 'AGENT_PRIVATE_PROMPT_ASSEMBLY_UNAVAILABLE');
            } });
        wrappedServices.push(() => agentTransport.destroy());
    } catch { console.warn('[提示词缓存优化] Agent request controls are unavailable.'); }

    target.fetch = async function tauriFetch(input, init) {
        if (destroyed || !isGenerationRequest(input, init, origin)) {
            return originalFetch.call(this, input, init);
        }

        const signal = init?.signal ?? input?.signal;
        if (signal?.aborted) {
            // Never wait for a Request body that may not finish after cancellation.
            // A settings-ready token can still be recovered from an inline body.
            let abortedMetadata;
            if (typeof init?.body === 'string') {
                try { abortedMetadata = JSON.parse(init.body)?.[REQUEST_STATE]; }
                catch { /* Cancellation takes precedence over malformed JSON. */ }
            }
            if (abortedMetadata?.background !== true && abortedMetadata?.messageCostToken) {
                observeCost('failed', abortedMetadata.messageCostToken);
            }
            safeCall(() => getCacheBoundary()?.cancelRequest?.(abortedMetadata?.cacheBoundaryToken));
            signalAbort(signal);
        }
        // Request.clone().text() can yield after the active chat changes.  A
        // direct fetch therefore captures its fallback conversation before
        // awaiting the body, just like the service wrappers do synchronously.
        const fallbackStartedAt = Date.now();
        const fallbackChatId = safeCall(captureUsageContext);
        const rawBody = await readRequestBody(input, init);
        if (typeof rawBody !== 'string') {
            throw new TypeError('[提示词缓存优化] Expected a JSON generation request.');
        }
        const data = JSON.parse(rawBody);
        const warming = data[CACHE_WARM_FIELD] === true;
        if (warming) data[REQUEST_STATE] = { background: true, chatId: fallbackChatId };
        delete data[CACHE_WARM_FIELD];
        const requestMetadata = isRecord(data[REQUEST_STATE]) ? data[REQUEST_STATE] : null;
        if (!warming && requestMetadata?.background !== true) { try { cacheWarmer?.stop?.(); } catch {} }
        confirmMigration(data.messages, requestMetadata, 'FINAL_PROMPT_ASSEMBLY_UNMIGRATED');
        let cleanedMacros = false;
        if (Array.isArray(data.messages)) {
            const cleaned = sanitizeChat(data.messages);
            cleanedMacros = JSON.stringify(cleaned) !== JSON.stringify(data.messages);
            data.messages = cleaned;
        }
        const costToken = requestMetadata?.background === true ? null : requestMetadata?.messageCostToken;
        const source = sourceOf(data);
        if (!isGoogleSource(source)) {
            safeCall(() => getCacheBoundary()?.cancelRequest?.(requestMetadata?.cacheBoundaryToken));
            delete data[REQUEST_STATE];
            signalAbort(signal);
            const inspection = await reservePrompt(data, signal, requestMetadata, fallbackChatId);
            let dispatched = false;
            try {
                signalAbort(signal);
                dispatched = true;
                const sending = originalFetch.call(this, input,
                    !requestMetadata && !cleanedMacros ? init : { ...init, body: JSON.stringify(data) });
                void observePrompt(inspection, 'markDispatched');
                const response = await sending;
                void observePrompt(inspection, 'finishRequest', { responseOk: response.ok, httpStatus: response.status });
                return response;
            } catch (error) {
                void observePrompt(inspection, dispatched ? 'finishRequest' : 'cancelRequest', { failed: true });
                throw error;
            }
        }
        delete data[REQUEST_STATE];

        let validationState;
        let prepared;
        let usageMetadata = requestMetadata;
        let warmCandidate = null;
        let inspection = null, dispatched = false;
        try {
            signalAbort(signal);
            const state = hasExplicitTauriState(data, { yaml })
                ? readTauriState(data, { yaml })
                : (requestMetadata?.state ? normalizeState(requestMetadata.state) : { ...DEFAULT_STATE });
            validationState = state;
            if (isGoogleSource(source)) {
                const validation = validatePluginState({
                    state,
                    source,
                    model: modelOf(data),
                    region: data.vertexai_region,
                });
                if (!validation.ok) throw validationError(validation);
                validationState = validation.state;
                if (validation.warning) {
                    try {
                        notifyWarning(localize(validation.warning));
                    } catch {
                        // A warning cannot change the request outcome.
                    }
                }
            }
            prepared = applyTauriParameters(data, validationState, { yaml });
            applySystemPromptPreference(prepared, getContext());
            safeCall(() => getCacheBoundary()?.applyRequest?.(prepared, {
                background: requestMetadata?.background === true,
                token: requestMetadata?.cacheBoundaryToken,
            }));
            signalAbort(signal);
            const samePricingIdentity = requestMetadata
                && requestMetadata.source === sourceOf(prepared)
                && requestMetadata.model === modelOf(prepared)
                && requestMetadata.tier === validationState.tier
                && pricingRegion(requestMetadata) === pricingRegion({ source, region: prepared.vertexai_region ?? '' })
                && Object.hasOwn(requestMetadata, 'price');
            // The request-start price is a snapshot.  Keep it when host work
            // leaves source/model/tier/region unchanged; recompute only when the
            // final payload actually changed the pricing identity.
            const finalPrice = samePricingIdentity
                ? requestMetadata.price
                : safeCall(getUsagePrice, prepared, validationState);
            usageMetadata = metadataFor({
                data: prepared,
                state: validationState,
                target,
                captureUsageContext,
                getUsagePrice,
                existing: requestMetadata,
                chatId: requestMetadata && Object.hasOwn(requestMetadata, 'chatId')
                    ? requestMetadata.chatId : (fallbackChatId ?? null),
                price: finalPrice !== undefined ? finalPrice : (samePricingIdentity ? undefined : null),
                startedAt: requestMetadata?.startedAt ?? fallbackStartedAt,
            });
            if (warming && usageMetadata) usageMetadata.cacheWarm = true;
            try {
                await getBillingClient()?.applyLabels?.(prepared, {
                    chatId: usageMetadata?.chatId, requestId: usageMetadata?.id,
                });
            } catch (error) {
                try { notifyWarning(localize(error?.translationKey ?? 'vertex_paygo.billing.error_operation')); }
                catch { /* Optional billing attribution cannot prevent generation. */ }
            }
            if (costToken) observeCost('prepared', costToken, usageMetadata?.id, {
                chatId: usageMetadata?.chatId,
                model: modelOf(prepared), source: sourceOf(prepared),
                region: usageMetadata?.region,
                tier: validationState.tier, stream: Boolean(prepared.stream),
                price: usageMetadata?.price,
            });
            signalAbort(signal);
            inspection = await reservePrompt(prepared, signal, requestMetadata, fallbackChatId);
            signalAbort(signal);
            if (costToken) observeCost('started', costToken);
            dispatched = true;
            applySystemPromptPreference(prepared, getContext());
            const body = JSON.stringify(prepared);
            if (usageMetadata && typeof usageClient?.captureRequest === 'function') {
                try {
                    const requestPreview = Promise.resolve(usageClient.captureRequest(body)).catch(() =>
                        ({ version: 1, status: 'unavailable', reason: 'FINGERPRINT_UNAVAILABLE' }));
                    usageMetadata = { ...usageMetadata, requestPreview };
                }
                catch { /* Request summaries cannot affect generation. */ }
            }
            if (!warming) {
                try {
                    warmCandidate = cacheWarmer?.captureRequest?.(prepared, (request, warmSignal) => tauriFetch.call(target, GENERATE_PATH, {
                        method: 'POST', headers: getContext()?.getRequestHeaders?.() ?? init?.headers,
                        body: JSON.stringify(request), signal: warmSignal,
                    }), { background: requestMetadata?.background === true, preserveProxy: true });
                } catch { /* Warming cannot affect the real request. */ }
            }
            const sending = originalFetch.call(this, input, { ...init, body });
            void observePrompt(inspection, 'markDispatched');
            const response = await sending;
            if (warmCandidate) void cacheWarmer.observeResponse(warmCandidate, response).catch(() => {});
            void observePrompt(inspection, 'finishRequest', { responseOk: response.ok, httpStatus: response.status });
            const observed = await callObservation(usageClient, response, usageMetadata, signal);
            return costToken ? observeCost('response', costToken, observed, signal) ?? observed : observed;
        } catch (error) {
            try { cacheWarmer?.cancelRequest?.(warmCandidate); } catch {}
            safeCall(() => getCacheBoundary()?.cancelRequest?.(requestMetadata?.cacheBoundaryToken));
            void observePrompt(inspection, dispatched ? 'finishRequest' : 'cancelRequest', { failed: true });
            callFailure(usageClient, error, usageMetadata);
            if (costToken) observeCost('failed', costToken);
            notifyBlocked(notifyError, localize, error);
            throw error;
        }
    };

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        try { cacheWarmer?.stop?.(); } catch {}
        if (target.fetch === targetFetch) target.fetch = originalFetch;
        for (const restore of wrappedServices.splice(0)) restore();
    }

    const targetFetch = target.fetch;
    settingsReady.destroy = destroy;
    settingsReady.settingsReady = settingsReady;
    settingsReady.requestStateKey = REQUEST_STATE;
    return settingsReady;
}

export { GENERATE_PATH as TAURI_GENERATE_PATH, REQUEST_STATE as TAURI_REQUEST_STATE };
