/* Source-backed, request-bound prefix segmentation; SPDX-License-Identifier: MPL-2.0 */
import { isNativeGemini4Request } from './gemini4-request.js';
import { completionIdentity } from './worldinfo-stability.js';
import { sanitizeChat } from './prompt-migration.js';
import { mountExtensionSettings } from './extension-settings.js';
import { createLocalizer } from './i18n.js';

export const CACHE_BOUNDARY_FIELD = '__vertexPayGoCacheBoundary';
export const CACHE_BOUNDARY_SETTINGS_KEY = 'vertex-paygo-cache-boundary';
const MAX_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const bytes = value => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const safeHistory = source => source?.kind === 'history' && source.historyInput === true
    && typeof source.id === 'string' && /^prompt:chatHistory-\d{1,9}$/u.test(source.id)
    && typeof source.text === 'string' && source.text.length > 0
    && ['user', 'assistant', 'system'].includes(source.role);

// Match a whole observed history source exactly and uniquely. No length-based,
// role-only or fuzzy reconstruction of a missing source is accepted.
export function locateCacheHistoryBoundary(messages, source) {
    if (!safeHistory(source) || !Array.isArray(messages) || messages.length > 512 || bytes(messages) > MAX_BYTES) return null;
    const text = sanitizeChat([{ role: source.role, content: source.text }])[0].content;
    if (!text || bytes(text) > MAX_BYTES) return null;
    let match = null;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
        const message = messages[messageIndex];
        const parts = typeof message?.content === 'string' ? [{ index: null, text: message.content }]
            : Array.isArray(message?.content) ? message.content.flatMap((part, index) => part?.type === 'text' && typeof part.text === 'string' ? [{ index, text: part.text }] : []) : [];
        for (const part of parts) {
            const offset = part.text.indexOf(text);
            if (offset === -1) continue;
            if (match || part.text.indexOf(text, offset + 1) !== -1 || message.role !== source.role) return null;
            match = { messageIndex, textPartIndex: part.index, offset, sourceId: source.id };
        }
    }
    return match;
}

