/* Exact, memory-only prompt normalization. SPDX-License-Identifier: MPL-2.0. */
import { normalizePromptSources } from './prompt-inspector-sources.js';

// Limits bound analysis, never truncate captured strings or reconstruct them.
export const PROMPT_INSPECTOR_MODEL_LIMITS = Object.freeze({
    parseCodeUnits: 8 * 1024 * 1024,
    matchWork: 32 * 1024 * 1024,
    segmentLabels: 128000,
    comparisonCells: 40000,
    comparisonKeyCodeUnits: 4 * 1024 * 1024,
    textScanCodeUnits: 1024 * 1024,
    comparisonTextPairs: 256,
    stageComparisons: 32,
    contentDepth: 64,
});

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const warning = (context, code) => context.warnings.add(code);
const childPath = (path, key) => /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
const unknownSegments = text => text.length ? [{ start: 0, end: text.length, sourceIds: [], verified: false }] : [];

function textPart(text, path, raw, type = 'text') {
    return { type, path, text, segments: unknownSegments(text), raw };
}

function unknownPart(raw, path, context, reason = 'unknown-content') {
    context.complete = false;
    warning(context, reason);
    return { type: 'unknown', path, raw, reason };
}

function contentParts(content, path, context, depth = 0) {
    if (depth > PROMPT_INSPECTOR_MODEL_LIMITS.contentDepth) {
        return [unknownPart(content, path, context, 'content-depth-limit')];
    }
    if (typeof content === 'string') return [textPart(content, path, content)];
    if (content === null) return [{ type: 'null', path, raw: null }];
    if (!Array.isArray(content)) return [blockPart(content, path, context, depth)];
    return content.map((part, index) => blockPart(part, `${path}[${index}]`, context, depth));
}

function blockPart(block, path, context, depth = 0) {
    if (typeof block === 'string') return textPart(block, path, block);
    if (!object(block)) return unknownPart(block, path, context);
    if (depth > PROMPT_INSPECTOR_MODEL_LIMITS.contentDepth) {
        return unknownPart(block, path, context, 'content-depth-limit');
    }
    if (own(block, 'type') && typeof block.type !== 'string') return unknownPart(block, path, context, 'invalid-content-type');
    const nativeType = typeof block.type === 'string' ? block.type : null;
    const payloadKeys = ['text', 'inlineData', 'inline_data', 'fileData', 'file_data', 'functionCall',
        'function_call', 'functionResponse', 'function_response', 'executableCode', 'codeExecutionResult'];
    if (payloadKeys.filter(key => own(block, key)).length > 1) {
        return unknownPart(block, path, context, 'compound-content-raw-backed');
    }
    const result = (type, extra = {}) => ({ type, path, raw: block, originalType: nativeType, ...extra });
    if (nativeType === 'text' || nativeType === 'input_text' || nativeType === 'output_text'
        || (!nativeType && own(block, 'text'))) {
        if (typeof block.text !== 'string') return unknownPart(block, path, context, 'invalid-text-content');
        const part = textPart(block.text, path, block, block.thought === true ? 'thought' : 'text');
        part.originalType = nativeType;
        if (own(block, 'thought')) part.thought = block.thought;
        if (own(block, 'thoughtSignature')) part.thoughtSignature = block.thoughtSignature;
        return part;
    }
    if (nativeType === 'thinking' || nativeType === 'reasoning' || nativeType === 'thought') {
        const text = typeof block.thinking === 'string' ? block.thinking : block.text;
        if (typeof text === 'string') return { ...textPart(text, path, block, 'thought'), originalType: nativeType };
        return unknownPart(block, path, context, 'unsupported-thought-content');
    }
    if (nativeType === 'redacted_thinking') return result('thought', { redacted: true });
    if (nativeType === 'refusal') {
        if (typeof block.refusal === 'string') return { ...textPart(block.refusal, path, block, 'refusal'), originalType: nativeType };
        return unknownPart(block, path, context, 'invalid-refusal-content');
    }
    if (['image', 'image_url', 'input_image'].includes(nativeType)) return result('image');
    if (['audio', 'input_audio', 'output_audio'].includes(nativeType)) return result('audio');
    if (['video', 'video_url', 'input_video'].includes(nativeType)) return result('video');
    if (['file', 'document', 'input_file'].includes(nativeType)) return result('file');
    if (['tool_use', 'server_tool_use', 'tool_call', 'function_call'].includes(nativeType)) return result('tool_call');
    if (nativeType === 'tool_result' || nativeType === 'function_response') {
        const part = result('tool_result');
        if (own(block, 'content')) part.parts = contentParts(block.content, childPath(path, 'content'), context, depth + 1);
        return part;
    }
    // Gemini parts have no type discriminator. Preserve each original part,
    // including thought flags/signatures, without evaluating URLs or tool input.
    if (!nativeType) {
        if (own(block, 'inlineData') || own(block, 'inline_data')) {
            const data = block.inlineData ?? block.inline_data;
            const mime = object(data) ? (data.mimeType ?? data.mime_type) : null;
            const type = typeof mime === 'string' && mime.startsWith('image/') ? 'image'
                : typeof mime === 'string' && mime.startsWith('audio/') ? 'audio'
                    : typeof mime === 'string' && mime.startsWith('video/') ? 'video' : 'media';
            return result(type);
        }
        if (own(block, 'fileData') || own(block, 'file_data')) return result('file');
        if (own(block, 'functionCall') || own(block, 'function_call')) return result('tool_call');
        if (own(block, 'functionResponse') || own(block, 'function_response')) return result('tool_result');
        if (own(block, 'executableCode')) return result('code');
        if (own(block, 'codeExecutionResult')) return result('code_result');
        if (own(block, 'thoughtSignature') || own(block, 'thought_signature')) return result('thought');
    }
    return unknownPart(block, path, context);
}

