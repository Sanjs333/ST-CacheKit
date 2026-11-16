/* TauriTavern's native Gemini text-part boundary; SPDX-License-Identifier: MPL-2.0 */
import { CACHE_BOUNDARY_SETTINGS_KEY, locateCacheHistoryBoundary } from './cache-prefix-boundary.js';
import { completionIdentity } from './worldinfo-stability.js';
import { sanitizeChat } from './prompt-migration.js';
import { isGoogleSource } from './constants.js';

const LIMIT = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const plain = message => record(message) && Object.keys(message).length === 2
    && typeof message.role === 'string' && typeof message.content === 'string';
const canonical = value => JSON.stringify(value, function (_key, current) {
    return record(current) ? Object.fromEntries(Object.keys(current).sort().map(key => [key, current[key]])) : current;
});
const modes = new Set(['merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single']);

function modeOf(data) {
    const mode = String(data?.custom_prompt_post_processing ?? '').trim().toLowerCase();
    return mode === 'claude' ? 'merge' : modes.has(mode) ? mode : '';
}

function namesOf(data) {
    const trim = value => typeof value === 'string' ? value.trim() : '';
    return { user: trim(data.user_name), char: trim(data.char_name),
        groups: Array.isArray(data.group_names) ? data.group_names.map(trim).filter(Boolean) : [] };
}

function prefix(text, name, groups = []) {
    return !name || text.startsWith(`${name}: `) || groups.some(group => text.startsWith(`${group}: `))
        ? text : `${name}: ${text}`;
}

// Mirrors TT's Rust prompt_post_processing before provider conversion. Indices
// identify only the existing input members of each native merge group. Media
// tokens are local to this projection and never leave it or enter a request.
export function projectTauriPromptMessages(data) {
    if (!Array.isArray(data?.messages)) return null;
    const mode = modeOf(data);
    const names = namesOf(data);
    const original = data.messages;
    let tokenSerial = 0;
    const marker = '__ST_CACHEKIT_PROJECTION_MEDIA_';
    if (JSON.stringify(original).includes(marker)) return null;
    const process = (entries, { strict, placeholders, single, tools }) => {
        const media = new Map();
        const normalizeContent = value => {
            if (typeof value === 'string') return value;
            if (value == null) return '';
            if (!Array.isArray(value)) return JSON.stringify(value);
            return value.map(part => {
                if (typeof part === 'string') return part;
                if (!record(part)) return '';
                if (part.type === 'text') return typeof part.text === 'string' ? part.text : '';
                if (!['image_url', 'video_url', 'audio_url'].includes(part.type)) return '';
                const token = `${marker}${++tokenSerial}__`;
                media.set(token, clone(part));
                return token;
            }).join('\n\n');
        };
        const merged = [];
        for (const entry of entries) {
            if (!record(entry.message)) continue;
            const message = clone(entry.message);
            let content = normalizeContent(message.content);
            let role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : 'user';
            const name = typeof message.name === 'string' ? message.name.trim() : null;
            if (role === 'system' && name === 'example_assistant') content = prefix(content, names.char, names.groups);
            else if (role === 'system' && name === 'example_user') content = prefix(content, names.user);
            else if (name !== null && role !== 'system' && !content.startsWith(`${name}: `)) content = `${name}: ${content}`;
            if (role === 'tool' && !tools) role = 'user';
            if (single) {
                if (role === 'assistant') content = prefix(content, names.char, names.groups);
                else if (role === 'user') content = prefix(content, names.user);
                role = 'user';
            }
            message.role = role; message.content = content;
            delete message.name;
            if (!tools) { delete message.tool_calls; delete message.tool_call_id; }
            const previous = merged.at(-1);
            if (plain(message) && role !== 'tool' && content && plain(previous?.message) && previous.message.role === role) {
                previous.message.content += `\n\n${content}`;
                previous.indices.push(...entry.indices);
            } else merged.push({ message, indices: [...entry.indices] });
        }
        if (!merged.length) merged.push({ message: { role: 'user', content: "Let's get started." }, indices: [] });
        if (media.size) {
            for (const entry of merged) {
                const content = entry.message.content;
                if (typeof content !== 'string' || ![...media.keys()].some(token => content.includes(token))) continue;
                const parts = [];
                for (const segment of content.split('\n\n')) {
                    if (media.has(segment)) parts.push(clone(media.get(segment)));
                    else if (parts.at(-1)?.type === 'text') parts.at(-1).text += `\n\n${segment}`;
                    else parts.push({ type: 'text', text: segment });
                }
                entry.message.content = parts;
            }
        }
        if (strict) {
            for (let index = 1; index < merged.length; index++) {
                if (merged[index].message.role === 'system') merged[index].message.role = 'user';
            }
            if (placeholders) {
                const first = merged[0].message.role, second = merged[1]?.message.role;
                const placeholder = { message: { role: 'user', content: "Let's get started." }, indices: [] };
                if (first === 'system' && second !== 'user') merged.splice(1, 0, placeholder);
                else if (first !== 'system' && first !== 'user') merged.unshift(placeholder);
            }
            return process(merged, { strict: false, placeholders, single: false, tools });
        }
        return merged;
    };
    const entries = original.map((message, index) => ({ message: clone(message), indices: [index] }));
    if (!mode) return entries;
    return process(entries, { strict: ['semi', 'semi_tools', 'strict', 'strict_tools', 'single'].includes(mode),
        placeholders: ['strict', 'strict_tools'].includes(mode), single: mode === 'single', tools: mode.endsWith('_tools') });
}

