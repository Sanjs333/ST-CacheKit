/* Optional warming controls; SPDX-License-Identifier: MPL-2.0 */
import { mountExtensionSettings } from './extension-settings.js';
import { createLocalizer } from './i18n.js';

export function createCacheWarmerSettings({ warmer, getContext, documentRef = globalThis.document,
    mountSettings = mountExtensionSettings, localize = createLocalizer() } = {}) {
    const make = (tag, text = '') => { const node = documentRef.createElement(tag); node.textContent = text; return node; };
    const root = make('section'); root.className = 'vertex-paygo-group'; root.id = 'vertex-paygo-cache-warm-settings';
    const title = make('h4', localize('vertex_paygo.cache_warm.title')); title.className = 'vertex-paygo-group-title';
    const label = make('label'); label.className = 'vertex-paygo-toggle-row';
    const toggle = make('input'); toggle.type = 'checkbox'; toggle.className = 'vertex-paygo-compact-switch';
    toggle.id = 'vertex-paygo-cache-warm-enabled'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', localize('vertex_paygo.cache_warm.enabled'));
    label.append(make('span', localize('vertex_paygo.cache_warm.enabled')), toggle);
    const help = make('p', localize('vertex_paygo.cache_warm.help')); help.className = 'vertex-paygo-guidance';
    const row = make('div'); row.className = 'vertex-paygo-pi-controls vertex-paygo-cache-warm-status';
    const status = make('small'); status.className = 'vertex-paygo-status'; status.setAttribute('role', 'status');
    const stop = make('button'); stop.type = 'button'; stop.className = 'vertex-paygo-icon-button vertex-paygo-log-tool';
    stop.title = localize('vertex_paygo.cache_warm.stop'); stop.setAttribute('aria-label', stop.title);
    const icon = make('i'); icon.className = 'fa-solid fa-stop'; icon.setAttribute('aria-hidden', 'true'); stop.append(icon);
    row.append(status, stop); root.append(title, label, help, row);
    const render = () => {
        const state = warmer.snapshot(); toggle.checked = state.enabled; toggle.disabled = !getContext?.()?.extensionSettings;
        stop.disabled = !state.active;
        status.textContent = localize('vertex_paygo.cache_warm.progress', { count: state.count, max: state.max })
            + ' · ' + localize('vertex_paygo.cache_warm.' + state.status);
    };
    const change = () => { warmer.setEnabled(toggle.checked); render(); }, cancel = () => { warmer.stop(); render(); };
    toggle.addEventListener('change', change); stop.addEventListener('click', cancel);
    const unmount = mountSettings(root, { documentRef, tab: 'cache', label: localize('vertex_paygo.settings.tab.cache'), onShow: render });
    render();
    return { render, destroy() { toggle.removeEventListener('change', change); stop.removeEventListener('click', cancel); unmount(); } };
}
