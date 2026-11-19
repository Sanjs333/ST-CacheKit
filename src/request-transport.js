/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

import { sanitizeChat } from './prompt-migration.js';
import { PROMPT_INSPECTOR_FIELD } from './prompt-inspector-controller.js';
import { DEFAULT_STATE, EXTENSION_ID, isGoogleSource } from './constants.js';
import { createRequestHook, installFailureSink } from './request-hook.js';
import { normalizeState, requiresPlugin } from './state-machine.js';
import {
    enrichGemini4ModelList, getGemini4RequestTarget, isNativeGemini4Request,
    localizeGemini4Response, serverSupportsNativeGemini4,
} from './gemini4-request.js';
import { createGemini4SignatureTracker } from './gemini4-signatures.js';
import { CACHE_BOUNDARY_FIELD, CACHE_BOUNDARY_STATUS_FIELD } from './cache-prefix-boundary.js';
import { applySystemPromptPreference } from './system-prompt-settings.js';
import { CACHE_WARM_FIELD } from './cache-warmer.js';
import { isNativeRelayCustomAuth } from './native-custom-auth.js';

const REQUEST_STATE = '__vertexPayGoRequestState';
const GENERATE_PATH = '/api/backends/chat-completions/generate';

function nativeInspectionOverrides(data, inspection) {
    if (inspection?.captureMode !== 'native' || inspection.source !== data.chat_completion_source
        || inspection.model !== data.model) return null;
    const proxy = inspection.nativeProxy;
    if (typeof proxy?.ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(proxy.ticket)
        || typeof proxy.proxySecret !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(proxy.proxySecret)) return null;
    let url;
    try { url = new URL(proxy.proxyUrl); } catch { return null; }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
        || url.search || url.hash || url.pathname !== '/native-proxy/' + proxy.ticket) return null;
    const fields = proxy.requestOverrides;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
    const keys = Object.keys(fields).sort();
    if (inspection.source === 'custom') {
        const hasAuth = data.custom_auth !== undefined;
        const expected = hasAuth ? ['custom_auth', 'custom_include_headers', 'custom_url'] : ['custom_include_headers', 'custom_url'];
        if (JSON.stringify(keys) !== JSON.stringify(expected)
            || (hasAuth && !isNativeRelayCustomAuth(fields.custom_auth))
            || fields.custom_url !== url.toString() || typeof fields.custom_include_headers !== 'string') return null;
        let headers;
        try { headers = JSON.parse(fields.custom_include_headers); } catch { return null; }
        if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length !== 1
            || headers.Authorization !== 'Bearer ' + proxy.proxySecret) return null;
        return { custom_url: url.toString(), custom_include_headers: fields.custom_include_headers,
            ...(hasAuth ? { custom_auth: fields.custom_auth } : {}) };
    }
    if (!['openai', 'claude'].includes(inspection.source)
        || JSON.stringify(keys) !== JSON.stringify(['proxy_password', 'reverse_proxy'])
        || fields.reverse_proxy !== url.toString() || fields.proxy_password !== proxy.proxySecret) return null;
    return { reverse_proxy: url.toString(), proxy_password: proxy.proxySecret };
}

// Carry state on each request, rather than in shared mutable state: background
// profile requests may overlap each other and normal chat requests.
function markRequest(data, state, origin, protect = true) {
    const marked = { ...data, [REQUEST_STATE]: { state: normalizeState(state) } };
    if (protect && isGoogleSource(data.chat_completion_source) && requiresPlugin(state, data.chat_completion_source, data.model)) {
        marked[REQUEST_STATE].originalReverseProxy = data.reverse_proxy;
        marked[REQUEST_STATE].originalProxyPassword = data.proxy_password;
        installFailureSink(marked, origin);
        marked[REQUEST_STATE].sink = marked.reverse_proxy;
    }
    return marked;
}

function presetState(context, name) {
    if (!name) return DEFAULT_STATE;
    const preset = context.getPresetManager?.('openai')?.getCompletionPresetByName?.(name);
    // A missing named preset cannot safely be interpreted as Standard.
    if (!preset) throw new Error(`[提示词缓存优化] Cannot resolve request preset: ${name}`);
    return preset.extensions?.[EXTENSION_ID] ?? DEFAULT_STATE;
}

