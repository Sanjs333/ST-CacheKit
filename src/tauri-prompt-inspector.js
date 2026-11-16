/* Read-only Tauri native request records. SPDX-License-Identifier: MPL-2.0. */
import { createPromptInspectorUi } from './prompt-inspector-ui.js';
import { mountExtensionSettings } from './extension-settings.js';
import { createLocalizer } from './i18n.js';

export const TAURI_PROMPT_INSPECTOR_NOTICE = 'TauriTavern 全局模型日志，未关联当前聊天，未追踪提示词来源或构建阶段。JSON 由宿主整理，可能省略媒体与模型私有续接状态；无法核验逐字节网络请求。';
const INDEX_LIMIT = 64;
const MAX_RECORD_CODE_UNITS = 16 * 1024 * 1024;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const label = (value, limit) => typeof value === 'string' && value.length <= limit ? value : null;
const SOURCES = new Map([['vertexai', 'Vertex AI'], ['makersuite', 'Google AI Studio'],
    ['custom', '自定义'], ['openai', 'OpenAI'], ['claude', 'Claude']]);

function safeEndpoint(value) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol)) return null;
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.toString();
    } catch { return null; }
}

function indexEntry(value) {
    const model = value?.model == null || value.model === '' ? null : value.model;
    if (!value || !positiveId(value.id) || !Number.isSafeInteger(value.timestampMs)
        || !Number.isFinite(new Date(value.timestampMs).getTime())
        || typeof value.ok !== 'boolean' || typeof value.stream !== 'boolean'
        || !label(value.source, 128) || (model !== null && label(model, 512) === null)) return null;
    return Object.freeze({ id: value.id, timestampMs: value.timestampMs, ok: value.ok,
        source: value.source, model, stream: value.stream,
        level: ['INFO', 'WARN', 'ERROR'].includes(value.level) ? value.level : null,
        durationMs: Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : null,
        endpoint: safeEndpoint(value.endpoint) });
}

export function supportsTauriPromptInspector(api) {
    return typeof api?.dev?.llmApiLogs?.index === 'function' && typeof api.dev.llmApiLogs.getRaw === 'function';
}