function normalizeMessage(raw, path, context, defaultRole = null) {
    const id = path;
    if (!object(raw)) {
        return { id, path, role: defaultRole ?? 'unknown', parts: [unknownPart(raw, path, context, 'unknown-message')], raw };
    }
    const role = typeof raw.role === 'string' ? raw.role : defaultRole ?? 'unknown';
    if ((role === 'unknown' && typeof raw.role !== 'string' && defaultRole === null) || role === '') {
        context.complete = false;
        warning(context, 'missing-message-role');
    }
    const parts = [];
    const fields = {};
    let found = false;
    // Object field order matters for auxiliary parts; array order is untouched.
    for (const key of Object.keys(raw)) {
        const partPath = childPath(path, key);
        if (key === 'content' || key === 'parts') {
            found = true;
            for (const part of contentParts(raw[key], partPath, context)) parts.push(part);
        } else if (key === 'tool_calls') {
            found = true;
            if (Array.isArray(raw[key])) {
                raw[key].forEach((call, index) => parts.push(object(call)
                    ? { type: 'tool_call', path: `${partPath}[${index}]`, raw: call, originalType: call.type ?? null }
                    : unknownPart(call, `${partPath}[${index}]`, context, 'invalid-tool-call')));
            } else parts.push(unknownPart(raw[key], partPath, context, 'invalid-tool-calls'));
        } else if (key === 'function_call') {
            found = true;
            parts.push(object(raw[key]) ? { type: 'tool_call', path: partPath, raw: raw[key], originalType: 'function_call' }
                : unknownPart(raw[key], partPath, context, 'invalid-tool-call'));
        } else if (key === 'reasoning_content' || key === 'thinking' || key === 'refusal') {
            found = true;
            parts.push(typeof raw[key] === 'string'
                ? textPart(raw[key], partPath, raw[key], key === 'refusal' ? 'refusal' : 'thought')
                : raw[key] === null ? { type: 'null', path: partPath, raw: null }
                    : unknownPart(raw[key], partPath, context));
        } else if (key === 'audio') {
            found = true;
            parts.push({ type: raw[key] === null ? 'null' : 'audio', path: partPath, raw: raw[key] });
        } else if (key !== 'role') {
            Object.defineProperty(fields, key, { value: raw[key], enumerable: true, configurable: true, writable: true });
        }
    }
    if (!found) parts.push(unknownPart(raw, path, context, 'missing-message-content'));
    return { id, path, role, parts, fields, raw };
}

function systemMessage(raw, path, context) {
    if (typeof raw === 'string' || Array.isArray(raw)) {
        return { id: path, path, role: 'system', parts: contentParts(raw, path, context), raw };
    }
    return normalizeMessage(raw, path, context, 'system');
}

function fieldMessage(raw, path, context) {
    // A top-level prompt/input/instructions field has no recorded message role.
    const parts = typeof raw === 'string' ? [textPart(raw, path, raw)]
        : raw === null ? [{ type: 'null', path, raw: null }]
            : [unknownPart(raw, path, context, 'unsupported-request-field')];
    return { id: path, path, role: 'unknown', parts, raw };
}

function completionPrompts(raw, path, context) {
    return Array.isArray(raw) && raw.every(value => typeof value === 'string')
        ? raw.map((value, index) => fieldMessage(value, `${path}[${index}]`, context))
        : [fieldMessage(raw, path, context)];
}

function responseInputs(raw, path, context) {
    if (typeof raw === 'string') return [fieldMessage(raw, path, context)];
    if (!Array.isArray(raw)) return [{ id: path, path, role: 'unknown',
        parts: [unknownPart(raw, path, context, 'unsupported-responses-input')], raw }];
    return raw.map((value, index) => {
        const itemPath = `${path}[${index}]`;
        if (object(value) && typeof value.role === 'string' && own(value, 'content')
            && (!own(value, 'type') || value.type === 'message')) return normalizeMessage(value, itemPath, context);
        return { id: itemPath, path: itemPath, role: 'unknown',
            parts: [unknownPart(value, itemPath, context, 'unsupported-responses-input-item')], raw: value };
    });
}