function bodyOverrideTouchesMessages(data, yaml) {
    const parse = value => {
        if (value == null || value === '') return undefined;
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); }
        catch { return yaml?.parse ? yaml.parse(value) : yaml?.load ? yaml.load(value) : yaml?.safeLoad ? yaml.safeLoad(value) : null; }
    };
    try {
        const included = parse(data.custom_include_body);
        const excluded = parse(data.custom_exclude_body);
        if ((data.custom_include_body && included == null) || (data.custom_exclude_body && excluded == null)) return true;
        const objects = Array.isArray(included) ? included : [included];
        const keys = objects.flatMap(value => record(value) ? Object.keys(value) : []);
        keys.push(...(Array.isArray(excluded) ? excluded : record(excluded) ? Object.keys(excluded) : typeof excluded === 'string' ? [excluded] : []));
        return keys.some(key => ['contents', 'messages', 'systemInstruction', 'system_instruction'].includes(key));
    } catch { return true; }
}

function supportedRequest(data, yaml) {
    return isGoogleSource(data?.chat_completion_source)
        && typeof data.model === 'string' && /^gemini-/u.test(data.model)
        && !/image/iu.test(data.model) && !data.use_interactions_api && !data.interactions
        && Array.isArray(data.messages) && data.messages.length <= 512
        && encoder.encode(JSON.stringify(data.messages)).length <= LIMIT
        && !bodyOverrideTouchesMessages(data, yaml);
}

// Replace exactly one native plain-text merge group, then run the same native
// processing on the proposal. Accept only identical roles/content/other fields.
// The supported Gemini converter forwards native parts verbatim for this user
// group; all remaining signed, tool and media turns keep their original input.
export function splitTauriCacheHistoryBoundary(data, source, { yaml } = {}) {
    if (!supportedRequest(data, yaml)) return { status: 'unsupported' };
    const location = locateCacheHistoryBoundary(data.messages, source);
    if (!location) return { status: 'ambiguous' };
    const projected = projectTauriPromptMessages(data);
    if (!projected) return { status: 'unsupported' };
    const groupIndex = projected.findIndex(entry => entry.indices.includes(location.messageIndex));
    const group = projected[groupIndex];
    if (!group || group.message.role !== 'user' || !plain(group.message)) return { status: 'unsupported' };
    const historyText = sanitizeChat([{ role: source.role, content: source.text }])[0].content;
    const offset = group.message.content.indexOf(historyText);
    if (offset < 0 || group.message.content.indexOf(historyText, offset + 1) !== -1) return { status: 'ambiguous' };
    if (offset === 0) return { status: 'already-separated', stableTextChars: projected.slice(0, groupIndex)
        .reduce((sum, entry) => sum + (typeof entry.message.content === 'string' ? entry.message.content.length : 0), 0) };
    const first = group.indices[0], last = group.indices.at(-1);
    if (group.indices.length !== last - first + 1 || group.indices.some(index => {
        const message = data.messages[index];
        return !record(message) || typeof message.content !== 'string'
            || Object.keys(message).some(key => !['role', 'content', 'name'].includes(key));
    })) return { status: 'unsupported' };
    const stable = group.message.content.slice(0, offset), history = group.message.content.slice(offset);
    if (!stable.trim() || !history.trim()) return { status: 'unsupported' };
    const replacement = { role: 'user', content: group.message.content,
        native: { gemini: { content: { parts: [{ text: stable }, { text: history }] } } } };
    const messages = [...data.messages.slice(0, first), replacement, ...data.messages.slice(last + 1)];
    const verified = projectTauriPromptMessages({ ...data, messages });
    if (!verified || verified.length !== projected.length) return { status: 'unsupported' };
    const comparable = verified.map((entry, index) => {
        const message = clone(entry.message);
        if (index === groupIndex && canonical(message.native) === canonical(replacement.native)) delete message.native;
        return message;
    });
    if (canonical(comparable) !== canonical(projected.map(entry => entry.message))) return { status: 'unsupported' };
    data.messages = messages;
    return { status: 'split', stableTextChars: stable.length + projected.slice(0, groupIndex)
        .reduce((sum, entry) => sum + (typeof entry.message.content === 'string' ? entry.message.content.length : 0), 0) };
}