/** A selected native log is never inferred to belong to the active chat. */
export function createTauriPromptInspectorController({ api, indexLimit = INDEX_LIMIT,
    maxRecordCodeUnits = MAX_RECORD_CODE_UNITS } = {}) {
    if (!Number.isSafeInteger(indexLimit) || indexLimit < 1 || indexLimit > 256
        || !Number.isSafeInteger(maxRecordCodeUnits) || maxRecordCodeUnits < 1) {
        throw new TypeError('Tauri 请求记录的容量限制无效。');
    }
    const logs = api?.dev?.llmApiLogs;
    const supported = supportsTauriPromptInspector(api);
    const listeners = new Set();
    let entries = new Map(), liveEntries = new Map(), filters = { source: '', model: '' };
    let selectedId = null, record = null, error = null, status = supported ? 'idle' : 'unavailable';
    let enabled = true, destroyed = false, readSerial = 0, indexSerial = 0, liveRevision = 0;
    let subscriptionSerial = 0, subscriptionPending = false, unsubscribe = null;
    const emit = () => { for (const fn of listeners) try { fn(); } catch {} };
    const sorted = () => [...entries.values()].sort((left, right) => right.timestampMs - left.timestampMs || right.id - left.id);
    const visible = () => sorted().filter(entry => (!filters.source || entry.source === filters.source)
        && (filters.model === '' || entry.model === filters.model));
    const availableSelection = () => selectedId !== null && visible().some(entry => entry.id === selectedId);
    function releaseSelection() {
        readSerial++; selectedId = null; record = null; error = null;
        status = !enabled ? 'disabled' : supported ? 'idle' : 'unavailable';
    }
    function trimEntries() {
        entries = new Map(sorted().slice(0, indexLimit).map(entry => [entry.id, entry]));
        if (selectedId !== null && !availableSelection()) releaseSelection();
    }
    const stopSubscription = () => {
        subscriptionSerial++; subscriptionPending = false;
        const dispose = unsubscribe; unsubscribe = null;
        try { Promise.resolve(dispose?.()).catch(() => {}); } catch { /* Host subscription cleanup cannot affect generation. */ }
    };
    function startSubscription() {
        if (destroyed || !enabled || !supported || unsubscribe || subscriptionPending
            || typeof logs.subscribeIndex !== 'function') return;
        const serial = ++subscriptionSerial;
        subscriptionPending = true;
        Promise.resolve().then(() => {
            if (destroyed || !enabled || serial !== subscriptionSerial) return null;
            return logs.subscribeIndex(value => {
                if (destroyed || !enabled || serial !== subscriptionSerial) return;
                const entry = indexEntry(value); if (!entry) return;
                liveEntries.set(entry.id, { entry, revision: ++liveRevision });
                while (liveEntries.size > indexLimit) liveEntries.delete(liveEntries.keys().next().value);
                entries.set(entry.id, entry); trimEntries(); emit();
            });
        }).then(dispose => {
            if (destroyed || !enabled || serial !== subscriptionSerial) {
                try { if (typeof dispose === 'function') Promise.resolve(dispose()).catch(() => {}); } catch { /* Late native subscription. */ }
                return;
            }
            subscriptionPending = false;
            if (typeof dispose === 'function') unsubscribe = dispose;
        }).catch(() => {
            if (serial === subscriptionSerial) subscriptionPending = false;
            // Manual index refresh remains available when the live stream cannot start.
        });
    }
    async function select(id) {
        if (destroyed || !enabled || !supported) return null;
        if (id === null || id === '') { releaseSelection(); emit(); return null; }
        if (!positiveId(id) || !visible().some(entry => entry.id === id)) {
            releaseSelection(); status = 'error';
            error = { code: 'NATIVE_RECORD_NOT_LISTED', message: '该记录不在当前日志列表中，请刷新后重新选择。' }; emit(); return null;
        }
        const entry = entries.get(id), serial = ++readSerial;
        selectedId = id; record = null; error = null; status = 'loading'; emit();
        try {
            const raw = await logs.getRaw(id);
            if (destroyed || !enabled || serial !== readSerial || selectedId !== id || !availableSelection()) return null;
            if (raw?.id !== id || typeof raw.requestRaw !== 'string' || !raw.requestRaw.length) {
                throw new TypeError('原生日志未返回请求 JSON。');
            }
            if (raw.requestRaw.length > maxRecordCodeUnits) {
                status = 'oversize'; error = { code: 'RECORD_TOO_LARGE',
                    message: '记录超过查看器内存上限，未保留截断副本。请在 TauriTavern 开发日志面板查看。' };
                emit(); return null;
            }
            const current = entries.get(id) ?? entry;
            record = Object.freeze({ version: 1, id: `tauri-log-${id}`, sequence: id, chatId: null,
                source: current.source, model: current.model, state: current.ok ? 'responded' : 'failed',
                capturedAt: new Date(current.timestampMs).toISOString(), rawRequest: raw.requestRaw, complete: true,
                trace: Object.freeze({ version: 1, complete: false, reason: 'TAURI_NATIVE_LOG_HAS_NO_SOURCE_TRACE',
                    sources: Object.freeze([]), stages: Object.freeze([]), events: Object.freeze([]) }),
                metadata: Object.freeze({ captureKind: 'tauri-log', transport: 'tauri-log', nativeLogId: id,
                    bodyEvidence: 'host-log', logBodyAvailable: true, networkBytesVerified: false,
                    association: 'native-global-log', endpoint: current.endpoint,
                    durationMs: current.durationMs, stream: current.stream, ok: current.ok, level: current.level }) });
            status = 'ready'; emit(); return record;
        } catch {
            if (destroyed || !enabled || serial !== readSerial || selectedId !== id) return null;
            record = null; status = 'error'; error = { code: 'NATIVE_RECORD_UNAVAILABLE',
                message: '无法读取记录，可能已被清理。请刷新列表并重新选择；日志预览不包含完整请求正文。' }; emit(); return null;
        }
    }
    async function refresh({ reloadSelection = true } = {}) {
        if (destroyed || !enabled || !supported) return null;
        startSubscription();
        const serial = ++indexSerial, revision = liveRevision;
        status = 'loading'; error = null; emit();
        try {
            const values = await logs.index({ limit: indexLimit });
            if (destroyed || !enabled || serial !== indexSerial) return null;
            if (!Array.isArray(values)) throw new TypeError('原生请求记录索引无效。');
            const fresh = new Map();
            for (const value of values) { const entry = indexEntry(value); if (entry) fresh.set(entry.id, entry); }
            for (const [id, live] of liveEntries) if (live.revision > revision) fresh.set(id, live.entry);
            entries = fresh; trimEntries();
            status = record ? 'ready' : 'idle'; error = null; emit();
            if (reloadSelection && selectedId !== null) return select(selectedId);
            return visible();
        } catch {
            if (destroyed || !enabled || serial !== indexSerial) return null;
            status = 'error'; error = { code: 'NATIVE_INDEX_UNAVAILABLE', message: '原生请求列表读取失败，请刷新重试。' }; emit(); return null;
        }
    }
    return {
        snapshot: () => ({ supported: supported && !destroyed, backendAvailable: supported && !destroyed,
            sourceAvailable: false, enabled: enabled && !destroyed, status, error, record,
            recordAvailable: Boolean(record), selectedId, filters: { ...filters }, index: sorted(), records: visible(),
            privacyMode: 'tauri-native-log', persistence: { status: 'memory-only' }, notice: TAURI_PROMPT_INSPECTOR_NOTICE }),
        subscribe(fn) {
            if (typeof fn !== 'function') throw new TypeError('缺少事件监听函数。');
            if (destroyed) return () => {};
            listeners.add(fn); return () => listeners.delete(fn);
        },
        select, refresh,
        setFilters(value = {}) {
            const source = value.source ?? filters.source;
            const model = Object.prototype.hasOwnProperty.call(value, 'model') ? value.model : filters.model;
            if (label(source, 128) === null || (model !== null && label(model, 512) === null)) throw new TypeError('请求记录筛选条件无效。');
            if (destroyed) return;
            if (source !== filters.source || model !== filters.model) { filters = { source, model }; releaseSelection(); emit(); }
        },
        clear() { if (!destroyed) { releaseSelection(); emit(); } return Promise.resolve(); },
        setEnabled(value) {
            if (destroyed) return false;
            enabled = value === true; indexSerial++; stopSubscription(); releaseSelection(); emit(); return enabled;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true; indexSerial++; releaseSelection(); stopSubscription();
            entries.clear(); liveEntries.clear(); listeners.clear();
        },
    };
}

