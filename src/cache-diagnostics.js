/* Local cache diagnostics; SPDX-License-Identifier: MPL-2.0 */
import { mountExtensionSettings } from './extension-settings.js';
import { createCacheDiagnosticsViewer } from './cache-diagnostics-view.js';
import { bindExtensionTheme } from './theme.js';
import { createExtensionDialog } from './dialog.js';
import { buildCacheMissAnalysis, sameCacheScope } from './cache-miss-analysis.js';
import { compareRequestPreviews, projectCacheBoundary, projectRequestComparison } from './cache-request-comparison.js';
import { cacheTokenCount } from './cost-model.js';
import { createLocalizer } from './i18n.js';
export { compareRequestPreviews } from './cache-request-comparison.js';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const label = value => typeof value === 'string' ? value.slice(0, 128) : '';
const STATUSES = ['pending', 'complete', 'incomplete', 'failed'];
const KINDS = ['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult', 'other'];

function contentView(content) {
    if (!content || typeof content !== 'object') return null;
    const kinds = {};
    for (const kind of KINDS) if (count(content.kinds?.[kind]) !== null) kinds[kind] = content.kinds[kind];
    const textSegments = Array.isArray(content.textSegments) ? content.textSegments.slice(0, 64).filter(segment =>
        Number.isSafeInteger(segment?.part) && segment.part >= 1 && segment.part <= content.partCount
        && count(segment.textChars) !== null && hash(segment.fingerprint)).map(segment => ({ part: segment.part,
        textChars: segment.textChars, fingerprint: hash(segment.fingerprint) })) : [];
    return { role: ['user', 'model', 'system', 'tool'].includes(content.role) ? content.role : 'unknown',
        partCount: count(content.partCount), textChars: count(content.textChars), textBytes: count(content.textBytes),
        kinds, thoughtParts: count(content.thoughtParts), signedParts: count(content.signedParts), fingerprint: hash(content.fingerprint),
        textSegments, omittedTextSegments: count(content.omittedTextSegments) };
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
    const systemInstruction = preview.systemInstruction == null ? null : contentView(preview.systemInstruction);
    if (preview.systemInstruction != null && systemInstruction === null) {
        return { status: 'unavailable', reason: 'INVALID_OR_UNSUPPORTED_JSON', bodyBytes: count(preview.bodyBytes) };
    }
    return { status: 'available', bodyBytes: count(preview.bodyBytes),
        captureKind: preview.captureKind === 'tauri-frontend' ? 'tauri-frontend' : 'google-wire',
        cacheMode: ['implicit', 'explicit', 'unknown'].includes(preview.cacheMode) ? preview.cacheMode
            : preview.hasExplicitCache === true ? 'explicit' : 'implicit',
        epoch: typeof preview.epoch === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(preview.epoch) ? preview.epoch : null,
        bodyFingerprint: hash(preview.bodyFingerprint), parametersFingerprint: hash(preview.parametersFingerprint),
        systemInstruction,
        contentCount: count(preview.contentCount), contents: preview.contents.slice(0, 64).map(contentView),
        omittedContents: count(preview.omittedContents), generation, toolCount: count(preview.toolCount),
        requestComparison: projectRequestComparison(preview.requestComparison),
        cacheBoundary: projectCacheBoundary(preview.cacheBoundary),
        hasExplicitCache: preview.hasExplicitCache === true, hasContinuationToken: preview.hasContinuationToken === true,
        serviceTier: ['standard', 'flex', 'priority'].includes(preview.serviceTier) ? preview.serviceTier : null };
}

export function cacheUsageView(record) {
    const promptTokens = count(record?.usage?.promptTokenCount);
    const cachedTokens = count(record?.usage?.cachedContentTokenCount);
    const valid = promptTokens !== null && cachedTokens !== null && cachedTokens <= promptTokens;
    const provenance = record?.usage?.cacheCountStatus;
    const cacheField = provenance === 'omitted' || provenance === 'mixed' ? provenance
        : provenance !== undefined && provenance !== 'reported' ? 'invalid'
            : cachedTokens === null ? record?.usage?.cachedContentTokenCount == null ? 'missing' : 'invalid'
                : !valid ? 'invalid' : record?.usageAccuracy === 'tauri-normalized' && cachedTokens === 0 ? 'normalized'
                    : provenance === undefined && cachedTokens === 0 ? 'unverified' : 'reported';
    const usableCount = cacheTokenCount(record);
    return { promptTokens, cachedTokens: usableCount,
        cacheRate: record?.status === 'complete' && usableCount !== null && promptTokens > 0 ? usableCount / promptTokens : null,
        outputTokens: count(record?.usage?.candidatesTokenCount), thinkingTokens: count(record?.usage?.thoughtsTokenCount),
        cacheField: cacheField === 'reported' && record?.usage?.cacheCountSource === 'google-default-zero' ? 'default-zero' : cacheField,
        partial: record?.status !== 'complete' || Array.isArray(record?.usage?.invalidUsageFields) && record.usage.invalidUsageFields.length > 0 };
}

