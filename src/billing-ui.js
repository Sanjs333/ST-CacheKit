/* SPDX-License-Identifier: MPL-2.0 */
import { mountExtensionSettings } from './extension-settings.js';
import { createLocalizer } from './i18n.js';
import { BILLING_SETTINGS_DEFAULTS, billingDate, billingExportDate, billingMoney, billingQuery, billingRows, billingSettings, sameBillingSettings, summarizeBillingRows } from './billing-model.js';

export function createBillingUi({ context, serverClient, getChatId, documentRef = globalThis.document,
    mountSettings = mountExtensionSettings, localize = createLocalizer((fallback, key) => context?.translate?.(fallback, key)) } = {}) {
    const t = (key, variables) => localize('vertex_paygo.billing.' + key, variables);
    const make = (tag, text = '', className = '') => {
        const element = documentRef.createElement(tag);
        element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    const root = make('section', '', 'vertex-paygo-settings vertex-paygo-billing-settings');
    const connection = make('section', '', 'vertex-paygo-group');
    const heading = make('div', '', 'vertex-paygo-billing-heading');
    heading.append(make('h4', t('connection_title'), 'vertex-paygo-group-title'));
    const actions = make('div', '', 'vertex-paygo-billing-actions');
    const iconButton = (key, icon, id) => {
        const button = make('button', '', 'menu_button vertex-paygo-icon-button');
        button.type = 'button'; button.id = id; button.title = t(key); button.setAttribute('aria-label', t(key));
        const glyph = make('i', '', 'fa-solid ' + icon); glyph.setAttribute('aria-hidden', 'true'); button.append(glyph);
        return button;
    };
    const save = iconButton('save', 'fa-check', 'vertex-paygo-billing-save');
    const refresh = iconButton('reload', 'fa-rotate-right', 'vertex-paygo-billing-refresh');
    actions.append(save, refresh); heading.append(actions);
    const inputs = new Map();
    const enableLabel = make('label', '', 'vertex-paygo-toggle-row');
    const enabled = make('input', '', 'vertex-paygo-compact-switch'); enabled.type = 'checkbox'; enabled.id = 'vertex-paygo-billing-enabled'; enabled.setAttribute('role', 'switch');
    enableLabel.append(make('span', t('enabled')), enabled); inputs.set('enabled', enabled);
    const guidance = make('p', t('setup_note'), 'vertex-paygo-guidance');
    const help = make('a', t('setup_link'), 'vertex-paygo-billing-help');
    help.href = 'https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup'; help.target = '_blank'; help.rel = 'noopener noreferrer';
    const form = make('div', '', 'vertex-paygo-billing-grid');
    const field = (name, labelKey, placeholderKey, parent = form, type = 'text') => {
        const wrapper = make('label', '', 'vertex-paygo-cost-field vertex-paygo-billing-field');
        const input = make('input', '', 'text_pole'); input.type = type; input.id = `vertex-paygo-billing-${name}`; input.autocomplete = 'off';
        if (placeholderKey) input.placeholder = t(placeholderKey);
        wrapper.append(make('span', t(labelKey)), input); parent.append(wrapper); inputs.set(name, input);
        return { wrapper, input };
    };
    field('queryProject', 'query_project', 'query_project_placeholder');
    field('dataset', 'dataset', 'dataset_placeholder');
    field('table', 'table', 'table_placeholder').wrapper.classList.add('vertex-paygo-billing-wide');
    const modeLabel = make('label', '', 'vertex-paygo-cost-field vertex-paygo-billing-field');
    const mode = make('select', '', 'text_pole'); mode.id = 'vertex-paygo-billing-labelMode'; inputs.set('labelMode', mode);
    for (const [value, key] of [['off', 'link_off'], ['chat', 'link_chat'], ['request', 'link_request']]) {
        const option = make('option', t(key)); option.value = value; mode.append(option);
    }
    modeLabel.append(make('span', t('link_mode')), mode); form.append(modeLabel);
    const advanced = make('details', '', 'vertex-paygo-billing-advanced'); advanced.append(make('summary', t('advanced')));
    const advancedFields = make('div', '', 'vertex-paygo-billing-grid');
    for (const [name, label, placeholder] of [
        ['datasetProject', 'dataset_project', 'dataset_project_placeholder'],
        ['projectFilter', 'project_filter', 'project_filter_placeholder'],
        ['location', 'location', 'location_placeholder'],
        ['secretId', 'credential', 'credential_placeholder'],
    ]) field(name, label, placeholder, advancedFields);
    advanced.append(advancedFields);
    connection.append(heading, enableLabel, guidance, help, form, advanced);

    const queryGroup = make('section', '', 'vertex-paygo-group vertex-paygo-billing-query-group');
    const queryHeading = make('div', '', 'vertex-paygo-billing-heading');
    queryHeading.append(make('h4', t('query_title'), 'vertex-paygo-group-title'));
    const query = iconButton('query', 'fa-magnifying-glass', 'vertex-paygo-billing-query'); queryHeading.append(query);
    const dates = make('div', '', 'vertex-paygo-billing-dates');
    const startLabel = make('label', '', 'vertex-paygo-cost-field vertex-paygo-billing-field');
    const endLabel = make('label', '', 'vertex-paygo-cost-field vertex-paygo-billing-field');
    const start = make('input', '', 'text_pole'), end = make('input', '', 'text_pole');
    start.type = end.type = 'date'; start.value = end.value = billingDate();
    start.id = 'vertex-paygo-billing-startDate'; end.id = 'vertex-paygo-billing-endDate';
    startLabel.append(make('span', t('start_date')), start); endLabel.append(make('span', t('end_date')), end); dates.append(startLabel, endLabel);
    const queryFields = make('div', '', 'vertex-paygo-billing-grid');
    const scopeLabel = make('label', '', 'vertex-paygo-cost-field vertex-paygo-billing-field');
    const scope = make('select', '', 'text_pole'); scope.id = 'vertex-paygo-billing-scope';
    for (const [value, key] of [['project', 'scope_project'], ['chat', 'scope_chat'], ['request', 'scope_request']]) {
        const option = make('option', t(key)); option.value = value; scope.append(option);
    }
    scopeLabel.append(make('span', t('scope')), scope); queryFields.append(scopeLabel);
    const requestLabel = make('label', '', 'vertex-paygo-cost-field vertex-paygo-billing-field'); requestLabel.hidden = true;
    const requestId = make('input', '', 'text_pole'); requestId.id = 'vertex-paygo-billing-requestId'; requestId.placeholder = t('request_placeholder'); requestId.autocomplete = 'off';
    requestLabel.append(make('span', t('request_id')), requestId); queryFields.append(requestLabel);
    const status = make('p', '', 'vertex-paygo-status vertex-paygo-billing-feedback'); status.id = 'vertex-paygo-billing-status'; status.setAttribute('aria-live', 'polite'); status.hidden = true;
    const summary = make('p', '', 'vertex-paygo-billing-total'); summary.id = 'vertex-paygo-billing-summary'; summary.hidden = true;
    const result = make('div', '', 'vertex-paygo-billing-results');
    queryGroup.append(queryHeading, dates, queryFields, make('small', t('date_note'), 'vertex-paygo-guidance'), summary, result, make('small', t('delay_note'), 'vertex-paygo-guidance'));
    root.append(connection, queryGroup, status);

    let saved = null, busy = false, destroyed = false, loadTask = null, epoch = 0, dirty = false, settingsReady = false;
    const listeners = [];
    const listen = (node, name, action) => { node.addEventListener(name, action); listeners.push(() => node.removeEventListener(name, action)); };
    const feedback = (text = '', kind = 'info') => { status.textContent = text; status.hidden = !text; status.dataset.kind = kind; };
    const errorMessage = error => {
        if (typeof error?.translationKey === 'string') return localize(error.translationKey);
        const code = error?.serverCode ?? error?.code;
        const keys = { BILLING_PERMISSION_REQUIRED: 'error_permissions', BILLING_CREDENTIAL_UNAVAILABLE: 'error_credentials',
            BILLING_NOT_CONFIGURED: 'error_config_required', INVALID_BILLING_SETTINGS: 'error_settings_invalid', INVALID_BILLING_QUERY: 'error_dates',
            BILLING_QUERY_FAILED: 'error_query_failed', BILLING_QUERY_PENDING: 'error_pending', BILLING_UNAVAILABLE: 'error_unavailable',
            BILLING_RESPONSE_TOO_LARGE: 'error_result_size', INVALID_BILLING_RESPONSE: 'error_response',
            UNAVAILABLE: 'error_unavailable', TIMEOUT: 'error_unavailable' };
        return t(keys[code] ?? 'error_operation');
    };
    const currentSettings = () => ({ ...BILLING_SETTINGS_DEFAULTS, ...Object.fromEntries([...inputs].map(([name, input]) =>
        [name, input.type === 'checkbox' ? input.checked : input.value.trim()])) });
    const controls = () => {
        save.disabled = busy || !settingsReady || !saved || !dirty; refresh.disabled = busy;
        refresh.title = t(dirty ? 'reload_discard' : 'reload'); refresh.setAttribute('aria-label', refresh.title);
        query.disabled = busy || !settingsReady || !saved?.enabled || dirty;
        for (const input of inputs.values()) input.disabled = busy || !settingsReady;
        for (const input of [start, end, scope, requestId]) input.disabled = !settingsReady || !saved?.enabled;
        root.setAttribute('aria-busy', String(busy));
    };
    const clearResults = () => { epoch++; summary.textContent = ''; summary.hidden = true; result.replaceChildren(); };
    const fill = value => {
        const next = billingSettings(value, localize); saved = next; settingsReady = true; dirty = false;
        for (const [name, input] of inputs) if (input.type === 'checkbox') input.checked = next[name] === true; else input.value = next[name] ?? '';
        controls();
    };
    async function load({ force = false, discardChanges = false } = {}) {
        if (destroyed) return;
        if (loadTask) return loadTask;
        if (busy || (saved && !force)) return;
        if (dirty && !discardChanges) { feedback(t('status_dirty')); return; }
        busy = true; clearResults(); controls(); feedback(t('status_reading'));
        loadTask = Promise.resolve().then(async () => {
            try {
                const value = await serverClient.readBillingSettings();
                if (destroyed) return;
                fill(value); feedback();
            } catch (error) {
                if (!destroyed) { settingsReady = false; feedback(error?.status === 404 ? t('error_backend') : errorMessage(error), 'error'); }
            } finally { loadTask = null; busy = false; if (!destroyed) controls(); }
        });
        return loadTask;
    }
    const onSettingsChanged = () => {
        if (destroyed || busy || !saved) return;
        dirty = !sameBillingSettings(saved, currentSettings()); clearResults(); controls(); feedback(dirty ? t('status_dirty') : '');
    };
    for (const input of inputs.values()) { listen(input, 'input', onSettingsChanged); listen(input, 'change', onSettingsChanged); }
    listen(refresh, 'click', () => { if (!busy) void load({ force: true, discardChanges: true }); });
    const onQueryChanged = () => { clearResults(); if (busy) feedback(t('status_changed')); };
    listen(scope, 'change', () => { requestLabel.hidden = scope.value !== 'request'; onQueryChanged(); });
    for (const input of [start, end, requestId]) { listen(input, 'change', onQueryChanged); listen(input, 'input', onQueryChanged); }
    listen(save, 'click', async () => {
        if (busy || !settingsReady || !saved || !dirty || destroyed) return;
        const value = currentSettings();
        if (value.enabled && !['queryProject', 'dataset', 'table'].every(name => value[name])) { feedback(t('error_config_required'), 'error'); return; }
        busy = true; clearResults(); controls(); feedback(t('status_saving'));
        try {
            const value = await serverClient.saveBillingSettings(currentSettings());
            if (destroyed) return;
            fill(value); feedback(t('status_saved'));
        } catch (error) { if (!destroyed) feedback(errorMessage(error), 'error'); }
        finally { busy = false; if (!destroyed) controls(); }
    });
    listen(query, 'click', async () => {
        if (busy || !settingsReady || !saved?.enabled || dirty || destroyed) return;
        let selected;
        try { selected = billingQuery({ startDate: start.value, endDate: end.value, scope: scope.value,
            chatId: scope.value === 'chat' ? getChatId?.() : undefined, requestId: requestId.value.trim() }, localize); }
        catch (error) { feedback(errorMessage(error), 'error'); return; }
        busy = true; clearResults(); const currentEpoch = epoch; controls(); feedback(t('status_querying'));
        try {
            const value = await serverClient.readBilling(selected);
            if (destroyed || epoch !== currentEpoch) return;
            if (selected.chatId && getChatId?.() !== selected.chatId) { feedback(t('status_chat_changed')); return; }
            const rows = billingRows(value, localize);
            if ((value.startDate && value.startDate !== selected.startDate) || (value.endDate && value.endDate !== selected.endDate)) { feedback(t('error_range_mismatch'), 'error'); return; }
            summary.textContent = summarizeBillingRows(rows).map(group => t('net_total', { amount: billingMoney(group.netCost, group.currency) })).join(' · ');
            summary.hidden = !summary.textContent;
            const invalidAmounts = rows.some(row => row.currency === null || row.netCost === null) || (value.rows.length <= 1000 && rows.length !== value.rows.length);
            const notices = [t(rows.length ? 'status_loaded' : 'status_empty')];
            if (value.cached) notices.push(t('status_cached'));
            if (value.truncated || value.rows.length > 1000) notices.push(t('status_truncated'));
            if (invalidAmounts) notices.push(t('status_invalid'));
            feedback(notices.join(' '));
            if (!rows.length) return;
            const table = make('table'), head = make('thead'), headings = make('tr'), body = make('tbody');
            const showRequests = rows.some(row => row.requestLabel);
            for (const key of ['col_date', 'col_gross', 'col_credits', 'col_net', ...(showRequests ? ['col_request'] : []), 'col_updated']) headings.append(make('th', t(key)));
            head.append(headings);
            for (const row of rows) {
                const tr = make('tr'), date = billingExportDate(row.lastExportTime);
                const values = [row.day || '—', billingMoney(row.grossCost, row.currency), billingMoney(row.credits, row.currency), billingMoney(row.netCost, row.currency),
                    ...(showRequests ? [row.requestLabel || '—'] : []), date && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined,
                        { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—'];
                for (const text of values) tr.append(make('td', text)); body.append(tr);
            }
            table.append(head, body); result.replaceChildren(table);
        } catch (error) { if (!destroyed && epoch === currentEpoch) feedback(errorMessage(error), 'error'); }
        finally { busy = false; if (!destroyed) controls(); }
    });
    controls();
    let unmount;
    try { unmount = mountSettings(root, { documentRef, tab: 'billing', label: localize('vertex_paygo.settings.tab.billing'), onShow: () => void load({ force: true }) }); }
    catch (error) { destroyed = true; for (const dispose of listeners) dispose(); throw error; }
    return { root, load, destroy() { if (destroyed) return; destroyed = true; epoch++; for (const dispose of listeners) dispose(); unmount(); } };
}