/** Optional tool; absence of native dev APIs does not affect requests or costs. */
export function createTauriPromptInspector({ context, api, documentRef = globalThis.document,
    clipboard = globalThis.navigator?.clipboard, controller: suppliedController,
    localize = createLocalizer((fallback, key) => context?.translate?.(fallback, key)) } = {}) {
    const controller = suppliedController ?? createTauriPromptInspectorController({ api });
    const make = (tag, value = '', attrs = {}) => {
        const node = documentRef.createElement(tag); if (value) node.textContent = value;
        for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, String(val));
        return node;
    };
    const root = make('section', '', { class: 'vertex-paygo-settings vertex-paygo-log-settings',
        id: 'vertex-paygo-tauri-request-records' });
    let viewer, unmount, unsubscribe, destroyed = false;
    const disposers = [];
    const listen = (node, event, fn) => { node.addEventListener(event, fn); disposers.push(() => node.removeEventListener(event, fn)); };
    try {
        viewer = createPromptInspectorUi({ controller, mountPoint: root, context, documentRef, clipboard, presentation: 'tauri-log' });
        root.append(make('small', TAURI_PROMPT_INSPECTOR_NOTICE, { class: 'vertex-paygo-guidance' }));
        const filters = make('div', '', { class: 'vertex-paygo-tauri-record-filters' });
        const source = make('select', '', { class: 'text_pole', 'aria-label': '请求来源', 'data-tauri-record-source': '' });
        const model = make('select', '', { class: 'text_pole', 'aria-label': '请求模型', 'data-tauri-record-model': '' });
        for (const [control, name] of [[source, '来源'], [model, '模型']]) {
            const row = make('label', '', { class: 'vertex-paygo-cache-selector' });
            row.append(make('span', name), control); filters.append(row);
        }
        const record = make('select', '', { class: 'text_pole', 'aria-label': '选择原生请求记录', 'data-tauri-record-id': '' });
        const recordRow = make('label', '', { class: 'vertex-paygo-cache-selector' });
        recordRow.append(make('span', '记录'), record);
        const refresh = make('button', '', { type: 'button', class: 'vertex-paygo-icon-button vertex-paygo-log-tool',
            title: localize('vertex_paygo.tauri_records.refresh'), 'aria-label': localize('vertex_paygo.tauri_records.refresh') });
        refresh.append(make('i', '', { class: 'fa-solid fa-rotate-right', 'aria-hidden': 'true' }));
        const actions = make('div', '', { class: 'vertex-paygo-pi-controls vertex-paygo-tauri-record-actions' });
        actions.append(refresh);
        const status = make('small', '', { class: 'vertex-paygo-status', role: 'status', 'aria-live': 'polite' });
        actions.append(status); root.append(filters, recordRow, actions);
        const option = (value, text) => make('option', text, { value });
        const render = () => {
            if (destroyed) return;
            const state = controller.snapshot();
            const sources = [...new Set(state.index.map(entry => entry.source))];
            if (state.filters.source && !sources.includes(state.filters.source)) sources.push(state.filters.source);
            source.replaceChildren(option('', '全部来源'), ...sources.map(value => option(value, SOURCES.get(value) ?? value)));
            source.value = state.filters.source;
            const models = [...new Set(state.index.filter(entry => !state.filters.source || entry.source === state.filters.source).map(entry => entry.model))];
            if (state.filters.model !== '' && !models.includes(state.filters.model)) models.push(state.filters.model);
            model.replaceChildren(option('', '全部模型'), ...models.map(value => option(JSON.stringify(value), value === null ? '模型未标注' : value)));
            model.value = state.filters.model === '' ? '' : JSON.stringify(state.filters.model);
            record.replaceChildren(option('', '选择全局模型日志记录'), ...state.records.map(entry => {
                const time = new Date(entry.timestampMs).toLocaleString('zh-CN', { hour12: false });
                return option(String(entry.id), `#${entry.id} · ${time} · ${SOURCES.get(entry.source) ?? entry.source} · ${entry.model ?? '模型未标注'} · ${entry.ok ? '成功' : '失败'}`);
            }));
            record.value = state.selectedId === null ? '' : String(state.selectedId);
            source.disabled = model.disabled = !state.supported || !state.enabled;
            record.disabled = !state.supported || !state.enabled || !state.records.length;
            refresh.disabled = !state.supported || !state.enabled || state.status === 'loading';
            status.textContent = !state.supported ? '当前 TauriTavern 缺少原生请求日志读取接口；其他功能可正常使用。'
                : state.error?.message || (state.status === 'loading' ? '正在读取原生日志…'
                    : `${state.records.length} 条匹配记录。选择后点击查看按钮；列表包含全局模型请求。`);
        };
        listen(source, 'change', () => controller.setFilters({ source: source.value, model: '' }));
        listen(model, 'change', () => controller.setFilters({ model: model.value === '' ? '' : JSON.parse(model.value) }));
        listen(record, 'change', () => { void controller.select(record.value === '' ? null : Number(record.value)); });
        listen(refresh, 'click', () => { void controller.refresh(); });
        unsubscribe = controller.subscribe(render);
        unmount = mountExtensionSettings(root, { documentRef, tab: 'logs', label: '日志', onShow: () => { void controller.refresh({ reloadSelection: false }); } });
        render();
        return { root, controller, render, open: viewer.open, refresh: controller.refresh, clear: controller.clear,
            destroy() {
                if (destroyed) return;
                destroyed = true; viewer.destroy(); unsubscribe?.();
                for (const dispose of disposers) dispose(); controller.destroy(); unmount();
            } };
    } catch (error) {
        destroyed = true; viewer?.destroy(); unsubscribe?.();
        for (const dispose of disposers) dispose(); controller.destroy(); unmount?.(); root.remove(); throw error;
    }
}