function normalizePayload(payload, context) {
    if (!object(payload)) return fallbackMessages(payload, context, 'unknown-request-shape');
    const messages = [];
    let format = 'unknown';
    const consumed = new Set();
    const gemini = ['contents', 'systemInstruction', 'system_instruction'].some(key => own(payload, key));
    const frontendMessages = context.frontendMessages && Array.isArray(payload.messages);
    if (!frontendMessages && [gemini, own(payload, 'messages'), own(payload, 'prompt'), own(payload, 'input')].filter(Boolean).length > 1) {
        return fallbackMessages(payload, context, 'mixed-request-shape');
    }
    if (!frontendMessages && (own(payload, 'contents') || own(payload, 'systemInstruction') || own(payload, 'system_instruction'))) {
        format = 'gemini';
        for (const key of ['systemInstruction', 'system_instruction']) {
            if (own(payload, key)) {
                consumed.add(key);
                messages.push(systemMessage(payload[key], childPath('$', key), context));
            }
        }
        if (own(payload, 'contents')) {
            consumed.add('contents');
            if (Array.isArray(payload.contents)) {
                payload.contents.forEach((message, index) => messages.push(normalizeMessage(message, `$.contents[${index}]`, context)));
            } else messages.push({ id: '$.contents', path: '$.contents', role: 'unknown',
                parts: [unknownPart(payload.contents, '$.contents', context, 'invalid-contents')], raw: payload.contents });
        }
    } else if (own(payload, 'messages')) {
        format = context.source === 'claude' || own(payload, 'system') ? 'anthropic' : 'openai';
        if (own(payload, 'system')) {
            consumed.add('system');
            messages.push(systemMessage(payload.system, '$.system', context));
        }
        consumed.add('messages');
        if (Array.isArray(payload.messages)) {
            payload.messages.forEach((message, index) => messages.push(normalizeMessage(message, `$.messages[${index}]`, context)));
        } else messages.push({ id: '$.messages', path: '$.messages', role: 'unknown',
            parts: [unknownPart(payload.messages, '$.messages', context, 'invalid-messages')], raw: payload.messages });
    } else if (own(payload, 'prompt')) {
        format = 'openai-completions'; consumed.add('prompt');
        messages.push(...completionPrompts(payload.prompt, '$.prompt', context));
    } else if (own(payload, 'input')) {
        format = 'openai-responses'; consumed.add('input');
        if (own(payload, 'instructions')) {
            consumed.add('instructions'); messages.push(fieldMessage(payload.instructions, '$.instructions', context));
        }
        messages.push(...responseInputs(payload.input, '$.input', context));
    } else return fallbackMessages(payload, context, 'unknown-request-shape');
    if (!messages.length || !messages.some(message => message.parts.length)) {
        messages.push(...fallbackMessages(payload, context, 'empty-final-messages').messages);
    }
    const requestFields = Object.fromEntries(Object.keys(payload).filter(key => !consumed.has(key)).map(key => [key, payload[key]]));
    return { messages, format, requestFields };
}

function fallbackMessages(raw, context, reason) {
    return { messages: [{ id: '$', path: '$', role: 'unknown', parts: [unknownPart(raw, '$', context, reason)], raw }],
        format: 'unknown', requestFields: {} };
}

function prepareSources(trace, context) {
    if (!Array.isArray(trace?.sources)) {
        if (trace && own(trace, 'sources')) warning(context, 'invalid-trace-sources');
        return [];
    }
    const capturedSources = normalizePromptSources(trace.sources);
    const idCounts = new Map();
    for (const source of capturedSources) {
        if (object(source) && typeof source.id === 'string' && source.id.length) {
            idCounts.set(source.id, (idCounts.get(source.id) ?? 0) + 1);
        }
    }
    return capturedSources.map((raw, index) => {
        const source = object(raw) ? { ...raw } : { raw };
        source.index = index;
        source.id = typeof source.id === 'string' && source.id.length ? source.id : null;
        const valid = source.id !== null && idCounts.get(source.id) === 1 && typeof source.text === 'string';
        source.status = valid ? source.text.length ? 'unmatched' : 'empty' : 'invalid';
        source.matches = [];
        source.matchCount = 0;
        if (!valid) warning(context, 'invalid-or-duplicate-source');
        if (typeof source.kind === 'string' && source.kind.startsWith('worldinfo-')
            && [2, 3, 4, '2', '3', '4'].includes(source.position)) {
            source.originalKind = source.kind;
            source.kind = 'worldinfo-depth';
        }
        return source;
    });
}

function textLeaves(messages) {
    const leaves = [];
    function visit(parts, message) {
        for (const part of parts) {
            if (typeof part.text === 'string') leaves.push({ part, message });
            if (Array.isArray(part.parts)) visit(part.parts, message);
        }
    }
    for (const message of messages) visit(message.parts, message);
    return leaves;
}

