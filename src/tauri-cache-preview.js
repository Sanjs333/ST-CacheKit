/* Body-free Tauri frontend request summaries; SPDX-License-Identifier: MPL-2.0 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONTENTS = 64;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (reason, bodyBytes = null) => ({ version: 1, status: 'unavailable', reason, bodyBytes });
const roleOf = role => role === 'assistant' ? 'model' : role === 'developer' ? 'system'
    : ['system', 'user', 'model', 'tool'].includes(role) ? role : 'unknown';

function explicitCache(data, yaml) {
    let unknown = false;
    const containers = [data, object(data.parameters) ? data.parameters : null].filter(Boolean);
    for (const container of containers) {
        if (typeof (container.cachedContent ?? container.cached_content) === 'string') return 'explicit';
        for (const key of ['custom_include_body', 'include_body', 'customIncludeBody']) {
            let extra = container[key];
            if (extra == null || extra === '') continue;
            if (typeof extra === 'string') {
                try { extra = yaml?.parse?.(extra); } catch { extra = null; }
                if (!object(extra)) { unknown = true; continue; }
            }
            if (!object(extra)) { unknown = true; continue; }
            if (typeof (extra.cachedContent ?? extra.cached_content) === 'string') return 'explicit';
        }
    }
    return unknown ? 'unknown' : 'implicit';
}

export function createTauriCachePreview({ cryptoRef = globalThis.crypto, yaml } = {}) {
    const encoder = new TextEncoder();
    let epoch = null, key;
    try { epoch = cryptoRef?.randomUUID?.() ?? null; } catch {}
    if (!epoch && typeof cryptoRef?.getRandomValues === 'function') {
        try { epoch = Array.from(cryptoRef.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); } catch {}
    }
    const fingerprint = async value => {
        key ??= cryptoRef.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const signed = await cryptoRef.subtle.sign('HMAC', await key,
            encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)));
        return Array.from(new Uint8Array(signed), byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const describe = async (messages, role, useNative = true) => {
        const kinds = {};
        const textSegments = [];
        let partCount = 0, textChars = 0, textBytes = 0, thoughtParts = 0, signedParts = 0, omittedTextSegments = 0;
        for (const message of messages) {
            const nativeParts = useNative ? message.native?.gemini?.content?.parts : null;
            const parts = Array.isArray(nativeParts) ? nativeParts : Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content
                : typeof message.content === 'string' ? [{ text: message.content }] : [];
            for (const part of parts) {
                partCount++;
                const kind = typeof part?.text === 'string' ? 'text'
                    : part?.inlineData || part?.type === 'image_url' ? 'inlineData'
                        : part?.fileData ? 'fileData' : part?.functionCall ? 'functionCall'
                            : part?.functionResponse ? 'functionResponse' : 'other';
                kinds[kind] = (kinds[kind] ?? 0) + 1;
                if (typeof part?.text === 'string') {
                    textChars += part.text.length; textBytes += encoder.encode(part.text).byteLength;
                    if (textSegments.length < MAX_CONTENTS) textSegments.push({ part: partCount,
                        textChars: part.text.length, fingerprint: await fingerprint(part.text) });
                    else omittedTextSegments++;
                }
                if (part?.thought === true || part?.type === 'reasoning') thoughtParts++;
                if (typeof part?.thoughtSignature === 'string' || typeof part?.signature === 'string') signedParts++;
            }
            if (!Array.isArray(nativeParts) && Array.isArray(message.tool_calls)) {
                partCount += message.tool_calls.length;
                kinds.functionCall = (kinds.functionCall ?? 0) + message.tool_calls.length;
            }
        }
        return { role, partCount, textChars, textBytes, kinds, thoughtParts, signedParts,
            textSegments, omittedTextSegments, fingerprint: await fingerprint(messages) };
    };
    return async raw => {
        if (typeof raw !== 'string') return unavailable('BODY_UNAVAILABLE');
        // UTF-8 needs at least one byte per UTF-16 code unit for valid JSON.
        if (raw.length > MAX_BODY_BYTES) return unavailable('BODY_TOO_LARGE');
        const bodyBytes = encoder.encode(raw).byteLength;
        if (bodyBytes > MAX_BODY_BYTES) return unavailable('BODY_TOO_LARGE', bodyBytes);
        if (!epoch || !cryptoRef?.subtle) return unavailable('FINGERPRINT_UNAVAILABLE', bodyBytes);
        let data;
        try { data = JSON.parse(raw); } catch { return unavailable('INVALID_OR_UNSUPPORTED_JSON', bodyBytes); }
        if (!object(data) || !Array.isArray(data.messages) || data.messages.some(message => !object(message))) {
            return unavailable('UNSUPPORTED_GOOGLE_SHAPE', bodyBytes);
        }
        try {
            let leadingSystems = 0;
            // Match the native Google converter's extraction gate. These are
            // frontend messages; later native conversion remains unobserved.
            const model = typeof data.model === 'string' ? data.model : '';
            const imageModels = ['gemini-2.0-flash-exp', 'gemini-2.0-flash-exp-image-generation',
                'gemini-2.0-flash-preview-image-generation', 'gemini-2.5-flash-image-preview',
                'gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-image'];
            const useSystemPrompt = data.use_sysprompt === true && !model.includes('gemma-3')
                && !(data.request_images === true && imageModels.includes(model));
            if (useSystemPrompt) while (leadingSystems < data.messages.length - 1
                && String(data.messages[leadingSystems].role ?? '').trim().toLowerCase() === 'system') leadingSystems++;
            const messages = data.messages.slice(leadingSystems);
            const parameters = { ...data };
            delete parameters.messages;
            for (const key of Object.keys(parameters)) if (key.startsWith('__vertexPayGo')) delete parameters[key];
            const generation = {};
            for (const [target, source] of [['maxOutputTokens', 'max_tokens'], ['temperature', 'temperature'],
                ['topP', 'top_p'], ['topK', 'top_k'], ['candidateCount', 'candidate_count'], ['seed', 'seed']]) {
                if (typeof data[source] === 'number' && Number.isFinite(data[source])) generation[target] = data[source];
            }
            const cacheMode = explicitCache(data, yaml);
            return { version: 1, status: 'available', captureKind: 'tauri-frontend', cacheMode, bodyBytes, epoch,
                bodyFingerprint: await fingerprint(raw), parametersFingerprint: await fingerprint(parameters),
                systemInstruction: leadingSystems ? await describe(data.messages.slice(0, leadingSystems), 'system', false) : null,
                contentCount: messages.length, contents: await Promise.all(messages.slice(0, MAX_CONTENTS)
                    .map(message => describe([message], roleOf(message.role)))),
                omittedContents: Math.max(0, messages.length - MAX_CONTENTS), generation,
                toolCount: Array.isArray(data.tools) ? data.tools.length : 0,
                hasExplicitCache: cacheMode === 'explicit', hasContinuationToken: false,
                serviceTier: null };
        } catch { return unavailable('FINGERPRINT_UNAVAILABLE', bodyBytes); }
    };
}
