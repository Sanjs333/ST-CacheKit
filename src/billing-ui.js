/* SPDX-License-Identifier: MPL-2.0 */
import { mountExtensionSettings } from './extension-settings.js';
import { BILLING_SETTINGS_DEFAULTS, billingDate, billingExportDate, billingMoney, billingQuery, billingRows, billingSettings, sameBillingSettings, summarizeBillingRows } from './billing-model.js';

export function createBillingUi({ context, serverClient, getChatId, documentRef = globalThis.document,
    mountSettings = mountExtensionSettings } = {}) {
    const make = (tag, text = '', className = '') => {
        const element = documentRef.createElement(tag); element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    const root = make('section', '', 'vertex-paygo-settings vertex-paygo-billing-settings');
    const details = make('details'); details.append(make('summary', 'Google 实际账单（可选）'));
    const description = make('p', '消息费用是用量估算；这里读取指定项目的 Vertex / Agent Platform 账单导出数据。需要先开启 BigQuery 账单导出，并给当前服务账号授予账单表读取与查询权限。');
    const help = make('a', '查看 Google 账单导出设置说明');
    help.href = 'https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup'; help.target = '_blank'; help.rel = 'noopener noreferrer';
    const form = make('div', '', 'vertex-paygo-billing-fields'), inputs = new Map();
    const field = (key, label, type = 'text', placeholder = '', parent = form) => {
        const wrapper = make('label'), input = make('input');
        input.type = type; input.className = type === 'checkbox' ? '' : 'text_pole'; input.placeholder = placeholder;
        input.id = `vertex-paygo-billing-${key}`; input.autocomplete = 'off'; inputs.set(key, input);
        if (type === 'checkbox') { wrapper.className = 'checkbox_label'; wrapper.append(input, make('span', label)); }
        else wrapper.append(make('span', label), input);
        parent.append(wrapper); return input;
    };
    field('enabled', '启用实际账单查询', 'checkbox');
    field('queryProject', '运行查询的项目 ID', 'text', '有权运行 BigQuery 查询的项目');
    field('dataset', '账单数据集', 'text', '例如 billing_export');
    field('table', '账单表名', 'text', '例如 gcp_billing_export_v1_…');
    const advanced = make('details'); advanced.append(make('summary', '其他账单设置'));
    const advancedFields = make('div', '', 'vertex-paygo-billing-fields');
    for (const [key, label, placeholder] of [
        ['datasetProject', '账单表所在项目（可留空）', '默认与查询项目相同'],
        ['projectFilter', '模型调用项目（可留空）', '默认使用服务账号的项目'],
        ['location', '数据集位置', 'US、EU 或数据集的区域'],
        ['secretId', '服务账号 ID（可留空）', '默认复用当前服务账号凭证'],
    ]) field(key, label, 'text', placeholder, advancedFields);
    advanced.append(advancedFields);
    const modeLabel = make('label'), mode = make('select');
    mode.className = 'text_pole'; mode.id = 'vertex-paygo-billing-labelMode'; inputs.set('labelMode', mode);
    for (const [value, label] of [['off', '关闭'], ['chat', '按聊天关联'], ['request', '按单次请求关联（用于排查）']]) {
        const option = make('option', label); option.value = value; mode.append(option);
    }
    modeLabel.append(make('span', '新请求的账单关联'), mode); form.append(modeLabel);
    const actions = make('div', '', 'vertex-paygo-billing-actions');
    const save = make('button', '保存账单设置', 'menu_button'), refresh = make('button', '重新读取设置', 'menu_button');
    save.type = refresh.type = 'button'; save.id = 'vertex-paygo-billing-save'; refresh.id = 'vertex-paygo-billing-refresh'; actions.append(save, refresh);
    const dates = make('div', '', 'vertex-paygo-billing-dates');
    const start = make('input'), end = make('input'); start.type = end.type = 'date'; start.className = end.className = 'text_pole'; start.value = end.value = billingDate();
    start.id = 'vertex-paygo-billing-startDate'; end.id = 'vertex-paygo-billing-endDate';
    const startLabel = make('label'), endLabel = make('label'); startLabel.append(make('span', '开始日期（北京时间）'), start); endLabel.append(make('span', '结束日期（北京时间）'), end); dates.append(startLabel, endLabel);
    const scopeLabel = make('label', '', 'vertex-paygo-billing-scope'), scope = make('select');
    scope.className = 'text_pole'; scope.id = 'vertex-paygo-billing-scope';
    for (const [value, label] of [['project', '项目 Vertex 费用'], ['chat', '当前聊天费用'], ['request', '指定请求费用']]) {
        const option = make('option', label); option.value = value; scope.append(option);
    }
    scopeLabel.append(make('span', '查询范围'), scope);
    const requestId = make('input'); requestId.className = 'text_pole'; requestId.id = 'vertex-paygo-billing-requestId';
    requestId.placeholder = '请求 ID（缓存诊断中的记录 ID）'; requestId.hidden = true; requestId.setAttribute('aria-label', '账单关联请求 ID');
    const query = make('button', '读取实际账单', 'menu_button'); query.type = 'button'; query.id = 'vertex-paygo-billing-query';
    const status = make('p'); status.id = 'vertex-paygo-billing-status'; status.setAttribute('aria-live', 'polite');
    const summary = make('p'), result = make('div', '', 'vertex-paygo-billing-results'); summary.id = 'vertex-paygo-billing-summary';
    const note = make('small', '账单通常在一天内更新，有时超过 24 小时；净费用包含导出表中的抵扣，可能后续调整。日期按北京时间查询，结果按天汇总。关联标签仅对开启后的 Vertex 请求生效。');
    details.append(description, help, form, advanced, actions, dates, scopeLabel, requestId, query, status, summary, result, note); root.append(details);

    let saved = null, busy = false, destroyed = false, loadTask = null, epoch = 0, dirty = false, settingsReady = false;
    const listeners = [];
    const listen = (node, name, action) => { node.addEventListener(name, action); listeners.push(() => node.removeEventListener(name, action)); };
    const errorMessage = error => typeof error?.message === 'string' && error.message ? error.message : '账单操作失败，请重试。';
    const currentSettings = () => ({ ...BILLING_SETTINGS_DEFAULTS, ...Object.fromEntries([...inputs].map(([key, input]) =>
        [key, input.type === 'checkbox' ? input.checked : input.value.trim()])) });
    const controls = () => {
        save.disabled = busy || !settingsReady || !saved || !dirty;
        refresh.disabled = busy;
        refresh.textContent = dirty ? '撤销修改并重新读取' : '重新读取设置';
        query.disabled = busy || !settingsReady || !saved?.enabled || dirty;
        for (const input of inputs.values()) input.disabled = busy || !settingsReady;
        root.setAttribute('aria-busy', String(busy));
    };
    const clearResults = () => { epoch++; summary.textContent = ''; result.replaceChildren(); };
    const fill = value => {
        const next = billingSettings(value);
        saved = next; settingsReady = true; dirty = false;
        for (const [key, input] of inputs) {
            if (input.type === 'checkbox') input.checked = next[key] === true;
            else input.value = next[key] ?? '';
        }
        controls();
    };
    async function load({ force = false, discardChanges = false } = {}) {
        if (destroyed) return;
        if (loadTask) return loadTask;
        if (busy || (saved && !force)) return;
        if (dirty && !discardChanges) { status.textContent = '账单设置有未保存的修改，请先保存或重新读取。'; return; }
        busy = true; clearResults(); controls(); status.textContent = '正在读取账单设置…';
        loadTask = (async () => {
            try {
                const value = await serverClient.readBillingSettings();
                if (destroyed) return;
                fill(value); status.textContent = saved.enabled ? '账单查询已配置。' : '账单查询默认关闭。配置后保存即可启用。';
            } catch (error) {
                if (!destroyed) { settingsReady = false; status.textContent = error?.status === 404 ? '当前后端不支持账单查询，请更新后端。' : errorMessage(error); }
            } finally { loadTask = null; busy = false; if (!destroyed) controls(); }
        })();
        return loadTask;
    }
    const onSettingsChanged = () => {
        if (destroyed || busy || !saved) return;
        dirty = !sameBillingSettings(saved, currentSettings()); clearResults(); controls();
        status.textContent = dirty ? '账单设置有未保存的修改，请先保存再查询。' : '账单设置与已保存配置一致。';
    };
    for (const input of inputs.values()) { listen(input, 'input', onSettingsChanged); listen(input, 'change', onSettingsChanged); }
    listen(details, 'toggle', () => { if (details.open) void load({ force: true }); });
    listen(refresh, 'click', () => { if (!busy) void load({ force: true, discardChanges: true }); });
    const onQueryChanged = () => { clearResults(); if (busy) status.textContent = '查询条件已变化，请重新读取账单。'; };
    listen(scope, 'change', () => { requestId.hidden = scope.value !== 'request'; onQueryChanged(); });
    for (const input of [start, end, requestId]) { listen(input, 'change', onQueryChanged); listen(input, 'input', onQueryChanged); }
    listen(save, 'click', async () => {
        if (busy || !settingsReady || !saved || !dirty || destroyed) return;
        const value = currentSettings();
        if (value.enabled && !['queryProject', 'dataset', 'table'].every(key => value[key])) {
            status.textContent = '启用账单查询前，请填写查询项目、账单数据集和表名。'; return;
        }
        busy = true; clearResults(); controls(); status.textContent = '正在保存账单设置…';
        try {
            const value = await serverClient.saveBillingSettings(currentSettings());
            if (destroyed) return;
            fill(value); status.textContent = '账单设置已保存。关联标签从下一次请求开始生效。';
        } catch (error) { if (!destroyed) status.textContent = errorMessage(error); }
        finally { busy = false; if (!destroyed) controls(); }
    });
    listen(query, 'click', async () => {
        if (busy || !settingsReady || !saved?.enabled || dirty || destroyed) return;
        let selected;
        try { selected = billingQuery({ startDate: start.value, endDate: end.value, scope: scope.value,
            chatId: scope.value === 'chat' ? getChatId?.() : undefined, requestId: requestId.value.trim() }); }
        catch (error) { status.textContent = errorMessage(error); return; }
        busy = true; clearResults(); const currentEpoch = epoch; controls(); status.textContent = '正在读取实际账单…';
        try {
            const value = await serverClient.readBilling(selected);
            if (destroyed || epoch !== currentEpoch) return;
            if (selected.chatId && getChatId?.() !== selected.chatId) { status.textContent = '聊天已切换，请重新读取对应账单。'; return; }
            const rows = billingRows(value);
            if ((value.startDate && value.startDate !== selected.startDate) || (value.endDate && value.endDate !== selected.endDate)) throw new Error('账单响应的日期范围不一致，请重试。');
            const totals = summarizeBillingRows(rows);
            summary.textContent = totals.map(group => `账单净费用 ${billingMoney(group.netCost, group.currency)}`).join(' · ');
            const invalidAmounts = rows.some(row => row.currency === null || row.netCost === null)
                || (value.rows.length <= 1000 && rows.length !== value.rows.length);
            status.textContent = rows.length
                ? `${typeof value.note === 'string' ? value.note.slice(0, 1024) : '已读取账单导出数据。'}${value.cached ? '当前为最近一分钟内的查询结果。' : ''}${value.truncated || value.rows.length > 1000 ? '结果已截断，请缩小范围。' : ''}${invalidAmounts ? '部分费用数据无效，未计入合计。' : ''}`
                : '暂无已导出的匹配账单；可能尚未更新，或请求未携带关联标签。';
            if (!rows.length) return;
            const table = make('table'), head = make('thead'), headings = make('tr'), body = make('tbody');
            const showRequests = rows.some(row => row.requestLabel);
            for (const text of ['日期', '计费金额', '抵扣', '净费用', ...(showRequests ? ['关联请求'] : []), '导出更新时间（北京时间）']) headings.append(make('th', text));
            head.append(headings);
            for (const row of rows) {
                const tr = make('tr'), date = billingExportDate(row.lastExportTime);
                const values = [row.day || '—', billingMoney(row.grossCost, row.currency), billingMoney(row.credits, row.currency), billingMoney(row.netCost, row.currency),
                    ...(showRequests ? [row.requestLabel || '—'] : []), date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—'];
                for (const text of values) tr.append(make('td', text)); body.append(tr);
            }
            table.append(head, body); result.replaceChildren(table);
        } catch (error) { if (!destroyed && epoch === currentEpoch) status.textContent = errorMessage(error); }
        finally { busy = false; if (!destroyed) controls(); }
    });
    controls();
    const unmount = mountSettings(root, { documentRef, tab: 'pricing', onShow: () => { if (details.open) void load({ force: true }); } });
    return { root, load, destroy() { if (destroyed) return; destroyed = true; epoch++; for (const dispose of listeners) dispose(); unmount(); } };
}
