/* Local cache diagnostics presentation; SPDX-License-Identifier: MPL-2.0 */
const number = value => value === null || value === undefined ? '未知' : value.toLocaleString('zh-CN');
const ROLE_LABELS = { system: '系统', user: '用户', model: '助手', unknown: '未知身份' };
const SOURCE_LABELS = { vertexai: 'Vertex AI', makersuite: 'Google AI Studio' };
const STATUS_LABELS = { pending: '生成中', complete: '完成', incomplete: '中断', failed: '失败', unknown: '未知' };
const time = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : value;
};

export function createCacheDiagnosticsViewer({ documentRef = globalThis.document, onRefresh, onSelect, onClose }) {
    const make = (tag, className = '', value, attributes = {}) => {
        const node = documentRef.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) node.textContent = String(value);
        for (const [name, item] of Object.entries(attributes)) node.setAttribute(name, String(item));
        return node;
    };
    const disposers = [];
    const listen = (node, event, callback) => {
        node.addEventListener(event, callback); disposers.push(() => node.removeEventListener(event, callback));
    };
    const iconButton = (label, icon, action) => {
        const button = make('button', 'vertex-paygo-icon-button vertex-paygo-log-tool', undefined,
            { type: 'button', title: label, 'aria-label': label, 'data-cache-action': action });
        button.append(make('i', `fa-solid ${icon}`, undefined, { 'aria-hidden': 'true' }));
        return button;
    };
    const disclosure = label => {
        const details = make('details', 'vertex-paygo-log-json vertex-paygo-cache-detail');
        const summary = make('summary', 'vertex-paygo-log-json-summary');
        summary.append(make('i', 'fa-solid fa-angle-right vertex-paygo-log-disclosure', undefined, { 'aria-hidden': 'true' }),
            make('span', '', label));
        details.append(summary); return details;
    };
    const root = make('section', 'vertex-paygo-log-viewer vertex-paygo-cache-viewer', undefined,
        { 'aria-label': 'Google 请求与缓存用量' });
    const header = make('header', 'vertex-paygo-log-header');
    const heading = make('div', 'vertex-paygo-log-heading-row');
    const tools = make('div', 'vertex-paygo-log-tools');
    const refresh = iconButton('刷新本地记录', 'fa-rotate-right', 'refresh');
    refresh.id = 'vertex-paygo-cache-diagnostics-refresh';
    const close = iconButton('关闭缓存诊断', 'fa-xmark', 'close');
    close.classList.add('vertex-paygo-log-close');
    tools.append(refresh, close); heading.append(make('h3', '', 'Google 请求与缓存用量'), tools);
    const selector = make('select', 'text_pole', undefined, { id: 'vertex-paygo-cache-diagnostics-select', 'aria-label': '选择请求记录' });
    const selectLabel = make('label', 'vertex-paygo-cache-selector');
    selectLabel.append(make('span', '', '查看请求'), selector);
    header.append(heading, make('p', 'vertex-paygo-log-description', '查看当前聊天的请求与缓存用量记录。'), selectLabel);
    const body = make('div', 'vertex-paygo-cache-viewer-body', undefined, { tabindex: '0' });
    const status = make('p', 'vertex-paygo-log-empty', '', { 'aria-live': 'polite' });
    const content = make('div', 'vertex-paygo-cache-content');
    const metadata = make('p', 'vertex-paygo-cache-request-meta');
    const metrics = make('div', 'vertex-paygo-cache-metrics', undefined, { id: 'vertex-paygo-cache-diagnostics-usage' });
    const values = new Map();
    for (const [id, label, unit] of [['input', '输入量', 'tokens'], ['cached', '缓存量', 'tokens'], ['rate', '缓存命中比例', '']]) {
        const metric = make('div', 'vertex-paygo-cache-metric');
        const value = make('strong', '', '未知', { 'data-cache-metric': id }); values.set(id, value);
        const valueRow = make('div', 'vertex-paygo-cache-metric-value');
        valueRow.append(value); if (unit) valueRow.append(make('small', '', unit));
        metric.append(make('span', 'vertex-paygo-cache-metric-label', label), valueRow); metrics.append(metric);
    }
    const progress = make('progress', 'vertex-paygo-cache-progress', undefined, { max: '1', 'aria-label': '缓存占输入的比例' });
    const warning = make('p', 'vertex-paygo-cache-warning', '', { 'data-cache-warning': '' });
    const multi = make('p', 'vertex-paygo-cache-note', '', { 'data-cache-subrequests': '' });
    const advanced = disclosure('请求结构与前后比较');
    const structure = make('p', 'vertex-paygo-cache-note', '', { id: 'vertex-paygo-cache-diagnostics-structure' });
    const comparison = make('p', 'vertex-paygo-cache-note', '', { id: 'vertex-paygo-cache-diagnostics-comparison' });
    const comparisonNote = make('p', 'vertex-paygo-cache-note', '比较以完整消息块为单位；相同块数为 0 时仍可能存在相同文本前缀。');
    const raw = disclosure('原始结构摘要');
    const preview = make('pre', 'vertex-paygo-log-record-raw', '', { id: 'vertex-paygo-cache-diagnostics-preview' });
    raw.append(preview); advanced.append(structure, comparison, comparisonNote, raw);
    const explanation = disclosure('数据说明');
    explanation.append(make('p', 'vertex-paygo-cache-note', '命中比例 = 缓存 tokens ÷ 输入 tokens。缓存计数缺失或无效时显示未知；字符数与 token 数不同。'),
        make('p', 'vertex-paygo-cache-note', '结构比较用于判断请求是否稳定。缓存命中以 Google 返回用量为准，费用按用量与单价估算。'),
        make('p', 'vertex-paygo-cache-note', '记录范围为关联本地用量记录的 Google 代理请求。结构摘要保留长度、指纹和参数，不含提示词正文。'));
    content.append(metadata, metrics, progress, warning, multi, advanced, explanation);
    body.append(status, content);
    const footer = make('footer', 'vertex-paygo-cache-viewer-footer');
    const counter = make('small', '', '', { id: 'vertex-paygo-cache-diagnostics-status', 'aria-live': 'polite' });
    footer.append(counter); root.append(header, body, footer);
    listen(refresh, 'click', onRefresh); listen(selector, 'change', () => onSelect(selector.value)); listen(close, 'click', onClose);
    return {
        root,
        render({ views, selected, state, comparisonText }) {
            const current = views.find(view => view.id === selected);
            const previous = selector.value;
            const labels = views.map(view => `${time(view.createdAt)} · ${view.model} · ${STATUS_LABELS[view.status]}`);
            if (selector.options.length !== views.length || [...selector.options].some((option, index) => option.value !== views[index].id
                || option.textContent !== labels[index])) {
                selector.replaceChildren(...views.map((view, index) => make('option', '', labels[index], { value: view.id })));
            }
            selector.value = selected ?? ''; selector.disabled = !views.length; refresh.disabled = state === 'loading';
            root.setAttribute('aria-busy', String(state === 'loading'));
            status.textContent = state === 'loading' ? '正在读取记录…' : state === 'error' ? '读取失败，请刷新重试。'
                : state === 'no_chat' ? '请先打开聊天。' : !current ? '当前聊天暂无用量记录。' : '';
            status.hidden = !status.textContent; content.hidden = !current;
            counter.textContent = views.length ? `当前聊天最近 ${views.length} 条记录` : '当前聊天暂无记录';
            if (!current) { values.forEach(value => { value.textContent = '未知'; }); preview.textContent = ''; return; }
            if (previous !== selector.value) body.scrollTop = 0;
            const { usage } = current;
            metadata.textContent = [SOURCE_LABELS[current.source] ?? current.source, current.model, current.region, STATUS_LABELS[current.status]].filter(Boolean).join(' · ');
            values.get('input').textContent = number(usage.promptTokens); values.get('cached').textContent = number(usage.cachedTokens);
            values.get('rate').textContent = usage.cacheRate === null ? '未知' : `${(usage.cacheRate * 100).toFixed(1)}%`;
            progress.hidden = usage.cacheRate === null;
            if (usage.cacheRate !== null) progress.value = usage.cacheRate;
            const warnings = [];
            if (usage.cacheField === 'missing') warnings.push('未返回缓存计数，无法计算命中比例。');
            else if (usage.cacheField === 'invalid') warnings.push('缓存计数无效，无法计算命中比例。');
            if (usage.partial) warnings.push('请求未成功完成，用量可能不完整。');
            warning.textContent = warnings.join(' '); warning.hidden = !warning.textContent;
            multi.textContent = current.googleRequestCount > 1 ? `包含 ${current.googleRequestCount} 个 Google 子请求；用量为汇总值，结构显示首个子请求。` : '';
            multi.hidden = !multi.textContent;
            const summary = current.preview;
            structure.textContent = summary.status === 'available'
                ? `系统指令：${summary.systemInstruction ? '有' : '无'}；消息：${number(summary.contentCount)} 块。顺序：${summary.contents.slice(0, 8).map(item => ROLE_LABELS[item?.role] ?? '未知身份').join(' → ')}${summary.contents.length > 8 || summary.omittedContents > 0 ? ' → …' : ''}。`
                : '暂无请求结构摘要。';
            comparison.textContent = comparisonText(current.comparison);
            preview.textContent = summary.status === 'available' ? JSON.stringify(summary, null, 2)
                : summary.reason === 'BODY_TOO_LARGE' ? '请求超过 2 MiB 观察上限，未记录结构摘要。'
                    : '暂无结构摘要。旧版记录或不支持的请求格式可能缺少此数据。';
        },
        destroy() { for (const dispose of disposers) dispose(); root.remove(); },
    };
}
