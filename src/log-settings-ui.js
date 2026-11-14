/* SPDX-License-Identifier: MPL-2.0 */
// Runtime log tools own a separate settings tab; they never capture prompt bodies.
import { createLocalizer, localizeError } from './i18n.js';
import { getSafeErrorContext } from './client-logger.js';
import { mountExtensionSettings } from './extension-settings.js';
import { downloadLogText, showLogViewer } from './log-actions.js';

export function createLogSettingsUi({ context, serverClient, logger, notifyError = () => {},
    localize = createLocalizer(), documentRef = globalThis.document, onRetry = () => {},
    showViewer = showLogViewer, download = downloadLogText } = {}) {
    const make = (tag, attributes = {}, text = '') => {
        const node = documentRef.createElement(tag);
        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'class') node.className = value;
            else node.setAttribute(key, value);
        }
        if (text) node.textContent = text;
        return node;
    };
    const iconButton = (key, icon, id) => {
        const label = localize(key);
        const button = make('button', { id, type: 'button',
            class: 'menu_button vertex-paygo-icon-button vertex-paygo-log-button', title: label, 'aria-label': label });
        button.append(make('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }));
        return button;
    };
    const root = make('section', { id: 'vertex-paygo-log-settings', class: 'vertex-paygo-settings vertex-paygo-log-settings' });
    const actions = make('div', { id: 'vertex-paygo-log-actions', class: 'vertex-paygo-log-actions' });
    const label = make('span', { class: 'vertex-paygo-action-label', 'data-i18n': 'vertex_paygo.logs.title' }, localize('vertex_paygo.logs.title'));
    const tools = make('div', { class: 'vertex-paygo-log-tools' });
    const buttons = make('div', { class: 'vertex-paygo-settings-log-buttons' });
    const view = iconButton('vertex_paygo.logs.view', 'fa-file-lines', 'vertex-paygo-view-logs');
    const save = iconButton('vertex_paygo.logs.save', 'fa-download', 'vertex-paygo-save-logs');
    buttons.append(view, save); tools.append(buttons); actions.append(label, tools);
    const statusRow = make('div', { class: 'vertex-paygo-log-settings-status-row' });
    const status = make('small', { id: 'vertex-paygo-log-settings-status', class: 'vertex-paygo-status', 'aria-live': 'polite' });
    const retry = iconButton('vertex_paygo.retry', 'fa-rotate-right', 'vertex-paygo-log-retry');
    statusRow.append(status, retry); root.append(actions, statusRow);
    let destroyed = false, pending = false, healthEpoch = 0;
    let health = { status: 'checking', logsAvailable: false };
    const disposers = [];
    const listen = (node, event, fn) => {
        node.addEventListener(event, fn); disposers.push(() => node.removeEventListener(event, fn));
    };
    const available = () => !destroyed && health.status === 'ready' && health.logsAvailable === true;
    function render() {
        if (destroyed) return;
        const denied = health.status === 'ready' && !health.logsAvailable;
        root.dataset.serverStatus = health.status;
        actions.hidden = denied; buttons.hidden = denied; label.hidden = denied;
        view.disabled = pending || !available(); save.disabled = pending || !available();
        statusRow.hidden = available() && !pending;
        status.textContent = localize(pending ? 'vertex_paygo.logs.loading'
            : denied ? 'vertex_paygo.logs.permission_denied'
                : health.status === 'checking' ? 'vertex_paygo.server.checking' : 'vertex_paygo.logs.unavailable');
        retry.hidden = pending || denied || health.status === 'checking';
        retry.disabled = pending || health.status === 'checking';
        root.setAttribute('aria-busy', String(pending));
    }
    function event(level, name, details = {}) {
        try { logger?.event?.(level, name, details); } catch { /* Logging must not block a read-only action. */ }
    }
    async function run(action) {
        if (destroyed || pending || !available()) return;
        const requestEpoch = healthEpoch;
        const valid = () => !destroyed && available() && healthEpoch === requestEpoch;
        pending = true; render(); event('info', `logs.${action}_started`, { phase: 'started' });
        try {
            await logger?.flush?.();
            if (!valid()) return;
            const text = await serverClient.readLogs();
            if (!valid()) return; // Late permission/teardown changes cannot display old logs.
            if (action === 'view') {
                event('info', 'logs.view_ready', { phase: 'ready' });
                await showViewer(text, { context, documentRef, localize,
                    title: localize('vertex_paygo.logs.title'),
                    emptyText: localize('vertex_paygo.logs.empty'), closeText: localize('vertex_paygo.logs.close') });
            } else {
                download(text, { documentRef }); event('info', 'logs.save_ready', { phase: 'ready' });
            }
        } catch (error) {
            if (!valid()) return;
            event('error', `logs.${action}_failed`, { phase: 'failed', ...getSafeErrorContext(error) });
            notifyError(localize(`vertex_paygo.logs.${action}_failed`, { error: localizeError(localize, error) }));
        } finally { pending = false; render(); }
    }
    listen(view, 'click', () => void run('view'));
    listen(save, 'click', () => void run('save'));
    listen(retry, 'click', () => {
        if (destroyed || pending || health.status === 'checking') return;
        try { Promise.resolve(onRetry()).catch(() => {}); } catch { /* Parent health UI reports errors. */ }
    });
    render();
    const unmount = mountExtensionSettings(root, { documentRef, tab: 'logs',
        label: localize('vertex_paygo.settings.tab.logs'), onShow: render });
    return {
        root,
        setHealth(value) {
            if (destroyed) return;
            const next = { status: value?.status ?? 'checking', logsAvailable: value?.logsAvailable === true };
            if (next.status !== health.status || next.logsAvailable !== health.logsAvailable) healthEpoch++;
            health = next; render();
        },
        viewLogs: () => run('view'), saveLogs: () => run('save'), render,
        destroy() {
            if (destroyed) return; destroyed = true;
            for (const dispose of disposers) dispose(); unmount();
        },
    };
}
