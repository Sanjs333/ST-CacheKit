/* SPDX-License-Identifier: MPL-2.0 */
import { buildPromptInspectorView, comparePromptInspectorStages } from './prompt-inspector-model.js';
import { mountExtensionSettings } from './extension-settings.js';
import { bindExtensionTheme } from './theme.js';
import { createExtensionDialog } from './dialog.js';
import { describePromptSource, isInternalControlSource } from './prompt-inspector-sources.js';

const TITLE = '上一轮提示词';
const KINDS = new Map([
    ['preset', '预设'], ['character', '角色'], ['persona', '用户资料'],
    ['worldinfo-blue', '世界书 · 蓝灯'], ['worldinfo-green', '世界书 · 绿灯'],
    ['worldinfo-depth', '世界书 · @D'], ['worldinfo-an-before', '世界书 · 作者注释前'],
    ['worldinfo-an-after', '世界书 · 作者注释后'], ['worldinfo-other', '世界书'], ['author-note', '作者注释'],
    ['memory', '记忆'], ['extension', '扩展'], ['history', '聊天消息'], ['input', '本轮输入'], ['unknown', '来源待确认'],
]);
const BLOCKED = new Set(['expired', 'expiry', 'oversize', 'unavailable', 'disabled']);
const asArray = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const excerpt = (value, limit = 110) => value.length > limit ? value.slice(0, limit) + '…' : value;
const positionNumber = value => (typeof value === 'number' || (typeof value === 'string' && /^-?\d+$/u.test(value)))
    && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const categoryOf = source => {
    source = source ? { ...source, ...describePromptSource(source) } : source;
    if (typeof source?.kind === 'string' && source.kind.startsWith('worldinfo-')) {
        const position = positionNumber(source.position);
        if (position === 2) return 'worldinfo-an-before';
        if (position === 3) return 'worldinfo-an-after';
        if (position === 4) return 'worldinfo-depth';
        if (source.kind === 'worldinfo-depth') return 'worldinfo-other';
    }
    return KINDS.has(source?.kind) ? source.kind : 'unknown';
};
const sourceLabel = source => describePromptSource(source).label;
const WARNING_LABELS = new Map([
    ['unknown-source-ranges', '部分正文暂时无法确认来自哪个预设、世界书条目或扩展。'],
    ['provenance-trace-incomplete', '部分来源资料未收集到；已捕获的发送正文不受影响。'],
    ['ambiguous-source-match', '同一段文字重复出现，暂时无法确定对应哪个来源或正文位置。'],
    ['final-body-unavailable', '尚未捕获最终发送正文；不使用前端快照代替。'],
    ['final-body-incomplete', '最终正文未完整确认。'],
    ['malformed-request-json', '原始请求不是有效 JSON；按未知结构保留，仍可精确复制 raw。'],
    ['unknown-request-shape', '请求形状未识别；不猜测消息或角色。'],
    ['missing-message-role', '消息 role 缺失或为空；不猜测实际角色。'],
    ['source-match-work-limit', '来源匹配达到计算上限；其余片段保留为未确认。'],
    ['stage-comparison-bounded', '阶段差异预览达到计算上限。'],
    ['compound-content-raw-backed', '部分内容含附加结构，可展开查看。'],
    ['duplicate-or-reserved-stage-id', '部分阶段编号相同，查看器已自动区分；不影响发送正文。'],
    ['invalid-trace-sources', '来源资料格式不完整。'],
    ['invalid-or-duplicate-source', '部分来源资料无效或编号重复，未用于正文定位。'],
    ['invalid-trace-stages', '构建阶段资料格式不完整。'],
    ['invalid-trace-stage', '某个阶段缺少可读取的消息快照。'],
    ['invalid-trace-events', '变化记录格式不完整。'],
    ['unverified-trace-event', '有些变化未经核验，未作为已确认的改动显示。'],
    ['source-annotation-work-limit', '来源标注达到处理上限，其余内容仍按原文显示。'],
    ['stage-comparison-count-limit', '构建阶段较多，只比较部分阶段；原始请求保持不变。'],
    ['stage-comparison-unavailable', '部分阶段无法比较，仍可查看已记录的内容。'],
    ['record-unavailable', '暂无可读取的发送记录。'],
    ['invalid-raw-request', '原始请求格式无效，无法确认为完整正文。'],
    ['final-body-oversize', '请求超过临时记录上限，未保留完整正文。'],
    ['raw-request-parse-limit', '请求较大，已停止结构解析；仍可查看和复制原始请求。'],
]);
const warningLabel = (value, recordName = '原始请求') => WARNING_LABELS.get(value)
    ?? (/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(value) ? `部分内容无法按消息展示；可查看${recordName}。` : value);
const REQUEST_STATES = new Map([
    ['observed', '已记录组装结果'],
    ['pending', '等待发送'], ['dispatched', '已发送，等待响应'], ['responded', '已响应'],
    ['failed', '请求失败'], ['oversize', '超出记录上限'],
]);
const CHANNELS = new Map([
    ['custom', '自定义'], ['vertexai', '谷歌云'], ['makersuite', '谷歌 AI 工作室'],
    ['openai', 'OpenAI'], ['claude', 'Claude'],
]);
const TRANSPORTS = new Map([
    ['native', '酒馆原生请求'], ['google-proxy', '谷歌代理请求'], ['google-gemini4', 'Gemini 4 请求'],
    ['native-loopback-http', '酒馆原生请求（插件记录）'],
    ['frontend', '前端发送消息观察'],
    ['tauri-frontend', 'Tauri 请求提交前'], ['tauri-agent-artifact', 'Agent 保存的初始输入'],
]);
const STAGES = new Map([
    ['assembled', '原生首次组装'], ['post-plugin', '插件处理后'], ['frontend-final', '前端最终组装'],
    ['frontend-request', '发送前'], ['pre-dispatch', '发送前'], ['backend-final', '实际发送正文'],
    ['settings-ready', '请求参数就绪事件'],
]);
const stageLabel = stage => stage?.origin === 'trace' && stage?.originalId === 'backend-final'
    ? '后端发送快照' : STAGES.get(stage?.originalId ?? stage?.id) ?? (text(stage?.label) || text(stage?.id));
const SOURCE_WARNINGS = new Set(['unknown-source-ranges', 'provenance-trace-incomplete', 'ambiguous-source-match',
    'invalid-trace-sources', 'invalid-or-duplicate-source', 'source-match-work-limit', 'source-annotation-work-limit']);
const DETAIL_WARNINGS = new Set(['duplicate-or-reserved-stage-id', 'invalid-trace-stages', 'invalid-trace-stage',
    'invalid-trace-events', 'unverified-trace-event', 'stage-comparison-count-limit', 'stage-comparison-unavailable',
    'stage-comparison-bounded', 'compound-content-raw-backed']);
const WORLD_POSITIONS = new Map([[0, '角色定义前'], [1, '角色定义后'], [2, '作者注释前'], [3, '作者注释后'],
    [4, '按聊天深度插入（@D）'], [5, '示例对话前'], [6, '示例对话后'], [7, '自定义出口']]);
const ROLE_LABELS = new Map([['system', '系统'], ['user', '用户'], ['assistant', '助手'], ['model', '助手'],
    ['developer', '开发者'], ['tool', '工具'], ['function', '工具']]);
const ROLE_ICONS = new Map([['system', 'fa-gear'], ['user', 'fa-user'], ['assistant', 'fa-robot'], ['model', 'fa-robot']]);
const configuredRole = source => {
    if (typeof source.role === 'string' && ROLE_LABELS.has(source.role)) return ROLE_LABELS.get(source.role);
    // World-info / extension role enums differ from the actual outbound string roles.
    if (typeof source.kind === 'string' && (source.kind.startsWith('worldinfo-')
        || ['extension', 'memory', 'author-note'].includes(source.kind))) {
        return new Map([[0, '系统'], [1, '用户'], [2, 'AI']]).get(positionNumber(source.role)) ?? '';
    }
    return '';
};
const sourcePlacement = source => {
    const position = positionNumber(source.position);
    if (typeof source.kind === 'string' && source.kind.startsWith('worldinfo-')) {
        return { label: WORLD_POSITIONS.get(position) ?? '', depth: position === 4, role: position === 4 };
    }
    if (typeof source.identifier === 'string' || source.id?.startsWith('prompt:')) {
        return { label: new Map([[0, '预设顺序'], [1, '按聊天深度插入']]).get(position) ?? '', depth: position === 1, role: true };
    }
    if (['extension', 'memory', 'author-note'].includes(source.kind)) {
        return { label: new Map([[-1, '不注入'], [0, '主提示词内'], [1, '按聊天深度插入'], [2, '主提示词前']]).get(position) ?? '',
            depth: position === 1, role: position === 1 };
    }
    return { label: '', depth: false, role: false };
};
const ACTION_ICONS = new Map([
    ['drawer', 'fa-list-ul'], ['drawer-close', 'fa-xmark'], ['fold-toggle', 'fa-compress'],
    ['copy-text', 'fa-copy'], ['copy-message', 'fa-copy'], ['copy-raw', 'fa-copy'],
    ['source-locate', 'fa-location-dot'], ['filter-reset', 'fa-filter-circle-xmark'],
]);
let nextId = 0;

// Read-only previews are bounded. Media bytes are never put in a URL, image or iframe.
function inspect(value, limit = 16000, recordName = '原始请求') {
    const seen = new WeakSet();
    try {
        const result = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => {
            if (item && typeof item === 'object') {
                if (seen.has(item)) return '[circular]';
                seen.add(item);
            }
            if (typeof item === 'string' && item.length > limit) return item.slice(0, limit) + `… [预览截短；${recordName}不变]`;
            return typeof item === 'bigint' ? String(item) : item;
        }, 2);
        return excerpt(result ?? 'null', limit);
    } catch { return `无法显示此结构；请查看${recordName}。`; }
}

function messageText(message) {
    const collect = parts => asArray(parts).flatMap(part => typeof part?.text === 'string'
        ? [part.text] : collect(part?.parts));
    return collect(message?.parts).join('\n');
}

function validSegments(part, sources) {
    const length = part.text?.length ?? 0;
    return asArray(part.segments).filter(segment => segment?.verified === true && Number.isInteger(segment.start)
        && Number.isInteger(segment.end) && segment.start >= 0 && segment.end > segment.start && segment.end <= length)
        .map(segment => ({ ...segment, sourceIds: asArray(segment.sourceIds).filter(id => sources.has(id)) }))
        .filter(segment => segment.sourceIds.length);
}