// Exact textual matches cannot establish provenance for opaque media/tool data.
// Make that explicit rather than treating a text-free display as fully sourced.
function markOpaqueProvenance(messages) {
    let unknown = false;
    function visit(parts) {
        for (const part of parts) {
            if (typeof part.text !== 'string') {
                part.sourceIds = []; part.verified = false; unknown = true;
            }
            if (Array.isArray(part.parts)) visit(part.parts);
        }
    }
    for (const message of messages) visit(message.parts);
    return unknown;
}

function annotateSources(messages, sources, budget, context) {
    const leaves = textLeaves(messages);
    const total = leaves.reduce((length, leaf) => length + leaf.part.text.length, 0);
    const byText = new Map();
    for (const source of sources) {
        if (typeof source.text !== 'string' || !source.text.length) continue;
        const group = byText.get(source.text) ?? [];
        group.push(source);
        byText.set(source.text, group);
    }
    const ranges = new Map();
    for (const [text, group] of byText) {
        if (group.length !== 1) {
            group.forEach(source => { if (source.status !== 'invalid') source.status = 'ambiguous'; source.reason = 'duplicate-source-text'; });
            warning(context, 'ambiguous-source-match');
            continue;
        }
        const source = group[0];
        if (source.status === 'invalid') continue;
        if (2 * total + text.length > budget.remaining) {
            source.status = 'bounded';
            source.reason = 'source-match-work-limit';
            warning(context, 'source-match-work-limit');
            continue;
        }
        budget.remaining -= 2 * total + text.length;
        const hits = [];
        for (const leaf of leaves) {
            const first = leaf.part.text.indexOf(text);
            if (first < 0) continue;
            hits.push({ leaf, start: first, end: first + text.length });
            // Count overlapping occurrences too (e.g. "aaa" in "aaaa").
            if (leaf.part.text.indexOf(text, first + 1) >= 0 || hits.length > 1) {
                hits.push(null);
                break;
            }
        }
        source.matchCount = Math.min(hits.length, 2);
        if (hits.length !== 1) {
            source.status = hits.length ? 'ambiguous' : 'unmatched';
            source.reason = hits.length ? 'multiple-final-occurrences' : 'no-exact-match';
            if (hits.length) warning(context, 'ambiguous-source-match');
            continue;
        }
        const hit = hits[0];
        source.status = 'matched';
        source.matches = [{ messageId: hit.leaf.message.id, messagePath: hit.leaf.message.path,
            partPath: hit.leaf.part.path, start: hit.start, end: hit.end, verified: true }];
        const list = ranges.get(hit.leaf.part) ?? [];
        list.push({ start: hit.start, end: hit.end, sourceId: source.id });
        ranges.set(hit.leaf.part, list);
    }
    // Sweep interval boundaries into a non-overlapping, exact partition. Labels
    // can merge at overlaps, but actual text is never copied or reordered.
    for (const { part } of leaves) {
        const list = ranges.get(part) ?? [];
        if (!list.length) continue;
        const events = new Map();
        for (const range of list) {
            for (const [offset, add] of [[range.start, true], [range.end, false]]) {
                const event = events.get(offset) ?? [];
                event.push({ id: range.sourceId, add });
                events.set(offset, event);
            }
        }
        const boundaries = [...new Set([0, part.text.length, ...events.keys()])].sort((a, b) => a - b);
        const active = new Set();
        const segments = [];
        let labelWork = 0, annotationBounded = false;
        for (let index = 0; index < boundaries.length - 1; index++) {
            const start = boundaries[index], end = boundaries[index + 1];
            for (const event of events.get(start) ?? []) {
                if (event.add) active.add(event.id); else active.delete(event.id);
            }
            labelWork += active.size;
            if (labelWork > budget.labelsRemaining) { annotationBounded = true; break; }
            const sourceIds = [...active];
            const last = segments.at(-1);
            if (last && last.verified === Boolean(sourceIds.length)
                && last.sourceIds.length === sourceIds.length && last.sourceIds.every((id, i) => id === sourceIds[i])) last.end = end;
            else segments.push({ start, end, sourceIds, verified: sourceIds.length > 0 });
        }
        if (annotationBounded) {
            const ids = new Set(list.map(range => range.sourceId));
            for (const source of sources) if (ids.has(source.id)) {
                source.status = 'bounded'; source.matches = []; source.reason = 'source-annotation-work-limit';
            }
            warning(context, 'source-annotation-work-limit');
        } else { budget.labelsRemaining -= labelWork; part.segments = segments; }
    }
}

