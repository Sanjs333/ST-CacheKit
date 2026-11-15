/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

import { isGoogleSource } from './constants.js';
import { localizePluginErrorMessage } from './i18n.js';

export const GEMINI4_MODELS = Object.freeze(['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-argon-cyber-permissive']);
export const GEMINI4_MODEL_LIMIT = 1048576;
export const isGemini4Model = model => GEMINI4_MODELS.includes(model);
export const GEMINI4_NATIVE_ROUTE = '/api/plugins/vertex-paygo/native-gemini/generate';

// Older servers advertise no model list and support only Argon.
const LEGACY_SERVER_MODELS = Object.freeze(['gemini-4-argon', 'gemini-4-argon-cyber-permissive']);

export function serverSupportsNativeGemini4(prepared, model) {
    if (prepared?.nativeGemini4 !== true) return false;
    const models = Array.isArray(prepared.nativeGemini4Models) ? prepared.nativeGemini4Models : LEGACY_SERVER_MODELS;
    return models.includes(model);
}

export async function enrichGemini4ModelList(response) {
    if (!response?.ok || typeof response.clone !== 'function') return response;
    let data;
    try { data = await response.clone().json(); } catch { return response; }
    if (!Array.isArray(data?.data)) return response;
    for (const id of GEMINI4_MODELS) {
        let record = data.data.find(record => record.id === id);
        if (!record) data.data.push(record = { id });
        record.inputTokenLimit ??= GEMINI4_MODEL_LIMIT;
        record.outputTokenLimit ??= GEMINI4_MODEL_LIMIT;
    }
    return rebuildResponse(response, JSON.stringify(data));
}

const ERROR_KEYS = {
    GEMINI4_OUTPUT_BUDGET_EXHAUSTED: () => ['vertex_paygo.gemini4.budget_exhausted', {}],
    NATIVE_GEMINI_EMPTY_RESPONSE: details => ['vertex_paygo.gemini4.no_output', { reason: details.reason ?? 'UNKNOWN' }],
};

function localizeError(error, localize) {
    if (!error || typeof error !== 'object') return null;
    const entry = Object.hasOwn(ERROR_KEYS, error.code)
        ? ERROR_KEYS[error.code](error.details && typeof error.details === 'object' ? error.details : {}) : null;
    if (entry) return { ...error, message: localize(...entry) };
    const message = localizePluginErrorMessage(localize, error);
    return message ? { ...error, message } : null;
}

function localizeErrorPayload(data, localize) {
    if (!data || typeof data !== 'object') return null;
    if (data.error === true) return localizeError(data, localize);
    const error = localizeError(data.error, localize);
    return error ? { ...data, error, message: error.message } : null;
}

function rebuildResponse(response, body) {
    const headers = new Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'etag']) headers.delete(name);
    const result = new Response(body, { status: response.status, statusText: response.statusText, headers });
    for (const key of ['url', 'redirected', 'type']) Object.defineProperty(result, key, { value: response[key] });
    return result;
}

/**
 * The host shows data.error.message from failed responses and SSE events
 * verbatim. Localize plugin errors in both nested and flat response bodies.
 */
export async function localizeGemini4Response(response, localize) {
    if (typeof localize !== 'function' || !response) return response;
    if (!response.ok) {
        let data;
        try { data = await response.clone().json(); } catch { return response; }
        const localized = localizeErrorPayload(data, localize);
        return localized ? rebuildResponse(response, JSON.stringify(localized)) : response;
    }
    if (!response.body || !/^text\/event-stream/iu.test(response.headers.get('content-type') ?? '')) return response;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const rewrite = frame => {
        const lines = frame.split(/\r?\n/u);
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data.trimStart().startsWith('{') || !data.includes('"error"')) return frame;
        try {
            const parsed = JSON.parse(data);
            const localized = localizeErrorPayload(parsed, localize);
            if (!localized) return frame;
            let written = false;
            return lines.flatMap(line => {
                if (!line.startsWith('data:')) return [line];
                if (written) return [];
                written = true;
                return [`data: ${JSON.stringify(localized)}`];
            }).join(frame.includes('\r\n') ? '\r\n' : '\n');
        } catch { return frame; }
    };
    return rebuildResponse(response, response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            for (;;) {
                const separator = /\r?\n\r?\n/u.exec(buffer);
                if (!separator) break;
                const frame = buffer.slice(0, separator.index);
                buffer = buffer.slice(separator.index + separator[0].length);
                controller.enqueue(encoder.encode(rewrite(frame) + separator[0]));
            }
        },
        flush(controller) {
            buffer += decoder.decode();
            if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
        },
    })));
}

export function isNativeGemini4Request(data) {
    return isGoogleSource(data?.chat_completion_source)
        && isGemini4Model(data?.model);
}

// Keep Request headers, credentials and cancellation when only its destination
// changes. The caller replaces the body with the final prepared JSON payload.
export function getGemini4RequestTarget(input, origin) {
    const url = new URL(GEMINI4_NATIVE_ROUTE, origin);
    return typeof input?.clone === 'function' ? new Request(url, input) : url.toString();
}