export function createTauriCacheBoundary({ getContext, target = globalThis, yaml, onChange = () => {}, now = Date.now,
    ttlMs = 300_000, maxEntries = 8, maxPendingBytes = 4 * 1024 * 1024 } = {}) {
    let latest = null, destroyed = false, serial = 0, last = { status: 'waiting' };
    const listeners = [], pending = new Map();
    const enabled = () => !!getContext?.()?.extensionSettings
        && getContext().extensionSettings[CACHE_BOUNDARY_SETTINGS_KEY]?.enabled !== false;
    const emit = value => { last = value; try { onChange(); } catch {} };
    const scope = () => {
        const context = getContext?.(), identity = completionIdentity(context);
        const chatId = context?.getCurrentChatId?.();
        return identity && typeof chatId === 'string' && chatId ? { ...identity, chatId } : null;
    };
    const matches = (a, b) => !!a && !!b && ['chatId', 'source', 'model'].every(key => a[key] === b[key]);
    const clear = () => { latest = null; };
    const sweep = () => {
        if (latest && now() >= latest.expires) clear();
        for (const [token, entry] of pending) if (now() >= entry.expires) pending.delete(token);
    };
    const context = getContext?.();
    for (const name of ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'SETTINGS_LOADED',
        'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CONNECTION_PROFILE_LOADED']) {
        const event = context?.eventTypes?.[name];
        if (typeof event === 'string' && context?.eventSource?.on) {
            context.eventSource.on(event, clear); listeners.push([event, clear]);
        }
    }
    return {
        snapshot: () => ({ enabled: enabled(), supportedModels: 'Gemini', ...last }),
        setEnabled(value) {
            const current = getContext?.();
            if (!current?.extensionSettings) return;
            current.extensionSettings[CACHE_BOUNDARY_SETTINGS_KEY] = { version: 1, enabled: value === true };
            current.saveSettingsDebounced?.(); clear();
            if (!value) pending.clear();
            emit({ status: value ? 'waiting' : 'disabled' });
        },
        captureRuntimeSnapshot(payload) {
            if (destroyed || !enabled() || !['assembled', 'post-plugin'].includes(payload?.stage)
                || !Array.isArray(payload.sources) || !Array.isArray(payload.messages)
                || !Number.isSafeInteger(payload.generationOrdinal) || !matches(payload.requestScope, scope())) return;
            const source = payload.sources.find(value => value?.kind === 'history' && value.historyInput === true);
            if (!source || !locateCacheHistoryBoundary(payload.messages, source)) { clear(); emit({ status: 'source-unavailable' }); return; }
            latest = { source: { id: source.id, role: source.role, text: source.text, kind: 'history', historyInput: true },
                requestScope: { ...payload.requestScope }, expires: now() + ttlMs };
            emit({ status: 'source-ready' });
        },
        captureRequest(data, { background = false } = {}) {
            if (destroyed || background || !enabled() || !supportedRequest(data, yaml)) return null;
            sweep();
            const entry = latest;
            if (!entry || now() >= entry.expires || !matches(entry.requestScope, scope())
                || entry.requestScope.source !== data?.chat_completion_source || entry.requestScope.model !== data?.model
                || !locateCacheHistoryBoundary(data.messages, entry.source)) {
                emit({ status: 'source-unavailable' }); return null;
            }
            const size = encoder.encode(entry.source.text).length;
            while (pending.size >= maxEntries || [...pending.values()].reduce((sum, item) => sum + item.size, 0) + size > maxPendingBytes) {
                if (!pending.size) return null;
                pending.delete(pending.keys().next().value);
            }
            const token = `tauri-boundary-${++serial}`;
            pending.set(token, { ...entry, size });
            clear();
            return token;
        },
        applyRequest(data, { background = false, token } = {}) {
            sweep();
            const entry = pending.get(token);
            pending.delete(token);
            if (destroyed || background || !enabled() || !entry) return null;
            if (!matches(entry.requestScope, scope()) || entry.requestScope.source !== data?.chat_completion_source
                || entry.requestScope.model !== data?.model) {
                emit({ status: 'source-unavailable' }); return null;
            }
            // This controller is for the legacy /generate Gemini request. Agent
            // and Interactions requests have their own native prompt structure.
            if (data?.agent_mode || data?.agentMode || target?.__TAURITAVERN__?.agentModeEnabled === true) {
                emit({ status: 'unsupported' }); return null;
            }
            const result = splitTauriCacheHistoryBoundary(data, entry.source, { yaml });
            emit(result); return result;
        },
        cancelRequest(token) { pending.delete(token); },
        destroy() { destroyed = true; clear(); pending.clear();
            for (const [event, handler] of listeners) context?.eventSource?.removeListener?.(event, handler); },
    };
}