function traceStages(trace, sources, budget, context, reservedId = 'backend-final') {
    if (!Array.isArray(trace?.stages)) {
        if (trace && own(trace, 'stages')) warning(context, 'invalid-trace-stages');
        return [];
    }
    const usedIds = new Set([reservedId]);
    return trace.stages.map((raw, index) => {
        const stageContext = { complete: true, warnings: context.warnings };
        const providedId = object(raw) && typeof raw.id === 'string' ? raw.id : `trace-stage-${index}`;
        // Reserve backend-final and prevent collisions with generated IDs too.
        let id = providedId;
        if (usedIds.has(id)) {
            warning(context, 'duplicate-or-reserved-stage-id');
            id = `trace:${providedId}:${index}`;
            while (usedIds.has(id)) id += ':trace';
        }
        usedIds.add(id);
        const path = `$.trace.stages[${index}].messages`;
        const messages = object(raw) && Array.isArray(raw.messages)
            ? raw.messages.flatMap((message, messageIndex) => {
                const itemPath = `${path}[${messageIndex}]`, keys = object(message) ? Object.keys(message) : [];
                const field = providedId === 'backend-final' && keys.length === 1 ? keys[0] : null;
                if (field === 'prompt') return completionPrompts(message.prompt, childPath(itemPath, field), stageContext);
                if (field === 'input') return responseInputs(message.input, childPath(itemPath, field), stageContext);
                if (field === 'instructions') return [fieldMessage(message.instructions, childPath(itemPath, field), stageContext)];
                return [normalizeMessage(message, itemPath, stageContext)];
            })
            : [{ id: path, path, role: 'unknown', parts: [unknownPart(raw, path, stageContext, 'invalid-trace-stage')], raw }];
        markOpaqueProvenance(messages);
        const candidates = sources.map(source => ({ ...source, matches: [], matchCount: 0 }));
        annotateSources(messages, candidates, budget, stageContext);
        return { id, originalId: providedId, label: object(raw) && typeof raw.label === 'string' ? raw.label : providedId,
            messages, notes: object(raw) && Array.isArray(raw.notes) ? raw.notes : [],
            complete: stageContext.complete, origin: 'trace', raw };
    });
}

function observedEvents(trace, context) {
    if (!Array.isArray(trace?.events)) {
        if (trace && own(trace, 'events')) warning(context, 'invalid-trace-events');
        return [];
    }
    const changes = [];
    trace.events.forEach((event, index) => {
        if (!object(event) || event.evidence !== 'observed') {
            warning(context, 'unverified-trace-event');
            return;
        }
        changes.push({ ...event, id: `event-${index}`, kind: typeof event.kind === 'string' ? event.kind : 'unknown',
            label: typeof event.label === 'string' ? event.label : 'Observed change', evidence: 'observed', origin: 'trace' });
    });
    return changes;
}

function limit(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), fallback) : fallback;
}

function splitsSurrogate(text, offset) {
    return offset > 0 && offset < text.length && text.charCodeAt(offset - 1) >= 0xD800
        && text.charCodeAt(offset - 1) <= 0xDBFF && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF;
}

/**
 * Linear, bounded common-prefix/suffix comparison, not a guessed edit history.
 * UTF-16 offsets refer to exact input. removed/added and segments are never
 * shortened, even when the scan limit forces one whole-text replacement.
 */
export function diffPromptInspectorText(before, after, options = {}) {
    if (typeof before !== 'string' || typeof after !== 'string') throw new TypeError('Text comparisons require strings');
    const maxScan = limit(options.maxScanCodeUnits, PROMPT_INSPECTOR_MODEL_LIMITS.textScanCodeUnits);
    const equal = before === after;
    let prefix = 0, suffix = 0, scanned = 0, bounded = false;
    if (equal) prefix = before.length;
    else {
        while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) {
            if (scanned++ >= maxScan) { bounded = true; break; }
            prefix++;
        }
        if (!bounded) {
            while (suffix < Math.min(before.length, after.length) - prefix
                && before[before.length - suffix - 1] === after[after.length - suffix - 1]) {
                if (scanned++ >= maxScan) { bounded = true; break; }
                suffix++;
            }
        }
        if (bounded) { prefix = 0; suffix = 0; }
        if (splitsSurrogate(before, prefix) || splitsSurrogate(after, prefix)) prefix--;
        if (splitsSurrogate(before, before.length - suffix) || splitsSurrogate(after, after.length - suffix)) suffix--;
    }
    const beforeEnd = before.length - suffix, afterEnd = after.length - suffix;
    const removed = before.slice(prefix, beforeEnd), added = after.slice(prefix, afterEnd);
    const segments = [];
    if (prefix) segments.push({ type: 'equal', text: before.slice(0, prefix) });
    if (removed) segments.push({ type: 'delete', text: removed });
    if (added) segments.push({ type: 'insert', text: added });
    if (suffix) segments.push({ type: 'equal', text: before.slice(beforeEnd) });
    return { equal, bounded, prefix, suffix, before: { text: before, start: prefix, end: beforeEnd },
        after: { text: after, start: prefix, end: afterEnd }, removed, added, segments, scannedCodeUnits: scanned, evidence: 'compared' };
}

