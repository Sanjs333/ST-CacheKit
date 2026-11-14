/* Local cache diagnostics; SPDX-License-Identifier: MPL-2.0 */
import { mountExtensionSettings } from './extension-settings.js';
import { createCacheDiagnosticsViewer } from './cache-diagnostics-view.js';
import { bindExtensionTheme } from './theme.js';
import { createExtensionDialog } from './dialog.js';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const label = value => typeof value === 'string' ? value.slice(0, 128) : '';
const STATUSES = ['pending', 'complete', 'incomplete', 'failed'];
const KINDS = ['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult', 'other'];

function contentView(content) {
    if (!content || typeof content !== 'object') return null;
    const kinds = {};
    for (const kind of KINDS) if (count(content.kinds?.[kind]) !== null) kinds[kind] = content.kinds[kind];
    return { role: ['user', 'model', 'system'].includes(content.role) ? content.role : 'unknown',
        partCount: count(content.partCount), textChars: count(content.textChars), textBytes: count(content.textBytes),
        kinds, thoughtParts: count(content.thoughtParts), signedParts: count(content.signedParts), fingerprint: hash(content.fingerprint) };
}

// Project the server response again. Never render an arbitrary record/body or
// trust a historical/corrupt ledger to contain only the new metadata schema.
export function requestPreviewView(preview) {
    if (preview?.version !== 1 || preview.status !== 'available' || !Array.isArray(preview.contents)) {
        const reason = ['BODY_TOO_LARGE', 'UNSUPPORTED_GOOGLE_SHAPE', 'INVALID_OR_UNSUPPORTED_JSON',
            'FINGERPRINT_UNAVAILABLE', 'BODY_UNAVAILABLE'].includes(preview?.reason) ? preview.reason : 'NOT_RECORDED';
        return { status: 'unavailable', reason, bodyBytes: count(preview?.bodyBytes) };
    }
    const generation = {};
    for (const key of ['maxOutputTokens', 'temperature', 'topP', 'topK', 'candidateCount', 'seed']) {
        if (typeof preview.generation?.[key] === 'number' && Number.isFinite(preview.generation[key])) generation[key] = preview.generation[key];
    }
    return { status: 'available', bodyBytes: count(preview.bodyBytes),
        epoch: typeof preview.epoch === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(preview.epoch) ? preview.epoch : null,
        bodyFingerprint: hash(preview.bodyFingerprint), parametersFingerprint: hash(preview.parametersFingerprint),
        systemInstruction: preview.systemInstruction == null ? null : contentView(preview.systemInstruction),
        contentCount: count(preview.contentCount), contents: preview.contents.slice(0, 64).map(contentView),
        omittedContents: count(preview.omittedContents), generation, toolCount: count(preview.toolCount),
        hasExplicitCache: preview.hasExplicitCache === true, hasContinuationToken: preview.hasContinuationToken === true,
        serviceTier: ['standard', 'flex', 'priority'].includes(preview.serviceTier) ? preview.serviceTier : null };
}

export function cacheUsageView(record) {
    const promptTokens = count(record?.usage?.promptTokenCount);
    const cachedTokens = count(record?.usage?.cachedContentTokenCount);
    const valid = promptTokens !== null && cachedTokens !== null && cachedTokens <= promptTokens;
    return { promptTokens, cachedTokens: valid ? cachedTokens : null,
        cacheRate: valid && promptTokens > 0 ? cachedTokens / promptTokens : null,
        outputTokens: count(record?.usage?.candidatesTokenCount), thinkingTokens: count(record?.usage?.thoughtsTokenCount),
        cacheField: record?.usage?.cachedContentTokenCount == null ? 'missing' : valid ? 'reported' : 'invalid',
        partial: record?.status !== 'complete' };
}

export function compareRequestPreviews(current, previous) {
    if (!previous) return { status: 'no_previous' };
    const left = current.preview, right = previous.preview;
    if (left.status !== 'available' || right.status !== 'available') return { status: 'unavailable' };
    if (!left.epoch || left.epoch !== right.epoch) return { status: 'different_epoch' };
    if (['model', 'source', 'region'].some(key => current[key] !== previous[key])) return { status: 'different_scope' };
    const same = (a, b) => a?.fingerprint && b?.fingerprint && a.role === b.role && a.fingerprint === b.fingerprint;
    const systemUnchanged = left.systemInstruction === null && right.systemInstruction === null
        || !!same(left.systemInstruction, right.systemInstruction);
    let commonBlocks = 0, commonTextChars = 0;
    if (systemUnchanged) {
        commonTextChars = left.systemInstruction?.textChars ?? 0;
        while (commonBlocks < Math.min(left.contents.length, right.contents.length)
            && same(left.contents[commonBlocks], right.contents[commonBlocks])) {
            commonTextChars += left.contents[commonBlocks].textChars ?? 0;
            commonBlocks++;
        }
    }
    return { status: 'compared', systemUnchanged, commonBlocks, commonTextChars,
        sameBody: !!left.bodyFingerprint && left.bodyFingerprint === right.bodyFingerprint,
        sameParameters: !!left.parametersFingerprint && left.parametersFingerprint === right.parametersFingerprint,
        bounded: (left.omittedContents ?? 0) > 0 || (right.omittedContents ?? 0) > 0 };
}