export function buildCacheDiagnostics(records, localize = createLocalizer()) {
    // Select twelve previews without filtering the full ledger.
    const latest = [];
    if (Array.isArray(records)) for (let index = records.length - 1; index >= 0 && latest.length < 12; index--) {
        const record = records[index];
        if (typeof record?.id === 'string') latest.push(record);
    }
    const views = latest.map(record => ({
        id: label(record.id), createdAt: label(record.createdAt), model: label(record.model), source: label(record.source),
        tier: label(record.tier), region: label(record.region), status: STATUSES.includes(record.status) ? record.status : 'unknown',
        errorCode: typeof record.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(record.errorCode) ? record.errorCode : '',
        usage: cacheUsageView(record), googleRequestCount: count(record.googleRequestCount),
        preview: requestPreviewView(record.googleRequests?.[0]),
        storedRequestCount: Array.isArray(record.googleRequests) ? Math.min(3, record.googleRequests.length) : 0,
    }));
    return views.map((view, index) => {
        const previous = views[index + 1] ?? null;
        const reference = views.slice(index + 1).find(candidate => candidate.status === 'complete' && sameCacheScope(view, candidate)) ?? null;
        return { ...view, comparison: compareRequestPreviews(view, previous),
            diagnosis: buildCacheMissAnalysis(view, { previous, reference, comparison: compareRequestPreviews(view, reference), localize }) };
    });
}

const comparisonText = (value, t = createLocalizer()) => {
    if (value.status === 'no_previous') return t("vertex_paygo.cache_diagnostics.no_previous");
    if (value.status === 'different_epoch') return t("vertex_paygo.cache_diagnostics.different_epoch");
    if (value.status === 'different_scope') return t("vertex_paygo.cache_diagnostics.different_scope");
    if (value.status === 'different_capture') return t("vertex_paygo.cache_diagnostics.different_capture");
    if (value.status !== 'compared') return t("vertex_paygo.cache_diagnostics.comparison_unavailable");
    const exact = value.wireComparison;
    const textComparison = exact ? t("vertex_paygo.cache_diagnostics.exact_prefix", { p0: exact.commonTextChars.toLocaleString() })
        : t("vertex_paygo.cache_diagnostics.no_exact_prefix");
    return t("vertex_paygo.cache_diagnostics.comparison_summary", { p0: value.systemUnchanged ? t("vertex_paygo.cache_diagnostics.same") : t("vertex_paygo.cache_diagnostics.different"), p1: value.previousContentCount, p2: value.currentContentCount, p3: value.commonBlocks, p4: value.commonTextChars, p5: value.parametersComparable ? value.sameParameters ? t("vertex_paygo.cache_diagnostics.same") : t("vertex_paygo.cache_diagnostics.different") : t("vertex_paygo.cache_diagnostics.unknown"), p6: textComparison, p7: value.bounded ? t("vertex_paygo.cache_diagnostics.comparison_bounded") : '' });
};

export function createCacheDiagnosticsUi({ serverClient, getChatId, context, documentRef = globalThis.document,
    coverageNotice = '', coverageSummary = '', localize = createLocalizer((fallback, key) => context?.translate?.(fallback, key) ?? fallback) }) {
    const t = localize;
    const formatComparison = value => comparisonText(value, localize);
    const make = (tag, text = '') => { const node = documentRef.createElement(tag); node.textContent = text; return node; };
    const root = make('section'); root.id = 'vertex-paygo-cache-diagnostics'; root.className = 'vertex-paygo-settings vertex-paygo-log-settings';
    const actions = make('div'); actions.id = `${root.id}-actions`; actions.className = 'vertex-paygo-log-actions';
    const title = make('h4', t("vertex_paygo.cache_diagnostics.title")); title.className = 'vertex-paygo-action-label';
    const tools = make('div'); tools.className = 'vertex-paygo-log-tools';
    const viewButton = make('button'); viewButton.type = 'button'; viewButton.id = `${root.id}-view`;
    viewButton.className = 'menu_button vertex-paygo-icon-button vertex-paygo-log-button';
    viewButton.setAttribute('title', t("vertex_paygo.cache_diagnostics.open")); viewButton.setAttribute('aria-label', t("vertex_paygo.cache_diagnostics.open"));
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
        statusNode.textContent = state === 'loading' ? t("vertex_paygo.cache_diagnostics.loading") : state === 'error' ? t("vertex_paygo.cache_diagnostics.load_retry_viewer") : '';
        statusNode.hidden = !statusNode.textContent;
        session?.viewer.render({ views, selected, state, comparisonText: formatComparison });
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
            coverageNotice, coverageSummary, localize,
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
                if (result?.ok !== true || !Array.isArray(result.records)) throw new Error(t("vertex_paygo.cache_diagnostics.usage_unavailable"));
                views = buildCacheDiagnostics(result.records.filter(record => record?.chatId === chatId), localize);
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
        unmount = mountExtensionSettings(root, { documentRef, tab: 'logs', label: t("vertex_paygo.settings.tab.logs"), onShow: onRefresh });
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