function comparisonMessages(stage) {
    if (!Array.isArray(stage?.messages)) return [];
    return stage.messages.map((message, index) => object(message) && typeof message.path === 'string' && Array.isArray(message.parts)
        && message.parts.every(part => object(part) && typeof part.type === 'string' && typeof part.path === 'string')
        ? message : normalizeMessage(message, `$.messages[${index}]`, { complete: true, warnings: new Set() }));
}

function comparisonPart(part) {
    const key = { type: part.type };
    if (typeof part.text === 'string') key.text = part.text;
    // String and typed text align. Preserve annotations/signatures/nontext data;
    // the full native encoding remains available in message.raw/requestFields.
    if (object(part.raw)) {
        const omitted = typeof part.text === 'string' ? ['type', 'text', 'thinking'] : [];
        if (Array.isArray(part.parts)) omitted.push('content');
        const extras = Object.fromEntries(Object.keys(part.raw).filter(name => !omitted.includes(name))
            .sort().map(name => [name, part.raw[name]]));
        if (Object.keys(extras).length) key.fields = extras;
    } else if (typeof part.text !== 'string' && own(part, 'raw')) key.raw = part.raw;
    if (Array.isArray(part.parts)) key.parts = part.parts.map(comparisonPart);
    return key;
}

function comparisonBody(message) {
    return { parts: message.parts.map(comparisonPart), fields: message.fields ?? {} };
}

// Preflight serialization so a raw-backed huge fallback cannot allocate a huge
// comparison key just to discover it exceeded the analysis limit.
function messageBodyKey(message, maxUnits) {
    const body = comparisonBody(message), stack = [body], seen = new Set();
    let units = 0;
    while (stack.length) {
        const value = stack.pop();
        if (typeof value === 'string') units += value.length + 2;
        else if (value && typeof value === 'object') {
            if (seen.has(value)) return null;
            seen.add(value);
            const keys = Object.keys(value);
            units += keys.reduce((sum, key) => sum + key.length + 4, 2);
            for (const key of keys) stack.push(value[key]);
        } else units += 8;
        if (units > maxUnits) return null;
    }
    const key = JSON.stringify(body);
    return key.length <= maxUnits ? key : null;
}

// An exact bounded fallback can still establish equality/difference without an
// LCS matrix. null means undecidable within the limit, NOT equal or different.
function boundedEquality(before, after, maxNodes) {
    if (before.length !== after.length) return false;
    const stack = [];
    before.forEach((message, index) => {
        stack.push([{ role: message.role, ...comparisonBody(message) },
            { role: after[index].role, ...comparisonBody(after[index]) }]);
    });
    const seen = new Map();
    let nodes = 0;
    while (stack.length) {
        if (++nodes > maxNodes) return null;
        const [left, right] = stack.pop();
        if (left === right) continue;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
        if (Array.isArray(left) !== Array.isArray(right)) return false;
        if (seen.get(left)?.has(right)) return null;
        const partners = seen.get(left) ?? new Set(); partners.add(right); seen.set(left, partners);
        const keys = Object.keys(left), rightKeys = Object.keys(right);
        if (keys.length !== rightKeys.length || keys.some(key => !own(right, key))) return false;
        for (const key of keys) stack.push([left[key], right[key]]);
    }
    return true;
}

function groupChange(before, after, beforeStart, afterStart, options) {
    const textChanges = [];
    let textDiffsOmitted = 0;
    if (before.length === after.length) {
        before.forEach((message, index) => {
            const left = textLeaves([message]), right = textLeaves([after[index]]);
            // Positional comparisons are explicit, not native rewrite claims.
            if (left.length === right.length) left.forEach((leaf, partIndex) => {
                if (options.textBudget.pairsRemaining <= 0) { textDiffsOmitted++; return; }
                options.textBudget.pairsRemaining--;
                const diff = diffPromptInspectorText(leaf.part.text, right[partIndex].part.text,
                    { maxScanCodeUnits: options.textBudget.remaining });
                options.textBudget.remaining = Math.max(0, options.textBudget.remaining - diff.scannedCodeUnits);
                if (!diff.equal) textChanges.push({ beforePath: leaf.part.path, afterPath: right[partIndex].part.path, ...diff });
            });
        });
    }
    const roleChanged = before.length !== after.length || before.some((message, index) => message.role !== after[index]?.role);
    return { kind: before.length ? after.length ? 'messages-changed' : 'messages-removed' : 'messages-added',
        evidence: 'compared', alignment: 'sequence-gap', beforeStart, afterStart,
        before: { messages: before, roles: before.map(message => message.role) },
        after: { messages: after, roles: after.map(message => message.role) },
        roleChanged, messageCountChanged: before.length !== after.length, textChanges, textDiffsOmitted };
}

/**
 * Bounded LCS aligns exact bodies, separately reporting role changes. Gaps keep
 * full arrays so merged/split messages and media are not flattened. All results
 * are evidence:'compared', never 'observed' or an invented transformation cause.
 */