export function buildCacheDiagnostics(records) {
    // Select twelve previews without filtering the full ledger.
    const latest = [];
    if (Array.isArray(records)) for (let index = records.length - 1; index >= 0 && latest.length < 12; index--) {
        const record = records[index];
        if (typeof record?.id === 'string') latest.push(record);
    }
    const views = latest.map(record => ({
        id: label(record.id), createdAt: label(record.createdAt), model: label(record.model), source: label(record.source),
        tier: label(record.tier), region: label(record.region), status: STATUSES.includes(record.status) ? record.status : 'unknown',
        usage: cacheUsageView(record), googleRequestCount: count(record.googleRequestCount),
        preview: requestPreviewView(record.googleRequests?.[0]),
        storedRequestCount: Array.isArray(record.googleRequests) ? Math.min(3, record.googleRequests.length) : 0,
    }));
    return views.map((view, index) => ({ ...view, comparison: compareRequestPreviews(view, views[index + 1]) }));
}

const comparisonText = value => {
    if (value.status === 'no_previous') return '暂无上一条记录。';
    if (value.status === 'different_epoch') return '指纹密钥不同或缺失，无法比较。';
    if (value.status === 'different_scope') return '模型、来源或区域不同，无法比较。';
    if (value.status !== 'compared') return '结构摘要不完整，无法比较。';
    return `与上一条记录比较：系统指令${value.systemUnchanged ? '相同' : '不同'}；前 ${value.commonBlocks} 个完整消息块相同，共 ${value.commonTextChars} 个文本字符（含相同系统指令）；其他参数${value.sameParameters ? '相同' : '不同'}。${value.bounded ? '结构列表已截断，比较范围有限。' : ''}`;
};