export function createCachePrefixBoundary({ getContext, onChange = () => {}, now = Date.now,
    loadHash = () => import('../../../../../lib.js'), ttlMs = 300_000, maxEntries = 8, maxPendingBytes = 4 * 1024 * 1024 } = {}) {
    let latest = null, hashModule = null, destroyed = false, serial = 0;
    let last = { status: 'waiting', reason: '尚未发送可核验的普通聊天请求。' };
    const pending = new Map(), listeners = [];
    const enabled = () => {
        const root = getContext?.()?.extensionSettings;
        return !!root && root[CACHE_BOUNDARY_SETTINGS_KEY]?.enabled !== false;
    };
    const emit = value => { last = value; try { onChange(); } catch {} };
    const sweep = () => {
        const time = now();
        if (latest && time >= latest.expires) latest = null;
        for (const [id, value] of pending) if (time >= value.expires) pending.delete(id);
    };
    const snapshot = () => ({ enabled: enabled(), supportedModels: 'Gemini 4 原生请求', ...last });
    const currentScope = () => {
        const context = getContext?.(), identity = completionIdentity(context);
        const chatId = context?.getCurrentChatId?.();
        return identity && typeof chatId === 'string' && chatId ? { chatId, ...identity } : null;
    };
    const scopeMatches = (a, b) => a && b && ['chatId', 'source', 'model'].every(key => a[key] === b[key]);
    const timer = setInterval(sweep, Math.min(ttlMs, 10_000)); timer.unref?.();
    const clearSource = () => { latest = null; };
    const context = getContext?.();
    for (const name of ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'SETTINGS_LOADED',
        'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CONNECTION_PROFILE_LOADED']) {
        const event = context?.eventTypes?.[name];
        if (typeof event === 'string' && context?.eventSource?.on) {
            context.eventSource.on(event, clearSource); listeners.push([event, clearSource]);
        }
    }
    return {
        snapshot,
        setEnabled(value) {
            const current = getContext?.();
            if (!current?.extensionSettings) return;
            current.extensionSettings[CACHE_BOUNDARY_SETTINGS_KEY] = { version: 1, enabled: value === true };
            current.saveSettingsDebounced?.();
            if (!value) { latest = null; pending.clear(); }
            emit({ status: value ? 'waiting' : 'disabled', reason: value ? '下一次普通聊天发送时核验历史起点。' : '已关闭来源边界分离。' });
        },
        captureRuntimeSnapshot(payload) {
            if (destroyed || !enabled() || !['assembled', 'post-plugin'].includes(payload?.stage)
                || !Array.isArray(payload.sources) || !Array.isArray(payload.messages)
                || !Number.isSafeInteger(payload.generationOrdinal) || !scopeMatches(payload.requestScope, currentScope())) return;
            sweep();
            const source = payload.sources.find(safeHistory);
            if (!source || bytes(source.text) > MAX_BYTES || !locateCacheHistoryBoundary(payload.messages, source)) {
                latest = null; emit({ status: 'source-unavailable', reason: '未取得唯一可核验的历史起点，保留原请求。' }); return;
            }
            latest = { source: { id: source.id, role: source.role, text: source.text, kind: 'history', historyInput: true },
                requestScope: { ...payload.requestScope }, generationOrdinal: payload.generationOrdinal, expires: now() + ttlMs };
            emit({ status: 'source-ready', reason: '已观察到本次组装的历史起点，发送前将再次核验。' });
        },
        captureRequest(data, { background = false } = {}) {
            if (destroyed || background || !enabled() || !isNativeGemini4Request(data)) return null;
            sweep();
            if (!latest || !scopeMatches(latest.requestScope, currentScope())
                || latest.requestScope.source !== data.chat_completion_source || latest.requestScope.model !== data.model) {
                emit({ status: 'source-unavailable', reason: '当前请求缺少同聊天、同模型的来源证明，保留原请求。' }); return null;
            }
            if (!locateCacheHistoryBoundary(data.messages, latest.source)) {
                emit({ status: 'ambiguous', reason: '历史正文被改写或出现多次，无法唯一核验分界，保留原请求。' }); return null;
            }
            while (pending.size >= maxEntries || [...pending.values()].reduce((sum, value) => sum + bytes(value.source.text), 0) + bytes(latest.source.text) > maxPendingBytes) {
                if (!pending.size) return null;
                pending.delete(pending.keys().next().value);
            }
            const token = `boundary-${++serial}`;
            pending.set(token, { ...latest, expires: now() + ttlMs }); return token;
        },
        async bindRequest(token, data, { supported = false } = {}) {
            sweep();
            const entry = pending.get(token);
            if (destroyed || !entry || !enabled()) return null;
            if (!supported || !isNativeGemini4Request(data)
                || entry.requestScope.source !== data.chat_completion_source || entry.requestScope.model !== data.model) {
                pending.delete(token); emit({ status: 'unsupported', reason: '当前后端或请求通道不支持来源边界分离，保留原请求。' }); return null;
            }
            const location = locateCacheHistoryBoundary(data.messages, entry.source);
            if (!location) { pending.delete(token); emit({ status: 'ambiguous', reason: '发送前历史来源无法唯一匹配，保留原请求。' }); return null; }
            try {
                hashModule ??= loadHash();
                const module = await hashModule;
                if (destroyed || !enabled() || pending.get(token) !== entry) return null;
                const messagesHash = module.sha256(JSON.stringify(data.messages));
                if (typeof messagesHash !== 'string' || !/^[a-f0-9]{64}$/.test(messagesHash)) throw new Error('Hash unavailable');
                emit({ status: 'bound', reason: '历史起点已绑定最终消息内容，等待后端确认分段。' });
                return { version: 1, ...location, messagesHash };
            } catch {
                pending.delete(token); hashModule = null;
                emit({ status: 'unsupported', reason: '请求绑定工具不可用，保留原请求。' }); return null;
            }
        },
        confirmRequest(token, response) {
            pending.delete(token);
            if (destroyed || !token) return;
            let evidence;
            try { evidence = JSON.parse(response?.headers?.get?.('X-ST-CacheKit-Cache-Boundary')); } catch {}
            if (evidence?.version === 1 && ['split', 'already-separated'].includes(evidence.status)
                && Number.isSafeInteger(evidence.stableTextChars) && evidence.stableTextChars >= 0) {
                emit({ status: evidence.status, stableTextChars: evidence.stableTextChars,
                    reason: `后端已确认稳定区与历史分离；稳定区 ${evidence.stableTextChars.toLocaleString('zh-CN')} 个文本字符。` });
            } else if (evidence?.version === 1 && evidence.status === 'unavailable') emit({ status: 'unavailable', reason: '后端未能核验分界，已保留原请求结构。' });
            else emit({ status: 'submitted', reason: '已提交来源边界；最终是否分离请查看 Google 请求与缓存诊断。' });
        },
        cancelRequest(token) { pending.delete(token); },
        destroy() { destroyed = true; clearInterval(timer); latest = null; pending.clear();
            for (const [event, handler] of listeners) context?.eventSource?.removeListener?.(event, handler); },
    };
}

export function createCachePrefixBoundarySettings({ boundary, getContext, documentRef = globalThis.document, mountSettings = mountExtensionSettings,
    localize = createLocalizer((fallback, key) => getContext?.()?.translate?.(fallback, key)), helpKey = 'vertex_paygo.cache_boundary.help' } = {}) {
    const make = (tag, text = '') => { const node = documentRef.createElement(tag); node.textContent = text; return node; };
    const root = make('section'); root.id = 'vertex-paygo-cache-prefix-settings'; root.className = 'vertex-paygo-group';
    const title = make('h4', localize('vertex_paygo.cache_boundary.title')); title.className = 'vertex-paygo-group-title';
    const label = make('label'); label.className = 'vertex-paygo-toggle-row';
    const toggle = make('input'); toggle.type = 'checkbox'; toggle.id = 'vertex-paygo-cache-prefix-boundary';
    toggle.className = 'vertex-paygo-compact-switch'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', localize('vertex_paygo.cache_boundary.enabled'));
    label.append(make('span', localize('vertex_paygo.cache_boundary.enabled')), toggle);
    const note = make('p', localize(helpKey)); note.className = 'vertex-paygo-guidance';
    root.append(title, label, note);
    const render = () => { const current = boundary?.snapshot(); toggle.checked = current?.enabled === true;
        toggle.disabled = !boundary || !getContext?.()?.extensionSettings; };
    const change = () => { boundary?.setEnabled(toggle.checked); render(); };
    toggle.addEventListener('change', change); render();
    const unmount = mountSettings(root, { documentRef, tab: 'cache', label: localize('vertex_paygo.settings.tab.cache'), onShow: render });
    return { render, destroy() { toggle.removeEventListener('change', change); unmount(); } };
}