export function comparePromptInspectorStages(beforeStage, afterStage, options = {}) {
    const before = comparisonMessages(beforeStage), after = comparisonMessages(afterStage);
    const maxCells = limit(options.maxCells, PROMPT_INSPECTOR_MODEL_LIMITS.comparisonCells);
    const maxKeys = limit(options.maxKeyCodeUnits, PROMPT_INSPECTOR_MODEL_LIMITS.comparisonKeyCodeUnits);
    const textOptions = { textBudget: {
        remaining: limit(options.maxScanCodeUnits ?? options.maxTextCodeUnits, PROMPT_INSPECTOR_MODEL_LIMITS.textScanCodeUnits),
        pairsRemaining: limit(options.maxTextPairs, PROMPT_INSPECTOR_MODEL_LIMITS.comparisonTextPairs),
    } };
    const available = Array.isArray(beforeStage?.messages) && Array.isArray(afterStage?.messages);
    let bounded = (before.length + 1) * (after.length + 1) > maxCells;
    const leftKeys = [], rightKeys = [];
    if (!bounded) {
        let keyUnits = 0;
        try {
            for (const [messages, keys] of [[before, leftKeys], [after, rightKeys]]) {
                for (const message of messages) {
                    const key = messageBodyKey(message, maxKeys - keyUnits);
                    if (key === null) { bounded = true; break; }
                    keyUnits += key.length;
                    keys.push(key);
                }
                if (bounded) break;
            }
        } catch {
            // Cyclic/non-JSON optional trace content remains raw-backed.
            bounded = true;
        }
    }
    const changes = [];
    let uncertain = !available;
    if (bounded) {
        let equality = null;
        try { equality = boundedEquality(before, after, PROMPT_INSPECTOR_MODEL_LIMITS.comparisonCells); } catch {                           }
        uncertain ||= equality === null;
        if (equality !== true && (before.length || after.length)) {
            const change = groupChange(before, after, 0, 0, textOptions);
            if (equality === null) change.kind = 'comparison-bounded';
            changes.push(change);
        }
    } else {
        const width = after.length + 1;
        const cells = new Uint32Array((before.length + 1) * width);
        for (let i = before.length - 1; i >= 0; i--) {
            for (let j = after.length - 1; j >= 0; j--) {
                cells[i * width + j] = leftKeys[i] === rightKeys[j] ? cells[(i + 1) * width + j + 1] + 1
                    : Math.max(cells[(i + 1) * width + j], cells[i * width + j + 1]);
            }
        }
        let i = 0, j = 0, leftStart = 0, rightStart = 0;
        function flush() {
            if (leftStart < i || rightStart < j) changes.push(groupChange(before.slice(leftStart, i), after.slice(rightStart, j), leftStart, rightStart, textOptions));
        }
        while (i < before.length && j < after.length) {
            if (leftKeys[i] === rightKeys[j]) {
                flush();
                if (before[i].role !== after[j].role) changes.push({ kind: 'role-changed', evidence: 'compared', alignment: 'exact-content',
                    beforeStart: i, afterStart: j, before: { messages: [before[i]], roles: [before[i].role] },
                    after: { messages: [after[j]], roles: [after[j].role] }, roleChanged: true, messageCountChanged: false, textChanges: [] });
                i++; j++; leftStart = i; rightStart = j;
            } else if (cells[(i + 1) * width + j] >= cells[i * width + j + 1]) i++;
            else j++;
        }
        i = before.length; j = after.length; flush();
    }
    const requestFieldsCompared = own(beforeStage ?? {}, 'requestFields') && own(afterStage ?? {}, 'requestFields');
    let requestFieldsChanged = false;
    try { if (requestFieldsCompared) requestFieldsChanged = JSON.stringify(beforeStage?.requestFields ?? {}) !== JSON.stringify(afterStage?.requestFields ?? {}); }
    catch { requestFieldsChanged = true; bounded = true; }
    if (requestFieldsChanged) changes.push({ kind: 'request-fields-changed', evidence: 'compared',
        before: { requestFields: beforeStage?.requestFields ?? {} }, after: { requestFields: afterStage?.requestFields ?? {} } });
    bounded ||= changes.some(change => change.textDiffsOmitted > 0 || change.textChanges?.some(diff => diff.bounded));
    const knownChange = changes.some(change => change.kind !== 'comparison-bounded');
    return { beforeId: beforeStage?.id ?? null, afterId: afterStage?.id ?? null,
        changed: !available ? null : knownChange ? true : uncertain ? null : false, comparisonComplete: !uncertain,
        bounded, changes, requestFieldsCompared, evidence: 'compared',
        warnings: [...(bounded ? ['stage-comparison-bounded'] : []), ...(!available ? ['stage-comparison-unavailable'] : [])] };
}

