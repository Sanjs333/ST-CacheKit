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
import { createLocalizer, localizeError } from './i18n.js';

export class ServerPluginError extends Error {
    constructor(message, { code = 'SERVER_PLUGIN_ERROR', status, serverCode, responseFormat, details, cause } = {}) {
        super(message, { cause });
        this.name = 'ServerPluginError';
        this.code = code;
        this.status = status;
        this.serverCode = serverCode;
        this.responseFormat = responseFormat;
        if (details && typeof details === 'object' && !Array.isArray(details)) this.details = details;
    }
}

export function parseLoopbackProxyUrl(value) {
    let url;
    try {
        url = new URL(String(value));
    } catch (cause) {
        throw new ServerPluginError('后端插件返回了无效的代理地址。', {
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
        throw new ServerPluginError('后端代理地址必须是经过认证的本地 HTTP 回环端点。', {
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
        const error = new ServerPluginError('后端插件返回了无效的原生请求准备信息。', { code: 'INVALID_NATIVE_PREPARE' });
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
        return new ServerPluginError('SillyTavern 拒绝了 CSRF 令牌（HTTP 403），请刷新页面后重试。', {
            code: 'CSRF_REJECTED', status: response.status,
        });
    }
    const payload = data?.error && typeof data.error === 'object' ? data.error : data;
    const message = typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message : `后端插件请求失败（HTTP ${response.status}），未返回 JSON 错误详情。`;
    return new ServerPluginError(message, {
        code: 'HTTP_ERROR', status: response.status,
        serverCode: typeof payload?.code === 'string' ? payload.code : undefined,
        responseFormat: data === undefined ? 'non-json' : 'json',
        details: payload?.details,
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
            throw new ServerPluginError('后端插件返回了非 JSON 响应。', {
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
            throw new ServerPluginError('等待后端插件响应超时。', { code: 'TIMEOUT', cause: error });
        }
        throw new ServerPluginError('后端插件不可用。', { code: 'UNAVAILABLE', cause: error });
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
        if (!response.ok) throw await readHttpError(response);
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            controller.abort();
            throw new ServerPluginError('后端日志响应超过大小上限。', {
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
                        throw new ServerPluginError('后端日志响应超过大小上限。', {
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
                    throw new ServerPluginError('后端日志响应超过大小上限。', {
                        code: 'LOG_TOO_LARGE',
                        status: response.status,
                    });
                }
            }
        } catch (cause) {
            if (cause?.name === 'AbortError') throw cause;
            if (cause instanceof ServerPluginError) throw cause;
            throw new ServerPluginError('后端插件返回了无效的文本响应。', {
                code: 'INVALID_LOG_RESPONSE',
                status: response.status,
                cause,
            });
        }
        const contentType = response.headers?.get?.('content-type');
        if (contentType && !contentTypePattern.test(contentType)) {
            throw new ServerPluginError('后端日志响应的内容类型无效。', {
                code: 'INVALID_LOG_RESPONSE',
                status: response.status,
            });
        }
        return data;
    } catch (error) {
        if (error instanceof ServerPluginError) throw error;
        if (error?.name === 'AbortError') {
            throw new ServerPluginError('等待后端插件响应超时。', { code: 'TIMEOUT', cause: error });
        }
        throw new ServerPluginError('后端插件不可用。', { code: 'UNAVAILABLE', cause: error });
    } finally {
        clearTimeout(timeout);
    }
}

async function sendWithoutBody(fetchImpl, url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        if (!response.ok) throw await readHttpError(response);
    } catch (error) {
        if (error instanceof ServerPluginError) throw error;
        if (error?.name === 'AbortError') {
            throw new ServerPluginError('等待后端插件响应超时。', { code: 'TIMEOUT', cause: error });
        }
        throw new ServerPluginError('后端插件不可用。', { code: 'UNAVAILABLE', cause: error });
    } finally {
        clearTimeout(timeout);
    }
}

function validateHandshake(data) {
    if (data?.ok !== true || data?.pluginId !== EXTENSION_ID || data?.protocolVersion !== PROTOCOL_VERSION) {
        throw new ServerPluginError(`需要后端插件协议 v${PROTOCOL_VERSION}。`, {
            code: 'PROTOCOL_MISMATCH',
        });
    }
    if (data.transport !== REQUIRED_TRANSPORT) {
        throw new ServerPluginError(`需要后端传输方式“${REQUIRED_TRANSPORT}”。`, {
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
    catch { throw new ServerPluginError('提示词快照响应无效。', { code: 'INVALID_INSPECTOR_RESPONSE' }); }
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

export function createServerClient({ fetchImpl = globalThis.fetch, getRequestHeaders = () => ({}), localize = createLocalizer() } = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('当前环境缺少 fetch 请求接口。');
    }

    const client = {
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
                throw new ServerPluginError('后端凭证与代理地址不匹配。', {
                    code: 'INVALID_PROXY_TICKET',
                });
            }
            if (typeof data.proxySecret !== 'string' || data.proxySecret.length < 16) {
                throw new ServerPluginError('后端插件返回了无效的代理密钥。', {
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
                throw new ServerPluginError('后端插件返回的更新检查结果无效。', { code: 'INVALID_UPDATE_RESPONSE' });
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
                throw new ServerPluginError('后端插件未能启动更新。', { code: 'INVALID_UPDATE_RESPONSE' });
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
                throw new ServerPluginError('后端插件返回的更新状态无效。', { code: 'INVALID_UPDATE_RESPONSE' });
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

        async readBillingSettings() {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.BILLING_SETTINGS, {
                method: 'GET', headers: { ...getRequestHeaders(), Accept: 'application/json' }, cache: 'no-store',
            }, HEALTH_TIMEOUT_MS);
            if (data?.ok !== true || !data.settings || typeof data.settings !== 'object') throw new ServerPluginError(localize('vertex_paygo.billing.error_settings_invalid'), { code: 'INVALID_BILLING_RESPONSE' });
            return data.settings;
        },
        async saveBillingSettings(settings) {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.BILLING_SETTINGS, {
                method: 'POST', headers: { ...getRequestHeaders(), Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(settings), cache: 'no-store',
            }, HEALTH_TIMEOUT_MS);
            if (data?.ok !== true || !data.settings) throw new ServerPluginError(localize('vertex_paygo.billing.error_settings_invalid'), { code: 'INVALID_BILLING_RESPONSE' });
            return data.settings;
        },
        async readBilling(query) {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.BILLING_QUERY, {
                method: 'POST', headers: { ...getRequestHeaders(), Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(query), cache: 'no-store',
            }, 90_000);
            if (data?.ok !== true || data.kind !== 'billing-export' || !Array.isArray(data.rows)) throw new ServerPluginError(localize('vertex_paygo.billing.error_response'), { code: 'INVALID_BILLING_RESPONSE' });
            return data;
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
                throw new TypeError('原生请求需要有效的记录范围和提示词查看凭证。');
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
            if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(ticket)) throw new TypeError('缺少原生请求转发凭证。');
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
        async readUsage(chatId, { includeRequestPreviews = false, latest, ids } = {}) {
            if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) {
                throw new TypeError('需要有效的对话用量 ID。');
            }
            if (latest !== undefined && (includeRequestPreviews !== true || !Number.isSafeInteger(latest) || latest < 1 || latest > 50)) {
                throw new TypeError('读取最近请求预览时需要明确的数量限制。');
            }
            if (ids !== undefined && (!Array.isArray(ids) || latest !== undefined
                || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))) {
                throw new TypeError('需要有效的用量记录 ID 列表。');
            }
            const wanted = ids === undefined ? null : new Set(ids);
            if (wanted?.size === 0) return { ok: true, records: [], truncated: false };
            const batches = wanted ? Array.from(wanted).reduce((result, id, index) => {
                if (index % 100 === 0) result.push([]);
                result.at(-1).push(id); return result;
            }, []) : [null];
            const previewSuffix = includeRequestPreviews === true ? `&includeRequestPreviews=1${latest === undefined ? '' : `&latest=${latest}`}` : '';
            const records = [];
            let truncated = false;
            for (const batch of batches) {
                const cursors = new Set();
                let cursor, lookup = false;
                const idSuffix = batch ? '&ids=' + encodeURIComponent(batch.join(',')) : '';
                do {
                    const suffix = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`;
                    const data = await fetchJson(fetchImpl, `${SERVER_ROUTES.USAGE}?chatId=${encodeURIComponent(chatId)}${previewSuffix}${idSuffix}${suffix}`, {
                        method: 'GET',
                        headers: { ...getRequestHeaders(), Accept: 'application/json' },
                        cache: 'no-store',
                    }, LOG_TIMEOUT_MS);
                    if (data?.ok !== true || !Array.isArray(data.records)) {
                        throw new ServerPluginError('用量记录响应无效。', { code: 'INVALID_USAGE_RESPONSE' });
                    }
                    lookup ||= data.lookup === true;
                    for (const record of data.records) if (!wanted || wanted.has(record?.id)) records.push(record);
                    cursor = data.nextCursor ?? undefined;
                    // All fetched pages together form the complete ledger.
                    truncated ||= data.truncated === true && cursor === undefined;
                    if (cursor !== undefined) {
                        if (typeof cursor !== 'string' || cursor.length > 256 || !cursor || cursors.has(cursor)) {
                            throw new ServerPluginError('用量记录的分页游标无效。', { code: 'INVALID_USAGE_RESPONSE' });
                        }
                        cursors.add(cursor);
                    }
                } while (cursor !== undefined);
                // Older servers ignore ids and return the full paginated ledger.
                // That first scan already resolves every requested ID.
                if (wanted && !lookup) break;
            }
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
    if (typeof localize === 'function') for (const [name, method] of Object.entries(client)) {
        client[name] = async (...args) => {
            try { return await method.apply(client, args); }
            catch (error) {
                if (error instanceof ServerPluginError) {
                    error.message = localizeError(localize, error);
                    error.localized = true;
                }
                throw error;
            }
        };
    }
    return client;
}