function messageSources(message, sources) {
    const ids = new Set();
    let unknown = false;
    const visit = parts => {
        for (const part of asArray(parts)) {
            if (typeof part?.text === 'string') {
                const segments = validSegments(part, sources).sort((a, b) => a.start - b.start);
                let end = 0;
                for (const segment of segments) {
                    if (segment.start > end) unknown = true;
                    end = Math.max(end, segment.end);
                    for (const id of segment.sourceIds) ids.add(id);
                }
                if (end < part.text.length || !segments.length) unknown = true;
            } else if (asArray(part?.parts).length) visit(part.parts);
            else unknown = true;
        }
    };
    visit(message?.parts);
    return { ids, unknown };
}

/** Read-only viewer in the Logs settings tab by default; never owns the supplied controller. */
export function createPromptInspectorUi({ controller, mountPoint, context, documentRef = globalThis.document,
    clipboard = globalThis.navigator?.clipboard, presentation = 'outbound' } = {}) {
    if (typeof documentRef?.createElement !== 'function'
        || (mountPoint !== undefined && typeof mountPoint?.append !== 'function')) {
        throw new TypeError('A document and an optional valid mount point are required.');
    }
    if (typeof controller?.snapshot !== 'function' || typeof controller?.subscribe !== 'function') {
        throw new TypeError('A prompt inspector controller is required.');
    }
    const doc = documentRef;
    const nativeLog = presentation === 'tauri-log';
    const tauriFrontend = presentation === 'tauri-frontend';
    const frontendLabel = tauriFrontend ? '上一轮提示词' : '前端发送消息';
    const viewerTitle = nativeLog ? 'Tauri 原生请求记录' : TITLE;
    const frontendRecordLabel = record => record?.metadata?.capturePhase === 'agent-initial-snapshot' ? 'Agent 初始提示词'
        : record?.metadata?.capturePhase === 'tauri-dispatch' ? '交给 Tauri 前的请求'
            : record?.metadata?.capturePhase === 'settings-ready' ? '组装事件中的消息' : frontendLabel;
    const recordName = s => nativeLog ? '日志 JSON' : s?.frontend ? tauriFrontend ? '提示词 JSON' : '前端消息 JSON' : '原始请求';
    const requestState = (record, state) => {
        if (tauriFrontend) {
            if (record.metadata?.initialAssemblyOnly === true) return '已读取 Agent 初始组装记录';
            if (record.metadata?.capturePhase === 'settings-ready') return '组装消息已记录，发送未确认';
            if (record.state === 'dispatched') return state.restored ? '已交给 Tauri（响应状态未更新）' : '已交给 Tauri，等待响应';
            if (record.state === 'responded') return 'Tauri 已返回 HTTP 响应';
            if (record.state === 'failed') return 'Tauri 请求失败';
        }
        return state.restored && record.state === 'dispatched' ? '已发送（响应状态未更新）' : REQUEST_STATES.get(record.state) ?? '状态未确认';
    };
    const inspectRecord = (value, s) => inspect(value, 16000, recordName(s));
    const displayStageLabel = (stage, s) => s?.frontend && stage?.id === 'frontend-request' ? frontendRecordLabel(s.record)
        : nativeLog && (stage?.originalId ?? stage?.id) === 'backend-final' ? '宿主请求 JSON 记录' : stageLabel(stage);
    const displayWarning = (code, s) => s?.frontend ? new Map([
        ['malformed-request-json', '前端消息快照不是有效 JSON；仍可查看原文。'],
        ['unknown-request-shape', '前端消息结构未识别；可查看前端消息 JSON。'],
        ['invalid-raw-request', '没有可读取的前端消息快照。'],
        ['final-body-unavailable', '尚未记录前端发送消息。'],
        ['final-body-incomplete', '前端消息快照未完整读取。'],
        ['raw-request-parse-limit', '消息较大，已停止结构解析；仍可查看前端消息 JSON。'],
    ]).get(code) ?? warningLabel(code, '前端消息 JSON') : nativeLog ? new Map([
        ['malformed-request-json', '宿主记录不是有效 JSON；仍可查看和复制日志文本。'],
        ['unknown-request-shape', '宿主日志的请求结构未识别，可查看日志 JSON。'],
        ['invalid-raw-request', '宿主没有返回可读取的日志正文。'],
        ['final-body-unavailable', '尚未读取宿主请求记录。'],
        ['final-body-incomplete', '宿主日志记录未完整读取。'],
        ['final-body-oversize', '宿主日志超过查看上限，未保留截断正文。'],
        ['record-unavailable', '暂无可读取的宿主请求记录。'],
        ['raw-request-parse-limit', '记录较大，已停止结构解析；仍可查看和复制日志 JSON。'],
    ]).get(code) ?? warningLabel(code, '日志 JSON') : warningLabel(code);
    const prefix = `vertex-paygo-pi-${++nextId}`;
    const make = (tag, name = '', value, attrs = {}) => {
        const node = doc.createElement(tag);
        if (name) node.className = name;
        if (value !== undefined) node.textContent = String(value);
        for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, String(val));
        return node;
    };
    let disposed = false, session = null, unsubscribe;
    const settings = make('section', 'vertex-paygo-settings vertex-paygo-log-settings', undefined,
        { id: tauriFrontend ? 'vertex-paygo-tauri-frontend-inspector-settings' : 'vertex-paygo-prompt-inspector-settings' });
    const actions = make('div', 'vertex-paygo-log-actions', undefined,
        { id: tauriFrontend ? 'vertex-paygo-tauri-frontend-inspector-actions' : 'vertex-paygo-prompt-inspector-actions' });
    const title = make('h4', 'vertex-paygo-action-label', viewerTitle);
    const tools = make('div', 'vertex-paygo-log-tools');
    const launch = make('button', 'menu_button vertex-paygo-icon-button vertex-paygo-log-button vertex-paygo-prompt-inspector-launch', undefined,
        { type: 'button', title: viewerTitle, 'aria-label': viewerTitle, 'data-pi-action': 'open', 'aria-haspopup': 'dialog' });
    launch.append(make('i', 'fa-solid fa-file-lines', undefined, { 'aria-hidden': 'true' }));
    tools.append(launch); actions.append(title, tools); settings.append(actions);
    let unmount;
    if (mountPoint) { mountPoint.append(settings); unmount = () => settings.remove(); }
    else { unmount = mountExtensionSettings(settings, { documentRef: doc, tab: 'logs', label: '日志' }); }
    const readState = () => {
        try { return controller.snapshot() ?? {}; }
        catch { return { supported: false, enabled: false, status: 'error', error: { message: '无法读取查看器状态。' } }; }
    };
    const listen = (s, node, event, callback, dynamic = false) => {
        node.addEventListener(event, callback);
        (dynamic ? s.dynamic : s.listeners).push(() => node.removeEventListener(event, callback));
    };
    const notify = (s, value, error = false) => {
        if (disposed || session !== s) return;
        s.feedback.textContent = value;
        s.feedback.setAttribute('data-tone', error ? 'error' : 'normal');
    };
    const action = async (s, kind, fn) => {
        if (disposed || session !== s || s.busy) return;
        s.busy = kind;
        notify(s, kind === 'clear' ? nativeLog ? '正在释放本页查看副本…' : '正在清除临时记录…' : '正在更新…');
        render();
        try { await fn(); if (session === s) notify(s, kind === 'clear'
            ? nativeLog ? '本页查看副本已释放，宿主日志仍保留。' : '临时记录已清除。' : '状态已更新。'); }
        catch { notify(s, '操作失败；不会影响生成。请重试。', true); }
        finally { s.busy = ''; if (session === s && !disposed) render(); }
    };
    const copy = async (s, value, label) => {
        if (disposed || session !== s || typeof value !== 'string') return;
        try {
            if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard');
            // No role/source labels, pretty-printing or normalization of raw bytes.
            await clipboard.writeText(value);
            notify(s, `已复制${label}。`);
        } catch { notify(s, '复制不可用；可选择文本手动复制。', true); }
    };
    const button = (s, label, name, fn, dynamic = false) => {
        const icon = ACTION_ICONS.get(name);
        const node = make('button', `menu_button vertex-paygo-pi-button${icon ? ' vertex-paygo-pi-icon-action' : ''}`, icon ? undefined : label,
            { type: 'button', 'data-pi-action': name, 'aria-label': label, title: label });
        if (icon) node.append(make('i', `fa-solid ${icon}`, undefined, { 'aria-hidden': 'true' }));
        listen(s, node, 'click', fn, dynamic);
        return node;
    };
    function disposeSession(s) {
        if (session !== s) return;
        session = null;
        s.theme?.destroy();
        for (const dispose of [...s.dynamic, ...s.listeners]) dispose();
        s.dynamic = []; s.listeners = [];
        s.root.replaceChildren(); s.root.remove();
        s.dialog?.remove?.();
        s.view = null; s.record = null;
        s.sources?.clear(); s.diffs.clear();
        s.cachedRecord = null; s.cachedKey = null; s.cachedView = null;
        for (const node of [s.panel, s.sidebar, s.metadata, s.notice, s.chips, s.empty, s.feedback]) node?.replaceChildren();
        s.targets.clear(); s.collapsed.clear();
        launch.focus?.();
    }
    function close(s) {
        if (session !== s) return;
        if (s.popup) {
            try {
                const pending = s.popup.complete?.(context?.POPUP_RESULT?.NEGATIVE ?? 0);
                pending?.catch?.(() => {});
                if (typeof s.popup.complete !== 'function') s.popup.closeButton?.click?.();
            } catch {                                                         }
        } else { try { s.dialog?.close?.(); } catch {                                 } }
        disposeSession(s);
    }
    function buildSession() {
        const compactViewport = doc.defaultView?.matchMedia?.('(max-width: 680px)');
        const s = { listeners: [], dynamic: [], view: null, record: null, key: null,
            tab: 'final', query: '', category: 'all', selected: null, collapsed: new Set(),
            frontend: !nativeLog && readState().captureKind === 'frontend-messages',
            targets: new Map(), busy: '', compact: compactViewport?.matches === true,
            drawer: !nativeLog && compactViewport?.matches !== true, before: '', after: '',
            cachedRecord: null, cachedKey: null, cachedView: null, diffs: new Map() };
        s.root = make('section', 'vertex-paygo-prompt-inspector', undefined,
            { 'aria-label': viewerTitle, 'data-pi-viewer': '', lang: 'zh-CN' });
        const header = make('header', 'vertex-paygo-pi-header');
        const heading = make('div', 'vertex-paygo-pi-heading');
        const titles = make('div', 'vertex-paygo-pi-titles');
        s.badge = make('span', 'vertex-paygo-pi-status', '', { role: 'status', 'data-pi-status': '' });
        titles.append(make('h2', '', viewerTitle), s.badge);
        const dismiss = make('button', 'vertex-paygo-icon-button vertex-paygo-log-tool vertex-paygo-log-close', undefined,
            { type: 'button', title: '关闭提示词查看器', 'aria-label': '关闭提示词查看器', 'data-pi-action': 'close' });
        dismiss.append(make('i', 'fa-solid fa-xmark', undefined, { 'aria-hidden': 'true' }));
        listen(s, dismiss, 'click', () => close(s));
        s.metadata = make('dl', 'vertex-paygo-pi-metadata', undefined, { 'data-pi-metadata': '' });
        const controls = make('div', 'vertex-paygo-pi-controls');
        s.refresh = make('button', 'vertex-paygo-icon-button vertex-paygo-log-tool', undefined,
            { type: 'button', title: '刷新状态', 'aria-label': '刷新状态', 'data-pi-action': 'refresh' });
        s.refresh.append(make('i', 'fa-solid fa-rotate-right', undefined, { 'aria-hidden': 'true' }));
        listen(s, s.refresh, 'click', () => action(s, 'refresh', () => controller.refresh()));
        s.clear = make('button', 'vertex-paygo-icon-button vertex-paygo-log-tool', undefined,
            { type: 'button', title: nativeLog ? '释放本页所选日志的查看副本；宿主日志由 TauriTavern 保留。'
                : tauriFrontend ? '清除当前聊天上一轮提示词及其保存副本；其他聊天不受影响。'
                    : '清除当前聊天记录：同时删除当前聊天与连接的保存副本，不影响其他聊天。',
                'aria-label': nativeLog ? '释放本页查看副本' : '清除临时记录', 'data-pi-action': 'clear' });
        s.clear.append(make('i', 'fa-solid fa-eraser', undefined, { 'aria-hidden': 'true' }));
        listen(s, s.clear, 'click', () => action(s, 'clear', () => controller.clear()));
        controls.append(s.refresh, s.clear, dismiss);
        heading.append(titles, controls);
        const metaDisclosure = make('details', 'vertex-paygo-pi-meta-disclosure');
        s.metaSummary = make('summary', '', nativeLog ? '宿主记录信息' : tauriFrontend ? '组装记录信息' : '发送与响应信息');
        metaDisclosure.append(s.metaSummary, s.metadata);
        s.metaDisclosure = metaDisclosure;
        header.append(heading, metaDisclosure);
        s.notice = make('div', 'vertex-paygo-pi-notice', '', { role: 'status', 'data-pi-notice': '' });
        const work = make('div', 'vertex-paygo-pi-work');
        s.work = work;
        const tabs = make('div', 'vertex-paygo-pi-tabs', undefined, { role: 'tablist', 'aria-label': '查看方式' });
        s.tabs = new Map();
        const viewTabs = nativeLog ? [['final', '请求正文'], ['raw', '日志 JSON']]
            : [['final', s.frontend ? frontendLabel : '最终发送'], ['sources', '来源与变化'], ['compare', '阶段对比'],
                ['raw', s.frontend ? '前端消息 JSON' : '原始请求']];
        for (const [id, label] of viewTabs) {
            const node = button(s, label, `tab-${id}`, () => switchTab(s, id));
            node.setAttribute('role', 'tab'); node.setAttribute('id', `${prefix}-tab-${id}`);
            node.setAttribute('aria-controls', `${prefix}-panel`);
            listen(s, node, 'keydown', event => {
                const ids = [...s.tabs.keys()]; let index = ids.indexOf(s.tab);
                if (event.key === 'ArrowRight') index = (index + 1) % ids.length;
                else if (event.key === 'ArrowLeft') index = (index + ids.length - 1) % ids.length;
                else if (event.key === 'Home') index = 0;
                else if (event.key === 'End') index = ids.length - 1;
                else return;
                event.preventDefault(); switchTab(s, ids[index]); s.tabs.get(ids[index]).focus?.();
            });
            s.tabs.set(id, node); tabs.append(node);
        }
        const tools = make('div', 'vertex-paygo-pi-tools');
        s.search = make('input', 'text_pole vertex-paygo-pi-search', undefined,
            { type: 'search', placeholder: nativeLog ? '搜索日志中的文本或角色…' : '搜索实际文本、角色或来源…',
                'aria-label': '搜索提示词', 'data-pi-search': '', autocomplete: 'off' });
        listen(s, s.search, 'input', () => { s.query = s.search.value; renderContent(s); });
        s.drawerButton = button(s, '来源目录', 'drawer', () => {
            s.drawer = !s.drawer; updateDrawer(s);
            if (s.drawer) s.sidebar.focus?.({ preventScroll: true });
        });
        s.drawerButton.setAttribute('aria-controls', `${prefix}-sidebar`);
        s.drawerButton.hidden = nativeLog;
        s.foldToggle = button(s, '全部展开', 'fold-toggle', () => {
            const { details, allOpen } = panelFoldState(s);
            if (!details.length || s.tab === 'raw') return;
            const open = !allOpen;
            for (const node of details) node.open = open;
            for (const { node, key } of s.disclosures) node.open ? s.collapsed.delete(key) : s.collapsed.add(key);
            updateFoldToggle(s);
        });
        s.foldIcon = s.foldToggle.children[0];
        s.copyText = button(s, nativeLog ? '复制记录纯文本' : '复制本轮纯文本', 'copy-text', () => {
            if (s.view) return copy(s, asArray(s.view.messages).map(messageText).join('\n\n'), '纯文本（不含媒体、角色或来源标签）');
        });
        s.copyText.setAttribute('title', nativeLog ? '只复制文本 parts；不含媒体、角色或来源标签；日志 JSON 可单独复制。'
            : s.frontend ? '只复制前端消息中的文本 parts；前端消息 JSON 可单独复制。'
            : '只复制文本 parts；不含媒体、角色或来源标签；不是原始请求。');
        tools.append(s.search, s.drawerButton, s.foldToggle, s.copyText);
        s.chips = make('nav', 'vertex-paygo-pi-chips', undefined, { 'aria-label': '来源类别' });
        const layout = make('div', 'vertex-paygo-pi-layout'); s.layout = layout;
        s.sidebar = make('aside', 'vertex-paygo-pi-sidebar', undefined,
            { id: `${prefix}-sidebar`, 'aria-label': '来源目录', 'data-pi-sidebar': '', tabindex: '-1' });
        s.panel = make('div', 'vertex-paygo-pi-panel', undefined,
            { id: `${prefix}-panel`, role: 'tabpanel', tabindex: '0', 'data-pi-panel': '' });
        const onPanelToggle = event => {
            if (event.target?.tagName === 'DETAILS' && s.panel.contains(event.target)) updateFoldToggle(s);
        };
        s.panel.addEventListener('toggle', onPanelToggle, true);
        s.listeners.push(() => s.panel.removeEventListener('toggle', onPanelToggle, true));
        layout.append(s.sidebar, s.panel); work.append(tabs, tools, s.chips, layout);
        s.empty = make('div', 'vertex-paygo-pi-empty', undefined, { 'data-pi-empty': '' });
        const footer = make('footer', 'vertex-paygo-pi-footer');
        s.counter = make('span', '', '', { 'data-pi-count': '' });
        s.feedback = make('span', '', '', { role: 'status', 'aria-live': 'polite', 'data-pi-feedback': '' });
        footer.append(s.counter, s.feedback); s.root.append(header, s.notice, s.empty, work, footer);
        if (compactViewport?.addEventListener) listen(s, compactViewport, 'change', event => {
            s.compact = event.matches; s.drawer = !s.compact; updateDrawer(s);
            if (!s.drawer && s.sidebar.contains(doc.activeElement)) s.drawerButton.focus?.({ preventScroll: true });
        });
        return s;
    }
    function panelDisclosures(s) {
        if (!s.panel) return [];
        if (typeof s.panel.querySelectorAll === 'function') return [...s.panel.querySelectorAll('details')];
        const nodes = [];
        const visit = parent => {
            for (const node of parent.children ?? []) { if (node.tagName === 'DETAILS') nodes.push(node); visit(node); }
        };
        visit(s.panel); return nodes;
    }
    function panelFoldState(s) {
        const details = panelDisclosures(s);
        const primary = (s.disclosures ?? []).map(({ node }) => node).filter(node => s.panel?.contains(node));
        // Closed parameter/tool details must not override the visible content's fold state.
        const controls = primary.length ? primary : details;
        return { details, allOpen: controls.length > 0 && controls.every(node => node.open) };
    }
    function updateFoldToggle(s) {
        const { details, allOpen } = panelFoldState(s);
        const label = allOpen ? '全部折叠' : '全部展开';
        s.foldToggle.disabled = s.tab === 'raw' || !details.length;
        s.foldToggle.setAttribute('data-pi-fold-mode', allOpen ? 'collapse' : 'expand');
        s.foldToggle.setAttribute('title', label);
        s.foldToggle.setAttribute('aria-label', label);
        s.foldToggle.setAttribute('aria-expanded', String(allOpen));
        s.foldIcon.className = `fa-solid ${allOpen ? 'fa-expand' : 'fa-compress'}`;
    }
    function updateDrawer(s) {
        if (nativeLog) s.drawer = false;
        s.layout.setAttribute('data-drawer-open', String(s.drawer));
        s.sidebar.hidden = !s.drawer;
        s.drawerButton.setAttribute('aria-expanded', String(s.drawer));
        s.drawerButton.setAttribute('aria-pressed', String(s.drawer));
        s.drawerButton.setAttribute('title', s.drawer ? '收起来源目录' : '打开来源目录');
        s.drawerButton.setAttribute('aria-label', s.drawer ? '收起来源目录' : '打开来源目录');
    }
    function hideDrawer(s) { s.drawer = false; updateDrawer(s); s.drawerButton.focus?.({ preventScroll: true }); }
    function switchTab(s, tab) { s.tab = tab; if (s.compact) s.drawer = false; renderContent(s); s.panel.scrollTop = 0; }
    function disclosure(s, key, label, className = '') {
        const node = make('details', `vertex-paygo-pi-card ${className}`, undefined, { 'data-pi-card': key });
        node.open = !s.collapsed.has(key);
        const summary = make('summary', 'vertex-paygo-pi-card-heading'); summary.append(label); node.append(summary);
        s.disclosures.push({ node, key });
        listen(s, node, 'toggle', () => { node.open ? s.collapsed.delete(key) : s.collapsed.add(key); updateFoldToggle(s); }, true);
        return node;
    }
    function markText(s, parent, value, attrs = {}) {
        const needle = s.queryLower;
        let offset = 0, count = 0;
        const lower = needle ? value.toLocaleLowerCase() : '';
        // Case folding can change Unicode string length; never use shifted offsets.
        const searchable = needle && lower.length === value.length && needle.length === s.query.length;
        while (searchable && count++ < 600) {
            const start = lower.indexOf(needle, offset); if (start < 0) break;
            if (start > offset) parent.append(make('span', '', value.slice(offset, start), attrs));
            parent.append(make('mark', 'vertex-paygo-pi-search-hit', value.slice(start, start + needle.length), attrs));
            offset = start + needle.length;
        }
        if (offset < value.length || !value.length) parent.append(make('span', '', value.slice(offset), attrs));
    }
    function textPart(s, part) {
        const node = make('div', 'vertex-paygo-pi-text', undefined, { 'data-pi-text': '', 'data-pi-part-path': text(part.path) });
        const value = part.text;
        const segments = validSegments(part, s.sources);
        const boundaries = [...new Set([0, value.length, ...segments.flatMap(segment => [segment.start, segment.end])])].sort((a, b) => a - b);
        // Keep exact text even if malformed provenance produces too many boundaries.
        if (boundaries.length > 4096) { markText(s, node, value); return node; }
        if (!value.length) markText(s, node, value);
        for (let index = 0; index < boundaries.length - 1; index++) {
            const start = boundaries[index], end = boundaries[index + 1];
            const ids = [...new Set(segments.filter(segment => segment.start <= start && segment.end >= end).flatMap(segment => segment.sourceIds))];
            const span = make('span', ids.length ? 'vertex-paygo-pi-verified' : 'vertex-paygo-pi-unattributed', undefined,
                { 'data-pi-source-ids': JSON.stringify(ids) });
            if (ids.length) span.setAttribute('title', ids.map(id => sourceLabel(s.sources.get(id))).join(' · '));
            if (ids.includes(s.selected)) span.setAttribute('data-selected', 'true');
            markText(s, span, value.slice(start, end)); node.append(span);
        }
        return node;
    }
    function renderPart(s, part, depth = 0) {
        if (part?.type === 'text' && typeof part.text === 'string' && !part.compound) return textPart(s, part);
        const type = text(part?.type) || 'unknown';
        const node = make('div', 'vertex-paygo-pi-part', undefined, { 'data-pi-part-type': type, 'data-pi-part-path': text(part?.path) });
        const media = /image|audio|video|file|media/u.test(type);
        const tool = /tool|function/u.test(type);
        node.append(make('div', 'vertex-paygo-pi-part-title', `${media ? '▧' : tool ? '⌘' : '◇'} ${type} · 只读`));
        node.append(make('p', 'vertex-paygo-pi-muted', media ? '媒体保持在原位置；不加载链接、不解码内联数据。'
            : tool ? '工具数据仅供检查；不执行工具或其中的代码。' : '结构化 / 未识别内容；不猜测为普通文本。'));
        const raw = part?.raw ?? part;
        if (typeof part?.text === 'string') node.append(textPart(s, part));
        if (media) {
            const safe = {};
            for (const key of ['mimeType', 'mime_type', 'type', 'detail', 'name', 'id']) {
                const val = part?.[key] ?? raw?.[key] ?? raw?.source?.[key] ?? raw?.inlineData?.[key];
                if (text(val)) safe[key] = excerpt(text(val), 180);
            }
            if (Object.keys(safe).length) node.append(make('pre', 'vertex-paygo-pi-structure', inspectRecord(safe, s)));
            node.append(make('small', 'vertex-paygo-pi-muted', s.frontend
                ? '前端保留的媒体信息见「前端消息 JSON」；服务商最终请求暂未捕获。' : nativeLog
                ? '日志中保留的媒体信息见「日志 JSON」；宿主可能已省略内联数据。'
                : '完整媒体描述及数据仅在高级原始请求中可见。'));
        } else {
            const detail = make('details', 'vertex-paygo-pi-part-detail');
            detail.append(make('summary', '', tool ? '查看工具名称 / 参数 / 结果' : '查看原有结构'));
            detail.append(make('pre', 'vertex-paygo-pi-structure', inspectRecord(raw, s))); node.append(detail);
        }
        if (depth < 8) for (const nested of asArray(part?.parts)) node.append(renderPart(s, nested, depth + 1));
        else if (asArray(part?.parts).length) node.append(make('p', 'vertex-paygo-pi-muted', s.frontend
            ? '嵌套预览达到上限；前端消息 JSON 仍可查看。' : nativeLog
            ? '嵌套预览达到上限；日志 JSON 仍保留宿主返回的文本。'
            : '嵌套预览达到安全上限；原始请求未改变。'));
        return node;
    }
    function sourceButton(s, id, dynamic = true) {
        const source = s.sources.get(id);
        const node = button(s, sourceLabel(source), 'source', () => navigateSource(s, id, { toggle: true }), dynamic);
        node.className = 'vertex-paygo-pi-source-tag'; node.setAttribute('data-pi-source', text(id));
        node.setAttribute('aria-pressed', String(s.selected === id));
        if (s.selected === id) node.setAttribute('data-selected', 'true');
        return node;
    }
    function sourceRefs(s, message) {
        // Reuse only within this render: source maps and new records cannot leave stale matches.
        if (!message || typeof message !== 'object' || !s.messageRefs) return messageSources(message, s.sources);
        let refs = s.messageRefs.get(message);
        if (!refs) { refs = messageSources(message, s.sources); s.messageRefs.set(message, refs); }
        return refs;
    }
    function navigateSource(s, id, { toggle = false } = {}) {
        if (!s.sources.has(id)) return;
        if (toggle && s.selected === id) {
            s.selected = null;
            renderContent(s);
            // Re-render replaces the clicked row/tag. Restore keyboard focus to its new directory row.
            const row = s.sidebar.querySelector?.(`[data-pi-source=${JSON.stringify(id)}]`);
            const visibleRow = row && (typeof row.getClientRects !== 'function' || row.getClientRects().length);
            (visibleRow ? row : s.panel).focus?.({ preventScroll: true });
            notify(s, '已取消来源选择。');
            return;
        }
        s.selected = id; s.category = 'all'; s.query = ''; s.search.value = '';
        if (s.compact) s.drawer = false;
        const located = asArray(s.view?.messages).filter(message => sourceRefs(s, message).ids.has(id));
        s.tab = located.length ? 'final' : 'sources';
        for (const message of located) s.collapsed.delete(`final-${message.id}`);
        s.collapsed.delete(`source-${id}`);
        renderContent(s);
        s.panel.scrollTop = 0;
        const target = s.targets.get(id);
        if (target) { target.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); target.focus?.({ preventScroll: true }); }
        notify(s, located.length ? `已定位「${sourceLabel(s.sources.get(id))}」的发送正文。`
            : `正在查看「${sourceLabel(s.sources.get(id))}」的来源内容。`);
    }
    function messageCard(s, message, index, scope = 'final') {
        const refs = sourceRefs(s, message);
        const plainText = messageText(message);
        const heading = make('div', 'vertex-paygo-pi-message-heading');
        const roleLabel = ROLE_LABELS.get(message.role) ?? '未识别身份';
        const roleIcon = ROLE_ICONS.get(message.role);
        const identity = make('span', 'vertex-paygo-pi-role', roleIcon ? undefined : roleLabel,
            { title: roleLabel, 'aria-label': roleLabel, ...(roleIcon ? { role: 'img' } : {}) });
        if (roleIcon) identity.append(make('i', `fa-solid ${roleIcon}`, undefined, { 'aria-hidden': 'true' }));
        const labels = make('span', 'vertex-paygo-pi-message-labels');
        labels.append(make('code', 'vertex-paygo-pi-path', text(message.path)));
        const headerAction = node => {
            // Header controls act independently of the native summary disclosure.
            listen(s, node, 'click', event => { event.preventDefault(); event.stopPropagation?.(); }, true);
            listen(s, node, 'keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') event.stopPropagation?.();
            }, true);
            return node;
        };
        for (const id of refs.ids) labels.append(headerAction(sourceButton(s, id)));
        if (refs.unknown) labels.append(make('span', 'vertex-paygo-pi-unknown', nativeLog ? '来源未追踪' : '含来源待确认内容'));
        const copyMessage = headerAction(button(s, '复制此条纯文本', 'copy-message', () => copy(s, messageText(message), '此条纯文本'), true));
        copyMessage.disabled = !plainText.length;
        heading.append(make('span', 'vertex-paygo-pi-order', String(index + 1).padStart(3, '0')),
            identity, labels, copyMessage,
            make('span', 'vertex-paygo-pi-excerpt', excerpt(plainText.replace(/\s+/gu, ' ')) || '结构化内容'));
        const card = disclosure(s, `${scope}-${message.id}`, heading, 'vertex-paygo-pi-message');
        card.setAttribute('data-pi-message-id', text(message.id)); card.setAttribute('data-pi-role', text(message.role)); card.setAttribute('tabindex', '-1');
        if (refs.ids.has(s.selected)) card.setAttribute('data-selected', 'true');
        for (const id of refs.ids) if (!s.targets.has(id)) s.targets.set(id, card);
        const body = make('div', 'vertex-paygo-pi-card-body');
        for (const part of asArray(message.parts)) body.append(renderPart(s, part));
        if (!asArray(message.parts).length) body.append(make('p', 'vertex-paygo-pi-muted', s.frontend
            ? '此消息没有可识别的 parts；请查看前端消息 JSON。' : nativeLog
            ? '此消息没有可识别的 parts；请查看日志 JSON。'
            : '此消息没有可识别的 parts；请检查高级原始请求。'));
        card.append(body); return card;
    }
    function matchesQuery(s, value) { return !s.query || value.toLocaleLowerCase().includes(s.queryLower); }
    function visibleMessage(s, message) {
        const refs = sourceRefs(s, message);
        const category = s.category === 'all' || (s.category === 'unknown' && refs.unknown)
            || [...refs.ids].some(id => categoryOf(s.sources.get(id)) === s.category);
        if (!category || !s.query) return category;
        const names = [...refs.ids].map(id => sourceLabel(s.sources.get(id))).join('\n');
        return matchesQuery(s, `${text(message.role)}\n${ROLE_LABELS.get(message.role) ?? ''}\n${messageText(message)}\n${names}\n${asArray(message.parts).filter(part => part?.type !== 'text').map(part => inspectRecord(part?.raw ?? part, s)).join('\n')}`);
    }
    function emptyPanel(s, value) { s.panel.append(make('p', 'vertex-paygo-pi-no-results', value)); }
    function renderSources(s) {
        s.panel.append(make('h3', 'vertex-paygo-pi-section-title', s.selected ? `来源内容 · ${sourceLabel(s.sources.get(s.selected))}` : '来源与变化'),
            make('p', 'vertex-paygo-pi-muted', s.selected ? '以下是你选择的来源内容，不是重新生成的提示词。' : '点击来源可查看内容；已定位的来源可跳转到发送正文。'));
        let count = 0;
        for (const source of s.sources.values()) {
            if (s.selected && source.id !== s.selected) continue;
            if (s.category !== 'all' && categoryOf(source) !== s.category) continue;
            if (s.query && !matchesQuery(s, `${sourceLabel(source)}\n${text(source.text)}\n${text(source.kind)}\n${text(source.world)}`)) continue;
            count++;
            const heading = make('div', 'vertex-paygo-pi-source-heading');
            heading.append(make('strong', '', sourceLabel(source)), make('span', 'vertex-paygo-pi-muted', KINDS.get(categoryOf(source))));
            const card = disclosure(s, `source-${source.id}`, heading, 'vertex-paygo-pi-source-card');
            if (source.id === s.selected) card.setAttribute('data-selected', 'true');
            card.setAttribute('tabindex', '-1'); s.targets.set(source.id, card);
            const fields = make('dl', 'vertex-paygo-pi-source-fields');
            const field = (parent, label, value) => {
                if (text(value)) parent.append(make('dt', '', label), make('dd', '', value));
            };

            const locationIds = new Set(asArray(source.matches).filter(match => match.verified === true).map(match => match.messageId));
            const located = asArray(s.view.messages).map((message, index) => ({ message, index }))
                .filter(({ message }) => locationIds.has(message.id));
            if (!located.length) field(fields, '正文跳转', '暂不能自动跳转，可查看来源内容');
            if (located.length) {
                field(fields, '正文位置', located.map(({ index }) => `第 ${index + 1} 条消息`).join('、'));
                const roles = [...new Set(located.map(({ message }) => ROLE_LABELS.get(message.role) ?? '未识别'))];
                field(fields, s.frontend ? '消息身份' : '发送身份', roles.join('、'));
            }
            if (source.world) field(fields, '世界书', text(source.world));
            if (source.outletName) field(fields, '出口', text(source.outletName));
            if (source.kind?.startsWith('worldinfo-') && positionNumber(source.uid) !== null && positionNumber(source.uid) >= 0) field(fields, '条目编号', text(source.uid));
            const body = make('div', 'vertex-paygo-pi-card-body'); body.append(fields);
            const placement = sourcePlacement(source);
            const configuration = make('dl', 'vertex-paygo-pi-source-fields');
            field(configuration, '插入位置', placement.label);
            if (placement.depth && positionNumber(source.depth) !== null && positionNumber(source.depth) >= 0) field(configuration, '设置深度', text(source.depth));
            if (placement.role) field(configuration, '设置身份', configuredRole(source));
            if (typeof source.priority === 'number' && Number.isFinite(source.priority)) field(configuration, '插入优先级', text(source.priority));
            if (source.aggregate === true && asArray(source.inputs).length) {
                const inputs = make('details', 'vertex-paygo-pi-part-detail');
                inputs.append(make('summary', '', `组合来源 · ${source.inputs.length} 项`));
                const list = make('ul');
                for (const input of source.inputs) list.append(make('li', '', text(input.label) || text(input.id)));
                inputs.append(list); body.append(inputs);
            }
            if (source.kind?.startsWith('worldinfo-') && typeof source.constant === 'boolean') {
                field(configuration, '触发方式', source.constant ? '常驻（蓝灯）' : '条件触发（绿灯）');
            }
            if (configuration.children.length) {
                const settings = make('section', 'vertex-paygo-pi-source-settings');
                settings.append(make('h4', '', '来源设置'), configuration); body.append(settings);
            }
            if (typeof source.text === 'string') { const pre = make('div', 'vertex-paygo-pi-text'); markText(s, pre, source.text); body.append(pre); }
            if (typeof source.originalText === 'string' && source.originalText !== source.text) {
                const original = make('details', 'vertex-paygo-pi-part-detail');
                original.append(make('summary', '', '处理前的来源文字'), make('pre', 'vertex-paygo-pi-text', source.originalText));
                body.append(original);
            }
            if (located.length) body.append(button(s, '定位到发送正文', 'source-locate', () => navigateSource(s, source.id), true));
            card.append(body); s.panel.append(card);
        }
        if (!count) emptyPanel(s, s.frontend ? `没有符合筛选条件的来源证据。未确认的文本仍在「${frontendLabel}」中。`
            : '没有符合筛选条件的来源证据。未确认的文本仍在「最终发送」中。');
        if (s.selected) { s.counter.textContent = '查看所选来源'; return; }
        s.panel.append(make('h3', 'vertex-paygo-pi-section-title', '变化记录'));
        let observed = 0;
        for (const change of asArray(s.view.changes)) {
            if (change?.evidence !== 'observed') continue;
            if (s.query && !matchesQuery(s, `${text(change.label)}\n${text(change.kind)}\n${inspectRecord(change.before, s)}\n${inspectRecord(change.after, s)}`)) continue;
            observed++;
            const card = make('article', 'vertex-paygo-pi-change');
            card.append(make('strong', '', text(change.label) || text(change.kind) || '已观察到的变化'), make('small', 'vertex-paygo-pi-muted', '已观测 · 仅已验证证据'));
            for (const id of asArray(change.sourceIds)) if (s.sources.has(id)) card.append(sourceButton(s, id));
            if (change.before !== undefined || change.after !== undefined) {
                const detail = make('details', 'vertex-paygo-pi-part-detail'); detail.append(make('summary', '', '查看前 / 后证据'));
                if (change.before !== undefined) detail.append(make('strong', '', '前'), make('pre', 'vertex-paygo-pi-structure', inspectRecord(change.before, s)));
                if (change.after !== undefined) detail.append(make('strong', '', '后'), make('pre', 'vertex-paygo-pi-structure', inspectRecord(change.after, s)));
                card.append(detail);
            }
            s.panel.append(card);
        }
        if (!observed) s.panel.append(make('p', 'vertex-paygo-pi-muted', '没有已观察到的变化事件。阶段差异不自动归因于正则、预算或插件。'));
        s.counter.textContent = `${count} 个来源 · ${observed} 个已观察事件`;
    }
    function renderComparison(s) {
        const stages = asArray(s.view.stages);
        s.panel.append(make('h3', 'vertex-paygo-pi-section-title', s.frontend ? '已观察阶段 → ' + frontendLabel : '构建阶段 → 实际发送正文'),
            make('p', 'vertex-paygo-pi-muted', '按真实消息 / parts 顺序比较。文本差异是差异，不等于已核验的修改原因。'));
        if (stages.length < 2) { emptyPanel(s, s.frontend ? `当前只有${frontendLabel}，没有可比较的前序快照。`
            : '当前只有最终发送证据，没有可比较的前序快照。'); s.counter.textContent = `${stages.length} 个阶段`; return; }
        if (!stages.some(stage => stage.id === s.before)) s.before = stages[0].id;
        if (!stages.some(stage => stage.id === s.after)) s.after = stages.at(-1).id;
        const selectors = make('div', 'vertex-paygo-pi-stage-controls');
        for (const [key, label] of [['before', '比较前'], ['after', '比较后']]) {
            const wrapper = make('label', ''); wrapper.append(make('span', '', label));
            const select = make('select', 'text_pole', undefined, { 'data-pi-stage': key, 'aria-label': label });
            for (const stage of stages) select.append(make('option', '', displayStageLabel(stage, s), { value: text(stage.id) }));
            select.value = s[key]; listen(s, select, 'change', () => { s[key] = select.value; renderContent(s); }, true);
            wrapper.append(select); selectors.append(wrapper);
        }
        s.panel.append(selectors);
        const before = stages.find(stage => stage.id === s.before), after = stages.find(stage => stage.id === s.after);
        let diff;
        try {
            const key = JSON.stringify([before.id, after.id]);
            if (!s.diffs.has(key)) s.diffs.set(key, comparePromptInspectorStages(before, after, { maxCells: 20000, maxTextCodeUnits: 24000 }));
            diff = s.diffs.get(key);
        }
        catch { diff = null; }
        renderDiffSummary(s, diff);
        const columns = make('div', 'vertex-paygo-pi-comparison');
        for (const [stage, label, scope] of [[before, '比较前', 'before'], [after, '比较后', 'after']]) {
            const column = make('section', 'vertex-paygo-pi-stage-column');
            column.append(make('h4', '', `${label} · ${displayStageLabel(stage, s)}`));
            if (stage.complete === false) column.append(make('p', 'vertex-paygo-pi-muted', '此阶段证据不完整。'));

            const messages = asArray(stage.messages);
            messages.forEach((message, index) => { if (visibleMessage(s, message)) column.append(messageCard(s, message, index, `${scope}-${stage.id}`)); });
            if (!messages.length) column.append(make('p', 'vertex-paygo-pi-muted', '没有消息快照。'));
            const extra = requestFields(s, stage.requestFields, text(stage.id));
            if (extra) column.append(extra);
            columns.append(column);
        }
        s.panel.append(columns); s.counter.textContent = `${asArray(before.messages).length} → ${asArray(after.messages).length} 条消息`;
    }
    function renderDiffSummary(s, diff) {
        const summary = make('section', 'vertex-paygo-pi-diff-summary', undefined, { 'data-pi-diff': '' });
        summary.append(make('p', '', !diff || diff.changed === null ? '差异计算不可用或未得出结论；下方仍显示真实阶段快照。'
            : diff.changed ? '这两个快照存在差异（不推断修改原因）。' : '这两个快照相同。'));
        if (diff?.bounded) summary.append(make('p', 'vertex-paygo-pi-muted', '差异预览已达到计算上限。下方阶段内容与原始请求仍保留实际顺序。'));

        const changes = asArray(diff?.changes);
        const labels = { 'role-changed': 'role 改变', 'messages-changed': '消息内容改变', 'messages-added': '新增消息', 'messages-removed': '移除消息', 'request-fields-changed': '请求参数改变', 'comparison-bounded': '比较达到上限（未得出结论）' };
        for (const [index, entry] of changes.slice(0, 40).entries()) {
            const heading = make('div', 'vertex-paygo-pi-diff-heading');
            heading.append(make('strong', '', labels[entry.kind] ?? text(entry.kind)));
            if (entry.beforeStart !== undefined || entry.afterStart !== undefined) heading.append(
                make('code', '', `前 #${Number(entry.beforeStart ?? 0) + 1} → 后 #${Number(entry.afterStart ?? 0) + 1}`));
            const card = disclosure(s, `diff-${index}`, heading, 'vertex-paygo-pi-diff-card');
            const body = make('div', 'vertex-paygo-pi-card-body');
            if (entry.before?.roles || entry.after?.roles) body.append(make('p', 'vertex-paygo-pi-muted', `role: ${asArray(entry.before?.roles).map(text).join(', ') || '—'} → ${asArray(entry.after?.roles).map(text).join(', ') || '—'}`));
            for (const item of asArray(entry.textChanges).slice(0, 30)) {
                if (item.equal) continue;
                body.append(make('code', 'vertex-paygo-pi-path', `${text(item.beforePath)} → ${text(item.afterPath)}`));
                const output = make('div', 'vertex-paygo-pi-text vertex-paygo-pi-diff-text', undefined, { 'data-pi-text-diff': '' });
                for (const segment of asArray(item.segments)) {
                    const tag = segment.type === 'delete' ? 'del' : segment.type === 'insert' ? 'ins' : 'span';
                    const span = make(tag, '', text(segment.text));
                    if (tag !== 'span') span.setAttribute('title', tag === 'del' ? '比较前存在' : '比较后存在');
                    output.append(span);
                }
                if (!asArray(item.segments).length) output.append(make('span', '', '此差异没有文本片段；请检查两侧的结构化内容。'));
                body.append(output);
                if (item.bounded) body.append(make('small', 'vertex-paygo-pi-muted', '此文本差异预览有界；不要将预览截断视为发送内容截断。'));
            }
            if (!asArray(entry.textChanges).length) body.append(make('p', 'vertex-paygo-pi-muted', '结构 / 媒体 / 工具或消息数量存在差异；请查看两侧实际 cards。'));
            card.append(body); summary.append(card);
        }
        if (changes.length > 40) summary.append(make('p', 'vertex-paygo-pi-muted', `其余 ${changes.length - 40} 处差异请查看下方阶段快照。`));
        s.panel.append(summary);
    }
    function requestFields(s, fields, scope) {
        if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) return null;
        const wrapper = make('details', 'vertex-paygo-pi-request-fields');
        wrapper.open = s.frontend && ['tools', 'functions', 'json_schema', 'response_format', 'instructions', 'input', 'prompt']
            .some(key => Object.hasOwn(fields, key));
        wrapper.append(make('summary', '', '请求参数 / 工具声明（非消息）'),
            make('p', 'vertex-paygo-pi-muted', s.frontend ? '以下为前端消息快照保留的字段，服务商最终请求暂未捕获。'
                : nativeLog ? '以下是宿主日志中的附加字段，按原记录展示。'
                : '以下是实际请求中的附加字段，不插入消息顺序，不执行工具。'));
        for (const [key, value] of Object.entries(fields)) {
            if (s.query && !matchesQuery(s, `${key}\n${inspectRecord(value, s)}`)) continue;
            const field = make('details', 'vertex-paygo-pi-part-detail');
            field.append(make('summary', '', key));
            if (key === 'tools' && Array.isArray(value)) {
                for (const item of value) {
                    const tool = item?.function ?? item;
                    const card = make('article', 'vertex-paygo-pi-part');
                    card.append(make('strong', 'vertex-paygo-pi-part-title', text(tool?.name) || text(item?.type) || '工具声明'),
                        make('p', 'vertex-paygo-pi-muted', text(tool?.description) || '只读声明；不执行。'));
                    const schema = make('details', 'vertex-paygo-pi-part-detail');
                    schema.append(make('summary', '', '原有工具结构'), make('pre', 'vertex-paygo-pi-structure', inspectRecord(item, s)));
                    card.append(schema); field.append(card);
                }
            } else field.append(make('pre', 'vertex-paygo-pi-structure', inspectRecord(value, s)));
            wrapper.append(field);
        }
        wrapper.setAttribute('data-pi-request-fields', scope);
        return wrapper;
    }
    function renderRaw(s) {
        s.panel.append(make('h3', 'vertex-paygo-pi-section-title', s.frontend ? recordName(s) : nativeLog ? '宿主请求 JSON 记录' : '高级 · 原始请求'),
            make('p', 'vertex-paygo-pi-muted', s.frontend
                ? s.record?.metadata?.initialAssemblyOnly === true
                    ? '这是该 Agent 运行保存的初始输入，保留模型、消息和输入中实际存在的提示词字段。后续模型轮次未记录。'
                    : '保留记录位置上的模型、消息、工具说明及输出格式等提示词字段。宿主之后仍可能转换内容，服务商最终请求未捕获。'
                : nativeLog
                ? '保留宿主返回的 JSON 文本。TauriTavern 可能已格式化 JSON、省略媒体及模型私有续接状态；这份记录不是逐字节网络请求证据。'
                : '这是捕获的最终序列化请求，不是重建或美化的 JSON。复制不会加入标签；分享前请自行检查敏感内容。'));
        const raw = typeof s.record?.rawRequest === 'string' ? s.record.rawRequest : null;
        const copyRaw = button(s, s.frontend ? '复制' + recordName(s) : nativeLog ? '复制日志 JSON' : '复制原始请求', 'copy-raw',
            () => copy(s, raw, s.frontend ? recordName(s) : nativeLog ? '宿主日志 JSON（保留其格式）' : '精确原始请求（raw）'), true);
        copyRaw.disabled = raw === null; s.panel.append(copyRaw);
        s.panel.append(make('pre', 'vertex-paygo-pi-raw', raw ?? (s.frontend ? '未记录前端发送消息。' : nativeLog ? '未读取请求日志。' : '未捕获完整原始请求。'),
            { 'data-pi-raw': '', tabindex: '0' }));
        s.counter.textContent = raw === null ? s.frontend ? '没有消息快照' : nativeLog ? '没有日志正文' : '没有原始请求'
            : `${raw.length.toLocaleString()} 字符 · ${s.frontend ? '前端消息快照' : nativeLog ? '保留宿主日志格式' : '保留原始格式'}`;
    }
    function renderDirectory(s) {
        const header = make('div', 'vertex-paygo-pi-sidebar-header');
        header.append(make('h3', 'vertex-paygo-pi-sidebar-heading', '来源目录'),
            button(s, '关闭来源目录', 'drawer-close', () => hideDrawer(s), true));
        const content = make('div', 'vertex-paygo-pi-sidebar-content');
        content.append(make('p', 'vertex-paygo-pi-muted', '点击来源可查看内容；能定位时直接跳转正文。'));
        s.sidebar.append(header, content);
        const groups = new Map();
        for (const source of s.sources.values()) {
            if (typeof source.text !== 'string' || !source.text.trim()
                || (isInternalControlSource(source) && source.status !== 'matched')) continue;
            const kind = categoryOf(source); if (!groups.has(kind)) groups.set(kind, []); groups.get(kind).push(source);
        }
        const chip = (kind, label) => {
            const node = button(s, label, 'category', () => { s.category = kind; s.selected = null; renderContent(s); }, true);
            node.className = 'vertex-paygo-pi-chip'; node.setAttribute('aria-pressed', String(s.category === kind));
            node.setAttribute('data-pi-category', kind); s.chips.append(node);
        };
        chip('all', '全部');
        const positions = new Map();
        asArray(s.view.messages).forEach((message, index) => {
            for (const id of sourceRefs(s, message).ids) {
                const list = positions.get(id) ?? []; list.push(index + 1); positions.set(id, list);
            }
        });
        for (const [kind, group] of groups) {
            chip(kind, `${KINDS.get(kind)} ${group.length}`);
            const section = make('details', 'vertex-paygo-pi-source-group'); section.open = true;
            section.append(make('summary', '', `${KINDS.get(kind)} · ${group.length}`));
            for (const source of group) {
                if (s.query && !matchesQuery(s, `${sourceLabel(source)}\n${text(source.text)}\n${text(source.world)}`)) continue;
                const row = sourceButton(s, source.id); row.className = 'vertex-paygo-pi-source-row';
                const matches = positions.get(source.id) ?? [];
                if (matches.length) row.append(make('small', 'vertex-paygo-pi-muted', `正文第 ${matches.join('、')} 条`));
                row.setAttribute('title', `${sourceLabel(source)} · ${s.selected === source.id ? '再次点击取消选择' : matches.length ? '跳转到发送正文' : '查看来源内容'}`);
                section.append(row);
            }
            content.append(section);
        }
        if (!groups.has('unknown')) chip('unknown', '来源待确认');
        if (!groups.size) content.append(make('p', 'vertex-paygo-pi-muted', s.frontend
            ? '没有来源证据。当前前端消息仍可检查；服务商最终请求暂未捕获。'
            : '没有来源证据。最终请求仍可检查；不从当前预设重建。'));
    }
    function renderContent(s) {
        if (!s.view || session !== s || disposed) return;
        s.messageRefs = new WeakMap();
        s.queryLower = s.query.toLocaleLowerCase();
        const focusedSearch = doc.activeElement === s.search;
        for (const dispose of s.dynamic) dispose(); s.dynamic = []; s.disclosures = []; s.targets.clear();
        s.panel.replaceChildren(); s.sidebar.replaceChildren(); s.chips.replaceChildren();
        for (const [id, tab] of s.tabs) { tab.setAttribute('aria-selected', String(id === s.tab)); tab.setAttribute('tabindex', id === s.tab ? '0' : '-1'); }
        s.panel.setAttribute('aria-labelledby', `${prefix}-tab-${s.tab}`);
        s.layout.setAttribute('data-tab', s.tab); updateDrawer(s); renderDirectory(s);
        s.search.disabled = s.tab === 'raw';
        s.copyText.disabled = !asArray(s.view.messages).some(message => messageText(message).length);
        s.chips.hidden = nativeLog || s.tab === 'raw';
        if (s.tab === 'sources') renderSources(s);
        else if (s.tab === 'compare') renderComparison(s);
        else if (s.tab === 'raw') renderRaw(s);
        else {
            const messages = asArray(s.view.messages);
            const title = make('div', 'vertex-paygo-pi-section-heading');
            const filtered = Boolean(s.query) || s.category !== 'all';
            title.append(make('h3', '', s.frontend ? filtered ? '筛选视图 · 保留前端消息序号' : frontendLabel + '顺序'
                : nativeLog ? filtered ? '筛选视图 · 保留日志消息序号' : '日志中的消息顺序'
                : filtered ? '筛选视图 · 保留原发送序号' : '实际发送顺序'),
                make('small', 'vertex-paygo-pi-muted', s.frontend ? frontendRecordLabel(s.record) + ' · 服务商最终请求未捕获'
                    : nativeLog ? '按宿主 JSON 展示 · 来源未追踪'
                    : filtered ? '仅隐藏未匹配项 · 不分组、不改变发送顺序' : 'role / parts 原样 · 标签仅供查看'));
            if (filtered) title.append(button(s, '清空筛选', 'filter-reset', () => {
                s.query = ''; s.search.value = ''; s.category = 'all'; renderContent(s);
            }, true));
            s.panel.append(title);
            let count = 0;
            messages.forEach((message, index) => { if (visibleMessage(s, message)) { count++; s.panel.append(messageCard(s, message, index)); } });
            if (!count) emptyPanel(s, messages.length ? '没有匹配结果。清空搜索或切换来源类别。'
                : s.frontend ? '前端消息结构未识别，请查看前端消息 JSON。' : nativeLog ? '宿主日志的请求结构未识别，请查看日志 JSON。'
                    : '请求形状未识别；不会把未知结构猜测为消息。请查看高级原始请求。');
            const extra = requestFields(s, s.view.metadata?.requestFields, s.frontend ? 'frontend-request' : 'backend-final');
            if (extra) s.panel.append(extra);
            s.counter.textContent = `${count} / ${messages.length} 条消息 · ${filtered ? '筛选中（保留原顺序）'
                : s.frontend ? '按前端消息顺序' : nativeLog ? '按日志中的顺序' : '按实际发送顺序'}`;
        }
        updateFoldToggle(s);
        if (focusedSearch) s.search.focus?.();
    }
    function renderMetadata(s, state, record) {
        s.metadata.replaceChildren();
        s.metaDisclosure.hidden = !record;
        if (!record) return;
        s.metaSummary.textContent = `${s.frontend ? tauriFrontend ? frontendRecordLabel(record) : '前端发送记录'
            : nativeLog ? '宿主记录信息' : '发送与响应信息'}${record.metadata?.initialAssemblyOnly === true ? '' : ` · #${text(record.sequence)}`}${record.model ? ` · ${text(record.model)}` : ''}`;
        s.metaSummary.setAttribute('title', s.metaSummary.textContent);
        const field = (label, value, explanation) => {
            if (!text(value)) return;
            const name = make('dt', '', label), content = make('dd', '', value);
            if (explanation) { name.title = explanation; content.title = explanation; }
            s.metadata.append(name, content);
        };
        if (nativeLog) {
            field('记录范围', 'TauriTavern 全局模型日志', '原生接口未提供聊天或请求关联标识。');
            field('渠道', record.source ? CHANNELS.get(record.source) ?? record.source : '未标注');
            field('模型', record.model || '未标注'); field('日志编号', text(record.metadata?.nativeLogId ?? record.sequence));
            field('日志结果', record.metadata?.ok === true ? '请求成功' : record.metadata?.ok === false ? '请求失败' : '未确认');
            if (record.capturedAt) {
                const date = new Date(record.capturedAt);
                field('日志时间', Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : record.capturedAt);
            }
            if (typeof record.metadata?.durationMs === 'number') field('耗时', `${record.metadata.durationMs} 毫秒`);
            if (typeof record.metadata?.stream === 'boolean') field('流式响应', record.metadata.stream ? '开启' : '关闭');
            field('API 地址', text(record.metadata?.endpoint));
            field('日志正文', typeof record.rawRequest === 'string' ? '已取得宿主记录' : '未取得');
            field('正文格式', '宿主整理的 JSON', '媒体及模型私有续接状态可能被宿主省略，网络请求字节未经核验。');
            field('来源与阶段', '原生日志未提供', '不从当前预设或聊天猜测记录来源。');
            field('查看副本', '仅保留本页内存', '释放查看副本不修改 TauriTavern 的日志。');
            return;
        }
        if (s.frontend) {
            field('记录范围', tauriFrontend ? (record.metadata?.initialAssemblyOnly === true ? '当前聊天上一轮 · ' : '当前聊天普通模式上一轮 · ')
                + frontendRecordLabel(record) : '发送给酒馆后端的消息');
            if (record.metadata?.capturePhase === 'settings-ready') field('发送状态', '未确认', '消息在公开组装事件中记录，之后仍可能继续处理。');
            if (record.metadata?.initialAssemblyOnly === true) {
                field('Agent 运行', text(record.metadata.runId ?? record.runId));
                field('覆盖范围', '该运行的初始组装提示词', '运行中的后续模型轮次未记录。');
            }
            field('服务商最终请求', '暂未捕获', tauriFrontend ? 'Tauri 原生通道可能继续转换消息。' : '酒馆后端可能对消息进行后处理或转换。');
        }
        field('渠道', record.source ? CHANNELS.get(record.source) ?? record.source : '');
        field('模型', text(record.model) || (record.metadata?.initialAssemblyOnly === true ? '输入快照未记录模型' : ''));
        if (record.metadata?.initialAssemblyOnly !== true) field(tauriFrontend ? '记录序号' : '发送序号', text(record.sequence));
        field(tauriFrontend ? '记录状态' : '请求状态', record.state ? requestState(record, state) : '',
            tauriFrontend ? record.metadata?.initialAssemblyOnly === true ? '读取的是该运行保存的初始输入。'
                : '响应状态指 Tauri HTTP 接口；服务商网络请求字节未经核验。'
                : '已响应表示已收到服务端响应，不保证流式输出全部完成，也不代表缓存命中。');
        for (const [key, label] of [['capturedAt', '记录时间'], ['dispatchAt', '发送时间'], ['responseAt', '响应时间'], ['expiresAt', '后台临时记录到期']]) {
            const value = record[key] ?? record.metadata?.[key];
            if (text(value)) {
                let formatted = text(value);
                try { const date = new Date(value); if (Number.isFinite(date.getTime())) formatted = date.toLocaleString('zh-CN', { hour12: false }); } catch {                               }
                field(label, formatted);
            }
        }
        field('响应状态码', text(record.metadata?.httpStatus ?? record.metadata?.statusCode));
        if (typeof record.metadata?.durationMs === 'number') field('耗时', `${record.metadata.durationMs} 毫秒`);
        if (typeof record.metadata?.stream === 'boolean') field(tauriFrontend ? '前端流式设置' : '流式响应', record.metadata.stream ? '开启（逐段接收）' : '关闭（一次接收）',
            tauriFrontend ? '这是前端事件中的设置，实际输出方式未确认。' : '流式响应会边生成边显示；关闭时等待完整响应。');
        if (record.metadata?.transport) field(tauriFrontend ? '观测位置' : '发送方式', TRANSPORTS.get(record.metadata.transport) ?? '其他发送方式',
            tauriFrontend ? '记录发生在进入 Tauri 原生通道之前。' : '指请求经过酒馆原生接口还是插件代理，与来源定位无关。');
        field(s.frontend ? '消息快照' : '发送正文', (s.frontend ? s.view?.metadata?.frontendMessagesComplete : s.view?.metadata?.bodyComplete) === true
            ? '完整记录' : '不完整 / 未确认');
        if (state.privacyMode === 'tab-session') {
            field('记录保留', ['saved', 'restored'].includes(state.persistence?.status)
                ? '按聊天保留，切回或刷新可恢复' : state.persistence?.status === 'loading' ? '正在恢复记录' : '本页临时查看');
        }
        if (state.privacyMode === 'memory-only') field('记录保留', '仅保留本页，刷新后清空');
        if (state.privacyMode === 'host-artifact') field('记录保留', '由该 Agent 运行的工作区保存，刷新可重新读取');
        field('来源收集', record.trace?.complete === true && state.sourceAvailable !== false ? '完整' : '部分未收集',
            '收集发送时的预设、世界书、角色和扩展等来源资料；不完整不等于发送正文缺失。');
        field('正文来源定位', s.view?.metadata?.provenanceComplete === true ? '已确认' : '部分未确认',
            s.frontend ? `将来源文字与${frontendLabel}核对。只有完全相同且能唯一定位时才标注。`
                : '将来源文字与实际发送正文核对。只有完全相同且能唯一定位时才标注；重复或变化后的文字可能无法确认。');
    }
    function render() {
        if (disposed) return;
        const state = readState();
        launch.setAttribute('title', `${viewerTitle} · ${nativeLog ? '查看所选全局模型日志' : '自动记录当前聊天上一轮的提示词'}`);
        const s = session; if (!s) return;
        const enabled = state.enabled === true;
        const status = state.error?.code === 'RECORD_EXPIRED' ? 'expired'
            : state.error?.code === 'RECORD_TOO_LARGE' ? 'oversize' : state.status;
        const supported = (state.supported === true && (state.backendAvailable !== false || state.frontendAvailable === true))
            || (state.recordAvailable === true && Boolean(state.record));
        const record = state.record && typeof state.record === 'object' ? state.record : null;
        s.frontend = !nativeLog && (record?.metadata?.captureKind ?? state.captureKind) === 'frontend-messages';
        if (!nativeLog) {
            for (const [id, label] of [['final', s.frontend ? frontendRecordLabel(record) : '最终发送'], ['raw', s.frontend ? recordName(s) : '原始请求']]) {
                const tab = s.tabs.get(id);
                if (!tab.querySelector('i')) tab.textContent = label;
                tab.setAttribute('aria-label', label); tab.setAttribute('title', label);
            }
            s.copyText.setAttribute('title', s.frontend ? '只复制前端消息中的文本 parts；前端消息 JSON 可单独复制。'
                : '只复制文本 parts；不含媒体、角色或来源标签；不是原始请求。');
        }
        const blocked = !enabled || (!record && (!supported || BLOCKED.has(status))) || record?.state === 'oversize';
        s.refresh.disabled = Boolean(s.busy);
        s.clear.disabled = (!enabled && !record) || Boolean(s.busy);
        s.root.setAttribute('aria-busy', String(Boolean(s.busy)));
        s.badge.textContent = s.frontend && record ? requestState(record, state)
            : nativeLog ? !supported ? '接口不可用' : !enabled ? '读取已暂停'
            : status === 'oversize' ? '超出查看上限' : record ? '宿主记录已读取'
                : status === 'loading' ? '正在读取' : status === 'error' ? '读取失败' : '请选择日志记录'
            : !supported ? '捕获不可用' : !enabled ? '暂无发送记录' : status === 'expired' || status === 'expiry' ? '临时记录已过期'
            : status === 'oversize' ? REQUEST_STATES.get('oversize') : record ? state.restored && record.state === 'dispatched' ? '已发送（响应状态未更新）' : REQUEST_STATES.get(record.state) ?? '记录状态未确认' : status === 'error' ? '读取失败' : '等待下一次发送';
        s.badge.setAttribute('data-tone', state.error || record?.state === 'failed' ? 'error' : enabled ? 'active' : 'normal');

        const key = !blocked && record ? `${text(record.id)}:${text(record.sequence)}:${text(record.chatId)}` : null;
        if (key !== s.key) {
            s.key = key; s.tab = 'final'; s.query = ''; s.search.value = ''; s.category = 'all';
            s.selected = null; s.before = ''; s.after = ''; s.collapsed.clear(); s.feedback.textContent = '';
        }
        s.record = blocked ? null : record; s.view = null;
        let parseFailure = false;
        if (s.record) {
            try {
                // Controller records are immutable. Repeated status/search/control renders reuse
                // normalization and exact provenance matching, not a preset reconstruction.
                if (s.cachedRecord !== s.record || s.cachedKey !== key) {
                    s.cachedView = buildPromptInspectorView(s.record);
                    s.cachedRecord = s.record; s.cachedKey = key; s.diffs.clear();
                }
                s.view = s.cachedView;
            }
            catch { parseFailure = true; s.view = { messages: [], sources: [], stages: [], changes: [],
                warnings: [s.frontend ? '无法解析前端消息快照；仍可查看前端消息 JSON。' : nativeLog ? '无法解析宿主记录；仍可查看日志 JSON。' : '无法解析记录；仍可查看精确原始请求。'] }; }
        }
        const notices = [];
        if (s.frontend) notices.push(tauriFrontend
            ? record?.metadata?.initialAssemblyOnly === true ? state.notice
                : record?.metadata?.capturePhase === 'tauri-dispatch'
                    ? '这是当前聊天上一轮交给 Tauri 前的提示词，保留了消息、媒体、续接状态、工具说明和输出格式。响应状态指 Tauri HTTP 接口；服务商最终网络请求字节未核验。'
                    : '这是公开组装事件中记录的消息，发送状态未确认。Tauri 原生通道之后可能继续转换内容，服务商最终请求暂未捕获。'
            : '这里只记录进入酒馆后端前的消息。后端可能继续处理或转换内容；服务商最终请求暂未捕获。');
        else if (!nativeLog && record?.trace?.reason === 'PUBLIC_EVENT_CAPTURE') notices.push('已捕获插件代理发出的最终请求；来源与构建阶段仅显示通过插件接口实际观察到的部分。');
        if (nativeLog) notices.push(state.notice || '记录来自全局模型日志，未关联当前聊天；来源与构建阶段未追踪。JSON 由宿主整理，媒体和模型私有续接状态可能被省略。');
        if (s.record && state.persistence?.evicted > 0) notices.push('标签页保存空间已满，已释放较早的其他聊天记录；当前记录已保留。');
        if (s.record && ['unavailable', 'too-large', 'invalid'].includes(state.persistence?.status)) {
            notices.push(state.persistence.status === 'too-large'
                ? '这轮记录较大，无法跨刷新保留；本页仍可查看和复制完整正文。'
                : '浏览器未能保存这轮记录，刷新后可能丢失；本页仍可查看和复制。');
        }
        if (s.record && state.persistence?.traceOmitted === true) notices.push('已保存完整提示词正文；来源和阶段较大，刷新后只恢复正文。');
        if (state.generationMode === 'unknown') notices.push('暂未读取到 Tauri 的生成模式配置；已有记录仍按实际提交位置标明。');
        if (state.error) notices.push(text(state.error.message) || '读取临时记录失败。');
        if (record?.state === 'failed' && !blocked) notices.push(s.frontend ? '前端请求未取得正常响应；消息快照不代表服务商已经接收。' : nativeLog ? '宿主将该请求记录标记为失败。'
            : `实际请求失败${record.errorCode ? `（${text(record.errorCode)}）` : ''}。捕获的发送内容不代表响应成功。`);
        if (s.record?.complete !== true) notices.push(s.record ? s.frontend ? '前端消息快照未完整读取。' : nativeLog ? '宿主日志记录未完整读取。'
            : '最终请求证据不完整。不会将前端阶段冒充最终发送。' : '');
        const warnings = asArray(s.view?.warnings).filter(value => typeof value === 'string');
        notices.push(...warnings.filter(code => !SOURCE_WARNINGS.has(code) && !DETAIL_WARNINGS.has(code)
            && !(code === 'final-body-incomplete' && s.record?.complete !== true)).map(code => displayWarning(code, s)));
        s.notice.textContent = [...new Set(notices.filter(Boolean))].join('\n'); s.notice.hidden = !s.notice.textContent;
        s.work.hidden = !s.view; s.empty.hidden = Boolean(s.view);
        renderMetadata(s, state, !blocked ? record : null);
        if (s.view) {
            s.sources = new Map(asArray(s.view.sources).filter(source => source && typeof source.id === 'string').map(source => [source.id, source]));
            if (parseFailure) s.tab = 'raw'; renderContent(s);
        } else {
            for (const dispose of s.dynamic) dispose(); s.dynamic = []; s.disclosures = []; s.targets.clear();
            s.panel.replaceChildren(); s.sidebar.replaceChildren(); s.chips.replaceChildren(); s.sources = new Map();
            updateFoldToggle(s);
            s.empty.replaceChildren(); s.counter.textContent = nativeLog ? '没有日志正文' : '没有保留的提示词';
            s.cachedRecord = null; s.cachedView = null; s.cachedKey = null; s.diffs.clear();
            let title = '暂无上一轮提示词', description = '正常发送一轮后会自动记录，之后打开这里即可查看。无法补录安装前未记录的普通模式请求。';
            if (nativeLog) {
                title = '请选择一条原生请求记录'; description = '在插件日志页刷新列表并选择记录，再打开这里查看。列表包含全局模型请求，不能据此认定它属于当前聊天。';
                if (!supported || status === 'unavailable') { title = '原生请求日志接口不可用'; description = '当前 TauriTavern 未提供宿主日志读取接口，其他插件功能仍可使用。'; }
                else if (!enabled || status === 'disabled') { title = '日志读取已暂停'; description = '本页查看副本已释放，宿主日志仍由 TauriTavern 保留。'; }
                else if (status === 'oversize') { title = '宿主记录超过查看上限'; description = '没有保留截断副本。可在 TauriTavern 的开发日志面板查看该记录。'; }
                else if (status === 'error' || state.error) { title = '暂时无法读取宿主记录'; description = '可刷新列表并重新选择记录；生成流程不受影响。'; }
            }
            else if (!supported || status === 'unavailable') {
                title = state.initialAssemblyOnly && state.error ? '暂时无法读取上一轮 Agent 提示词' : '当前环境暂不能记录';
                description = state.initialAssemblyOnly ? state.error?.message || '当前版本未提供 Agent 初始输入读取接口。'
                    : '请选中支持的聊天补全连接。当前聊天或生成事件不可用时，不影响其他插件功能。';
            }
            else if (!enabled || status === 'disabled') { title = '暂无上一轮发送记录'; description = '正常发送时自动临时记录最近一次请求，无需提前打开查看器。'; }
            else if (status === 'expired' || status === 'expiry') { title = '临时记录已过期'; description = '过期内容已释放。下一次正常发送会自动记录；无法恢复旧内容。'; }
            else if (status === 'oversize' || record?.state === 'oversize') {
                title = s.frontend ? '前端消息超过查看上限' : '请求超过临时捕获上限';
                description = s.frontend ? '未保留截断消息快照，生成流程不受影响。'
                    : '没有保留完整请求，不能称为完整发送证据。生成不受影响；不会展示截断内容冒充全文。';
            }
            else if (status === 'error' || state.error) { title = '暂时无法读取记录'; description = '读取失败不会影响生成。可刷新状态，或清除临时记录后重试。'; }
            s.empty.append(make('span', 'vertex-paygo-pi-empty-symbol', '◎'), make('h3', '', title), make('p', '', description));
        }
    }
    async function open() {
        if (disposed) return;
        if (session) { session.root.focus?.(); return session.showing; }
        const s = buildSession(); session = s; render();
        try {
            s.popup = createExtensionDialog(s.root, { okButton: false, wide: true, large: true,
                onEscape: () => { if (s.drawer) hideDrawer(s); else close(s); } });
            s.popup.dlg.classList.add('vertex-paygo-prompt-inspector-dialog');
            s.theme = bindExtensionTheme(s.popup.dlg, { skipBg: false });
            s.showing = s.popup.show();
            s.theme.sync();
            void action(s, 'refresh', () => controller.refresh());
            const result = await s.showing;
            disposeSession(s);
            return result;
        } catch (error) {
            disposeSession(s);
            throw error;
        }
    }
    const onLaunch = () => { void open().catch(() => {}); };
    launch.addEventListener('click', onLaunch);
    try { unsubscribe = controller.subscribe(() => render()); }
    catch {                                                                 }
    render();
    return { open, render, destroy() {
        if (disposed) return;
        if (session) close(session);
        disposed = true;
        try { if (typeof unsubscribe === 'function') unsubscribe(); } catch {                                                    }
        launch.removeEventListener('click', onLaunch); unmount();
    } };
}