/** Exact outbound view: no I/O, HTML decoding, regex/macro execution, or mutation. */
export function buildPromptInspectorView(record) {
    const validRecord = object(record);
    const input = validRecord ? record : {};
    const frontendMessages = input.metadata?.captureKind === 'frontend-messages';
    const context = { complete: true, source: input.source, frontendMessages, warnings: new Set() };
    if (!validRecord) warning(context, 'record-unavailable');
    const trace = object(input.trace) ? input.trace : null;
    const traceComplete = trace?.complete === true;
    if (!traceComplete) warning(context, 'provenance-trace-incomplete');
    const rawRequest = typeof input.rawRequest === 'string' ? input.rawRequest : null;
    let normalized = { messages: [], format: 'unknown', requestFields: {} };
    if (rawRequest === null) {
        context.complete = false;
        warning(context, own(input, 'rawRequest') && input.rawRequest !== null ? 'invalid-raw-request' : 'final-body-unavailable');
        if (own(input, 'rawRequest') && input.rawRequest !== null) normalized = fallbackMessages(input.rawRequest, context, 'invalid-raw-request');
    } else if (rawRequest.length > PROMPT_INSPECTOR_MODEL_LIMITS.parseCodeUnits) {
        normalized = fallbackMessages(rawRequest, context, 'raw-request-parse-limit');
    } else {
        try { normalized = normalizePayload(JSON.parse(rawRequest), context); }
        catch { normalized = fallbackMessages(rawRequest, context, 'malformed-request-json'); }
    }
    const unknownOpaque = markOpaqueProvenance(normalized.messages);
    const sources = prepareSources(trace, context);
    const matchBudget = { remaining: PROMPT_INSPECTOR_MODEL_LIMITS.matchWork, labelsRemaining: PROMPT_INSPECTOR_MODEL_LIMITS.segmentLabels };
    annotateSources(normalized.messages, sources, matchBudget, context);
    const leaves = textLeaves(normalized.messages);
    const unknownRanges = leaves.some(({ part }) => part.segments.some(segment => !segment.verified));
    if (unknownRanges) warning(context, 'unknown-source-ranges');
    const recordComplete = input.complete === true && rawRequest !== null && input.state !== 'oversize' && input.state !== 'pending';
    const bodyComplete = !frontendMessages && recordComplete;
    if (input.state === 'oversize') warning(context, 'final-body-oversize');
    if (!recordComplete) warning(context, 'final-body-incomplete');
    const complete = recordComplete && context.complete;
    const finalId = frontendMessages ? 'frontend-request' : 'backend-final';
    const stages = traceStages(trace, sources, matchBudget, context, finalId);
    const frontendLabel = input.metadata?.capturePhase === 'agent-initial-snapshot' ? 'Agent 保存的初始组装提示词'
        : input.metadata?.capturePhase === 'tauri-dispatch' ? '交给 Tauri 前的请求'
            : input.metadata?.capturePhase === 'settings-ready' ? '公开组装事件中的消息' : '进入后端前的消息';
    stages.push({ id: finalId, label: frontendMessages ? frontendLabel : 'Final outbound request', messages: normalized.messages,
        notes: [], complete, origin: frontendMessages ? 'frontend' : 'backend', requestFields: normalized.requestFields, rawRequest });
    const changes = observedEvents(trace, context);
    const pairs = stages.slice(1).map((stage, index) => [stages[index], stage]);
    const maxPairs = PROMPT_INSPECTOR_MODEL_LIMITS.stageComparisons;
    const selectedPairs = pairs.length > maxPairs ? [...pairs.slice(0, maxPairs - 1), pairs.at(-1)] : pairs;
    if (selectedPairs.length < pairs.length) warning(context, 'stage-comparison-count-limit');
    let cellsRemaining = PROMPT_INSPECTOR_MODEL_LIMITS.comparisonCells;
    for (const [before, after] of selectedPairs) {
        const needed = (before.messages.length + 1) * (after.messages.length + 1);
        const comparison = comparePromptInspectorStages(before, after, { maxCells: cellsRemaining });
        cellsRemaining = Math.max(0, cellsRemaining - needed);
        comparison.warnings.forEach(code => warning(context, code));
        changes.push({ kind: 'stage-comparison', label: `${before.label} → ${after.label}`, origin: 'comparison', ...comparison });
    }
    const metadata = { ...(object(input.metadata) ? input.metadata : {}),
        version: input.version ?? null, id: input.id ?? null, chatId: input.chatId ?? null,
        source: input.source ?? null, model: input.model ?? null, sequence: input.sequence ?? null,
        capturedAt: input.capturedAt ?? null, responseAt: input.responseAt ?? null, state: input.state ?? 'unavailable',
        errorCode: input.errorCode ?? null, format: normalized.format, bodyComplete,
        frontendMessagesComplete: frontendMessages && recordComplete,
        normalizedComplete: complete, traceComplete, provenanceComplete: complete && traceComplete && !unknownRanges && !unknownOpaque
            && sources.every(source => source.status === 'matched' || source.status === 'empty'),
        requestFields: normalized.requestFields, rangeUnit: 'utf16-code-units' };
    return { metadata, messages: normalized.messages, sources, stages, changes, rawRequest, complete, warnings: [...context.warnings] };
}