export function createCacheDiagnosticsUi({ serverClient, getChatId, context, documentRef = globalThis.document }) {
    const make = (tag, text = '') => { const node = documentRef.createElement(tag); node.textContent = text; return node; };
    const root = make('section'); root.id = 'vertex-paygo-cache-diagnostics'; root.className = 'vertex-paygo-settings vertex-paygo-log-settings';
    const actions = make('div'); actions.id = `${root.id}-actions`; actions.className = 'vertex-paygo-log-actions';
    const title = make('h4', 'Google 请求与缓存用量'); title.className = 'vertex-paygo-action-label';
    const tools = make('div'); tools.className = 'vertex-paygo-log-tools';
    const viewButton = make('button'); viewButton.type = 'button'; viewButton.id = `${root.id}-view`;
    viewButton.className = 'menu_button vertex-paygo-icon-button vertex-paygo-log-button';
    viewButton.setAttribute('title', '查看 Google 请求与缓存用量'); viewButton.setAttribute('aria-label', '查看 Google 请求与缓存用量');
    const icon = make('i'); icon.className = 'fa-solid fa-chart-simple'; icon.setAttribute('aria-hidden', 'true');
    viewButton.append(icon); tools.append(viewButton); actions.append(title, tools);
    const statusNode = make('small'); statusNode.className = 'vertex-paygo-status'; statusNode.setAttribute('aria-live', 'polite');
    root.append(actions, statusNode);
    let views = [], selected = null, state = 'idle', destroyed = false, epoch = 0, inFlight = null, timer = null;
    let session = null;
    let viewChatId = null, followLatest = true;
    const listeners = [];
    function render() {
        if (destroyed) return;
        statusNode.textContent = state === 'loading' ? '正在读取记录…' : state === 'error' ? '读取失败，请打开查看器后刷新重试。' : '';
        statusNode.hidden = !statusNode.textContent;
        session?.viewer.render({ views, selected, state, comparisonText });
    }
    function disposeSession(current) {
        if (session !== current) return;
        session = null;
        current.theme?.destroy();
        for (const dispose of current.disposers) dispose();
        current.viewer.destroy(); current.dialog?.remove();
        if (!destroyed) viewButton.focus?.();
    }
    function close(current) {
        if (session !== current) return;
        if (current.popup) {
            try {
                if (typeof current.popup.complete === 'function') current.popup.complete(context?.POPUP_RESULT?.NEGATIVE ?? 0)?.catch?.(() => {});
                else current.popup.closeButton?.click?.();
            } catch { /* Closing a preview cannot affect generation. */ }
        } else { try { current.dialog?.close?.(); } catch { /* Dispose fallback below. */ } }
        disposeSession(current);
    }
    async function open() {
        if (destroyed) return;
        if (session) { session.viewer.root.querySelector('select')?.focus?.(); return; }
        const current = { popup: null, dialog: null, disposers: [] };
        current.viewer = createCacheDiagnosticsViewer({ documentRef, onRefresh: () => void refresh(),
            onSelect: value => { if (views.some(view => view.id === value)) { selected = value; followLatest = selected === views[0]?.id; } render(); },
            onClose: () => close(current) });
        session = current; render();
        try {
            current.popup = createExtensionDialog(current.viewer.root, { okButton: false, wide: true, large: true });
            current.popup.dlg.classList.add('vertex-paygo-cache-dialog');
            current.theme = bindExtensionTheme(current.popup.dlg, { skipBg: false });
            const showing = current.popup.show();
            current.theme.sync();
            void showing.then(() => disposeSession(current));
            void refresh();
            return current.viewer.root;
        } catch (error) {
            disposeSession(current);
            throw error;
        }
    }
    async function refresh() {
        if (destroyed) return;
        let chatId;
        try { chatId = getChatId(); } catch { epoch++; views = []; selected = null; viewChatId = null; inFlight = null; state = 'error'; render(); return; }
        if (!chatId) { epoch++; views = []; selected = null; viewChatId = null; inFlight = null; state = 'no_chat'; render(); return; }
        if (viewChatId !== chatId) { epoch++; views = []; selected = null; followLatest = true; viewChatId = chatId; inFlight = null; }
        if (inFlight?.chatId === chatId && inFlight.epoch === epoch) return inFlight.promise;
        const task = { chatId, epoch };
        state = 'loading'; render(); inFlight = task;
        task.promise = (async () => {
            try {
                const result = await serverClient.readUsage(chatId, { includeRequestPreviews: true, latest: 12 });
                if (destroyed || task.epoch !== epoch || getChatId() !== chatId) return;
                if (result?.ok !== true || !Array.isArray(result.records)) throw new Error('用量数据不可用');
                views = buildCacheDiagnostics(result.records.filter(record => record?.chatId === chatId));
                if (followLatest || !views.some(view => view.id === selected)) selected = views[0]?.id ?? null;
                state = 'ready';
            } catch { if (!destroyed && task.epoch === epoch) state = 'error'; }
            finally {
                if (inFlight === task) inFlight = null;
                if (!destroyed && task.epoch === epoch) render();
            }
        })();
        return task.promise;
    }
    const schedule = () => {
        if (destroyed || timer !== null) return;
        timer = setTimeout(() => { timer = null; void refresh(); }, 400);
    };
    const reset = () => { epoch++; views = []; selected = null; viewChatId = null; followLatest = true; state = 'idle'; inFlight = null; clearTimeout(timer); timer = null; render(); if (session) void refresh(); };
    const listen = (name, callback) => {
        const event = context?.eventTypes?.[name];
        if (typeof event !== 'string' || typeof context?.eventSource?.on !== 'function'
            || typeof context.eventSource.removeListener !== 'function') return;
        context.eventSource.on(event, callback); listeners.push([event, callback]);
    };
    const onRefresh = () => void refresh();
    const onView = () => { void open().catch(() => { if (session) disposeSession(session); state = 'error'; render(); }); };
    viewButton.addEventListener('click', onView);
    let unmount;
    try {
        unmount = mountExtensionSettings(root, { documentRef, tab: 'logs', label: '日志', onShow: onRefresh });
        listen('CHAT_CHANGED', reset); listen('GENERATION_ENDED', schedule); listen('MESSAGE_RECEIVED', schedule);
        render();
    } catch (error) {
        viewButton.removeEventListener('click', onView);
        for (const [event, callback] of listeners) context.eventSource.removeListener(event, callback);
        unmount?.(); throw error;
    }
    return { open, refresh, render, snapshot: () => structuredClone({ state, selected, views }),
        destroy() {
            if (destroyed) return; destroyed = true; epoch++; clearTimeout(timer); timer = null;
            if (session) close(session);
            viewButton.removeEventListener('click', onView);
            for (const [event, callback] of listeners) context.eventSource.removeListener(event, callback);
            unmount(); views = []; inFlight = null;
        } };
}
