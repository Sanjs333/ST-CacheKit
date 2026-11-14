/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
    CLIENT_LOG_MEDIA_TYPE,
    HEALTH_TIMEOUT_MS,
    EXTENSION_ID,
    LOG_TIMEOUT_MS,
    MAX_LOG_RESPONSE_BYTES,
    PREPARE_TIMEOUT_MS,
    PROTOCOL_VERSION,
    UPDATE_CHECK_TIMEOUT_MS,
    UPDATE_START_TIMEOUT_MS,
    UPDATE_STATUS_TIMEOUT_MS,
    REQUIRED_TRANSPORT,
    SERVER_ROUTES,
} from './constants.js';

export class ServerPluginError extends Error {
    constructor(message, { code = 'SERVER_PLUGIN_ERROR', status, serverCode, responseFormat, cause } = {}) {
        super(message, { cause });
        this.name = 'ServerPluginError';
        this.code = code;
        this.status = status;
        this.serverCode = serverCode;
        this.responseFormat = responseFormat;
    }
}

export function parseLoopbackProxyUrl(value) {
    let url;
    try {
        url = new URL(String(value));
    } catch (cause) {
        throw new ServerPluginError('Server Plugin returned an invalid proxy URL.', {
            code: 'INVALID_PROXY_URL',
            cause,
        });
    }

    // The Server Plugin chooses the ticket length. Require a bounded base64url
    // token here, then bind it exactly to data.ticket in prepare().
    const validPath = /^\/proxy\/[A-Za-z0-9_-]{16,128}$/.test(url.pathname);
    if (
        url.protocol !== 'http:'
        || url.hostname !== '127.0.0.1'
        || !url.port
        || url.username
        || url.password
        || !validPath
        || url.search
        || url.hash
    ) {
        throw new ServerPluginError('Server Plugin proxy URL is not an authenticated loopback HTTP endpoint.', {
            code: 'UNSAFE_PROXY_URL',
        });
    }

    return url.toString();
}

const NATIVE_PREPARE_FIELDS = ['reverse_proxy', 'proxy_password', 'secret_id', 'custom_url',
    'custom_include_headers', 'custom_api_format'];
const NATIVE_SOURCES = new Set(['openai', 'claude', 'custom']);

function validateNativePreparation(data, source) {
    const invalid = () => {
        const error = new ServerPluginError('Server Plugin returned an invalid native relay preparation.', { code: 'INVALID_NATIVE_PREPARE' });
        if (typeof data?.ticket === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(data.ticket)) error.nativeTicket = data.ticket;
        throw error;
    };
    if (data?.ok !== true || data.protocolVersion !== PROTOCOL_VERSION || data.transport !== 'native-loopback-http'
        || data.source !== source || typeof data.ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(data.ticket)
        || typeof data.proxySecret !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(data.proxySecret)
        || typeof data.expiresAt !== 'string' || data.expiresAt.length > 64 || !Number.isFinite(Date.parse(data.expiresAt))) invalid();
    let url;
    try { url = new URL(data.proxyUrl); } catch { invalid(); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
        || url.search || url.hash || url.pathname !== '/native-proxy/' + data.ticket) invalid();
    const fields = data.requestOverrides;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) invalid();
    const keys = Object.keys(fields).sort();
    let overrides;
    if (source === 'custom') {
        if (JSON.stringify(keys) !== JSON.stringify(['custom_include_headers', 'custom_url'])
            || fields.custom_url !== url.toString() || typeof fields.custom_include_headers !== 'string') invalid();
        let headers;
        try { headers = JSON.parse(fields.custom_include_headers); } catch { invalid(); }
        if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length !== 1
            || headers.Authorization !== 'Bearer ' + data.proxySecret) invalid();
        overrides = { custom_url: url.toString(), custom_include_headers: fields.custom_include_headers };
    } else {
        if (JSON.stringify(keys) !== JSON.stringify(['proxy_password', 'reverse_proxy'])
            || fields.reverse_proxy !== url.toString() || fields.proxy_password !== data.proxySecret) invalid();
        overrides = { reverse_proxy: url.toString(), proxy_password: data.proxySecret };
    }
    return { ok: true, protocolVersion: data.protocolVersion, transport: data.transport, source,
        ticket: data.ticket, proxyUrl: url.toString(), proxySecret: data.proxySecret,
        expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null, requestOverrides: overrides };
}