export function installRequestTransport({ context, stateProvider, target = globalThis, captureUsageContext = () => null,
    getUsagePrice = () => null, messageCosts, worldInfoStability, promptInspector, cachePrefixBoundary, cacheWarmer, ...hookOptions }) {
    const origin = hookOptions.origin ?? target.location?.origin;
    const originalFetch = target.fetch;
    if (typeof originalFetch !== 'function') throw new TypeError('当前环境缺少 fetch 请求接口。');
    const requestStates = new WeakMap();
    const requestUsage = new WeakMap();
    const restorers = [];
    let destroyed = false;
    const signatures = createGemini4SignatureTracker({ context,
        getContext: () => target.SillyTavern?.getContext?.() ?? context });
    const installWrapper = (owner, key, wrapper) => {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        restorers.push(() => {
            if (owner[key] !== wrapper) return;
            if (descriptor) Object.defineProperty(owner, key, descriptor);
            else delete owner[key];
        });
        owner[key] = wrapper;
        if (owner[key] !== wrapper) throw new TypeError(`无法安装请求包装接口：${key}`);
    };
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        try { cacheWarmer?.stop?.(); } catch {}
        for (const restore of restorers.reverse()) try { restore(); } catch { /* Preserve other extensions and release remaining wrappers. */ }
        restorers.length = 0;
        try { signatures.cleanup(); } catch { /* Runtime listeners cannot prevent wrapper restoration. */ }
    };
    // Presentation/telemetry must never prevent a generation or change its route.
    const observe = (method, ...args) => {
        try { return messageCosts?.[method]?.(...args); }
        catch (error) { console.warn('[提示词缓存优化] Message cost observation failed.', error); }
    };
    const observeOrder = (method, ...args) => {
        try {
            const result = worldInfoStability?.[method]?.(...args);
            if (result && typeof result.catch === 'function') void result.catch(() => {});
            return result;
        } catch { return null; }
    };
    const observeInspector = async (method, ...args) => {
        try { return await promptInspector?.[method]?.(...args); }
        catch { return null; } // Recording must never block or reroute generation.
    };
    const prepareRequest = createRequestHook({ ...hookOptions, origin,
        usageProvider: data => requestUsage.get(data) ?? {},
        stateProvider: data => requestStates.get(data) });

    const onSettingsReady = data => {
        if (destroyed) return;
        applySystemPromptPreference(data, target.SillyTavern?.getContext?.() ?? context);
        if (!isGoogleSource(data?.chat_completion_source)) {
            if (data?.[REQUEST_STATE]?.background === true) return;
            const chatId = captureUsageContext();
            const token = observeOrder('captureRequest', data, { background: false, chatId });
            if (token) data[REQUEST_STATE] = { usageChatId: chatId, worldInfoOrderToken: token };
            return;
        }
        const background = data[REQUEST_STATE]?.background === true;
        if (background) return;
        Object.assign(data, markRequest(data, stateProvider(), origin));
        data[REQUEST_STATE].usageChatId = captureUsageContext();
        data[REQUEST_STATE].background = background;
        data[REQUEST_STATE].messageCostToken = background ? null
            : observe('capture', data, data[REQUEST_STATE].usageChatId) ?? null;
        data[REQUEST_STATE].worldInfoOrderToken = observeOrder('captureRequest', data, {
            background, chatId: data[REQUEST_STATE].usageChatId,
        });
        try { data[REQUEST_STATE].cacheBoundaryToken = cachePrefixBoundary?.captureRequest?.(data, { background }); } catch {}
    };

    const fetchWrapper = async function payGoFetch(input, init) {
        if (destroyed) return originalFetch.call(this, input, init);
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
        const method = init?.method ?? input?.method ?? 'GET';
        if (url.origin === origin && url.pathname === '/api/backends/chat-completions/status'
            && method.toUpperCase() === 'POST') {
            const body = init?.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : undefined);
            let google = false;
            try { google = isGoogleSource(JSON.parse(body).chat_completion_source); } catch {                             }
            const response = await originalFetch.call(this, input, init);
            return google ? enrichGemini4ModelList(response) : response;
        }
        if (url.origin !== origin || url.pathname !== GENERATE_PATH || method.toUpperCase() !== 'POST') {
            return originalFetch.call(this, input, init);
        }
        const signal = init?.signal ?? input?.signal;
        // Capture before async Request body/preset/credential work: switching
        // chats while a request is in flight must never move its charge.
        const fallbackChatId = captureUsageContext();
        const rawBody = init?.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : undefined);
        // Host generation requests use JSON strings; reject unexpected formats
        // instead of silently letting a paid request bypass preparation.
        if (typeof rawBody !== 'string') throw new TypeError('[提示词缓存优化] Expected a JSON generation request.');
        const data = JSON.parse(rawBody);
        const warming = data[CACHE_WARM_FIELD] === true;
        if (warming) data[REQUEST_STATE] = { background: true, usageChatId: fallbackChatId };
        applySystemPromptPreference(data, target.SillyTavern?.getContext?.() ?? context);
        const hadBoundaryMarker = Object.hasOwn(data, CACHE_BOUNDARY_FIELD) || Object.hasOwn(data, CACHE_BOUNDARY_STATUS_FIELD);
        if (!warming) delete data[CACHE_BOUNDARY_FIELD];
        delete data[CACHE_BOUNDARY_STATUS_FIELD];
        const hadInspectorMarker = Object.hasOwn(data, PROMPT_INSPECTOR_FIELD);
        delete data[PROMPT_INSPECTOR_FIELD];
        const hadOrderMarker = Object.hasOwn(data, '__vertexPayGoNativeOrder');
        delete data.__vertexPayGoNativeOrder;
        let cleanedMacros = false;
        if (Array.isArray(data.messages)) { const cleaned = sanitizeChat(data.messages); cleanedMacros = JSON.stringify(cleaned) !== JSON.stringify(data.messages); data.messages = cleaned; }
        const metadata = data[REQUEST_STATE];
        if (!warming && metadata?.background !== true) { try { cacheWarmer?.stop?.(); } catch {} }
        try { signal?.throwIfAborted(); } catch (error) {
            try { cachePrefixBoundary?.cancelRequest?.(metadata?.cacheBoundaryToken); } catch {}
            if (metadata?.worldInfoOrderToken) observeOrder('cancelRequest', metadata.worldInfoOrderToken, 'not-sent');
            if (metadata?.messageCostToken) observe('failed', metadata.messageCostToken);
            throw error;
        }
        let providerCapture = false;
        try { providerCapture = isGoogleSource(data.chat_completion_source)
            && requiresPlugin(metadata?.state ?? stateProvider(), data.chat_completion_source, data.model); }
        catch { /* Request preparation reports invalid tier state through its normal path. */ }
        let inspection = await observeInspector('reserveRequest', data, {
            background: metadata?.background === true, chatId: metadata?.usageChatId ?? fallbackChatId,
            providerCapture,
            signal,
        });
        if (!isGoogleSource(data.chat_completion_source)) {
            if (!metadata && !inspection) return originalFetch.call(this, input, cleanedMacros || hadInspectorMarker || hadOrderMarker || hadBoundaryMarker ? { ...init, body: JSON.stringify(data) } : init);
            delete data[REQUEST_STATE];
            const token = metadata?.worldInfoOrderToken;
            const plan = token ? observeOrder('requestPlan', token, data) : null;
            const receipt = plan ? observeOrder('captureFrontendReceipt', token, data, plan) : null;
            if (token && !receipt) observeOrder('cancelRequest', token, 'frontend-unverified');
            if (inspection?.captureMode === 'native') {
                const overrides = nativeInspectionOverrides(data, inspection);
                if (overrides) Object.assign(data, overrides);
                else { await observeInspector('cancelRequest', inspection); inspection = null; }
            }
            let hostDispatched = false;
            try {
                signal?.throwIfAborted(); hostDispatched = true;
                const sending = originalFetch.call(this, input, { ...init, body: JSON.stringify(data) });
                if (inspection) void observeInspector('markDispatched', inspection);
                const response = await sending;
                if (inspection) void observeInspector('finishRequest', inspection, { responseOk: response.ok, httpStatus: response.status });
                if (receipt) observeOrder('confirmFrontendRequest', token, receipt, { responseOk: response.ok });
                return response;
            } catch (error) {
                if (token) observeOrder('cancelRequest', token, 'not-sent');
                if (inspection) void observeInspector(hostDispatched ? 'finishRequest' : 'cancelRequest', inspection, { failed: true });
                throw error;
            }
        }
        delete data[REQUEST_STATE];
        const state = metadata?.state ?? stateProvider();
        if (metadata?.sink && data.reverse_proxy === metadata.sink) {
            data.reverse_proxy = metadata.originalReverseProxy ?? '';
            data.proxy_password = metadata.originalProxyPassword ?? '';
        }
        requestStates.set(data, state);
        const usageChatId = metadata && Object.hasOwn(metadata, 'usageChatId')
            ? metadata.usageChatId : fallbackChatId;
        let worldInfoToken = metadata?.worldInfoOrderToken;
        const orderPlan = worldInfoToken ? observeOrder('requestPlan', worldInfoToken, data) : null;
        const worldInfoOrder = providerCapture && orderPlan?.version === 1 && Array.isArray(orderPlan.groups) ? orderPlan : null;
        const frontendOrder = !providerCapture && orderPlan ? observeOrder('captureFrontendReceipt', worldInfoToken, data, orderPlan) : null;
        if (worldInfoToken && !worldInfoOrder && !frontendOrder) { observeOrder('cancelRequest', worldInfoToken, 'request-scope-changed'); worldInfoToken = null; }
        requestUsage.set(data, {
            ...(usageChatId ? { usageChatId } : {}),
            usagePrice: getUsagePrice(data, state),
            ...(worldInfoOrder && usageChatId ? { worldInfoOrder } : {}),
            ...(inspection?.captureMode === 'google' ? { promptInspectorTicket: inspection.ticket } : {}),
        });
        const costToken = metadata?.messageCostToken;
        const signatureToken = isNativeGemini4Request(data) ? signatures.capture(data, metadata?.background) : null;
        let requestTarget = input;
        let nativeGemini4 = false;
        let preparedOrder;
        try {
            const prepared = await prepareRequest(data);
            preparedOrder = prepared;
            if (isNativeGemini4Request(data)) {
                if (!serverSupportsNativeGemini4(prepared, data.model)) {
                    const message = hookOptions.localize?.('vertex_paygo.gemini4.server_upgrade')
                        ?? 'Gemini 4 兼容功能需要新版服务端插件，请更新服务端并重启 SillyTavern。';
                    throw Object.assign(new Error(message), { code: 'GEMINI4_SERVER_UPGRADE_REQUIRED' });
                }
                data.native_gemini_api_version = prepared.nativeGeminiApiVersion;
                requestTarget = getGemini4RequestTarget(input, origin);
                nativeGemini4 = true;
                if (warming && prepared.nativeGeminiCacheWarm !== true) throw new Error(hookOptions.localize?.('vertex_paygo.cache_warm.server_upgrade') ?? 'Cache warming requires an updated server plugin.');
            }
            if (costToken) observe('prepared', costToken, prepared?.usageId, {
                chatId: usageChatId, model: data.model, source: data.chat_completion_source,
                region: data.chat_completion_source === 'vertexai' ? (data.vertexai_region || 'us-central1') : '',
                tier: state.tier, stream: Boolean(data.stream), price: requestUsage.get(data).usagePrice,
            });
        } catch (error) {
            if (costToken) observe('failed', costToken);
            try { cachePrefixBoundary?.cancelRequest?.(metadata?.cacheBoundaryToken); } catch {}
            if (worldInfoToken) observeOrder('cancelRequest', worldInfoToken);
            if (inspection) void observeInspector('cancelRequest', inspection);
            throw error;
        } finally {
            requestStates.delete(data);
            requestUsage.delete(data);
        }
        let googleDispatched = false;
        let warmCandidate = null;
        try {
            signal?.throwIfAborted();
            if (metadata?.cacheBoundaryToken) {
                let boundary;
                try { boundary = await cachePrefixBoundary?.bindRequest?.(metadata.cacheBoundaryToken, data,
                    { supported: nativeGemini4 && preparedOrder?.nativeGeminiCacheBoundary === true }); } catch {}
                if (boundary) data[CACHE_BOUNDARY_FIELD] = boundary;
            }
            if (nativeGemini4 && metadata?.background !== true) {
                try {
                    const state = cachePrefixBoundary?.snapshot?.();
                    if (state) data[CACHE_BOUNDARY_STATUS_FIELD] = { version: 1, status: state.enabled ? state.status : 'disabled' };
                } catch { /* Optional diagnostic metadata never changes generation. */ }
            }
            signal?.throwIfAborted();
            if (costToken) observe('started', costToken);
            googleDispatched = true;
            if (!warming) {
                try {
                    warmCandidate = cacheWarmer?.captureRequest?.(data, (request, warmSignal) => fetchWrapper.call(target, GENERATE_PATH, {
                        method: 'POST', headers: (target.SillyTavern?.getContext?.() ?? context)?.getRequestHeaders?.() ?? init?.headers,
                        body: JSON.stringify(request), signal: warmSignal,
                    }), { background: metadata?.background === true, supported: nativeGemini4 && preparedOrder?.nativeGeminiCacheWarm === true });
                } catch { /* Optional warming cannot affect the real request. */ }
            }
            const sending = originalFetch.call(this, requestTarget, { ...init, body: JSON.stringify(data) });
            if (inspection) void observeInspector('markDispatched', inspection);
            let response = await sending;
            if (warmCandidate) void cacheWarmer.observeResponse(warmCandidate, response).catch(() => {});
            if (metadata?.cacheBoundaryToken && data[CACHE_BOUNDARY_FIELD]) {
                try { cachePrefixBoundary?.confirmRequest?.(metadata.cacheBoundaryToken, response); } catch {}
            }
            if (inspection) void observeInspector('finishRequest', inspection, { responseOk: response.ok, httpStatus: response.status });
            if (frontendOrder) observeOrder('confirmFrontendRequest', worldInfoToken, frontendOrder, { responseOk: response.ok });
            else if (worldInfoToken) observeOrder('confirmRequest', worldInfoToken, {
                prepared: preparedOrder, serverClient: hookOptions.serverClient, responseOk: response.ok,
            });
            if (signatureToken) {
                try { await signatures.observe(signatureToken, response); }
                catch (error) { console.warn('[提示词缓存优化] Could not preserve the native Gemini signature.', error); }
            }
            if (nativeGemini4) response = await localizeGemini4Response(response, hookOptions.localize);
            return costToken ? observe('response', costToken, response, signal) ?? response : response;
        } catch (error) {
            try { cacheWarmer?.cancelRequest?.(warmCandidate); } catch {}
            try { cachePrefixBoundary?.cancelRequest?.(metadata?.cacheBoundaryToken); } catch {}
            if (costToken) observe('failed', costToken);
            if (worldInfoToken) observeOrder('cancelRequest', worldInfoToken);
            if (inspection) void observeInspector(googleDispatched ? 'finishRequest' : 'cancelRequest', inspection, { failed: true });
            throw error;
        }
    };

    try {
        installWrapper(target, 'fetch', fetchWrapper);
        const service = context.ChatCompletionService;
        if (service) {
            const processRequest = service.processRequest;
            const sendRequest = service.sendRequest;
            if (typeof processRequest === 'function') installWrapper(service, 'processRequest', async function (data, options = {}, ...args) {
                if (destroyed) return processRequest.call(this, data, options, ...args);
                if (data.chat_completion_source && !isGoogleSource(data.chat_completion_source)) {
                    return processRequest.call(this, worldInfoStability || promptInspector ? { ...data, [REQUEST_STATE]: { background: true } } : data, options, ...args);
                }
                const marked = data[REQUEST_STATE] ? data : markRequest(data,
                    // The host has not yet merged proxy settings from the preset.
                    presetState(context, options.presetName), origin, false);
                marked[REQUEST_STATE].background = true;
                marked[REQUEST_STATE].messageCostToken = null;
                if (!Object.hasOwn(marked[REQUEST_STATE], 'usageChatId')) {
                    marked[REQUEST_STATE].usageChatId = captureUsageContext();
                }
                return processRequest.call(this, marked, options, ...args);
            });
            if (typeof sendRequest === 'function') installWrapper(service, 'sendRequest', async function (data, ...args) {
                if (destroyed) return sendRequest.call(this, data, ...args);
                if (!isGoogleSource(data.chat_completion_source)) return sendRequest.call(this, worldInfoStability || promptInspector ? { ...data, [REQUEST_STATE]: { background: true } } : data, ...args);
                const marked = data[REQUEST_STATE] ? data : markRequest(data,
                    data.extensions?.[EXTENSION_ID] ?? DEFAULT_STATE, origin);
                marked[REQUEST_STATE].background = true;
                marked[REQUEST_STATE].messageCostToken = null;
                if (!Object.hasOwn(marked[REQUEST_STATE], 'usageChatId')) {
                    marked[REQUEST_STATE].usageChatId = captureUsageContext();
                }
                return sendRequest.call(this, marked, ...args);
            });
        }

        const manager = context.ConnectionManagerRequestService;
        if (typeof manager?.sendRequest === 'function') {
            const sendRequest = manager.sendRequest;
            installWrapper(manager, 'sendRequest', async function (profileId, prompt, maxTokens, custom = {}, overridePayload = {}) {
                if (destroyed) return sendRequest.call(this, profileId, prompt, maxTokens, custom, overridePayload);
                const profile = this.getProfile(profileId);
                if (profile?.mode !== 'cc' || !isGoogleSource(profile.api)) {
                    return sendRequest.call(this, profileId, prompt, maxTokens, custom, (worldInfoStability || promptInspector) && profile?.mode === 'cc' ? { ...overridePayload, [REQUEST_STATE]: { background: true } } : overridePayload);
                }
                const state = profile?.[EXTENSION_ID] ?? presetState(context,
                    custom.includePreset === false ? undefined : profile?.preset);
                // The host adds provider/model before merging overridePayload.
                return sendRequest.call(this, profileId, prompt, maxTokens, custom, {
                    ...overridePayload, [REQUEST_STATE]: { state: normalizeState(state), usageChatId: captureUsageContext(), background: true },
                });
            });
        }
        onSettingsReady.destroy = destroy;
        return onSettingsReady;
    } catch (error) { destroy(); throw error; }
}