// Error pages can come from SillyTavern or an upstream reverse proxy. Read only
// a bounded prefix and never expose arbitrary HTML in a user-facing message.
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;

async function readHttpError(response) {
    let data;
    let text = '';
    try {
        if (response.body?.getReader) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let remaining = MAX_ERROR_RESPONSE_BYTES;
            try {
                while (remaining > 0) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const prefix = value.subarray(0, remaining);
                    text += decoder.decode(prefix, { stream: true });
                    remaining -= prefix.byteLength;
                }
                text += decoder.decode();
            } finally {
                await reader.cancel();
                reader.releaseLock();
            }
            try { data = JSON.parse(text); } catch {                                 }
        } else if (typeof response.text === 'function') {
            text = String(await response.text()).slice(0, MAX_ERROR_RESPONSE_BYTES);
            try { data = JSON.parse(text); } catch {                            }
        } else {
            // Support minimal host adapters that expose only json().
            data = await response.json();
        }
    } catch (cause) {
        if (cause?.name === 'AbortError') throw cause;
        // An unreadable error body must not hide the HTTP failure status.
    }
    if (response.status === 403 && /\bInvalid CSRF token\b/iu.test(text)) {
        return new ServerPluginError('SillyTavern rejected the CSRF token (HTTP 403). Refresh the page and try again.', {
            code: 'CSRF_REJECTED', status: response.status,
        });
    }
    const message = typeof data?.message === 'string' && data.message.trim()
        ? data.message : `Server Plugin request failed (HTTP ${response.status}); no JSON error details were returned.`;
    return new ServerPluginError(message, {
        code: 'HTTP_ERROR', status: response.status,
        serverCode: typeof data?.code === 'string' ? data.code : undefined,
        responseFormat: data === undefined ? 'non-json' : 'json',
    });
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        if (!response.ok) throw await readHttpError(response);
        let data;
        try {
            data = await response.json();
        } catch (cause) {
            if (cause?.name === 'AbortError') throw cause;
            throw new ServerPluginError('Server Plugin returned a non-JSON response.', {
                code: 'INVALID_RESPONSE',
                status: response.status,
                cause,
            });
        }

        return data;
    } catch (error) {
        if (error instanceof ServerPluginError) {
            throw error;
        }
        if (error?.name === 'AbortError') {
            throw new ServerPluginError('Server Plugin request timed out.', { code: 'TIMEOUT', cause: error });
        }
        throw new ServerPluginError('Server Plugin is unavailable.', { code: 'UNAVAILABLE', cause: error });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchText(fetchImpl, url, options, timeoutMs, {
    maxBytes = MAX_LOG_RESPONSE_BYTES,
    contentTypePattern = /^text\/plain(?:\s*;|$)/iu,
} = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            controller.abort();
            throw new ServerPluginError('Server Plugin log response is too large.', {
                code: 'LOG_TOO_LARGE',
                status: response.status,
            });
        }

        let data;
        try {
            if (response.body && typeof response.body.getReader === 'function' && typeof TextDecoder === 'function') {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let totalBytes = 0;
                let text = '';
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    totalBytes += value.byteLength;
                    if (totalBytes > maxBytes) {
                        await reader.cancel();
                        throw new ServerPluginError('Server Plugin log response is too large.', {
                            code: 'LOG_TOO_LARGE',
                            status: response.status,
                        });
                    }
                    text += decoder.decode(value, { stream: true });
                }
                data = text + decoder.decode();
            } else {
                data = await response.text();
                const byteLength = typeof TextEncoder === 'function'
                    ? new TextEncoder().encode(data).byteLength
                    : data.length;
                if (byteLength > maxBytes) {
                    throw new ServerPluginError('Server Plugin log response is too large.', {
                        code: 'LOG_TOO_LARGE',
                        status: response.status,
                    });
                }
            }
        } catch (cause) {
            if (cause?.name === 'AbortError') throw cause;
            if (cause instanceof ServerPluginError) throw cause;
            throw new ServerPluginError('Server Plugin returned an invalid text response.', {
                code: 'INVALID_LOG_RESPONSE',
                status: response.status,
                cause,
            });
        }
        if (!response.ok) {
            let message = `Server Plugin request failed (${response.status}).`;
            try {
                const parsed = JSON.parse(data);
                if (typeof parsed?.message === 'string') message = parsed.message;
            } catch {

            }
            throw new ServerPluginError(message, { code: 'HTTP_ERROR', status: response.status });
        }
        const contentType = response.headers?.get?.('content-type');
        if (contentType && !contentTypePattern.test(contentType)) {
            throw new ServerPluginError('Server Plugin returned an invalid log content type.', {
                code: 'INVALID_LOG_RESPONSE',
                status: response.status,
            });
        }
        return data;
    } catch (error) {
        if (error instanceof ServerPluginError) throw error;
        if (error?.name === 'AbortError') {
            throw new ServerPluginError('Server Plugin request timed out.', { code: 'TIMEOUT', cause: error });
        }
        throw new ServerPluginError('Server Plugin is unavailable.', { code: 'UNAVAILABLE', cause: error });
    } finally {
        clearTimeout(timeout);
    }
}

async function sendWithoutBody(fetchImpl, url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        if (!response.ok) {
            let message = `Server Plugin request failed (${response.status}).`;
            try {
                const data = await response.json();
                if (typeof data?.message === 'string') message = data.message;
            } catch {
                // The log transport deliberately ignores non-JSON error details.
            }
            throw new ServerPluginError(message, { code: 'HTTP_ERROR', status: response.status });
        }
    } catch (error) {
        if (error instanceof ServerPluginError) throw error;
        if (error?.name === 'AbortError') {
            throw new ServerPluginError('Server Plugin request timed out.', { code: 'TIMEOUT', cause: error });
        }
        throw new ServerPluginError('Server Plugin is unavailable.', { code: 'UNAVAILABLE', cause: error });
    } finally {
        clearTimeout(timeout);
    }
}

function validateHandshake(data) {
    if (data?.ok !== true || data?.pluginId !== EXTENSION_ID || data?.protocolVersion !== PROTOCOL_VERSION) {
        throw new ServerPluginError(`Server Plugin protocol v${PROTOCOL_VERSION} is required.`, {
            code: 'PROTOCOL_MISMATCH',
        });
    }
    if (data.transport !== REQUIRED_TRANSPORT) {
        throw new ServerPluginError(`Server Plugin transport “${REQUIRED_TRANSPORT}” is required.`, {
            code: 'TRANSPORT_MISMATCH',
        });
    }
    return data;
}

// Inspector content is private ephemeral request evidence, never a log entry.
async function fetchInspectorJson(fetchImpl, url, options, timeoutMs = 3000) {
    const text = await fetchText(fetchImpl, url, options, timeoutMs, {
        maxBytes: 16 * 1024 * 1024,
        contentTypePattern: /^application\/json(?:\s*;|$)/iu,
    });
    try { return JSON.parse(text); }
    catch { throw new ServerPluginError('The prompt snapshot response is invalid.', { code: 'INVALID_INSPECTOR_RESPONSE' }); }
}
const inspectorQuery = value => {
    const options = typeof value === 'string' ? { ticket: value } : value;
    const params = new URLSearchParams();
    if (options?.ticket) params.set('ticket', options.ticket);
    else if (options?.chatId) params.set('chatId', options.chatId);
    if (typeof options?.source === 'string') params.set('source', options.source);
    if (typeof options?.model === 'string') params.set('model', options.model);
    return params.size ? '?' + params.toString() : '';
};

export function createServerClient({ fetchImpl = globalThis.fetch, getRequestHeaders = () => ({}) } = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('A fetch implementation is required.');
    }

    return {
        async checkHealth() {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.HEALTH, {
                method: 'GET',
                headers: { ...getRequestHeaders(), Accept: 'application/json' },
                cache: 'no-store',
            }, HEALTH_TIMEOUT_MS);
            return validateHandshake(data);
        },

        async prepare(payload) {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.PREPARE, {
                method: 'POST',
                headers: { ...getRequestHeaders(), Accept: 'application/json' },
                body: JSON.stringify(payload),
                cache: 'no-store',
            }, PREPARE_TIMEOUT_MS);

            validateHandshake(data);
            const proxyUrl = parseLoopbackProxyUrl(data.proxyUrl);
            const ticket = new URL(proxyUrl).pathname.split('/').at(-1);
            if (data.ticket !== ticket) {
                throw new ServerPluginError('Server Plugin ticket does not match its proxy URL.', {
                    code: 'INVALID_PROXY_TICKET',
                });
            }
            if (typeof data.proxySecret !== 'string' || data.proxySecret.length < 16) {
                throw new ServerPluginError('Server Plugin returned an invalid proxy secret.', {
                    code: 'INVALID_PROXY_SECRET',
                });
            }

            return {
                ...data,
                proxyUrl,
                proxySecret: data.proxySecret,
            };
        },

        async checkUpdate() {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.UPDATE, {
                method: 'GET',
                headers: { ...getRequestHeaders(), Accept: 'application/json' },
                cache: 'no-store',
            }, UPDATE_CHECK_TIMEOUT_MS);
            if (data?.ok !== true || !['update-available', 'up-to-date', 'blocked'].includes(data.status) || !Array.isArray(data.components)) {
                throw new ServerPluginError('Server Plugin returned an invalid update check.', { code: 'INVALID_UPDATE_RESPONSE' });
            }
            return data;
        },

        async startUpdate() {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.UPDATE, {
                method: 'POST',
                headers: { ...getRequestHeaders(), Accept: 'application/json', 'Content-Type': 'application/json' },
                body: '{}',
                cache: 'no-store',
            }, UPDATE_START_TIMEOUT_MS);
            if (data?.ok !== true || data.started !== true) {
                throw new ServerPluginError('Server Plugin did not start the update.', { code: 'INVALID_UPDATE_RESPONSE' });
            }
            return data;
        },

        async readUpdateStatus() {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.UPDATE_STATUS, {
                method: 'GET',
                headers: { ...getRequestHeaders(), Accept: 'application/json' },
                cache: 'no-store',
            }, UPDATE_STATUS_TIMEOUT_MS);
            if (data?.ok !== true || typeof data.running !== 'boolean') {
                throw new ServerPluginError('Server Plugin returned an invalid update status.', { code: 'INVALID_UPDATE_RESPONSE' });
            }
            return data;
        },

        async readLogs() {
            return await fetchText(fetchImpl, SERVER_ROUTES.LOGS, {
                method: 'GET',
                headers: { ...getRequestHeaders(), Accept: 'text/plain' },
                cache: 'no-store',
            }, LOG_TIMEOUT_MS);
        },

        async preparePromptInspector(payload) {
            return fetchInspectorJson(fetchImpl, '/api/plugins/vertex-paygo/prompt-inspector', {
                method: 'POST', headers: { ...getRequestHeaders(), Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(payload), cache: 'no-store',
            }, 2000);
        },
        async readPromptInspector(value) {
            return fetchInspectorJson(fetchImpl, '/api/plugins/vertex-paygo/prompt-inspector' + inspectorQuery(value), {
                method: 'GET', headers: { ...getRequestHeaders(), Accept: 'application/json' }, cache: 'no-store',
            });
        },
        async clearPromptInspector(value) {
            return fetchInspectorJson(fetchImpl, '/api/plugins/vertex-paygo/prompt-inspector' + inspectorQuery(value), {
                method: 'DELETE', headers: { ...getRequestHeaders(), Accept: 'application/json' }, cache: 'no-store',
            }, 2000);
        },
        async prepareNativeRequest(payload) {
            if (!payload || !NATIVE_SOURCES.has(payload.source) || typeof payload.model !== 'string'
                || typeof payload.chatId !== 'string' || typeof payload.promptInspectorTicket !== 'string') {
                throw new TypeError('A native request scope and prompt inspector ticket are required.');
            }
            const body = { version: 1, source: payload.source, model: payload.model, chatId: payload.chatId,
                promptInspectorTicket: payload.promptInspectorTicket };
            for (const field of NATIVE_PREPARE_FIELDS) if (payload[field] !== undefined && payload[field] !== null) body[field] = payload[field];
            const data = await fetchJson(fetchImpl, '/api/plugins/vertex-paygo/native-prepare', {
                method: 'POST', headers: { ...getRequestHeaders(), Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(body), cache: 'no-store',
            }, 5000);
            return validateNativePreparation(data, payload.source);
        },
        async cancelNativeRequest(ticket) {
            if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(ticket)) throw new TypeError('A native relay ticket is required.');
            return fetchJson(fetchImpl, '/api/plugins/vertex-paygo/native-prepare?ticket=' + encodeURIComponent(ticket), {
                method: 'DELETE', headers: { ...getRequestHeaders(), Accept: 'application/json' }, cache: 'no-store',
            }, 2000);
        },
        async prepareNativeOrder({ plan, source, model, chatId }) {
            return await fetchJson(fetchImpl, '/api/plugins/vertex-paygo/native-order', {
                method: 'POST', headers: { ...getRequestHeaders(), Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan, source, model, chatId }), cache: 'no-store',
            }, LOG_TIMEOUT_MS);
        },
        async readNativeOrder(ticket) {
            return await fetchJson(fetchImpl, '/api/plugins/vertex-paygo/native-order?ticket=' + encodeURIComponent(ticket), {
                method: 'GET', headers: { ...getRequestHeaders(), Accept: 'application/json' }, cache: 'no-store',
            }, LOG_TIMEOUT_MS);
        },
        async cancelNativeOrder(ticket) {
            return await fetchJson(fetchImpl, '/api/plugins/vertex-paygo/native-order?ticket=' + encodeURIComponent(ticket), {
                method: 'DELETE', headers: { ...getRequestHeaders(), Accept: 'application/json' }, cache: 'no-store',
            }, LOG_TIMEOUT_MS);
        },
        async readUsage(chatId, { includeRequestPreviews = false, latest } = {}) {
            if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) {
                throw new TypeError('A valid conversation usage ID is required.');
            }
            if (latest !== undefined && (includeRequestPreviews !== true || !Number.isSafeInteger(latest) || latest < 1 || latest > 50)) {
                throw new TypeError('A latest preview page requires an explicit bounded preview selection.');
            }
            const previewSuffix = includeRequestPreviews === true ? `&includeRequestPreviews=1${latest === undefined ? '' : `&latest=${latest}`}` : '';
            const records = [];
            const cursors = new Set();
            let cursor;
            let truncated = false;
            do {
                const suffix = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`;
                const data = await fetchJson(fetchImpl, `${SERVER_ROUTES.USAGE}?chatId=${encodeURIComponent(chatId)}${previewSuffix}${suffix}`, {
                    method: 'GET',
                    headers: { ...getRequestHeaders(), Accept: 'application/json' },
                    cache: 'no-store',
                }, LOG_TIMEOUT_MS);
                if (data?.ok !== true || !Array.isArray(data.records)) {
                    throw new ServerPluginError('Invalid usage ledger response.', { code: 'INVALID_USAGE_RESPONSE' });
                }
                records.push(...data.records);
                cursor = data.nextCursor ?? undefined;
                // All fetched pages together form the complete ledger.
                truncated ||= data.truncated === true && cursor === undefined;
                if (cursor !== undefined) {
                    if (typeof cursor !== 'string' || cursor.length > 256 || !cursor || cursors.has(cursor)) {
                        throw new ServerPluginError('Invalid usage ledger cursor.', { code: 'INVALID_USAGE_RESPONSE' });
                    }
                    cursors.add(cursor);
                }
            } while (cursor !== undefined);
            return { ok: true, records, truncated };
        },

        async writeClientLog(entry) {
            await sendWithoutBody(fetchImpl, SERVER_ROUTES.CLIENT_LOG, {
                method: 'POST',
                headers: {
                    ...getRequestHeaders(),
                    Accept: 'application/json',
                    'Content-Type': CLIENT_LOG_MEDIA_TYPE,
                },
                body: JSON.stringify(entry),
                cache: 'no-store',
            }, LOG_TIMEOUT_MS);
        },
    };
}
